use super::*;
use crate::catalog::{CatalogError, CatalogService, RecommendationKind};
use std::collections::VecDeque;

const INITIAL_TRACKS: usize = 10;
const REFILL_TRACKS: usize = 5;
const QUEUE_LIMIT: usize = 1_000;

#[derive(Debug)]
pub enum RadarError {
    Catalog(CatalogError),
    Session(PlaybackSessionError),
    Empty,
}

impl From<PlaybackSessionError> for RadarError {
    fn from(error: PlaybackSessionError) -> Self {
        Self::Session(error)
    }
}
impl From<QueueError> for RadarError {
    fn from(error: QueueError) -> Self {
        Self::Session(PlaybackSessionError::Queue(error))
    }
}

#[cfg_attr(test, derive(Default))]
pub(crate) struct RadarSeed {
    items: Vec<QueueTrack>,
    source_page: u32,
    has_more: bool,
}

impl RadarSeed {
    pub(crate) fn new(
        items: Vec<QueueTrack>,
        source_page: u32,
        has_more: bool,
    ) -> Result<Self, RadarError> {
        use crate::multi_provider::{identity::track_provider, ProviderId};
        if items.is_empty()
            || !(1..=100).contains(&source_page)
            || items
                .iter()
                .any(|track| track_provider(&track.id) != Ok(ProviderId::Qqmusic))
        {
            return Err(RadarError::Catalog(CatalogError::InvalidRequest));
        }
        crate::queue::validate_items(&items)?;
        Ok(Self {
            items,
            source_page,
            has_more: has_more && source_page < 100,
        })
    }

    #[cfg(test)]
    fn unseeded() -> Self {
        Self {
            has_more: true,
            ..Self::default()
        }
    }
}

#[derive(Clone)]
struct RadarReader {
    session_id: u64,
    catalog: Arc<CatalogService>,
    source_page: u32,
    has_more: bool,
    buffered: VecDeque<QueueTrack>,
    seen: HashSet<String>,
}

impl RadarReader {
    fn new(catalog: Arc<CatalogService>, session_id: u64, seed: RadarSeed) -> Self {
        Self {
            session_id,
            catalog,
            source_page: seed.source_page,
            has_more: seed.has_more,
            seen: seed.items.iter().map(|item| item.id.clone()).collect(),
            buffered: seed.items.into(),
        }
    }

    fn take(
        &mut self,
        count: usize,
        mut is_current: impl FnMut() -> bool,
    ) -> Result<Vec<QueueTrack>, RadarError> {
        // A recommendation feed need not end. Never scan it to exhaustion, even
        // when the server keeps returning empty or duplicate batches.
        while self.buffered.len() < count && self.has_more && is_current() {
            let page = self
                .catalog
                .recommend_songs(RecommendationKind::Radar, self.source_page + 1, 0)
                .map_err(RadarError::Catalog)?;
            if !is_current() {
                return Err(PlaybackSessionError::Superseded.into());
            }
            self.source_page += 1;
            self.has_more = page.has_more && self.source_page < 100;
            let before = self.buffered.len();
            for song in page.items {
                if self.seen.insert(song.id.clone()) {
                    self.buffered.push_back(QueueTrack {
                        video: None,
                        id: song.id,
                        media_mid: song.media_mid,
                        cover_cache_key: song.cover_cache_key,
                        title: song.title,
                        artist: song.artist,
                        album: song.album,
                        duration_ms: song.duration_ms,
                    });
                }
            }
            if self.buffered.len() == before {
                self.has_more = false;
                break;
            }
        }
        Ok(self
            .buffered
            .drain(..count.min(self.buffered.len()))
            .collect())
    }
}

pub(super) struct RadarPlayback {
    reader: RadarReader,
    ids: Vec<String>,
    queue_generation: u64,
    next_index: usize,
    in_flight: bool,
    starting_intent: Option<u64>,
}

impl PlaybackSession {
    pub(crate) fn cancel_radar(&self) {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.cancel_radar_locked();
    }

    pub(super) fn cancel_radar_locked(&self) {
        self.radar_epoch.fetch_add(1, Ordering::SeqCst);
        let starting_intent = self
            .radar
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .and_then(|state| state.starting_intent);
        self.supersede_radar_start_locked(starting_intent);
    }

    pub(super) fn pause_radar_locked(&self) {
        // Keep the reader, but release startup ownership before its late result arrives.
        self.radar_epoch.fetch_add(1, Ordering::SeqCst);
        let starting_intent = self
            .radar
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .and_then(|state| state.starting_intent.take());
        self.supersede_radar_start_locked(starting_intent);
    }

    fn supersede_radar_start_locked(&self, starting_intent: Option<u64>) {
        // A later ordinary play request owns a different intent and must survive.
        if starting_intent.is_some_and(|intent| self.play_intent.load(Ordering::SeqCst) == intent) {
            self.new_play_intent();
        }
    }

