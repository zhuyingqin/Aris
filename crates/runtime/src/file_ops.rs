use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use flate2::read::{DeflateDecoder, ZlibDecoder};
use glob::Pattern;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextFilePayload {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub content: String,
    #[serde(rename = "numLines")]
    pub num_lines: usize,
    #[serde(rename = "startLine")]
    pub start_line: usize,
    #[serde(rename = "totalLines")]
    pub total_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadFileOutput {
    #[serde(rename = "type")]
    pub kind: String,
    pub file: TextFilePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StructuredPatchHunk {
    #[serde(rename = "oldStart")]
    pub old_start: usize,
    #[serde(rename = "oldLines")]
    pub old_lines: usize,
    #[serde(rename = "newStart")]
    pub new_start: usize,
    #[serde(rename = "newLines")]
    pub new_lines: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WriteFileOutput {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub content: String,
    #[serde(rename = "structuredPatch")]
    pub structured_patch: Vec<StructuredPatchHunk>,
    #[serde(rename = "originalFile")]
    pub original_file: Option<String>,
    #[serde(rename = "gitDiff")]
    pub git_diff: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditFileOutput {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "oldString")]
    pub old_string: String,
    #[serde(rename = "newString")]
    pub new_string: String,
    #[serde(rename = "originalFile")]
    pub original_file: String,
    #[serde(rename = "structuredPatch")]
    pub structured_patch: Vec<StructuredPatchHunk>,
    #[serde(rename = "userModified")]
    pub user_modified: bool,
    #[serde(rename = "replaceAll")]
    pub replace_all: bool,
    #[serde(rename = "gitDiff")]
    pub git_diff: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GlobSearchOutput {
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
    #[serde(rename = "numFiles")]
    pub num_files: usize,
    pub filenames: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrepSearchInput {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    #[serde(rename = "output_mode")]
    pub output_mode: Option<String>,
    #[serde(rename = "-B")]
    pub before: Option<usize>,
    #[serde(rename = "-A")]
    pub after: Option<usize>,
    #[serde(rename = "-C")]
    pub context_short: Option<usize>,
    pub context: Option<usize>,
    #[serde(rename = "-n")]
    pub line_numbers: Option<bool>,
    #[serde(rename = "-i")]
    pub case_insensitive: Option<bool>,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    pub head_limit: Option<usize>,
    pub offset: Option<usize>,
    pub multiline: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrepSearchOutput {
    pub mode: Option<String>,
    #[serde(rename = "numFiles")]
    pub num_files: usize,
    pub filenames: Vec<String>,
    pub content: Option<String>,
    #[serde(rename = "numLines")]
    pub num_lines: Option<usize>,
    #[serde(rename = "numMatches")]
    pub num_matches: Option<usize>,
    #[serde(rename = "appliedLimit")]
    pub applied_limit: Option<usize>,
    #[serde(rename = "appliedOffset")]
    pub applied_offset: Option<usize>,
}

pub fn read_file(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> io::Result<ReadFileOutput> {
    let absolute_path = normalize_path(path)?;
    let content = if is_pdf_path(&absolute_path) {
        extract_pdf_text(&absolute_path)?
    } else {
        fs::read_to_string(&absolute_path)?
    };
    Ok(read_text_payload(absolute_path, &content, offset, limit))
}

fn read_text_payload(
    absolute_path: PathBuf,
    content: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> ReadFileOutput {
    let lines: Vec<&str> = content.lines().collect();
    let start_index = offset.unwrap_or(0).min(lines.len());
    let end_index = limit.map_or(lines.len(), |limit| {
        start_index.saturating_add(limit).min(lines.len())
    });
    let selected = lines[start_index..end_index].join("\n");

    ReadFileOutput {
        kind: String::from("text"),
        file: TextFilePayload {
            file_path: absolute_path.to_string_lossy().into_owned(),
            content: selected,
            num_lines: end_index.saturating_sub(start_index),
            start_line: start_index.saturating_add(1),
            total_lines: lines.len(),
        },
    }
}

pub fn write_file(path: &str, content: &str) -> io::Result<WriteFileOutput> {
    let absolute_path = normalize_path_allow_missing(path)?;
    let original_file = fs::read_to_string(&absolute_path).ok();
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&absolute_path, content)?;

    Ok(WriteFileOutput {
        kind: if original_file.is_some() {
            String::from("update")
        } else {
            String::from("create")
        },
        file_path: absolute_path.to_string_lossy().into_owned(),
        content: content.to_owned(),
        structured_patch: make_patch(original_file.as_deref().unwrap_or(""), content),
        original_file,
        git_diff: None,
    })
}

pub fn edit_file(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> io::Result<EditFileOutput> {
    let absolute_path = normalize_path(path)?;
    let original_file = fs::read_to_string(&absolute_path)?;
    if old_string == new_string {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "old_string and new_string must differ",
        ));
    }
    if !original_file.contains(old_string) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "old_string not found in file",
        ));
    }

    let updated = if replace_all {
        original_file.replace(old_string, new_string)
    } else {
        original_file.replacen(old_string, new_string, 1)
    };
    fs::write(&absolute_path, &updated)?;

    Ok(EditFileOutput {
        file_path: absolute_path.to_string_lossy().into_owned(),
        old_string: old_string.to_owned(),
        new_string: new_string.to_owned(),
        original_file: original_file.clone(),
        structured_patch: make_patch(&original_file, &updated),
        user_modified: false,
        replace_all,
        git_diff: None,
    })
}

pub fn glob_search(pattern: &str, path: Option<&str>) -> io::Result<GlobSearchOutput> {
    let started = Instant::now();
    let root = workspace_root()?;
    let base_dir = path
        .map(normalize_path)
        .transpose()?
        .unwrap_or(match root.as_ref() {
            Some(root) => root.clone(),
            None => std::env::current_dir()?,
        });
    let search_path = if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        base_dir.join(pattern)
    };
    if let Some(root) = root.as_ref() {
        ensure_within_workspace(&lexically_normalize(&search_path), root)?;
    }
    let search_pattern = search_path.to_string_lossy().into_owned();

    let mut matches = Vec::new();
    let entries = glob::glob(&search_pattern)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    for entry in entries.flatten() {
        if !entry.is_file() {
            continue;
        }
        if let Some(root) = root.as_ref() {
            let Ok(canonical) = entry.canonicalize() else {
                continue;
            };
            if canonical.starts_with(root) {
                matches.push(canonical);
            }
        } else {
            matches.push(entry);
        }
    }

    matches.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(Reverse)
    });

    let truncated = matches.len() > 100;
    let filenames = matches
        .into_iter()
        .take(100)
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    Ok(GlobSearchOutput {
        duration_ms: started.elapsed().as_millis(),
        num_files: filenames.len(),
        filenames,
        truncated,
    })
}

