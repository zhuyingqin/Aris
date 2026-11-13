//! What an agent needs to write a package itself: the rules the validators
//! apply, read from the constants they use, a fix hint for every diagnostic
//! code, and starter packages that pass preview as they are.
//!
//! Nothing here installs or approves anything. An authored package is an
//! ordinary package: it goes through the same preview, install and Desktop
//! approval as one a person imports, so there is one lifecycle, not two.

use serde::Serialize;

use super::{dsh, ui, Diagnostic, MAX_BYTES, MAX_DEPTH, MAX_FILES};

/// Where agents put packages they are writing, relative to the project root.
/// Any directory in the workspace works; this keeps drafts out of research
/// files. Installation snapshots the bytes, so the draft stays editable.
pub const PLUGIN_DRAFTS_DIR: &str = ".somniq/plugin-drafts";

/// One sentence per diagnostic code on how to fix it.
const DIAGNOSTIC_HINTS: &[(&str, &str)] = &[
    ("package", "Fix package.json at the package root: valid JSON, a lowercase npm name such as @local/my-plugin, and an exact SemVer version such as 0.1.0."),
    ("manifest", "Set dsh.bundle.patch in package.json to a package-relative YAML file such as ./cordis.patch.yml, or an ordered array of them."),
    ("manifest-version", "Set dsh.manifestVersion to 1, or leave it out."),
    ("client", "Remove dsh.client: SomniQ does not load plugin JavaScript; declare panels in somniq.ui instead."),
    ("platform", "Remove dsh.bundle.platforms, or list Node platform names that include this computer's (win32, darwin or linux)."),
    ("patch", "Each patch file must exist in the package and be a plain YAML sequence of rows: no !! tags, %TAG directives or ${} templates."),
    ("patch-target", "Add new rows with a top-level `- insert:` list; an override or targeted insert must name the id of a row inserted earlier."),
    ("patch-name", "A name-qualified override must use the same name as the row it overrides, or leave name out."),
    ("group-replacement", "Change a group by inserting into it (`- id: <group>` with `insert:`), not by overriding its config or group fields."),
    ("entry", "Each row must be an object; disabled and group, when present, must be true or false."),
    ("host-options", "Rows may only carry id, name, config, group and disabled."),
    ("group", "A group row's config must be an array of rows."),
    ("capability", "Only @deepseek-ai/dsh-skill-filesystem and @deepseek-ai/dsh-mcp-client rows are supported; PluginManager inspect lists the config fields each accepts."),
    ("ui", "Check ui.json against PluginManager inspect: a supported slot, known widget types with only their own fields, unique ids, and text within the limits."),
    ("duplicate-capability", "Give every skill and every MCP serverName in the package a different name."),
    ("empty", "Add at least one skill (dsh-skill-filesystem row), MCP server (dsh-mcp-client row) or somniq.ui panel."),
    ("skill-alias", "Rename the skill: its name is reserved by a SomniQ skill alias."),
    ("skill-builtin", "Rename the skill directory and its frontmatter name to something not in PluginManager inspect's built-in skill list."),
    ("integrity", "The installed copy is missing or was modified; remove the plugin and install it again from its source directory."),
    ("approvals", "This computer's plugin approvals file is unreadable; the user has to repair or remove it."),
    ("approval-required", "Only the user can approve a package, by turning it on in the Plugins page; ask them to."),
];

#[must_use]
pub fn hint_for(code: &str) -> Option<&'static str> {
    DIAGNOSTIC_HINTS
        .iter()
        .find(|(known, _)| *known == code)
        .map(|(_, hint)| *hint)
}

