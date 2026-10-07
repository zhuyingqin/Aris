//! Explicit, one-shot image edits. The original and every mask/result stay local.
use super::*;
use store::FigureRasterVersion;

pub(super) fn ensure_raster(workspace: &Path, id: &str) -> Result<FigureRun, String> {
    let run = store::load(workspace, id)?;
    if !run.raster_versions.is_empty() {
        return super::raster_result::restore_saved_edit(workspace, run);
    }
    let image = api::validate_image_bytes(store::source(workspace, &run)?)?;
    let mut version = raster_version(&image, None, None, None, None);
    version.request_id = run.requests.iter().rev().find(|r| r.kind == "generate_image").map(|r| r.id.clone());
    version.prompt_request_id = run.requests.iter().rev().find(|r| r.kind == "plan_image").map(|r| r.id.clone());
    store::save_raster(
        workspace,
        id,
        version,
        &image.bytes,
    )
}

pub(super) fn raster_version(
    image: &api::GeneratedImage,
    parent_hash: Option<String>,
    prompt: Option<String>,
    mask_path: Option<String>,
    request_id: Option<String>,
) -> FigureRasterVersion {
    FigureRasterVersion {
        index: 0,
        hash: store::hash(&image.bytes),
        path: String::new(),
        mime_type: image.mime_type.into(),
        width: image.width,
        height: image.height,
        parent_hash,
        parent_index: None,
        prompt,
        mask_path,
        request_id,
        prompt_request_id: None,
        created_at: runtime::now_iso8601(),
    }
}

