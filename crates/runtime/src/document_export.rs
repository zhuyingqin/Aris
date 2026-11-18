//! DOCX generation and pagination delegated to Pandoc and LibreOffice.
//! No Markdown parser, math converter, or pagination engine lives here.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const MAX_SOURCE: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT: usize = 64 * 1024 * 1024;
const REFERENCE: &[u8] = include_bytes!("../assets/docx/research-reference.docx");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocxExportInput {
    pub source_path: String,
    pub expected_source_revision: String,
    pub output_path: String,
    pub reference_doc: Option<String>,
    pub expected_revision: Option<String>,
    #[serde(default = "yes")]
    pub render_pdf: bool,
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocxRenderInput {
    pub path: String,
    pub expected_revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocxPdfExportInput {
    pub path: String,
    pub expected_source_revision: String,
    pub output_path: Option<String>,
    pub expected_revision: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxDeleteParagraphsInput {
    pub path: String,
    pub expected_source_revision: String,
    pub output_path: String,
    pub expected_revision: Option<String>,
    pub deletions: Vec<DocxParagraphDeletion>,
    #[serde(default = "yes")]
    pub render_pdf: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxParagraphDeletion {
    pub paragraph_id: String,
    pub expected_text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxFormatInput {
    pub path: String,
    pub expected_source_revision: String,
    pub output_path: String,
    pub expected_revision: Option<String>,
    pub operations: Vec<DocxFormatOperation>,
    #[serde(default = "yes")]
    pub render_pdf: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxFormatOperation {
    pub paragraph_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_before_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_after_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_line_indent_pt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_with_next: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widow_control: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_empty_paragraph: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<DocxTextRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscript: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superscript: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_stops: Option<Vec<DocxTabStop>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxTextRange {
    pub start: usize,
    pub end: usize,
    pub expected_text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxTabStop {
    pub position_pt: f64,
    pub alignment: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxStructureInput {
    pub path: String,
    pub expected_source_revision: String,
    pub output_path: String,
    pub expected_revision: Option<String>,
    pub operations: Vec<DocxStructureOperation>,
    #[serde(default = "yes")]
    pub render_pdf: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocxStructureOperation {
    InsertBreaks {
        paragraph_id: String,
        expected_text: String,
        breaks: Vec<DocxBreak>,
    },
    InsertBlankPage {
        paragraph_id: String,
        expected_text: String,
    },
    InsertTable {
        paragraph_id: String,
        expected_text: String,
        position: String,
        rows: usize,
        columns: usize,
    },
    InsertImage {
        paragraph_id: String,
        expected_text: String,
        offset: usize,
        image_path: String,
        image_revision: String,
        width_pt: f64,
    },
    TextToTable {
        paragraphs: Vec<DocxParagraphDeletion>,
        delimiter: String,
    },
    PageNumbers {
        alignment: String,
        #[serde(default)]
        skip_first_page: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_at: Option<usize>,
    },
    RepeatTableHeader {
        paragraph_id: String,
        expected_text: String,
        header_rows: usize,
    },
    SectionOrientation {
        section_index: usize,
        orientation: String,
    },
    RemovePersonalMetadata {},
    AcceptRevisions {},
    FillContentControl {
        control_id: String,
        expected_text: String,
        text: String,
    },
    InsertTableOfContents {
        paragraph_id: String,
        expected_text: String,
        levels: usize,
    },
    BibliographyReference {
        paragraph_id: String,
        expected_text: String,
        marker: String,
        after_paragraph_id: String,
        after_expected_text: String,
        bookmark: String,
        number: usize,
        entry: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocxBreak {
    pub offset: usize,
    pub kind: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OdtHighlightInput {
    pub path: String,
    pub expected_source_revision: String,
    pub output_path: String,
    pub expected_revision: Option<String>,
    #[serde(default = "yes")]
    pub render_pdf: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxDeleteParagraphsOutput {
    pub file_path: String,
    pub revision: String,
    pub source_revision: String,
    pub deleted_paragraphs: usize,
    pub preserved_native_equations: usize,
    pub formatter_version: String,
    pub python_version: String,
    pub change_id: Option<String>,
    pub evidence: DocxPageEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxPdfExportOutput {
    pub file_path: String,
    pub revision: String,
    pub source_revision: String,
    pub change_id: Option<String>,
    pub evidence: DocxPageEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxFormatOutput {
    pub file_path: String,
    pub revision: String,
    pub source_revision: String,
    pub preserved_native_equations: usize,
    pub applied_operations: usize,
    pub formatter_version: String,
    pub python_version: String,
    pub change_id: Option<String>,
    pub evidence: DocxPageEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OdtHighlightOutput {
    pub file_path: String,
    pub revision: String,
    pub source_revision: String,
    pub removed_highlights: usize,
    pub formatter_version: String,
    pub change_id: Option<String>,
    pub evidence: DocxPageEvidence,
}

/// Read an ODT snapshot before a bounded format edit. Never convert it to DOCX.
pub fn read_odt(path: &str) -> io::Result<Value> {
    use std::io::{Cursor, Read};
    let path = crate::file_ops::normalize_read_path(path)?;
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("odt"))
    {
        return Err(failure("invalid_format", "read_odt requires ODT"));
    }
    let bytes = bounded_read(&path, MAX_DOCUMENT)?;
    ensure_local_odt(&bytes)?;
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(io::Error::other)?;
    let mut content = String::new();
    zip.by_name("content.xml")
        .map_err(io::Error::other)?
        .read_to_string(&mut content)?;
    let xml = roxmltree::Document::parse(&content).map_err(io::Error::other)?;
    let ns = Some("urn:oasis:names:tc:opendocument:xmlns:text:1.0");
    let paragraphs: Vec<_> = xml
        .descendants()
        .filter(|n| {
            n.is_element()
                && n.tag_name().namespace() == ns
                && matches!(n.tag_name().name(), "p" | "h")
        })
        .map(|n| {
            n.descendants()
                .filter(|c| c.is_text())
                .filter_map(|c| c.text())
                .collect::<String>()
        })
        .collect();
    Ok(
        serde_json::json!({"filePath":display(&path), "revision":revision(&bytes), "paragraphs":paragraphs}),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxExportOutput {
    pub file_path: String,
    pub revision: String,
    pub source_revision: String,
    pub template_revision: String,
    pub generator_version: String,
    pub native_equation_count: usize,
    pub resources: Vec<DocxResource>,
    pub change_id: Option<String>,
    pub evidence: DocxPageEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxResource {
    pub file_path: String,
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxPageEvidence {
    pub document_revision: String,
    pub state: String,
    pub renderer_version: Option<String>,
    pub pdf_path: Option<String>,
    pub pdf_revision: Option<String>,
    pub page_count: Option<usize>,
    pub evidence_path: Option<String>,
    pub visual_review: String,
    pub target_editor_verification: String,
    pub warnings: Vec<String>,
}

fn failure(kind: &str, message: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("docx_export:{kind} {message}"))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn bounded_read(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut data = Vec::new();
    fs::File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut data)?;
    if data.len() > maximum {
        return Err(failure("size_limit", display(path)));
    }
    Ok(data)
}

fn revision(data: &[u8]) -> String {
    crate::file_ops::content_revision(data)
}

fn require_revision(path: &Path, expected: &str, maximum: usize) -> io::Result<Vec<u8>> {
    let bytes = bounded_read(path, maximum)?;
    if revision(&bytes) != expected {
        return Err(failure("revision_conflict", "file changed; read it again"));
    }
    Ok(bytes)
}

fn executable(variable: &str, default: &str) -> PathBuf {
    crate::execution_env_var_os(variable)
        .filter(|value| !value.is_empty())
        .map_or_else(|| PathBuf::from(default), PathBuf::from)
}

fn run(command: &mut Command, engine: &str, cancel: &dyn Fn() -> bool) -> io::Result<Vec<u8>> {
    if cancel() {
        return Err(failure(
            "cancelled",
            format!("{engine} cancelled before launch"),
        ));
    }
    let result = crate::run_managed_command_with_cancel(
        command, format!("DOCX {engine}"), Some(Duration::from_secs(120)), true, cancel,
    ).map_err(|error| failure("engine_unavailable", format!("{engine}: {error}; configure SOMNIQ_PANDOC / SOMNIQ_LIBREOFFICE with an installed local engine")))?;
    if result.interrupted || result.timed_out {
        return Err(failure(
            if result.timed_out {
                "timeout"
            } else {
                "cancelled"
            },
            engine,
        ));
    }
    if !result.status.success() || result.output_truncated {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(failure(
            "engine_failed",
            format!(
                "{engine}: {}",
                stderr.chars().take(4000).collect::<String>()
            ),
        ));
    }
    Ok(result.stdout)
}

fn engine_version(
    executable: &Path,
    engine: &str,
    cancel: &dyn Fn() -> bool,
) -> io::Result<String> {
    let bytes = run(
        crate::hidden_command(executable).arg("--version"),
        engine,
        cancel,
    )?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .next()
        .unwrap_or("unknown")
        .trim()
        .to_string())
}

fn artifact_directory(anchor: &Path) -> io::Result<tempfile::TempDir> {
    let root = crate::execution_env_var_os("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| anchor.parent().unwrap_or(Path::new(".")).to_path_buf());
    let root = crate::file_ops::normalize_path_allow_missing(&display(
        &root.join(".somniq/artifacts/docx"),
    ))?;
    fs::create_dir_all(&root)?;
    tempfile::Builder::new().prefix("run-").tempdir_in(root)
}

fn math_count(value: &Value) -> usize {
    match value {
        Value::Object(object) => {
            usize::from(object.get("t").and_then(Value::as_str) == Some("Math"))
                + object.values().map(math_count).sum::<usize>()
        }
        Value::Array(values) => values.iter().map(math_count).sum(),
        _ => 0,
    }
}

// Work with Pandoc's parsed Image nodes. Embedding authorised local resources
// as data URIs lets its writer remain sandboxed; no Markdown/image parser or
// network fetcher is implemented here.
fn embed_local_images(
    value: &mut Value,
    base: &Path,
    resources: &mut Vec<DocxResource>,
) -> io::Result<()> {
    if value.get("t").and_then(Value::as_str) == Some("Image") {
        let target = value
            .pointer_mut("/c/2/0")
            .ok_or_else(|| failure("invalid_ast", "Image has no target"))?;
        let name = target
            .as_str()
            .ok_or_else(|| failure("invalid_ast", "Image target is not text"))?;
        if !name.starts_with("data:") {
            if name.starts_with("//") || name.starts_with("\\\\") {
                return Err(failure(
                    "external_resource",
                    "save the image in the workspace before exporting",
                ));
            }
            let path = if Path::new(name).is_absolute() {
                PathBuf::from(name)
            } else {
                let url = url::Url::from_directory_path(base)
                    .map_err(|()| failure("image_path", "invalid source directory"))?
                    .join(name)
                    .map_err(|e| failure("image_path", e))?;
                if url.scheme() != "file"
                    || url
                        .host_str()
                        .is_some_and(|host| !host.is_empty() && host != "localhost")
                {
                    return Err(failure("external_resource", "save the image in the workspace before exporting; export never downloads images"));
                }
                url.to_file_path()
                    .map_err(|()| failure("image_path", name))?
            };
            let path = crate::file_ops::normalize_read_path(&display(&path))?;
            let media_type =
                crate::file_ops::image_media_type(&display(&path)).ok_or_else(|| {
                    failure(
                        "unsupported_image",
                        "use a local PNG, JPEG, GIF, WebP or BMP",
                    )
                })?;
            let bytes = bounded_read(&path, 8 * 1024 * 1024)?;
            let file_path = display(&path);
            if !resources
                .iter()
                .any(|resource| resource.file_path == file_path)
            {
                if resources.len() >= 32 {
                    return Err(failure(
                        "size_limit",
                        "at most 32 local image resources per document",
                    ));
                }
                resources.push(DocxResource {
                    file_path,
                    revision: revision(&bytes),
                });
            }
            *target = Value::String(format!(
                "data:{media_type};base64,{}",
                BASE64.encode(&bytes)
            ));
        }
    }
    match value {
        Value::Object(object) => {
            for child in object.values_mut() {
                embed_local_images(child, base, resources)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                embed_local_images(child, base, resources)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn unreviewed(revision: String, state: &str) -> DocxPageEvidence {
    DocxPageEvidence {
        document_revision: revision,
        state: state.into(),
        renderer_version: None,
        pdf_path: None,
        pdf_revision: None,
        page_count: None,
        evidence_path: None,
        visual_review: "pending".into(),
        target_editor_verification: "unverified".into(),
        warnings: Vec::new(),
    }
}

fn render_failure(document_revision: String, error: io::Error) -> DocxPageEvidence {
    let message = error.to_string();
    let state = if message.starts_with("docx_export:cancelled") {
        "cancelled"
    } else if message.starts_with("docx_export:engine_unavailable") {
        "unavailable"
    } else {
        "failed"
    };
    let mut evidence = unreviewed(document_revision, state);
    evidence.warnings.push(message);
    evidence
}

/// Delegate creation to Pandoc; inspect the actual candidate before publishing it.
pub fn export_docx(
    input: &DocxExportInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxExportOutput> {
    if cancel() {
        return Err(failure("cancelled", "export cancelled before launch"));
    }
    let source = crate::file_ops::normalize_read_path(&input.source_path)?;
    let output = crate::file_ops::normalize_path_allow_missing(&input.output_path)?;
    if !source
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("md"))
        || !output
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
    {
        return Err(failure("invalid_format", "source must be .md and output must be .docx; existing DOCX is never round-tripped through Markdown"));
    }
    let source_bytes = require_revision(&source, &input.expected_source_revision, MAX_SOURCE)?;
    std::str::from_utf8(&source_bytes).map_err(|e| failure("encoding", e))?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let reference = input
        .reference_doc
        .as_deref()
        .map(crate::file_ops::normalize_read_path)
        .transpose()?;
    if reference.as_ref() == Some(&output) {
        return Err(failure(
            "invalid_output",
            "output cannot replace the reference template",
        ));
    }
    let template = reference.as_ref().map_or_else(
        || Ok(REFERENCE.to_vec()),
        |path| bounded_read(path, MAX_DOCUMENT),
    )?;
    let job = artifact_directory(&output)?;
    let markdown = job.path().join("source.md");
    let template_path = job.path().join("reference.docx");
    let ast_path = job.path().join("document.json");
    let candidate = job.path().join("candidate.docx");
    fs::write(&markdown, &source_bytes)?;
    fs::write(&template_path, &template)?;
    let pandoc = executable("SOMNIQ_PANDOC", "pandoc");
    let version = engine_version(&pandoc, "Pandoc", cancel)?;
    let mut reader = crate::hidden_command(&pandoc);
    reader
        .args([
            "--sandbox",
            "--fail-if-warnings",
            "--from=markdown",
            "--to=json",
        ])
        .arg(&markdown)
        .current_dir(source.parent().unwrap());
    let ast = run(&mut reader, "Pandoc reader", cancel)?;
    if ast.len() > MAX_DOCUMENT {
        return Err(failure("size_limit", "Pandoc AST exceeds 64 MiB"));
    }
    let mut ast_value: Value =
        serde_json::from_slice(&ast).map_err(|e| failure("invalid_ast", e))?;
    let expected_math = math_count(&ast_value);
    let mut resources = Vec::new();
    embed_local_images(&mut ast_value, source.parent().unwrap(), &mut resources)?;
    let ast = serde_json::to_vec(&ast_value).map_err(|e| failure("invalid_ast", e))?;
    if ast.len() > MAX_DOCUMENT {
        return Err(failure("size_limit", "embedded Pandoc AST exceeds 64 MiB"));
    }
    fs::write(&ast_path, &ast)?;
    let mut writer = crate::hidden_command(&pandoc);
    writer
        .args([
            "--sandbox",
            "--fail-if-warnings",
            "--from=json",
            "--to=docx",
            "--standalone",
        ])
        .arg("--reference-doc")
        .arg(&template_path)
        .arg("--resource-path")
        .arg(source.parent().unwrap())
        .arg("--output")
        .arg(&candidate)
        .arg(&ast_path)
        .current_dir(source.parent().unwrap());
    run(&mut writer, "Pandoc writer", cancel)?;
    let bytes = bounded_read(&candidate, MAX_DOCUMENT)?;
    let inspection = crate::docx::read_docx(&display(&candidate), None, Some(1))?;
    if inspection.native_equation_count < expected_math {
        return Err(failure(
            "editable_math_required",
            format!(
                "expected {expected_math} native formulas, found {}",
                inspection.native_equation_count
            ),
        ));
    }
    require_revision(&source, &input.expected_source_revision, MAX_SOURCE)?;
    if let Some(path) = reference {
        require_revision(&path, &revision(&template), MAX_DOCUMENT)?;
    }
    for resource in &resources {
        require_revision(
            Path::new(&resource.file_path),
            &resource.revision,
            8 * 1024 * 1024,
        )?;
    }
    if cancel() {
        return Err(failure("cancelled", "export cancelled before commit"));
    }
    let audit = serde_json::json!({
        "operation": "export_docx", "sourcePath": display(&source),
        "sourceRevision": input.expected_source_revision,
        "templateRevision": revision(&template), "generatorVersion": version,
        "resources": resources
    })
    .to_string();
    let change_id = commit(&output, previous.as_deref(), &bytes, context, audit)?;
    let document_revision = revision(&bytes);
    let evidence = if input.render_pdf {
        match render_bytes(&output, &bytes, cancel) {
            Ok(evidence) => evidence,
            Err(error) => render_failure(document_revision.clone(), error),
        }
    } else {
        unreviewed(document_revision.clone(), "not_requested")
    };
    Ok(DocxExportOutput {
        file_path: display(&output),
        revision: document_revision,
        source_revision: input.expected_source_revision.clone(),
        template_revision: revision(&template),
        generator_version: version,
        native_equation_count: inspection.native_equation_count,
        resources,
        change_id,
        evidence,
    })
}

fn existing_output(path: &Path, expected: Option<&str>) -> io::Result<Option<Vec<u8>>> {
    match bounded_read(path, MAX_DOCUMENT) {
        Ok(bytes) if expected == Some(revision(&bytes).as_str()) => {
            if bytes.len() > crate::change_ledger::MAX_REVERT_BLOB_BYTES {
                return Err(failure("candidate_required", "existing output exceeds the reversible snapshot limit; use a new candidate output_path"));
            }
            Ok(Some(bytes))
        },
        Ok(_) => Err(failure("revision_conflict", "existing output requires its current expected_revision; use a new candidate path otherwise")),
        Err(error) if error.kind() == io::ErrorKind::NotFound && expected.is_none() => Ok(None),
        Err(error) => Err(error),
    }
}

fn run_docx_adapter(
    source_bytes: &[u8],
    output: &Path,
    plan: &impl Serialize,
    mode: &str,
    resources: &[(String, Vec<u8>)],
    cancel: &dyn Fn() -> bool,
) -> io::Result<(Vec<u8>, String, String, Value)> {
    let job = artifact_directory(output)?;
    let extension = if mode == "odt_highlight" {
        "odt"
    } else {
        "docx"
    };
    let staged = job.path().join(format!("source.{extension}"));
    let candidate = job.path().join(format!("candidate.{extension}"));
    let plan_path = job.path().join("plan.json");
    let script = job.path().join("format_docx.py");
    fs::write(&staged, source_bytes)?;
    let mut plan = serde_json::to_value(plan).map_err(io::Error::other)?;
    if serde_json::to_vec(&plan).map_err(io::Error::other)?.len() > MAX_SOURCE {
        return Err(failure("size_limit", "document plan exceeds 8 MiB"));
    }
    let mut resource_paths = serde_json::Map::new();
    for (index, (key, data)) in resources.iter().enumerate() {
        let path = job.path().join(format!("resource-{index}"));
        fs::write(&path, data)?;
        resource_paths.insert(key.clone(), Value::String(display(&path)));
    }
    plan["_resources"] = Value::Object(resource_paths);
    fs::write(
        &plan_path,
        serde_json::to_vec(&plan).map_err(io::Error::other)?,
    )?;
    fs::write(&script, include_str!("../assets/docx/format_docx.py"))?;
    fs::write(
        job.path().join("structure_docx.py"),
        include_str!("../assets/docx/structure_docx.py"),
    )?;
    fs::write(
        job.path().join("format_odt.py"),
        include_str!("../assets/docx/format_odt.py"),
    )?;
    fs::write(job.path().join("office_docx.py"), include_str!("../assets/docx/office_docx.py"))?;
    fs::write(job.path().join("toc_index.py"), include_str!("../assets/docx/toc_index.py"))?;
    let python = executable(
        "SOMNIQ_PYTHON",
        if cfg!(windows) { "python" } else { "python3" },
    );
    let mut command = crate::hidden_command(python);
    command
        .arg(&script)
        .arg("--source")
        .arg(&staged)
        .arg("--output")
        .arg(&candidate)
        .arg("--plan")
        .arg(&plan_path)
        .arg("--mode")
        .arg(mode);
    let versions: Value = serde_json::from_slice(&run(&mut command, "python-docx", cancel)?)
        .map_err(|e| failure("invalid_engine_response", e))?;
    let version = |key: &str| {
        versions[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| failure("invalid_engine_response", format!("missing {key}")))
    };
    let formatter = version("engineVersion")?;
    let python = version("pythonVersion")?;
    Ok((
        bounded_read(&candidate, MAX_DOCUMENT)?,
        formatter,
        python,
        versions,
    ))
}

/// Formatting edits use python-docx; the original text, math and other parts stay intact.
pub fn format_docx(
    input: &DocxFormatInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxFormatOutput> {
    if cancel() {
        return Err(failure("cancelled", "formatting cancelled before launch"));
    }
    if input.operations.is_empty() || input.operations.len() > 64 {
        return Err(failure("format_limit", "supply 1-64 operations"));
    }
    let source = crate::file_ops::normalize_read_path(&input.path)?;
    let output = crate::file_ops::normalize_path_allow_missing(&input.output_path)?;
    if !source
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
        || !output
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
    {
        return Err(failure("invalid_format", "format_docx requires DOCX"));
    }
    let source_bytes = require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    let original = crate::docx::inspect_bytes(&source_bytes)?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let (bytes, formatter_version, python_version, _) =
        run_docx_adapter(&source_bytes, &output, input, "format", &[], cancel)?;
    let inspection = crate::docx::inspect_bytes(&bytes)?;
    if inspection.native_equation_count != original.native_equation_count
        || inspection.total_paragraphs != original.total_paragraphs
    {
        return Err(failure(
            "protected_content_changed",
            "formatting changed paragraph or equation structure",
        ));
    }
    require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    if cancel() {
        return Err(failure("cancelled", "formatting cancelled before commit"));
    }
    let audit = serde_json::json!({
        "operation": "format_docx", "sourcePath": display(&source),
        "sourceRevision": input.expected_source_revision,
        "formatterVersion": formatter_version, "pythonVersion": python_version,
        "operations": input.operations
    })
    .to_string();
    let change_id = commit(&output, previous.as_deref(), &bytes, context, audit)?;
    let doc_revision = revision(&bytes);
    let evidence = if input.render_pdf {
        render_bytes(&output, &bytes, cancel)
            .unwrap_or_else(|error| render_failure(doc_revision.clone(), error))
    } else {
        unreviewed(doc_revision.clone(), "not_requested")
    };
    Ok(DocxFormatOutput {
        file_path: display(&output),
        revision: doc_revision,
        source_revision: input.expected_source_revision.clone(),
        preserved_native_equations: inspection.native_equation_count,
        applied_operations: input.operations.len(),
        formatter_version,
        python_version,
        change_id,
        evidence,
    })
}

/// Bounded structure edits, with an explicit snapshot anchor instead of a cursor.
pub fn edit_docx_structure(
    input: &DocxStructureInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxFormatOutput> {
    if cancel() {
        return Err(failure(
            "cancelled",
            "structure edit cancelled before launch",
        ));
    }
    if input.operations.is_empty() || input.operations.len() > 64 {
        return Err(failure("structure_limit", "supply 1-64 operations"));
    }
    let source = crate::file_ops::normalize_read_path(&input.path)?;
    let output = crate::file_ops::normalize_path_allow_missing(&input.output_path)?;
    if ![&source, &output].iter().all(|p| {
        p.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
    }) {
        return Err(failure("invalid_format", "structure edits require DOCX"));
    }
    let source_bytes = require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    let original = crate::docx::inspect_bytes(&source_bytes)?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let mut resources = Vec::new();
    let mut resource_checks = Vec::new();
    if input.operations.iter().any(|op| matches!(op, DocxStructureOperation::InsertTableOfContents { .. })) {
        // Index pagination must pass the same offline/macro preflight as PDF rendering.
        crate::docx::ensure_local_render(&source_bytes)?;
    }
    let mut total = 0;
    for op in &input.operations {
        if let DocxStructureOperation::InsertImage {
            image_path,
            image_revision,
            ..
        } = op
        {
            let path = crate::file_ops::normalize_read_path(image_path)?;
            let bytes = require_revision(&path, image_revision, 16 * 1024 * 1024)?;
            total += bytes.len();
            if total > MAX_DOCUMENT {
                return Err(failure("resource_limit", "images exceed 64 MiB"));
            }
            resources.push((image_path.clone(), bytes));
            resource_checks.push((path, image_revision));
        }
    }
    let (bytes, formatter_version, python_version, result) = run_docx_adapter(
        &source_bytes,
        &output,
        input,
        "structure",
        &resources,
        cancel,
    )?;
    let inspection = crate::docx::inspect_bytes(&bytes)?;
    if inspection.native_equation_count != original.native_equation_count
        || result["appliedOperations"].as_u64() != Some(input.operations.len() as u64)
    {
        return Err(failure(
            "protected_content_changed",
            "unexpected equation/operation count",
        ));
    }
    require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    for (path, expected) in resource_checks {
        require_revision(&path, expected, 16 * 1024 * 1024)?;
    }
    if cancel() {
        return Err(failure(
            "cancelled",
            "structure edit cancelled before commit",
        ));
    }
    let audit =
        serde_json::json!({"operation":"edit_docx_structure", "sourcePath":display(&source),
        "sourceRevision":input.expected_source_revision, "operations":input.operations,
        "formatterVersion":formatter_version, "pythonVersion":python_version})
        .to_string();
    let change_id = commit(&output, previous.as_deref(), &bytes, context, audit)?;
    let document_revision = revision(&bytes);
    let evidence = if input.render_pdf {
        render_bytes(&output, &bytes, cancel)
            .unwrap_or_else(|error| render_failure(document_revision.clone(), error))
    } else {
        unreviewed(document_revision.clone(), "not_requested")
    };
    Ok(DocxFormatOutput {
        file_path: display(&output),
        revision: document_revision,
        source_revision: input.expected_source_revision.clone(),
        preserved_native_equations: inspection.native_equation_count,
        applied_operations: input.operations.len(),
        formatter_version,
        python_version,
        change_id,
        evidence,
    })
}

/// ODT highlight edits stay in ODT; existing styles, text, images and links survive.
pub fn remove_odt_highlight(
    input: &OdtHighlightInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<OdtHighlightOutput> {
    if cancel() {
        return Err(failure("cancelled", "ODT edit cancelled before launch"));
    }
    let source = crate::file_ops::normalize_read_path(&input.path)?;
    let output = crate::file_ops::normalize_path_allow_missing(&input.output_path)?;
    if ![&source, &output]
        .iter()
        .all(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("odt")))
    {
        return Err(failure("invalid_format", "highlight removal requires ODT"));
    }
    let original = require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    ensure_local_odt(&original)?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let (bytes, formatter_version, _, result) =
        run_docx_adapter(&original, &output, input, "odt_highlight", &[], cancel)?;
    ensure_local_odt(&bytes)?;
    let removed = result["removedHighlights"]
        .as_u64()
        .ok_or_else(|| failure("invalid_engine_response", "missing removedHighlights"))?
        as usize;
    require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    if cancel() {
        return Err(failure("cancelled", "ODT edit cancelled before commit"));
    }
    let audit = serde_json::json!({"operation":"remove_odt_highlight", "sourceRevision":input.expected_source_revision,
        "sourcePath":display(&source), "removedHighlights":removed, "formatterVersion":formatter_version}).to_string();
    let change_id = commit(&output, previous.as_deref(), &bytes, context, audit)?;
    let doc_revision = revision(&bytes);
    let evidence = if input.render_pdf {
        render_bytes(&output, &bytes, cancel)
            .unwrap_or_else(|error| render_failure(doc_revision.clone(), error))
    } else {
        unreviewed(doc_revision.clone(), "not_requested")
    };
    Ok(OdtHighlightOutput {
        file_path: display(&output),
        revision: doc_revision,
        source_revision: input.expected_source_revision.clone(),
        removed_highlights: removed,
        formatter_version,
        change_id,
        evidence,
    })
}

fn ensure_local_odt(bytes: &[u8]) -> io::Result<()> {
    use std::io::{Cursor, Read};
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(io::Error::other)?;
    if archive.len() > 4096 {
        return Err(failure("size_limit", "too many ODT members"));
    }
    let mut total = 0;
    let mut mimetype = false;
    for i in 0..archive.len() {
        let mut member = archive.by_index(i).map_err(io::Error::other)?;
        total += member.size();
        if total > 128 * 1024 * 1024 {
            return Err(failure("size_limit", "ODT expansion exceeds 128 MiB"));
        }
        let name = member.name().to_owned();
        if name.starts_with("Basic/") || name.starts_with("Scripts/") || name.contains("signatures")
        {
            return Err(failure(
                "protected_document",
                "ODT scripts/signatures are unsupported",
            ));
        }
        if name == "mimetype" || name.ends_with(".xml") {
            if member.size() > MAX_SOURCE as u64 {
                return Err(failure("size_limit", "ODT XML too large"));
            }
            let mut text = String::new();
            member.read_to_string(&mut text)?;
            if name == "mimetype" {
                mimetype = text == "application/vnd.oasis.opendocument.text";
                continue;
            }
            let xml = roxmltree::Document::parse(&text).map_err(io::Error::other)?;
            for node in xml.descendants().filter(roxmltree::Node::is_element) {
                if matches!(node.tag_name().name(), "encryption-data" | "event-listener")
                    || (node.tag_name().name() == "scripts"
                        && node.children().any(|c| c.is_element()))
                {
                    return Err(failure(
                        "protected_document",
                        "ODT encryption/scripts are unsupported",
                    ));
                }
                for attr in node.attributes() {
                    if attr.namespace() == Some("http://www.w3.org/1999/xlink")
                        && attr.name() == "href"
                    {
                        let href = attr.value();
                        if !href.starts_with('#')
                            && (href.contains(':')
                                || href.starts_with('/')
                                || href.split('/').any(|p| p == ".."))
                        {
                            // Ordinary hyperlinks are never activated by rendering.
                            if node.tag_name().name() != "a" {
                                return Err(failure(
                                    "external_resource",
                                    "ODT rendering requires embedded resources",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    if !mimetype {
        return Err(failure("invalid_format", "invalid ODT mimetype"));
    }
    Ok(())
}

/// Explicit structure editing, separate from text-preserving formatting.
pub fn delete_docx_paragraphs(
    input: &DocxDeleteParagraphsInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxDeleteParagraphsOutput> {
    if cancel() {
        return Err(failure("cancelled", "deletion cancelled before launch"));
    }
    if input.deletions.is_empty() || input.deletions.len() > 128 {
        return Err(failure("delete_limit", "supply 1-128 verified paragraphs"));
    }
    if serde_json::to_vec(&input.deletions)
        .map_err(io::Error::other)?
        .len()
        > MAX_SOURCE
    {
        return Err(failure("size_limit", "deletion plan exceeds 8 MiB"));
    }
    let source = crate::file_ops::normalize_read_path(&input.path)?;
    let output = crate::file_ops::normalize_path_allow_missing(&input.output_path)?;
    if !source
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
        || !output
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
    {
        return Err(failure(
            "invalid_format",
            "paragraph deletion requires DOCX",
        ));
    }
    let source_bytes = require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    let original = crate::docx::inspect_bytes(&source_bytes)?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let (bytes, formatter_version, python_version, result) = run_docx_adapter(
        &source_bytes,
        &output,
        input,
        "delete_paragraphs",
        &[],
        cancel,
    )?;
    let inspection = crate::docx::inspect_bytes(&bytes)?;
    let deleted = input.deletions.len();
    if result["deletedParagraphs"].as_u64() != Some(deleted as u64)
        || inspection.native_equation_count != original.native_equation_count
        || inspection.total_paragraphs.checked_add(deleted) != Some(original.total_paragraphs)
    {
        return Err(failure(
            "protected_content_changed",
            "unexpected paragraph or equation structure",
        ));
    }
    require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    if cancel() {
        return Err(failure("cancelled", "deletion cancelled before commit"));
    }
    let audit =
        serde_json::json!({"operation":"delete_docx_paragraphs", "sourcePath":display(&source),
        "sourceRevision":input.expected_source_revision, "deletions":input.deletions,
        "formatterVersion":formatter_version, "pythonVersion":python_version})
        .to_string();
    let change_id = commit(&output, previous.as_deref(), &bytes, context, audit)?;
    let document_revision = revision(&bytes);
    let evidence = if input.render_pdf {
        render_bytes(&output, &bytes, cancel)
            .unwrap_or_else(|error| render_failure(document_revision.clone(), error))
    } else {
        unreviewed(document_revision.clone(), "not_requested")
    };
    Ok(DocxDeleteParagraphsOutput {
        file_path: display(&output),
        revision: document_revision,
        source_revision: input.expected_source_revision.clone(),
        deleted_paragraphs: deleted,
        preserved_native_equations: inspection.native_equation_count,
        formatter_version,
        python_version,
        change_id,
        evidence,
    })
}

/// Publish the exact rendered PDF through the same versioned binary ledger.
pub fn export_docx_pdf(
    input: &DocxPdfExportInput,
    context: &crate::FileMutationContext,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxPdfExportOutput> {
    if cancel() {
        return Err(failure("cancelled", "PDF export cancelled before launch"));
    }
    let source = crate::file_ops::normalize_read_path(&input.path)?;
    let output = crate::file_ops::normalize_path_allow_missing(
        &input
            .output_path
            .clone()
            .unwrap_or_else(|| display(&source.with_extension("pdf"))),
    )?;
    if !source
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("docx"))
        || !output
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("pdf"))
    {
        return Err(failure(
            "invalid_format",
            "PDF export requires DOCX input and PDF output",
        ));
    }
    let bytes = require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    crate::docx::inspect_bytes(&bytes)?;
    let previous = existing_output(&output, input.expected_revision.as_deref())?;
    let evidence = render_bytes(&source, &bytes, cancel)?;
    let pdf = require_revision(
        Path::new(
            evidence
                .pdf_path
                .as_deref()
                .ok_or_else(|| failure("invalid_pdf", "missing PDF"))?,
        ),
        evidence
            .pdf_revision
            .as_deref()
            .ok_or_else(|| failure("invalid_pdf", "missing PDF hash"))?,
        MAX_DOCUMENT,
    )?;
    require_revision(&source, &input.expected_source_revision, MAX_DOCUMENT)?;
    if cancel() {
        return Err(failure("cancelled", "PDF export cancelled before commit"));
    }
    let audit = serde_json::json!({"operation":"export_docx_pdf", "sourcePath":display(&source),
        "sourceRevision":input.expected_source_revision, "pdfRevision":revision(&pdf),
        "rendererVersion":evidence.renderer_version, "pageCount":evidence.page_count})
    .to_string();
    let change_id = commit(&output, previous.as_deref(), &pdf, context, audit)?;
    Ok(DocxPdfExportOutput {
        file_path: display(&output),
        revision: revision(&pdf),
        source_revision: input.expected_source_revision.clone(),
        change_id,
        evidence,
    })
}

fn commit(
    path: &Path,
    before: Option<&[u8]>,
    after: &[u8],
    context: &crate::FileMutationContext,
    audit: String,
) -> io::Result<Option<String>> {
    crate::atomic_file::with_path_lock(path, || {
        crate::atomic_file::write_replace_unlocked_checked(path, after, || {
            let current = match bounded_read(path, MAX_DOCUMENT) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => return Err(e),
            };
            if current.as_deref() != before {
                return Err(failure("revision_conflict", "output changed during export"));
            }
            Ok(())
        })
    })?;
    let record = crate::change_ledger::record_binary_file_write(
        context,
        path,
        before,
        Some(after),
        audit,
        None,
    );
    match record {
        Ok(record) => Ok(record.map(|record| record.change_id)),
        Err(error) => {
            let rollback = crate::atomic_file::with_path_lock(path, || {
                if bounded_read(path, MAX_DOCUMENT)? != after {
                    return Err(failure(
                        "revision_conflict",
                        "output changed before audit rollback",
                    ));
                }
                match before {
                    Some(bytes) => crate::atomic_file::write_replace_unlocked(path, bytes),
                    None => fs::remove_file(path),
                }
            });
            Err(failure(
                "audit_failed",
                format!("{error}; rollback: {rollback:?}"),
            ))
        }
    }
}

/// Render a saved DOCX snapshot. Rendering never certifies visual correctness.
pub fn render_docx(
    input: &DocxRenderInput,
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxPageEvidence> {
    if cancel() {
        return Err(failure("cancelled", "render cancelled before launch"));
    }
    let path = crate::file_ops::normalize_read_path(&input.path)?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
    {
        return Err(failure("invalid_format", "render_docx requires DOCX"));
    }
    let bytes = require_revision(&path, &input.expected_revision, MAX_DOCUMENT)?;
    crate::docx::read_docx(&display(&path), None, Some(1))?;
    render_bytes(&path, &bytes, cancel)
}

fn render_bytes(
    path: &Path,
    bytes: &[u8],
    cancel: &dyn Fn() -> bool,
) -> io::Result<DocxPageEvidence> {
    let is_odt = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("odt"));
    if is_odt {
        ensure_local_odt(bytes)?;
    } else {
        crate::docx::ensure_local_render(bytes)?;
    }
    let job = artifact_directory(path)?;
    let input = job.path().join(if is_odt {
        "document.odt"
    } else {
        "document.docx"
    });
    let profile = job.path().join("profile");
    let output = job.path().join("document.pdf");
    fs::write(&input, bytes)?;
    fs::create_dir(&profile)?;
    let soffice = executable(
        "SOMNIQ_LIBREOFFICE",
        if cfg!(windows) {
            "soffice.com"
        } else {
            "soffice"
        },
    );
    let version = engine_version(&soffice, "LibreOffice", cancel)?;
    let profile_url = url::Url::from_directory_path(&profile)
        .map_err(|()| failure("profile_path", "cannot construct local profile URL"))?;
    let mut command = crate::hidden_command(soffice);
    command
        .arg(format!("-env:UserInstallation={profile_url}"))
        .args([
            "--headless",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
        ])
        .arg(job.path())
        .arg(&input);
    run(&mut command, "LibreOffice PDF", cancel)?;
    let pdf = bounded_read(&output, MAX_DOCUMENT)?;
    let parsed = lopdf::Document::load_mem(&pdf).map_err(|e| failure("invalid_pdf", e))?;
    let pages = parsed.get_pages().len();
    if pages == 0 {
        return Err(failure("invalid_pdf", "renderer returned no pages"));
    }
    require_revision(path, &revision(bytes), MAX_DOCUMENT)?;
    let mut evidence = unreviewed(revision(bytes), "rendered");
    evidence.renderer_version = Some(version);
    evidence.pdf_path = Some(display(&output));
    evidence.pdf_revision = Some(revision(&pdf));
    evidence.page_count = Some(pages);
    evidence.evidence_path = Some(display(&job.path().join("evidence.json")));
    fs::write(
        job.path().join("evidence.json"),
        serde_json::to_vec_pretty(&evidence).map_err(io::Error::other)?,
    )?;
    // Keep only the evidence and its exact input snapshot, never a renderer profile.
    fs::remove_dir_all(profile)?;
    let _ = job.keep();
    Ok(evidence)
}

#[cfg(test)]
#[path = "tests/document_export.rs"]
mod tests;
