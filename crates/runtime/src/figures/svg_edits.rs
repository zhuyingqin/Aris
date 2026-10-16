//! Durable, explicitly submitted SVG conversations. Restart never resumes a turn.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureSvgEdit {
    pub id: String,
    pub base_version: usize,
    pub base_hash: String,
    pub prompt: String,
    pub result_version: Option<usize>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

/// Reusing a turn ID is idempotent; a different payload for that ID is rejected.
pub fn begin(
    workspace: &Path,
    id: &str,
    edit_id: &str,
    base_version: usize,
    expected_hash: &str,
    prompt: &str,
) -> Result<(FigureRun, bool), String> {
    validate_id(edit_id)?;
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > 4000 {
        return Err("Please describe the SVG change in 1–4000 characters".into());
    }
    update(workspace, id, |run| {
        if let Some(edit) = run.svg_edits.iter().find(|edit| edit.id == edit_id) {
            return if edit.base_version == base_version
                && edit.base_hash == expected_hash
                && edit.prompt == prompt
            {
                Ok(false)
            } else {
                Err("This SVG edit ID already belongs to another request".into())
            };
        }
        let version = run
            .versions
            .last()
            .ok_or("Save an SVG version before requesting a change")?;
        if version.index != base_version || version.hash != expected_hash {
            return Err(
                "SVG changed. Reload the current version before requesting a change".into(),
            );
        }
        if run
            .requests
            .iter()
            .any(|r| matches!(r.status.as_str(), "submitted" | "unknown"))
            || run.svg_edits.iter().any(|edit| edit.status == "running")
        {
            return Err("Wait for the current request to finish before editing the SVG".into());
        }
        if run.pending_raster_edit.is_some() {
            return Err("Choose how to apply the returned image first".into());
        }
        if run.versions.len() >= 100 || run.requests.len() > 198 || run.svg_edits.len() >= 100 {
            return Err("Figure version or request limit reached".into());
        }
        run.svg_edits.push(FigureSvgEdit {
            id: edit_id.into(),
            base_version,
            base_hash: expected_hash.into(),
            prompt: prompt.into(),
            result_version: None,
            status: "running".into(),
            error: None,
            created_at: crate::now_iso8601(),
            finished_at: None,
        });
        run.status = "editing_svg".into();
        run.error = None;
        Ok(true)
    })
}

pub fn finish(
    workspace: &Path,
    id: &str,
    edit_id: &str,
    error: Option<String>,
    cancelled: bool,
) -> Result<FigureRun, String> {
    update(workspace, id, |run| {
        let unresolved = run
            .requests
            .iter()
            .any(|r| matches!(r.status.as_str(), "submitted" | "unknown"));
        let edit = run
            .svg_edits
            .iter_mut()
            .find(|edit| edit.id == edit_id)
            .ok_or("SVG edit not found")?;
        edit.status = if unresolved {
            "unknown"
        } else if cancelled {
            "cancelled"
        } else if error.is_some() {
            "failed"
        } else {
            "completed"
        }
        .into();
        edit.error = error.clone();
        edit.finished_at = Some(crate::now_iso8601());
        if error.is_some() || unresolved || cancelled {
            if run.status != "budget_truncated" {
                run.status = if unresolved {
                    "unknown"
                } else if cancelled {
                    "cancelled"
                } else {
                    "draft"
                }
                .into();
            }
            run.error = error;
        }
        Ok(())
    })
    .map(|(run, ())| run)
}

