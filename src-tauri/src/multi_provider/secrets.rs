//! Current-user DPAPI; no optional entropy (None for both protect/unprotect).
//! Generation intent and final file replacement share a commit boundary.
use super::{
    protocol::{self, Error},
    OnlineProviderId,
};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;
pub const MAX_SECRET: usize = 65536;
pub trait Prepared: Send {
    fn commit(self: Box<Self>) -> Result<(), Error>;
}
pub trait Store: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error>;
    fn prepare(&self, bytes: &[u8]) -> Result<Box<dyn Prepared>, Error>;
    fn delete(&self) -> Result<(), Error>;
}
pub fn validate(provider: OnlineProviderId, bytes: &[u8]) -> Result<(), Error> {
    if provider == OnlineProviderId::Qqmusic || bytes.is_empty() || bytes.len() > MAX_SECRET {
        return Err(Error::Storage);
    }
    let v = crate::provider::parse_json_value(bytes).map_err(|_| Error::Storage)?;
    protocol::validate("credential", &v).map_err(|_| Error::Storage)?;
    if v["providerId"] != protocol::name(provider) {
        return Err(Error::Storage);
    }
    Ok(())
}
pub struct CoordinatedStore {
    store: Arc<dyn Store>,
    epoch: AtomicU64,
    commit: Mutex<()>,
}
impl CoordinatedStore {
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self {
            store,
            epoch: AtomicU64::new(0),
            commit: Mutex::new(()),
        }
    }
    pub fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        let _g = self.commit.lock().unwrap();
        self.store.read()
    }
    pub fn activate(&self, epoch: u64) {
        let _g = self.commit.lock().unwrap();
        self.epoch.store(epoch, Ordering::Release);
    }
    pub fn invalidate(&self, old: u64, new: u64) {
        let _ = self
            .epoch
            .compare_exchange(old, new, Ordering::AcqRel, Ordering::Acquire);
    }
    pub fn save(&self, epoch: u64, bytes: &[u8]) -> Result<(), Error> {
        let prepared = self.prepare(epoch, bytes)?;
        self.commit(epoch, prepared)
    }
    pub fn prepare(&self, epoch: u64, bytes: &[u8]) -> Result<Box<dyn Prepared>, Error> {
        if self.epoch.load(Ordering::Acquire) != epoch {
            return Err(Error::Stale);
        }
        self.store.prepare(bytes)
    }
    pub fn commit(&self, epoch: u64, prepared: Box<dyn Prepared>) -> Result<(), Error> {
        let _g = self.commit.lock().unwrap();
        if self.epoch.load(Ordering::Acquire) != epoch {
            return Err(Error::Stale);
        }
        prepared.commit()
    }
    pub fn delete(&self, epoch: u64) -> Result<(), Error> {
        let _g = self.commit.lock().unwrap();
        if self.epoch.load(Ordering::Acquire) != epoch {
            return Err(Error::Stale);
        }
        self.store.delete()
    }
}
pub struct DpapiStore {
    provider: OnlineProviderId,
    path: PathBuf,
}
impl DpapiStore {
    pub fn new(root: PathBuf, provider: OnlineProviderId) -> Result<Self, Error> {
        if !root.is_absolute() || provider == OnlineProviderId::Qqmusic {
            return Err(Error::Storage);
        }
        Ok(Self {
            provider,
            path: root
                .join("provider-state")
                .join(protocol::name(provider))
                .join("credentials.v1.dpapi"),
        })
    }
}
struct FileCommit {
    temp: PathBuf,
    target: PathBuf,
}
impl Prepared for FileCommit {
    fn commit(self: Box<Self>) -> Result<(), Error> {
        #[cfg(windows)]
        {
            use windows::{
                core::PCWSTR,
                Win32::Storage::FileSystem::{
                    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
                },
            };
            let a: Vec<u16> = self.temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let b: Vec<u16> = self
                .target
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            unsafe {
                MoveFileExW(
                    PCWSTR(a.as_ptr()),
                    PCWSTR(b.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            }
            .map_err(|_| Error::Storage)?;
        }
        #[cfg(not(windows))]
        {
            fs::rename(&self.temp, &self.target).map_err(|_| Error::Storage)?;
        }
        Ok(())
    }
}
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
impl Drop for FileCommit {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temp);
    }
}
impl Store for DpapiStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        match fs::metadata(&self.path) {
            Ok(m) if m.len() > (MAX_SECRET + 16384) as u64 => return Err(Error::Storage),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
            _ => {}
        }
        let data = match fs::read(&self.path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
        };
        if data.len() > MAX_SECRET + 16384 {
            return Err(Error::Storage);
        }
        let bytes = crypt(&data, false)?;
        validate(self.provider, &bytes)?;
        Ok(Some(bytes))
    }
    fn prepare(&self, bytes: &[u8]) -> Result<Box<dyn Prepared>, Error> {
        validate(self.provider, bytes)?;
        let encrypted = crypt(bytes, true)?;
        let dir = self.path.parent().ok_or(Error::Storage)?;
        fs::create_dir_all(dir).map_err(|_| Error::Storage)?;
        let prepared = FileCommit {
            temp: dir.join(format!(".credential-{}.tmp", uuid::Uuid::new_v4())),
            target: self.path.clone(),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&prepared.temp)
            .map_err(|_| Error::Storage)?;
        file.write_all(&encrypted)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Storage)?;
        drop(file);
        Ok(Box::new(prepared))
    }
    fn delete(&self) -> Result<(), Error> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(Error::Storage),
        }
    }
}
#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Zeroizing<Vec<u8>>, Error> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| Error::Storage)?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    let r = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
    };
    r.map_err(|_| Error::Storage)?;
    if out.pbData.is_null() {
        return Err(Error::Storage);
    }
    let result = unsafe {
        Zeroizing::new(std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec())
    };
    unsafe {
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
    }
    Ok(result)
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Zeroizing<Vec<u8>>, Error> {
    Err(Error::Storage)
}

