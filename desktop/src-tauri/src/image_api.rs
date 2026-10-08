//! Somni gateway image tool: agent-authored prompt, account-bound HTTP, local artifacts.
use crate::{config, newapi};
use api::{ImageApiClient, ImageGenerationRequest, ImageReference};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SomniImageSettings {
    pub enabled: bool,
    pub model: Option<String>,
    pub models: Vec<String>,
    pub available: bool,
}

fn settings_from_object(obj: &Map<String, Value>) -> SomniImageSettings {
    let mut models: Vec<_> = obj
        .get("managed_models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|model| api::is_image_generation_model(model))
        .map(ToString::to_string)
        .collect();
    models.sort();
    models.dedup();
    let requested = obj
        .get("somni_image_model")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let model = requested
        .clone()
        .or_else(|| {
            models
                .iter()
                .find(|model| model.as_str() == "gpt-image-2")
                .cloned()
        })
        .or_else(|| models.first().cloned());
    let enabled = obj
        .get("somni_image_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let available = enabled
        && model.as_ref().is_some_and(|model| models.contains(model))
        && managed_credentials(obj).is_ok();
    SomniImageSettings {
        enabled,
        model,
        models,
        available,
    }
}

fn managed_credentials(obj: &Map<String, Value>) -> Result<(String, String), String> {
    let base = config::managed_executor_base_url(obj).ok_or("请先登录 Somni 账号。")?;
    let url = reqwest::Url::parse(&base).map_err(|_| "Somni 网关配置无效。")?;
    if url.path().trim_end_matches('/') != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !newapi::is_approved_managed_base(&url.origin().ascii_serialization())
    {
        return Err("绘图工具只能使用当前客户端配置的 Somni 网关。".into());
    }
    let key = config::managed_executor_api_key(obj).ok_or("请先登录 Somni 账号。")?;
    Ok((base, key))
}

#[tauri::command]
pub fn somni_image_settings() -> SomniImageSettings {
    settings_from_object(&config::load_object())
}

#[tauri::command]
pub fn somni_image_settings_set(
    enabled: bool,
    model: Option<String>,
) -> Result<SomniImageSettings, String> {
    let settings = somni_image_settings();
    if let Some(model) = model.as_deref().filter(|model| !model.trim().is_empty()) {
        if !settings
            .models
            .iter()
            .any(|candidate| candidate == model.trim())
        {
            return Err("所选绘图模型不在当前账号的可用模型列表中，请先同步模型。".into());
        }
    }
    config::set_somni_image_preferences(enabled, model)?;
    Ok(somni_image_settings())
}

pub(crate) fn tool_available() -> bool {
    somni_image_settings().available
}

/// Resolve once before the figure's first paid request. Generation then uses
/// this same account connection even if Settings changes during vision probes.
pub(crate) struct PreparedFigureImage {
    pub identity: runtime::figures::ModelIdentity,
    client: ImageApiClient,
    request: ImageGenerationRequest,
}

pub(crate) fn prepare_figure_image(prompt: String, model: Option<String>) -> Result<PreparedFigureImage, String> {
    let object = config::load_object();
    let settings = settings_from_object(&object);
    if !settings.available { return Err("SomniImage is not available; configure it in Settings or import an image".into()); }
    let model = model.or(settings.model).ok_or("SomniImage has no model")?;
    if !settings.models.contains(&model) { return Err("SomniImage model is no longer available".into()); }
    let (base, key) = managed_credentials(&object)?;
    let identity = runtime::figures::ModelIdentity {
        model: model.clone(), provider: "somni-image".into(), endpoint: base.clone(), transport: "images_generations".into(),
        signature: runtime::figures::hash(format!("image|{model}|{base}|figure-image-v1").as_bytes()),
    };
    let request = ImageGenerationRequest { model, prompt, size: "1024x1024".into(), quality: None, n: 1 };
    request.validate()?;
    Ok(PreparedFigureImage { identity, client: ImageApiClient::new(&base, key)?, request })
}

impl PreparedFigureImage {
    pub fn set_prompt(&mut self, prompt: String) -> Result<(), String> {
        let mut request = self.request.clone();
        request.prompt = prompt;
        request.validate()?;
        self.request = request;
        Ok(())
    }
    pub fn edit(&self, reference: ImageReference, mask: &api::ImageEditMask, cancelled: Arc<AtomicBool>) -> Result<api::ImageGenerationResult, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        runtime.block_on(async {
            tokio::select! {
                biased;
                () = wait_for_cancel(&cancelled) => Err("图片修改已取消；服务器可能仍在处理，请先核对账户用量。".into()),
                result = self.client.edit(&self.request, reference, mask) => result,
            }
        })
    }
    pub fn generate(&self, workspace: &Path, cancelled: Arc<AtomicBool>) -> Result<Value, String> {
        let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        let result = runtime.block_on(generate_with_cancel(&self.client, &self.request, Vec::new(), &cancelled))?;
        let run_id: String = rand::thread_rng().sample_iter(&Alphanumeric).take(24).map(char::from).collect();
        save_result(&workspace, &run_id, &self.request, &[], result)
    }
}

pub(crate) fn prepare_figure_edit(prompt: String, model: Option<String>) -> Result<PreparedFigureImage, String> {
    let mut prepared = prepare_figure_image(prompt, model)?;
    prepared.request.size = "auto".into();
    prepared.identity.transport = "images_edits".into();
    Ok(prepared)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageToolInput {
    prompt: String,
    #[serde(default)]
    files: Vec<String>,
    model: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    #[serde(default = "one")]
    n: u8,
}

fn one() -> u8 {
    1
}

pub(crate) fn execute_tool(
    workspace: &Path,
    input: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let input: ImageToolInput =
        serde_json::from_str(input).map_err(|error| format!("绘图参数无效：{error}"))?;
    let obj = config::load_object();
    let settings = settings_from_object(&obj);
    if !settings.enabled {
        return Err("Somni 绘图已关闭，请在设置 > 模型中开启。".into());
    }
    let model = input
        .model
        .or(settings.model)
        .ok_or("请在设置 > 模型中同步并选择绘图模型。")?;
    if !settings.models.contains(&model) {
        return Err("绘图模型不可用，请在设置 > 模型中重新同步。".into());
    }
    let (base, key) = managed_credentials(&obj)?;
    let workspace = workspace
        .canonicalize()
        .map_err(|_| "当前项目目录不可用。")?;
    if !workspace.is_dir() {
        return Err("绘图需要有效的当前项目目录。".into());
    }
    let request = ImageGenerationRequest {
        model,
        prompt: input.prompt.trim().into(),
        size: input.size.unwrap_or_else(|| "1024x1024".into()),
        quality: input.quality,
        n: input.n,
    };
    request.validate()?;
    let references = reference_images(&workspace, &input.files)?;
    let client = ImageApiClient::new(&base, key)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("无法启动绘图请求：{error}"))?;
    let result = runtime.block_on(generate_with_cancel(
        &client, &request, references, &cancelled,
    ))?;
    if cancelled.load(Ordering::SeqCst) {
        return Err("绘图任务已取消。".into());
    }
    let run_id: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    save_result(&workspace, &run_id, &request, &input.files, result)
        .and_then(|result| serde_json::to_string_pretty(&result).map_err(|error| error.to_string()))
}

async fn generate_with_cancel(
    client: &ImageApiClient,
    request: &ImageGenerationRequest,
    references: Vec<ImageReference>,
    cancelled: &AtomicBool,
) -> Result<api::ImageGenerationResult, String> {
    tokio::select! {
        biased;
        () = wait_for_cancel(cancelled) => Err("绘图请求已取消；服务器可能仍在生成，请先核对账户用量再重新提交。".into()),
        result = client.generate(request, references) => result,
    }
}

async fn wait_for_cancel(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn reference_images(workspace: &Path, files: &[String]) -> Result<Vec<ImageReference>, String> {
    if files.len() > 16 {
        return Err("每次最多使用 16 张项目内参考图片。".into());
    }
    let mut total = 0_u64;
    files
        .iter()
        .map(|file| {
            let path = workspace
                .join(file)
                .canonicalize()
                .map_err(|_| format!("参考图片不存在：{file}"))?;
            if !path.starts_with(workspace) || !path.is_file() {
                return Err("参考图片必须位于当前项目内。".into());
            }
            let size = fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len();
            total = total.saturating_add(size);
            if size > api::MAX_IMAGE_BYTES as u64 || total > 64 * 1024 * 1024 {
                return Err("参考图片过大；单张最多 32 MB，总计最多 64 MB。".into());
            }
            let image =
                api::validate_image_bytes(fs::read(&path).map_err(|error| error.to_string())?)?;
            Ok(ImageReference {
                name: format!("reference-{}.{}", total, image.extension),
                image,
            })
        })
        .collect()
}

fn artifact_directory(workspace: &Path, run_id: &str) -> Result<PathBuf, String> {
    let mut directory = workspace.to_path_buf();
    for component in [".somniq", "artifacts", "somni-images", run_id] {
        directory.push(component);
        if !directory.exists() {
            fs::create_dir(&directory).map_err(|error| error.to_string())?;
        }
        let canonical = directory
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical.starts_with(workspace) {
            return Err("图片保存目录不能指向项目外部。".into());
        }
        directory = canonical;
    }
    Ok(directory)
}

fn save_result(
    workspace: &Path,
    run_id: &str,
    request: &ImageGenerationRequest,
    files: &[String],
    result: api::ImageGenerationResult,
) -> Result<Value, String> {
    let directory = artifact_directory(workspace, run_id)?;
    let mut images = Vec::new();
    for (index, image) in result.images.into_iter().enumerate() {
        let path = directory.join(format!("image-{}.{}", index + 1, image.extension));
        fs::write(&path, &image.bytes).map_err(|error| format!("保存生成图片失败：{error}"))?;
        images.push(json!({ "path": path.strip_prefix(workspace).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/"),
            "width": image.width, "height": image.height, "sizeBytes": image.bytes.len(),
            "mimeType": image.mime_type, "sha256": format!("{:x}", Sha256::digest(&image.bytes)),
            "revisedPrompt": image.revised_prompt }));
    }
    let output = json!({ "provider": "somni", "status": "completed", "requestId": run_id,
        "model": request.model, "prompt": request.prompt, "size": request.size, "quality": request.quality,
        "referenceFiles": files, "images": images, "usage": result.usage,
        "createdAt": runtime::now_iso8601() });
    runtime::write_file_atomically(
        &directory.join("generation.json"),
        &serde_json::to_vec_pretty(&output).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("图片已保存，但生成记录保存失败：{error}"))?;
    Ok(output)
}

#[cfg(test)]
#[path = "tests/image_api.rs"]
mod tests;