pub fn grep_search(input: &GrepSearchInput) -> io::Result<GrepSearchOutput> {
    let root = workspace_root()?;
    let base_path = input
        .path
        .as_deref()
        .map(normalize_path)
        .transpose()?
        .unwrap_or(match root.as_ref() {
            Some(root) => root.clone(),
            None => std::env::current_dir()?,
        });

    let regex = RegexBuilder::new(&input.pattern)
        .case_insensitive(input.case_insensitive.unwrap_or(false))
        .dot_matches_new_line(input.multiline.unwrap_or(false))
        .build()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    let glob_filter = input
        .glob
        .as_deref()
        .map(Pattern::new)
        .transpose()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let file_type = input.file_type.as_deref();
    let output_mode = input
        .output_mode
        .clone()
        .unwrap_or_else(|| String::from("files_with_matches"));
    let context = input.context.or(input.context_short).unwrap_or(0);

    let mut filenames = Vec::new();
    let mut content_lines = Vec::new();
    let mut total_matches = 0usize;

    for file_path in collect_search_files(&base_path)? {
        if !matches_optional_filters(&file_path, glob_filter.as_ref(), file_type) {
            continue;
        }

        let Ok(file_contents) = fs::read_to_string(&file_path) else {
            continue;
        };

        if output_mode == "count" {
            let count = regex.find_iter(&file_contents).count();
            if count > 0 {
                filenames.push(file_path.to_string_lossy().into_owned());
                total_matches += count;
            }
            continue;
        }

        let lines: Vec<&str> = file_contents.lines().collect();
        let mut matched_lines = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if regex.is_match(line) {
                total_matches += 1;
                matched_lines.push(index);
            }
        }

        if matched_lines.is_empty() {
            continue;
        }

        filenames.push(file_path.to_string_lossy().into_owned());
        if output_mode == "content" {
            for index in matched_lines {
                let start = index.saturating_sub(input.before.unwrap_or(context));
                let end = (index + input.after.unwrap_or(context) + 1).min(lines.len());
                for (current, line) in lines.iter().enumerate().take(end).skip(start) {
                    let prefix = if input.line_numbers.unwrap_or(true) {
                        format!("{}:{}:", file_path.to_string_lossy(), current + 1)
                    } else {
                        format!("{}:", file_path.to_string_lossy())
                    };
                    content_lines.push(format!("{prefix}{line}"));
                }
            }
        }
    }

    let (filenames, applied_limit, applied_offset) =
        apply_limit(filenames, input.head_limit, input.offset);
    let content_output = if output_mode == "content" {
        let (lines, limit, offset) = apply_limit(content_lines, input.head_limit, input.offset);
        return Ok(GrepSearchOutput {
            mode: Some(output_mode),
            num_files: filenames.len(),
            filenames,
            num_lines: Some(lines.len()),
            content: Some(lines.join("\n")),
            num_matches: None,
            applied_limit: limit,
            applied_offset: offset,
        });
    } else {
        None
    };

    Ok(GrepSearchOutput {
        mode: Some(output_mode.clone()),
        num_files: filenames.len(),
        filenames,
        content: content_output,
        num_lines: None,
        num_matches: (output_mode == "count").then_some(total_matches),
        applied_limit,
        applied_offset,
    })
}

