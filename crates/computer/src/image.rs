//! Window screenshots after capture: crop, scale down, PNG, base64.
//!
//! Pure and platform-independent so it can be tested anywhere; the Windows
//! backend only produces the top-down BGRA pixels.

/// Top-down 32-bit BGRA pixels, as GDI hands them over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bgra {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// A part of the window in thousandths of its width and height, so a model
/// can zoom without knowing the window's pixel size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Bgra {
    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let at = ((y as usize) * (self.width as usize) + x as usize) * 4;
        [
            self.pixels[at],
            self.pixels[at + 1],
            self.pixels[at + 2],
            self.pixels[at + 3],
        ]
    }
}

/// The pixels inside `region` (clamped to the image; at least 1×1).
#[must_use]
pub fn crop_permille(image: &Bgra, region: Region) -> Bgra {
    let scale = |value: u32, size: u32| -> u32 {
        u32::try_from(u64::from(value.min(1000)) * u64::from(size) / 1000).unwrap_or(size)
    };
    let left = scale(region.x, image.width).min(image.width.saturating_sub(1));
    let top = scale(region.y, image.height).min(image.height.saturating_sub(1));
    let width = scale(region.width, image.width).clamp(1, image.width - left);
    let height = scale(region.height, image.height).clamp(1, image.height - top);
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in top..top + height {
        let start = ((y * image.width + left) * 4) as usize;
        pixels.extend_from_slice(&image.pixels[start..start + (width * 4) as usize]);
    }
    Bgra {
        width,
        height,
        pixels,
    }
}

/// Scale down (never up) so the longer edge is at most `max_long_edge`, by
/// averaging the source pixels each output pixel covers. Returns the image
/// and the factor applied (1.0 when unchanged).
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
pub fn fit_long_edge(image: &Bgra, max_long_edge: u32) -> (Bgra, f64) {
    let long = image.width.max(image.height);
    if max_long_edge == 0 || long <= max_long_edge {
        return (image.clone(), 1.0);
    }
    let scale = f64::from(max_long_edge) / f64::from(long);
    let width = ((f64::from(image.width) * scale).round() as u32).max(1);
    let height = ((f64::from(image.height) * scale).round() as u32).max(1);
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let y0 = (u64::from(y) * u64::from(image.height) / u64::from(height)) as u32;
        let y1 = ((u64::from(y + 1) * u64::from(image.height) / u64::from(height)) as u32)
            .max(y0 + 1)
            .min(image.height);
        for x in 0..width {
            let x0 = (u64::from(x) * u64::from(image.width) / u64::from(width)) as u32;
            let x1 = ((u64::from(x + 1) * u64::from(image.width) / u64::from(width)) as u32)
                .max(x0 + 1)
                .min(image.width);
            let mut sum = [0u64; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let pixel = image.pixel(sx, sy);
                    for channel in 0..4 {
                        sum[channel] += u64::from(pixel[channel]);
                    }
                }
            }
            let count = u64::from((y1 - y0) * (x1 - x0));
            for channel in sum {
                pixels.push((channel / count) as u8);
            }
        }
    }
    (
        Bgra {
            width,
            height,
            pixels,
        },
        f64::from(width) / f64::from(image.width),
    )
}

/// Drops the columns at the right and rows at the bottom that the window never
/// painted (every byte still zero). A DPI-unaware window on a scaled monitor
/// renders at 96 DPI into a bitmap sized for its scaled frame, leaving such a
/// margin. Only the right and bottom edges, and only exact zeros (alpha
/// included), so dark but painted content stays.
#[must_use]
pub fn trim_unrendered(image: &Bgra) -> Bgra {
    let row_bytes = (image.width * 4) as usize;
    let column_is_blank = |x: u32, rows: u32| {
        (0..rows).all(|y| {
            let at = (y as usize) * row_bytes + (x as usize) * 4;
            image.pixels[at..at + 4] == [0, 0, 0, 0]
        })
    };
    let mut height = image.height;
    while height > 1
        && image.pixels[((height - 1) as usize) * row_bytes..(height as usize) * row_bytes]
            .iter()
            .all(|byte| *byte == 0)
    {
        height -= 1;
    }
    let mut width = image.width;
    while width > 1 && column_is_blank(width - 1, height) {
        width -= 1;
    }
    if width == image.width && height == image.height {
        return image.clone();
    }
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let start = (y as usize) * row_bytes;
        pixels.extend_from_slice(&image.pixels[start..start + (width * 4) as usize]);
    }
    Bgra {
        width,
        height,
        pixels,
    }
}

/// True when every pixel has the same colour: what a window that rendered
/// nothing (minimized, protected content, a failed capture) looks like.
#[must_use]
pub fn is_blank(image: &Bgra) -> bool {
    let Some(first) = image.pixels.get(0..3) else {
        return true;
    };
    image.pixels.chunks_exact(4).all(|pixel| &pixel[0..3] == first)
}

/// Opaque RGB PNG. Alpha is dropped: windows captured with `PrintWindow`
/// often report alpha 0 for opaque content.
pub fn to_png(image: &Bgra) -> Result<Vec<u8>, String> {
    let mut rgb = Vec::with_capacity((image.width * image.height * 3) as usize);
    for pixel in image.pixels.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&rgb)
            .map_err(|error| error.to_string())?;
    }
    Ok(out)
}

/// Standard base64 with padding.
#[must_use]
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(TABLE[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "tests/image.rs"]
mod tests;
