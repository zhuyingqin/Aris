//! Independent SomniQ figure application; project-bound jobs use shared crates.
use crate::projects::{self, ProjectState};
use aris_chat::figures::{self as workflow};
use aris_executor::bounded::{is_budget_truncated, ModelReply};
use base64::Engine;
use rand::Rng;
use runtime::figures::{self as store, FigureReview, FigureRun, ModelIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};

type ActiveRuns = Mutex<HashMap<(String, String), Arc<AtomicBool>>>;
fn active_runs() -> &'static ActiveRuns {
    static RUNS: OnceLock<ActiveRuns> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}
struct Guard {
    key: (String, String),
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = active_runs().lock() {
            jobs.remove(&self.key);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FigureView {
    project_id: String,
    run: FigureRun,
    active: bool,
    active_count: usize,
}
fn view(project_id: &str, run: FigureRun) -> FigureView {
    let (active, active_count) = active_runs()
        .lock()
        .map(|jobs| {
            (
                jobs.contains_key(&(project_id.into(), run.id.clone())),
                jobs.len(),
            )
        })
        .unwrap_or((false, 0));
    FigureView {
        project_id: project_id.into(),
        run,
        active,
        active_count,
    }
}
fn project(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    projects::project_path_for_id(app.state::<ProjectState>().inner(), project_id)
}

#[tauri::command]
pub fn figures_running_count() -> usize {
    active_runs().lock().map(|jobs| jobs.len()).unwrap_or(0)
}

/// A separate static-asset protocol allows opaque-origin editor frames to load
/// local ES modules without changing the main application's CORS/IPC boundary.
pub fn editor_asset(
    app: &AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    editor_asset_response(request.uri().path(), request.method().as_str(), |path| {
        app.asset_resolver()
            .get(path)
            .map(|asset| (asset.mime_type, asset.bytes))
    })
}
fn editor_asset_response(
    path: &str,
    method: &str,
    resolve: impl FnOnce(String) -> Option<(String, Vec<u8>)>,
) -> tauri::http::Response<Vec<u8>> {
    let safe = path.starts_with("/figure-editor/")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
        && path.split('/').all(|part| !part.starts_with('.'));
    let (status, mime, bytes) = if !safe || !matches!(method, "GET" | "HEAD" | "OPTIONS") {
        (403, "text/plain".to_string(), Vec::new())
    } else if method == "OPTIONS" {
        (204, "text/plain".to_string(), Vec::new())
    } else if let Some((mime, bytes)) = resolve(path.trim_start_matches('/').into()) {
        (200, mime, if method == "HEAD" { Vec::new() } else { bytes })
    } else {
        (404, "text/plain".to_string(), Vec::new())
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes)
        .expect("Static editor response")
}
fn emit(app: &AppHandle, project_id: &str, workspace: &Path, id: &str) {
    if let Ok(run) = store::load(workspace, id) {
        let _ = app.emit("figures-updated", view(project_id, run));
    }
}

fn invalidate_changed_renderer(workspace: &Path, run: FigureRun) -> Result<FigureRun, String> {
    if run.review.is_none()
        || run
            .versions
            .last()
            .is_none_or(tools::figures::render_signature_matches)
    {
        return Ok(run);
    }
    let (updated, ()) = store::update(workspace, &run.id, |current| {
        if current.current_hash() != run.current_hash() {
            return Err("SVG changed while checking its rendering evidence".into());
        }
        current.review = None;
        if let Some(version) = current.versions.last_mut() {
            version.review_status = "visual_pending".into();
        }
        if !current
            .requests
            .iter()
            .any(|r| r.status == "unknown" || r.status == "submitted")
        {
            current.status = "visual_pending".into();
            current.error = Some("renderer_changed: renderer or fonts changed. Review the current version to refresh its local rendering and independent decision.".into());
        }
        Ok(())
    })?;
    let final_path = store::directory(workspace, &run.id)?.join("final.svg");
    if final_path.exists() {
        fs::remove_file(final_path).map_err(|e| e.to_string())?;
    }
    Ok(updated)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureConnections {
    executor: ModelIdentity,
    reviewer: ModelIdentity,
    executor_models: Vec<String>,
    image: crate::image_api::SomniImageSettings,
}
#[tauri::command]
pub async fn figures_connections(model: Option<String>) -> Result<FigureConnections, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (executor, reviewer) = crate::engine::figure_connections(model.as_deref())?;
        let mut executor_models: Vec<String> = crate::config::verified_executor_summaries()
            .into_iter()
            .map(|(_, model, _)| model)
            .collect();
        executor_models.push(executor.identity.model.clone());
        executor_models.sort();
        executor_models.dedup();
        Ok(FigureConnections {
            executor: executor.identity,
            reviewer: reviewer.figure_identity(),
            executor_models,
            image: crate::image_api::somni_image_settings(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareInput {
    project_id: String,
    id: String,
    title: String,
    method: String,
    style: String,
    source_mode: String,
    source_base64: Option<String>,
    output_limit: u32,
    model: Option<String>,
}
#[tauri::command]
pub async fn figures_prepare(app: AppHandle, input: PrepareInput) -> Result<FigureView, String> {
    let workspace = project(&app, &input.project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(input.source_mode.as_str(), "import" | "generate") {
            return Err("Choose import or generation".into());
        }
        if input.title.len() > 200 || input.style.len() > 2000 {
            return Err("Title or style exceeds length limit".into());
        }
        let (executor, reviewer) = crate::engine::figure_connections(input.model.as_deref())?;
        let source = if input.source_mode == "import" {
            let encoded = input
                .source_base64
                .as_deref()
                .ok_or("Choose a source image")?;
            if encoded.len() > 14 * 1024 * 1024 {
                return Err("Source exceeds 10 MiB".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid source image encoding")?;
            if bytes.len() > store::MAX_SOURCE_BYTES {
                return Err("Source exceeds 10 MiB".into());
            }
            Some(api::validate_image_bytes(bytes)?)
        } else {
            if !crate::image_api::somni_image_settings().available {
                return Err(
                    "Enable and configure SomniImage in Settings, or import an existing image"
                        .into(),
                );
            }
            None
        };
        let now = runtime::now_iso8601();
        let image_identity = if input.source_mode == "generate" {
            Some(
                crate::image_api::prepare_figure_image(
                    image_prompt(&input.method, &input.style),
                    None,
                )?
                .identity,
            )
        } else {
            None
        };
        let run = FigureRun {
            schema_version: 1,
            id: input.id,
            title: input.title.trim().into(),
            method: input.method.trim().into(),
            style: input.style,
            source_mode: input.source_mode,
            source_mime: source.as_ref().map(|s| s.mime_type.to_string()),
            source_hash: None,
            status: "ready".into(),
            output_limit: input.output_limit,
            executor: executor.identity,
            reviewer: reviewer.figure_identity(),
            image_identity,
            executor_vision: false,
            reviewer_vision: false,
            revision_used: false,
            versions: vec![],
            requests: vec![],
            review: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let run = store::create(&workspace, run, source.as_ref().map(|s| s.bytes.as_slice()))?;
        Ok(view(&input.project_id, run))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn figures_list(app: AppHandle, project_id: String) -> Result<Vec<FigureView>, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        store::list(&workspace)?
            .into_iter()
            .map(|run| {
                let v = view(&project_id, run);
                if !v.active
                    && (v.run.requests.iter().any(|r| r.status == "submitted")
                        || matches!(
                            v.run.status.as_str(),
                            "probing" | "generating" | "reconstructing" | "reviewing" | "revising"
                        ))
                {
                    Ok(view(&project_id, store::recover(&workspace, &v.run.id)?))
                } else if !v.active {
                    Ok(view(
                        &project_id,
                        invalidate_changed_renderer(&workspace, v.run)?,
                    ))
                } else {
                    Ok(v)
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn figures_start(
    app: AppHandle,
    project_id: String,
    id: String,
) -> Result<FigureView, String> {
    let workspace = project(&app, &project_id)?;
    let mut jobs = active_runs().lock().map_err(|e| e.to_string())?;
    let key = (project_id.clone(), id.clone());
    if jobs.contains_key(&key) {
        return Ok(view_unlocked(
            &project_id,
            store::load(&workspace, &id)?,
            true,
            jobs.len(),
        ));
    }
    let run = store::load(&workspace, &id)?;
    if !run.can_start() {
        return Err(
            "This task has already started. Create a new task to submit new paid requests.".into(),
        );
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.insert(key.clone(), cancelled.clone());
    drop(jobs);
    let result = view(&project_id, run);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = Guard { key };
        let result = process(&workspace, &id, cancelled.clone(), || {
            emit(&app, &project_id, &workspace, &id)
        });
        if let Err(error) = result {
            let _ = store::update(&workspace, &id, |run| {
                if run.status != "budget_truncated" {
                    run.status = if run
                        .requests
                        .iter()
                        .any(|r| r.status == "unknown" || r.status == "submitted")
                    {
                        "unknown"
                    } else if cancelled.load(Ordering::SeqCst) {
                        "cancelled"
                    } else if run.status == "needs_vision_executor" {
                        "needs_vision_executor"
                    } else {
                        "draft"
                    }
                    .into();
                }
                run.error = Some(error);
                Ok(())
            });
        }
        drop(guard);
        emit(&app, &project_id, &workspace, &id);
    });
    Ok(result)
}
fn view_unlocked(
    project_id: &str,
    run: FigureRun,
    active: bool,
    active_count: usize,
) -> FigureView {
    FigureView {
        project_id: project_id.into(),
        run,
        active,
        active_count,
    }
}

#[tauri::command]
pub fn figures_cancel(project_id: String, id: String) -> Result<(), String> {
    if let Some(flag) = active_runs()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&(project_id, id))
    {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn stage(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    id: &str,
    status: &str,
) -> Result<(), String> {
    store::update(workspace, id, |run| {
        run.status = status.into();
        Ok(())
    })?;
    emit(app, project_id, workspace, id);
    Ok(())
}
fn call(
    workspace: &Path,
    id: &str,
    kind: &str,
    role: &str,
    identity: ModelIdentity,
    budget: u32,
    perform: impl FnOnce() -> Result<ModelReply, String>,
) -> Result<ModelReply, String> {
    let record = store::begin_request(workspace, id, kind, role, identity.clone(), budget)?;
    let started = Instant::now();
    let reply = perform().unwrap_or_else(|error| ModelReply {
        error: Some(error),
        ..ModelReply::default()
    });
    let usage = reply.usage.map(|u| json!({ "inputTokens": u.input_tokens, "outputTokens": u.output_tokens, "cacheCreationInputTokens": u.cache_creation_input_tokens, "cacheReadInputTokens": u.cache_read_input_tokens }));
    let duration = started.elapsed().as_millis() as u64;
    store::update(workspace, id, |run| {
        let request = run
            .requests
            .iter_mut()
            .find(|r| r.id == record.id)
            .ok_or("Request ledger entry missing")?;
        request.status = if reply.error.as_deref().is_some_and(known_rejection) {
            "failed"
        } else if reply.error.is_some() {
            "unknown"
        } else {
            "completed"
        }
        .into();
        request.finished_at = Some(runtime::now_iso8601());
        request.usage = usage.clone();
        request.stop_reason = reply.stop_reason.clone();
        request.error = reply.error.clone();
        request.duration_ms = duration;
        Ok(())
    })?;
    let usages = reply.usage.into_iter().collect::<Vec<_>>();
    let _ = crate::usage_log::append_turn_usage(
        &format!("figure-{id}"),
        &record.id,
        role,
        &identity.model,
        &identity.provider,
        &identity.endpoint,
        &usages,
        &[],
        duration,
        "figure-light",
    );
    if !reply.text.is_empty() {
        runtime::write_file_atomically(
            &store::directory(workspace, id)?.join(format!("{}.response.txt", record.id)),
            &reply.text,
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(error) = &reply.error {
        return Err(if known_rejection(error) {
            format!("Request rejected; no automatic retry. {error}")
        } else {
            format!("Submitted request result is unresolved; no automatic retry. {error}")
        });
    }
    Ok(reply)
}

fn known_rejection(error: &str) -> bool {
    ["400", "401", "403", "404", "413", "415", "422"]
        .iter()
        .any(|status| {
            error.contains(&format!("HTTP {status}"))
                || error.contains(&format!("returned {status}"))
        })
}

static CACHE_WRITES: Mutex<()> = Mutex::new(());
fn capability_file(workspace: &Path) -> PathBuf {
    workspace.join(".somniq/artifacts/figures/vision-capabilities.json")
}
fn capability(workspace: &Path, identity: &ModelIdentity) -> Option<bool> {
    let path = capability_file(workspace);
    if !path
        .canonicalize()
        .ok()?
        .starts_with(path.parent()?.canonicalize().ok()?)
    {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<HashMap<String, bool>>(&bytes)
        .ok()?
        .get(&identity.signature)
        .copied()
}
fn save_capability(
    workspace: &Path,
    identity: &ModelIdentity,
    accepted: bool,
) -> Result<(), String> {
    let _lock = CACHE_WRITES.lock().map_err(|e| e.to_string())?;
    let mut cache = fs::read(capability_file(workspace))
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, bool>>(&b).ok())
        .unwrap_or_default();
    cache.insert(identity.signature.clone(), accepted);
    runtime::write_file_atomically(
        &capability_file(workspace),
        serde_json::to_vec_pretty(&cache).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn probe(
    workspace: &Path,
    id: &str,
    identity: ModelIdentity,
    role: &str,
    perform: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
) -> Result<bool, String> {
    if let Some(accepted) = capability(workspace, &identity) {
        return Ok(accepted);
    }
    let number = rand::thread_rng().gen_range(1000..10000).to_string();
    let svg = format!("<svg xmlns='http://www.w3.org/2000/svg' width='300' height='120'><rect width='300' height='120' fill='white'/><text x='20' y='85' font-family='sans-serif' font-size='76' fill='black'>{number}</text></svg>");
    let png = tools::figures::render(&svg)?.png;
    let request = workflow::request(
        "Read the attached image. Return only its four visible digits.",
        "What four digits are drawn? Reply with only the digits.".into(),
        vec![(
            "image/png".into(),
            base64::engine::general_purpose::STANDARD.encode(png),
        )],
    );
    let reply = call(
        workspace,
        id,
        "vision_probe",
        role,
        identity.clone(),
        1024,
        || perform(request),
    );
    let accepted = match reply {
        Ok(reply) if is_budget_truncated(reply.stop_reason.as_deref()) => {
            return Err(
                "Vision probe was budget-truncated; image capability remains unknown".into(),
            )
        }
        Ok(reply) => reply.text.trim() == number,
        Err(error) if image_not_supported(&error) => false,
        Err(error) => return Err(error),
    };
    save_capability(workspace, &identity, accepted)?;
    Ok(accepted)
}

fn process(
    workspace: &Path,
    id: &str,
    cancelled: Arc<AtomicBool>,
    notify: impl Fn(),
) -> Result<(), String> {
    let set_stage = |status: &str| -> Result<(), String> {
        store::update(workspace, id, |run| {
            run.status = status.into();
            Ok(())
        })?;
        notify();
        Ok(())
    };
    let run = store::load(workspace, id)?;
    let (executor, reviewer) = crate::engine::figure_connections(Some(&run.executor.model))?;
    if executor.identity != run.executor || reviewer.figure_identity() != run.reviewer {
        return Err(
            "Configured model connection changed. Create a new task to use the new settings."
                .into(),
        );
    }
    let image_connection = if run.source_mode == "generate" {
        let prepared = crate::image_api::prepare_figure_image(
            image_prompt(&run.method, &run.style),
            run.image_identity
                .as_ref()
                .map(|identity| identity.model.clone()),
        )?;
        if Some(&prepared.identity) != run.image_identity.as_ref() {
            return Err(
                "SomniImage settings changed; create a new task before submitting paid requests"
                    .into(),
            );
        }
        Some(prepared)
    } else {
        None
    };
    set_stage("probing")?;
    let executor_vision = probe(workspace, id, run.executor.clone(), "executor", |request| {
        executor.run(request, 1024, cancelled.clone())
    })?;
    if !executor_vision {
        store::update(workspace, id, |run| {
            run.status = "needs_vision_executor".into();
            Ok(())
        })?;
        return Err("The configured Executor did not pass the real image probe. Choose a vision model before creating a new task.".into());
    }
    let reviewer_vision = probe(workspace, id, run.reviewer.clone(), "reviewer", |request| {
        reviewer.run_figure_request(request, 1024, cancelled.clone())
    })?;
    store::update(workspace, id, |run| {
        run.executor_vision = executor_vision;
        run.reviewer_vision = reviewer_vision;
        Ok(())
    })?;
    if cancelled.load(Ordering::SeqCst) {
        return Err("Task cancelled".into());
    }
    if run.source_mode == "generate" {
        set_stage("generating")?;
        let prepared = image_connection
            .as_ref()
            .ok_or("Missing SomniImage snapshot")?;
        let request = store::begin_request(
            workspace,
            id,
            "generate_image",
            "image",
            prepared.identity.clone(),
            0,
        )?;
        let started = Instant::now();
        let output: Value = match prepared.generate(workspace, cancelled.clone()) {
            Ok(output) => output,
            Err(error) => {
                store::update(workspace, id, |r| {
                    let entry = r.requests.iter_mut().find(|e| e.id == request.id).unwrap();
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
        let relative = output["images"][0]["path"]
            .as_str()
            .ok_or("SomniImage returned no image")?;
        let path = workspace
            .join(relative)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(&workspace.canonicalize().map_err(|e| e.to_string())?) {
            return Err("Generated image escaped its project".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > store::MAX_SOURCE_BYTES {
            return Err("Generated image exceeds the figure source limit".into());
        }
        let image = api::validate_image_bytes(bytes)?;
        runtime::write_file_atomically(
            &store::directory(workspace, id)?.join("figure.source"),
            &image.bytes,
        )
        .map_err(|e| e.to_string())?;
        runtime::write_file_atomically(
            &store::directory(workspace, id)?.join(format!("figure.{}", image.extension)),
            &image.bytes,
        )
        .map_err(|e| e.to_string())?;
        runtime::write_file_atomically(
            &store::directory(workspace, id)?.join("generation.json"),
            serde_json::to_vec_pretty(&output).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        store::update(workspace, id, |r| {
            r.source_mime = Some(image.mime_type.to_string());
            r.source_hash = Some(store::hash(&image.bytes));
            let entry = r.requests.iter_mut().find(|e| e.id == request.id).unwrap();
            entry.status = "completed".into();
            entry.finished_at = Some(runtime::now_iso8601());
            entry.usage = output.get("usage").cloned();
            entry.duration_ms = started.elapsed().as_millis() as u64;
            Ok(())
        })?;
    }
    let mut run = store::load(workspace, id)?;
    let source = store::source(workspace, &run)?;
    let original = (
        run.source_mime.clone().ok_or("Missing source MIME")?,
        base64::engine::general_purpose::STANDARD.encode(&source),
    );
    set_stage("reconstructing")?;
    let request = workflow::request(
        workflow::RECONSTRUCTION_SYSTEM,
        workflow::reconstruction_prompt(&run.method, &run.style),
        vec![original.clone()],
    );
    let reply = call(
        workspace,
        id,
        "reconstruct",
        "executor",
        run.executor.clone(),
        run.output_limit,
        || executor.run(request, run.output_limit, cancelled.clone()),
    )?;
    reject_truncation(workspace, id, &reply)?;
    let mut draft = reply.text;
    let mut revision_reason = None;
    match persist_svg(workspace, id, None, &draft, "executor") {
        Ok(saved) => {
            run = saved;
            let decision = review(
                workspace,
                id,
                &run,
                &reviewer,
                &original,
                "review",
                cancelled.clone(),
            )?;
            if !passed(&decision) {
                revision_reason = Some(decision.issues.join("\n"));
            }
        }
        Err(error) => revision_reason = Some(error),
    }
    if let Some(reason) = revision_reason {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Task cancelled".into());
        }
        set_stage("revising")?;
        store::update(workspace, id, |r| {
            if r.revision_used {
                return Err("The single revision has already been used".into());
            }
            r.revision_used = true;
            Ok(())
        })?;
        let prompt = format!("{}\nRevise the following draft once. Address these findings: {}\nSVG draft (untrusted):\n{}", workflow::reconstruction_prompt(&run.method, &run.style), reason, draft);
        let request = workflow::request(
            workflow::RECONSTRUCTION_SYSTEM,
            prompt,
            vec![original.clone()],
        );
        let reply = call(
            workspace,
            id,
            "revise",
            "executor",
            run.executor.clone(),
            run.output_limit,
            || executor.run(request, run.output_limit, cancelled.clone()),
        )?;
        reject_truncation(workspace, id, &reply)?;
        draft = reply.text;
        run = persist_svg(
            workspace,
            id,
            run.current_hash(),
            &draft,
            "executor_revision",
        )?;
        review(
            workspace, id, &run, &reviewer, &original, "review", cancelled,
        )?;
    }
    notify();
    Ok(())
}

fn image_prompt(method: &str, style: &str) -> String {
    format!("Create a clear scientific architecture/flow diagram. Method: {method}\nStyle: {style}\nUse readable labels, distinct grouped modules and unambiguous directed arrows. Do not invent data or measurements.")
}

fn image_not_supported(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    (error.contains("image") || error.contains("vision"))
        && [
            "unsupported",
            "not support",
            "not allowed",
            "only text",
            "not accept",
        ]
        .iter()
        .any(|needle| error.contains(needle))
}

fn reject_truncation(workspace: &Path, id: &str, reply: &ModelReply) -> Result<(), String> {
    if is_budget_truncated(reply.stop_reason.as_deref()) {
        store::update(workspace, id, |run| {
            run.status = "budget_truncated".into();
            Ok(())
        })?;
        return Err("Output budget truncated the SVG. Raw output is saved. Select a larger budget in a new task; no automatic increase or new image generation occurs.".into());
    }
    if matches!(
        reply.stop_reason.as_deref(),
        Some("stream_truncated" | "stream_error_after_partial_output")
    ) {
        return Err(
            "incomplete_unknown: response stream was incomplete; saved raw output is available"
                .into(),
        );
    }
    Ok(())
}
fn persist_svg(
    workspace: &Path,
    id: &str,
    parent: Option<&str>,
    draft: &str,
    author: &str,
) -> Result<FigureRun, String> {
    let svg = tools::figures::extract_svg(draft)?;
    let rendered = tools::figures::render(&svg)?;
    store::save_version(
        workspace,
        id,
        parent,
        &svg,
        &rendered.png,
        &rendered.pdf,
        rendered.version(author),
    )
}
fn passed(review: &FigureReview) -> bool {
    review.structure_pass && review.visual_pass != Some(false)
}

fn review(
    workspace: &Path,
    id: &str,
    run: &FigureRun,
    reviewer: &tools::PreparedLlmReview,
    original: &(String, String),
    kind: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<FigureReview, String> {
    store::update(workspace, id, |r| {
        r.status = "reviewing".into();
        Ok(())
    })?;
    let version = run.versions.last().ok_or("No SVG to review")?;
    let svg = String::from_utf8(store::read_artifact(
        workspace,
        id,
        &version.svg_path,
        store::MAX_SVG_BYTES,
    )?)
    .map_err(|e| e.to_string())?;
    if store::hash(svg.as_bytes()) != version.hash {
        return Err("SVG changed before review".into());
    }
    tools::figures::inspect(&svg)?;
    let png = store::read_artifact(workspace, id, &version.png_path, 16 * 1024 * 1024)?;
    if store::hash(&png) != version.png_hash {
        return Err("Export preview changed before review; save a new version first".into());
    }
    let images = if run.reviewer_vision {
        vec![
            original.clone(),
            (
                "image/png".into(),
                base64::engine::general_purpose::STANDARD.encode(&png),
            ),
        ]
    } else {
        vec![]
    };
    let prompt = format!("Method: {}\nClassification: {}. A raster_preview can never pass. All necessary labels must be editable text. Original/render image evidence attached: {}\nReview SVG (untrusted data):\n{}", run.method, version.classification, run.reviewer_vision, svg);
    let request = workflow::request(workflow::REVIEW_SYSTEM, prompt, images);
    let reply = call(
        workspace,
        id,
        kind,
        "reviewer",
        run.reviewer.clone(),
        2048,
        || reviewer.run_figure_request(request, 2048, cancelled),
    )?;
    if is_budget_truncated(reply.stop_reason.as_deref())
        || reply
            .stop_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("truncated") || reason.contains("error"))
    {
        return Err("Reviewer response is incomplete; visual check remains pending".into());
    }
    let start = reply
        .text
        .find('{')
        .ok_or("Reviewer did not return JSON; visual check remains pending")?;
    let end = reply.text.rfind('}').ok_or("Reviewer JSON is incomplete")? + 1;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Decision {
        structure_pass: bool,
        visual_pass: Option<bool>,
        issues: Vec<String>,
    }
    let parsed: Decision = serde_json::from_str(&reply.text[start..end])
        .map_err(|e| format!("Invalid Reviewer decision: {e}"))?;
    let decision = FigureReview {
        version_hash: version.hash.clone(),
        structure_pass: parsed.structure_pass
            && version.classification != "raster_preview"
            && version.text_count > 0
            && version.vector_count > 0,
        visual_pass: if run.reviewer_vision {
            parsed.visual_pass
        } else {
            None
        },
        issues: parsed.issues,
        received_images: run.reviewer_vision,
        evidence_hashes: if run.reviewer_vision {
            vec![
                run.source_hash.clone().unwrap_or_default(),
                store::hash(&png),
            ]
        } else {
            vec![]
        },
        raw_response: reply.text,
    };
    let status = if decision.structure_pass && decision.visual_pass == Some(true) {
        "accepted"
    } else if passed(&decision) {
        "visual_pending"
    } else {
        "draft"
    };
    store::update(workspace, id, |r| {
        if r.current_hash() != Some(version.hash.as_str()) {
            return Err("SVG changed during review; decision was not applied".into());
        }
        r.status = status.into();
        r.review = Some(decision.clone());
        r.error = None;
        r.versions.last_mut().unwrap().review_status = status.into();
        Ok(())
    })?;
    if status == "accepted" {
        runtime::write_file_atomically(&store::directory(workspace, id)?.join("final.svg"), svg)
            .map_err(|e| e.to_string())?;
    }
    Ok(decision)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureDocument {
    svg: Option<String>,
    raw_output: Option<String>,
    source_data_url: Option<String>,
    preview_data_url: Option<String>,
}
#[tauri::command]
pub async fn figures_document(
    app: AppHandle,
    project_id: String,
    id: String,
    version_index: Option<usize>,
) -> Result<FigureDocument, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let run = invalidate_changed_renderer(&workspace, store::load(&workspace, &id)?)?;
        let source_data_url = if run.source_hash.is_some() {
            Some(format!(
                "data:{};base64,{}",
                run.source_mime.as_deref().unwrap_or("image/png"),
                base64::engine::general_purpose::STANDARD.encode(store::source(&workspace, &run)?)
            ))
        } else {
            None
        };
        let version = match version_index {
            Some(index) => run.versions.iter().find(|v| v.index == index),
            None => run.versions.last(),
        };
        let (svg, preview_data_url) = if let Some(v) = version {
            let bytes = store::read_artifact(&workspace, &id, &v.svg_path, store::MAX_SVG_BYTES)?;
            if store::hash(&bytes) != v.hash {
                return Err("SVG version integrity check failed".into());
            }
            let svg = String::from_utf8(bytes).map_err(|e| e.to_string())?;
            tools::figures::inspect(&svg)?;
            let png = store::read_artifact(&workspace, &id, &v.png_path, 16 * 1024 * 1024)?;
            if store::hash(&png) != v.png_hash {
                return Err("Export preview integrity check failed".into());
            }
            (
                Some(svg),
                Some(format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png)
                )),
            )
        } else {
            (None, None)
        };
        let raw_output = if version.is_none() {
            run.requests
                .iter()
                .rev()
                .find(|r| r.kind == "reconstruct" || r.kind == "revise")
                .and_then(|r| {
                    store::read_artifact(
                        &workspace,
                        &id,
                        &format!("{}.response.txt", r.id),
                        store::MAX_SVG_BYTES,
                    )
                    .ok()
                })
                .and_then(|bytes| String::from_utf8(bytes).ok())
        } else {
            None
        };
        Ok(FigureDocument {
            svg,
            raw_output,
            source_data_url,
            preview_data_url,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn figures_save(
    app: AppHandle,
    project_id: String,
    id: String,
    expected_hash: Option<String>,
    svg: String,
) -> Result<FigureView, String> {
    let workspace = project(&app, &project_id)?;
    if active_runs()
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&(project_id.clone(), id.clone()))
    {
        return Err("Wait for the active figure task before saving edits".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let rendered = tools::figures::render(&svg)?;
        let run = store::save_version(
            &workspace,
            &id,
            expected_hash.as_deref(),
            &svg,
            &rendered.png,
            &rendered.pdf,
            rendered.version("user"),
        )?;
        Ok(view(&project_id, run))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureExport {
    filename: String,
    mime_type: String,
    data_base64: String,
}
#[tauri::command]
pub async fn figures_export(
    app: AppHandle,
    project_id: String,
    id: String,
    format: String,
    destination: Option<String>,
    version_index: Option<usize>,
) -> Result<FigureExport, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let run = invalidate_changed_renderer(&workspace, store::load(&workspace, &id)?)?;
        let version = match version_index {
            Some(index) => run.versions.iter().find(|v| v.index == index),
            None => run.versions.last(),
        }
        .ok_or("Saved SVG version not found")?;
        let svg_bytes =
            store::read_artifact(&workspace, &id, &version.svg_path, store::MAX_SVG_BYTES)?;
        if store::hash(&svg_bytes) != version.hash {
            return Err("SVG integrity check failed".into());
        }
        let svg = String::from_utf8(svg_bytes).map_err(|e| e.to_string())?;
        let rendered = tools::figures::render(&svg)?;
        let (bytes, mime_type) = match format.as_str() {
            "svg" => (svg.into_bytes(), "image/svg+xml"),
            "png" => (rendered.png, "image/png"),
            "pdf" => (rendered.pdf, "application/pdf"),
            _ => return Err("Choose SVG, PNG or PDF".into()),
        };
        if let Some(destination) = destination {
            runtime::write_file_atomically(Path::new(&destination), &bytes)
                .map_err(|e| e.to_string())?;
        }
        Ok(FigureExport {
            filename: format!("figure-{}.{format}", &id[..8]),
            mime_type: mime_type.into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An explicit additional review of the saved editor version, never a hidden
/// continuation of the automatic reconstruction budget.
#[tauri::command]
pub async fn figures_review(
    app: AppHandle,
    project_id: String,
    id: String,
) -> Result<FigureView, String> {
    let workspace = project(&app, &project_id)?;
    let mut jobs = active_runs().lock().map_err(|e| e.to_string())?;
    let key = (project_id.clone(), id.clone());
    if jobs.contains_key(&key) {
        return Err("A figure task is already active".into());
    }
    let run = store::load(&workspace, &id)?;
    if run.versions.is_empty() {
        return Err("Save an SVG version before reviewing".into());
    }
    if run
        .requests
        .iter()
        .any(|r| r.status == "unknown" || r.status == "submitted")
    {
        return Err("A previous submitted request must be reconciled first".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.insert(key.clone(), cancelled.clone());
    drop(jobs);
    let result = view(&project_id, run.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let guard = Guard { key };
        let result = (|| {
            let mut run = run.clone();
            if let Some(version) = run.versions.last() {
                if !tools::figures::render_signature_matches(version) {
                    let bytes = store::read_artifact(
                        &workspace,
                        &id,
                        &version.svg_path,
                        store::MAX_SVG_BYTES,
                    )?;
                    if store::hash(&bytes) != version.hash {
                        return Err("SVG integrity check failed".into());
                    }
                    let svg = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                    let rendered = tools::figures::render(&svg)?;
                    run = store::save_version(
                        &workspace,
                        &id,
                        run.current_hash(),
                        &svg,
                        &rendered.png,
                        &rendered.pdf,
                        rendered.version("renderer_refresh"),
                    )?;
                }
            }
            let (_, reviewer) = crate::engine::figure_connections(Some(&run.executor.model))?;
            if reviewer.figure_identity() != run.reviewer {
                return Err(
                    "Reviewer settings changed; create a new task with the new configuration"
                        .into(),
                );
            }
            let original = (
                run.source_mime.clone().ok_or("Source image is missing")?,
                base64::engine::general_purpose::STANDARD.encode(store::source(&workspace, &run)?),
            );
            stage(&app, &project_id, &workspace, &id, "reviewing")?;
            review(
                &workspace,
                &id,
                &run,
                &reviewer,
                &original,
                "manual_review",
                cancelled,
            )?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let _ = store::update(&workspace, &id, |r| {
                r.status = if r.requests.iter().any(|r| r.status == "unknown") {
                    "unknown"
                } else {
                    "draft"
                }
                .into();
                r.error = Some(error);
                Ok(())
            });
        }
        drop(guard);
        emit(&app, &project_id, &workspace, &id);
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_protocol_only_serves_its_static_assets_to_the_opaque_frame() {
        for path in [
            "/index.html",
            "/figure-editor/../secret",
            "/figure-editor/%2e%2e/secret",
            "/figure-editor/a%2fb",
            "/figure-editor/.somniq/secret",
        ] {
            let response = editor_asset_response(path, "GET", |_| {
                panic!("Rejected path reached the asset resolver")
            });
            assert_eq!(response.status(), 403);
        }
        let response = editor_asset_response("/figure-editor/Editor.js", "GET", |path| {
            assert_eq!(path, "figure-editor/Editor.js");
            Some(("text/javascript".into(), b"export default {};".to_vec()))
        });
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Access-Control-Allow-Origin"], "*");
        assert_eq!(response.body(), b"export default {};");
    }
    #[test]
    #[ignore = "Read-only diagnostic of the user's configured model identities"]
    fn configured_figure_connections_diagnostic() {
        let (executor, reviewer) =
            crate::engine::figure_connections(None).expect("Figure model setup is incomplete");
        println!(
            "Executor: {} / {}",
            executor.identity.provider, executor.identity.model
        );
        println!(
            "Reviewer: {} / {}",
            reviewer.figure_identity().provider,
            reviewer.figure_identity().model
        );
        println!("No model request was submitted.");
    }
    #[test]
    #[ignore = "P0: up to two small paid image-capability requests; requires explicit invocation"]
    fn live_p0_figure_vision_preflight() {
        let workspace = PathBuf::from(
            std::env::var("SOMNIQ_FIGURE_P0_WORKSPACE")
                .expect("Set the diagnostic project workspace"),
        );
        let (executor, reviewer) = crate::engine::figure_connections(None).unwrap();
        let id = format!("{:032x}", rand::thread_rng().gen::<u128>());
        let now = runtime::now_iso8601();
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion": 1, "id": id, "title": "[P0] Figure vision preflight", "method": "Check real image payloads separately for Executor and independent Reviewer", "style": "diagnostic", "sourceMode": "import", "sourceMime": null, "sourceHash": null,
            "status": "probing", "outputLimit": 16384, "executor": executor.identity, "reviewer": reviewer.figure_identity(), "imageIdentity": null,
            "executorVision": false, "reviewerVision": false, "revisionUsed": false, "versions": [], "requests": [], "review": null, "error": null, "createdAt": now, "updatedAt": now,
        })).unwrap();
        store::create(&workspace, run, None).unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let execute = probe(
            &workspace,
            &id,
            executor.identity.clone(),
            "executor",
            |request| executor.run(request, 1024, cancellation.clone()),
        );
        let review = if execute.is_ok() {
            probe(
                &workspace,
                &id,
                reviewer.figure_identity(),
                "reviewer",
                |request| reviewer.run_figure_request(request, 1024, cancellation.clone()),
            )
        } else {
            Err("Not attempted after Executor request failed".into())
        };
        let report = json!({ "executorVision": execute, "reviewerVision": review, "runId": id, "kind": "vision_preflight_only", "generatedImages": 0 });
        runtime::write_file_atomically(
            &store::directory(&workspace, &id)
                .unwrap()
                .join("p0-preflight.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        store::update(&workspace, &id, |run| {
            run.executor_vision = report["executorVision"]["Ok"].as_bool().unwrap_or(false);
            run.reviewer_vision = report["reviewerVision"]["Ok"].as_bool().unwrap_or(false);
            run.status = "diagnostic".into();
            run.error = Some(
                "Vision preflight only; no figure quality or cost benchmark was performed".into(),
            );
            Ok(())
        })
        .unwrap();
        println!("{report}");
    }
    #[test]
    #[ignore = "P0 DEV-01: up to four paid core requests; requires explicit invocation"]
    fn live_p0_chinese_figure_smoke() {
        let workspace = PathBuf::from(
            std::env::var("SOMNIQ_FIGURE_P0_WORKSPACE")
                .expect("Set the diagnostic project workspace"),
        );
        let (executor, reviewer) = crate::engine::figure_connections(None).unwrap();
        let id = format!("{:032x}", rand::thread_rng().gen::<u128>());
        let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='900' height='240'><rect width='900' height='240' fill='white'/><defs><marker id='arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='8' markerHeight='8' orient='auto'><path d='M0 0L10 5L0 10Z' fill='#334155'/></marker></defs><g font-family='sans-serif' font-size='24' text-anchor='middle' fill='#16243b'><rect x='40' y='80' width='220' height='80' rx='12' fill='#dbeafe'/><rect x='340' y='80' width='220' height='80' rx='12' fill='#dcfce7'/><rect x='640' y='80' width='220' height='80' rx='12' fill='#ede9fe'/><text x='150' y='130'>研究问题</text><text x='450' y='130'>独立审查</text><text x='750' y='130'>证据产物</text></g><g stroke='#334155' stroke-width='3' marker-end='url(#arrow)'><path d='M260 120H335'/><path d='M560 120H635'/></g></svg>";
        let png = tools::figures::render(svg).unwrap().png;
        let method = "从左到右的三个模块：研究问题 → 独立审查 → 证据产物。三个中文标签必须逐字保留。只有两条向右的单向箭头，不增加数据、图标或模块。文字、模块、箭头都需要可编辑。";
        let now = runtime::now_iso8601();
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion": 1, "id": id, "title": "[P0 DEV-01] 中文研究流程", "method": method, "style": "Clean flat academic diagram; preserve the source layout and colors", "sourceMode": "import", "sourceMime": "image/png", "sourceHash": null,
            "status": "ready", "outputLimit": 16384, "executor": executor.identity, "reviewer": reviewer.figure_identity(), "imageIdentity": null,
            "executorVision": false, "reviewerVision": false, "revisionUsed": false, "versions": [], "requests": [], "review": null, "error": null, "createdAt": now, "updatedAt": now,
        })).unwrap();
        store::create(&workspace, run, Some(&png)).unwrap();
        let sample = json!({ "sampleId": "DEV-01", "split": "development", "source": "Deterministic local SVG fixture; the model receives only its PNG", "inputHash": store::hash(&png), "requiredLabels": ["研究问题", "独立审查", "证据产物"], "requiredRelations": [["研究问题", "独立审查"], ["独立审查", "证据产物"]], "outputLimit": 16384, "runId": id });
        runtime::write_file_atomically(
            &store::directory(&workspace, &id)
                .unwrap()
                .join("p0-sample.json"),
            serde_json::to_vec_pretty(&sample).unwrap(),
        )
        .unwrap();
        let result = process(&workspace, &id, Arc::new(AtomicBool::new(false)), || {});
        if let Err(error) = &result {
            store::update(&workspace, &id, |run| {
                if run.status != "budget_truncated" {
                    run.status = if run.requests.iter().any(|r| r.status == "unknown") {
                        "unknown"
                    } else {
                        "draft"
                    }
                    .into();
                }
                run.error = Some(error.clone());
                Ok(())
            })
            .unwrap();
        }
        let run = store::load(&workspace, &id).unwrap();
        let report = json!({ "kind": "first_development_smoke_only", "sampleId": "DEV-01", "runId": id, "result": result, "status": run.status, "requests": run.requests.len(), "revisionUsed": run.revision_used, "versions": run.versions.len(), "review": run.review });
        runtime::write_file_atomically(
            &store::directory(&workspace, &id)
                .unwrap()
                .join("p0-smoke.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!("{report}");
        assert!(
            !run.versions.is_empty(),
            "No editable SVG was produced; inspect the saved request ledger"
        );
    }
    #[test]
    fn routing_or_budget_errors_are_not_evidence_of_missing_vision() {
        assert!(!image_not_supported("HTTP 400: missing x-opencode-session"));
        assert!(!image_not_supported("HTTP 400: unsupported max_tokens"));
        assert!(image_not_supported(
            "HTTP 400: image content is not supported by this model"
        ));
    }
    #[test]
    fn text_reviewer_can_never_establish_visual_acceptance() {
        let review = FigureReview {
            version_hash: "hash".into(),
            structure_pass: true,
            visual_pass: None,
            issues: vec![],
            received_images: false,
            evidence_hashes: vec![],
            raw_response: String::new(),
        };
        assert!(passed(&review));
        assert_ne!(review.visual_pass, Some(true));
    }
    #[test]
    fn changed_renderer_revokes_review_without_sending_a_request() {
        let workspace = tempfile::tempdir().unwrap();
        let id = "c".repeat(32);
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion": 1, "id": id, "title": "Renderer evidence", "method": "A to B", "style": "paper", "sourceMode": "import", "sourceMime": null, "sourceHash": null,
            "status": "ready", "outputLimit": 16384, "executor": ModelIdentity::default(), "reviewer": ModelIdentity::default(),
            "executorVision": true, "reviewerVision": true, "revisionUsed": false, "versions": [], "requests": [], "review": null, "error": null, "createdAt": "now", "updatedAt": "now"
        })).unwrap();
        store::create(workspace.path(), run, None).unwrap();
        let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='80'><rect width='180' height='80' fill='white'/><text x='10' y='40'>A to B</text></svg>";
        let rendered = tools::figures::render(svg).unwrap();
        let run = store::save_version(
            workspace.path(),
            &id,
            None,
            svg,
            &rendered.png,
            &rendered.pdf,
            rendered.version("test"),
        )
        .unwrap();
        let (run, ()) = store::update(workspace.path(), &id, |current| {
            current.status = "accepted".into();
            current.versions.last_mut().unwrap().font_fingerprint = "old-fonts".into();
            current.review = Some(FigureReview {
                version_hash: run.current_hash().unwrap().into(),
                structure_pass: true,
                visual_pass: Some(true),
                issues: vec![],
                received_images: true,
                evidence_hashes: vec![],
                raw_response: "{}".into(),
            });
            Ok(())
        })
        .unwrap();
        let final_path = store::directory(workspace.path(), &id)
            .unwrap()
            .join("final.svg");
        runtime::write_file_atomically(&final_path, svg).unwrap();
        let updated = invalidate_changed_renderer(workspace.path(), run).unwrap();
        assert_eq!(updated.status, "visual_pending");
        assert!(updated.review.is_none());
        assert!(updated.requests.is_empty());
        assert!(!final_path.exists());
        assert_eq!(updated.versions.len(), 1);
        assert_eq!(
            updated.current_hash(),
            Some(store::hash(svg.as_bytes()).as_str())
        );
    }
}