fn collect_search_files(base_path: &Path) -> io::Result<Vec<PathBuf>> {
    if base_path.is_file() {
        return Ok(vec![base_path.to_path_buf()]);
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(base_path) {
        let entry = entry.map_err(|error| io::Error::other(error.to_string()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    Ok(files)
}

fn matches_optional_filters(
    path: &Path,
    glob_filter: Option<&Pattern>,
    file_type: Option<&str>,
) -> bool {
    if let Some(glob_filter) = glob_filter {
        let path_string = path.to_string_lossy();
        if !glob_filter.matches(&path_string) && !glob_filter.matches_path(path) {
            return false;
        }
    }

    if let Some(file_type) = file_type {
        let extension = path.extension().and_then(|extension| extension.to_str());
        if extension != Some(file_type) {
            return false;
        }
    }

    true
}

fn apply_limit<T>(
    items: Vec<T>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> (Vec<T>, Option<usize>, Option<usize>) {
    let offset_value = offset.unwrap_or(0);
    let mut items = items.into_iter().skip(offset_value).collect::<Vec<_>>();
    let explicit_limit = limit.unwrap_or(250);
    if explicit_limit == 0 {
        return (items, None, (offset_value > 0).then_some(offset_value));
    }

    let truncated = items.len() > explicit_limit;
    items.truncate(explicit_limit);
    (
        items,
        truncated.then_some(explicit_limit),
        (offset_value > 0).then_some(offset_value),
    )
}

type PdfUnicodeMap = BTreeMap<Vec<u8>, String>;

#[derive(Debug)]
struct PdfStream<'a> {
    dict: &'a [u8],
    data: &'a [u8],
}

#[derive(Debug)]
struct DecodedPdfStream<'a> {
    dict: &'a [u8],
    data: Vec<u8>,
}

#[derive(Debug, Clone)]
enum PdfToken {
    String(Vec<u8>),
    Array(Vec<PdfToken>),
    Number(f32),
    Word(String),
}

fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn extract_pdf_text(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    if !bytes.starts_with(b"%PDF") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("`{}` is not a PDF file", path.display()),
        ));
    }

    let mut decoded_streams = Vec::new();
    for stream in pdf_streams(&bytes) {
        let data = decode_pdf_stream(stream.dict, stream.data);
        if !data.is_empty() {
            decoded_streams.push(DecodedPdfStream {
                dict: stream.dict,
                data,
            });
        }
    }

    let mut unicode_map = PdfUnicodeMap::new();
    for stream in &decoded_streams {
        if looks_like_cmap_stream(&stream.data) {
            parse_to_unicode_cmap(&stream.data, &mut unicode_map);
        }
    }

    let mut extracted = String::new();
    for stream in &decoded_streams {
        if looks_like_cmap_stream(&stream.data) || looks_like_image_stream(stream.dict) {
            continue;
        }
        if !looks_like_page_content_stream(&stream.data) {
            continue;
        }
        let text = extract_pdf_content_text(&stream.data, &unicode_map);
        if !text.trim().is_empty() {
            if !extracted.trim().is_empty() {
                extracted.push_str("\n\n");
            }
            extracted.push_str(&text);
        }
    }

    let normalized = normalize_pdf_text(&extracted);
    if normalized.trim().is_empty() {
        Ok(format!(
            "[PDF text extraction found no readable text in `{}`. The PDF may be scanned/image-only or use an unsupported encoding.]",
            path.display()
        ))
    } else {
        Ok(normalized)
    }
}

fn pdf_streams(bytes: &[u8]) -> Vec<PdfStream<'_>> {
    let mut streams = Vec::new();
    let mut cursor = 0;
    while let Some(relative_stream_pos) = find_subslice(&bytes[cursor..], b"stream") {
        let stream_pos = cursor + relative_stream_pos;
        let stream_data_start = skip_stream_newline(bytes, stream_pos + b"stream".len());
        let Some(relative_end_pos) = find_subslice(&bytes[stream_data_start..], b"endstream")
        else {
            break;
        };
        let stream_data_end = stream_data_start + relative_end_pos;
        if stream_data_end < stream_data_start {
            cursor = stream_pos + b"stream".len();
            continue;
        }

        let dict_start = rfind_subslice(&bytes[..stream_pos], b"<<").unwrap_or(stream_pos);
        streams.push(PdfStream {
            dict: &bytes[dict_start..stream_pos],
            data: &bytes[stream_data_start..stream_data_end],
        });
        cursor = stream_data_end + b"endstream".len();
    }
    streams
}

fn skip_stream_newline(bytes: &[u8], index: usize) -> usize {
    if bytes.get(index) == Some(&b'\r') && bytes.get(index + 1) == Some(&b'\n') {
        index + 2
    } else if matches!(bytes.get(index), Some(b'\n' | b'\r')) {
        index + 1
    } else {
        index
    }
}

fn decode_pdf_stream(dict: &[u8], data: &[u8]) -> Vec<u8> {
    if ascii_contains(dict, b"/FlateDecode") || ascii_contains(dict, b"/Fl") {
        if let Some(decoded) = inflate_pdf_stream(data) {
            return decoded;
        }
    }
    trim_pdf_stream_data(data).to_vec()
}