pub(super) fn raster_image(
    workspace: &Path,
    run: &FigureRun,
    index: usize,
) -> Result<api::GeneratedImage, String> {
    let version = run
        .raster_versions
        .iter()
        .find(|v| v.index == index)
        .ok_or("图片版本不存在。")?;
    let bytes = store::read_artifact(workspace, &run.id, &version.path, store::MAX_SOURCE_BYTES)?;
    if store::hash(&bytes) != version.hash {
        return Err("图片版本完整性检查失败。".into());
    }
    api::validate_image_bytes(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterDocument {
    pub(super) data_url: String,
    pub(super) hash: String,
    pub(super) index: usize,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) edit_prompts: Vec<String>,
    pub(super) resolved_prompt: Option<String>,
    pub(super) prompt_model: Option<String>,
}

#[tauri::command]
pub async fn figures_raster_document(
    app: AppHandle,
    project_id: String,
    id: String,
    index: Option<usize>,
) -> Result<RasterDocument, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut run = ensure_raster(&workspace, &id)?;
        let index = index.or(run.source_raster).unwrap_or(1);
        let image = raster_image(&workspace, &run, index)?;
        run.source_raster = Some(index);
        let (resolved_prompt, prompt_model) = resolved_prompt(&workspace, &run, index)?;
        Ok(RasterDocument {
            data_url: format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(&image.bytes)
            ),
            hash: store::hash(&image.bytes),
            index,
            width: image.width,
            height: image.height,
            edit_prompts: edit_prompts(&run),
            resolved_prompt,
            prompt_model,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn resolved_prompt(workspace: &Path, run: &FigureRun, index: usize) -> Result<(Option<String>, Option<String>), String> {
    let request = run.raster_versions.iter().find(|v| v.index == index)
        .and_then(|v| v.prompt_request_id.as_ref())
        .and_then(|id| run.requests.iter().find(|r| &r.id == id && matches!(r.kind.as_str(), "plan_image" | "manual_image_prompt")));
    let Some(request) = request else { return Ok((None, None)); };
    let bytes = store::read_artifact(workspace, &run.id, &format!("{}.image-prompt.txt", request.id), 100_000)?;
    Ok((Some(String::from_utf8(bytes).map_err(|e| e.to_string())?), Some(request.identity.model.clone())))
}

#[tauri::command]
pub async fn figures_select_raster(
    app: AppHandle,
    project_id: String,
    id: String,
    index: usize,
    expected_hash: String,
) -> Result<FigureView, String> {
    let workspace = project(&app, &project_id)?;
    let jobs = active_runs().lock().map_err(|e| e.to_string())?;
    if jobs.contains_key(&(project_id.clone(), id.clone())) {
        return Err("请等待当前任务完成。".into());
    }
    let run = store::load(&workspace, &id)?;
    raster_image(&workspace, &run, index)?;
    let run = store::select_raster(&workspace, &id, index, &expected_hash)?;
    drop(jobs);
    emit(&app, &project_id, &workspace, &id);
    Ok(view(&project_id, run))
}

#[tauri::command]
pub async fn figures_export_raster(
    app: AppHandle,
    project_id: String,
    id: String,
    index: usize,
    destination: Option<String>,
) -> Result<FigureExport, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let run = ensure_raster(&workspace, &id)?;
        let image = api::image_as_png(raster_image(&workspace, &run, index)?)?;
        if let Some(destination) = destination {
            runtime::write_file_atomically(Path::new(&destination), &image.bytes)
                .map_err(|e| e.to_string())?;
        }
        Ok(FigureExport {
            filename: format!("figure-{}-image-{index}.png", &id[..8]),
            mime_type: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(&image.bytes),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditImageInput {
    project_id: String,
    id: String,
    base_index: usize,
    expected_hash: String,
    prompt: String,
    mask_base64: String,
}

fn edit_allowed(run: &FigureRun) -> bool {
    run.pending_raster_edit.is_none() && !matches!(
        run.status.as_str(),
        "ready"
            | "planning_image"
            | "planning_image_edit"
            | "generating"
            | "editing_image"
            | "probing"
            | "reconstructing"
            | "reviewing"
            | "revising"
            | "unknown"
    ) && !run
        .requests
        .iter()
        .any(|r| matches!(r.status.as_str(), "submitted" | "unknown"))
        && run.raster_versions.len() < 100
        && run.requests.len() < 199
}

/// Keep the confirmed human edits in the semantics used by both roles.
/// A branch from an older image follows its parent chain, not newer revisions.
pub(super) fn confirmed_method(run: &FigureRun) -> String {
    let edits = edit_prompts(run);
    if edits.is_empty() {
        return run.method.clone();
    }
    format!("{}\nHuman-confirmed image edits (in order):\n{}\nUse the confirmed image for the edited labels and appearance. Preserve scientific relationships; report remaining conflicts.", run.method, edits.iter().enumerate().map(|(i, edit)| format!("{}. {}", i + 1, edit)).collect::<Vec<_>>().join("\n"))
}

fn edit_prompts(run: &FigureRun) -> Vec<String> {
    let mut edits = Vec::new();
    let mut current = run
        .source_raster
        .and_then(|index| run.raster_versions.iter().find(|v| v.index == index));
    for _ in 0..run.raster_versions.len() {
        let Some(version) = current else {
            break;
        };
        if let Some(prompt) = &version.prompt {
            edits.push(prompt.clone());
        }
        current = version.parent_hash.as_deref().and_then(|parent| {
            run.raster_versions.iter().rev().find(|v| {
                v.index < version.index
                    && v.hash == parent
                    && version.parent_index.is_none_or(|index| v.index == index)
            })
        });
    }
    edits.reverse();
    edits
}

#[tauri::command]
pub async fn figures_edit_image(
    app: AppHandle,
    input: EditImageInput,
) -> Result<FigureView, String> {
    let workspace = project(&app, &input.project_id)?;
    if input.prompt.trim().is_empty() || input.prompt.len() > 4000 {
        return Err("请填写修改要求，最多 4000 字节。".into());
    }
    if input.mask_base64.len() > 6 * 1024 * 1024 {
        return Err("圈选蒙版过大。".into());
    }
    let mask_bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.mask_base64)
        .map_err(|_| "圈选蒙版编码无效。")?;
    // Validate the base and mask before any paid request is recorded or sent.
    let run = ensure_raster(&workspace, &input.id)?;
    let original = raster_image(&workspace, &run, input.base_index)?;
    if store::hash(&original.bytes) != input.expected_hash {
        return Err("图片已变更，请重新圈选。".into());
    }
    let mask = api::validate_edit_mask(mask_bytes.clone(), &original)?;
    let mut prepared = crate::image_api::prepare_figure_edit(
        "Executor prompt pending".into(),
        run.image_identity.as_ref().map(|i| i.model.clone()),
    )?;
    if let Some(identity) = &run.image_identity {
        let mut expected = identity.clone();
        expected.transport = prepared.identity.transport.clone();
        if expected != prepared.identity {
            return Err("SomniImage 连接已变更，请用此图片新建任务后再修改。".into());
        }
    }
    let executor = prompt::executor(&run)?;
    let key = (input.project_id.clone(), input.id.clone());
    let mut jobs = active_runs().lock().map_err(|e| e.to_string())?;
    if jobs.contains_key(&key) {
        return Err("请等待当前任务完成。".into());
    }
    // Reload under the same lock used by start/review/delete; no double submit.
    let run = store::load(&workspace, &input.id)?;
    if !edit_allowed(&run) {
        return Err("当前任务不能修改图片；请先处理未决请求或新建任务。".into());
    }
    let previous_status = run.status.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.insert(key.clone(), cancelled.clone());
    drop(jobs);
    let output_cap = svg_cap(&run);
    let image_identity = prepared.identity.clone();
    let initial = view(&input.project_id, run);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = Guard { key };
        let result = edit_once(
            &workspace,
            &input,
            original,
            mask,
            &mask_bytes,
            &image_identity,
            &cancelled,
            |request| executor.run_with_limit(&store::routing_session_id(&workspace, &input.id, "executor"), request, output_cap, cancelled.clone()),
            |instruction, reference, mask| { prepared.set_prompt(instruction)?; prepared.edit(reference, mask, cancelled.clone()) },
            || emit(&app, &input.project_id, &workspace, &input.id),
        );
        let _ = finish_edit(&workspace, &input.id, previous_status, result);
        drop(guard);
        emit(&app, &input.project_id, &workspace, &input.id);
    });
    Ok(initial)
}

fn finish_edit(
    workspace: &Path,
    id: &str,
    previous_status: String,
    result: Result<(), String>,
) -> Result<FigureRun, String> {
    store::update(workspace, id, |run| {
        run.status = if run
            .requests
            .iter()
            .any(|r| matches!(r.status.as_str(), "submitted" | "unknown"))
        {
            "unknown".into()
        } else {
            previous_status
        };
        run.error = result.err();
        Ok(())
    })
    .map(|(run, ())| run)
}

fn edit_once(
    workspace: &Path,
    input: &EditImageInput,
    original: api::GeneratedImage,
    mask: api::ImageEditMask,
    mask_bytes: &[u8],
    identity: &ModelIdentity,
    cancelled: &AtomicBool,
    plan: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
    send: impl FnOnce(
        String,
        api::ImageReference,
        &api::ImageEditMask,
    ) -> Result<api::ImageGenerationResult, String>,
    notify: impl Fn(),
) -> Result<(), String> {
    let dir = store::directory(workspace, &input.id)?;
    let mut run = store::load(workspace, &input.id)?;
    // The visible historical version may differ from the frozen SVG reference.
    run.source_raster = Some(input.base_index);
    let selection = mask.selection_preview()?;
    let next_prompt_id = format!("request-{:02}", run.requests.len() + 1);
    runtime::write_file_atomically(&dir.join(format!("{next_prompt_id}.mask.png")), mask_bytes).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&dir.join(format!("{next_prompt_id}.selection.png")), &selection.bytes).map_err(|e| e.to_string())?;
    let request = workflow::image_prompt_request(json!({
        "action": "edit", "requirements": run.method, "style": run.style,
        "priorEdits": edit_prompts(&run), "latestRequest": input.prompt.trim(),
        "baseIndex": input.base_index, "baseHash": input.expected_hash,
        "width": original.width, "height": original.height,
        "selection": "Second image: white pixels editable, black pixels protected. An all-white map permits whole-image edits."
    }), vec![
        (original.mime_type.into(), base64::engine::general_purpose::STANDARD.encode(&original.bytes)),
        (selection.mime_type.into(), base64::engine::general_purpose::STANDARD.encode(&selection.bytes)),
    ]);
    let compiled = prompt::compile_once(workspace, &run, "manual_image_prompt", request, cancelled, plan, &notify)?;
    let instruction = format!("Edit only the transparent pixels in the supplied mask. Keep dimensions exactly {}x{} and preserve all pixels outside the mask. Executor instruction:\n{}", original.width, original.height, compiled.prompt);
    // Save selection and instruction before marking the request submitted.
    let next_id = format!(
        "request-{:02}",
        store::load(workspace, &input.id)?.requests.len() + 1
    );
    let mask_path = format!("{next_id}.mask.png");
    runtime::write_file_atomically(&dir.join(&mask_path), mask_bytes).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&dir.join(format!("{next_id}.edit.json")), serde_json::to_vec_pretty(&json!({
        "prompt": input.prompt.trim(), "baseIndex": input.base_index, "baseHash": input.expected_hash,
        "maskHash": store::hash(mask_bytes), "maskPath": mask_path, "identity": identity,
        "promptRequestId": compiled.request_id, "resolvedPrompt": instruction
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if cancelled.load(Ordering::SeqCst) { return Err("Task cancelled before image editing".into()); }
    let request = store::begin_request(
        workspace,
        &input.id,
        "manual_image_edit",
        "image",
        identity.clone(),
        0,
    )?;
    store::update(workspace, &input.id, |run| {
        run.status = "editing_image".into();
        run.error = None;
        Ok(())
    })?;
    notify();
    let started = Instant::now();
    let reference = api::ImageReference {
        name: format!("reference.{}", original.extension),
        image: api::validate_image_bytes(original.bytes.clone())?,
    };
    let response = match send(instruction, reference, &mask) {
        Ok(result) => result,
        Err(error) => {
            store::update(workspace, &input.id, |run| {
                let entry = run
                    .requests
                    .iter_mut()
                    .find(|r| r.id == request.id)
                    .ok_or("Missing image request")?;
                entry.status = if known_rejection(&error) {
                    "failed"
                } else {
                    "unknown"
                }
                .into();
                entry.error = Some(error.clone());
                entry.finished_at = Some(runtime::now_iso8601());
                entry.duration_ms = started.elapsed().as_millis() as u64;
                Ok(())
            })?;
            return Err(error);
        }
    };
    let edited = response.images.first().ok_or("没有返回修改后的图片。")?;
    runtime::write_file_atomically(
        &dir.join(format!("{}.result.{}", request.id, edited.extension)),
        &edited.bytes,
    )
    .map_err(|e| e.to_string())?;
    runtime::write_file_atomically(&dir.join(format!("{}.result.json", request.id)), serde_json::to_vec_pretty(&json!({"sha256": store::hash(&edited.bytes), "width": edited.width, "height": edited.height, "usage": response.usage, "revisedPrompt": edited.revised_prompt})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    store::update(workspace, &input.id, |run| {
        let entry = run
            .requests
            .iter_mut()
            .find(|r| r.id == request.id)
            .ok_or("Missing image request")?;
        entry.status = "completed".into();
        entry.usage = response.usage;
        entry.finished_at = Some(runtime::now_iso8601());
        entry.duration_ms = started.elapsed().as_millis() as u64;
        Ok(())
    })?;
    if (original.width, original.height) != (edited.width, edited.height) {
        let mut candidate = raster_version(edited, Some(input.expected_hash.clone()), Some(input.prompt.trim().into()), Some(mask_path), Some(request.id.clone()));
        candidate.path = format!("{}.result.{}", request.id, edited.extension);
        candidate.parent_index = Some(input.base_index); candidate.prompt_request_id = Some(compiled.request_id);
        let (run, ()) = store::update(workspace, &input.id, |run| { run.pending_raster_edit = Some(candidate); run.error = None; Ok(()) })?;
        super::raster_result::align_rounding_edit(workspace, run)?;
        return Ok(());
    }
    let result = api::composite_masked_edit(&original, edited, &mask)?;
    let mut version = raster_version(
        &result,
        Some(input.expected_hash.clone()),
        Some(input.prompt.trim().into()),
        Some(mask_path),
        Some(request.id),
    );
    version.parent_index = Some(input.base_index);
    version.prompt_request_id = Some(compiled.request_id);
    store::save_raster(workspace, &input.id, version, &result.bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned_edit(request: runtime::ApiRequest) -> Result<ModelReply, String> {
        assert_eq!(request.messages[0].blocks.iter().filter(|block| matches!(block, runtime::ContentBlock::Image { .. })).count(), 2);
        Ok(ModelReply { text: r#"{"prompt":"Make the selected input blue; retain other content."}"#.into(), ..ModelReply::default() })
    }

    fn fixture(workspace: &Path, id: &str) -> (EditImageInput, api::GeneratedImage, Vec<u8>) {
        fixture_size(workspace, id, 4, 3)
    }

    fn fixture_size(workspace: &Path, id: &str, width: u32, height: u32) -> (EditImageInput, api::GeneratedImage, Vec<u8>) {
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion": 1, "id": id, "title": "Edit", "method": "A to B", "style": "paper", "sourceMode": "import", "sourceMime": "image/png", "sourceHash": null,
            "status": "ready", "outputLimit": 0, "executor": ModelIdentity::default(), "reviewer": ModelIdentity::default(),
            "executorVision": false, "reviewerVision": false, "revisionUsed": false, "versions": [], "requests": [], "review": null, "error": null, "createdAt": "now", "updatedAt": "now"
        })).unwrap();
        let original = tools::figures::render(&format!("<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}'><rect width='{width}' height='{height}' fill='red'/></svg>")).unwrap().png;
        let mask = tools::figures::render(&format!("<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}'><rect x='1' width='{}' height='{height}' fill='white'/></svg>", width - 1)).unwrap().png;
        store::create(workspace, run, Some(&original)).unwrap();
        ensure_raster(workspace, id).unwrap();
        store::update(workspace, id, |r| {
            r.status = "image_ready".into();
            Ok(())
        })
        .unwrap();
        (
            EditImageInput {
                project_id: "fixture".into(),
                id: id.into(),
                base_index: 1,
                expected_hash: store::hash(&original),
                prompt: "blue input".into(),
                mask_base64: String::new(),
            },
            api::validate_image_bytes(original).unwrap(),
            mask,
        )
    }

    #[test]
    fn one_pixel_rounding_applies_without_a_choice_on_fresh_and_recovered_edits() {
        let workspace = tempfile::tempdir().unwrap(); let id = "f".repeat(32);
        let (input, original, mask_bytes) = fixture_size(workspace.path(), &id, 2171, 724);
        let original_bytes = original.bytes.clone();
        let returned_bytes = tools::figures::render("<svg xmlns='http://www.w3.org/2000/svg' width='2170' height='725'><rect width='2170' height='725' fill='blue'/></svg>").unwrap().png;
        let returned = api::validate_image_bytes(returned_bytes.clone()).unwrap();
        let mask = api::validate_edit_mask(mask_bytes.clone(), &original).unwrap();
        let expected = api::composite_masked_edit(&original, &api::resize_image_exact(&returned, 2171, 724).unwrap(), &mask).unwrap();
        let mut pending = raster_version(&returned, Some(input.expected_hash.clone()), Some(input.prompt.clone()), Some("request-02.mask.png".into()), Some("request-02".into()));
        pending.path = "request-02.result.png".into(); pending.parent_index = Some(1); pending.prompt_request_id = Some("request-01".into());
        let mut image_calls = 0;
        let result = edit_once(workspace.path(), &input, original, mask, &mask_bytes, &ModelIdentity::default(), &AtomicBool::new(false), planned_edit,
            |_, _, _| { image_calls += 1; Ok(api::ImageGenerationResult { images: vec![api::validate_image_bytes(returned_bytes.clone()).unwrap()], usage: Some(json!({"total_tokens":4})) }) }, || {});
        let mut run = finish_edit(workspace.path(), &id, "image_ready".into(), result).unwrap();
        for mode in ["fresh", "pending", "legacy"] {
            if mode != "fresh" {
                std::fs::remove_file(store::directory(workspace.path(), &id).unwrap().join("request-02.application.json")).unwrap();
                store::update(workspace.path(), &id, |r| {
                    r.raster_versions.truncate(1); r.source_raster=Some(1); r.source_hash=Some(input.expected_hash.clone());
                    r.pending_raster_edit=if mode=="pending" {Some(pending.clone())} else {None};
                    r.error=Some("old dimensions error".into()); Ok(())
                }).unwrap();
                if mode == "pending" {
                    // List and raster document recovery may race; adoption must be unique.
                    std::thread::scope(|scope| {
                        let a=scope.spawn(|| ensure_raster(workspace.path(), &id).unwrap());
                        let b=scope.spawn(|| ensure_raster(workspace.path(), &id).unwrap());
                        assert_eq!(a.join().unwrap().raster_versions.len(),2);
                        assert_eq!(b.join().unwrap().raster_versions.len(),2);
                    });
                }
                run=ensure_raster(workspace.path(), &id).unwrap();
            }
            assert!(run.pending_raster_edit.is_none(),"{mode}"); assert!(run.error.is_none(),"{mode}");
            assert!(run.can_confirm_image()); assert!(edit_allowed(&run));
            assert_eq!(run.raster_versions.len(),2); assert_eq!(run.requests.len(),2);
            assert_eq!(run.source_raster,Some(2)); assert_eq!(run.requests[1].usage.as_ref().unwrap()["total_tokens"],4);
            let applied=raster_image(workspace.path(), &run,2).unwrap();
            assert_eq!((applied.width,applied.height),(2171,724)); assert_eq!(applied.bytes,expected.bytes);
            assert_eq!(store::read_artifact(workspace.path(), &id,"figure.source",store::MAX_SOURCE_BYTES).unwrap(),original_bytes);
            assert_eq!(store::read_artifact(workspace.path(), &id,"request-02.result.png",store::MAX_SOURCE_BYTES).unwrap(),returned_bytes);
            let audit:Value=serde_json::from_slice(&store::read_artifact(workspace.path(), &id,"request-02.application.json",100_000).unwrap()).unwrap();
            assert_eq!(audit["choice"],"aligned"); assert_eq!(audit["automatic"],true);
            assert_eq!(audit["returnedWidth"],2170); assert_eq!(audit["returnedHeight"],725);
            assert_eq!(ensure_raster(workspace.path(), &id).unwrap().raster_versions.len(),2);
        }
        // An unresolved request is never silently completed by recovery. Once
        // completed, a later PNG edit must still preserve its confirmed SVG base.
        store::update(workspace.path(), &id, |r| {
            r.raster_versions.truncate(1); r.source_raster=Some(1); r.source_hash=Some(input.expected_hash.clone());
            r.image_confirmed=true; r.status="unknown".into(); r.requests[1].status="unknown".into();
            r.pending_raster_edit=Some(pending); Ok(())
        }).unwrap();
        assert!(ensure_raster(workspace.path(), &id).unwrap().pending_raster_edit.is_some());
        store::update(workspace.path(), &id, |r| {r.requests[1].status="completed".into();r.status="draft".into();Ok(())}).unwrap();
        let frozen=ensure_raster(workspace.path(), &id).unwrap();
        assert!(frozen.pending_raster_edit.is_none()); assert_eq!(frozen.raster_versions.len(),2);
        assert_eq!(frozen.source_raster,Some(1)); assert_eq!(frozen.source_hash.as_deref(),Some(input.expected_hash.as_str()));
        assert_eq!(frozen.requests.len(),2); assert_eq!(image_calls,1);
    }

    #[test]
    fn different_size_results_wait_for_a_local_choice_and_restore_legacy_saved_output() {
        let returned = tools::figures::render("<svg xmlns='http://www.w3.org/2000/svg' width='6' height='2'><rect width='6' height='2' fill='blue'/></svg>").unwrap().png;
        for choice in ["returned", "selection", "keep"] {
            let workspace = tempfile::tempdir().unwrap(); let id = "e".repeat(32);
            let (input, original, mask_bytes) = fixture(workspace.path(), &id);
            let original_bytes = original.bytes.clone();
            let mask = api::validate_edit_mask(mask_bytes.clone(), &original).unwrap();
            let result = edit_once(workspace.path(), &input, original, mask, &mask_bytes, &ModelIdentity::default(), &AtomicBool::new(false), planned_edit,
                |_, _, _| Ok(api::ImageGenerationResult { images: vec![api::validate_image_bytes(returned.clone()).unwrap()], usage: Some(json!({"total_tokens":4})) }), || {});
            let run = finish_edit(workspace.path(), &id, "image_ready".into(), result).unwrap();
            assert!(run.error.is_none()); assert_eq!(run.raster_versions.len(),1);
            assert_eq!(run.source_hash.as_deref(),Some(input.expected_hash.as_str()));
            assert!(!run.can_confirm_image()); assert!(!edit_allowed(&run));
            assert_eq!(run.requests.last().unwrap().status,"completed");
            assert!(store::recover(workspace.path(), &id).unwrap().pending_raster_edit.is_some());
            // Simulate a pre-upgrade manifest. Its existing raw result is offered
            // without resubmitting anything or changing the original reference.
            store::update(workspace.path(), &id, |r| { r.pending_raster_edit=None; r.error=Some("服务返回的图片尺寸与原图不同".into()); Ok(()) }).unwrap();
            let restored=ensure_raster(workspace.path(), &id).unwrap();
            let candidate=restored.pending_raster_edit.as_ref().unwrap();
            assert!(restored.error.is_none()); assert_eq!((candidate.width,candidate.height),(6,2));
            assert!(crate::figures::raster_result::resolve_once(workspace.path(), &id,"request-02","stale",choice).is_err());
            let resolved=crate::figures::raster_result::resolve_once(workspace.path(), &id,"request-02",&candidate.hash,choice).unwrap();
            assert!(resolved.pending_raster_edit.is_none()); assert_eq!(resolved.requests.len(),2);
            assert_eq!(resolved.requests[1].usage.as_ref().unwrap()["total_tokens"],4);
            assert!(resolved.can_confirm_image());
            assert_eq!(store::read_artifact(workspace.path(), &id,"figure.source",10000).unwrap(),original_bytes);
            assert_eq!(store::read_artifact(workspace.path(), &id,"request-02.result.png",10000).unwrap(),returned);
            if choice=="keep" { assert_eq!(resolved.raster_versions.len(),1); }
            else { let last=resolved.raster_versions.last().unwrap(); assert_eq!((last.width,last.height),if choice=="returned" {(6,2)} else {(4,3)}); assert_eq!(last.parent_index,Some(1)); }
            assert!(crate::figures::raster_result::resolve_once(workspace.path(), &id,"request-02",&candidate.hash,choice).is_err());
            assert!(ensure_raster(workspace.path(), &id).unwrap().pending_raster_edit.is_none());
        }
    }

    #[test]
    fn explicit_png_edit_records_evidence_and_freezes_the_confirmed_parent_branch() {
        let workspace = tempfile::tempdir().unwrap();
        let id = "a".repeat(32);
        let (input, original, mask_bytes) = fixture(workspace.path(), &id);
        let mask = api::validate_edit_mask(mask_bytes.clone(), &original).unwrap();
        let edited = tools::figures::render("<svg xmlns='http://www.w3.org/2000/svg' width='4' height='3'><rect width='4' height='3' fill='blue'/></svg>").unwrap().png;
        let mut sent = 0;
        let result = edit_once(
            workspace.path(),
            &input,
            original,
            mask,
            &mask_bytes,
            &ModelIdentity::default(),
            &AtomicBool::new(false),
            planned_edit,
            |instruction, reference, _| {
                assert!(instruction.contains("Make the selected input blue"));
                sent += 1;
                assert_eq!(store::hash(&reference.image.bytes), input.expected_hash);
                Ok(api::ImageGenerationResult {
                    images: vec![api::validate_image_bytes(edited).unwrap()],
                    usage: Some(json!({"total_tokens": 4})),
                })
            },
            || {},
        );
        let run = finish_edit(workspace.path(), &id, "image_ready".into(), result).unwrap();
        assert_eq!(sent, 1);
        assert_eq!(run.raster_versions.len(), 2);
        assert_eq!(run.source_raster, Some(2));
        assert_eq!(run.requests[0].status, "completed");
        assert_eq!(run.requests[0].kind, "manual_image_prompt");
        assert_eq!(run.requests[1].usage.as_ref().unwrap()["total_tokens"], 4);
        assert_eq!(run.raster_versions[1].prompt_request_id.as_deref(), Some("request-01"));
        assert!(resolved_prompt(workspace.path(), &run, 2).unwrap().0.unwrap().contains("Make the selected input blue"));
        assert!(run.can_confirm_image());
        assert_eq!(
            store::read_artifact(workspace.path(), &id, "request-02.mask.png", 10000).unwrap(),
            mask_bytes
        );
        assert!(store::read_artifact(workspace.path(), &id, "request-02.edit.json", 10000).is_ok());
        let confirmed =
            store::confirm_image(workspace.path(), &id, run.source_hash.as_deref().unwrap())
                .unwrap();
        assert!(confirmed_method(&confirmed).contains("blue input"));
        let mut reverted = confirmed.clone();
        reverted.source_raster = Some(1);
        assert_eq!(confirmed_method(&reverted), "A to B");
        assert!(store::read_artifact(workspace.path(), &id, "figure.source", 10000).is_ok());
        // Identical pixels in different branches must not inherit the wrong
        // human instructions just because their content hashes are equal.
        let mut branch = confirmed;
        branch.raster_versions[1].hash = branch.raster_versions[0].hash.clone();
        let mut later = branch.raster_versions[1].clone();
        later.index = 3;
        later.parent_index = Some(1);
        later.parent_hash = Some(branch.raster_versions[0].hash.clone());
        later.prompt = Some("red output".into());
        branch.raster_versions.push(later);
        branch.source_raster = Some(3);
        assert_eq!(edit_prompts(&branch), vec!["red output"]);
    }

    #[test]
    fn failed_or_unknown_png_edits_keep_the_original_without_resending() {
        for (i, error, expected) in [
            ("b", "HTTP 400: mask unsupported", "failed"),
            ("c", "connection closed", "unknown"),
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let id = i.repeat(32);
            let (input, original, mask_bytes) = fixture(workspace.path(), &id);
            let mask = api::validate_edit_mask(mask_bytes.clone(), &original).unwrap();
            let mut sent = 0;
            let result = edit_once(
                workspace.path(),
                &input,
                original,
                mask,
                &mask_bytes,
                &ModelIdentity::default(),
                &AtomicBool::new(false),
                planned_edit,
                |_, _, _| {
                    sent += 1;
                    Err(error.into())
                },
                || {},
            );
            let run = finish_edit(workspace.path(), &id, "image_ready".into(), result).unwrap();
            assert_eq!(sent, 1);
            assert_eq!(run.raster_versions.len(), 1);
            assert_eq!(run.requests[1].status, expected);
            assert_eq!(
                run.source_hash.as_deref(),
                Some(input.expected_hash.as_str())
            );
            assert_eq!(
                run.status,
                if expected == "unknown" {
                    "unknown"
                } else {
                    "image_ready"
                }
            );
            assert_eq!(edit_allowed(&run), expected != "unknown");
        }
    }

    #[test]
    fn edit_planning_failure_never_sends_an_image_and_uses_the_visible_branch() {
        for mode in ["rejected", "unknown", "invalid", "truncated", "cancelled"] {
            let workspace = tempfile::tempdir().unwrap(); let id = "b".repeat(32);
            let (input, original, mask_bytes) = fixture(workspace.path(), &id);
            // A later selected branch exists, but the user is viewing the original.
            let mut later = raster_version(&original, Some(input.expected_hash.clone()), Some("Make output red".into()), None, None);
            later.parent_index = Some(1);
            store::save_raster(workspace.path(), &id, later, &original.bytes).unwrap();
            let mask = api::validate_edit_mask(mask_bytes.clone(), &original).unwrap();
            let cancelled = AtomicBool::new(false);
            let result = edit_once(workspace.path(), &input, original, mask, &mask_bytes, &ModelIdentity::default(), &cancelled, |request| {
                let runtime::ContentBlock::Text { text } = &request.messages[0].blocks[0] else { panic!("Missing context") };
                let context: Value = serde_json::from_str(text).unwrap();
                assert_eq!(context["requirements"], "A to B");
                assert_eq!(context["priorEdits"], json!([]));
                assert_eq!(context["latestRequest"], "blue input");
                assert_eq!(context["baseIndex"], 1);
                assert_eq!(request.messages[0].blocks.len(), 3);
                if mode == "rejected" { return Err("HTTP 400: image not supported".into()); }
                if mode == "unknown" { return Err("connection closed".into()); }
                if mode == "cancelled" { cancelled.store(true, Ordering::SeqCst); }
                Ok(ModelReply { text: if mode == "invalid" { "not JSON" } else { r#"{"prompt":"Make input blue"}"# }.into(), stop_reason: (mode == "truncated").then(|| "length".into()), ..Default::default() })
            }, |_, _, _| panic!("Image edit must not be submitted after {mode} planning"), || {});
            assert!(result.is_err());
            let run = finish_edit(workspace.path(), &id, "image_ready".into(), result).unwrap();
            assert_eq!(run.requests.len(), 1);
            if mode == "invalid" {
                assert_eq!(run.requests[0].status, "failed");
                assert!(run.requests[0].error.as_deref().unwrap().contains("valid image prompt"));
            }
            assert_eq!(run.requests[0].kind, "manual_image_prompt");
            assert_eq!(run.raster_versions.len(), 2);
            assert_eq!(run.source_raster, Some(2));
            assert_eq!(run.status, if mode == "unknown" { "unknown" } else { "image_ready" });
        }
    }
}
