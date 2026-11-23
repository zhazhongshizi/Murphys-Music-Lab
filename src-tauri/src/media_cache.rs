use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MIB: u64 = 1024 * 1024;
const MIN_MIB: u32 = 16;
const MAX_MIB: u32 = 16384;
const FILE_OVERHEAD: u64 = 4096;
const CONFIG: &str = "settings.json";
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    enabled: bool,
    #[serde(default = "default_preload")]
    preload_enabled: bool,
    limit_mib: u32,
}

fn default_preload() -> bool {
    true
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            preload_enabled: default_preload(),
            limit_mib: 1024,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheStatus {
    enabled: bool,
    preload_enabled: bool,
    limit_mib: u32,
    pub(crate) used_bytes: u64,
    available: bool,
}

#[derive(Clone, Copy)]
struct Entry {
    allocation: u64,
    used: SystemTime,
}

struct Index {
    entries: HashMap<String, Entry>,
    lru: BTreeSet<(SystemTime, String)>,
    used: u64,
    pending_bytes: u64,
    epoch: u64,
    available: bool,
    preferences: Preferences,
}

impl Index {
    fn fits(&self, bytes: u64) -> bool {
        bytes + 2 * FILE_OVERHEAD <= u64::from(self.preferences.limit_mib) * MIB
    }
}

pub(crate) struct MediaCache {
    root: PathBuf,
    index: Mutex<Index>,
    // Serializes a detached file's unlink with publication at the same path.
    // Readers never take this lock, and a clear releases it between files.
    block_files: Mutex<HashMap<String, Entry>>,
    clear_lock: Mutex<()>,
    pub budget: Arc<crate::media_budget::MediaBudget>,
    // The cache is local to the installation. Hiding raw account IDs also
    // prevents a directory listing from correlating the same account across installations.
    salt: String,
}

impl MediaCache {
    pub fn open(root: PathBuf, budget: Arc<crate::media_budget::MediaBudget>) -> Self {
        let preferences = read_small(&root.join(CONFIG))
            .and_then(|data| serde_json::from_slice::<Preferences>(&data).ok())
            .filter(|p| (MIN_MIB..=MAX_MIB).contains(&p.limit_mib))
            .unwrap_or_default();
        budget.set_enabled(preferences.enabled);
        let salt_path = root.join("installation");
        let salt = fs::create_dir_all(&root).ok().and_then(|_| {
            if fs::symlink_metadata(&root).ok()?.file_type().is_symlink() {
                return None;
            }
            let salt = read_small(&salt_path)
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|value| uuid::Uuid::parse_str(value).is_ok())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            // Test that this installation can safely publish files, including
            // for old caches that have since been made read-only.
            publish_durable(&root, &salt_path, salt.as_bytes()).ok()?;
            Some(salt)
        });
        let mut index = Index {
            entries: HashMap::new(),
            lru: BTreeSet::new(),
            used: 0,
            pending_bytes: 0,
            epoch: 0,
            available: salt.is_some(),
            preferences,
        };
        if index.available {
            if let Ok(entries) = fs::read_dir(&root) {
                for entry in entries.flatten() {
                    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                        continue;
                    }
                    if owned_temp(&name) {
                        let _ = fs::remove_file(entry.path());
                    } else if owned_block(&name) {
                        let Ok(metadata) = entry.metadata() else {
                            continue;
                        };
                        if !(33..=MAX_BLOCK_FILE).contains(&metadata.len()) {
                            let _ = fs::remove_file(entry.path());
                            continue;
                        }
                        let allocation = allocation(metadata.len());
                        index.used += allocation;
                        let used = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        index.lru.insert((used, name.clone()));
                        index.entries.insert(name, Entry { allocation, used });
                    }
                }
            }
        }
        let salt = salt.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cache = Self {
            root,
            index: Mutex::new(index),
            block_files: Mutex::new(HashMap::new()),
            clear_lock: Mutex::new(()),
            budget,
            salt,
        };
        {
            let mut index = cache.index.lock().unwrap();
            cache.make_room(&mut index, 0, 0);
        }
        cache
    }

    pub fn scope(
        &self,
        source: &str,
        account: &str,
        track: &str,
        representation: &str,
    ) -> Option<String> {
        Some(digest_parts(&[
            &self.salt,
            source,
            account,
            track,
            representation,
        ]))
    }

    pub fn status(&self) -> CacheStatus {
        let index = self.index.lock().unwrap();
        CacheStatus {
            enabled: self.budget.enabled(),
            preload_enabled: index.preferences.preload_enabled,
            limit_mib: index.preferences.limit_mib,
            used_bytes: index.used + index.pending_bytes,
            available: index.available,
        }
    }

    pub fn preload_enabled(&self) -> bool {
        self.index.lock().unwrap().preferences.preload_enabled
    }

    pub fn configure(&self, enabled: bool, limit_mib: u32, preload_enabled: Option<bool>) -> Result<CacheStatus, ()> {
        if !(MIN_MIB..=MAX_MIB).contains(&limit_mib) {
            return Err(());
        }
        let mut index = self.index.lock().unwrap();
        let preferences = Preferences {
            enabled, limit_mib,
            preload_enabled: preload_enabled.unwrap_or(index.preferences.preload_enabled),
        };
        let data = serde_json::to_vec(&preferences).map_err(|_| ())?;
        if index.available {
            publish_durable(&self.root, &self.root.join(CONFIG), &data).map_err(|_| ())?;
        }
        index.preferences = preferences;
        self.budget.set_enabled(enabled);
        self.make_room(&mut index, 0, 0);
        drop(index);
        Ok(self.status())
    }

    pub fn clear(&self) -> CacheStatus {
        let _clear = self.clear_lock.lock().unwrap();
        for (_, name) in self.detach_blocks() {
            self.remove_detached_block(name);
        }
        self.status()
    }

    fn detach_blocks(&self) -> BTreeSet<(SystemTime, String)> {
        let mut pending = self.block_files.lock().unwrap();
        let mut index = self.index.lock().unwrap();
        debug_assert!(pending.is_empty());
        index.epoch = index.epoch.wrapping_add(1);
        index.pending_bytes = std::mem::take(&mut index.used);
        *pending = std::mem::take(&mut index.entries);
        std::mem::take(&mut index.lru)
    }

    fn remove_detached_block(&self, name: String) {
        let mut pending = self.block_files.lock().unwrap();
        let Some(entry) = pending.remove(&name) else {
            return;
        };
        let removed = fs::remove_file(self.root.join(&name));
        let mut index = self.index.lock().unwrap();
        index.pending_bytes -= entry.allocation;
        if removed.is_err_and(|error| error.kind() != io::ErrorKind::NotFound) {
            // Keep accounting for a file the OS declined to remove.
            index.used += entry.allocation;
            index.lru.insert((entry.used, name.clone()));
            index.entries.insert(name, entry);
        }
    }

    pub fn epoch(&self) -> u64 {
        self.index.lock().unwrap().epoch
    }

    pub fn read(&self, key: &str, offset: u64, len: usize) -> Option<Vec<u8>> {
        let name = block_name(key, offset);
        let path = self.root.join(&name);
        let (epoch, initial_used) = {
            let index = self.index.lock().unwrap();
            if !index.available || !self.budget.enabled() {
                return None;
            }
            let entry = index.entries.get(&name)?;
            (index.epoch, entry.used)
        };

        let data = if fs::symlink_metadata(&path)
            .ok()
            .is_some_and(|m| m.is_file())
        {
            fs::File::open(&path).ok().and_then(|file| {
                let mut data = Vec::new();
                file.take((len + 33) as u64).read_to_end(&mut data).ok()?;
                (data.len() == len + 32 && Sha256::digest(&data[32..])[..] == data[..32])
                    .then_some(data)
            })
        } else {
            None
        };

        let mut touch_used = None;
        let payload = {
            let mut index = self.index.lock().unwrap();
            if !index.available || index.epoch != epoch || !self.budget.enabled() {
                return None;
            }
            if let Some(data) = data {
                if let Some(entry) = index.entries.get(&name).copied() {
                    let used = SystemTime::now();
                    if used
                        .duration_since(entry.used)
                        .is_ok_and(|elapsed| elapsed >= TOUCH_INTERVAL)
                    {
                        touch_used = Some(used);
                    }
                    index.lru.remove(&(entry.used, name.clone()));
                    index.lru.insert((used, name.clone()));
                    index.entries.insert(name, Entry { used, ..entry });
                }
                Some(data[32..].to_vec())
            } else {
                if index
                    .entries
                    .get(&name)
                    .is_some_and(|entry| entry.used == initial_used)
                {
                    self.remove(&mut index, &name);
                }
                None
            }
        };

        if let Some(used) = touch_used {
            let _ = OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.set_modified(used));
        }

        payload
    }

    pub fn write(&self, key: &str, offset: u64, data: &[u8], epoch: u64, background: bool) {
        if data.is_empty() {
            return;
        }
        let name = block_name(key, offset);
        let allocation = allocation((data.len() + 32) as u64);
        {
            let index = self.index.lock().unwrap();
            if !self.can_write(&index, &name, epoch) {
                return;
            }
            if index.pending_bytes == 0 {
                if background && !index.fits(index.used + allocation) {
                    return;
                }
            } else {
                drop(index);
                let pending = self.block_files.lock().unwrap();
                let index = self.index.lock().unwrap();
                let replaced = pending.get(&name).map_or(0, |entry| entry.allocation);
                if !self.can_write(&index, &name, epoch)
                    || !Self::can_admit(&index, allocation, replaced, background)
                {
                    return;
                }
            }
        }

        let hash = Sha256::digest(data);
        let mut bytes = Vec::with_capacity(data.len() + hash.len());
        bytes.extend_from_slice(&hash);
        bytes.extend_from_slice(data);

        let Ok(temporary) = write_temp(&self.root, &bytes, false) else {
            let mut index = self.index.lock().unwrap();
            if index.epoch == epoch {
                index.available = false;
            }
            return;
        };

        let destination = self.root.join(&name);
        let mut keep_temp = false;
        {
            let mut pending = self.block_files.lock().unwrap();
            let mut index = self.index.lock().unwrap();
            let replaced = pending.get(&name).map_or(0, |entry| entry.allocation);
            if self.can_write(&index, &name, epoch)
                && Self::can_admit(&index, allocation, replaced, background)
                && self.make_room(&mut index, allocation, replaced)
            {
                if fs::rename(&temporary, &destination).is_ok() {
                    pending.remove(&name);
                    index.pending_bytes -= replaced;
                    index.used += allocation;
                    let used = SystemTime::now();
                    index.lru.insert((used, name.clone()));
                    index.entries.insert(name, Entry { allocation, used });
                    keep_temp = true;
                } else {
                    index.available = false;
                }
            }
        }
        if !keep_temp {
            let _ = fs::remove_file(&temporary);
        }
    }

    fn can_write(&self, index: &Index, name: &str, epoch: u64) -> bool {
        index.available && index.epoch == epoch && self.budget.enabled()
            && !index.entries.contains_key(name)
    }

    fn can_admit(index: &Index, allocation: u64, replaced: u64, background: bool) -> bool {
        let live = if background { index.used } else { 0 };
        index.fits(live + index.pending_bytes - replaced + allocation)
    }

    fn make_room(&self, index: &mut Index, additional: u64, replaced: u64) -> bool {
        let after = index.pending_bytes - replaced + additional;
        if index.fits(index.used + after) {
            return true;
        }
        while let Some((_, name)) = index.lru.first().cloned() {
            let before = index.used;
            self.remove(index, &name);
            if index.used == before {
                return false;
            }
            if index.fits(index.used + after) {
                return true;
            }
        }
        false
    }

    fn remove(&self, index: &mut Index, name: &str) {
        match fs::remove_file(self.root.join(name)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return,
            _ => {}
        }
        if let Some(entry) = index.entries.remove(name) {
            index.lru.remove(&(entry.used, name.to_owned()));
            index.used -= entry.allocation;
        }
    }
}