fn inflate_pdf_stream(data: &[u8]) -> Option<Vec<u8>> {
    for candidate in [data, trim_pdf_stream_data(data)] {
        if let Some(decoded) = decode_zlib(candidate) {
            return Some(decoded);
        }
        if let Some(decoded) = decode_deflate(candidate) {
            return Some(decoded);
        }
    }
    None
}

fn decode_zlib(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn decode_deflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn trim_pdf_stream_data(data: &[u8]) -> &[u8] {
    let mut end = data.len();
    while end > 0 && matches!(data[end - 1], b'\n' | b'\r' | b'\t' | b' ') {
        end -= 1;
    }
    &data[..end]
}

fn looks_like_cmap_stream(data: &[u8]) -> bool {
    ascii_contains(data, b"begincmap")
        || ascii_contains(data, b"beginbfchar")
        || ascii_contains(data, b"beginbfrange")
}

fn looks_like_image_stream(dict: &[u8]) -> bool {
    ascii_contains(dict, b"/Subtype") && ascii_contains(dict, b"/Image")
}

fn looks_like_page_content_stream(data: &[u8]) -> bool {
    ascii_contains(data, b"BT")
        && (ascii_contains(data, b"Tj")
            || ascii_contains(data, b"TJ")
            || ascii_contains(data, b" T*")
            || ascii_contains(data, b" ET"))
}

fn parse_to_unicode_cmap(data: &[u8], map: &mut PdfUnicodeMap) {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CMapMode {
        BfChar,
        BfRange,
    }

    let text = String::from_utf8_lossy(data);
    let mut mode = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.contains("beginbfchar") {
            mode = Some(CMapMode::BfChar);
            continue;
        }
        if trimmed.contains("beginbfrange") {
            mode = Some(CMapMode::BfRange);
            continue;
        }
        if trimmed.contains("endbfchar") || trimmed.contains("endbfrange") {
            mode = None;
            continue;
        }

        let hex_values = hex_strings_in_line(trimmed);
        match mode {
            Some(CMapMode::BfChar) => {
                for pair in hex_values.chunks(2) {
                    if pair.len() == 2 {
                        let source = hex_to_bytes(&pair[0]);
                        let target = unicode_hex_to_string(&pair[1]);
                        if !source.is_empty() && !target.is_empty() {
                            map.insert(source, target);
                        }
                    }
                }
            }
            Some(CMapMode::BfRange) => parse_cmap_range(trimmed, &hex_values, map),
            None => {}
        }
    }
}

fn parse_cmap_range(line: &str, hex_values: &[String], map: &mut PdfUnicodeMap) {
    if hex_values.len() < 3 {
        return;
    }
    let start = hex_to_bytes(&hex_values[0]);
    let end = hex_to_bytes(&hex_values[1]);
    if start.is_empty() || start.len() != end.len() {
        return;
    }
    let Some(start_value) = big_endian_bytes_to_u32(&start) else {
        return;
    };
    let Some(end_value) = big_endian_bytes_to_u32(&end) else {
        return;
    };
    if end_value < start_value {
        return;
    }

    let span = end_value - start_value;
    if line.contains('[') {
        for (offset, target_hex) in hex_values.iter().skip(2).enumerate() {
            let source_value =
                start_value.saturating_add(u32::try_from(offset).unwrap_or(u32::MAX));
            if source_value > end_value {
                break;
            }
            let source = u32_to_big_endian_bytes(source_value, start.len());
            let target = unicode_hex_to_string(target_hex);
            if !target.is_empty() {
                map.insert(source, target);
            }
        }
        return;
    }

    let target = hex_to_bytes(&hex_values[2]);
    let Some(target_value) = big_endian_bytes_to_u32(&target) else {
        return;
    };
    for offset in 0..=span {
        let source = u32_to_big_endian_bytes(start_value + offset, start.len());
        let target_bytes = u32_to_big_endian_bytes(target_value + offset, target.len());
        let target_text = decode_utf16be_units(&target_bytes);
        if !target_text.is_empty() {
            map.insert(source, target_text);
        }
    }
}

fn extract_pdf_content_text(data: &[u8], unicode_map: &PdfUnicodeMap) -> String {
    let mut index = 0;
    let mut stack = Vec::new();
    let mut output = String::new();

    while let Some(token) = next_pdf_token(data, &mut index) {
        match token {
            PdfToken::Word(word) => {
                if handle_pdf_text_operator(&word, &stack, unicode_map, &mut output) {
                    stack.clear();
                } else if looks_like_pdf_operator(&word) {
                    stack.clear();
                } else {
                    stack.push(PdfToken::Word(word));
                }
            }
            other => {
                stack.push(other);
                if stack.len() > 64 {
                    stack.remove(0);
                }
            }
        }
    }

    normalize_pdf_text(&output)
}

