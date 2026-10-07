//! OpenAI-compatible image transport. Paid submissions are never retried here.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Cursor, net::IpAddr, time::Duration};

pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = MAX_IMAGE_BYTES * 4 * 4 / 3 + 64 * 1024;

#[must_use]
pub fn is_image_generation_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("gpt-image-")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageGenerationRequest {
    pub model: String,
    pub prompt: String,
    pub size: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    pub n: u8,
}

impl ImageGenerationRequest {
    pub fn validate(&self) -> Result<(), String> {
        if !is_image_generation_model(&self.model) {
            return Err("请选择网关中的 GPT Image 绘图模型。".into());
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 120_000 {
            return Err("绘图提示词不能为空，且不能超过 120000 字节。".into());
        }
        if !matches!(
            self.size.as_str(),
            "auto" | "1024x1024" | "1536x1024" | "1024x1536"
        ) {
            return Err("不支持的图片尺寸。".into());
        }
        if self
            .quality
            .as_deref()
            .is_some_and(|quality| !matches!(quality, "auto" | "low" | "medium" | "high"))
        {
            return Err("不支持的图片质量。".into());
        }
        if !(1..=4).contains(&self.n) {
            return Err("每次可生成 1 到 4 张图片。".into());
        }
        Ok(())
    }
}

pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub extension: &'static str,
    pub width: u32,
    pub height: u32,
    pub revised_prompt: Option<String>,
}

pub struct ImageReference {
    pub name: String,
    pub image: GeneratedImage,
}

/// Validated binary PNG mask: transparent pixels are editable, opaque pixels
/// are protected. Keeping construction here avoids sending malformed masks.
pub struct ImageEditMask {
    image: GeneratedImage,
}

impl ImageEditMask {
    /// Opaque vision evidence: white means editable, black means protected.
    /// Mask RGB and transparent display backgrounds cannot invert the scope.
    pub fn selection_preview(&self) -> Result<GeneratedImage, String> {
        let mut pixels = ::image::load_from_memory(&self.image.bytes)
            .map_err(|e| e.to_string())?.to_rgba8();
        for pixel in pixels.pixels_mut() {
            let value = if pixel[3] == 0 { 255 } else { 0 };
            *pixel = ::image::Rgba([value, value, value, 255]);
        }
        let mut output = Cursor::new(Vec::new());
        ::image::DynamicImage::ImageRgba8(pixels)
            .write_to(&mut output, ::image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        validate_image_bytes(output.into_inner())
    }
}

pub fn validate_edit_mask(
    bytes: Vec<u8>,
    reference: &GeneratedImage,
) -> Result<ImageEditMask, String> {
    if bytes.len() >= 4 * 1024 * 1024 {
        return Err("圈选蒙版必须小于 4 MB。".into());
    }
    let image = validate_image_bytes(bytes)?;
    if image.mime_type != "image/png"
        || (image.width, image.height) != (reference.width, reference.height)
    {
        return Err("圈选蒙版必须是与原图尺寸一致的 PNG。".into());
    }
    let pixels = ::image::load_from_memory(&image.bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    if pixels.pixels().any(|pixel| !matches!(pixel[3], 0 | 255))
        || !pixels.pixels().any(|pixel| pixel[3] == 0)
    {
        return Err("请圈选需要修改的区域；蒙版只接受全透明和不透明像素。".into());
    }
    Ok(ImageEditMask { image })
}

/// Only encoder rounding is safe to align without interrupting an area edit.
/// Both axes must differ by at most two pixels and 0.5% of the smaller axis.
#[must_use]
pub fn image_dimensions_match_with_rounding(original: (u32, u32), returned: (u32, u32)) -> bool {
    [(original.0, returned.0), (original.1, returned.1)].into_iter().all(|(base, result)| {
        (1..=8192).contains(&base) && (1..=8192).contains(&result)
            && base.abs_diff(result) <= 2
            && u64::from(base.abs_diff(result)) * 200 <= u64::from(base.min(result))
    })
}

/// Local normalization for encoder rounding or a previewed user choice.
/// Callers retain the raw result and composite only the original edit mask.
pub fn resize_image_exact(image: &GeneratedImage, width: u32, height: u32) -> Result<GeneratedImage, String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("Invalid target image dimensions".into());
    }
    let pixels = ::image::load_from_memory(&image.bytes).map_err(|e| e.to_string())?
        .resize_exact(width, height, ::image::imageops::FilterType::Lanczos3);
    let mut output = Cursor::new(Vec::new());
    pixels.write_to(&mut output, ::image::ImageFormat::Png).map_err(|e| e.to_string())?;
    validate_image_bytes(output.into_inner())
}

