//! Win32 SMTC resolves an application through its Start Menu shortcut.
//! Keep the process and shortcut AUMID identical, without changing data/credential IDs.
use std::path::{Path, PathBuf};
use windows::{
    core::{Interface, HSTRING},
    Win32::{
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
            StructuredStorage::{PropVariantChangeType, PROPVARIANT, PVCHF_DEFAULT},
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READWRITE,
        },
        System::Variant::VT_LPWSTR,
        UI::Shell::{
            FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore, SHChangeNotify,
            SHGetKnownFolderPath, SetCurrentProcessExplicitAppUserModelID, ShellLink,
            KF_FLAG_DEFAULT, SHCNE_CREATE, SHCNE_UPDATEITEM, SHCNF_FLUSH, SHCNF_PATHW,
            SLGP_RAWPATH,
        },
    },
};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug)]
pub(crate) struct AppIdentity {
    id: String,
    name: String,
}

impl AppIdentity {
    pub(crate) fn new(identifier: &str, name: &str, debug: bool) -> Self {
        Self {
            id: if debug {
                format!("{identifier}.debug")
            } else {
                identifier.into()
            },
            name: if debug {
                format!("{name} (Debug)")
            } else {
                name.into()
            },
        }
    }

    pub(crate) fn set_process(&self) -> Result<()> {
        // SAFETY: HSTRING owns the terminated UTF-16 buffer for this call.
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(&self.id)) }
            .map_err(|_| "process_identity_failed")
    }

    pub(crate) fn ensure_shortcut(&self) -> Result<()> {
        let identity = self.clone();
        // A dedicated STA owns all Shell COM objects, independently of Tauri's apartment.
        std::thread::spawn(move || {
            let _com = ComApartment::new()?;
            let executable = std::env::current_exe().map_err(|_| "executable_unavailable")?;
            let programs = programs_directory()?;
            identity.write_shortcut(
                &programs.join(format!("{}.lnk", identity.name)),
                &executable,
            )
        })
        .join()
        .map_err(|_| "shortcut_worker_failed")?
    }

    fn write_shortcut(&self, path: &Path, executable: &Path) -> Result<()> {
        let parent = executable.parent().ok_or("executable_parent_unavailable")?;
        let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| "shell_link_unavailable")?;
        let persist: IPersistFile = link.cast().map_err(|_| "persist_unavailable")?;
        let properties: IPropertyStore = link.cast().map_err(|_| "properties_unavailable")?;
        let shortcut_path = HSTRING::from(path.as_os_str());
        let executable_path = HSTRING::from(executable.as_os_str());
        let exists = path.try_exists().map_err(|_| "shortcut_unreadable")?;
        if exists {
            // Do not replace another program's or the user's unrelated shortcut.
            unsafe { persist.Load(&shortcut_path, STGM_READWRITE) }
                .map_err(|_| "shortcut_unreadable")?;
            let stored_id = unsafe { properties.GetValue(&PKEY_AppUserModel_ID) }
                .map_err(|_| "shortcut_identity_unavailable")?;
            if stored_id.to_string() != self.id {
                return Err("shortcut_identity_conflict");
            }
            let mut target = vec![0u16; 32768];
            unsafe { link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }
                .map_err(|_| "shortcut_target_unavailable")?;
            if utf16_path(&target) == executable {
                return Ok(());
            }
        }
        // SAFETY: COM objects stay on their creating thread; buffers live through calls.
        unsafe {
            link.SetPath(&executable_path)
                .and_then(|_| link.SetWorkingDirectory(&HSTRING::from(parent.as_os_str())))
                .and_then(|_| link.SetArguments(&HSTRING::new()))
                .and_then(|_| link.SetDescription(&HSTRING::from(&self.name)))
                .and_then(|_| link.SetIconLocation(&executable_path, 0))
                .and_then(|_| {
                    let mut value = PROPVARIANT::default();
                    PropVariantChangeType(
                        &mut value,
                        &PROPVARIANT::from(self.id.as_str()),
                        PVCHF_DEFAULT,
                        VT_LPWSTR,
                    )?;
                    properties.SetValue(&PKEY_AppUserModel_ID, &value)
                })
                .and_then(|_| properties.Commit())
                .and_then(|_| persist.Save(&shortcut_path, true))
        }
        .map_err(|_| "shortcut_write_failed")?;
        // Notify Shell consumers when a portable copy first registers or moves.
        unsafe {
            SHChangeNotify(
                if exists {
                    SHCNE_UPDATEITEM
                } else {
                    SHCNE_CREATE
                },
                SHCNF_PATHW | SHCNF_FLUSH,
                Some(shortcut_path.as_ptr().cast()),
                None,
            )
        };
        Ok(())
    }
}

fn utf16_path(value: &[u16]) -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    let end = value.iter().position(|v| *v == 0).unwrap_or(value.len());
    std::ffi::OsString::from_wide(&value[..end]).into()
}

fn programs_directory() -> Result<PathBuf> {
    let value = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None) }
        .map_err(|_| "programs_directory_unavailable")?;
    let path = unsafe { utf16_path(value.as_wide()) };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    Ok(path)
}

