//! One explicit SVG edit followed by one independent review, without retries.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditSvgInput {
    project_id: String,
    id: String,
    edit_id: String,
    base_index: usize,
    expected_hash: String,
    prompt: String,
}

#[tauri::command]
pub async fn figures_edit_svg(app: AppHandle, input: EditSvgInput) -> Result<FigureView, String> {
    let workspace = project(&app, &input.project_id)?;
    let key = (input.project_id.clone(), input.id.clone());
    let mut jobs = active_runs().lock().map_err(|e| e.to_string())?;
    let run = store::load(&workspace, &input.id)?;
    if run.svg_edits.iter().any(|edit| edit.id == input.edit_id) {
        let (run, _) = store::svg_edits::begin(
            &workspace,
            &input.id,
            &input.edit_id,
            input.base_index,
            &input.expected_hash,
            &input.prompt,
        )?;
        return Ok(view_unlocked(
            &input.project_id,
            run,
            jobs.contains_key(&key),
            jobs.len(),
        ));
    }
    if jobs.contains_key(&key) {
        return Err("Wait for the active figure task before editing the SVG".into());
    }
    let (executor, reviewer) =
        crate::engine::figure_connections(Some(&run.executor.model), Some(&run.reviewer.model))?;
    if executor.identity != run.executor || reviewer.figure_identity() != run.reviewer {
        return Err(
            "Model connection changed. Use the original connection or create a new figure task"
                .into(),
        );
    }
    let (run, _) = store::svg_edits::begin(
        &workspace,
        &input.id,
        &input.edit_id,
        input.base_index,
        &input.expected_hash,
        &input.prompt,
    )?;
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.insert(key.clone(), cancelled.clone());
    let initial = view_unlocked(&input.project_id, run.clone(), true, jobs.len());
    drop(jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = Guard { key };
        let result = edit_once(
            &workspace,
            &run,
            &input.edit_id,
            &cancelled,
            |request| {
                executor.run_with_limit(
                    &store::routing_session_id(&workspace, &input.id, "executor"),
                    request,
                    svg_cap(&run),
                    cancelled.clone(),
                )
            },
            |request| {
                reviewer.run_figure_request(
                    &store::routing_session_id(&workspace, &input.id, "reviewer"),
                    request,
                    REVIEW_OUTPUT_LIMIT,
                    cancelled.clone(),
                )
            },
            || emit(&app, &input.project_id, &workspace, &input.id),
        );
        let _ = store::svg_edits::finish(
            &workspace,
            &input.id,
            &input.edit_id,
            result.err(),
            cancelled.load(Ordering::SeqCst),
        );
        drop(guard);
        emit(&app, &input.project_id, &workspace, &input.id);
    });
    Ok(initial)
}