/// Guarantees that the model cannot change any protected pixel. Different-size
/// results must be normalized or adopted as a whole image first.
pub fn composite_masked_edit(
    original: &GeneratedImage,
    edited: &GeneratedImage,
    mask: &ImageEditMask,
) -> Result<GeneratedImage, String> {
    if (original.width, original.height) != (edited.width, edited.height) {
        return Err(
            "图片尺寸不同，请先选择整图采用或缩放后应用圈选。".into(),
        );
    }
    if (original.width, original.height) != (mask.image.width, mask.image.height) {
        return Err("圈选与原图尺寸不一致。".into());
    }
    let mut pixels = ::image::load_from_memory(&original.bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let result = ::image::load_from_memory(&edited.bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let selection = ::image::load_from_memory(&mask.image.bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    for ((pixel, replacement), selected) in pixels
        .pixels_mut()
        .zip(result.pixels())
        .zip(selection.pixels())
    {
        if selected[3] == 0 {
            *pixel = *replacement;
        }
    }
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, ::image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    validate_image_bytes(output.into_inner())
}

pub struct ImageGenerationResult {
    pub images: Vec<GeneratedImage>,
    pub usage: Option<Value>,
}

pub fn validate_image_bytes(bytes: Vec<u8>) -> Result<GeneratedImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片为空或超过 32 MB 限制。".into());
    }
    let reader = ::image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别图片格式。")?;
    let (mime_type, extension) = match reader.format() {
        Some(::image::ImageFormat::Png) => ("image/png", "png"),
        Some(::image::ImageFormat::Jpeg) => ("image/jpeg", "jpg"),
        Some(::image::ImageFormat::WebP) => ("image/webp", "webp"),
        _ => return Err("绘图服务只接受 PNG、JPEG 或 WebP 图片。".into()),
    };
    let (width, height) = reader.into_dimensions().map_err(|_| "图片头损坏。")?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("图片尺寸超出支持范围。".into());
    }
    let mut reader = ::image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别图片格式。")?;
    let mut limits = ::image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "图片内容损坏或解码超过内存限制。")?;
    Ok(GeneratedImage {
        bytes,
        mime_type,
        extension,
        width,
        height,
        revised_prompt: None,
    })
}

pub fn image_as_png(image: GeneratedImage) -> Result<GeneratedImage, String> {
    if image.mime_type == "image/png" {
        return Ok(image);
    }
    let pixels = ::image::load_from_memory(&image.bytes).map_err(|e| e.to_string())?;
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, ::image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    validate_image_bytes(output.into_inner())
}

pub struct ImageApiClient {
    client: Client,
    base: Url,
    token: String,
}