struct ComApartment;
impl ComApartment {
    fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|_| "com_unavailable")?;
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit integration check: publishes a synthetic, silent media session and
    /// briefly registers a uniquely named Start Menu link. Never uses real accounts.
    #[test]
    #[ignore = "temporarily registers a Start Menu shortcut and publishes a synthetic SMTC session"]
    fn manual_shell_name_and_smtc_share_the_registered_identity() {
        use windows::{
            Media::{
                Control::GlobalSystemMediaTransportControlsSessionManager, MediaPlaybackStatus,
                MediaPlaybackType, Playback::MediaPlayer,
            },
            Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            Win32::UI::Shell::{
                FOLDERID_AppsFolder, IShellItem, SHCreateItemInKnownFolder, SIGDN_NORMALDISPLAY,
            },
        };
        let identity = AppIdentity::new(
            &format!("dev.qqmusic.gui.identity-test.p{}", std::process::id()),
            &format!("Music Lab identity test {}", std::process::id()),
            false,
        );
        identity.set_process().unwrap();
        let path = programs_directory()
            .unwrap()
            .join(format!("{}.lnk", identity.name));
        assert!(
            !path.exists(),
            "probe must not replace an existing shortcut"
        );
        identity.ensure_shortcut().unwrap();
        let outcome = std::thread::spawn(move || {
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.unwrap();
            let result = (|| -> windows::core::Result<()> {
                let player = MediaPlayer::new()?;
                player.CommandManager()?.SetIsEnabled(false)?;
                player.SetIsMuted(true)?;
                let smtc = player.SystemMediaTransportControls()?;
                smtc.SetIsEnabled(true)?;
                smtc.SetIsPlayEnabled(true)?;
                smtc.SetIsPauseEnabled(true)?;
                let updater = smtc.DisplayUpdater()?;
                updater.SetType(MediaPlaybackType::Music)?;
                updater
                    .MusicProperties()?
                    .SetTitle(&HSTRING::from("Silent identity verification"))?;
                updater.Update()?;
                smtc.SetPlaybackStatus(MediaPlaybackStatus::Paused)?;
                let manager =
                    GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                let mut found = false;
                let mut observed_ids = std::collections::BTreeSet::new();
                let mut name_result = String::new();
                while std::time::Instant::now() < deadline {
                    let sessions = manager.GetSessions()?;
                    for i in 0..sessions.Size()? {
                        let session = sessions.GetAt(i)?;
                        let source_id = session.SourceAppUserModelId()?.to_string();
                        observed_ids.insert(source_id.clone());
                        if source_id != identity.id {
                            continue;
                        }
                        let item: windows::core::Result<IShellItem> = unsafe {
                            SHCreateItemInKnownFolder(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, &HSTRING::from(&identity.id))
                        };
                        if let Ok(info) = item {
                            let display_name = unsafe { info.GetDisplayName(SIGDN_NORMALDISPLAY)? };
                            name_result = unsafe { display_name.to_string()? };
                            unsafe { CoTaskMemFree(Some(display_name.0.cast())) };
                            if name_result == identity.name {
                                found = true;
                                break;
                            }
                        } else if let Err(error) = item {
                            name_result = format!("Shell did not resolve this identity: {error}");
                        }
                    }
                    if found {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed)?;
                smtc.SetIsEnabled(false)?;
                player.Close()?;
                if !found {
                    eprintln!("Expected identity: {}; observed: {observed_ids:?}; name result: {name_result}", identity.id);
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004005u32 as i32,
                    )));
                }
                println!("SMTC source identity and Windows display name both resolved");
                Ok(())
            })();
            unsafe { RoUninitialize() };
            result
        })
        .join();
        // Only this test's unique file, checked absent before creation, is removed.
        std::fs::remove_file(&path).unwrap();
        outcome.unwrap().unwrap();
    }

    #[test]
    fn release_identity_is_stable_and_debug_has_its_own_shell_entry() {
        let release = AppIdentity::new("dev.qqmusic.gui", "Murphy’s Music Lab", false);
        let debug = AppIdentity::new("dev.qqmusic.gui", "Murphy’s Music Lab", true);
        assert_eq!(release.id, "dev.qqmusic.gui");
        assert_eq!(release.name, "Murphy’s Music Lab");
        assert_eq!(debug.id, "dev.qqmusic.gui.debug");
        assert_eq!(debug.name, "Murphy’s Music Lab (Debug)");
    }

    #[test]
    fn shell_shortcut_round_trip_is_idempotent_and_retargets_after_a_portable_move() {
        std::thread::spawn(|| {
            let _com = ComApartment::new().unwrap();
            let root =
                std::env::temp_dir().join(format!("music-lab-identity-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("音乐播放器.lnk");
            let first = root.join("初始位置.exe");
            let moved = root.join("移动后.exe");
            let identity = AppIdentity::new("dev.qqmusic.gui.test", "测试 Music Lab", false);
            identity.write_shortcut(&path, &first).unwrap();
            let before = std::fs::read(&path).unwrap();
            identity.write_shortcut(&path, &first).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), before);
            identity.write_shortcut(&path, &moved).unwrap();
            let link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
            let persist: IPersistFile = link.cast().unwrap();
            unsafe { persist.Load(&HSTRING::from(path.as_os_str()), STGM_READWRITE) }.unwrap();
            let mut target = vec![0u16; 32768];
            unsafe { link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }
                .unwrap();
            assert_eq!(utf16_path(&target), moved);
            let properties: IPropertyStore = link.cast().unwrap();
            let stored = unsafe { properties.GetValue(&PKEY_AppUserModel_ID) }.unwrap();
            assert_eq!(stored.to_string(), identity.id);
            assert_eq!(stored.vt(), VT_LPWSTR);
            let before_conflict = std::fs::read(&path).unwrap();
            let other = AppIdentity::new("another.app", "Other", false);
            assert_eq!(
                other.write_shortcut(&path, &first),
                Err("shortcut_identity_conflict")
            );
            assert_eq!(std::fs::read(&path).unwrap(), before_conflict);
            drop(properties);
            drop(persist);
            drop(link);
            std::fs::remove_dir_all(root).unwrap();
        })
        .join()
        .unwrap();
    }
}