fn handle_pdf_text_operator(
    operator: &str,
    stack: &[PdfToken],
    unicode_map: &PdfUnicodeMap,
    output: &mut String,
) -> bool {
    match operator {
        "BT" => true,
        "ET" | "T*" | "Td" | "TD" => {
            push_pdf_line_break(output);
            true
        }
        "Tj" => {
            if let Some(token) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::String(_)))
            {
                push_pdf_text(output, &decode_pdf_text_token(token, unicode_map));
            }
            true
        }
        "TJ" => {
            if let Some(PdfToken::Array(items)) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::Array(_)))
            {
                push_pdf_text(output, &decode_pdf_text_array(items, unicode_map));
            }
            true
        }
        "'" | "\"" => {
            push_pdf_line_break(output);
            if let Some(token) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::String(_)))
            {
                push_pdf_text(output, &decode_pdf_text_token(token, unicode_map));
            }
            true
        }
        _ => false,
    }
}

fn next_pdf_token(data: &[u8], index: &mut usize) -> Option<PdfToken> {
    skip_pdf_whitespace_and_comments(data, index);
    let current = *data.get(*index)?;
    match current {
        b'(' => Some(PdfToken::String(parse_pdf_literal_string(data, index))),
        b'<' if data.get(*index + 1) != Some(&b'<') => {
            Some(PdfToken::String(parse_pdf_hex_string(data, index)))
        }
        b'[' => Some(PdfToken::Array(parse_pdf_array(data, index))),
        b']' => {
            *index += 1;
            Some(PdfToken::Word(String::from("]")))
        }
        b'<' | b'>' => {
            let end = (*index + 2).min(data.len());
            let word = String::from_utf8_lossy(&data[*index..end]).into_owned();
            *index = end;
            Some(PdfToken::Word(word))
        }
        _ => Some(parse_pdf_word(data, index)),
    }
}

fn parse_pdf_array(data: &[u8], index: &mut usize) -> Vec<PdfToken> {
    *index += 1;
    let mut items = Vec::new();
    loop {
        skip_pdf_whitespace_and_comments(data, index);
        match data.get(*index) {
            Some(b']') => {
                *index += 1;
                break;
            }
            Some(_) => {
                if let Some(token) = next_pdf_token(data, index) {
                    items.push(token);
                } else {
                    break;
                }
            }
            None => break,
        }
    }
    items
}

fn parse_pdf_literal_string(data: &[u8], index: &mut usize) -> Vec<u8> {
    *index += 1;
    let mut depth = 1usize;
    let mut out = Vec::new();
    while *index < data.len() && depth > 0 {
        let byte = data[*index];
        *index += 1;
        match byte {
            b'\\' => parse_pdf_escape(data, index, &mut out),
            b'(' => {
                depth += 1;
                out.push(byte);
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth > 0 {
                    out.push(byte);
                }
            }
            _ => out.push(byte),
        }
    }
    out
}

fn parse_pdf_escape(data: &[u8], index: &mut usize, out: &mut Vec<u8>) {
    let Some(&byte) = data.get(*index) else {
        return;
    };
    *index += 1;
    match byte {
        b'n' => out.push(b'\n'),
        b'r' => out.push(b'\r'),
        b't' => out.push(b'\t'),
        b'b' => out.push(0x08),
        b'f' => out.push(0x0C),
        b'(' | b')' | b'\\' => out.push(byte),
        b'\r' => {
            if data.get(*index) == Some(&b'\n') {
                *index += 1;
            }
        }
        b'\n' => {}
        b'0'..=b'7' => {
            let mut value = byte - b'0';
            for _ in 0..2 {
                let Some(&next) = data.get(*index) else {
                    break;
                };
                if !(b'0'..=b'7').contains(&next) {
                    break;
                }
                *index += 1;
                value = value.saturating_mul(8).saturating_add(next - b'0');
            }
            out.push(value);
        }
        _ => out.push(byte),
    }
}

fn parse_pdf_hex_string(data: &[u8], index: &mut usize) -> Vec<u8> {
    *index += 1;
    let start = *index;
    while *index < data.len() && data[*index] != b'>' {
        *index += 1;
    }
    let raw = String::from_utf8_lossy(&data[start..*index]);
    if data.get(*index) == Some(&b'>') {
        *index += 1;
    }
    hex_to_bytes(&raw)
}

fn parse_pdf_word(data: &[u8], index: &mut usize) -> PdfToken {
    let start = *index;
    while *index < data.len() && !is_pdf_whitespace(data[*index]) && !is_pdf_delimiter(data[*index])
    {
        *index += 1;
    }
    if *index == start {
        *index += 1;
    }
    let word = String::from_utf8_lossy(&data[start..*index]).into_owned();
    word.parse::<f32>()
        .map_or(PdfToken::Word(word), PdfToken::Number)
}

fn skip_pdf_whitespace_and_comments(data: &[u8], index: &mut usize) {
    loop {
        while data
            .get(*index)
            .is_some_and(|byte| is_pdf_whitespace(*byte))
        {
            *index += 1;
        }
        if data.get(*index) == Some(&b'%') {
            while data
                .get(*index)
                .is_some_and(|byte| !matches!(byte, b'\n' | b'\r'))
            {
                *index += 1;
            }
            continue;
        }
        break;
    }
}

fn is_pdf_whitespace(byte: u8) -> bool {
    matches!(byte, b'\0' | b'\t' | b'\n' | b'\x0C' | b'\r' | b' ')
}

fn is_pdf_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'%'
    )
}

