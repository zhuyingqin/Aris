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