const MAX_BLOCK_FILE: u64 = crate::media_budget::BURST as u64 + 32;

fn allocation(length: u64) -> u64 {
    length.div_ceil(FILE_OVERHEAD) * FILE_OVERHEAD + FILE_OVERHEAD
}

pub(crate) fn digest_parts(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.len().to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn block_name(key: &str, offset: u64) -> String {
    format!("{key}-{offset:016x}.blk")
}

fn owned_block(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".blk") else {
        return false;
    };
    let Some((key, offset)) = stem.split_once('-') else {
        return false;
    };
    key.len() == 64
        && offset.len() == 16
        && key
            .bytes()
            .chain(offset.bytes())
            .all(|b| b.is_ascii_hexdigit())
}

fn owned_temp(name: &str) -> bool {
    name.strip_prefix(".media-")
        .and_then(|value| value.strip_suffix(".tmp"))
        .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(1025)
        .read_to_end(&mut data)
        .ok()?;
    (data.len() <= 1024).then_some(data)
}

fn write_temp(root: &Path, data: &[u8], durable: bool) -> io::Result<PathBuf> {
    let temporary = root.join(format!(".media-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(data)?;
        if durable {
            file.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| temporary)
}

fn commit_temp(temporary: &Path, destination: &Path) -> io::Result<()> {
    let result = fs::rename(temporary, destination);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn publish_durable(root: &Path, destination: &Path, data: &[u8]) -> io::Result<()> {
    let temporary = write_temp(root, data, true)?;
    commit_temp(&temporary, destination)
}

#[cfg_attr(not(test), allow(dead_code))]
fn publish_block(root: &Path, destination: &Path, data: &[u8]) -> io::Result<()> {
    let temporary = write_temp(root, data, false)?;
    commit_temp(&temporary, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_settings_keep_their_limit_and_preload_by_default() {
        let old: Preferences = serde_json::from_str(r#"{"enabled":false,"limitMib":64}"#).unwrap();
        assert!(!old.enabled);
        assert_eq!(old.limit_mib, 64);
        assert!(old.preload_enabled);
    }

    #[test]
    fn index_reopens_rejects_corruption_and_clear_fences_inflight_writes() {
        let root = std::env::temp_dir().join(format!("qmg-media-index-{}", uuid::Uuid::new_v4()));
        let open = || MediaCache::open(root.clone(), Arc::new(Default::default()));
        let first = open();
        let scope = first.scope("qqmusic", "a", "recording", "128k").unwrap();
        let separate = first.scope("qqmusic", "b", "recording", "128k").unwrap();
        let lossless = first.scope("qqmusic", "a", "recording", "flac").unwrap();
        assert_ne!(scope, separate);
        assert_ne!(scope, lossless);
        first.configure(true, 16, Some(false)).unwrap();
        assert!(!first.configure(true, 16, None).unwrap().preload_enabled);
        first.write(&scope, 0, b"alpha", first.epoch(), false);
        first.write(&scope, 24, b"valid", first.epoch(), false);
        let interrupted = root.join(format!(".media-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&interrupted, "interrupted").unwrap();
        fs::write(root.join("keep.txt"), "unrelated").unwrap();
        drop(first);
        let reopened = open();
        assert!(!interrupted.exists());
        assert_eq!(reopened.status().limit_mib, 16);
        assert!(reopened.budget.enabled());
        assert!(!reopened.preload_enabled());
        assert_eq!(
            reopened.scope("qqmusic", "a", "recording", "128k"),
            Some(scope.clone())
        );
        assert_eq!(
            reopened.read(&scope, 0, 5).as_deref(),
            Some(b"alpha".as_slice())
        );
        assert_eq!(reopened.read(&separate, 0, 5), None);
        fs::write(root.join(block_name(&scope, 0)), [0_u8; 37]).unwrap();
        assert_eq!(reopened.read(&scope, 0, 5), None);
        assert_eq!(
            reopened.read(&scope, 24, 5).as_deref(),
            Some(b"valid".as_slice())
        );
        let old_epoch = reopened.epoch();
        assert_eq!(reopened.clear().used_bytes, 0);
        reopened.write(&scope, 0, b"alpha", old_epoch, false);
        assert_eq!(reopened.read(&scope, 0, 5), None);
        assert!(root.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_releases_the_index_while_waiting_to_remove_files() {
        let root = std::env::temp_dir().join(format!("qmg-media-clear-{}", uuid::Uuid::new_v4()));
        let cache = Arc::new(MediaCache::open(root.clone(), Arc::new(Default::default())));
        let key = digest_parts(&["playing"]);
        let old_epoch = cache.epoch();
        cache.write(&key, 0, b"old", old_epoch, false);
        let detached = cache.detach_blocks();
        assert_ne!(cache.epoch(), old_epoch);
        let files = cache.block_files.lock().unwrap();
        let clearing = cache.clone();
        let clear = std::thread::spawn(move || {
            for (_, name) in detached {
                clearing.remove_detached_block(name);
            }
        });
        let reader = cache.clone();
        let (seen, result) = std::sync::mpsc::channel();
        let read = std::thread::spawn(move || {
            seen.send((reader.status().used_bytes, reader.read(&key, 0, 3))).unwrap();
        });
        let detached = result.recv_timeout(Duration::from_secs(3));
        drop(files);
        clear.join().unwrap();
        assert_eq!(cache.status().used_bytes, 0);
        assert_eq!(detached.unwrap(), (allocation(35), None));
        read.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detached_clear_preserves_a_new_block_written_at_the_same_path() {
        let root = std::env::temp_dir().join(format!("qmg-media-clear-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open(root.clone(), Arc::new(Default::default()));
        let key = digest_parts(&["active track"]);
        let old_epoch = cache.epoch();
        cache.write(&key, 0, b"old", old_epoch, false);
        cache.write(&key, 16, b"old", old_epoch, false);

        let detached = cache.detach_blocks();
        assert_eq!(detached.len(), 2);
        assert_eq!(cache.status().used_bytes, 2 * allocation(35));
        assert_eq!(cache.read(&key, 0, 3), None);
        cache.write(&key, 16, b"stale", old_epoch, false);
        assert_eq!(cache.read(&key, 16, 5), None);
        cache.write(&key, 0, b"new", cache.epoch(), false);

        for (_, name) in detached {
            cache.remove_detached_block(name);
        }
        assert_eq!(cache.read(&key, 0, 3).as_deref(), Some(b"new".as_slice()));
        assert!(!root.join(block_name(&key, 16)).exists());
        assert_eq!(cache.status().used_bytes, allocation(35));
        drop(cache);
        let reopened = MediaCache::open(root.clone(), Arc::new(Default::default()));
        assert_eq!(reopened.read(&key, 0, 3).as_deref(), Some(b"new".as_slice()));
        assert_eq!(reopened.status().used_bytes, allocation(35));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_blocks_count_against_quota_until_deleted_or_replaced() {
        const LENGTH: usize = crate::media_budget::BURST;
        let root = std::env::temp_dir().join(format!("qmg-media-quota-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open(root.clone(), Arc::new(Default::default()));
        cache.configure(true, MIN_MIB, None).unwrap();
        let key = digest_parts(&["old track"]);
        let new_key = digest_parts(&["new track"]);
        let data = vec![1; LENGTH];
        let per_block = allocation((LENGTH + 32) as u64);
        let full = (u64::from(MIN_MIB) * MIB - 2 * FILE_OVERHEAD) / per_block;
        for offset in 0..full {
            cache.write(&key, offset, &data, cache.epoch(), false);
        }
        let detached = cache.detach_blocks();
        let full_bytes = full * per_block;
        assert_eq!(detached.len() as u64, full);
        assert_eq!(cache.status().used_bytes, full_bytes);
        let epoch = cache.epoch();
        for background in [true, false] {
            cache.write(&new_key, 0, &data, epoch, background);
            assert!(!root.join(block_name(&new_key, 0)).exists());
            assert_eq!(cache.status().used_bytes, full_bytes);
        }

        let replacement = vec![2; LENGTH];
        cache.write(&key, 0, &replacement, epoch, true);
        assert_eq!(cache.read(&key, 0, LENGTH), Some(replacement));
        assert_eq!(cache.status().used_bytes, full_bytes);
        assert_eq!(cache.index.lock().unwrap().pending_bytes, full_bytes - per_block);

        cache.remove_detached_block(block_name(&key, 1));
        assert!(!root.join(block_name(&key, 1)).exists());
        assert_eq!(cache.status().used_bytes, full_bytes - per_block);
        cache.write(&new_key, 0, &data, epoch, false);
        assert_eq!(cache.read(&new_key, 0, LENGTH), Some(data));
        assert_eq!(cache.status().used_bytes, full_bytes);

        for (_, name) in detached {
            cache.remove_detached_block(name);
        }
        assert_eq!(cache.status().used_bytes, 2 * per_block);
        assert_eq!(cache.index.lock().unwrap().pending_bytes, 0);
        assert_eq!(cache.clear().used_bytes, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unavailable_directory_leaves_network_smoothing_enabled() {
        let root =
            std::env::temp_dir().join(format!("qmg-media-unavailable-{}", uuid::Uuid::new_v4()));
        fs::write(&root, "occupied").unwrap();
        let cache = MediaCache::open(root.clone(), Arc::new(Default::default()));
        let status = cache.status();
        assert!(!status.available);
        assert!(status.enabled);
        assert_eq!(fs::read_to_string(&root).unwrap(), "occupied");
        fs::remove_file(root).unwrap();
    }

    #[test]
    fn publish_helpers_write_atomically_and_clean_temp_files_on_failure() {
        let root = std::env::temp_dir().join(format!("qmg-media-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let durable_dest = root.join("durable.bin");
        publish_durable(&root, &durable_dest, b"settings").unwrap();
        assert_eq!(fs::read(&durable_dest).unwrap(), b"settings");

        let block_dest = root.join("block.blk");
        publish_block(&root, &block_dest, b"payload").unwrap();
        assert_eq!(fs::read(&block_dest).unwrap(), b"payload");

        let non_empty_dir = root.join("occupied-dir");
        fs::create_dir_all(&non_empty_dir).unwrap();
        fs::write(non_empty_dir.join("child"), b"x").unwrap();
        assert!(publish_block(&root, &non_empty_dir, b"fail").is_err());

        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| owned_temp(name))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_throttles_mtime_writes_within_60s_and_touches_after_threshold() {
        let root = std::env::temp_dir().join(format!("qmg-media-touch-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open(root.clone(), Arc::new(Default::default()));
        let scope = cache.scope("qqmusic", "u", "track", "128k").unwrap();
        cache.write(&scope, 0, b"hello", cache.epoch(), false);

        let name = block_name(&scope, 0);
        let path = root.join(&name);

        let recent_past = SystemTime::now() - Duration::from_secs(10);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(recent_past)
            .unwrap();
        let disk_before_recent = fs::metadata(&path).unwrap().modified().unwrap();
        {
            let mut index = cache.index.lock().unwrap();
            let entry = index.entries.remove(&name).unwrap();
            index.lru.remove(&(entry.used, name.clone()));
            index.lru.insert((recent_past, name.clone()));
            index.entries.insert(
                name.clone(),
                Entry {
                    used: recent_past,
                    ..entry
                },
            );
        }

        assert_eq!(cache.read(&scope, 0, 5).as_deref(), Some(b"hello".as_slice()));
        let disk_after_recent = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(disk_after_recent, disk_before_recent);
        {
            let index = cache.index.lock().unwrap();
            assert!(index.entries.get(&name).unwrap().used > recent_past);
        }

        let stale_past = SystemTime::now() - Duration::from_secs(65);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale_past)
            .unwrap();
        let disk_before_stale = fs::metadata(&path).unwrap().modified().unwrap();
        {
            let mut index = cache.index.lock().unwrap();
            let entry = index.entries.remove(&name).unwrap();
            index.lru.remove(&(entry.used, name.clone()));
            index.lru.insert((stale_past, name.clone()));
            index.entries.insert(
                name.clone(),
                Entry {
                    used: stale_past,
                    ..entry
                },
            );
        }

        assert_eq!(cache.read(&scope, 0, 5).as_deref(), Some(b"hello".as_slice()));
        let disk_after_stale = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(disk_after_stale > disk_before_stale);
        assert!(
            disk_after_stale
                .duration_since(disk_before_stale)
                .unwrap()
                >= Duration::from_secs(60)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_removes_sha_mismatched_block_and_updates_used_bytes() {
        let root = std::env::temp_dir().join(format!("qmg-media-corrupt-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open(root.clone(), Arc::new(Default::default()));
        let scope = cache.scope("netease", "u", "track", "320k").unwrap();
        cache.write(&scope, 0, b"first", cache.epoch(), false);
        cache.write(&scope, 16384, b"second", cache.epoch(), false);

        let one_alloc = allocation(32 + 5);
        let two_alloc = allocation(32 + 6);
        assert_eq!(cache.status().used_bytes, one_alloc + two_alloc);

        let first_path = root.join(block_name(&scope, 0));
        let mut raw = fs::read(&first_path).unwrap();
        raw[32] ^= 0xff;
        fs::write(&first_path, raw).unwrap();

        assert_eq!(cache.read(&scope, 0, 5), None);
        assert!(!first_path.exists());
        assert_eq!(cache.status().used_bytes, two_alloc);
        assert_eq!(
            cache.read(&scope, 16384, 6).as_deref(),
            Some(b"second".as_slice())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_writes_and_clear_preserve_epoch_fencing_without_orphans() {
        let root = std::env::temp_dir().join(format!("qmg-media-race-{}", uuid::Uuid::new_v4()));
        let cache = Arc::new(MediaCache::open(root.clone(), Arc::new(Default::default())));
        let scope = cache.scope("bilibili", "u", "track", "aac").unwrap();

        let mut handles = Vec::new();
        for worker in 0..4 {
            let cache = cache.clone();
            let scope = scope.clone();
            handles.push(std::thread::spawn(move || {
                let payload = vec![(worker as u8) + 1; 4096];
                for i in 0..30 {
                    let epoch = cache.epoch();
                    cache.write(&scope, ((worker * 100 + i) as u64) * 16384, &payload, epoch, false);
                    let _ = cache.read(&scope, ((worker * 100 + i) as u64) * 16384, payload.len());
                }
            }));
        }
        for _ in 0..10 {
            cache.clear();
            std::thread::yield_now();
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let status = cache.clear();
        assert_eq!(status.used_bytes, 0);
        let leftover_blocks_or_temps: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| owned_block(name) || owned_temp(name))
            .collect();
        assert!(leftover_blocks_or_temps.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