fn looks_like_pdf_operator(word: &str) -> bool {
    word.chars()
        .all(|ch| ch.is_ascii_alphabetic() || matches!(ch, '\'' | '"'))
}

fn decode_pdf_text_array(items: &[PdfToken], unicode_map: &PdfUnicodeMap) -> String {
    let mut out = String::new();
    for item in items {
        match item {
            PdfToken::String(_) => {
                push_pdf_text(&mut out, &decode_pdf_text_token(item, unicode_map))
            }
            PdfToken::Number(value) if *value < -120.0 => push_pdf_text(&mut out, " "),
            _ => {}
        }
    }
    out
}

fn decode_pdf_text_token(token: &PdfToken, unicode_map: &PdfUnicodeMap) -> String {
    match token {
        PdfToken::String(bytes) => decode_pdf_text_bytes(bytes, unicode_map),
        _ => String::new(),
    }
}

fn decode_pdf_text_bytes(bytes: &[u8], unicode_map: &PdfUnicodeMap) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Some(decoded) = decode_utf16_with_bom(bytes) {
        return decoded;
    }
    if let Some(decoded) = decode_bytes_with_cmap(bytes, unicode_map) {
        return decoded;
    }
    if looks_like_utf16be(bytes) {
        return decode_utf16be_units(bytes);
    }
    bytes
        .iter()
        .filter_map(|byte| pdf_doc_byte(*byte))
        .collect()
}

fn decode_bytes_with_cmap(bytes: &[u8], unicode_map: &PdfUnicodeMap) -> Option<String> {
    let max_key_len = unicode_map.keys().map(Vec::len).max()?;
    let mut index = 0;
    let mut hits = 0usize;
    let mut out = String::new();
    while index < bytes.len() {
        let mut matched = false;
        for len in (1..=max_key_len).rev() {
            if index + len > bytes.len() {
                continue;
            }
            if let Some(value) = unicode_map.get(&bytes[index..index + len]) {
                out.push_str(value);
                index += len;
                hits += 1;
                matched = true;
                break;
            }
        }
        if !matched {
            if let Some(ch) = pdf_doc_byte(bytes[index]) {
                out.push(ch);
            }
            index += 1;
        }
    }
    (hits > 0).then_some(out)
}

fn decode_utf16_with_bom(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(decode_utf16be_units(&bytes[2..]));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        return Some(decode_utf16_units(units));
    }
    None
}

fn looks_like_utf16be(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes.len() % 2 == 0
        && bytes
            .chunks_exact(2)
            .filter(|chunk| chunk[0] == 0 && chunk[1].is_ascii())
            .count()
            >= bytes.len() / 6
}

fn decode_utf16be_units(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
    decode_utf16_units(units)
}

