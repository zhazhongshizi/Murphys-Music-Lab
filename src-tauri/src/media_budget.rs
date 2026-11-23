use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub(crate) const BURST: usize = 16 * 1024;
pub(crate) const MIN_RATE: u64 = 64_000;

#[derive(Clone, Copy)]
pub(crate) enum Traffic {
    Audio,
    Preload,
    Cover,
    Probe,
    PreloadProbe,
}

#[derive(Default)]
pub(crate) struct Totals {
    pub audio: AtomicU64,
    pub preload: AtomicU64,
    pub cover: AtomicU64,
    pub probe: AtomicU64,
    pub cache: AtomicU64,
    pub preload_probe: AtomicU64,
    pub disk_cache: AtomicU64,
}

/// Shared byte reservations for HTTP requests and bounded streaming reads.
/// Only one burst can accumulate during idle time.
pub(crate) struct MediaBudget {
    enabled: AtomicBool,
    rate: AtomicU64,
    foreground: AtomicUsize,
    foreground_order: tokio::sync::Mutex<()>,
    buffer_ready: AtomicBool,
    available: Mutex<(Instant, f64)>,
    measurement: Mutex<(Instant, [u64; 7])>,
    pub totals: Totals,
}

impl Default for MediaBudget {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            rate: AtomicU64::new(MIN_RATE),
            foreground: AtomicUsize::new(0),
            foreground_order: tokio::sync::Mutex::new(()),
            buffer_ready: AtomicBool::new(false),
            available: Mutex::new((Instant::now(), BURST as f64)),
            measurement: Mutex::new((Instant::now(), [0; 7])),
            totals: Totals::default(),
        }
    }
}

impl MediaBudget {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn set_bitrate(&self, bits_per_second: u64) {
        self.rate
            .store(MIN_RATE.max(bits_per_second / 4), Ordering::Relaxed);
    }

    pub fn set_buffer_ready(&self, ready: bool) {
        self.buffer_ready.store(ready, Ordering::Relaxed);
    }

    fn try_reserve(&self, bytes: usize, foreground: bool) -> Option<Duration> {
        debug_assert!(bytes <= BURST);
        if !self.enabled() {
            return None;
        }
        if !foreground
            && !self.buffer_ready.load(Ordering::Relaxed)
            && self.foreground.load(Ordering::Acquire) > 0
        {
            return Some(Duration::from_millis(15));
        }
        let mut state = self.available.lock().unwrap();
        let now = Instant::now();
        let rate = self.rate.load(Ordering::Relaxed) as f64;
        state.1 = (state.1 + now.duration_since(state.0).as_secs_f64() * rate).min(BURST as f64);
        state.0 = now;
        if state.1 >= bytes as f64 {
            state.1 -= bytes as f64;
            None
        } else {
            Some(Duration::from_secs_f64((bytes as f64 - state.1) / rate))
        }
    }

    pub async fn reserve(&self, bytes: usize, traffic: Traffic) {
        let foreground = matches!(traffic, Traffic::Audio | Traffic::Probe);
        let _pending = foreground.then(|| {
            self.foreground.fetch_add(1, Ordering::AcqRel);
            ForegroundReservation(&self.foreground)
        });
        let _order = if foreground {
            Some(self.foreground_order.lock().await)
        } else {
            None
        };
        while let Some(delay) = self.try_reserve(bytes, foreground) {
            tokio::time::sleep(delay).await;
        }
    }

    pub fn reserve_blocking(&self, bytes: usize, allowed: &dyn Fn() -> bool) -> bool {
        while let Some(delay) = self.try_reserve(bytes, false) {
            if !allowed() {
                return false;
            }
            std::thread::sleep(delay.min(Duration::from_millis(40)));
        }
        allowed()
    }

    pub fn record(&self, traffic: Traffic, bytes: usize) {
        let counter = match traffic {
            Traffic::Audio => &self.totals.audio,
            Traffic::Preload => &self.totals.preload,
            Traffic::Cover => &self.totals.cover,
            Traffic::Probe => &self.totals.probe,
            Traffic::PreloadProbe => &self.totals.preload_probe,
        };
        counter.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn log_interval(&self) {
        let mut measurement = self.measurement.lock().unwrap();
        let elapsed = measurement.0.elapsed();
        if elapsed < Duration::from_secs(2) {
            return;
        }
        let now = [
            &self.totals.audio,
            &self.totals.preload,
            &self.totals.cover,
            &self.totals.probe,
            &self.totals.cache,
            &self.totals.preload_probe,
            &self.totals.disk_cache,
        ]
        .map(|counter| counter.load(Ordering::Relaxed));
        let delta = std::array::from_fn(|i| now[i].saturating_sub(measurement.1[i]));
        *measurement = (Instant::now(), now);
        if delta != [0; 7] {
            crate::file_logging::media_traffic(
                elapsed.as_millis() as u64,
                self.rate.load(Ordering::Relaxed),
                delta,
            );
        }
    }
}

struct ForegroundReservation<'a>(&'a AtomicUsize);

impl Drop for ForegroundReservation<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
