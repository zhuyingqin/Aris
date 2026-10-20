use tauri::ipc::InvokeBody;
use tauri_plugin_clipboard_manager::ClipboardExt;

fn decode_image(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    tauri::image::Image::from_bytes(bytes)
        .map_err(|error| format!("could not read the clipboard image: {error}"))
}

pub(crate) fn write_image_bytes(app: &tauri::AppHandle, bytes: &[u8]) -> Result<(), String> {
    let image = decode_image(bytes)?;
    app.clipboard()
        .write_image(&image)
        .map_err(|error| format!("could not write to the clipboard: {error}"))
}

/// The frontend supplies PNG bytes, without base64 or JSON array expansion.
#[tauri::command]
pub fn clipboard_write_image(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("clipboard image must be sent as binary PNG bytes".into());
    };
    write_image_bytes(&app, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use xcap::image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    #[test]
    fn clipboard_image_preserves_original_size_and_alpha() {
        let mut source = RgbaImage::from_pixel(3, 2, Rgba([12, 34, 56, 255]));
        source.put_pixel(1, 0, Rgba([78, 90, 123, 64]));
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(source.clone())
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let image = decode_image(bytes.get_ref()).unwrap();
        assert_eq!((image.width(), image.height()), (3, 2));
        assert_eq!(image.rgba(), source.as_raw());
    }

    #[test]
    fn invalid_image_is_rejected_before_writing_to_clipboard() {
        assert!(decode_image(b"not an image").is_err());
    }
}
