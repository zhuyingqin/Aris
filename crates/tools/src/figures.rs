//! SVG safety, editability classification and local PNG/PDF exports.
use base64::Engine;
use resvg::{tiny_skia, usvg};
use runtime::figures::{hash, FigureVersion, MAX_SVG_BYTES};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};

pub const RENDERER: &str = "resvg-0.45.1/svg2pdf-0.13.0";
pub fn render_signature_matches(version: &FigureVersion) -> bool {
    version.renderer == RENDERER && version.font_fingerprint == fonts().1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgInspection {
    pub classification: String,
    pub text_count: usize,
    pub vector_count: usize,
    pub image_count: usize,
}

pub fn extract_svg(text: &str) -> Result<String, String> {
    let begin = text.find("<svg").ok_or("Model response contains no SVG")?;
    let end = text
        .rfind("</svg>")
        .ok_or("incomplete_unknown: SVG closing tag is missing")?
        + 6;
    if end <= begin {
        return Err("incomplete_unknown: invalid SVG boundaries".into());
    }
    let svg = text[begin..end].to_string();
    inspect(&svg)?;
    Ok(svg)
}

pub fn inspect(svg: &str) -> Result<SvgInspection, String> {
    if svg.len() > MAX_SVG_BYTES {
        return Err("SVG exceeds 2 MiB".into());
    }
    let lower = svg.to_ascii_lowercase();
    if lower.contains("<!doctype")
        || lower.contains("<!entity")
        || lower.contains("<?xml-stylesheet")
    {
        return Err("SVG document types, entities and external stylesheets are prohibited".into());
    }
    let document = roxmltree::Document::parse(svg).map_err(|e| format!("Invalid SVG XML: {e}"))?;
    let root = document.root_element();
    if root.tag_name().name() != "svg"
        || root.tag_name().namespace() != Some("http://www.w3.org/2000/svg")
    {
        return Err("Expected an SVG document with the SVG namespace".into());
    }
    let allowed = [
        "svg",
        "g",
        "defs",
        "title",
        "desc",
        "metadata",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "textPath",
        "marker",
        "clipPath",
        "mask",
        "linearGradient",
        "radialGradient",
        "stop",
        "pattern",
        "image",
        "use",
    ];
    let mut result = SvgInspection {
        classification: String::new(),
        text_count: 0,
        vector_count: 0,
        image_count: 0,
    };
    let mut elements = 0;
    for node in document.descendants().filter(|n| n.is_element()) {
        elements += 1;
        if elements > 10_000 {
            return Err("SVG element limit exceeded".into());
        }
        let name = node.tag_name().name();
        if node.tag_name().namespace() != Some("http://www.w3.org/2000/svg")
            || !allowed.contains(&name)
        {
            return Err(format!("SVG element {name} is not allowed"));
        }
        if name == "text" {
            result.text_count += 1;
        }
        if [
            "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
        ]
        .contains(&name)
            && !node.ancestors().any(|n| {
                n.is_element()
                    && ["defs", "marker", "clipPath", "mask", "pattern"]
                        .contains(&n.tag_name().name())
            })
        {
            result.vector_count += 1;
        }
        if name == "image" {
            result.image_count += 1;
        }
        for attr in node.attributes() {
            let key = attr.name().to_ascii_lowercase();
            let value = attr.value().trim();
            let v = value.to_ascii_lowercase();
            if key.starts_with("on")
                || key == "base"
                || key == "src"
                || (key == "class" && value != "layer")
                || attr.namespace().is_some_and(|ns| {
                    ns != "http://www.w3.org/1999/xlink"
                        && ns != "http://www.w3.org/XML/1998/namespace"
                })
            {
                return Err(format!("SVG attribute {} is not allowed", attr.name()));
            }
            if key == "href" {
                let internal = value.starts_with('#') && value.len() > 1;
                let embedded = name == "image"
                    && [
                        "data:image/png;base64,",
                        "data:image/jpeg;base64,",
                        "data:image/webp;base64,",
                    ]
                    .iter()
                    .any(|prefix| v.starts_with(prefix));
                if !internal && !embedded {
                    return Err(
                        "Only local SVG references and embedded raster images are allowed".into(),
                    );
                }
                if embedded {
                    let encoded = value.split_once(',').ok_or("Invalid embedded image")?.1;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|_| "Invalid embedded image encoding")?;
                    let image = api::validate_image_bytes(bytes)?;
                    if !v.starts_with(&format!("data:{};base64,", image.mime_type)) {
                        return Err("Embedded image MIME does not match its pixels".into());
                    }
                    if image.width > 4096 || image.height > 4096 {
                        return Err("Embedded image is too large".into());
                    }
                }
            }
            if v.contains("javascript:")
                || v.contains("expression(")
                || v.contains('@')
                || v.contains('\\')
                || v.contains("/*")
            {
                return Err("SVG contains an unsafe CSS value".into());
            }
            let mut remainder = v.as_str();
            while let Some(start) = remainder.find("url(") {
                let tail = &remainder[start + 4..];
                let close = tail.find(')').ok_or("Unclosed SVG url reference")?;
                let target = tail[..close].trim().trim_matches(['\'', '"']);
                if !target.starts_with('#') || target.len() < 2 {
                    return Err("SVG external resource is prohibited".into());
                }
                remainder = &tail[close + 1..];
            }
            if key == "style"
                && (v.contains("font-face") || v.contains("behavior") || v.contains("-moz-binding"))
            {
                return Err("Unsafe SVG style".into());
            }
        }
    }
    result.classification = if result.image_count > 0 && result.vector_count == 0 {
        "raster_preview"
    } else if result.image_count > 0 {
        "hybrid"
    } else {
        "editable_vector"
    }
    .into();
    Ok(result)
}