/// A preview that could not inspect the package at all (no package.json,
/// invalid name or version, symlinks, size) as a diagnostic, so an author gets
/// the same shape and a hint either way.
#[must_use]
pub fn preview_failure(error: &str) -> Diagnostic {
    let lower = error.to_ascii_lowercase();
    let mut diagnostic = Diagnostic::error("package", error);
    let hint = if lower.contains("symlink") || lower.contains("non-regular") {
        Some("Copy the files into the package directory instead of linking them.")
    } else if lower.contains("exceeds") {
        Some("Keep the package under the file, size and depth limits PluginManager inspect lists; leave data and build output out of it.")
    } else if lower.contains("regular local package directory")
        || lower.contains("cannot find")
        || lower.contains("not found")
    {
        Some("Pass the package directory itself (the folder that contains package.json).")
    } else {
        None
    };
    if let Some(hint) = hint {
        diagnostic.hint = Some(hint.into());
    } else {
        diagnostic.file = Some("package.json".into());
    }
    diagnostic
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoringContract {
    pub draft_directory: &'static str,
    pub package: PackageRules,
    pub dsh: DshRules,
    pub skills: SkillRules,
    pub ui: UiRules,
    pub templates: Vec<TemplateSummary>,
    pub diagnostic_hints: Vec<DiagnosticHint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRules {
    pub manifest_file: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub max_files: usize,
    pub max_bytes: usize,
    pub max_depth: usize,
    pub rules: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRules {
    pub manifest_version: u32,
    pub patch: &'static str,
    pub yaml: &'static str,
    pub row_keys: &'static [&'static str],
    pub platforms: &'static [&'static str],
    pub rows: Vec<DshRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRow {
    pub name: &'static str,
    pub provides: &'static str,
    pub config_keys: &'static [&'static str],
    pub rules: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRules {
    pub layout: &'static str,
    pub name_pattern: &'static str,
    pub frontmatter: &'static str,
    /// Names a plugin skill must not use (case-insensitive).
    pub built_in: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRules {
    pub manifest: &'static str,
    pub manifest_version: u32,
    pub schema_version: u32,
    pub slots: &'static [&'static str],
    /// What each slot is, and what it asks of a panel.
    pub slot: &'static str,
    /// The values a panel's optional `icon` may take.
    pub icons: &'static [&'static str],
    pub widgets: Vec<UiWidgetRule>,
    pub max_panels: usize,
    pub max_widgets_per_panel: usize,
    pub id_pattern: String,
    pub max_title_chars: usize,
    pub max_text_chars: usize,
    pub text: &'static str,
    pub panel_fields: &'static [&'static str],
    /// A panel's optional `page`: HTML of the package that draws the panel.
    pub page: &'static str,
    pub max_page_bytes: usize,
    /// Panel `scope` values: whose data the panel shows.
    pub scopes: &'static [&'static str],
    pub scope: &'static str,
    /// How a panel gets its data, and who may write it.
    pub data: &'static str,
    /// What a `button`'s `action` and a `form`'s `submit.action` may be.
    pub click_actions: Vec<UiClickRule>,
    pub form_inputs: &'static [&'static str],
    pub chart_kinds: &'static [&'static str],
    pub max_table_columns: usize,
    pub max_form_fields: usize,
    pub max_select_options: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiWidgetRule {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub fields: &'static [&'static str],
    /// Who puts content in the widget.
    pub filled_by: &'static str,
    /// The JSON `PluginPanel` write takes for this widget; absent when the
    /// widget holds no data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<&'static str>,
    /// One complete widget of this type, valid as written.
    pub example: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiClickRule {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub shape: &'static str,
}

/// One valid widget of each type, in the order of [`ui::UI_WIDGET_TYPES`].
fn widget_example(kind: &str) -> serde_json::Value {
    use serde_json::json;
    match kind {
        "todo-list" => json!({"id": "next-steps", "type": "todo-list", "title": "Next steps"}),
        "notes" => json!({"id": "notes", "type": "notes", "title": "Notes"}),
        "agent-plan" => json!({"id": "plan", "type": "agent-plan", "title": "Agent plan"}),
        "text" => json!({"id": "intro", "type": "text", "text": "What this panel is for."}),
        "table" => json!({"id": "runs", "type": "table", "title": "Runs", "columns": [
            {"key": "name", "title": "Run"}, {"key": "accuracy", "title": "Accuracy"}
        ]}),
        "metrics" => json!({"id": "summary", "type": "metrics", "title": "Summary"}),
        "list" => json!({"id": "papers", "type": "list", "title": "Papers"}),
        "markdown" => json!({"id": "findings", "type": "markdown", "title": "Findings"}),
        "progress" => json!({"id": "progress", "type": "progress", "title": "Progress"}),
        "chart" => json!({"id": "loss", "type": "chart", "title": "Loss", "chart": "line"}),
        "form" => json!({"id": "new-run", "type": "form", "title": "New run", "fields": [
            {"key": "dataset", "label": "Dataset", "input": "text"},
            {"key": "split", "label": "Split", "input": "select", "options": ["train", "test"]}
        ], "submit": {"label": "Plan the run", "action": {
            "type": "prompt", "text": "Plan a run on {{dataset}} using the {{split}} split."
        }}}),
        "button" => json!({"id": "refresh", "type": "button", "label": "Refresh", "action": {
            "type": "prompt", "text": "Refresh this panel from the latest results.", "send": true
        }}),
        "json" => json!({"id": "cards", "type": "json", "title": "Board cards"}),
        _ => serde_json::Value::Null,
    }
}

