//! A mutable local editing draft, separate from immutable published versions.
use super::{directory, load as load_run, read_artifact, MAX_SVG_BYTES, WRITES};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

const FILE: &str = "draft.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FigureDraft {
    pub svg: String,
    pub expected_hash: Option<String>,
    pub base_index: Option<usize>,
    pub updated_at: String,
}

pub fn load(workspace: &Path, id: &str) -> Result<Option<FigureDraft>, String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let dir = directory(workspace, id)?;
    if !dir.join(FILE).try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    // JSON may escape every source character. The decoded source is bounded too.
    let bytes = read_artifact(workspace, id, FILE, MAX_SVG_BYTES * 6 + 4096)?;
    let draft: FigureDraft = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if draft.svg.len() > MAX_SVG_BYTES {
        return Err("Figure draft exceeds 2 MiB".into());
    }
    Ok(Some(draft))
}

pub fn save(
    workspace: &Path,
    id: &str,
    expected_hash: Option<&str>,
    svg: String,
    base_index: Option<usize>,
) -> Result<FigureDraft, String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    let run = load_run(workspace, id)?;
    if run.current_hash() != expected_hash {
        return Err("Figure changed. Your draft has not been overwritten.".into());
    }
    if svg.len() > MAX_SVG_BYTES {
        return Err("Figure draft exceeds 2 MiB".into());
    }
    if base_index.is_some_and(|index| !run.versions.iter().any(|v| v.index == index)) {
        return Err("SVG parent version not found".into());
    }
    // Incomplete source is recoverable text. Callers must validate before
    // loading it into a canvas; autosave never renders or reviews it.
    let draft = FigureDraft {
        svg,
        expected_hash: expected_hash.map(str::to_owned),
        base_index,
        updated_at: crate::now_iso8601(),
    };
    crate::write_file_atomically(
        &directory(workspace, id)?.join(FILE),
        serde_json::to_vec(&draft).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(draft)
}

pub fn discard(workspace: &Path, id: &str) -> Result<(), String> {
    let _lock = WRITES.lock().map_err(|e| e.to_string())?;
    // Require an existing manifest before discarding its editing state.
    load_run(workspace, id)?;
    remove_locked(&directory(workspace, id)?)
}

pub(super) fn remove_locked(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::figures::{self, FigureVersion};

    fn version(author: &str) -> FigureVersion {
        FigureVersion {
            index: 0,
            parent_index: None,
            svg_edit_id: None,
            hash: String::new(),
            svg_path: String::new(),
            png_path: String::new(),
            png_hash: String::new(),
            pdf_path: String::new(),
            author: author.into(),
            classification: "editable_vector".into(),
            text_count: 1,
            vector_count: 1,
            review_status: "accepted".into(),
            renderer: "test".into(),
            font_fingerprint: "test".into(),
            created_at: crate::now_iso8601(),
        }
    }

    fn fixture(workspace: &Path) -> figures::FigureRun {
        let id = "a".repeat(32);
        figures::create(workspace, figures::tests::run(&id), Some(b"source")).unwrap();
        figures::save_version(
            workspace,
            &id,
            None,
            "original",
            b"png",
            b"pdf",
            version("executor"),
        )
        .unwrap()
    }

    #[test]
    fn autosave_restores_partial_source_without_changing_versions_or_review_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let mut run = fixture(temp.path());
        run = figures::update(temp.path(), &run.id, |r| {
            r.status = "accepted".into();
            r.review = Some(figures::FigureReview {
                version_hash: r.current_hash().unwrap().into(),
                structure_pass: true,
                visual_pass: Some(true),
                issues: vec![],
                received_images: true,
                evidence_hashes: vec!["png".into()],
                raw_response: "{}".into(),
            });
            Ok(())
        })
        .unwrap()
        .0;
        let dir = directory(temp.path(), &run.id).unwrap();
        fs::write(dir.join("final.svg"), "original").unwrap();
        let manifest = fs::read(dir.join("manifest.json")).unwrap();
        for svg in ["first edit", "<svg><text>incomplete", ""] {
            let draft = save(
                temp.path(),
                &run.id,
                run.current_hash(),
                svg.into(),
                Some(1),
            )
            .unwrap();
            assert_eq!(load(temp.path(), &run.id).unwrap(), Some(draft));
        }
        assert_eq!(fs::read(dir.join("manifest.json")).unwrap(), manifest);
        assert_eq!(
            fs::read_to_string(dir.join("current.svg")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(dir.join("versions/0001.svg")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(dir.join("final.svg")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(dir.join("versions")).unwrap().count(), 3);
        assert_eq!(
            figures::recover(temp.path(), &run.id)
                .unwrap()
                .versions
                .len(),
            1
        );
        assert_eq!(load(temp.path(), &run.id).unwrap().unwrap().svg, "");
    }

    #[test]
    fn conflicts_preserve_the_draft_and_manual_commit_alone_clears_it() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let draft = save(
            temp.path(),
            &run.id,
            run.current_hash(),
            "draft".into(),
            Some(1),
        )
        .unwrap();
        let refreshed = figures::save_version(
            temp.path(),
            &run.id,
            run.current_hash(),
            "other version",
            b"png",
            b"pdf",
            version("renderer_refresh"),
        )
        .unwrap();
        assert_eq!(load(temp.path(), &run.id).unwrap(), Some(draft.clone()));
        assert!(save(
            temp.path(),
            &run.id,
            run.current_hash(),
            "stale autosave".into(),
            Some(1)
        )
        .is_err());
        assert!(figures::save_version(
            temp.path(),
            &run.id,
            run.current_hash(),
            "stale commit",
            b"png",
            b"pdf",
            version("user")
        )
        .is_err());
        assert_eq!(load(temp.path(), &run.id).unwrap(), Some(draft));
        let mut historical = version("user");
        historical.parent_index = Some(1);
        let committed = figures::save_version(
            temp.path(),
            &run.id,
            refreshed.current_hash(),
            "draft",
            b"png",
            b"pdf",
            historical,
        )
        .unwrap();
        assert_eq!(committed.versions.len(), 3);
        assert_eq!(committed.versions.last().unwrap().parent_index, Some(1));
        assert!(load(temp.path(), &run.id).unwrap().is_none());
        assert!(save(
            temp.path(),
            &run.id,
            refreshed.current_hash(),
            "late autosave".into(),
            Some(1)
        )
        .is_err());
        assert!(load(temp.path(), &run.id).unwrap().is_none());
    }

    #[test]
    fn discard_and_input_limits_preserve_saved_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let draft = save(
            temp.path(),
            &run.id,
            run.current_hash(),
            "draft".into(),
            Some(1),
        )
        .unwrap();
        assert!(save(
            temp.path(),
            &run.id,
            run.current_hash(),
            "x".repeat(MAX_SVG_BYTES + 1),
            Some(1)
        )
        .is_err());
        assert!(save(
            temp.path(),
            &run.id,
            run.current_hash(),
            "wrong base".into(),
            Some(10)
        )
        .is_err());
        assert!(save(temp.path(), "../escape", None, "outside".into(), None).is_err());
        assert_eq!(load(temp.path(), &run.id).unwrap(), Some(draft));
        discard(temp.path(), &run.id).unwrap();
        discard(temp.path(), &run.id).unwrap();
        assert!(load(temp.path(), &run.id).unwrap().is_none());
        assert_eq!(
            figures::load(temp.path(), &run.id).unwrap().versions.len(),
            1
        );
        assert_eq!(
            fs::read_to_string(directory(temp.path(), &run.id).unwrap().join("current.svg"))
                .unwrap(),
            "original"
        );
    }
}
