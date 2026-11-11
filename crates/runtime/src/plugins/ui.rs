//! SomniQ UI contributions. The host owns rendering and all actions; packages
//! never receive an invoke handle or filesystem access.
//!
//! Schema 3 lets a panel name a `page`: an HTML file of the package that
//! draws the panel itself. This module only validates the declaration and
//! hands the reviewed files over as text; the desktop runs the page in a
//! sandboxed frame whose one bridge is the panel's own data. Schema 3 also
//! adds the `chat.brief` slot (a small glance in the project summary) and
//! `dataPanel`, which lets one panel show and edit another panel's data, so a
//! glance and a full page share one store.
//!
//! Schema 2 adds widgets that show data (tables, metrics, lists, Markdown,
//! progress, charts) and widgets that act (forms, buttons). Data is written by
//! the agent through the `PluginPanel` tool and validated here against the
//! widget's shape; an action is one of the host's own (put text in the
//! composer, open a project file), never package code.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Diagnostic, PackageFile, PackageFiles, PluginCapabilities, PluginStore};

const MAX_UI_REVISION: u64 = 9_007_199_254_740_991;
const MAX_UI_STATE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UiText {
    Plain(String),
    Localized(UiLocales),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiLocales {
    pub en: String,
    pub cn: String,
}

impl UiText {
    fn validate(&self, max: usize) -> Result<(), String> {
        let valid = |s: &str| !s.trim().is_empty() && s.chars().count() <= max;
        if match self {
            Self::Plain(s) => valid(s),
            Self::Localized(UiLocales { en, cn }) => valid(en) && valid(cn),
        } {
            Ok(())
        } else {
            Err(format!(
                "UI text must contain 1..{max} characters per language"
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPanel {
    pub id: String,
    pub slot: String,
    pub title: UiText,
    /// A host icon for the panel's entry, by name. A package cannot ship an
    /// image of its own: workspace bytes never reach the app chrome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub order: i32,
    /// Whose data the panel shows: this conversation's, or one copy for the
    /// whole project.
    #[serde(default)]
    pub scope: UiScope,
    /// A package-relative HTML file that draws this panel itself, in a
    /// sandboxed frame. The widgets are then the panel's data stores: the
    /// page reads and writes them through the host bridge, and nothing else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// Another panel of the same package whose data this panel's page reads
    /// and writes, instead of keeping its own: a glance in the summary and
    /// the full page it summarizes then show one store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_panel: Option<String>,
    #[serde(default)]
    pub widgets: Vec<UiWidget>,
}

impl UiPanel {
    #[must_use]
    pub fn widget(&self, id: &str) -> Option<&UiWidget> {
        self.widgets.iter().find(|widget| widget.id() == id)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiScope {
    #[default]
    Session,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiColumn {
    pub key: String,
    pub title: UiText,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiChartKind {
    Bar,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiInputKind {
    Text,
    Textarea,
    Number,
    Select,
    Checkbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiField {
    pub key: String,
    pub label: UiText,
    pub input: UiInputKind,
    /// The choices of a `select`; no other input takes them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiButton {
    pub label: UiText,
    pub action: UiClick,
}

/// What a click does. Every variant is something the host does itself on the
/// user's click; none of them runs package code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UiClick {
    /// Put `text` in the Chat composer, with `{{key}}` replaced by the form's
    /// values. With `send`, the click also sends it as the user's message.
    Prompt {
        text: String,
        #[serde(default)]
        send: bool,
    },
    /// Open a project file in the side panel.
    OpenFile { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UiWidget {
    TodoList { id: String, title: UiText },
    Notes { id: String, title: UiText },
    AgentPlan { id: String, title: UiText },
    Text { id: String, text: UiText },
    Table { id: String, title: UiText, columns: Vec<UiColumn> },
    Metrics { id: String, title: UiText },
    List { id: String, title: UiText },
    Markdown { id: String, title: UiText },
    Progress { id: String, title: UiText },
    Chart { id: String, title: UiText, chart: UiChartKind },
    Form { id: String, title: UiText, fields: Vec<UiField>, submit: UiButton },
    Button { id: String, label: UiText, action: UiClick },
    /// Free-form data for a panel that draws itself with a `page`.
    Json { id: String, title: UiText },
}

impl UiWidget {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::TodoList { id, .. }
            | Self::Notes { id, .. }
            | Self::AgentPlan { id, .. }
            | Self::Text { id, .. }
            | Self::Table { id, .. }
            | Self::Metrics { id, .. }
            | Self::List { id, .. }
            | Self::Markdown { id, .. }
            | Self::Progress { id, .. }
            | Self::Chart { id, .. }
            | Self::Form { id, .. }
            | Self::Button { id, .. }
            | Self::Json { id, .. } => id,
        }
    }

    /// The `type` this widget is written with; exhaustive, so a new variant
    /// cannot be added without a name here and a row in [`UI_WIDGET_TYPES`].
    #[must_use]
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::TodoList { .. } => "todo-list",
            Self::Notes { .. } => "notes",
            Self::AgentPlan { .. } => "agent-plan",
            Self::Text { .. } => "text",
            Self::Table { .. } => "table",
            Self::Metrics { .. } => "metrics",
            Self::List { .. } => "list",
            Self::Markdown { .. } => "markdown",
            Self::Progress { .. } => "progress",
            Self::Chart { .. } => "chart",
            Self::Form { .. } => "form",
            Self::Button { .. } => "button",
            Self::Json { .. } => "json",
        }
    }

    /// The JSON a write to this widget must have, or `None` when the widget
    /// holds no data (it is fixed text, read-only, or only acts).
    #[must_use]
    pub fn data_shape(&self) -> Option<&'static str> {
        let kind = self.type_name();
        UI_DATA_SHAPES
            .iter()
            .find(|(known, _)| *known == kind)
            .map(|(_, shape)| *shape)
    }

    fn title(&self) -> Option<&UiText> {
        match self {
            Self::TodoList { title, .. }
            | Self::Notes { title, .. }
            | Self::AgentPlan { title, .. }
            | Self::Table { title, .. }
            | Self::Metrics { title, .. }
            | Self::List { title, .. }
            | Self::Markdown { title, .. }
            | Self::Progress { title, .. }
            | Self::Chart { title, .. }
            | Self::Form { title, .. }
            | Self::Json { title, .. } => Some(title),
            Self::Text { .. } | Self::Button { .. } => None,
        }
    }

    /// Widgets schema 1 already had.
    fn in_schema_1(&self) -> bool {
        matches!(
            self,
            Self::TodoList { .. } | Self::Notes { .. } | Self::AgentPlan { .. } | Self::Text { .. }
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiManifest {
    manifest_version: u32,
    ui: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiDocument {
    schema_version: u32,
    panels: Vec<UiPanel>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_UI_ID_LEN
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Where a package can put panels. The host declares every slot.
pub(super) const UI_SLOTS: &[&str] = &["chat.sidebar", UI_SLOT_NAV_PAGE, UI_SLOT_BRIEF];
/// A page of its own, opened from the app's navigation rail.
pub const UI_SLOT_NAV_PAGE: &str = "nav.page";
/// A small glance in the Chat's project summary card.
pub const UI_SLOT_BRIEF: &str = "chat.brief";
/// The widgets small enough for a glance in the project summary.
pub(super) const UI_BRIEF_WIDGETS: &[&str] =
    &["text", "metrics", "progress", "list", "markdown", "button", "todo-list", "json"];
/// The icons a panel may name. Each one is drawn by the host.
pub(super) const UI_ICONS: &[&str] = &[
    "grid", "list", "target", "barChart", "lineChart", "graph", "document", "notebook", "folder",
    "clock", "star", "sparkle", "lightning", "library", "bookOpen", "code", "image", "search",
    "inbox", "collection", "memory", "diagram", "pin", "check",
];
pub(super) const UI_MANIFEST_VERSION: u32 = 1;
/// The newest `schemaVersion`. Older documents keep loading; each may use
/// only what its own version had.
pub(super) const UI_SCHEMA_VERSION: u32 = 3;
/// The version that added data widgets, the project scope, icons and pages.
const UI_SCHEMA_DATA: u32 = 2;
/// The version that added panels drawn by the package's own HTML.
const UI_SCHEMA_PAGE: u32 = 3;
/// One self-contained HTML file; images and fonts ride along as data: URLs.
pub(super) const MAX_UI_PAGE_BYTES: usize = 1024 * 1024;
const MAX_JSON_BYTES: usize = 256 * 1024;
pub(super) const MAX_UI_PANELS: usize = 12;
pub(super) const MAX_UI_WIDGETS: usize = 16;
pub(super) const MAX_UI_ID_LEN: usize = 64;
pub(super) const MAX_UI_TITLE_CHARS: usize = 80;
pub(super) const MAX_UI_TEXT_CHARS: usize = 4000;
pub(super) const MAX_UI_COLUMNS: usize = 12;
pub(super) const MAX_UI_FIELDS: usize = 12;
pub(super) const MAX_UI_OPTIONS: usize = 24;
pub(super) const MAX_UI_OPTION_CHARS: usize = 80;
const MAX_TABLE_ROWS: usize = 500;
const MAX_CELL_CHARS: usize = 2000;
const MAX_METRICS: usize = 24;
const MAX_LIST_ITEMS: usize = 200;
const MAX_CHART_POINTS: usize = 200;
const MAX_CHART_SERIES: usize = 8;
const MAX_LABEL_CHARS: usize = 80;
const MAX_DETAIL_CHARS: usize = 2000;
const MAX_LONG_TEXT_CHARS: usize = 32000;
const MAX_TODOS: usize = 200;
const MAX_TODO_CHARS: usize = 500;
/// Every widget type, as written in `ui.json`, with the fields it takes.
pub(super) const UI_WIDGET_TYPES: &[(&str, &[&str])] = &[
    ("todo-list", &["id", "type", "title"]),
    ("notes", &["id", "type", "title"]),
    ("agent-plan", &["id", "type", "title"]),
    ("text", &["id", "type", "text"]),
    ("table", &["id", "type", "title", "columns"]),
    ("metrics", &["id", "type", "title"]),
    ("list", &["id", "type", "title"]),
    ("markdown", &["id", "type", "title"]),
    ("progress", &["id", "type", "title"]),
    ("chart", &["id", "type", "title", "chart"]),
    ("form", &["id", "type", "title", "fields", "submit"]),
    ("button", &["id", "type", "label", "action"]),
    ("json", &["id", "type", "title"]),
];
/// The value each data-holding widget accepts, as the agent writes it with
/// `PluginPanel`. Widgets missing here hold no data.
pub(super) const UI_DATA_SHAPES: &[(&str, &str)] = &[
    ("todo-list", "[{ \"text\": string (1..500 characters), \"completed\"?: boolean }], at most 200 items; replaces the list"),
    ("notes", "string, at most 32000 characters"),
    ("table", "[{ \"<column key>\": string | number | boolean | null }], at most 500 rows; every key must be a declared column"),
    ("metrics", "[{ \"label\": string, \"value\": string | number, \"hint\"?: string, \"tone\"?: \"good\" | \"warn\" | \"bad\" }], at most 24"),
    ("list", "[{ \"title\": string, \"detail\"?: string, \"tag\"?: string, \"path\"?: project-relative file, \"url\"?: http(s) link }], at most 200"),
    ("markdown", "string of Markdown, at most 32000 characters"),
    ("progress", "{ \"value\": number from 0 to 1, \"label\"?: string }"),
    ("chart", "{ \"labels\": [string], \"series\": [{ \"name\": string, \"values\": [number | null] }] }, at most 200 labels and 8 series; each values array as long as labels"),
    ("json", "any JSON value, at most 262144 bytes when serialized; the panel's page decides its shape"),
];
/// Who fills each widget type, for an author choosing between them.
pub(super) const UI_WIDGET_SOURCES: &[(&str, &str)] = &[
    ("todo-list", "the user in the panel, or the agent with PluginPanel"),
    ("notes", "the user in the panel, or the agent with PluginPanel"),
    ("agent-plan", "read-only: the agent's own TodoWrite plan"),
    ("text", "fixed text from ui.json"),
    ("table", "the agent with PluginPanel"),
    ("metrics", "the agent with PluginPanel"),
    ("list", "the agent with PluginPanel"),
    ("markdown", "the agent with PluginPanel"),
    ("progress", "the agent with PluginPanel"),
    ("chart", "the agent with PluginPanel"),
    ("form", "the user; submitting runs the declared action with the values"),
    ("button", "nothing to fill; a click runs the declared action"),
    ("json", "the panel's own page, or the agent with PluginPanel; only on a panel with a page"),
];
pub(super) const UI_SCOPES: &[&str] = &["session", "project"];
pub(super) const UI_INPUT_KINDS: &[&str] = &["text", "textarea", "number", "select", "checkbox"];
pub(super) const UI_CHART_KINDS: &[&str] = &["bar", "line"];
pub(super) const UI_CLICK_ACTIONS: &[(&str, &str)] = &[
    ("prompt", "{ \"type\": \"prompt\", \"text\": string, \"send\"?: boolean }: puts text in the Chat composer; {{key}} is replaced by the form field of that key (a button has no fields); with send true the click sends it as the user's message"),
    ("open-file", "{ \"type\": \"open-file\", \"path\": project-relative file }: opens the file in the side panel"),
];

fn short(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}

/// `{{key}}` placeholders in a prompt template.
fn placeholders(text: &str) -> Vec<&str> {
    let mut found = vec![];
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        found.push(after[..end].trim());
        rest = &after[end + 2..];
    }
    found
}

fn check_click(action: &UiClick, fields: &[&str]) -> Result<(), String> {
    match action {
        UiClick::Prompt { text, .. } => {
            if !short(text, MAX_UI_TEXT_CHARS) {
                return Err(format!(
                    "A prompt action's text must contain 1..{MAX_UI_TEXT_CHARS} characters"
                ));
            }
            match placeholders(text).into_iter().find(|key| !fields.contains(key)) {
                Some(key) => Err(format!(
                    "{{{{{key}}}}} is not a field of this form; placeholders must name declared field keys"
                )),
                None => Ok(()),
            }
        }
        UiClick::OpenFile { path } => super::dsh::relative_path(path)
            .map(|_| ())
            .map_err(|error| format!("open-file path: {error}")),
    }
}

/// Checks the parts of a widget beyond its id and title.
fn check_widget(widget: &UiWidget) -> Result<(), (&'static str, String)> {
    match widget {
        UiWidget::Table { columns, .. } => {
            let mut keys = BTreeSet::new();
            if columns.is_empty()
                || columns.len() > MAX_UI_COLUMNS
                || columns.iter().any(|column| {
                    !valid_id(&column.key)
                        || !keys.insert(&column.key)
                        || column.title.validate(MAX_UI_TITLE_CHARS).is_err()
                })
            {
                return Err((
                    "columns",
                    format!("A table needs 1..{MAX_UI_COLUMNS} columns with unique keys and titles of 1..{MAX_UI_TITLE_CHARS} characters"),
                ));
            }
            Ok(())
        }
        UiWidget::Form { fields, submit, .. } => {
            let mut keys = BTreeSet::new();
            if fields.is_empty() || fields.len() > MAX_UI_FIELDS {
                return Err(("fields", format!("A form needs 1..{MAX_UI_FIELDS} fields")));
            }
            for field in fields {
                if !valid_id(&field.key)
                    || !keys.insert(field.key.as_str())
                    || field.label.validate(MAX_UI_TITLE_CHARS).is_err()
                {
                    return Err((
                        "fields",
                        format!("Form field keys must be unique ids and labels 1..{MAX_UI_TITLE_CHARS} characters"),
                    ));
                }
                let select = field.input == UiInputKind::Select;
                if select == field.options.is_empty()
                    || field.options.len() > MAX_UI_OPTIONS
                    || field.options.iter().any(|option| !short(option, MAX_UI_OPTION_CHARS))
                {
                    return Err((
                        "fields",
                        format!("A select field needs 1..{MAX_UI_OPTIONS} options of 1..{MAX_UI_OPTION_CHARS} characters; other inputs take none"),
                    ));
                }
            }
            submit
                .label
                .validate(MAX_UI_TITLE_CHARS)
                .map_err(|error| ("submit", error))?;
            let keys: Vec<&str> = keys.into_iter().collect();
            check_click(&submit.action, &keys).map_err(|error| ("submit", error))
        }
        UiWidget::Button { label, action, .. } => {
            label
                .validate(MAX_UI_TITLE_CHARS)
                .map_err(|error| ("label", error))?;
            check_click(action, &[]).map_err(|error| ("action", error))
        }
        _ => Ok(()),
    }
}

/// The package files a page can use besides its HTML, by extension, with the
/// type the frame reads them as. Scripts and stylesheets are inlined into the
/// page; the rest become `data:` URLs. Nothing is fetched from anywhere.
pub(super) const UI_PAGE_ASSET_TYPES: &[(&str, &str)] = &[
    ("js", "text/javascript"), ("mjs", "text/javascript"), ("css", "text/css"),
    ("html", "text/html"), ("json", "application/json"), ("txt", "text/plain"), ("csv", "text/csv"),
    ("md", "text/markdown"), ("svg", "image/svg+xml"), ("png", "image/png"), ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("webp", "image/webp"), ("avif", "image/avif"),
    ("ico", "image/x-icon"), ("woff", "font/woff"), ("woff2", "font/woff2"), ("ttf", "font/ttf"),
    ("otf", "font/otf"), ("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg"),
    ("mp4", "video/mp4"), ("webm", "video/webm"), ("wasm", "application/wasm"),
];
/// Everything a package's pages may carry, together: libraries, fonts, images.
pub(super) const MAX_UI_ASSET_BYTES: usize = 12 * 1024 * 1024;

fn asset_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    UI_PAGE_ASSET_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}

/// The files a page can use, package-relative with forward slashes.
fn page_assets(files: &PackageFiles) -> impl Iterator<Item = (String, &PackageFile, &'static str)> {
    files.iter().filter_map(|(path, file)| {
        let name = path.to_string_lossy().replace('\\', "/");
        let skip = name == "package.json" || name.starts_with('.') || name.contains("/.");
        asset_type(path).filter(|_| !skip).map(|mime| (name, file, mime))
    })
}

/// A panel's `page`: an HTML file of the package. The page may use the
/// package's other files (scripts, styles, images, fonts, data) by relative
/// path; together they must fit in [`MAX_UI_ASSET_BYTES`].
fn check_page(files: &PackageFiles, file: &str, schema: bool) -> Result<(), String> {
    if !schema {
        return Err(format!("A panel page needs schemaVersion {UI_SCHEMA_PAGE}"));
    }
    let total: usize = page_assets(files).map(|(_, file, _)| file.bytes.len()).sum();
    if total > MAX_UI_ASSET_BYTES {
        return Err(format!("The files a page can use (scripts, styles, images, fonts, data) add up to {total} bytes; at most {MAX_UI_ASSET_BYTES} are allowed"));
    }
    let path = super::dsh::relative_path(file)?;
    if !file.to_ascii_lowercase().ends_with(".html") {
        return Err("A panel page must be an .html file".into());
    }
    let Some(found) = files.get(&path) else {
        return Err(format!("Missing panel page file: {file}"));
    };
    if found.bytes.len() > MAX_UI_PAGE_BYTES {
        return Err(format!("A panel page can be at most {MAX_UI_PAGE_BYTES} bytes"));
    }
    std::str::from_utf8(&found.bytes)
        .map(|_| ())
        .map_err(|_| "A panel page must be UTF-8 text".into())
}

/// The page `file` of a package's `files` and every file it can use, as the
/// frame receives them. `files` must already be verified to be `digest`.
pub(super) fn page_from_files(files: &PackageFiles, file: &str, digest: &str) -> Result<UiPage, String> {
    let path = super::dsh::relative_path(file)?;
    let html = files
        .get(&path)
        .filter(|found| found.bytes.len() <= MAX_UI_PAGE_BYTES)
        .ok_or("The panel page changed after it was reviewed")?;
    use base64::Engine as _;
    let assets = page_assets(files)
        .map(|(name, file, mime)| {
            let data = base64::engine::general_purpose::STANDARD.encode(&file.bytes);
            (name, UiPageAsset { mime, data })
        })
        .collect();
    Ok(UiPage {
        html: String::from_utf8(html.bytes.clone()).map_err(|e| e.to_string())?,
        path: path.to_string_lossy().replace('\\', "/"),
        assets,
        package_digest: digest.to_string(),
    })
}

/// Reports every problem in the declaration, not just the first, each with the
/// file and JSON pointer it is at, so an author can fix them in one pass.
pub(super) fn inspect_ui(
    files: &PackageFiles,
    manifest: &serde_json::Value,
    capabilities: &mut PluginCapabilities,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(value) = manifest.get("somniq") else {
        return;
    };
    let in_manifest = |message: String, at: &str| {
        Diagnostic::error("ui", message)
            .in_file("package.json")
            .at(at)
    };
    let header: UiManifest = match serde_json::from_value(value.clone()) {
        Ok(header) => header,
        Err(error) => return diagnostics.push(in_manifest(error.to_string(), "/somniq")),
    };
    if header.manifest_version != UI_MANIFEST_VERSION {
        return diagnostics.push(in_manifest(
            format!("Only somniq.manifestVersion {UI_MANIFEST_VERSION} is supported"),
            "/somniq/manifestVersion",
        ));
    }
    let path = match super::dsh::relative_path(&header.ui) {
        Ok(path) => path,
        Err(error) => return diagnostics.push(in_manifest(error, "/somniq/ui")),
    };
    let Some(file) = files.get(&path) else {
        return diagnostics.push(in_manifest(
            "Missing somniq.ui document".into(),
            "/somniq/ui",
        ));
    };
    let file_name = path.to_string_lossy().replace('\\', "/");
    let document: UiDocument = match serde_json::from_slice(&file.bytes) {
        Ok(document) => document,
        Err(error) => {
            return diagnostics.push(Diagnostic::error("ui", error.to_string()).in_file(file_name))
        }
    };
    let mut problems: Vec<(String, String)> = vec![];
    let mut problem = |at: String, message: String| problems.push((at, message));
    if !(1..=UI_SCHEMA_VERSION).contains(&document.schema_version) {
        problem(
            "/schemaVersion".into(),
            format!("UI schemaVersion must be {UI_SCHEMA_VERSION} (older versions are still read)"),
        );
    }
    let schema_1 = document.schema_version == 1;
    let pages = document.schema_version >= UI_SCHEMA_PAGE;
    if document.panels.is_empty() || document.panels.len() > MAX_UI_PANELS {
        problem(
            "/panels".into(),
            format!("A UI document must contain 1..{MAX_UI_PANELS} panels"),
        );
    }
    let mut panels = BTreeSet::new();
    for (index, panel) in document.panels.iter().enumerate() {
        let at = format!("/panels/{index}");
        if !valid_id(&panel.id) || !panels.insert(&panel.id) {
            problem(
                format!("{at}/id"),
                format!("UI panel ids must be unique and match [A-Za-z0-9_-]{{1,{MAX_UI_ID_LEN}}}"),
            );
        }
        if !UI_SLOTS.contains(&panel.slot.as_str()) {
            problem(
                format!("{at}/slot"),
                format!(
                    "Unsupported UI slot: {}; use one of {}",
                    panel.slot,
                    UI_SLOTS.join(", ")
                ),
            );
        }
        if let Err(error) = panel.title.validate(MAX_UI_TITLE_CHARS) {
            problem(format!("{at}/title"), error);
        }
        if schema_1 && panel.scope != UiScope::Session {
            problem(
                format!("{at}/scope"),
                format!("Panel scope needs schemaVersion {UI_SCHEMA_DATA}"),
            );
        }
        if let Some(icon) = &panel.icon {
            if schema_1 {
                problem(
                    format!("{at}/icon"),
                    format!("Panel icon needs schemaVersion {UI_SCHEMA_DATA}"),
                );
            } else if !UI_ICONS.contains(&icon.as_str()) {
                problem(
                    format!("{at}/icon"),
                    format!("Unknown panel icon: {icon}; use one of {}", UI_ICONS.join(", ")),
                );
            }
        }
        let brief = panel.slot == UI_SLOT_BRIEF;
        if brief && !pages {
            problem(
                format!("{at}/slot"),
                format!("The {UI_SLOT_BRIEF} slot needs schemaVersion {UI_SCHEMA_PAGE}"),
            );
        }
        // The summary belongs to the project, not to one conversation.
        if brief && panel.scope != UiScope::Project {
            problem(
                format!("{at}/scope"),
                format!("A {UI_SLOT_BRIEF} panel must set \"scope\": \"project\""),
            );
        }
        if let Some(target) = &panel.data_panel {
            let found = document.panels.iter().find(|other| &other.id == target);
            let error = if !pages {
                Some(format!("dataPanel needs schemaVersion {UI_SCHEMA_PAGE}"))
            } else if panel.page.is_none() {
                Some("dataPanel is for a panel with a page: the page reads and writes the other panel's widgets".into())
            } else if !panel.widgets.is_empty() {
                Some("A panel with dataPanel keeps no data of its own: remove its widgets".into())
            } else if target == &panel.id {
                Some("dataPanel must name another panel".into())
            } else {
                match found {
                    None => Some(format!("dataPanel names no panel of this package: {target}")),
                    Some(other) if other.data_panel.is_some() => {
                        Some("dataPanel must name a panel that keeps its own data".into())
                    }
                    Some(other) if other.scope != panel.scope => {
                        Some("dataPanel must name a panel with the same scope".into())
                    }
                    Some(_) => None,
                }
            };
            if let Some(error) = error {
                problem(format!("{at}/dataPanel"), error);
            }
        }
        let page = panel.slot == UI_SLOT_NAV_PAGE;
        if page && schema_1 {
            problem(
                format!("{at}/slot"),
                format!("The {UI_SLOT_NAV_PAGE} slot needs schemaVersion {UI_SCHEMA_DATA}"),
            );
        }
        // A page is not opened from a conversation, so it has none to belong to.
        if page && !schema_1 && panel.scope != UiScope::Project {
            problem(
                format!("{at}/scope"),
                format!("A {UI_SLOT_NAV_PAGE} panel must set \"scope\": \"project\""),
            );
        }
        if let Some(file) = &panel.page {
            if let Err(error) = check_page(files, file, pages) {
                problem(format!("{at}/page"), error);
            }
        }
        // A panel that draws itself may keep no data at all.
        let fewest = usize::from(panel.page.is_none());
        if panel.widgets.len() < fewest || panel.widgets.len() > MAX_UI_WIDGETS {
            problem(
                format!("{at}/widgets"),
                format!("Each UI panel must contain 1..{MAX_UI_WIDGETS} widgets (a panel with a page may have none)"),
            );
        }
        let mut widgets = BTreeSet::new();
        for (position, widget) in panel.widgets.iter().enumerate() {
            let at = format!("{at}/widgets/{position}");
            if !valid_id(widget.id()) || !widgets.insert(widget.id()) {
                problem(
                    format!("{at}/id"),
                    "UI widget ids must be valid and unique within the panel".into(),
                );
            }
            if schema_1 && !widget.in_schema_1() {
                problem(
                    format!("{at}/type"),
                    format!(
                        "The {} widget needs schemaVersion {UI_SCHEMA_DATA}",
                        widget.type_name()
                    ),
                );
            }
            if matches!(widget, UiWidget::Json { .. }) && !(pages && panel.page.is_some()) {
                problem(
                    format!("{at}/type"),
                    format!("The json widget holds data for a panel's own page: it needs schemaVersion {UI_SCHEMA_PAGE} and a panel with a page"),
                );
            }
            if brief && !UI_BRIEF_WIDGETS.contains(&widget.type_name()) {
                problem(
                    format!("{at}/type"),
                    format!(
                        "The {} widget is too large for the project summary; a {UI_SLOT_BRIEF} panel takes {}",
                        widget.type_name(),
                        UI_BRIEF_WIDGETS.join(", ")
                    ),
                );
            }
            if page && matches!(widget, UiWidget::AgentPlan { .. }) {
                problem(
                    format!("{at}/type"),
                    format!("The agent-plan widget follows one conversation; it cannot sit on a {UI_SLOT_NAV_PAGE} panel"),
                );
            }
            let checked = match (widget, widget.title()) {
                (UiWidget::Text { text, .. }, _) => {
                    text.validate(MAX_UI_TEXT_CHARS).map_err(|e| ("text", e))
                }
                (_, Some(title)) => title
                    .validate(MAX_UI_TITLE_CHARS)
                    .map_err(|e| ("title", e))
                    .and_then(|()| check_widget(widget)),
                _ => check_widget(widget),
            };
            if let Err((field, error)) = checked {
                problem(format!("{at}/{field}"), error);
            }
        }
    }
    if problems.is_empty() {
        capabilities.ui_panels = document.panels;
    }
    diagnostics.extend(problems.into_iter().map(|(at, message)| {
        Diagnostic::error("ui", message)
            .in_file(file_name.clone())
            .at(at)
    }));
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveUiPanel {
    pub plugin_name: String,
    pub package_digest: String,
    #[serde(flatten)]
    pub panel: UiPanel,
}

/// A page panel's HTML and the package version it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPage {
    pub html: String,
    /// The page's own package-relative path: its relative links resolve here.
    pub path: String,
    /// Every file the page can use, by package-relative path.
    pub assets: BTreeMap<String, UiPageAsset>,
    pub package_digest: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiPageAsset {
    pub mime: &'static str,
    /// Base64 of the file's bytes.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiTodo {
    pub id: String,
    pub text: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPanelState {
    pub revision: u64,
    pub todo_lists: BTreeMap<String, Vec<UiTodo>>,
    pub notes: BTreeMap<String, String>,
    /// Values of the data widgets, by widget id, each in its widget's shape.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub data: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TodoInput {
    text: String,
    #[serde(default)]
    completed: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Scalar {
    Text(String),
    Number(f64),
    Flag(#[allow(dead_code)] bool),
    Empty(()),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TextOrNumber {
    Text(String),
    Number(f64),
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Tone {
    Good,
    Warn,
    Bad,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetricInput {
    label: String,
    value: TextOrNumber,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    tone: Option<Tone>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListItemInput {
    title: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgressInput {
    value: f64,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChartSeriesInput {
    name: String,
    values: Vec<Option<f64>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChartInput {
    labels: Vec<String>,
    series: Vec<ChartSeriesInput>,
}

fn parse<T: serde::de::DeserializeOwned>(value: &serde_json::Value) -> Result<T, String> {
    T::deserialize(value).map_err(|error| error.to_string())
}

fn optional(text: &Option<String>, max: usize) -> bool {
    text.as_deref()
        .is_none_or(|text| text.chars().count() <= max)
}

/// Whether `value` is what a data widget shows. Stored values are checked
/// again on every read, so a value an upgraded package no longer accepts is
/// dropped instead of reaching the renderer.
fn check_data(widget: &UiWidget, value: &serde_json::Value) -> Result<(), String> {
    let fits = match widget {
        UiWidget::Table { columns, .. } => {
            let rows: Vec<BTreeMap<String, Scalar>> = parse(value)?;
            rows.len() <= MAX_TABLE_ROWS
                && rows.iter().all(|row| {
                    row.iter().all(|(key, cell)| {
                        columns.iter().any(|column| &column.key == key)
                            && match cell {
                                Scalar::Text(text) => text.chars().count() <= MAX_CELL_CHARS,
                                Scalar::Number(number) => number.is_finite(),
                                Scalar::Flag(_) | Scalar::Empty(()) => true,
                            }
                    })
                })
        }
        UiWidget::Metrics { .. } => {
            let metrics: Vec<MetricInput> = parse(value)?;
            metrics.len() <= MAX_METRICS
                && metrics.iter().all(|metric| {
                    short(&metric.label, MAX_LABEL_CHARS)
                        && optional(&metric.hint, MAX_DETAIL_CHARS)
                        && match &metric.value {
                            TextOrNumber::Text(text) => text.chars().count() <= MAX_LABEL_CHARS,
                            TextOrNumber::Number(number) => number.is_finite(),
                        }
                })
        }
        UiWidget::List { .. } => {
            let items: Vec<ListItemInput> = parse(value)?;
            items.len() <= MAX_LIST_ITEMS
                && items.iter().all(|item| {
                    short(&item.title, MAX_TODO_CHARS)
                        && optional(&item.detail, MAX_DETAIL_CHARS)
                        && optional(&item.tag, MAX_LABEL_CHARS)
                        && item
                            .path
                            .as_deref()
                            .is_none_or(|path| super::dsh::relative_path(path).is_ok())
                        && item.url.as_deref().is_none_or(|url| {
                            url.len() <= MAX_DETAIL_CHARS
                                && (url.starts_with("https://") || url.starts_with("http://"))
                                && !url.chars().any(char::is_whitespace)
                        })
                })
        }
        UiWidget::Markdown { .. } => parse::<String>(value)?.chars().count() <= MAX_LONG_TEXT_CHARS,
        UiWidget::Progress { .. } => {
            let progress: ProgressInput = parse(value)?;
            (0.0..=1.0).contains(&progress.value) && optional(&progress.label, MAX_TODO_CHARS)
        }
        UiWidget::Chart { .. } => {
            let chart: ChartInput = parse(value)?;
            chart.labels.len() <= MAX_CHART_POINTS
                && chart
                    .labels
                    .iter()
                    .all(|label| label.chars().count() <= MAX_LABEL_CHARS)
                && (1..=MAX_CHART_SERIES).contains(&chart.series.len())
                && chart.series.iter().all(|series| {
                    short(&series.name, MAX_LABEL_CHARS)
                        && series.values.len() == chart.labels.len()
                        && series.values.iter().flatten().all(|value| value.is_finite())
                })
        }
        UiWidget::Json { .. } => {
            serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_JSON_BYTES)
        }
        _ => return Err("This widget holds no data".into()),
    };
    if fits {
        Ok(())
    } else {
        Err("a value is outside the limits".into())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredState {
    schema_version: u32,
    plugin_name: String,
    panel_id: String,
    session_id: String,
    state: UiPanelState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UiAction {
    TodoAdd {
        widget_id: String,
        text: String,
    },
    TodoSetCompleted {
        widget_id: String,
        item_id: String,
        completed: bool,
    },
    TodoRemove {
        widget_id: String,
        item_id: String,
    },
    NotesSet {
        widget_id: String,
        text: String,
    },
    /// Replace everything a widget holds with `value`, in the widget's
    /// [`UiWidget::data_shape`]. This is how the agent fills a panel.
    WidgetSet {
        widget_id: String,
        value: serde_json::Value,
    },
}

impl PluginStore {
    pub fn active_ui_panels(&self) -> Result<Vec<ActiveUiPanel>, String> {
        let mut panels = vec![];
        for plugin in self
            .list()?
            .into_iter()
            .filter(|p| p.enabled && p.package.can_enable)
        {
            for panel in plugin.package.capabilities.ui_panels {
                panels.push(ActiveUiPanel {
                    plugin_name: plugin.package.name.clone(),
                    package_digest: plugin.package.digest.clone(),
                    panel,
                });
            }
        }
        // Stable ordering, as in DSH's list slots; ids are namespaced by package.
        panels.sort_by_key(|p| p.panel.order);
        Ok(panels)
    }

    /// The declaration of an enabled package's panel.
    pub fn ui_panel(&self, name: &str, panel_id: &str) -> Result<UiPanel, String> {
        let registry = self.registry()?;
        let record = registry
            .packages
            .get(name)
            .ok_or("UI plugin is not installed")?;
        let plugin = self.inspect_record(record);
        if !plugin.enabled || !plugin.package.can_enable {
            return Err("UI plugin is disabled or blocked; reload the plugin panels".into());
        }
        plugin
            .package
            .capabilities
            .ui_panels
            .into_iter()
            .find(|p| p.id == panel_id)
            .ok_or("UI panel is not declared by this plugin".into())
    }

    /// The HTML of an enabled package's page panel, read from the reviewed
    /// snapshot whose digest was just verified. It is the only package file
    /// the host hands to a frame, and it is handed over as text.
    pub fn ui_page(&self, name: &str, panel_id: &str) -> Result<UiPage, String> {
        self.mutate(|| {
            let registry = self.registry()?;
            let record = registry
                .packages
                .get(name)
                .ok_or("UI plugin is not installed")?;
            let file = self
                .ui_panel(name, panel_id)?
                .page
                .ok_or("This panel has no page")?;
            // Read the whole snapshot and check it is still the reviewed one:
            // the page and every file it uses come from the same bytes.
            let files = super::package_files(&self.snapshot_path(&record.digest))?;
            if super::digest_files(&files) != record.digest {
                return Err("The panel page changed after it was reviewed".into());
            }
            page_from_files(&files, &file, &record.digest)
        })
    }

    fn ui_state_path(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
    ) -> Result<PathBuf, String> {
        // Scope strings are data, never path components. The stored identity is
        // checked as well so files cannot accidentally be exchanged across scopes.
        // A project-scoped panel is stored under the empty session id, which no
        // conversation has, with a key shaped unlike any session's.
        let key = if session_id.is_empty() {
            serde_json::to_vec(&(name, panel_id, "", "project"))
        } else if session_id.trim().is_empty()
            || session_id.len() > 256
            || session_id.chars().any(char::is_control)
        {
            return Err("A valid local session id is required".into());
        } else {
            serde_json::to_vec(&(name, panel_id, session_id))
        }
        .map_err(|e| e.to_string())?;
        let path = self
            .root
            .join("ui-state")
            .join(format!("{:x}.json", Sha256::digest(key)));
        for (target, directory) in [(path.parent().unwrap(), true), (path.as_path(), false)] {
            match fs::symlink_metadata(target) {
                Ok(meta)
                    if meta.file_type().is_symlink()
                        || if directory {
                            !meta.is_dir()
                        } else {
                            !meta.is_file()
                        } =>
                {
                    return Err(
                        "Plugin UI state must use regular local files and directories".into(),
                    );
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(path)
    }

    fn read_ui_state(
        &self,
        path: &Path,
        name: &str,
        panel: &UiPanel,
        session: &str,
    ) -> Result<UiPanelState, String> {
        let mut state = match fs::File::open(path) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = vec![];
                file.take((MAX_UI_STATE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > MAX_UI_STATE_BYTES {
                    return Err("Plugin UI state exceeds 2 MiB".into());
                }
                let saved: StoredState =
                    serde_json::from_slice(&bytes).map_err(|e| format!("Plugin UI state: {e}"))?;
                if saved.schema_version != 1
                    || saved.plugin_name != name
                    || saved.panel_id != panel.id
                    || saved.session_id != session
                {
                    return Err("Plugin UI state identity does not match this panel/session".into());
                }
                saved.state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => UiPanelState::default(),
            Err(error) => return Err(error.to_string()),
        };
        // Ignore obsolete widget data after an author revises their package.
        state.todo_lists.retain(|id, _| {
            panel
                .widgets
                .iter()
                .any(|w| matches!(w, UiWidget::TodoList { id: key, .. } if key == id))
        });
        state.notes.retain(|id, _| {
            panel
                .widgets
                .iter()
                .any(|w| matches!(w, UiWidget::Notes { id: key, .. } if key == id))
        });
        state.data.retain(|id, value| {
            panel
                .widget(id)
                .is_some_and(|widget| check_data(widget, value).is_ok())
        });
        if state.revision > MAX_UI_REVISION {
            return Err("UI revision limit reached".into());
        }
        for todos in state.todo_lists.values() {
            let mut ids = BTreeSet::new();
            if todos.len() > 200
                || todos.iter().any(|t| {
                    !valid_id(&t.id)
                        || !ids.insert(&t.id)
                        || t.text.trim().is_empty()
                        || t.text.chars().count() > 500
                })
            {
                return Err("Invalid plugin Todo state".into());
            }
        }
        if state.notes.values().any(|s| s.chars().count() > 32000) {
            return Err("Plugin notes exceed 32000 characters".into());
        }
        Ok(state)
    }

    pub fn ui_state_get(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
    ) -> Result<UiPanelState, String> {
        self.mutate(|| {
            let panel = self.ui_panel(name, panel_id)?;
            let session_id = scoped_session(&panel, session_id)?;
            let path = self.ui_state_path(name, panel_id, session_id)?;
            self.read_ui_state(&path, name, &panel, session_id)
        })
    }

    /// Replace what one widget holds, as the agent does: no revision to
    /// present, the latest write wins. A panel the user has open sees its own
    /// revision go stale and reloads before it can save over this.
    pub fn ui_widget_set(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
        widget_id: &str,
        value: serde_json::Value,
    ) -> Result<UiPanelState, String> {
        let action = UiAction::WidgetSet {
            widget_id: widget_id.into(),
            value,
        };
        self.ui_apply(name, panel_id, session_id, None, action)
    }

    pub fn ui_state_update(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
        expected_revision: u64,
        action: UiAction,
    ) -> Result<UiPanelState, String> {
        self.ui_apply(name, panel_id, session_id, Some(expected_revision), action)
    }

    fn ui_apply(
        &self,
        name: &str,
        panel_id: &str,
        session_id: &str,
        expected_revision: Option<u64>,
        action: UiAction,
    ) -> Result<UiPanelState, String> {
        // The same cross-process lock covers enablement, integrity validation,
        // read/modify/write and atomic publication; disabling wins before later actions.
        self.mutate(|| {
            let panel = self.ui_panel(name, panel_id)?;
            let session_id = scoped_session(&panel, session_id)?;
            let path = self.ui_state_path(name, panel_id, session_id)?;
            let mut state = self.read_ui_state(&path, name, &panel, session_id)?;
            if expected_revision.is_some_and(|expected| state.revision != expected) {
                return Err(
                    "Plugin UI state changed in another window; reload before saving".into(),
                );
            }
            let next_revision = state
                .revision
                .checked_add(1)
                .filter(|r| *r <= MAX_UI_REVISION)
                .ok_or("UI revision limit reached")?;
            let (widget_id, allowed): (&String, fn(&UiWidget) -> bool) = match &action {
                UiAction::TodoAdd { widget_id, .. }
                | UiAction::TodoSetCompleted { widget_id, .. }
                | UiAction::TodoRemove { widget_id, .. } => {
                    (widget_id, |w| matches!(w, UiWidget::TodoList { .. }))
                }
                UiAction::NotesSet { widget_id, .. } => {
                    (widget_id, |w| matches!(w, UiWidget::Notes { .. }))
                }
                UiAction::WidgetSet { widget_id, .. } => (widget_id, |w| w.data_shape().is_some()),
            };
            let Some(widget) = panel.widget(widget_id).filter(|w| allowed(w)) else {
                return Err("Action is not allowed for this UI widget".into());
            };
            match action {
                UiAction::WidgetSet { widget_id, value } => {
                    let expected = |error: String| {
                        format!(
                            "The {} widget {widget_id} takes {}: {error}",
                            widget.type_name(),
                            widget.data_shape().unwrap_or_default()
                        )
                    };
                    let outside = || expected("a value is outside the limits".into());
                    match widget {
                        UiWidget::TodoList { .. } => {
                            let items: Vec<TodoInput> = parse(&value).map_err(expected)?;
                            if items.len() > MAX_TODOS
                                || items.iter().any(|item| !short(&item.text, MAX_TODO_CHARS))
                            {
                                return Err(outside());
                            }
                            let todos = items
                                .into_iter()
                                .enumerate()
                                .map(|(index, item)| UiTodo {
                                    id: format!("t{next_revision}-{index}"),
                                    text: item.text.trim().into(),
                                    completed: item.completed,
                                })
                                .collect();
                            state.todo_lists.insert(widget_id, todos);
                        }
                        UiWidget::Notes { .. } => {
                            let text: String = parse(&value).map_err(expected)?;
                            if text.chars().count() > MAX_LONG_TEXT_CHARS {
                                return Err(outside());
                            }
                            state.notes.insert(widget_id, text);
                        }
                        _ => {
                            check_data(widget, &value).map_err(expected)?;
                            state.data.insert(widget_id, value);
                        }
                    }
                }
                UiAction::TodoAdd { widget_id, text } => {
                    let text = text.trim();
                    if text.is_empty() || text.chars().count() > 500 {
                        return Err("Todo text must contain 1..500 characters".into());
                    }
                    let todos = state.todo_lists.entry(widget_id).or_default();
                    if todos.len() >= 200 {
                        return Err("A Todo list can contain at most 200 items".into());
                    }
                    todos.push(UiTodo {
                        id: format!("t{next_revision}"),
                        text: text.into(),
                        completed: false,
                    });
                }
                UiAction::TodoSetCompleted {
                    widget_id,
                    item_id,
                    completed,
                } => {
                    let todo = state
                        .todo_lists
                        .entry(widget_id)
                        .or_default()
                        .iter_mut()
                        .find(|t| t.id == item_id)
                        .ok_or("Todo item no longer exists")?;
                    todo.completed = completed;
                }
                UiAction::TodoRemove { widget_id, item_id } => {
                    let todos = state.todo_lists.entry(widget_id).or_default();
                    let index = todos
                        .iter()
                        .position(|t| t.id == item_id)
                        .ok_or("Todo item no longer exists")?;
                    todos.remove(index);
                }
                UiAction::NotesSet { widget_id, text } => {
                    if text.chars().count() > 32000 {
                        return Err("Plugin notes exceed 32000 characters".into());
                    }
                    state.notes.insert(widget_id, text);
                }
            }
            state.revision = next_revision;
            let saved = StoredState {
                schema_version: 1,
                plugin_name: name.into(),
                panel_id: panel_id.into(),
                session_id: session_id.into(),
                state: state.clone(),
            };
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_UI_STATE_BYTES {
                return Err("Plugin UI state exceeds 2 MiB".into());
            }
            crate::atomic_file::write_replace_unlocked(&path, &bytes).map_err(|e| e.to_string())?;
            Ok(state)
        })
    }
}

/// The session a panel's data is stored under: the conversation's own, or the
/// empty id every conversation shares when the panel is project-scoped.
fn scoped_session<'a>(panel: &UiPanel, session_id: &'a str) -> Result<&'a str, String> {
    match panel.scope {
        UiScope::Project => Ok(""),
        UiScope::Session if session_id.is_empty() => {
            Err("A valid local session id is required".into())
        }
        UiScope::Session => Ok(session_id),
    }
}
