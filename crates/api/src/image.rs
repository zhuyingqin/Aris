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