fn fonts() -> &'static (Arc<usvg::fontdb::Database>, String) {
    static FONTS: OnceLock<(Arc<usvg::fontdb::Database>, String)> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        db.set_sans_serif_family(if cfg!(target_os = "windows") {
            "Microsoft YaHei"
        } else {
            "Noto Sans CJK SC"
        });
        let mut entries = db
            .faces()
            .map(|face| {
                format!(
                    "{:?}:{:?}:{:?}:{}",
                    face.families,
                    face.style,
                    face.weight,
                    db.with_face_data(face.id, |bytes, index| format!("{}:{index}", hash(bytes)))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        entries.sort();
        let fingerprint = hash(entries.join("\n").as_bytes());
        (Arc::new(db), fingerprint)
    })
}

pub struct RenderedFigure {
    pub png: Vec<u8>,
    pub pdf: Vec<u8>,
    pub inspection: SvgInspection,
    pub font_fingerprint: String,
}

pub fn render(svg: &str) -> Result<RenderedFigure, String> {
    let inspection = inspect(svg)?;
    let (fontdb, font_fingerprint) = fonts();
    let options = usvg::Options {
        fontdb: fontdb.clone(),
        font_family: "sans-serif".into(),
        ..usvg::Options::default()
    };
    let tree =
        usvg::Tree::from_str(svg, &options).map_err(|e| format!("Cannot render SVG: {e}"))?;
    let size = tree.size();
    if size.width() > 4096.0 || size.height() > 4096.0 {
        return Err("SVG canvas must be at most 4096 × 4096".into());
    }
    let mut pixmap =
        tiny_skia::Pixmap::new(size.width().ceil() as u32, size.height().ceil() as u32)
            .ok_or("Invalid SVG canvas size")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    let png = pixmap.encode_png().map_err(|e| e.to_string())?;
    let pdf = svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    )
    .map_err(|e| format!("Cannot export PDF: {e}"))?;
    Ok(RenderedFigure {
        png,
        pdf,
        inspection,
        font_fingerprint: font_fingerprint.clone(),
    })
}

impl RenderedFigure {
    pub fn version(&self, author: &str) -> FigureVersion {
        FigureVersion {
            index: 0,
            hash: String::new(),
            svg_path: String::new(),
            png_path: String::new(),
            png_hash: String::new(),
            pdf_path: String::new(),
            author: author.into(),
            classification: self.inspection.classification.clone(),
            text_count: self.inspection.text_count,
            vector_count: self.inspection.vector_count,
            review_status: "visual_pending".into(),
            renderer: RENDERER.into(),
            font_fingerprint: self.font_fingerprint.clone(),
            created_at: runtime::now_iso8601(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const GOOD: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140"><defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker><clipPath id="c"><rect width="360" height="140"/></clipPath></defs><g clip-path="url(#c)"><rect x="10" y="10" width="100" height="70" fill="#ddeeff"/><text x="15" y="45" font-size="18">方法 A</text><path d="M110 45H230" stroke="black" marker-end="url(#a)"/></g></svg>"##;
    #[test]
    fn rejects_active_content_and_external_resources() {
        for content in [
            "<script>alert(1)</script>",
            "<foreignObject/>",
            "<image href='https://example.com/a.png'/>",
            "<rect onload='alert(1)'/>",
            "<rect style='fill:url(https://example.com)'/>",
            "<use href='data:image/svg+xml;base64,AA=='/>",
        ] {
            assert!(
                inspect(&format!(
                    "<svg xmlns='http://www.w3.org/2000/svg'>{content}</svg>"
                ))
                .is_err(),
                "{content}"
            );
        }
        assert!(inspect("<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///secret'>]><svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
    }
    #[test]
    fn preserves_arrows_clipping_editable_text_and_exports() {
        let output = render(GOOD).unwrap();
        assert_eq!(output.inspection.classification, "editable_vector");
        assert_eq!(output.inspection.text_count, 1);
        assert_eq!(output.inspection.vector_count, 2);
        assert!(output.png.starts_with(b"\x89PNG"));
        assert!(output.pdf.starts_with(b"%PDF"));
        assert!(!output.font_fingerprint.is_empty());
        let mut version = output.version("test");
        assert!(render_signature_matches(&version));
        version.font_fingerprint = "previous-font-set".into();
        assert!(!render_signature_matches(&version));
        assert_eq!(
            extract_svg(&format!("```svg\n{GOOD}\n```")),
            Ok(GOOD.into())
        );
    }
    #[test]
    fn a_whole_raster_is_not_classified_as_editable() {
        let mut pixel = tiny_skia::Pixmap::new(1, 1).unwrap();
        pixel.fill(tiny_skia::Color::WHITE);
        let data = base64::engine::general_purpose::STANDARD.encode(pixel.encode_png().unwrap());
        assert_eq!(inspect(&format!("<svg xmlns='http://www.w3.org/2000/svg'><image href='data:image/png;base64,{data}'/></svg>")).unwrap().classification, "raster_preview");
    }
}
