//! Older Figures saved an extra SomniImage archive before copying its source
//! into the task. New generations live in the task; clean linked legacy copies
//! only when both manifests identify the same archive inside this project.
use super::*;

pub(super) fn remove_legacy_generation(workspace: &Path, task: &Path) -> Result<(), String> {
    let metadata = task.join("generation.json");
    let content = match fs::read(&metadata) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let output: Value = serde_json::from_slice(&content)
        .map_err(|error| format!("Cannot inspect the figure generation archive: {error}"))?;
    let images = output.get("images").and_then(Value::as_array);
    let legacy = images.is_some_and(|images| images.iter().any(|image| {
        image.get("path").and_then(Value::as_str)
            .is_some_and(|path| path.replace('\\', "/").starts_with(".somniq/artifacts/somni-images/"))
    }));
    if !legacy { return Ok(()); }
    let archive_id = output.get("requestId").and_then(Value::as_str)
        .filter(|id| id.len() == 24 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .ok_or("Invalid legacy figure generation archive ID")?;
    let prefix = format!(".somniq/artifacts/somni-images/{archive_id}/");
    if output.get("provider").and_then(Value::as_str) != Some("somni")
        || !images.unwrap().iter().all(|image| {
            image.get("path").and_then(Value::as_str).is_some_and(|path| {
                path.replace('\\', "/").strip_prefix(&prefix).is_some_and(|name| {
                    name.starts_with("image-") && !name.contains(['/', '\\']) && !name.contains("..")
                })
            })
        }) {
        return Err("Legacy figure generation archive does not match its task".into());
    }
    let archive = workspace.join(".somniq/artifacts/somni-images").join(archive_id);
    if !archive.try_exists().map_err(|e| e.to_string())? { return Ok(()); }
    let parent = workspace.join(".somniq/artifacts/somni-images").canonicalize().map_err(|e| e.to_string())?;
    let canonical = archive.canonicalize().map_err(|e| e.to_string())?;
    if !parent.starts_with(workspace) || canonical.parent() != Some(parent.as_path()) || !canonical.is_dir()
        || !canonical.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case(archive_id)) {
        return Err("Legacy figure generation archive must remain inside its project".into());
    }
    let recorded: Value = serde_json::from_slice(&fs::read(canonical.join("generation.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if recorded != output {
        return Err("Legacy figure generation archive belongs to a different request".into());
    }
    fs::remove_dir_all(canonical).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(workspace: &Path) -> (String, PathBuf, Value) {
        let id = "a".repeat(32);
        let mut run = crate::figures::tests::run(&id);
        run.source_mode = "generate".into();
        create(workspace, run, Some(b"original")).unwrap();
        let archive_id = "A".repeat(24);
        let archive = workspace.join(".somniq/artifacts/somni-images").join(&archive_id);
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("image-1.png"), b"generated").unwrap();
        let output = serde_json::json!({"provider": "somni", "requestId": archive_id,
            "prompt": "A research diagram", "images": [{"path": format!(".somniq/artifacts/somni-images/{archive_id}/image-1.png")} ]});
        let bytes = serde_json::to_vec(&output).unwrap();
        fs::write(archive.join("generation.json"), &bytes).unwrap();
        fs::write(directory(workspace, &id).unwrap().join("generation.json"), bytes).unwrap();
        (id, archive, output)
    }

    #[test]
    fn deletion_removes_the_linked_legacy_generation_but_preserves_other_images_and_exports() {
        let workspace = tempfile::tempdir().unwrap();
        let (id, archive, _) = fixture(workspace.path());
        let task = directory(workspace.path(), &id).unwrap();
        let unrelated = archive.parent().unwrap().join("B".repeat(24));
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("image-1.png"), b"other chat image").unwrap();
        let export = workspace.path().join("exported.svg");
        fs::write(&export, b"user export").unwrap();
        delete(workspace.path(), &id).unwrap();
        assert!(!archive.exists());
        assert!(!task.exists());
        assert_eq!(fs::read(unrelated.join("image-1.png")).unwrap(), b"other chat image");
        assert_eq!(fs::read(export).unwrap(), b"user export");
        delete(workspace.path(), &id).unwrap();
    }

    #[test]
    fn deletion_rejects_mismatched_or_escaping_legacy_archives_without_removing_the_task() {
        let workspace = tempfile::tempdir().unwrap();
        let (id, archive, mut output) = fixture(workspace.path());
        let task = directory(workspace.path(), &id).unwrap();
        output["prompt"] = serde_json::json!("different request");
        fs::write(task.join("generation.json"), serde_json::to_vec(&output).unwrap()).unwrap();
        assert!(delete(workspace.path(), &id).unwrap_err().contains("different request"));
        assert!(task.join("manifest.json").exists());
        assert!(archive.join("image-1.png").exists());
        output["images"][0]["path"] = serde_json::json!(format!(".somniq/artifacts/somni-images/{}/../other/image-1.png", "A".repeat(24)));
        fs::write(task.join("generation.json"), serde_json::to_vec(&output).unwrap()).unwrap();
        assert!(delete(workspace.path(), &id).is_err());
        assert!(task.exists());
        assert!(archive.exists());
    }

    #[test]
    fn deletion_finishes_when_the_linked_legacy_archive_was_already_removed() {
        let workspace = tempfile::tempdir().unwrap();
        let (id, archive, _) = fixture(workspace.path());
        let task = directory(workspace.path(), &id).unwrap();
        fs::remove_dir_all(archive).unwrap();
        delete(workspace.path(), &id).unwrap();
        assert!(!task.exists());
    }
}
