use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn write_replace(path: &Path, body: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = temp_path(path);
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(body.as_ref())?;
        file.sync_all()?;
    }
    replace_file(&tmp, path)
}

fn temp_path(path: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mail-store");
    path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        counter
    ))
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, path: &Path) -> io::Result<()> {
    std::fs::rename(tmp, path)
}

#[cfg(windows)]
fn replace_file(tmp: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let tmp_wide = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    // Win32's replace flag avoids the remove-then-rename data-loss window that
    // std::fs::rename has on Windows when the target already exists.
    let ok = unsafe { MoveFileExW(tmp_wide.as_ptr(), path_wide.as_ptr(), flags) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::write_replace;

    #[test]
    fn write_replace_creates_and_replaces_file() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aris-mail-atomic-file-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("accounts.json");

        write_replace(&path, b"{\"version\":1}").expect("initial write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read initial"),
            "{\"version\":1}"
        );
        write_replace(&path, b"{\"version\":2}").expect("replace write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read replaced"),
            "{\"version\":2}"
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
