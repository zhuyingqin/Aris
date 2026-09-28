//! Live acceptance plumbing, not another model executor. There is no HTTP
//! control surface and no automatic execution in the packaged release app.

use super::*;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    paper_id: String,
    title: String,
    relative_path: String,
    document_revision: String,
    source_url: String,
    pages: Vec<PageInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageInput {
    page_index: usize,
    image_file: PathBuf,
    embedded_text: String,
    text_truncated: bool,
}

fn write_report(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    runtime::write_file_atomically(path, data).map_err(|e| e.to_string())
}

pub(crate) fn run(manifest_path: PathBuf) {
    // Never initialise diagnostics in the user's ordinary configuration. The
    // caller supplies an isolated root and explicitly marks it as disposable.
    let config_root = std::env::var_os("ARIS_CONFIG_ROOT")
        .map(PathBuf::from)
        .expect("Paper reading diagnostics require an isolated ARIS_CONFIG_ROOT");
    assert!(
        config_root.join(".paper-reading-diagnostic").is_file(),
        "Missing diagnostic isolation marker"
    );
    let mut context = crate::app_context();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(crate::engine::ChatState::default())
        .manage(crate::projects::ProjectState::default())
        .manage(crate::memory::MemoryState::default())
        .manage(crate::compute::ComputeState::default())
        .setup(move |app| {
            crate::projects::init(app.state::<ProjectState>().inner()).map_err(std::io::Error::other)?;
            crate::config::apply_reviewer_environment(false);
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let started = Instant::now();
                let output = manifest_path.with_file_name("live-result.json");
                let result = execute(&app, &manifest_path).await;
                let failed = result.is_err();
                let report = match result {
                    Ok(value) => serde_json::json!({"ok":true,"elapsedMs":started.elapsed().as_millis(),"result":value}),
                    Err(error) => serde_json::json!({"ok":false,"elapsedMs":started.elapsed().as_millis(),"error":error}),
                };
                let saved = write_report(&output, &report);
                if let Err(error) = &saved { eprintln!("Paper reading diagnostic report: {error}"); }
                app.exit(i32::from(failed || saved.is_err()));
            });
            Ok(())
        })
        .build(context).expect("Cannot build paper reading diagnostic host")
        .run(|_, _| {});
}

