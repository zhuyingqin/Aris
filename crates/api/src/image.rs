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
            return Err(runtime::ui_lang::tr_static("请选择网关中的 GPT Image 绘图模型。", "Choose a GPT Image drawing model from the gateway.", "Elige un modelo de dibujo GPT Image del gateway.").into());
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 120_000 {
            return Err(runtime::ui_lang::tr_static("绘图提示词不能为空，且不能超过 120000 字节。", "The drawing prompt must not be empty or longer than 120000 bytes.", "La instrucción de dibujo no puede estar vacía ni superar los 120000 bytes.").into());
        }
        if !matches!(
            self.size.as_str(),
            "auto" | "1024x1024" | "1536x1024" | "1024x1536"
        ) {
            return Err(runtime::ui_lang::tr_static("不支持的图片尺寸。", "Unsupported image size.", "Tamaño de imagen no compatible.").into());
        }
        if self
            .quality
            .as_deref()
            .is_some_and(|quality| !matches!(quality, "auto" | "low" | "medium" | "high"))
        {
            return Err(runtime::ui_lang::tr_static("不支持的图片质量。", "Unsupported image quality.", "Calidad de imagen no compatible.").into());
        }
        if !(1..=4).contains(&self.n) {
            return Err(runtime::ui_lang::tr_static("每次可生成 1 到 4 张图片。", "You can generate 1 to 4 images at a time.", "Puedes generar de 1 a 4 imágenes cada vez.").into());
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
        return Err(runtime::ui_lang::tr_static("圈选蒙版必须小于 4 MB。", "The selection mask must be smaller than 4 MB.", "La máscara de selección debe ocupar menos de 4 MB.").into());
    }
    let image = validate_image_bytes(bytes)?;
    if image.mime_type != "image/png"
        || (image.width, image.height) != (reference.width, reference.height)
    {
        return Err(runtime::ui_lang::tr_static("圈选蒙版必须是与原图尺寸一致的 PNG。", "The selection mask must be a PNG the same size as the original image.", "La máscara de selección debe ser un PNG del mismo tamaño que la imagen original.").into());
    }
    let pixels = ::image::load_from_memory(&image.bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    if pixels.pixels().any(|pixel| !matches!(pixel[3], 0 | 255))
        || !pixels.pixels().any(|pixel| pixel[3] == 0)
    {
        return Err(runtime::ui_lang::tr_static("请圈选需要修改的区域；蒙版只接受全透明和不透明像素。", "Select the area to change; the mask accepts only fully transparent and opaque pixels.", "Selecciona la zona que quieres cambiar; la máscara solo admite píxeles totalmente transparentes u opacos.").into());
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
            runtime::ui_lang::tr_static("图片尺寸不同，请先选择整图采用或缩放后应用圈选。", "The image sizes differ. Choose to use the whole image, or scale it before applying the selection.", "Las imágenes tienen tamaños distintos. Elige usar la imagen completa o escalarla antes de aplicar la selección.").into(),
        );
    }
    if (original.width, original.height) != (mask.image.width, mask.image.height) {
        return Err(runtime::ui_lang::tr_static("圈选与原图尺寸不一致。", "The selection does not match the original image size.", "La selección no coincide con el tamaño de la imagen original.").into());
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
        return Err(runtime::ui_lang::tr_static("图片为空或超过 32 MB 限制。", "The image is empty or exceeds the 32 MB limit.", "La imagen está vacía o supera el límite de 32 MB.").into());
    }
    let reader = ::image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| runtime::ui_lang::tr_static("无法识别图片格式。", "Unrecognized image format.", "No se reconoce el formato de la imagen."))?;
    let (mime_type, extension) = match reader.format() {
        Some(::image::ImageFormat::Png) => ("image/png", "png"),
        Some(::image::ImageFormat::Jpeg) => ("image/jpeg", "jpg"),
        Some(::image::ImageFormat::WebP) => ("image/webp", "webp"),
        _ => return Err(runtime::ui_lang::tr_static("绘图服务只接受 PNG、JPEG 或 WebP 图片。", "The drawing service accepts only PNG, JPEG or WebP images.", "El servicio de dibujo solo acepta imágenes PNG, JPEG o WebP.").into()),
    };
    let (width, height) = reader.into_dimensions().map_err(|_| runtime::ui_lang::tr_static("图片头损坏。", "The image header is corrupted.", "El encabezado de la imagen está dañado."))?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(runtime::ui_lang::tr_static("图片尺寸超出支持范围。", "The image dimensions are outside the supported range.", "Las dimensiones de la imagen están fuera del rango admitido.").into());
    }
    let mut reader = ::image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| runtime::ui_lang::tr_static("无法识别图片格式。", "Unrecognized image format.", "No se reconoce el formato de la imagen."))?;
    let mut limits = ::image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| runtime::ui_lang::tr_static("图片内容损坏或解码超过内存限制。", "The image is corrupted or decoding it exceeds the memory limit.", "La imagen está dañada o decodificarla supera el límite de memoria."))?;
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
        let mut base = Url::parse(base_url.trim()).map_err(|_| runtime::ui_lang::tr_static("绘图网关地址无效。", "Invalid drawing gateway address.", "La dirección del gateway de dibujo no es válida."))?;
        let loopback = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(base.scheme() == "https" || (base.scheme() == "http" && loopback))
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || token.trim().is_empty()
        {
            return Err(runtime::ui_lang::tr_static("绘图网关必须使用 HTTPS 和有效账号令牌。", "The drawing gateway must use HTTPS and a valid account token.", "El gateway de dibujo debe usar HTTPS y un token de cuenta válido.").into());
        }
        let path = format!("{}/", base.path().trim_end_matches('/'));
        base.set_path(&path);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|_| runtime::ui_lang::tr_static("无法创建绘图连接。", "Could not create the drawing connection.", "No se pudo crear la conexión de dibujo."))?;
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
            return Err(runtime::ui_lang::tr_static("圈选与原图尺寸不一致。", "The selection does not match the original image size.", "La selección no coincide con el tamaño de la imagen original.").into());
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
            return Err(runtime::ui_lang::tr_static("每次最多使用 16 张参考图片。", "Use at most 16 reference images at a time.", "Usa como máximo 16 imágenes de referencia cada vez.").into());
        }
        let endpoint = if references.is_empty() {
            "images/generations"
        } else {
            "images/edits"
        };
        let url = self.base.join(endpoint).map_err(|_| runtime::ui_lang::tr_static("绘图接口地址无效。", "Invalid drawing endpoint address.", "La dirección del endpoint de dibujo no es válida."))?;
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
                    .map_err(|_| runtime::ui_lang::tr_static("参考图片格式无效。", "Invalid reference image format.", "El formato de la imagen de referencia no es válido."))?;
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
                runtime::ui_lang::tr_static("Somni 绘图入口暂不可用（HTTP 404），请检查网关是否开放图片生成和编辑接口。", "Somni drawing is unavailable (HTTP 404). Check that the gateway exposes the image generation and editing endpoints.", "El dibujo de Somni no está disponible (HTTP 404). Comprueba que el gateway ofrezca los endpoints de generación y edición de imágenes.")
                    .to_string()
            } else {
                runtime::tr!("绘图网关返回了无法解析的响应（HTTP {status}）。", "The drawing gateway returned a response that could not be parsed (HTTP {status}).", "El gateway de dibujo devolvió una respuesta que no se pudo interpretar (HTTP {status}).")
            }
        })?;
        if !status.is_success() {
            let detail = body
                .pointer("/error/message")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or(runtime::ui_lang::tr_static("请求未成功", "The request did not succeed", "La solicitud no se completó"))
                .replace(&self.token, "[redacted]");
            return Err(runtime::tr!(
                "Somni 绘图失败（HTTP {status}）：{}", "Somni drawing failed (HTTP {status}): {}", "El dibujo de Somni falló (HTTP {status}): {}",
                detail.chars().take(700).collect::<String>()
            ));
        }
        let data = body
            .get("data")
            .and_then(Value::as_array)
            .filter(|data| !data.is_empty())
            .ok_or(runtime::ui_lang::tr_static("绘图网关没有返回图片。", "The drawing gateway returned no image.", "El gateway de dibujo no devolvió ninguna imagen."))?;
        if data.len() > usize::from(request.n) {
            return Err(runtime::ui_lang::tr_static("绘图网关返回的图片数量超过请求数量。", "The drawing gateway returned more images than requested.", "El gateway de dibujo devolvió más imágenes de las solicitadas.").into());
        }
        let mut images = Vec::with_capacity(data.len());
        for item in data {
            let bytes = if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
                STANDARD
                    .decode(encoded)
                    .map_err(|_| runtime::ui_lang::tr_static("绘图网关返回了损坏的图片编码。", "The drawing gateway returned a corrupted image encoding.", "El gateway de dibujo devolvió una imagen con codificación dañada."))?
            } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                if let Some((header, encoded)) = url.split_once(',').filter(|(header, _)| {
                    header.starts_with("data:image/") && header.ends_with(";base64")
                }) {
                    let _ = header;
                    STANDARD
                        .decode(encoded)
                        .map_err(|_| runtime::ui_lang::tr_static("绘图网关返回了损坏的图片编码。", "The drawing gateway returned a corrupted image encoding.", "El gateway de dibujo devolvió una imagen con codificación dañada."))?
                } else {
                    download_image(url).await?
                }
            } else {
                return Err(runtime::ui_lang::tr_static("绘图网关返回了缺少图片数据的结果。", "The drawing gateway returned a result without image data.", "El gateway de dibujo devolvió un resultado sin datos de imagen.").into());
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
            runtime::ui_lang::tr_static("Somni 绘图请求超时，服务器可能仍在生成；请先核对账户用量，避免重复提交。", "The Somni drawing request timed out and the server may still be generating. Check your account usage before submitting again.", "La solicitud de dibujo de Somni superó el tiempo de espera y es posible que el servidor siga generando. Revisa el uso de tu cuenta antes de volver a enviarla.").into()
        } else {
            runtime::ui_lang::tr_static("无法连接 Somni 绘图服务，请检查网络或网关状态。", "Failed to connect to the Somni drawing service. Check your network or the gateway status.", "No se pudo conectar con el servicio de dibujo de Somni. Revisa tu red o el estado del gateway.").into()
        }
    }
}