    pub(crate) fn start_radar(
        &self,
        catalog: Arc<CatalogService>,
        seed: RadarSeed,
    ) -> Result<PlaybackSessionSnapshot, RadarError> {
        let (epoch, generation, previous_intent) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.cancel_radar_locked();
            (
                self.radar_epoch.load(Ordering::SeqCst),
                self.queue.with_view(|queue| queue.generation),
                self.play_intent.load(Ordering::SeqCst),
            )
        };
        let mut reader = RadarReader::new(catalog, epoch, seed);
        let items = reader.take(INITIAL_TRACKS, || {
            self.radar_epoch.load(Ordering::SeqCst) == epoch
                && self.play_intent.load(Ordering::SeqCst) == previous_intent
        })?;
        if items.is_empty() {
            return Err(RadarError::Empty);
        }
        let (intent, track) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.radar_epoch.load(Ordering::SeqCst) != epoch
                || self.play_intent.load(Ordering::SeqCst) != previous_intent
            {
                return Err(PlaybackSessionError::Superseded.into());
            }
            let queue = self
                .queue
                .replace_if_generation(items, generation)?
                .ok_or(PlaybackSessionError::Superseded)?;
            let track = queue.items[0].clone();
            self.queue.save_playback_mode("sequence")?;
            *self
                .mode
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = PlaybackMode::Sequence;
            *self
                .next_override
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            let intent = self.new_play_intent();
            *self
                .radar
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(RadarPlayback {
                reader,
                ids: queue.items.iter().map(|item| item.id.clone()).collect(),
                queue_generation: queue.generation,
                next_index: 4,
                in_flight: false,
                starting_intent: Some(intent),
            });
            (intent, track)
        };
        // Source resolution is deliberately outside the operation mutex.
        let result = self.play_selected(intent, track, PlaybackQuality::Auto);
        {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut radar = self
                .radar
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(state) = radar.as_mut().filter(|state| {
                state.reader.session_id == epoch && state.starting_intent == Some(intent)
            }) {
                // An unavailable first song already has automatic skip scheduled.
                // Keep the reader so that recovery can continue filling this queue.
                if (result.is_ok() || result.as_ref().is_err_and(song_cannot_play))
                    && self.radar_epoch.load(Ordering::SeqCst) == epoch
                {
                    state.starting_intent = None;
                } else {
                    *radar = None;
                }
            }
        }
        result?;
        Ok(self.snapshot())
    }

    pub(super) fn poll_radar(self: &Arc<Self>) {
        let Some(plan) = self.prepare_radar_refill() else {
            return;
        };
        let session_id = plan.1.session_id;
        let session = Arc::downgrade(self);
        if thread::Builder::new()
            .name("qqmusic-radar-refill".into())
            .spawn(move || {
                let Some(session) = session.upgrade() else {
                    return;
                };
                session.refill_radar(plan.0, plan.1, plan.2);
            })
            .is_err()
        {
            let mut radar = self
                .radar
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if radar
                .as_ref()
                .is_some_and(|state| state.reader.session_id == session_id)
            {
                self.radar_epoch.fetch_add(1, Ordering::SeqCst);
                *radar = None;
            }
        }
    }

    fn prepare_radar_refill(&self) -> Option<(u64, RadarReader, Vec<String>)> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut radar = self
            .radar
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        radar.as_ref()?;
        // Even a paused/in-flight reader must reject external queue edits.
        // Selection can bump the generation without changing the ID order.
        self.queue.with_view(|queue| {
            let state = radar.as_mut()?;
            if queue.generation != state.queue_generation {
                if !queue.items.iter().map(|item| &item.id).eq(state.ids.iter()) {
                    self.radar_epoch.fetch_add(1, Ordering::SeqCst);
                    *radar = None;
                    return None;
                }
                state.queue_generation = queue.generation;
            }
            if state.starting_intent.is_some() || state.in_flight || state.ids.len() >= QUEUE_LIMIT {
                return None;
            }
            let player = self.playback.cached_snapshot();
            if player.state != PlayerState::Playing {
                return None;
            }
            let id = &player.current_track.as_ref()?.id;
            let Some(index) = queue.index_of(id) else {
                *radar = None;
                return None;
            };
            if index < state.next_index
                || (!state.reader.has_more && state.reader.buffered.is_empty())
            {
                return None;
            }
            state.in_flight = true;
            Some((
                self.radar_epoch.load(Ordering::SeqCst),
                state.reader.clone(),
                state.ids.clone(),
            ))
        })
    }

    fn refill_radar(&self, epoch: u64, mut reader: RadarReader, ids: Vec<String>) {
        let result = reader.take(REFILL_TRACKS.min(QUEUE_LIMIT - ids.len()), || {
            self.radar_epoch.load(Ordering::SeqCst) == epoch
        });
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut radar = self
            .radar
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(state) = radar
            .as_mut()
            .filter(|state| state.reader.session_id == reader.session_id && state.ids == ids)
        else {
            return;
        };
        state.in_flight = false;
        if self.radar_epoch.load(Ordering::SeqCst) != epoch
            || self.playback.cached_snapshot().state != PlayerState::Playing
        {
            return;
        }
        match result {
            Ok(items) => match self.queue.enqueue_many_if_unchanged(items, &ids) {
                Ok(Some(queue)) => {
                    state.ids = queue.items.iter().map(|item| item.id.clone()).collect();
                    state.queue_generation = queue.generation;
                    state.reader = reader;
                    state.next_index = state
                        .ids
                        .len()
                        .saturating_sub(6)
                        .max(state.next_index + REFILL_TRACKS);
                }
                _ => {
                    *radar = None;
                }
            },
            Err(_) => {
                *radar = None;
                crate::file_logging::event("radar_refill_failed");
            }
        }
    }
}

#[cfg(test)]
mod tests;