/// Follow the displayed version's ancestry. Failed turns and edits from a
/// discarded branch are not requirements for the current figure.
pub fn history(run: &FigureRun, version_index: usize) -> Vec<&FigureSvgEdit> {
    let mut result = Vec::new();
    let mut at = Some(version_index);
    while let Some(index) = at {
        let Some(version) = run.versions.iter().find(|v| v.index == index) else {
            break;
        };
        if let Some(edit) = version.svg_edit_id.as_ref().and_then(|id| {
            run.svg_edits
                .iter()
                .find(|edit| &edit.id == id && edit.result_version == Some(index))
        }) {
            result.push(edit);
        }
        // Older manifests predate parent indices and were appended sequentially.
        at = version
            .parent_index
            .or_else(|| index.checked_sub(1))
            .filter(|parent| *parent > 0 && *parent < index);
    }
    result.reverse();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(workspace: &Path) -> FigureRun {
        let run = super::super::tests::run(&"e".repeat(32));
        create(workspace, run, None).unwrap()
    }
    fn version() -> FigureVersion {
        serde_json::from_value(serde_json::json!({"index":0,"hash":"","svgPath":"","pngPath":"","pdfPath":"","author":"test","classification":"editable_vector","textCount":1,"vectorCount":1,"reviewStatus":"visual_pending","renderer":"test","fontFingerprint":"test","createdAt":"now"})).unwrap()
    }
    fn save(
        workspace: &Path,
        run: &FigureRun,
        edit: Option<&str>,
        parent: Option<usize>,
    ) -> FigureRun {
        let mut v = version();
        v.svg_edit_id = edit.map(str::to_string);
        v.parent_index = parent;
        save_version(
            workspace,
            &run.id,
            run.current_hash(),
            &format!("<svg>{}</svg>", run.versions.len()),
            b"png",
            b"pdf",
            v,
        )
        .unwrap()
    }
    #[test]
    fn edit_is_bound_to_a_version_and_duplicate_submission_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let run = save(temp.path(), &run, None, None);
        let id = "a".repeat(32);
        assert!(begin(
            temp.path(),
            &run.id,
            &id,
            2,
            run.current_hash().unwrap(),
            "Fix arrow"
        )
        .is_err());
        assert!(begin(temp.path(), &run.id, &id, 1, "stale", "Fix arrow").is_err());
        let (editing, submitted) = begin(
            temp.path(),
            &run.id,
            &id,
            1,
            run.current_hash().unwrap(),
            "Fix arrow",
        )
        .unwrap();
        assert!(submitted);
        assert!(
            !begin(
                temp.path(),
                &run.id,
                &id,
                1,
                run.current_hash().unwrap(),
                "Fix arrow"
            )
            .unwrap()
            .1
        );
        assert!(begin(
            temp.path(),
            &run.id,
            &id,
            1,
            run.current_hash().unwrap(),
            "Another change"
        )
        .is_err());
        let saved = save(temp.path(), &editing, Some(&id), None);
        assert_eq!(saved.svg_edits[0].result_version, Some(2));
        assert_eq!(saved.versions[1].parent_index, Some(1));
        assert_eq!(
            read_artifact(temp.path(), &run.id, &run.versions[0].svg_path, 100).unwrap(),
            b"<svg>0</svg>"
        );
        finish(temp.path(), &run.id, &id, None, false).unwrap();
        assert!(
            !begin(
                temp.path(),
                &run.id,
                &id,
                1,
                run.current_hash().unwrap(),
                "Fix arrow"
            )
            .unwrap()
            .1
        );
    }
    #[test]
    fn branch_history_excludes_discarded_changes_and_failed_turns() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let run = save(temp.path(), &run, None, None);
        let id = "a".repeat(32);
        let (run, _) = begin(
            temp.path(),
            &run.id,
            &id,
            1,
            run.current_hash().unwrap(),
            "Turn arrows red",
        )
        .unwrap();
        let run = save(temp.path(), &run, Some(&id), None);
        let run = finish(temp.path(), &run.id, &id, None, false).unwrap();
        let run = save(temp.path(), &run, None, None);
        assert_eq!(history(&run, 3)[0].prompt, "Turn arrows red");
        let run = save(temp.path(), &run, None, Some(1));
        assert!(history(&run, 4).is_empty());
        let (run, _) = begin(
            temp.path(),
            &run.id,
            &"b".repeat(32),
            4,
            run.current_hash().unwrap(),
            "Never applied",
        )
        .unwrap();
        let run = finish(
            temp.path(),
            &run.id,
            &"b".repeat(32),
            Some("Invalid SVG".into()),
            false,
        )
        .unwrap();
        assert!(history(&run, 4).is_empty());
    }
    #[test]
    fn restart_preserves_the_turn_and_never_replays_a_submitted_request() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let run = save(temp.path(), &run, None, None);
        let id = "a".repeat(32);
        begin(
            temp.path(),
            &run.id,
            &id,
            1,
            run.current_hash().unwrap(),
            "Larger labels",
        )
        .unwrap();
        begin_request(
            temp.path(),
            &run.id,
            "manual_svg_edit",
            "executor",
            ModelIdentity::default(),
            16384,
        )
        .unwrap();
        for _ in 0..2 {
            let recovered = recover(temp.path(), &run.id).unwrap();
            assert_eq!(recovered.svg_edits[0].status, "unknown");
            assert_eq!(recovered.requests.len(), 1);
            assert_eq!(recovered.versions.len(), 1);
            assert!(
                !begin(
                    temp.path(),
                    &run.id,
                    &id,
                    1,
                    run.current_hash().unwrap(),
                    "Larger labels"
                )
                .unwrap()
                .1
            );
            assert!(begin(
                temp.path(),
                &run.id,
                &"b".repeat(32),
                1,
                run.current_hash().unwrap(),
                "Larger labels"
            )
            .is_err());
        }
    }
    #[test]
    fn explicit_svg_edits_leave_the_automatic_request_budget_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        for kind in [
            "vision_probe",
            "vision_probe",
            "reconstruct",
            "review",
            "revise",
            "review",
            "manual_svg_edit",
            "manual_review",
        ] {
            let request = begin_request(
                temp.path(),
                &run.id,
                kind,
                "executor",
                ModelIdentity::default(),
                16384,
            )
            .unwrap();
            update(temp.path(), &run.id, |run| {
                run.requests
                    .iter_mut()
                    .find(|r| r.id == request.id)
                    .unwrap()
                    .status = "completed".into();
                Ok(())
            })
            .unwrap();
        }
        assert!(begin_request(
            temp.path(),
            &run.id,
            "reconstruct",
            "executor",
            ModelIdentity::default(),
            16384
        )
        .is_err());
    }
}