async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(runtime::ui_lang::tr_static("绘图服务响应超过大小限制。", "The drawing service response exceeds the size limit.", "La respuesta del servicio de dibujo supera el límite de tamaño.").into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| runtime::ui_lang::tr_static("读取绘图响应失败；请核对账户用量后再决定是否重试。", "Reading the drawing response failed. Check your account usage before deciding whether to retry.", "No se pudo leer la respuesta de dibujo. Revisa el uso de tu cuenta antes de decidir si reintentas."))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(runtime::ui_lang::tr_static("绘图服务响应超过大小限制。", "The drawing service response exceeds the size limit.", "La respuesta del servicio de dibujo supera el límite de tamaño.").into());
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
    let url = Url::parse(url).map_err(|_| runtime::ui_lang::tr_static("图片下载地址无效。", "Invalid image download address.", "La dirección de descarga de la imagen no es válida."))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(runtime::ui_lang::tr_static("图片下载地址必须是公开 HTTPS 地址。", "The image download address must be a public HTTPS address.", "La dirección de descarga de la imagen debe ser una dirección HTTPS pública.").into());
    }
    let host = url.host_str().ok_or(runtime::ui_lang::tr_static("图片下载地址缺少域名。", "The image download address has no host name.", "A la dirección de descarga de la imagen le falta el dominio."))?;
    let port = url.port_or_known_default().ok_or(runtime::ui_lang::tr_static("图片下载端口无效。", "Invalid image download port.", "El puerto de descarga de la imagen no es válido."))?;
    let addresses: Vec<_> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
        .await
        .map_err(|_| runtime::ui_lang::tr_static("无法解析图片下载地址。", "Could not resolve the image download address.", "No se pudo resolver la dirección de descarga de la imagen."))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(runtime::ui_lang::tr_static("图片下载地址不能指向本机或内部网络。", "The image download address must not point to this machine or an internal network.", "La dirección de descarga de la imagen no puede apuntar a este equipo ni a una red interna.").into());
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| runtime::ui_lang::tr_static("无法创建图片下载连接。", "Could not create the image download connection.", "No se pudo crear la conexión de descarga de la imagen."))?;
    // A CDN receives no gateway authorization header, even on the same origin.
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| runtime::ui_lang::tr_static("下载生成的图片失败。", "Downloading the generated image failed.", "No se pudo descargar la imagen generada."))?;
    if !response.status().is_success() {
        return Err(runtime::ui_lang::tr_static("生成图片的下载地址不可用。", "The generated image's download address is unavailable.", "La dirección de descarga de la imagen generada no está disponible.").into());
    }
    read_bounded(response, MAX_IMAGE_BYTES).await
}

#[cfg(test)]
#[path = "tests/image.rs"]
mod tests;
