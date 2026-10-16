use super::{active_runs, project};
use runtime::figures::drafts::{self, FigureDraft};
use tauri::AppHandle;

#[tauri::command]
pub async fn figures_save_draft(
    app: AppHandle,
    project_id: String,
    id: String,
    expected_hash: Option<String>,
    svg: String,
    base_index: Option<usize>,
) -> Result<FigureDraft, String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let jobs = active_runs().lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(&(project_id, id.clone())) {
            return Err("Wait for the active figure task before saving edits".into());
        }
        drafts::save(&workspace, &id, expected_hash.as_deref(), svg, base_index)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn figures_discard_draft(
    app: AppHandle,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let workspace = project(&app, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let jobs = active_runs().lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(&(project_id, id.clone())) {
            return Err("Wait for the active figure task before discarding edits".into());
        }
        drafts::discard(&workspace, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) fn canvas_svg(draft: &FigureDraft) -> Option<String> {
    tools::figures::inspect(&draft.svg)
        .ok()
        .map(|_| draft.svg.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_or_unsafe_drafts_remain_text_and_never_enter_the_canvas() {
        let mut draft = FigureDraft {
            svg: String::new(),
            expected_hash: None,
            base_index: None,
            updated_at: String::new(),
        };
        for source in [
            "<svg",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text onclick=\"alert(1)\">A</text></svg>",
        ] {
            draft.svg = source.into();
            assert!(canvas_svg(&draft).is_none());
            assert_eq!(draft.svg, source);
        }
        draft.svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>A</text></svg>".into();
        assert_eq!(canvas_svg(&draft).as_deref(), Some(draft.svg.as_str()));
    }
}