fn decode_utf16_units(units: impl Iterator<Item = u16>) -> String {
    std::char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn pdf_doc_byte(byte: u8) -> Option<char> {
    fn cp(value: u32) -> Option<char> {
        char::from_u32(value)
    }

    match byte {
        0x00 => None,
        b'\n' | b'\r' | b'\t' => Some(' '),
        0x20..=0x7E => Some(char::from(byte)),
        0x80 => cp(0x20AC),
        0x82 => cp(0x201A),
        0x83 => cp(0x0192),
        0x84 => cp(0x201E),
        0x85 => cp(0x2026),
        0x86 => cp(0x2020),
        0x87 => cp(0x2021),
        0x88 => cp(0x02C6),
        0x89 => cp(0x2030),
        0x8A => cp(0x0160),
        0x8B => cp(0x2039),
        0x8C => cp(0x0152),
        0x8E => cp(0x017D),
        0x91 => cp(0x2018),
        0x92 => cp(0x2019),
        0x93 => cp(0x201C),
        0x94 => cp(0x201D),
        0x95 => cp(0x2022),
        0x96 => cp(0x2013),
        0x97 => cp(0x2014),
        0x98 => cp(0x02DC),
        0x99 => cp(0x2122),
        0x9A => cp(0x0161),
        0x9B => cp(0x203A),
        0x9C => cp(0x0153),
        0x9E => cp(0x017E),
        0x9F => cp(0x0178),
        0xA0 => Some(' '),
        0xA1..=0xFF => char::from_u32(u32::from(byte)),
        _ => None,
    }
}

fn push_pdf_text(output: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    output.push_str(text);
}

fn push_pdf_line_break(output: &mut String) {
    if !output.ends_with('\n') {
        output.push('\n');
    }
}

fn normalize_pdf_text(input: &str) -> String {
    input
        .lines()
        .map(collapse_inline_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_inline_whitespace(line: &str) -> String {
    let mut out = String::new();
    let mut previous_was_space = false;
    for ch in line.chars() {
        if ch.is_whitespace() {
            if !previous_was_space && !out.is_empty() {
                out.push(' ');
                previous_was_space = true;
            }
        } else {
            out.push(ch);
            previous_was_space = false;
        }
    }
    out.trim().to_string()
}

fn hex_strings_in_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut index = 0;
    let mut values = Vec::new();
    while index < bytes.len() {
        if bytes[index] == b'<' && bytes.get(index + 1) != Some(&b'<') {
            let start = index + 1;
            index = start;
            while index < bytes.len() && bytes[index] != b'>' {
                index += 1;
            }
            if index < bytes.len() {
                values.push(line[start..index].to_string());
            }
        }
        index += 1;
    }
    values
}

fn hex_to_bytes(raw: &str) -> Vec<u8> {
    let mut digits = raw
        .bytes()
        .filter(|byte| byte.is_ascii_hexdigit())
        .collect::<Vec<_>>();
    if digits.len() % 2 == 1 {
        digits.push(b'0');
    }
    digits
        .chunks(2)
        .filter_map(|pair| {
            let hi = hex_nibble(pair[0])?;
            let lo = hex_nibble(pair[1])?;
            Some((hi << 4) | lo)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn unicode_hex_to_string(raw: &str) -> String {
    let bytes = hex_to_bytes(raw);
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        decode_utf16be_units(&bytes)
    } else {
        bytes
            .iter()
            .filter_map(|byte| pdf_doc_byte(*byte))
            .collect()
    }
}

fn big_endian_bytes_to_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.len() > 4 {
        return None;
    }
    let mut value = 0u32;
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
    }
    Some(value)
}

fn u32_to_big_endian_bytes(value: u32, len: usize) -> Vec<u8> {
    (0..len)
        .rev()
        .map(|shift| ((value >> (shift * 8)) & 0xFF) as u8)
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn rfind_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(haystack.len());
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn ascii_contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_subslice(haystack, needle).is_some()
}

fn make_patch(original: &str, updated: &str) -> Vec<StructuredPatchHunk> {
    let mut lines = Vec::new();
    for line in original.lines() {
        lines.push(format!("-{line}"));
    }
    for line in updated.lines() {
        lines.push(format!("+{line}"));
    }

    vec![StructuredPatchHunk {
        old_start: 1,
        old_lines: original.lines().count(),
        new_start: 1,
        new_lines: updated.lines().count(),
        lines,
    }]
}

fn normalize_path(path: &str) -> io::Result<PathBuf> {
    let root = workspace_root()?;
    let candidate = path_candidate(path, root.as_deref())?;
    let canonical = candidate.canonicalize()?;
    if let Some(root) = root.as_ref() {
        ensure_within_workspace(&canonical, root)?;
    }
    Ok(canonical)
}

fn normalize_path_allow_missing(path: &str) -> io::Result<PathBuf> {
    let root = workspace_root()?;
    let candidate = path_candidate(path, root.as_deref())?;
    let canonical = canonicalize_allow_missing(&candidate)?;
    if let Some(root) = root.as_ref() {
        ensure_within_workspace(&canonical, root)?;
    }
    Ok(canonical)
}

fn workspace_root() -> io::Result<Option<PathBuf>> {
    let Ok(raw) = std::env::var("ARIS_WORKSPACE_ROOT") else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let root = PathBuf::from(trimmed);
    fs::create_dir_all(&root)?;
    Ok(Some(root.canonicalize()?))
}

fn path_candidate(path: &str, workspace_root: Option<&Path>) -> io::Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    match workspace_root {
        Some(root) => Ok(root.join(path)),
        None => Ok(std::env::current_dir()?.join(path)),
    }
}

fn ensure_within_workspace(path: &Path, root: &Path) -> io::Result<()> {
    if path.starts_with(root) {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "path `{}` is outside the isolated workspace `{}`",
            path.display(),
            root.display()
        ),
    ))
}

