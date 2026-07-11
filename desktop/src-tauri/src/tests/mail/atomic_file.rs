use super::write_replace;

#[test]
fn write_replace_creates_and_replaces_file() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "somniq-mail-atomic-file-{}-{unique}",
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