fn edit_once(
    workspace: &Path,
    run: &FigureRun,
    edit_id: &str,
    cancelled: &Arc<AtomicBool>,
    execute: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
    review_model: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
    notify: impl Fn(),
) -> Result<(), String> {
    let check_cancelled = || {
        if cancelled.load(Ordering::SeqCst) {
            Err("SVG edit cancelled".to_string())
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let edit = run
        .svg_edits
        .iter()
        .find(|edit| edit.id == edit_id && edit.status == "running")
        .ok_or("SVG edit not found")?;
    let version = run.versions.last().ok_or("No saved SVG")?;
    let svg = String::from_utf8(store::read_artifact(
        workspace,
        &run.id,
        &version.svg_path,
        store::MAX_SVG_BYTES,
    )?)
    .map_err(|e| e.to_string())?;
    if version.index != edit.base_version || store::hash(svg.as_bytes()) != edit.base_hash {
        return Err("SVG base integrity check failed".into());
    }
    // Validate all local inputs before sending either model a request.
    tools::figures::inspect(&svg)?;
    let original = (
        run.source_mime.clone().ok_or("Source image is missing")?,
        base64::engine::general_purpose::STANDARD.encode(store::source(workspace, run)?),
    );
    let images = if run.executor_vision {
        // Render from the verified SVG using the current local fonts.
        let png = tools::figures::render(&svg)?.png;
        vec![
            (
                "image/png".into(),
                base64::engine::general_purpose::STANDARD.encode(png),
            ),
            original.clone(),
        ]
    } else {
        vec![]
    };
    let history = store::svg_edits::history(run, version.index)
        .iter()
        .map(|edit| edit.prompt.clone())
        .collect::<Vec<_>>();
    let issues = run
        .review
        .as_ref()
        .filter(|review| review.version_hash == version.hash)
        .map(|review| review.issues.as_slice())
        .unwrap_or_default();
    let request = workflow::svg_edit_request(
        &raster::confirmed_method(run),
        &run.style,
        &svg,
        &history,
        &edit.prompt,
        issues,
        images,
    );
    // Prompt + input version are durable; response text and usage use the
    // shared write-ahead request ledger, including partial/unknown results.
    check_cancelled()?;
    notify();
    let reply = call(
        workspace,
        &run.id,
        "manual_svg_edit",
        "executor",
        run.executor.clone(),
        run.output_limit,
        || execute(request),
    )?;
    reject_truncation(workspace, &run.id, &reply)?;
    check_cancelled()?;
    let svg = tools::figures::extract_svg(&reply.text)?;
    let rendered = tools::figures::render(&svg)?;
    check_cancelled()?;
    let mut next_version = rendered.version("executor_edit");
    next_version.parent_index = Some(edit.base_version);
    next_version.svg_edit_id = Some(edit.id.clone());
    let next = store::save_version(
        workspace,
        &run.id,
        Some(&edit.base_hash),
        &svg,
        &rendered.png,
        &rendered.pdf,
        next_version,
    )?;
    store::update(workspace, &run.id, |run| {
        run.status = "reviewing".into();
        Ok(())
    })?;
    notify();
    check_cancelled()?;
    review_once(
        workspace,
        &run.id,
        &next,
        &original,
        "manual_review",
        review_model,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &str = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='80' viewBox='0 0 180 80'><rect width='180' height='80' fill='white'/><text x='10' y='40'>A</text></svg>";
    fn fixture(workspace: &Path) -> FigureRun {
        let rendered = tools::figures::render(ORIGINAL).unwrap();
        let run = serde_json::from_value(json!({
            "schemaVersion":1,"id":"e".repeat(32),"title":"SVG edit","method":"A to B","style":"paper","sourceMode":"import","sourceMime":"image/png","sourceHash":null,"status":"draft","outputLimit":16384,
            "executor":ModelIdentity::default(),"reviewer":ModelIdentity{model:"independent".into(),..Default::default()},"executorVision":true,"reviewerVision":true,"revisionUsed":true,"versions":[],"requests":[],"review":null,"error":null,"createdAt":"now","updatedAt":"now"
        })).unwrap();
        let run = store::create(workspace, run, Some(&rendered.png)).unwrap();
        persist_svg(workspace, &run.id, None, ORIGINAL, "user").unwrap()
    }
    fn text(request: &runtime::ApiRequest) -> &str {
        let runtime::ContentBlock::Text { text } = &request.messages[0].blocks[0] else {
            panic!("Missing text")
        };
        text
    }
    fn reply(svg: &str) -> ModelReply {
        ModelReply {
            text: svg.into(),
            ..Default::default()
        }
    }
    fn accepted(_: runtime::ApiRequest) -> Result<ModelReply, String> {
        Ok(reply(
            r#"{"structurePass":true,"visualPass":true,"issues":[]}"#,
        ))
    }

    #[test]
    fn conversation_uses_current_svg_and_history_then_reviews_independently() {
        let temp = tempfile::tempdir().unwrap();
        let mut run = fixture(temp.path());
        let cancelled = Arc::new(AtomicBool::new(false));
        for (index, instruction) in [(1, "Change A to B"), (2, "Make B larger")] {
            let edit_id = format!("{index:032x}");
            (run, _) = store::svg_edits::begin(
                temp.path(),
                &run.id,
                &edit_id,
                index,
                run.current_hash().unwrap(),
                instruction,
            )
            .unwrap();
            let output = ORIGINAL
                .replace(">A<", ">B<")
                .replace("y='40'", &format!("y='40' font-size='{}'", 16 + index));
            edit_once(
                temp.path(),
                &run,
                &edit_id,
                &cancelled,
                |request| {
                    let context: Value = serde_json::from_str(text(&request)).unwrap();
                    assert_eq!(context["instruction"], instruction);
                    assert_eq!(request.messages[0].blocks.len(), 3);
                    if index == 2 {
                        assert_eq!(context["appliedEdits"][0], "Change A to B");
                        assert!(context["currentSvg"].as_str().unwrap().contains(">B<"));
                    }
                    Ok(reply(&output))
                },
                |request| {
                    assert_eq!(request.system_prompt, vec![workflow::REVIEW_SYSTEM]);
                    assert!(text(&request).contains(instruction));
                    assert!(text(&request).contains("intentionally differ"));
                    assert_eq!(request.messages[0].blocks.len(), 3);
                    accepted(request)
                },
                || {},
            )
            .unwrap();
            run = store::svg_edits::finish(temp.path(), &run.id, &edit_id, None, false).unwrap();
            assert_eq!(run.status, "accepted");
            assert_eq!(
                run.svg_edits.last().unwrap().result_version,
                Some(index + 1)
            );
            assert_eq!(run.requests.len(), index * 2);
            assert_eq!(run.requests.last().unwrap().role, "reviewer");
            assert_eq!(run.requests.last().unwrap().identity.model, "independent");
        }
        assert_eq!(
            store::read_artifact(temp.path(), &run.id, &run.versions[0].svg_path, 4096).unwrap(),
            ORIGINAL.as_bytes()
        );
        assert!(run.revision_used); // Explicit turns do not reset the automatic revision budget.
    }
    #[test]
    fn invalid_truncated_and_unknown_outputs_preserve_the_original_without_review_or_retry() {
        for (response, status) in [
            (reply("<svg><script>alert(1)</script></svg>"), "failed"),
            (
                ModelReply {
                    text: "<svg".into(),
                    stop_reason: Some("max_tokens".into()),
                    ..Default::default()
                },
                "failed",
            ),
            (
                ModelReply {
                    error: Some("response timeout".into()),
                    ..Default::default()
                },
                "unknown",
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let run = fixture(temp.path());
            let edit_id = "a".repeat(32);
            let (run, _) = store::svg_edits::begin(
                temp.path(),
                &run.id,
                &edit_id,
                1,
                run.current_hash().unwrap(),
                "Fix labels",
            )
            .unwrap();
            let result = edit_once(
                temp.path(),
                &run,
                &edit_id,
                &Arc::new(AtomicBool::new(false)),
                |_| Ok(response),
                |_| panic!("Invalid output must not be reviewed"),
                || {},
            );
            assert!(result.is_err());
            let final_run =
                store::svg_edits::finish(temp.path(), &run.id, &edit_id, result.err(), false)
                    .unwrap();
            assert_eq!(final_run.versions.len(), 1);
            assert_eq!(final_run.requests.len(), 1);
            assert_eq!(final_run.current_hash(), run.current_hash());
            assert_eq!(final_run.svg_edits[0].status, status);
            assert_eq!(
                store::recover(temp.path(), &run.id).unwrap().requests.len(),
                1
            );
        }
    }
    #[test]
    fn review_failure_keeps_the_new_version_and_requested_changes_for_a_later_review() {
        let temp = tempfile::tempdir().unwrap();
        let run = fixture(temp.path());
        let edit_id = "a".repeat(32);
        let (run, _) = store::svg_edits::begin(
            temp.path(),
            &run.id,
            &edit_id,
            1,
            run.current_hash().unwrap(),
            "Change A to B",
        )
        .unwrap();
        let result = edit_once(
            temp.path(),
            &run,
            &edit_id,
            &Arc::new(AtomicBool::new(false)),
            |_| Ok(reply(&ORIGINAL.replace(">A<", ">B<"))),
            |_| Ok(reply("invalid decision")),
            || {},
        );
        let run =
            store::svg_edits::finish(temp.path(), &run.id, &edit_id, result.err(), false).unwrap();
        assert_eq!(run.versions.len(), 2);
        assert_eq!(run.requests.len(), 2);
        assert!(run.review.is_none());
        assert_eq!(run.svg_edits[0].status, "failed");
        let original = (
            "image/png".into(),
            base64::engine::general_purpose::STANDARD
                .encode(store::source(temp.path(), &run).unwrap()),
        );
        review_once(
            temp.path(),
            &run.id,
            &run,
            &original,
            "manual_review",
            |request| {
                assert!(text(&request).contains("Change A to B"));
                accepted(request)
            },
        )
        .unwrap();
        assert_eq!(
            store::load(temp.path(), &run.id).unwrap().status,
            "accepted"
        );
    }
    #[test]
    fn cancellation_and_stale_bases_do_not_overwrite_saved_work() {
        for stale in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let run = fixture(temp.path());
            let edit_id = "a".repeat(32);
            let (run, _) = store::svg_edits::begin(
                temp.path(),
                &run.id,
                &edit_id,
                1,
                run.current_hash().unwrap(),
                "Change A to B",
            )
            .unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let result = edit_once(
                temp.path(),
                &run,
                &edit_id,
                &cancelled,
                |_| {
                    if stale {
                        persist_svg(
                            temp.path(),
                            &run.id,
                            run.current_hash(),
                            &ORIGINAL.replace(">A<", ">User edit<"),
                            "user",
                        )
                        .unwrap();
                    } else {
                        cancelled.store(true, Ordering::SeqCst);
                    }
                    Ok(reply(&ORIGINAL.replace(">A<", ">B<")))
                },
                |_| panic!("No review after cancellation/conflict"),
                || {},
            );
            assert!(result.is_err());
            let final_run =
                store::svg_edits::finish(temp.path(), &run.id, &edit_id, result.err(), !stale)
                    .unwrap();
            assert_eq!(final_run.requests.len(), 1);
            assert_eq!(final_run.svg_edits[0].result_version, None);
            assert_eq!(final_run.versions.len(), if stale { 2 } else { 1 });
        }
    }
}