impl ImageApiClient {
    pub fn new(base_url: &str, token: String) -> Result<Self, String> {
        let mut base = Url::parse(base_url.trim()).map_err(|_| "绘图网关地址无效。")?;
        let loopback = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(base.scheme() == "https" || (base.scheme() == "http" && loopback))
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || token.trim().is_empty()
        {
            return Err("绘图网关必须使用 HTTPS 和有效账号令牌。".into());
        }
        let path = format!("{}/", base.path().trim_end_matches('/'));
        base.set_path(&path);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|_| "无法创建绘图连接。")?;
        Ok(Self {
            client,
            base,
            token,
        })
    }

    pub async fn generate(
        &self,
        request: &ImageGenerationRequest,
        references: Vec<ImageReference>,
    ) -> Result<ImageGenerationResult, String> {
        self.submit(request, references, None).await
    }

    pub async fn edit(
        &self,
        request: &ImageGenerationRequest,
        reference: ImageReference,
        mask: &ImageEditMask,
    ) -> Result<ImageGenerationResult, String> {
        if (reference.image.width, reference.image.height) != (mask.image.width, mask.image.height)
        {
            return Err("圈选与原图尺寸不一致。".into());
        }
        self.submit(request, vec![reference], Some(mask)).await
    }

    async fn submit(
        &self,
        request: &ImageGenerationRequest,
        references: Vec<ImageReference>,
        mask: Option<&ImageEditMask>,
    ) -> Result<ImageGenerationResult, String> {
        request.validate()?;
        if references.len() > 16 {
            return Err("每次最多使用 16 张参考图片。".into());
        }
        let endpoint = if references.is_empty() {
            "images/generations"
        } else {
            "images/edits"
        };
        let url = self.base.join(endpoint).map_err(|_| "绘图接口地址无效。")?;
        let builder = self.client.post(url).bearer_auth(&self.token);
        let builder = if references.is_empty() {
            builder.json(request)
        } else {
            let mut form = multipart::Form::new()
                .text("model", request.model.clone())
                .text("prompt", request.prompt.clone())
                .text("size", request.size.clone())
                .text("n", request.n.to_string());
            if let Some(quality) = &request.quality {
                form = form.text("quality", quality.clone());
            }
            for reference in references {
                let part = multipart::Part::bytes(reference.image.bytes)
                    .file_name(reference.name)
                    .mime_str(reference.image.mime_type)
                    .map_err(|_| "参考图片格式无效。")?;
                form = form.part("image[]", part);
            }
            if let Some(mask) = mask {
                form = form.part(
                    "mask",
                    multipart::Part::bytes(mask.image.bytes.clone())
                        .file_name("selection.png")
                        .mime_str("image/png")
                        .map_err(|e| e.to_string())?,
                );
            }
            builder.multipart(form)
        };
        let response = builder
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_RESPONSE_BYTES).await?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| {
            if status == reqwest::StatusCode::NOT_FOUND {
                "Somni 绘图入口暂不可用（HTTP 404），请检查网关是否开放图片生成和编辑接口。"
                    .to_string()
            } else {
                format!("绘图网关返回了无法解析的响应（HTTP {status}）。")
            }
        })?;
        if !status.is_success() {
            let detail = body
                .pointer("/error/message")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("请求未成功")
                .replace(&self.token, "[redacted]");
            return Err(format!(
                "Somni 绘图失败（HTTP {status}）：{}",
                detail.chars().take(700).collect::<String>()
            ));
        }
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .filter(|data| !data.is_empty())
            .ok_or("绘图网关没有返回图片。")?;
        if data.len() > usize::from(request.n) {
            return Err("绘图网关返回的图片数量超过请求数量。".into());
        }
        let mut images = Vec::with_capacity(data.len());
        for item in data {
            let bytes = if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
                STANDARD
                    .decode(encoded)
                    .map_err(|_| "绘图网关返回了损坏的图片编码。")?
            } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                if let Some((header, encoded)) = url.split_once(',').filter(|(header, _)| {
                    header.starts_with("data:image/") && header.ends_with(";base64")
                }) {
                    let _ = header;
                    STANDARD
                        .decode(encoded)
                        .map_err(|_| "绘图网关返回了损坏的图片编码。")?
                } else {
                    download_image(url).await?
                }
            } else {
                return Err("绘图网关返回了缺少图片数据的结果。".into());
            };
            let mut image = validate_image_bytes(bytes)?;
            image.revised_prompt = item
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            images.push(image);
        }
        Ok(ImageGenerationResult {
            images,
            usage: body.get("usage").cloned(),
        })
    }

    fn transport_error(&self, error: &reqwest::Error) -> String {
        if error.is_timeout() {
            "Somni 绘图请求超时，服务器可能仍在生成；请先核对账户用量，避免重复提交。".into()
        } else {
            "无法连接 Somni 绘图服务，请检查网络或网关状态。".into()
        }
    }
}

async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("绘图服务响应超过大小限制。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取绘图响应失败；请核对账户用量后再决定是否重试。")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("绘图服务响应超过大小限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && ip.octets()[0] != 0
                && ip.octets()[0] < 224
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                && !(ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(ip));
            }
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && ip.segments()[0] & 0xfe00 != 0xfc00
                && ip.segments()[0] & 0xffc0 != 0xfe80
                && ip.segments()[0] & 0xe000 == 0x2000
        }
    }
}

async fn download_image(url: &str) -> Result<Vec<u8>, String> {
    let url = Url::parse(url).map_err(|_| "图片下载地址无效。")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("图片下载地址必须是公开 HTTPS 地址。".into());
    }
    let host = url.host_str().ok_or("图片下载地址缺少域名。")?;
    let port = url.port_or_known_default().ok_or("图片下载端口无效。")?;
    let addresses: Vec<_> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
        .await
        .map_err(|_| "无法解析图片下载地址。")?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("图片下载地址不能指向本机或内部网络。".into());
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "无法创建图片下载连接。")?;
    // A CDN receives no gateway authorization header, even on the same origin.
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "下载生成的图片失败。")?;
    if !response.status().is_success() {
        return Err("生成图片的下载地址不可用。".into());
    }
    read_bounded(response, MAX_IMAGE_BYTES).await
}

#[cfg(test)]
#[path = "tests/image.rs"]
mod tests;