fn canonicalize_allow_missing(candidate: &Path) -> io::Result<PathBuf> {
    let candidate = lexically_normalize(candidate);
    if let Ok(canonical) = candidate.canonicalize() {
        return Ok(canonical);
    }

    let mut ancestor = candidate.as_path();
    let mut missing = Vec::<OsString>::new();
    while !ancestor.exists() {
        let name = ancestor.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no existing ancestor for `{}`", candidate.display()),
            )
        })?;
        missing.push(name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no existing ancestor for `{}`", candidate.display()),
            )
        })?;
    }

    let mut canonical = ancestor.canonicalize()?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::io::Write;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use flate2::{write::ZlibEncoder, Compression};

    use super::{edit_file, glob_search, grep_search, read_file, write_file, GrepSearchInput};

    struct EnvGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvGuard {
        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, previous }
        }

        fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        std::env::temp_dir().join(format!("clawd-native-{name}-{unique}"))
    }

    fn zlib_bytes(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).expect("write compressed stream");
        encoder.finish().expect("finish compressed stream")
    }

    fn pdf_with_streams(streams: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        for (index, (dict_extra, data)) in streams.iter().enumerate() {
            pdf.extend_from_slice(
                format!(
                    "{} 0 obj\n<< /Length {}{} >>\nstream\n",
                    index + 1,
                    data.len(),
                    dict_extra
                )
                .as_bytes(),
            );
            pdf.extend_from_slice(data);
            pdf.extend_from_slice(b"\nendstream\nendobj\n");
        }
        pdf.extend_from_slice(b"%%EOF\n");
        pdf
    }

    #[test]
    fn reads_and_writes_files() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
        let path = temp_path("read-write.txt");
        let write_output = write_file(path.to_string_lossy().as_ref(), "one\ntwo\nthree")
            .expect("write should succeed");
        assert_eq!(write_output.kind, "create");

        let read_output = read_file(path.to_string_lossy().as_ref(), Some(1), Some(1))
            .expect("read should succeed");
        assert_eq!(read_output.file.content, "two");
    }

    #[test]
    fn reads_pdf_text_from_flate_stream() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
        let path = temp_path("paper").with_extension("pdf");
        let content_stream = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj T* (Second line) Tj ET";
        let pdf = pdf_with_streams(&[(" /Filter /FlateDecode", zlib_bytes(content_stream))]);
        std::fs::write(&path, pdf).expect("pdf should be written");

        let output = read_file(path.to_string_lossy().as_ref(), None, None)
            .expect("pdf read should succeed");

        assert_eq!(output.file.content, "Hello PDF\nSecond line");
    }

    #[test]
    fn reads_pdf_text_with_to_unicode_cmap() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
        let path = temp_path("unicode-paper").with_extension("pdf");
        let cmap = br#"
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 beginbfchar
<0001> <0041>
<0002> <0042>
<0003> <0020>
<0004> <03A9>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"#;
        let content_stream = b"BT /F1 12 Tf 72 720 Td <0001000200030004> Tj ET";
        let pdf = pdf_with_streams(&[("", cmap.to_vec()), ("", content_stream.to_vec())]);
        std::fs::write(&path, pdf).expect("pdf should be written");

        let output = read_file(path.to_string_lossy().as_ref(), None, None)
            .expect("pdf read should succeed");

        assert_eq!(output.file.content, "AB \u{03A9}");
    }

    #[test]
    fn edits_file_contents() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
        let path = temp_path("edit.txt");
        write_file(path.to_string_lossy().as_ref(), "alpha beta alpha")
            .expect("initial write should succeed");
        let output = edit_file(path.to_string_lossy().as_ref(), "alpha", "omega", true)
            .expect("edit should succeed");
        assert!(output.replace_all);
    }

    #[test]
    fn globs_and_greps_directory() {
        let _lock = crate::test_env_lock();
        let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
        let dir = temp_path("search-dir");
        std::fs::create_dir_all(&dir).expect("directory should be created");
        let file = dir.join("demo.rs");
        write_file(
            file.to_string_lossy().as_ref(),
            "fn main() {\n println!(\"hello\");\n}\n",
        )
        .expect("file write should succeed");

        let globbed = glob_search("**/*.rs", Some(dir.to_string_lossy().as_ref()))
            .expect("glob should succeed");
        assert_eq!(globbed.num_files, 1);

        let grep_output = grep_search(&GrepSearchInput {
            pattern: String::from("hello"),
            path: Some(dir.to_string_lossy().into_owned()),
            glob: Some(String::from("**/*.rs")),
            output_mode: Some(String::from("content")),
            before: None,
            after: None,
            context_short: None,
            context: None,
            line_numbers: Some(true),
            case_insensitive: Some(false),
            file_type: None,
            head_limit: Some(10),
            offset: Some(0),
            multiline: Some(false),
        })
        .expect("grep should succeed");
        assert!(grep_output.content.unwrap_or_default().contains("hello"));
    }

    #[test]
    fn workspace_root_allows_relative_paths_inside_root() {
        let _lock = crate::test_env_lock();
        let root = temp_path("workspace-root");
        std::fs::create_dir_all(&root).expect("workspace should be created");
        let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

        write_file("notes/demo.txt", "inside").expect("write inside workspace should succeed");
        let output =
            read_file("notes/demo.txt", None, None).expect("read inside workspace should succeed");

        assert_eq!(output.file.content, "inside");
        assert!(Path::new(&output.file.file_path).starts_with(root.canonicalize().unwrap()));
    }

    #[test]
    fn workspace_root_blocks_absolute_reads_outside_root() {
        let _lock = crate::test_env_lock();
        let root = temp_path("workspace-root");
        let outside = temp_path("outside.txt");
        std::fs::create_dir_all(&root).expect("workspace should be created");
        std::fs::write(&outside, "outside").expect("outside file should be created");
        let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

        let err = read_file(outside.to_string_lossy().as_ref(), None, None)
            .expect_err("outside read should be blocked");

        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn workspace_root_blocks_parent_traversal_writes() {
        let _lock = crate::test_env_lock();
        let root = temp_path("workspace-root");
        std::fs::create_dir_all(&root).expect("workspace should be created");
        let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

        let err = write_file("../outside.txt", "outside")
            .expect_err("parent traversal write should be blocked");

        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn workspace_root_blocks_absolute_globs_outside_root() {
        let _lock = crate::test_env_lock();
        let root = temp_path("workspace-root");
        let outside = temp_path("outside-dir");
        std::fs::create_dir_all(&root).expect("workspace should be created");
        std::fs::create_dir_all(&outside).expect("outside dir should be created");
        std::fs::write(outside.join("secret.rs"), "fn main() {}")
            .expect("outside file should be created");
        let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

        let err = glob_search(&format!("{}/*.rs", outside.display()), None)
            .expect_err("outside glob should be blocked");

        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }
}
