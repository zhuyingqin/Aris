use std::io::{self, Write};
use std::path::Path;

pub fn write_replace(path: &Path, body: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(body.as_ref())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map(|_| ()).map_err(|error| error.error)
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
            "aris-runtime-atomic-file-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("session.json");

        write_replace(&path, b"old").expect("initial write");
        write_replace(&path, b"new").expect("replacement write");

        assert_eq!(std::fs::read(&path).expect("read file"), b"new");
        let _ = std::fs::remove_dir_all(dir);
    }
}
