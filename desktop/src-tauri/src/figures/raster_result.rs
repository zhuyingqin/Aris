//! Align encoder rounding locally; preview choices for a changed canvas.
use super::*;
use store::FigureRasterVersion;

pub(super) fn restore_saved_edit(workspace: &Path, run: FigureRun) -> Result<FigureRun, String> {
    if run.pending_raster_edit.is_some() {
        return align_rounding_edit(workspace, run);
    }
    if run.raster_versions.is_empty() {
        return Ok(run);
    }
    let Some(request) = run
        .requests
        .last()
        .filter(|r| r.kind == "manual_image_edit" && r.status == "completed")
    else {
        return Ok(run);
    };
    if run
        .raster_versions
        .iter()
        .any(|v| v.request_id.as_deref() == Some(&request.id))
        || store::read_artifact(
            workspace,
            &run.id,
            &format!("{}.application.json", request.id),
            100_000,
        )
        .is_ok()
    {
        return Ok(run);
    }
    let Ok(bytes) = store::read_artifact(
        workspace,
        &run.id,
        &format!("{}.edit.json", request.id),
        100_000,
    ) else {
        return Ok(run);
    };
    let metadata: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let Some(base_index) = metadata["baseIndex"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
    else {
        return Ok(run);
    };
    let original = raster::raster_image(workspace, &run, base_index)?;
    if metadata["baseHash"].as_str() != Some(store::hash(&original.bytes).as_str()) {
        return Err("Saved image edit base changed".into());
    }
    for extension in ["png", "jpg", "webp"] {
        let path = format!("{}.result.{extension}", request.id);
        let Ok(bytes) = store::read_artifact(workspace, &run.id, &path, store::MAX_SOURCE_BYTES)
        else {
            continue;
        };
        let image = api::validate_image_bytes(bytes)?;
        if (image.width, image.height) == (original.width, original.height) {
            return Ok(run);
        }
        let mut candidate = raster::raster_version(
            &image,
            Some(store::hash(&original.bytes)),
            metadata["prompt"].as_str().map(str::to_owned),
            metadata["maskPath"].as_str().map(str::to_owned),
            Some(request.id.clone()),
        );
        candidate.path = path;
        candidate.parent_index = Some(base_index);
        candidate.prompt_request_id = metadata["promptRequestId"].as_str().map(str::to_owned);
        let (restored, ()) = store::update(workspace, &run.id, |current| {
            if current.pending_raster_edit.is_none()
                && current.requests.last().map(|r| &r.id) == Some(&request.id)
                && !current
                    .raster_versions
                    .iter()
                    .any(|v| v.request_id.as_deref() == Some(&request.id))
            {
                current.pending_raster_edit = Some(candidate);
                current.error = None;
                if !current.image_confirmed && current.versions.is_empty() {
                    current.status = "image_ready".into();
                }
            }
            Ok(())
        })?;
        return align_rounding_edit(workspace, restored);
    }
    Ok(run)
}

/// Fresh and recovered results use the same conservative rounding rule. This
/// operates on a loaded run so recovery does not recurse through ensure_raster.
pub(super) fn align_rounding_edit(workspace: &Path, run: FigureRun) -> Result<FigureRun, String> {
    let Some(pending) = &run.pending_raster_edit else {
        return Ok(run);
    };
    if run
        .requests
        .iter()
        .any(|r| matches!(r.status.as_str(), "submitted" | "unknown"))
    {
        return Ok(run);
    }
    // Listing tasks should not decode full images for a large, pending canvas
    // change on every poll. Application revalidates the actual image bytes.
    let original = run
        .raster_versions
        .iter()
        .find(|version| Some(version.index) == pending.parent_index)
        .ok_or("Missing edit base")?;
    if !api::image_dimensions_match_with_rounding(
        (original.width, original.height),
        (pending.width, pending.height),
    ) {
        return Ok(run);
    }
    let request_id = pending
        .request_id
        .as_deref()
        .ok_or("Missing edit request")?;
    match resolve_loaded(workspace, &run, request_id, &pending.hash, "aligned") {
        Ok(resolved) => Ok(resolved),
        Err(error) => {
            // Concurrent list/document recovery may have adopted this result.
            // The runtime transaction permits only one immutable new version.
            let latest = store::load(workspace, &run.id)?;
            if latest.pending_raster_edit.is_none()
                && store::read_artifact(
                    workspace,
                    &run.id,
                    &format!("{request_id}.application.json"),
                    100_000,
                )
                .is_ok()
            {
                Ok(latest)
            } else {
                Err(error)
            }
        }
    }
}

fn candidate(
    run: &FigureRun,
    request_id: &str,
    expected_hash: &str,
) -> Result<FigureRasterVersion, String> {
    let candidate = run
        .pending_raster_edit
        .as_ref()
        .ok_or("图片结果已处理，请刷新。")?;
    if candidate.request_id.as_deref() != Some(request_id) || candidate.hash != expected_hash {
        return Err("图片结果已变更，请刷新后重新选择。".into());
    }
    Ok(candidate.clone())
}

fn application_image(
    workspace: &Path,
    run: &FigureRun,
    candidate: &FigureRasterVersion,
    choice: &str,
) -> Result<api::GeneratedImage, String> {
    let bytes = store::read_artifact(workspace, &run.id, &candidate.path, store::MAX_SOURCE_BYTES)?;
    if store::hash(&bytes) != candidate.hash {
        return Err("返回图片完整性检查失败。".into());
    }
    let returned = api::validate_image_bytes(bytes)?;
    if choice == "returned" {
        return api::image_as_png(returned);
    }
    if !matches!(choice, "selection" | "aligned") {
        return Err("Invalid local image choice".into());
    }
    let original = raster::raster_image(
        workspace,
        run,
        candidate.parent_index.ok_or("Missing edit base")?,
    )?;
    if candidate.parent_hash.as_deref() != Some(store::hash(&original.bytes).as_str()) {
        return Err("Original image changed".into());
    }
    if choice == "aligned"
        && !api::image_dimensions_match_with_rounding(
            (original.width, original.height),
            (returned.width, returned.height),
        )
    {
        return Err("Image canvas change requires a preview".into());
    }
    let mask = api::validate_edit_mask(
        store::read_artifact(
            workspace,
            &run.id,
            candidate.mask_path.as_deref().ok_or("Missing edit mask")?,
            4 * 1024 * 1024,
        )?,
        &original,
    )?;
    let resized = api::resize_image_exact(&returned, original.width, original.height)?;
    api::composite_masked_edit(&original, &resized, &mask)
}

pub(super) fn resolve_once(
    workspace: &Path,
    id: &str,
    request_id: &str,
    expected_hash: &str,
    choice: &str,
) -> Result<FigureRun, String> {
    let run = raster::ensure_raster(workspace, id)?;
    // Automatic alignment is internal, never an alternative exposed by the UI.
    if !matches!(choice, "returned" | "selection" | "keep") {
        return Err("Invalid local image choice".into());
    }
    resolve_loaded(workspace, &run, request_id, expected_hash, choice)
}

fn resolve_loaded(
    workspace: &Path,
    run: &FigureRun,
    request_id: &str,
    expected_hash: &str,
    choice: &str,
) -> Result<FigureRun, String> {
    let id = &run.id;
    let candidate = candidate(&run, request_id, expected_hash)?;
    if choice == "keep" {
        return store::resolve_raster_edit(workspace, id, request_id, expected_hash, choice, None);
    }
    let image = application_image(workspace, &run, &candidate, choice)?;
    let mut version = candidate;
    version.hash = store::hash(&image.bytes);
    version.width = image.width;
    version.height = image.height;
    version.mime_type = image.mime_type.into();
    store::resolve_raster_edit(
        workspace,
        id,
        request_id,
        expected_hash,
        choice,
        Some((version, &image.bytes)),
    )
}

#[tauri::command]
pub async fn figures_edit_result_document(
    app: AppHandle,
    project_id: String,
    id: String,
    request_id: String,
    expected_hash: String,
    choice: String,
) -> Result<raster::RasterDocument, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let run = raster::ensure_raster(&workspace, &id)?;
        let candidate = candidate(&run, &request_id, &expected_hash)?;
        let image = application_image(&workspace, &run, &candidate, &choice)?;
        Ok(raster::RasterDocument {
            data_url: format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(&image.bytes)
            ),
            hash: store::hash(&image.bytes),
            index: 0,
            width: image.width,
            height: image.height,
            edit_prompts: vec![],
            resolved_prompt: None,
            prompt_model: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn figures_resolve_edit_result(
    app: AppHandle,
    project_id: String,
    id: String,
    request_id: String,
    expected_hash: String,
    choice: String,
) -> Result<FigureView, String> {
    let workspace = project(&app, &project_id)?;
    let result_project = project_id.clone();
    let result_id = id.clone();
    let run = tauri::async_runtime::spawn_blocking(move || {
        let jobs = active_runs().lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(&(project_id, id.clone())) {
            return Err("请等待当前任务完成。".into());
        }
        resolve_once(&workspace, &id, &request_id, &expected_hash, &choice)
    })
    .await
    .map_err(|e| e.to_string())??;
    emit(
        &app,
        &result_project,
        &project(&app, &result_project)?,
        &result_id,
    );
    Ok(view(&result_project, run))
}