/// Legacy QQ remains in Credential Manager with its original QMG envelope/limit.
pub struct QqStore(pub Arc<dyn crate::credentials::CredentialStore>);
struct QqCommit {
    store: Arc<dyn crate::credentials::CredentialStore>,
    secret: crate::credentials::SecretBlob,
}
impl Prepared for QqCommit {
    fn commit(self: Box<Self>) -> Result<(), Error> {
        self.store.replace(&self.secret).map_err(|_| Error::Storage)
    }
}
impl Store for QqStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        self.0
            .read()
            .map(|s| s.map(|s| Zeroizing::new(s.payload().to_vec())))
            .map_err(|_| Error::Storage)
    }
    fn prepare(&self, b: &[u8]) -> Result<Box<dyn Prepared>, Error> {
        Ok(Box::new(QqCommit {
            store: self.0.clone(),
            secret: crate::credentials::SecretBlob::new(b.to_vec()).map_err(|_| Error::Storage)?,
        }))
    }
    fn delete(&self) -> Result<(), Error> {
        self.0.delete().map_err(|_| Error::Storage)
    }
}

pub fn credential_bytes(v: &Value) -> Result<Zeroizing<Vec<u8>>, Error> {
    serde_json::to_vec(v)
        .map(Zeroizing::new)
        .map_err(|_| Error::Storage)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::json;
    fn bytes(id: OnlineProviderId) -> Vec<u8> {
        serde_json::to_vec(
            &json!({"version":1,"providerId":protocol::name(id),"payload":"SYNTHETIC_TEST_ONLY"}),
        )
        .unwrap()
    }
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("dpapi-3a-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn dpapi_roundtrip_corruption_platform_and_envelope_bound() {
        let root = root();
        let a = DpapiStore::new(root.clone(), OnlineProviderId::Netease).unwrap();
        let b = DpapiStore::new(root.clone(), OnlineProviderId::Bilibili).unwrap();
        let secret = bytes(OnlineProviderId::Netease);
        a.prepare(&secret).unwrap().commit().unwrap();
        assert_eq!(a.read().unwrap().unwrap().as_slice(), secret);
        assert!(!fs::read(&a.path)
            .unwrap()
            .windows(19)
            .any(|x| x == b"SYNTHETIC_TEST_ONLY"));
        fs::create_dir_all(b.path.parent().unwrap()).unwrap();
        fs::copy(&a.path, &b.path).unwrap();
        assert!(b.read().is_err());
        fs::write(&a.path, b"corrupt").unwrap();
        assert!(a.read().is_err());
        assert!(a.prepare(&bytes(OnlineProviderId::Bilibili)).is_err());
        let mut v: Value = serde_json::from_slice(&secret).unwrap();
        v["payload"] = json!("x".repeat(MAX_SECRET));
        let n = serde_json::to_vec(&v).unwrap().len() - MAX_SECRET;
        v["payload"] = json!("x".repeat(MAX_SECRET - n));
        let exact = serde_json::to_vec(&v).unwrap();
        assert_eq!(exact.len(), MAX_SECRET);
        a.prepare(&exact).unwrap().commit().unwrap();
        assert_eq!(a.read().unwrap().unwrap().len(), MAX_SECRET);
        v["payload"] = json!("x".repeat(MAX_SECRET - n + 1));
        assert!(a.prepare(&serde_json::to_vec(&v).unwrap()).is_err());
        a.delete().unwrap();
        assert!(a.read().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dpapi_failed_atomic_replace_and_delete_preserve_old_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = root();
        let store = DpapiStore::new(root.clone(), OnlineProviderId::Netease).unwrap();
        let secret = bytes(OnlineProviderId::Netease);
        store.prepare(&secret).unwrap().commit().unwrap();
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&store.path)
            .unwrap();
        let staged = store.prepare(&secret).unwrap();
        assert_eq!(staged.commit(), Err(Error::Storage));
        assert_eq!(store.delete(), Err(Error::Storage));
        drop(locked);
        assert_eq!(store.read().unwrap().unwrap().as_slice(), secret);
        assert_eq!(
            fs::read_dir(store.path.parent().unwrap()).unwrap().count(),
            1
        );
        store.delete().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