async fn execute(app: &AppHandle, manifest_path: &Path) -> Result<serde_json::Value, String> {
    if fs::metadata(manifest_path)
        .map_err(|e| e.to_string())?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Diagnostic manifest is too large".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let (project_id, workspace) = project(app, Some("default"))?;
    let now = runtime::now_iso8601();
    let record =
        serde_json::from_value::<runtime::literature::CanonicalRecord>(serde_json::json!({
            "schemaVersion": runtime::literature::LITERATURE_SCHEMA_VERSION,
            "id": manifest.paper_id, "title": manifest.title,
            "normalizedTitle": runtime::literature::normalized_record_title(&manifest.title),
            "createdAt": now, "updatedAt": now, "pdfUrl": manifest.source_url,
            "metadata": {"pdf": {"path": manifest.relative_path}},
        }))
        .map_err(|e| e.to_string())?;
    if open_literature_store_at(&workspace)?
        .load_canonical_record(&record.id)?
        .is_none()
    {
        open_literature_store_at(&workspace)?.insert_canonical_record(&record)?;
    }
    let mut prepared = paper_reading_prepare(
        app.clone(),
        PreparePaperInput {
            project_id: project_id.clone(),
            paper_id: manifest.paper_id.clone(),
            relative_path: manifest.relative_path.clone(),
            document_revision: manifest.document_revision.clone(),
            language: "zh".into(),
            model: None,
            regenerate: false,
            run_id: None,
        },
    )
    .await?;
    if manifest.pages.len() != prepared.run.total_pages
        || manifest
            .pages
            .iter()
            .enumerate()
            .any(|(index, page)| index != page.page_index)
    {
        return Err("Diagnostic must prepare every PDF page exactly once, in order".into());
    }
    let restored_completed = prepared.coverage.page_processing_coverage.completed;
    let attempts_before: usize = prepared
        .run
        .pages
        .iter()
        .map(|page| page.attempts.len())
        .sum();
    let guide_attempts_before = prepared.run.guide.as_ref().map_or(0, |guide| {
        guide.outline.attempts.len()
            + guide
                .lessons
                .iter()
                .map(|lesson| lesson.task.attempts.len())
                .sum::<usize>()
    });
    for page in manifest.pages {
        if prepared.run.pages[page.page_index].source.is_some() {
            continue;
        }
        let image = fs::read(&page.image_file).map_err(|e| e.to_string())?;
        prepared = paper_reading_source(
            app.clone(),
            PageSourceInput {
                project_id: project_id.clone(),
                run_id: prepared.run.id.clone(),
                page_index: page.page_index,
                document_revision: manifest.document_revision.clone(),
                image_base64: base64::engine::general_purpose::STANDARD.encode(image),
                embedded_text: page.embedded_text,
                text_truncated: page.text_truncated,
            },
        )
        .await?;
    }
    let run_id = prepared.run.id.clone();
    let first = paper_reading_start(app.clone(), project_id.clone(), run_id.clone(), None).await?;
    // A repeated dispatch while active must attach to the same controller.
    let duplicate = paper_reading_start(app.clone(), project_id.clone(), run_id.clone(), None).await?;
    if first.run.id != duplicate.run.id {
        return Err("Duplicate dispatch created another task".into());
    }
    let deadline = Instant::now() + Duration::from_secs(45 * 60);
    let progress_path = manifest_path.with_file_name("live-progress.json");
    let final_view = loop {
        let current = view(&project_id, load_run(&workspace, &run_id)?);
        write_report(
            &progress_path,
            &serde_json::json!({
                "runId": run_id, "active": current.active, "status": current.run.status,
                "pages": current.coverage.page_processing_coverage,
                "currentPage": current.run.pages.iter().find(|page| page.status == runtime::paper_reading::PageStatus::Running).map(|page| page.page_index + 1),
                "guide": current.run.guide.as_ref().map(|guide| serde_json::json!({
                    "outline": guide.outline.status,
                    "completed": guide.lessons.iter().filter(|lesson| lesson.task.status == runtime::paper_guide::GuideTaskStatus::Completed).count(),
                    "total": guide.lessons.len(),
                    "currentTopic": guide.lessons.iter().find(|lesson| lesson.task.status == runtime::paper_guide::GuideTaskStatus::Running).map(|lesson| &lesson.topic.title),
                    "reviews": guide.review_counts(),
                })),
            }),
        )?;
        if !current.active {
            break current;
        }
        if Instant::now() >= deadline {
            paper_reading_cancel(app.clone(), project_id.clone(), run_id.clone()).await?;
            return Err("Diagnostic exceeded its 45 minute budget; task cancelled".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let reloaded = paper_reading_get(
        app.clone(),
        project_id,
        manifest.paper_id,
        manifest.relative_path,
    )
    .await?
    .ok_or("Saved paper result was not found")?;
    let durable_matches = serde_json::to_value(&final_view.run).map_err(|e| e.to_string())?
        == serde_json::to_value(&reloaded.run).map_err(|e| e.to_string())?;
    let attempts_after: usize = final_view
        .run
        .pages
        .iter()
        .map(|page| page.attempts.len())
        .sum();
    Ok(serde_json::json!({
        "entry": "paper_reading_start -> run_paper_reading_turn -> run_chat_turn_with_context",
        "sourceUrl": manifest.source_url, "restoredCompletedPages": restored_completed,
        "newAttempts": attempts_after.saturating_sub(attempts_before),
        "newGuideAttempts": final_view.run.guide.as_ref().map_or(0, |guide| guide.outline.attempts.len() + guide.lessons.iter().map(|lesson| lesson.task.attempts.len()).sum::<usize>()).saturating_sub(guide_attempts_before),
        "durableReloadMatches": durable_matches, "view": final_view,
    }))
}
