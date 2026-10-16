//! Local OOXML edits that preserve the rest of the original package byte-for-byte.
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Cursor, Read, Write},
    ops::Range,
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MATH: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MAX_PACKAGE: usize = 64 * 1024 * 1024;
const MAX_XML: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxParagraph {
    pub id: String,
    pub part: String,
    pub text: String,
    pub editable_segments: Vec<String>,
    pub native_equation_count: usize,
    pub style: Option<String>,
    pub read_only_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxReadOutput {
    pub file_path: String,
    pub revision: String,
    pub paragraphs: Vec<DocxParagraph>,
    pub total_paragraphs: usize,
    pub next_offset: Option<usize>,
    pub native_equation_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxTextEdit {
    pub paragraph_id: String,
    pub old_string: String,
    pub new_string: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxEditOutput {
    pub file_path: String,
    pub revision: String,
    pub applied_edits: usize,
    pub preserved_native_equations: usize,
    pub change_id: Option<String>,
}

#[derive(Clone)]
struct TextSpan {
    range: Range<usize>,
    text: String,
}
struct Paragraph {
    snapshot: DocxParagraph,
    groups: Vec<Vec<TextSpan>>,
}

fn error(reason: &str, detail: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("docx_error:{reason} {detail}"),
    )
}

fn read_bytes(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_PACKAGE as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PACKAGE {
        return Err(error("size_limit", "DOCX exceeds 64 MiB"));
    }
    Ok(bytes)
}

fn archive(bytes: &[u8]) -> io::Result<ZipArchive<Cursor<&[u8]>>> {
    if bytes.len() > MAX_PACKAGE {
        return Err(error("size_limit", "DOCX exceeds 64 MiB"));
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|e| {
        error(
            "invalid_package",
            format!("{e}; legacy .doc or encrypted files must first be converted to .docx"),
        )
    })?;
    if zip.len() > 5_000 {
        return Err(error("size_limit", "too many package entries"));
    }
    let mut total = 0_u64;
    let mut seen = HashSet::new();
    for index in 0..zip.len() {
        let file = zip
            .by_index(index)
            .map_err(|e| error("invalid_package", e))?;
        if !seen.insert(file.name().to_string()) {
            return Err(error("duplicate_part", file.name()));
        }
        total = total.saturating_add(file.size());
        if total > 256 * 1024 * 1024 {
            return Err(error("size_limit", "expanded package exceeds 256 MiB"));
        }
    }
    if zip.by_name("[Content_Types].xml").is_err() || zip.by_name("word/document.xml").is_err() {
        return Err(error(
            "invalid_package",
            "missing DOCX content types or main document",
        ));
    }
    Ok(zip)
}

fn story_parts(zip: &ZipArchive<Cursor<&[u8]>>) -> Vec<String> {
    let mut parts = zip
        .file_names()
        .filter(|name| {
            *name == "word/document.xml"
                || *name == "word/footnotes.xml"
                || *name == "word/endnotes.xml"
                || (name.starts_with("word/header") || name.starts_with("word/footer"))
                    && name.ends_with(".xml")
                    && !name[5..].contains('/')
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    parts.sort();
    parts
}

fn xml_part(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> io::Result<String> {
    let mut file = zip.by_name(name).map_err(|e| error("missing_part", e))?;
    if file.size() > MAX_XML as u64 {
        return Err(error("size_limit", name));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_XML as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_XML {
        return Err(error("size_limit", name));
    }
    String::from_utf8(bytes).map_err(|e| error("invalid_xml_encoding", e))
}

fn is(node: Node<'_, '_>, namespace: &str, tag: &str) -> bool {
    node.is_element()
        && node.tag_name().namespace() == Some(namespace)
        && node.tag_name().name() == tag
}

fn paragraphs(xml: &str, part: &str) -> io::Result<Vec<Paragraph>> {
    let doc = Document::parse(xml).map_err(|e| error("invalid_xml", e))?;
    if doc.root_element().tag_name().namespace() != Some(WORD) {
        return Err(error(
            "unsupported_namespace",
            "only transitional WordprocessingML is currently supported",
        ));
    }
    let mut output = Vec::new();
    for (index, paragraph) in doc.descendants().filter(|n| is(*n, WORD, "p")).enumerate() {
        let own =
            |n: Node<'_, '_>| n.ancestors().skip(1).find(|a| is(*a, WORD, "p")) == Some(paragraph);
        let nodes = paragraph
            .descendants()
            .filter(|n| n.is_element() && own(*n))
            .collect::<Vec<_>>();
        let restricted = nodes.iter().any(|n| {
            n.tag_name().namespace() == Some(WORD)
                && matches!(
                    n.tag_name().name(),
                    "ins"
                        | "del"
                        | "moveFrom"
                        | "moveTo"
                        | "fldChar"
                        | "instrText"
                        | "fldSimple"
                        | "sdt"
                )
        }) || paragraph.ancestors().any(|n| {
            n.tag_name().namespace() == Some(WORD)
                && matches!(
                    n.tag_name().name(),
                    "sdt" | "ins" | "del" | "moveFrom" | "moveTo"
                )
        }) || paragraph
            .ancestors()
            .chain(paragraph.descendants())
            .any(|n| {
                n.tag_name().namespace()
                    == Some("http://schemas.openxmlformats.org/markup-compatibility/2006")
                    && n.tag_name().name() == "AlternateContent"
            });
        let mut groups: Vec<Vec<TextSpan>> = Vec::new();
        let mut active = Vec::new();
        let mut hyperlink = None;
        let mut text = String::new();
        let mut equations = 0;
        for node in nodes {
            if is(node, MATH, "oMath") {
                if !active.is_empty() {
                    groups.push(std::mem::take(&mut active));
                }
                equations += 1;
                text.push_str(&format!("[native equation {equations}]"));
            } else if is(node, WORD, "t") && !node.ancestors().any(|n| is(n, MATH, "oMath")) {
                let scope = node
                    .ancestors()
                    .find(|n| is(*n, WORD, "hyperlink"))
                    .map(|n| n.range().start);
                if scope != hyperlink && !active.is_empty() {
                    groups.push(std::mem::take(&mut active));
                }
                hyperlink = scope;
                let value = node.text().unwrap_or_default().to_string();
                text.push_str(&value);
                if !value.is_empty() {
                    active.push(TextSpan {
                        range: node.range(),
                        text: value,
                    });
                }
            } else if node.tag_name().namespace() == Some(WORD)
                && matches!(
                    node.tag_name().name(),
                    "tab"
                        | "br"
                        | "cr"
                        | "drawing"
                        | "pict"
                        | "object"
                        | "sym"
                        | "noBreakHyphen"
                        | "softHyphen"
                        | "commentReference"
                        | "bookmarkStart"
                        | "bookmarkEnd"
                        | "footnoteReference"
                        | "endnoteReference"
                        | "commentRangeStart"
                        | "commentRangeEnd"
                )
            {
                if !active.is_empty() {
                    groups.push(std::mem::take(&mut active));
                }
                if is(node, WORD, "tab") {
                    text.push('\t');
                }
                if is(node, WORD, "br") || is(node, WORD, "cr") {
                    text.push('\n');
                }
            }
        }
        if !active.is_empty() {
            groups.push(active);
        }
        let editable_segments = groups
            .iter()
            .map(|g| g.iter().map(|s| s.text.as_str()).collect())
            .collect();
        let style = paragraph
            .descendants()
            .find(|n| is(*n, WORD, "pStyle") && own(*n))
            .and_then(|n| n.attribute((WORD, "val")))
            .map(str::to_string);
        output.push(Paragraph {
            snapshot: DocxParagraph {
                id: format!("{part}:p{}", index + 1), part: part.to_string(), text, editable_segments,
                native_equation_count: equations, style,
                read_only_reason: restricted.then(|| "Tracked changes, fields, managed controls or alternate representations require a specialised edit".to_string()),
            },
            groups,
        });
    }
    Ok(output)
}

pub fn read_docx(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> io::Result<DocxReadOutput> {
    let path = crate::file_ops::normalize_read_path(path)?;
    let bytes = read_bytes(&path)?;
    let mut zip = archive(&bytes)?;
    let mut snapshots = Vec::new();
    for part in story_parts(&zip) {
        snapshots.extend(
            paragraphs(&xml_part(&mut zip, &part)?, &part)?
                .into_iter()
                .map(|p| p.snapshot),
        );
    }
    let total = snapshots.len();
    let equation_count = snapshots.iter().map(|p| p.native_equation_count).sum();
    let start = offset.unwrap_or(0).min(total);
    let end = start
        .saturating_add(limit.unwrap_or(40).clamp(1, 100))
        .min(total);
    Ok(DocxReadOutput {
        file_path: path.to_string_lossy().to_string(), revision: crate::file_ops::content_revision(&bytes),
        paragraphs: snapshots.drain(start..end).collect(), total_paragraphs: total,
        next_offset: (end < total).then_some(end), native_equation_count: equation_count,
        warnings: vec!["Text preview preserves native equation boundaries; it does not verify page layout or mathematical correctness. Edits preserve equations and the first matched text run's formatting.".to_string()],
    })
}

pub(crate) fn review_text(bytes: &[u8]) -> io::Result<String> {
    let mut zip = archive(bytes)?;
    let mut text =
        String::from("[DOCX text preview; native equations and layout are not rendered]\n");
    for part in story_parts(&zip) {
        for paragraph in paragraphs(&xml_part(&mut zip, &part)?, &part)? {
            text.push_str(&format!(
                "{}: {}\n",
                paragraph.snapshot.id, paragraph.snapshot.text
            ));
        }
    }
    Ok(text)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn replace_text_element(xml: &str, span: &TextSpan, text: &str) -> io::Result<String> {
    let original = &xml[span.range.clone()];
    let opening_end = original
        .find('>')
        .ok_or_else(|| error("invalid_xml", "missing text opening tag"))?;
    let closing_start = original
        .rfind("</")
        .ok_or_else(|| error("invalid_xml", "missing text closing tag"))?;
    let mut opening = original[..opening_end].to_string();
    // Replacing the element's inner text, rather than decoded byte offsets,
    // preserves entities, namespaces, attributes and run formatting.
    let space_attribute =
        regex::Regex::new(r#"xml:space\s*=\s*["'][^"']*["']"#).expect("constant regex");
    if space_attribute.is_match(&opening) {
        opening = space_attribute
            .replace(&opening, "xml:space=\"preserve\"")
            .into_owned();
    } else {
        opening.push_str(" xml:space=\"preserve\"");
    }
    Ok(format!(
        "{opening}>{}{}",
        escape(text),
        &original[closing_start..]
    ))
}

fn apply_text_edit(xml: &str, part: &str, edit: &DocxTextEdit) -> io::Result<String> {
    if edit.old_string.is_empty()
        || edit.old_string == edit.new_string
        || edit.new_string.contains(['\n', '\r', '\t'])
        || edit
            .new_string
            .chars()
            .any(|c| c < ' ' || c == '\u{fffe}' || c == '\u{ffff}')
        || edit.new_string.matches('\u{fffd}').count() > edit.old_string.matches('\u{fffd}').count()
    {
        return Err(error(
            "invalid_edit",
            "use nonempty exact old text and valid single-line replacement text",
        ));
    }
    let paragraph = paragraphs(xml, part)?
        .into_iter()
        .find(|p| p.snapshot.id == edit.paragraph_id)
        .ok_or_else(|| {
            error(
                "paragraph_not_found",
                "read_docx again and copy the paragraph id",
            )
        })?;
    if let Some(reason) = paragraph.snapshot.read_only_reason {
        return Err(error("protected_paragraph", reason));
    }
    let mut matches = Vec::new();
    for (index, group) in paragraph.groups.iter().enumerate() {
        let joined = group.iter().map(|s| s.text.as_str()).collect::<String>();
        let mut cursor = 0;
        while let Some(found) = joined[cursor..].find(&edit.old_string) {
            let start = cursor + found;
            matches.push((index, start));
            if matches.len() > 1 {
                break;
            }
            // Count overlapping occurrences too, advancing at a UTF-8 boundary.
            cursor = start
                + joined[start..]
                    .chars()
                    .next()
                    .expect("nonempty match")
                    .len_utf8();
        }
        if matches.len() > 1 {
            break;
        }
    }
    if matches.len() != 1 {
        return Err(error("text_match", format!("found {} matches; use a unique editable segment, without crossing equation, field, bookmark or object boundaries", matches.len())));
    }
    let (group_index, start) = matches[0];
    let end = start + edit.old_string.len();
    let mut position = 0;
    let mut replacements = Vec::new();
    let mut inserted = false;
    for span in &paragraph.groups[group_index] {
        let span_start = position;
        let span_end = position + span.text.len();
        position = span_end;
        if span_end <= start || span_start >= end {
            continue;
        }
        let from = start.saturating_sub(span_start);
        let to = (end - span_start).min(span.text.len());
        let mut value = span.text[..from].to_string();
        if !inserted {
            value.push_str(&edit.new_string);
            inserted = true;
        }
        value.push_str(&span.text[to..]);
        replacements.push((span.range.clone(), replace_text_element(xml, span, &value)?));
    }
    let mut updated = xml.to_string();
    for (range, value) in replacements.into_iter().rev() {
        updated.replace_range(range, &value);
    }
    Document::parse(&updated).map_err(|e| error("invalid_result", e))?;
    Ok(updated)
}

pub fn edit_docx(
    path: &str,
    expected_revision: &str,
    edits: &[DocxTextEdit],
    context: &crate::FileMutationContext,
) -> io::Result<DocxEditOutput> {
    if edits.is_empty() || edits.len() > 64 {
        return Err(error("edit_limit", "supply 1-64 edits"));
    }
    let payload_bytes = edits.iter().fold(0_usize, |total, edit| {
        total
            .saturating_add(edit.paragraph_id.len())
            .saturating_add(edit.old_string.len())
            .saturating_add(edit.new_string.len())
    });
    if payload_bytes > crate::MAX_FILE_TOOL_PAYLOAD_BYTES {
        return Err(error("size_limit", "edit payload exceeds 8 MiB"));
    }
    let path = crate::file_ops::normalize_path(path)?;
    let (original, updated, equations, diff) = crate::atomic_file::with_path_lock(&path, || {
        let original = read_bytes(&path)?;
        let revision = crate::file_ops::content_revision(&original);
        if expected_revision != revision {
            return Err(error(
                "revision_conflict",
                "file changed; read_docx again before editing",
            ));
        }
        let mut zip = archive(&original)?;
        if zip.file_names().any(|n| n.starts_with("_xmlsignatures/")) {
            return Err(error(
                "signed_document",
                "editing would invalidate a digital signature",
            ));
        }
        let mut parts = BTreeMap::new();
        let mut equations = 0;
        for part in story_parts(&zip) {
            let xml = xml_part(&mut zip, &part)?;
            equations += paragraphs(&xml, &part)?
                .iter()
                .map(|p| p.snapshot.native_equation_count)
                .sum::<usize>();
            parts.insert(part, xml);
        }
        let mut changed = HashSet::new();
        let mut diff = String::new();
        for edit in edits {
            let part = parts
                .keys()
                .find(|part| edit.paragraph_id.starts_with(&format!("{part}:p")))
                .cloned()
                .ok_or_else(|| error("paragraph_not_found", "unknown story part"))?;
            let xml = parts.get(&part).expect("known part");
            let updated = apply_text_edit(xml, &part, edit)?;
            if updated.len() > MAX_XML {
                return Err(error("size_limit", "edited story exceeds 16 MiB"));
            }
            parts.insert(part.clone(), updated);
            changed.insert(part);
            diff.push_str(&format!(
                "{}\n-{}\n+{}\n",
                edit.paragraph_id, edit.old_string, edit.new_string
            ));
        }
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.set_raw_comment(zip.comment().into());
        for index in 0..zip.len() {
            let file = zip
                .by_index(index)
                .map_err(|e| error("invalid_package", e))?;
            let name = file.name().to_string();
            if changed.contains(&name) {
                let options = SimpleFileOptions::default()
                    .compression_method(file.compression())
                    .last_modified_time(file.last_modified().unwrap_or_default())
                    .unix_permissions(file.unix_mode().unwrap_or(0o644));
                writer
                    .start_file(&name, options)
                    .map_err(|e| error("write_package", e))?;
                writer.write_all(parts[&name].as_bytes())?;
            } else {
                writer
                    .raw_copy_file(file)
                    .map_err(|e| error("write_package", e))?;
            }
        }
        let updated = writer
            .finish()
            .map_err(|e| error("write_package", e))?
            .into_inner();
        archive(&updated)?;
        // An external editor may not participate in the process-local path lock.
        if read_bytes(&path)? != original {
            return Err(error(
                "revision_conflict",
                "file changed while preparing the edit",
            ));
        }
        crate::atomic_file::write_replace_unlocked(&path, &updated)?;
        drop(zip);
        Ok::<_, io::Error>((original, updated, equations, diff))
    })?;
    // Ledger/blob writes take their own striped locks. Do not nest them under
    // the document lock: distinct paths may share a stripe or form a cycle.
    let record = crate::change_ledger::record_binary_file_change(
        context, &path, &original, &updated, diff, None,
    )
    .map_err(|error| {
        crate::change_ledger::binary_audit_rollback_error(&path, &updated, &original, error)
    })?;
    Ok(DocxEditOutput {
        file_path: path.to_string_lossy().to_string(),
        revision: crate::file_ops::content_revision(&updated),
        applied_edits: edits.len(),
        preserved_native_equations: equations,
        change_id: record.map(|r| r.change_id),
    })
}

#[cfg(test)]
#[path = "tests/docx.rs"]
mod tests;