fn lookup(table: &'static [(&'static str, &'static str)], kind: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(known, _)| *known == kind)
        .map(|(_, value)| *value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticHint {
    pub code: &'static str,
    pub hint: &'static str,
}

/// The rules preview enforces, built from the validators' own constants.
#[must_use]
pub fn authoring_contract() -> AuthoringContract {
    let mut built_in: Vec<&'static str> = crate::BUNDLED_SKILLS.iter().map(|(name, _)| *name).collect();
    built_in.sort_unstable();
    AuthoringContract {
        draft_directory: PLUGIN_DRAFTS_DIR,
        package: PackageRules {
            manifest_file: "package.json",
            name: "An npm name: lowercase letters, digits, '-', '_' or '.', optionally scoped as @scope/name (for example @local/hypothesis-log). Installing a second package with the same name is an upgrade.",
            version: "An exact SemVer version such as 0.1.0. Raise it for each new version.",
            max_files: MAX_FILES,
            max_bytes: MAX_BYTES,
            max_depth: MAX_DEPTH,
            rules: vec![
                "No symlinks or Windows junctions anywhere in the package.",
                "package.json scripts never run; there is no npm install or build step.",
                "Every file is hashed. The installed snapshot of those bytes is what runs, so editing the draft afterwards changes nothing until it is upgraded.",
                "A package may combine skills, MCP servers and somniq.ui panels.",
            ],
        },
        dsh: DshRules {
            manifest_version: 1,
            patch: "package.json `dsh.bundle.patch`: a package-relative YAML file, or an ordered array of them, each a YAML sequence of patch rows. `- insert: [rows]` adds rows; `- id: <row>` with fields overrides an earlier row and replaces those fields whole.",
            yaml: "Plain YAML only: no !! tags (so no !!js), no %TAG directives, no ${} templates.",
            row_keys: dsh::ROW_KEYS,
            platforms: dsh::NODE_PLATFORMS,
            rows: vec![
                DshRow {
                    name: dsh::SKILL_FILESYSTEM,
                    provides: "Skills from directories inside the package.",
                    config_keys: dsh::SKILL_CONFIG_KEYS,
                    rules: vec![
                        "includeDefaultRoots must be false; SomniQ supplies the user and project skill roots itself.".into(),
                        "customSkillDirs lists package-relative directories; each holds <name>/SKILL.md bundles, which may carry references/, scripts/ and assets/.".into(),
                    ],
                },
                DshRow {
                    name: dsh::MCP_CLIENT,
                    provides: "One MCP server the agent can call as mcp__<prefix>__<tool>.",
                    config_keys: dsh::MCP_CONFIG_KEYS,
                    rules: vec![
                        format!("transport must be one of: {}.", dsh::MCP_TRANSPORTS.join(", ")),
                        format!("serverName must match [A-Za-z0-9_-]{{1,{}}} and be unique in the package.", dsh::MAX_MCP_SERVER_NAME),
                        "command is required. A command or argument starting with ./ resolves inside the installed snapshot; anything else is passed as written and runs with the project as its working directory.".into(),
                        "env values are literal strings: never put secrets in the package; ${} credential templates are not supported.".into(),
                        format!("toolCallTimeoutMs, when set, must be 1..{}.", dsh::MAX_TOOL_CALL_TIMEOUT_MS),
                    ],
                },
            ],
        },
        skills: SkillRules {
            layout: "<customSkillDir>/<name>/SKILL.md",
            name_pattern: "[A-Za-z0-9_-]+, the directory name",
            frontmatter: "Optional YAML between --- lines. name, when present, must equal the directory name; write a description of when to use the skill. disable-model-invocation and user-invocable are not supported.",
            built_in,
        },
        ui: UiRules {
            manifest: "package.json `somniq`: { \"manifestVersion\": 1, \"ui\": \"./ui.json\" }",
            manifest_version: ui::UI_MANIFEST_VERSION,
            schema_version: ui::UI_SCHEMA_VERSION,
            slots: ui::UI_SLOTS,
            slot: "chat.sidebar: a tab beside the conversation (a page there is about 320-480 px wide). chat.brief (schemaVersion 3): a small glance at the top of the Chat's project summary, about 280-340 px wide; it must set \"scope\": \"project\", takes only small widgets (text, metrics, progress, list, markdown, button, todo-list, json), and a page there is as tall as it asks with somniq.resize (40-320 px); the user can fold it, and its header offers Open when its dataPanel is a nav.page panel. nav.page: a page of its own, opened from an icon in the app's navigation rail and laid out in columns; it must set \"scope\": \"project\", cannot hold an agent-plan widget, and its buttons and forms take the user back to Chat with the prompt in the composer. The rail shows the first three pages of a project and lists the rest under More.",
            icons: ui::UI_ICONS,
            widgets: ui::UI_WIDGET_TYPES
                .iter()
                .map(|(kind, fields)| UiWidgetRule {
                    kind,
                    fields,
                    filled_by: lookup(ui::UI_WIDGET_SOURCES, kind).unwrap_or_default(),
                    value: lookup(ui::UI_DATA_SHAPES, kind),
                    example: widget_example(kind),
                })
                .collect(),
            max_panels: ui::MAX_UI_PANELS,
            max_widgets_per_panel: ui::MAX_UI_WIDGETS,
            id_pattern: format!("[A-Za-z0-9_-]{{1,{}}}", ui::MAX_UI_ID_LEN),
            max_title_chars: ui::MAX_UI_TITLE_CHARS,
            max_text_chars: ui::MAX_UI_TEXT_CHARS,
            text: "A string, or { \"en\": \"...\", \"cn\": \"...\" } with both languages. Shown as plain text with line breaks kept.",
            panel_fields: &["id", "slot", "title", "icon", "order", "scope", "page", "dataPanel", "widgets"],
            page: "Optional, schemaVersion 3, in either slot: a package-relative .html file (UTF-8, at most 1 MiB) that draws the whole panel itself, with its own HTML, CSS and JavaScript, instead of the host drawing the widgets. It may link other package files by relative path and they are inlined before it loads: <link rel=stylesheet> (with @import and url()), <script src>, <img src>/srcset, poster and CSS fonts; vendor libraries as package files. ES modules are .mjs files imported as \"pkg:<package-relative path>\" (relative module imports do not resolve). Scripts read other files with somniq.asset(path) (a data: URL) and somniq.text(path) (text), path relative to the page. These files together (js, mjs, css, html, json, txt, csv, md, images, fonts, audio, video, wasm) may be up to 12 MiB. It runs in a sandboxed frame with no network, no storage and no access to the app; anything it loads from a URL is blocked. The panel's widgets are then its data stores (usually one or more json widgets; none is allowed for a page that keeps no data). The page talks to the host only through window.somniq: `await somniq.ready()` gives { language: \"en\" | \"cn\", theme: { mode, colors }, data: { <widget id>: value } }; `await somniq.set(widgetId, value)` saves one widget's value in that widget's shape and rejects with the reason when it does not fit; `await somniq.data()` re-reads; `somniq.onData(fn)` and `somniq.onTheme(fn)` are called on changes, including the agent's PluginPanel writes; `somniq.prompt(text)` puts text in the Chat composer for the user to send (a page never sends a message itself); `somniq.openFile(path)` opens a project-relative file beside the chat; `somniq.openPanel(panelId)` opens a nav.page panel of the same package; `somniq.resize(px)` sets the height of a chat.brief glance (ignored elsewhere). A panel with a page may set `dataPanel` to the id of another panel of the same package with the same scope: it then declares no widgets and its page reads and writes that panel's widgets, so a glance and the full page show one store, and a save in either reaches the other through onData. Theme colors are set on <html> as CSS variables --somniq-bg, --somniq-surface, --somniq-raised, --somniq-border, --somniq-text, --somniq-muted, --somniq-accent and --somniq-font, with data-theme=\"light\" | \"dark\"; use them so the page follows the app's theme. Treat widget values as untrusted input: build DOM with textContent, never innerHTML.",
            max_page_bytes: ui::MAX_UI_PAGE_BYTES,
            scopes: ui::UI_SCOPES,
            scope: "Optional, default session: each conversation has its own copy of the panel's data. project: one copy shared by every conversation of the project, for a board that outlives a chat.",
            data: "A panel shows data; it does not compute it. The agent reads and fills the widgets with the PluginPanel tool (list, read, write), each write replacing one widget's value in the shape given as that widget's `value` here. Nothing in the package runs outside a panel's own page, and a page can only draw and store data: to compute something, the agent does the work (with its own tools or the package's MCP server) and writes the result. A button or form starts that work by putting a prompt in the composer.",
            click_actions: ui::UI_CLICK_ACTIONS
                .iter()
                .map(|(kind, shape)| UiClickRule { kind, shape })
                .collect(),
            form_inputs: ui::UI_INPUT_KINDS,
            chart_kinds: ui::UI_CHART_KINDS,
            max_table_columns: ui::MAX_UI_COLUMNS,
            max_form_fields: ui::MAX_UI_FIELDS,
            max_select_options: ui::MAX_UI_OPTIONS,
        },
        templates: TEMPLATES.iter().map(TemplateSummary::of).collect(),
        diagnostic_hints: DIAGNOSTIC_HINTS
            .iter()
            .map(|(code, hint)| DiagnosticHint { code, hint })
            .collect(),
    }
}

/// A starter package that passes preview unchanged.
struct PluginTemplate {
    id: &'static str,
    description: &'static str,
    files: &'static [(&'static str, &'static str)],
}

/// Replaced with the Python launcher this platform has on PATH by default.
const PYTHON_PLACEHOLDER: &str = "__PYTHON__";

const TEMPLATES: &[PluginTemplate] = &[
    PluginTemplate {
        id: "chat-panel",
        description: "A Chat sidebar panel (somniq.ui) with text, a to-do list, notes and the agent's plan.",
        files: &[
            ("package.json", include_str!("templates/chat-panel/package.json")),
            ("ui.json", include_str!("templates/chat-panel/ui.json")),
        ],
    },
    PluginTemplate {
        id: "data-panel",
        description: "A project-wide board (somniq.ui) the agent fills with PluginPanel: metrics, a table, a chart, Markdown findings, and a form and a button that hand work to the agent.",
        files: &[
            ("package.json", include_str!("templates/data-panel/package.json")),
            ("ui.json", include_str!("templates/data-panel/ui.json")),
        ],
    },
    PluginTemplate {
        id: "page-panel",
        description: "A project page (somniq.ui, schemaVersion 3) drawn by the package's own HTML, CSS and JavaScript in a sandboxed frame: a drag-and-drop board that stores its cards in a json widget the agent can also fill.",
        files: &[
            ("package.json", include_str!("templates/page-panel/package.json")),
            ("ui.json", include_str!("templates/page-panel/ui.json")),
            ("page.html", include_str!("templates/page-panel/page.html")),
        ],
    },
    PluginTemplate {
        id: "todo-workspace",
        description: "Project tasks (somniq.ui, schemaVersion 3): a page with list, board, calendar and timeline views, quick add (#tag !high @fri), a detail drawer with steps and notes, and a glance in the Chat's project summary (chat.brief) that shares the same tasks through dataPanel. Pages are split into HTML, CSS and ES modules that share one model.",
        files: &[
            ("package.json", include_str!("templates/todo-workspace/package.json")),
            ("ui.json", include_str!("templates/todo-workspace/ui.json")),
            ("todo/model.mjs", include_str!("templates/todo-workspace/todo/model.mjs")),
            ("todo/index.html", include_str!("templates/todo-workspace/todo/index.html")),
            ("todo/todo.css", include_str!("templates/todo-workspace/todo/todo.css")),
            ("todo/app.mjs", include_str!("templates/todo-workspace/todo/app.mjs")),
            ("todo/glance.html", include_str!("templates/todo-workspace/todo/glance.html")),
        ],
    },
    PluginTemplate {
        id: "skill-pack",
        description: "Skills the agent loads with the Skill tool, from a dsh-skill-filesystem row.",
        files: &[
            ("package.json", include_str!("templates/skill-pack/package.json")),
            ("cordis.patch.yml", include_str!("templates/skill-pack/cordis.patch.yml")),
            (
                "skills/example-checklist/SKILL.md",
                include_str!("templates/skill-pack/skills/example-checklist/SKILL.md"),
            ),
        ],
    },
    PluginTemplate {
        id: "mcp-stdio-python",
        description: "A stdio MCP server in Python using only the standard library, with one ping tool to extend.",
        files: &[
            ("package.json", include_str!("templates/mcp-stdio-python/package.json")),
            ("cordis.patch.yml", include_str!("templates/mcp-stdio-python/cordis.patch.yml")),
            ("server.py", include_str!("templates/mcp-stdio-python/server.py")),
        ],
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: &'static str,
    pub description: &'static str,
    pub files: Vec<&'static str>,
}

impl TemplateSummary {
    fn of(template: &PluginTemplate) -> Self {
        Self {
            id: template.id,
            description: template.description,
            files: template.files.iter().map(|(path, _)| *path).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    /// Package-relative, with forward slashes.
    pub path: &'static str,
    pub content: String,
}

/// The files of template `id`, ready to write into a draft directory.
#[must_use]
pub fn plugin_template(id: &str) -> Option<Vec<TemplateFile>> {
    let template = TEMPLATES.iter().find(|template| template.id == id)?;
    Some(
        template
            .files
            .iter()
            .map(|(path, content)| TemplateFile {
                path,
                content: content.replace(PYTHON_PLACEHOLDER, python_command()),
            })
            .collect(),
    )
}

#[must_use]
pub fn plugin_template_ids() -> Vec<&'static str> {
    TEMPLATES.iter().map(|template| template.id).collect()
}

fn python_command() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::super::{PluginPreview, PluginStore};
    use super::*;

    fn store(temp: &tempfile::TempDir) -> PluginStore {
        PluginStore::with_user_root(
            temp.path().join("project"),
            temp.path().join("somniq-config").join("plugins"),
        )
    }

    fn write_template(root: &Path, id: &str) -> PathBuf {
        let dir = root.join("drafts").join(id);
        for file in plugin_template(id).unwrap() {
            write(&dir, file.path, &file.content);
        }
        dir
    }

    fn write(dir: &Path, file: &str, content: &str) {
        let path = dir.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn preview(store: &PluginStore, dir: &Path) -> PluginPreview {
        store.preview(dir).unwrap()
    }

    #[test]
    fn every_template_previews_without_a_single_diagnostic() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let ids = plugin_template_ids();
        assert_eq!(
            ids,
            ["chat-panel", "data-panel", "page-panel", "todo-workspace", "skill-pack", "mcp-stdio-python"]
        );
        for id in ids {
            let dir = write_template(temp.path(), id);
            let preview = preview(&store, &dir);
            assert!(preview.can_enable, "{id}: {:?}", preview.diagnostics);
            assert!(
                preview.diagnostics.is_empty(),
                "{id}: {:?}",
                preview.diagnostics
            );
            let capabilities = &preview.capabilities;
            match id {
                "chat-panel" => assert_eq!(capabilities.ui_panels.len(), 1),
                "data-panel" => {
                    assert_eq!(capabilities.ui_panels.len(), 1);
                    assert_eq!(capabilities.ui_panels[0].scope, ui::UiScope::Project);
                }
                "page-panel" => {
                    assert_eq!(capabilities.ui_panels.len(), 1);
                    assert_eq!(capabilities.ui_panels[0].page.as_deref(), Some("./page.html"));
                }
                "todo-workspace" => {
                    let slots: Vec<_> = capabilities.ui_panels.iter().map(|p| p.slot.as_str()).collect();
                    assert_eq!(slots, ["nav.page", "chat.brief"]);
                    assert_eq!(capabilities.ui_panels[1].data_panel.as_deref(), Some("tasks"));
                    assert!(capabilities.ui_panels[1].widgets.is_empty());
                }
                "skill-pack" => assert_eq!(capabilities.skills, ["example-checklist"]),
                "mcp-stdio-python" => {
                    assert_eq!(capabilities.mcp_servers.len(), 1);
                    assert_eq!(capabilities.mcp_servers[0].command, python_command());
                }
                _ => unreachable!(),
            }
        }
        assert!(plugin_template("javascript-widget").is_none());
    }

    #[test]
    fn the_mcp_template_answers_ping_through_the_real_mcp_manager() {
        let available = crate::hidden_command(python_command())
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success());
        if !available {
            eprintln!("skipping: `{}` is not on PATH", python_command());
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let dir = write_template(temp.path(), "mcp-stdio-python");
        let preview = preview(&store, &dir);
        store.install(&dir, &preview.digest).unwrap();
        store.set_enabled(&preview.name, true).unwrap();
        let servers = store.package_mcp_servers(&preview.name).unwrap();
        assert_eq!(servers.len(), 1);
        let mut manager = crate::McpServerManager::from_servers(&servers);
        let text = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let tools = manager
                    .discover_tools()
                    .await
                    .expect("discover template tools");
                assert_eq!(tools.len(), 1, "{tools:?}");
                assert_eq!(tools[0].raw_name, "ping");
                let response = manager
                    .call_tool(&tools[0].qualified_name, Some(serde_json::json!({})))
                    .await
                    .expect("call ping");
                manager.shutdown().await.expect("shutdown");
                let result = response.result.expect("ping result");
                assert_ne!(result.is_error, Some(true));
                result.content[0].data["text"].clone()
            });
        assert_eq!(text, "pong");
    }

    #[test]
    fn every_diagnostic_code_the_validators_emit_has_a_hint() {
        let sources = [
            include_str!("mod.rs"),
            include_str!("dsh.rs"),
            include_str!("ui.rs"),
            include_str!("upgrade.rs"),
            include_str!("lifecycle.rs"),
            include_str!("authoring.rs"),
        ];
        // Built at runtime so this test's own text is not a match.
        let needle = format!("{}::error(", "Diagnostic");
        let mut codes = vec![];
        for source in sources {
            for (start, _) in source.match_indices(&needle) {
                let rest = source[start + needle.len()..].trim_start();
                if let Some(quoted) = rest.strip_prefix('"') {
                    let code = quoted.split('"').next().unwrap();
                    assert!(
                        code.bytes().all(|c| c.is_ascii_lowercase() || c == b'-'),
                        "unexpected code {code:?}"
                    );
                    codes.push(code.to_string());
                }
            }
        }
        assert!(codes.len() > 15, "scan found only {codes:?}");
        let listed: Vec<_> = authoring_contract()
            .diagnostic_hints
            .iter()
            .map(|hint| hint.code)
            .collect();
        for code in &codes {
            assert!(hint_for(code).is_some(), "diagnostic code {code} has no hint");
            assert!(listed.contains(&code.as_str()), "{code} missing from inspect");
        }
    }

    #[test]
    fn the_contract_reports_the_limits_preview_enforces() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let contract = authoring_contract();
        assert_eq!(contract.draft_directory, PLUGIN_DRAFTS_DIR);
        assert_eq!(contract.ui.slots, ["chat.sidebar", "nav.page", "chat.brief"]);
        let dir = write_template(temp.path(), "chat-panel");
        let base: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("ui.json")).unwrap()).unwrap();
        let ui_with = |edit: &dyn Fn(&mut serde_json::Value)| {
            let mut value = base.clone();
            edit(&mut value);
            fs::write(dir.join("ui.json"), serde_json::to_vec(&value).unwrap()).unwrap();
            preview(&store, &dir).can_enable
        };
        let text = |chars: usize| serde_json::Value::String("x".repeat(chars));
        let max_title = contract.ui.max_title_chars;
        assert!(ui_with(&|v| v["panels"][0]["title"] = text(max_title)));
        assert!(!ui_with(&|v| v["panels"][0]["title"] = text(max_title + 1)));
        let max_text = contract.ui.max_text_chars;
        assert!(ui_with(&|v| v["panels"][0]["widgets"][0]["text"] = text(max_text)));
        assert!(!ui_with(
            &|v| v["panels"][0]["widgets"][0]["text"] = text(max_text + 1)
        ));
        let panel = base["panels"][0].clone();
        let panels = |count: usize| {
            (0..count)
                .map(|index| {
                    let mut panel = panel.clone();
                    panel["id"] = format!("panel-{index}").into();
                    panel
                })
                .collect::<Vec<_>>()
        };
        let max_panels = contract.ui.max_panels;
        assert!(ui_with(&|v| v["panels"] = panels(max_panels).into()));
        assert!(!ui_with(&|v| v["panels"] = panels(max_panels + 1).into()));
        let widgets = |count: usize| {
            (0..count)
                .map(|index| {
                    serde_json::json!({"id": format!("w{index}"), "type": "notes", "title": "Notes"})
                })
                .collect::<Vec<_>>()
        };
        let max_widgets = contract.ui.max_widgets_per_panel;
        assert!(ui_with(
            &|v| v["panels"][0]["widgets"] = widgets(max_widgets).into()
        ));
        assert!(!ui_with(
            &|v| v["panels"][0]["widgets"] = widgets(max_widgets + 1).into()
        ));
        // Every widget type the contract lists is accepted as its example,
        // which carries exactly the listed fields.
        assert_eq!(contract.ui.widgets.len(), 13);
        for rule in &contract.ui.widgets {
            let widget = rule.example.clone();
            let mut keys: Vec<&str> = widget
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            let mut fields = rule.fields.to_vec();
            keys.sort_unstable();
            fields.sort_unstable();
            assert_eq!(keys, fields, "{}", rule.kind);
            let parsed: ui::UiWidget = serde_json::from_value(widget.clone())
                .unwrap_or_else(|e| panic!("{widget}: {e}"));
            assert_eq!(parsed.type_name(), rule.kind);
            assert_eq!(parsed.data_shape(), rule.value, "{}", rule.kind);
            assert!(!rule.filled_by.is_empty(), "{}", rule.kind);
            // Free-form data is for a panel with its own page (the page-panel
            // template); a panel the host draws cannot show it.
            assert_eq!(
                ui_with(&|v| v["panels"][0]["widgets"] = serde_json::json!([widget.clone()])),
                rule.kind != "json",
                "{}",
                rule.kind
            );
        }
        for scope in contract.ui.scopes {
            assert!(ui_with(&|v| v["panels"][0]["scope"] = (*scope).into()));
        }
        assert!(!ui_with(&|v| v["panels"][0]["scope"] = "user".into()));
        // A plugin skill may not reuse a built-in name, including this one.
        assert!(contract
            .skills
            .built_in
            .contains(&"somniq-plugin-development"));
        assert_eq!(contract.skills.built_in.len(), crate::BUNDLED_SKILLS.len());
        assert_eq!(contract.dsh.rows[0].name, dsh::SKILL_FILESYSTEM);
        assert_eq!(contract.dsh.rows[1].config_keys, dsh::MCP_CONFIG_KEYS);
    }

    #[test]
    fn a_navigation_page_is_a_project_panel_with_a_host_icon() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let dir = write_template(temp.path(), "data-panel");
        let read = || -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(dir.join("ui.json")).unwrap()).unwrap()
        };
        let pointers = |ui: &serde_json::Value| -> Vec<String> {
            fs::write(dir.join("ui.json"), serde_json::to_vec(ui).unwrap()).unwrap();
            let preview = preview(&store, &dir);
            assert_eq!(preview.can_enable, preview.diagnostics.is_empty());
            preview.diagnostics.iter().filter_map(|d| d.path.clone()).collect()
        };

        let mut ui = read();
        ui["panels"][0]["slot"] = "nav.page".into();
        ui["panels"][0]["icon"] = "barChart".into();
        assert!(pointers(&ui).is_empty());
        let panel = &preview(&store, &dir).capabilities.ui_panels[0];
        assert_eq!((panel.slot.as_str(), panel.icon.as_deref()), ("nav.page", Some("barChart")));

        // An icon is a name the host draws, never a file from the package.
        ui["panels"][0]["icon"] = "./icon.svg".into();
        assert_eq!(pointers(&ui), ["/panels/0/icon"]);
        ui["panels"][0]["icon"] = "barChart".into();

        // A page belongs to the project, not to whichever chat is open.
        ui["panels"][0]["scope"] = "session".into();
        assert_eq!(pointers(&ui), ["/panels/0/scope"]);
        ui["panels"][0]["scope"] = "project".into();
        let plan = serde_json::json!({"id": "plan", "type": "agent-plan", "title": "Plan"});
        ui["panels"][0]["widgets"].as_array_mut().unwrap().push(plan);
        assert_eq!(pointers(&ui).len(), 1);
        assert!(pointers(&ui)[0].ends_with("/type"));

        // Schema 1 packages keep meaning what they meant.
        let mut old = serde_json::json!({"schemaVersion": 1, "panels": [{
            "id": "p", "slot": "nav.page", "title": "P", "icon": "grid",
            "widgets": [{"id": "n", "type": "notes", "title": "N"}],
        }]});
        assert_eq!(pointers(&old), ["/panels/0/icon", "/panels/0/slot"]);
        old["panels"][0]["slot"] = "chat.sidebar".into();
        old["panels"][0].as_object_mut().unwrap().remove("icon");
        assert!(pointers(&old).is_empty());
    }

    #[test]
    fn ui_diagnostics_list_every_problem_with_its_file_and_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let dir = write_template(temp.path(), "chat-panel");
        let mut ui: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("ui.json")).unwrap()).unwrap();
        ui["panels"][0]["slot"] = "chat.composer".into();
        ui["panels"][0]["widgets"][2]["id"] = "intro".into();
        fs::write(dir.join("ui.json"), serde_json::to_vec(&ui).unwrap()).unwrap();
        let preview = preview(&store, &dir);
        assert!(!preview.can_enable);
        assert!(preview.capabilities.ui_panels.is_empty());
        let found: Vec<_> = preview
            .diagnostics
            .iter()
            .map(|d| (d.code.as_str(), d.file.as_deref(), d.path.as_deref()))
            .collect();
        assert_eq!(
            found,
            [
                ("ui", Some("ui.json"), Some("/panels/0/slot")),
                ("ui", Some("ui.json"), Some("/panels/0/widgets/2/id")),
            ]
        );
        assert!(preview.diagnostics[0].message.contains("chat.sidebar"));
        assert!(preview.diagnostics.iter().all(|d| d.hint.is_some()));
    }

    #[test]
    fn patch_and_row_diagnostics_point_at_their_file_and_row() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let dir = write_template(temp.path(), "skill-pack");
        let row = "- insert:\n    - id: skills\n      name: '@deepseek-ai/dsh-skill-filesystem'\n      config:\n";
        write(
            &dir,
            "cordis.patch.yml",
            &format!("{row}        includeDefaultRoots: !!js true\n"),
        );
        let tagged = preview(&store, &dir);
        assert_eq!(tagged.diagnostics[0].code, "patch");
        assert_eq!(
            tagged.diagnostics[0].file.as_deref(),
            Some("cordis.patch.yml")
        );
        assert!(tagged.diagnostics[0].hint.as_deref().unwrap().contains("!!"));

        write(
            &dir,
            "cordis.patch.yml",
            &format!("{row}        includeDefaultRoots: true\n        customSkillDirs: ['./skills']\n"),
        );
        let preview = preview(&store, &dir);
        let capability = preview
            .diagnostics
            .iter()
            .find(|d| d.code == "capability")
            .unwrap();
        assert_eq!(capability.path.as_deref(), Some("skills"));
        assert!(capability.message.contains("includeDefaultRoots"));
    }

    #[test]
    fn a_package_preview_cannot_read_becomes_a_package_diagnostic() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let dir = temp.path().join("not-a-package");
        fs::create_dir_all(&dir).unwrap();
        let diagnostic = preview_failure(&store.preview(&dir).unwrap_err());
        assert_eq!(diagnostic.code, "package");
        assert_eq!(diagnostic.file.as_deref(), Some("package.json"));
        assert!(diagnostic.hint.is_some());
        write(&dir, "package.json", r#"{"name":"Bad Name","version":"1.0.0"}"#);
        let diagnostic = preview_failure(&store.preview(&dir).unwrap_err());
        assert!(diagnostic.hint.unwrap().contains("npm name"));
    }
}
