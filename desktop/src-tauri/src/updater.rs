use serde::Serialize;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::UpdaterExt;

const CHINA_UPDATE_ENDPOINT: &str = "https://somni.chat/releases/latest.json";
const GLOBAL_UPDATE_ENDPOINT: &str =
    "https://github.com/zhuyingqin/Aris/releases/latest/download/latest.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    available: bool,
    current_version: Option<String>,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInstallResult {
    installed: bool,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    stage: &'static str,
    downloaded_bytes: u64,
    content_length: Option<u64>,
    percent: Option<u64>,
}

fn endpoint_for_region(is_china: bool) -> &'static str {
    if is_china {
        CHINA_UPDATE_ENDPOINT
    } else {
        GLOBAL_UPDATE_ENDPOINT
    }
}

async fn check(
    app: &AppHandle,
    is_china: bool,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let endpoint = endpoint_for_region(is_china)
        .parse()
        .map_err(|error| format!("invalid update endpoint: {error}"))?;
    let updater = app
        .updater_builder()
        // Exactly one endpoint is supplied deliberately. Mainland China must
        // never fall through to GitHub, while the global channel must not use
        // the website mirror.
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    updater.check().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle, is_china: bool) -> Result<AppUpdateInfo, String> {
    let Some(update) = check(&app, is_china).await? else {
        return Ok(AppUpdateInfo {
            available: false,
            current_version: None,
            version: None,
            date: None,
            body: None,
        });
    };
    Ok(AppUpdateInfo {
        available: true,
        current_version: Some(update.current_version),
        version: Some(update.version),
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    })
}

#[tauri::command]
pub async fn app_update_download_and_install(
    app: AppHandle,
    is_china: bool,
    on_progress: Channel<AppUpdateProgress>,
) -> Result<AppUpdateInstallResult, String> {
    let Some(update) = check(&app, is_china).await? else {
        return Ok(AppUpdateInstallResult {
            installed: false,
            version: None,
        });
    };
    let version = update.version.clone();
    let mut downloaded_bytes = 0_u64;
    let mut content_length = None;
    let mut started = false;
    update
        .download_and_install(
            |chunk_length, total| {
                if !started {
                    started = true;
                    content_length = total;
                    let _ = on_progress.send(AppUpdateProgress {
                        stage: "started",
                        downloaded_bytes: 0,
                        content_length,
                        percent: None,
                    });
                }
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let percent = content_length.map(|length| {
                    if length == 0 {
                        100
                    } else {
                        (downloaded_bytes.saturating_mul(100) / length).min(100)
                    }
                });
                let _ = on_progress.send(AppUpdateProgress {
                    stage: "progress",
                    downloaded_bytes,
                    content_length,
                    percent,
                });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    let _ = on_progress.send(AppUpdateProgress {
        stage: "finished",
        downloaded_bytes,
        content_length,
        percent: Some(100),
    });
    Ok(AppUpdateInstallResult {
        installed: true,
        version: Some(version),
    })
}

#[cfg(test)]
mod tests {
    use super::{endpoint_for_region, CHINA_UPDATE_ENDPOINT, GLOBAL_UPDATE_ENDPOINT};

    #[test]
    fn china_uses_only_the_official_website_endpoint() {
        assert_eq!(endpoint_for_region(true), CHINA_UPDATE_ENDPOINT);
        assert!(!endpoint_for_region(true).contains("github.com"));
    }

    #[test]
    fn users_outside_china_use_the_github_endpoint() {
        assert_eq!(endpoint_for_region(false), GLOBAL_UPDATE_ENDPOINT);
        assert!(endpoint_for_region(false).contains("github.com"));
    }
}
