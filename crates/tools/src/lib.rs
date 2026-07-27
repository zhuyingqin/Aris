use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Bundled skills are compiled into the runtime crate and re-exported
use runtime::BUNDLED_SKILLS;

use api::{read_base_url, read_send_betas, AuthSource};
use aris_executor::{
    AnthropicRuntimeClient as SharedAnthropicRuntimeClient, ExecutorToolSpec, NoopStreamObserver,
    StreamObserver,
};
use reqwest::blocking::Client;
use runtime::{
    append_file_with_context, edit_file_with_context, get_file_change, glob_search, grep_search,
    list_file_changes, load_system_prompt, read_file, record_text_file_change, revert_file_change,
    write_file_with_context, ApiClient, ApiRequest, AssistantEvent, BashCommandInput,
    ConversationRuntime, FileChangeGetInput, FileChangeListInput, FileChangeOperation,
    FileChangeRecord, FileChangeRevertInput, FileMutationContext, GrepSearchInput, PermissionMode,
    PermissionPolicy, RuntimeError, Session, StructuredPatchHunk, TokenUsage, ToolError,
    ToolExecutor,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_WRITE_FILE_CONTENT_CHARS: usize = 24_000;
const TOOL_PROGRESS_NEAR_TIMEOUT_RATIO: f64 = 0.80;
const WORKSPACE_AUDIT_MAX_FILE_BYTES: u64 = 2_000_000;
const WORKSPACE_AUDIT_MAX_FILES: usize = 8_000;
const WORKSPACE_AUDIT_EXTENSIONS: &[&str] = &[
    "bib", "c", "cc", "conf", "cpp", "cs", "css", "csv", "go", "h", "hpp", "html", "ipynb", "java",
    "js", "json", "jsx", "kt", "latex", "lua", "md", "mjs", "mmd", "py", "r", "rs", "scss", "sh",
    "sql", "svg", "tex", "toml", "ts", "tsx", "txt", "yaml", "yml",
];
const WORKSPACE_AUDIT_IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".somniq",
    ".aris",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "__pycache__",
];

pub mod knowledge;
pub mod layout;
pub mod literature;
pub mod notebook;
pub mod pdf_rag;
pub mod runs;
pub mod sweep;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolManifestEntry {
    pub name: String,
    pub source: ToolSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSource {
    Base,
    Conditional,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolRegistry {
    entries: Vec<ToolManifestEntry>,
}

impl ToolRegistry {
    #[must_use]
    pub fn new(entries: Vec<ToolManifestEntry>) -> Self {
        Self { entries }
    }

    #[must_use]
    pub fn entries(&self) -> &[ToolManifestEntry] {
        &self.entries
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub required_permission: PermissionMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolProgress {
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    pub pid: Option<u32>,
    #[serde(rename = "stdoutTail")]
    pub stdout_tail: Option<String>,
    #[serde(rename = "stderrTail")]
    pub stderr_tail: Option<String>,
    #[serde(rename = "nearTimeout")]
    pub near_timeout: bool,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolRunContext {
    pub tool_use_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

impl ToolRunContext {
    #[must_use]
    pub fn new(tool_use_id: impl Into<Option<String>>) -> Self {
        Self {
            tool_use_id: tool_use_id.into(),
            session_id: None,
            turn_id: None,
        }
    }

    fn mutation_context(&self, tool_name: &str) -> FileMutationContext {
        let mut context =
            FileMutationContext::from_env(tool_name).with_tool_use_id(self.tool_use_id.clone());
        if self
            .session_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            context.session_id = self.session_id.clone();
        }
        if self
            .turn_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            context.turn_id = self.turn_id.clone();
        }
        context
    }
}

pub fn mvp_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "bash",
            description: concat!(
                "Execute a shell command in the current workspace for shell semantics, package managers, build/test runners, scripts, and process control. ",
                "Prefer dedicated tools when they fit: read_file for known-path reads, glob_search for file discovery, grep_search for content search, and write_file/append_file/edit_file for file changes. ",
                "Do not use shell redirection, heredocs, sed/awk in-place edits, or ad hoc scripts to modify files unless a justified bulk mechanical rewrite is safer than edit_file. ",
                "Foreground commands default to a 120000 ms timeout; pass a larger timeout for legitimately long work. ",
                "Use run_in_background only for long-running services or watchers whose immediate output is not needed; include a short description and do not start duplicate background processes. ",
                "Run independent read-only investigations as separate parallel tool calls instead of chaining them with separators; chain commands only when they genuinely depend on each other."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout": { "type": "integer", "minimum": 1, "description": "Timeout in milliseconds for foreground commands. Defaults to 120000." },
                    "description": { "type": "string" },
                    "run_in_background": { "type": "boolean" },
                    "dangerouslyDisableSandbox": {
                        "type": "boolean",
                        "description": "Request that this single command bypass the sandbox. Honored only when the runtime config has `sandbox.strictMode != true`. When `sandbox.strictMode: true` is set by the user, this field is ignored and the runtime emits a warning. Default false."
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "read_file",
            description: "Read a text file or extract readable text from a PDF in the workspace. Large files without offset/limit return a safe outline preview; use offset and limit to read one section window at a time.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "WorkspaceLayout",
            description: "Return the canonical SomniQ project output layout: where to place slides/PPTs, posters, web apps, notebooks, run artifacts, and scratch files.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "write_file",
            description: concat!(
                "Write a complete text file in the workspace. Use write_file for new files, full replacements, or generated content with little continuity from an existing file; read the target first before overwriting an existing path. ",
                "For incremental edits to existing files, prefer edit_file; do not use write_file, append_file, shell redirection, heredocs, or scripts for small localized changes. ",
                "Place application-generated artifacts under .somniq/: papers under .somniq/papers/, slide/PPT/PDF deck outputs under .somniq/slides/, posters under .somniq/poster/, interactive web apps under .somniq/web/<name>/ with index.html plus local CSS/assets, source notebooks under .somniq/notebooks/, run artifacts under .somniq/experiments/runs/, and scratch/temp/cache files under .somniq/tmp/. Preserve a user-specified existing path in place. ",
                "When the user asks to modify an existing/current artifact, reuse the existing path and update it in place; do not create sibling version files such as _v2, _new, _final, or timestamped copies unless explicitly requested. ",
                "Keep content under 24000 characters in a single call; for longer generated files, write a small scaffold, append chunks with append_file, and verify the final file."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string", "maxLength": MAX_WRITE_FILE_CONTENT_CHARS }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "append_file",
            description: concat!(
                "Append one text chunk to a workspace file without returning the full file. Use append_file mainly for long generated artifacts after a small write_file scaffold; do not use it for localized edits to existing files. ",
                "For existing/current artifacts, append only to the identified existing path and do not create a new versioned sibling unless explicitly requested. ",
                "Keep generated artifacts in the same internal folders as write_file: .somniq/papers/, .somniq/slides/, .somniq/poster/, .somniq/web/<name>/, .somniq/notebooks/, .somniq/experiments/runs/, or .somniq/tmp/. ",
                "Keep content under 24000 characters; after chunked writes, verify the final file with read_file, line counts, tests, or compilation as appropriate."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string", "maxLength": MAX_WRITE_FILE_CONTENT_CHARS },
                    "create_if_missing": { "type": "boolean", "description": "Create the target file if it does not exist. Defaults to true." }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "edit_file",
            description: concat!(
                "Replace text directly in a workspace file. Use edit_file for small and medium edits to existing/current artifacts instead of write_file, append_file, new version files, shell redirection, sed/awk in-place edits, or generated helper scripts. ",
                "Read the target file first and take old_string from the current file contents, not stale memory; old_string should be unique — if it matches multiple locations the call fails unless replace_all is set. ",
                "CRLF/LF line-ending differences are matched automatically and the file's existing endings are preserved on write. ",
                "When multiple edits target the same file, apply one edit, read the file again, then make the next edit so old_string does not go stale. ",
                "It returns Codex-style structured file changes."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" },
                    "replace_all": { "type": "boolean" }
                },
                "required": ["path", "old_string", "new_string"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "change_list",
            description: "List audited file changes recorded by ARIS for the current workspace/session. Use this to inspect what GPT-created file mutations can be traced or reverted.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "change_get",
            description: "Fetch one audited file change by change_id, including exact hunks and before/after hashes.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "change_id": { "type": "string" },
                    "session_id": { "type": "string" }
                },
                "required": ["change_id"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "change_revert",
            description: "Revert one audited file change if the current file still matches the recorded after-hash. Returns a conflict instead of overwriting newer edits.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "change_id": { "type": "string" },
                    "session_id": { "type": "string" }
                },
                "required": ["change_id"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "glob_search",
            description: "Find files by glob pattern.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "grep_search",
            description: "Search file contents with a regex pattern.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" },
                    "glob": { "type": "string" },
                    "output_mode": { "type": "string" },
                    "-B": { "type": "integer", "minimum": 0 },
                    "-A": { "type": "integer", "minimum": 0 },
                    "-C": { "type": "integer", "minimum": 0 },
                    "context": { "type": "integer", "minimum": 0 },
                    "-n": { "type": "boolean" },
                    "-i": { "type": "boolean" },
                    "type": { "type": "string" },
                    "head_limit": { "type": "integer", "minimum": 1 },
                    "offset": { "type": "integer", "minimum": 0 },
                    "multiline": { "type": "boolean" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "memory",
            description: "Manage compact, durable hot memory. Save stable facts and user preferences here; use session_search for task history and Skills for reusable procedures.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["add", "replace", "remove", "list", "pending"]
                    },
                    "target": {
                        "type": "string",
                        "enum": ["memory", "user"],
                        "description": "Use user for identity/preferences; memory for stable environment and project facts."
                    },
                    "content": { "type": "string" },
                    "old_text": { "type": "string" },
                    "scope": {
                        "type": "string",
                        "enum": ["global", "project"],
                        "description": "Global applies everywhere; project applies only to the active workspace."
                    },
                    "source": {
                        "type": "string",
                        "description": "Short provenance label. Defaults to assistant_tool."
                    },
                    "expires_at": {
                        "type": "string",
                        "description": "Optional expiry date in YYYY-MM-DD format."
                    },
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "session_search",
            description: "Search or browse persisted conversation history. Use this for prior task progress, completed work, decisions, and past discussions instead of saving temporary history to hot memory.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "session_id": {
                        "type": "string",
                        "description": "Read a specific session by id."
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 },
                    "window": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 30,
                        "description": "Messages before and after each search hit."
                    }
                },
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "WebFetch",
            description:
                "Fetch a URL, convert it into readable text, and answer a prompt about it.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "format": "uri" },
                    "prompt": { "type": "string" }
                },
                "required": ["url", "prompt"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "WebSearch",
            description: "Search the web for current information and return cited results.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 2 },
                    "allowed_domains": {
                        "type": "array",
                        "items": { "type": "string" }
                    },
                    "blocked_domains": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "LiteratureSearch",
            description: "Run an explicit bounded casual metadata search across Scopus, OpenAlex, Semantic Scholar, Crossref and arXiv. It automatically creates a project-local ad-hoc SearchProtocol and durable SearchRun, then persists canonical records, request/response artifacts, quotas and failures before projecting the library view. Use the explicit ProtocolCreate → Preview → Execute workflow when the user needs to review or refine the protocol before any network request. Results are deduplicated through canonical identity. Scopus requires SCOPUS_API_KEY; Semantic Scholar can use SEMANTIC_SCHOLAR_API_KEY. Do not call LiteratureLibraryUpsert after this tool: the records are already stored and projected.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 2 },
                    "sources": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["scopus", "openalex", "semantic-scholar", "crossref", "arxiv"] },
                        "description": "Engines to query (listing order is ignored; results follow Scopus → OpenAlex → Semantic Scholar → Crossref → arXiv priority). Empty or omitted means the full bounded set."
                    },
                    "maxResults": { "type": "integer", "minimum": 1, "description": "Per-source result target (default 50). No hard ceiling — set as many as the task needs; every source, including the arXiv supplement, fetches up to this count." }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LiteratureSearchProtocolCreate",
            description: "Create a versioned, project-local literature SearchProtocol. The protocol records the research question, scope, source-specific queries, time window, eligibility criteria and known papers. This only saves a plan; call LiteratureSearchPreview and obtain explicit user confirmation before executing a network search.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "protocol": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "minLength": 2 },
                            "scope": { "type": "string" },
                            "timeWindow": { "type": "string" },
                            "databases": { "type": "array", "items": { "type": "string" } },
                            "queries": { "type": "object", "additionalProperties": { "type": "string" } },
                            "inclusionCriteria": { "type": "array", "items": { "type": "string" } },
                            "exclusionCriteria": { "type": "array", "items": { "type": "string" } },
                            "knownKeyPapers": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["question"],
                        "additionalProperties": false
                    }
                },
                "required": ["protocol"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LiteratureSearchPreview",
            description: "Preview a saved SearchProtocol before execution. Returns each effective source, complete query and adapter availability; it never performs a network request or a full export.",
            input_schema: json!({
                "type": "object",
                "properties": { "protocolId": { "type": "string", "minLength": 1 } },
                "required": ["protocolId"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "LiteratureSearchExecute",
            description: "Execute a previously previewed SearchProtocol and persist a checkpointed SearchRun, canonical records, sanitised request details, raw provider-response artifacts, quotas and source failures. Use only after the user has reviewed the preview and explicitly agreed to the bounded scope. The `confirmation` field must be exactly `execute`. A `resumeRunId` can continue only the same interrupted protocol revision.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "protocolId": { "type": "string", "minLength": 1 },
                    "confirmation": { "type": "string", "enum": ["execute"] },
                    "maxResults": { "type": "integer", "minimum": 1 },
                    "resumeRunId": { "type": "string", "minLength": 1 }
                },
                "required": ["protocolId", "confirmation"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LiteratureLibraryUpsert",
            description: "Compatibility-only refresh of the `.somniq/papers/library.json` projection. Every supplied paper must already exist in the canonical literature store under its canonical id; this tool rejects untracked records and never creates a search or imports raw results. LiteratureSearch already persists and projects its results, so normally this tool is unnecessary.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "papers": {
                        "type": "array",
                        "items": { "type": "object" },
                        "description": "Existing canonical records, identified by the exact `id` returned by LiteratureSearch or a saved protocol execution."
                    },
                    "search": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string" },
                            "sources": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["query"],
                        "additionalProperties": false,
                        "description": "Deprecated compatibility field; ignored because saved-search provenance belongs to SearchRun."
                    }
                },
                "required": ["papers"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LiteraturePdfDownload",
            description: "Download a paper PDF into `.somniq/papers/` (verifies the response is a real PDF). When paperId is given, the paper's pdf status and stage are updated in `.somniq/papers/library.json`.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "format": "uri" },
                    "fileName": { "type": "string", "description": "Target file name, e.g. the arXiv id. Sanitised; .pdf is appended when missing." },
                    "paperId": { "type": "string", "description": "Library paper id (e.g. arxiv:2602.01491) to mark as downloaded." }
                },
                "required": ["url", "fileName"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LiteratureBrowserDownloadTask",
            description: "Build a browser-download task for publisher PDFs that direct HTTP downloads cannot handle, especially IEEE Xplore and Elsevier ScienceDirect. Use this after LiteraturePdfDownload fails or when search results have no direct pdfUrl. The returned task is compatible with the paper-pdf-downloader browser_batch_download.py workflow.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paper": {
                        "type": "object",
                        "description": "One paper record from LiteratureSearch output."
                    }
                },
                "required": ["paper"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "KnowledgeSearch",
            description: "Search the project's confirmed knowledge base (papers/knowledge.db) BEFORE re-searching literature or answering from memory. Returns user-confirmed knowledge points — each with its original question, answer, condensed statement, supporting evidence (paperId, page, quote, stable anchor ids) and 1-hop relations to other points. Cite evidence as [paperId p.PAGE] so the user can jump to the exact PDF page. Only confirmed knowledge is returned; if nothing matches, fall back to literature search.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "KnowledgeUpsert",
            description: "Propose knowledge points into the project knowledge base (papers/knowledge.db). Points are always recorded as DRAFTS — this tool cannot confirm them. Confirmation happens only through the user's review UI ('AI generates, human filters'). Every point must keep its original question and answer plus a condensed statement, and carry at least one evidence anchor (paperId + page + quote). Drafts are not retrievable until the user confirms them.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "question": { "type": "string" },
                                "answer": { "type": "string" },
                                "statement": { "type": "string" },
                                "kind": { "type": "string" },
                                "sourcePaperId": { "type": "string" },
                                "evidence": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "paperId": { "type": "string" },
                                            "page": { "type": "integer" },
                                            "quote": { "type": "string" },
                                            "role": { "type": "string" },
                                            "annotationId": { "type": "string" },
                                            "evidenceId": { "type": "string" }
                                        },
                                        "required": ["paperId"],
                                        "additionalProperties": false
                                    }
                                },
                                "relations": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "dstId": { "type": "string" },
                                            "kind": { "type": "string" }
                                        },
                                        "required": ["dstId", "kind"],
                                        "additionalProperties": false
                                    }
                                }
                            },
                            "required": ["question", "answer", "statement"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["points"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LaTeXCompile",
            description: "Compile a LaTeX `.tex` root document inside the current workspace to PDF using the local TeX Live toolchain. It resolves the root file safely, selects a Unicode-capable engine for CJK/fontspec sources, handles Windows TeX paths, retries stale latexmk caches, and returns structured diagnostics plus the output PDF path. Prefer this over shelling out to pdflatex/latexmk from bash/PowerShell/REPL. On failure, make one minimal edit for diagnostics[0], then re-run this same tool; do not batch speculative source rewrites.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "inputPath": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute path to the .tex root source file."
                    },
                    "outputPath": {
                        "type": "string",
                        "description": "Optional workspace-relative or in-workspace absolute output PDF path. Defaults to the input path with .pdf extension."
                    },
                    "compiler": {
                        "type": "string",
                        "enum": ["latexmk", "xelatex", "pdflatex", "lualatex"],
                        "description": "Optional compiler override. Defaults to latexmk, then xelatex, pdflatex, and lualatex fallback."
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Foreground compile timeout in milliseconds. Defaults to the shell foreground timeout."
                    }
                },
                "required": ["inputPath"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LaTeXRender",
            description: "Render a data-driven LaTeX source from a stable .tex template and a JSON data file before compiling it with LaTeXCompile. Use {{field}} for safely TeX-escaped values and {{#each rows}}...{{/each}} for arrays; keep LaTeX structure in the template and prose/table values in JSON. This prevents data characters such as &, %, _, and # from changing TeX structure. The template is never overwritten.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "templatePath": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute .tex template path."
                    },
                    "dataPath": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute JSON data path."
                    },
                    "outputPath": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute generated .tex path. Must differ from templatePath."
                    }
                },
                "required": ["templatePath", "dataPath", "outputPath"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "NotebookExecute",
            description: "Execute code against a live Jupyter kernel bound to a notebook and capture its outputs (stdout/stderr, execute results, errors, and rich display data). Source notebooks should live under notebooks/; legacy experiments/*.ipynb paths still work. Provide cell_index to run a specific 0-based cell of the .ipynb and write its outputs + execution count back into the file (set write_back=false to skip persisting), or provide code to evaluate a snippet REPL-style without touching the file. The kernel is keyed by notebook_path and persists state across calls, so variables defined in one execute are visible to the next; it auto-starts on first use. Use this to run cells edited with NotebookEdit and iterate on errors.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "notebook_path": { "type": "string" },
                    "cell_index": { "type": "integer", "minimum": 0 },
                    "code": { "type": "string" },
                    "kernel": { "type": "string" },
                    "timeout_secs": { "type": "integer", "minimum": 1 },
                    "write_back": { "type": "boolean" }
                },
                "required": ["notebook_path"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "NotebookKernel",
            description: "Manage the Jupyter kernel for a notebook. action=status reports whether the notebook's kernel is running; action=list shows all running kernels; action=start launches it; action=restart clears all in-memory kernel state and starts fresh; action=shutdown stops it; action=interrupt raises KeyboardInterrupt in the running cell without losing kernel state (use to stop a runaway cell). notebook_path is required for every action except list.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "list", "start", "restart", "shutdown", "interrupt"]
                    },
                    "notebook_path": { "type": "string" },
                    "kernel": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "NotebookRun",
            description: "Run a whole notebook end to end against its kernel, executing every non-empty code cell in order and writing outputs back into the file. Source notebooks should live under notebooks/; parameterized executed copies and run artifacts land under experiments/runs/. Pass parameters (an object of name→value) to inject a papermill-style override cell before the first cell runs — use this to run the same notebook with different inputs. stop_on_error (default true) halts at the first failing cell. Returns per-cell status plus the worst overall status. The kernel is keyed by notebook_path and auto-starts.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "notebook_path": { "type": "string" },
                    "parameters": { "type": "object" },
                    "stop_on_error": { "type": "boolean" },
                    "timeout_secs": { "type": "integer", "minimum": 1 },
                    "kernel": { "type": "string" }
                },
                "required": ["notebook_path"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "NotebookSweep",
            description: "Run a parameter sweep of a notebook locally: expand seeds × the cartesian product of params (each name→array of values) into one run per grid point, execute each sequentially with the values injected, and record every run in experiments/runs.json (executed notebooks land under experiments/runs/<id>/). Source notebooks should live under notebooks/. Use for multi-seed / small grids on the local kernel; for heavy grids prefer handing off to the GPU via /experiment-queue. seeds is injected as `seed`; provide either seeds, params, or both.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "notebook": { "type": "string" },
                    "seeds": { "type": "array", "items": { "type": "integer" } },
                    "params": { "type": "object" },
                    "stop_on_error": { "type": "boolean" },
                    "timeout_secs": { "type": "integer", "minimum": 1 },
                    "kernel": { "type": "string" }
                },
                "required": ["notebook"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "TodoWrite",
            description: "Update the structured task list for the current session.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": { "type": "string" },
                                "activeForm": { "type": "string" },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"]
                                }
                            },
                            "required": ["content", "activeForm", "status"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["todos"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "LlmReview",
            description: "Send content to an external LLM reviewer for independent critical review. Supports OpenAI, Gemini, GLM, MiniMax, Kimi, and Anthropic-compatible endpoints. Routes by model name. Prefer omitting `model` and letting SomniQ use the user's configured reviewer.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The full content to review, including context and specific review instructions."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional model override. Prefer omitting this — ARIS will use the user's configured reviewer (ARIS_REVIEWER_MODEL). Only specify a model if you have a specific reason and know the corresponding API key is set. Examples: gpt-5.5, gemini-2.5-pro, GLM-5, MiniMax-M2.7, kimi-k2.5, claude-sonnet-4-6. If the specified model's API key is missing, ARIS falls back to the configured reviewer."
                    }
                },
                "required": ["prompt"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "Skill",
            description: "Load a local skill definition and its instructions.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "skill": { "type": "string" },
                    "args": { "type": "string" }
                },
                "required": ["skill"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "Agent",
            description: "Launch a specialized agent task and persist its handoff metadata.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "description": { "type": "string" },
                    "prompt": { "type": "string" },
                    "subagent_type": { "type": "string" },
                    "name": { "type": "string" },
                    "model": { "type": "string" }
                },
                "required": ["description", "prompt"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "ToolSearch",
            description: "Search for deferred or specialized tools by exact name or keywords.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "max_results": { "type": "integer", "minimum": 1 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "NotebookEdit",
            description: "Replace, insert, or delete a cell in a Jupyter notebook.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "notebook_path": { "type": "string" },
                    "cell_id": { "type": "string" },
                    "new_source": { "type": "string" },
                    "cell_type": { "type": "string", "enum": ["code", "markdown"] },
                    "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"] }
                },
                "required": ["notebook_path"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "Sleep",
            description: "Wait for a specified duration without holding a shell process.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "duration_ms": { "type": "integer", "minimum": 0 }
                },
                "required": ["duration_ms"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "SendUserMessage",
            description: "Send a message to the user.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                    "attachments": {
                        "type": "array",
                        "items": { "type": "string" }
                    },
                    "status": {
                        "type": "string",
                        "enum": ["normal", "proactive"]
                    }
                },
                "required": ["message", "status"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "Config",
            description: "Get or set ARIS-Code settings.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "setting": { "type": "string" },
                    "value": {
                        "type": ["string", "boolean", "number"]
                    }
                },
                "required": ["setting"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "StructuredOutput",
            description: "Return structured output in the requested format.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": true
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "REPL",
            description: concat!(
                "Execute code in a REPL-like subprocess for computation, data wrangling, and text/byte-level analysis (counting characters, inspecting encodings, transforming structured data). ",
                "Do not use this as a workaround for running external build tools, compilers, or CLI programs — use bash/PowerShell for that, and use LaTeXCompile specifically to compile a LaTeX `.tex` file to PDF instead of shelling out to pdflatex/latexmk here. ",
                "stdout/stderr are decoded as UTF-8 with a GB18030/GBK fallback for Windows console output; still prefer ASCII-safe prints when the exact byte layout matters."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string" },
                    "language": { "type": "string" },
                    "timeout_ms": { "type": "integer", "minimum": 1 }
                },
                "required": ["code", "language"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "PowerShell",
            description: concat!(
                "Execute a PowerShell command when Windows-specific shell semantics are needed. ",
                "Prefer dedicated tools when they fit: read_file for known-path reads, glob_search for file discovery, grep_search for content search, and write_file/append_file/edit_file for file changes. ",
                "Do not use shell redirection, here-strings, ad hoc scripts, or Set-Content/Add-Content for file edits unless a justified bulk mechanical rewrite is safer than edit_file. ",
                "Foreground commands default to a 120000 ms timeout; pass a larger timeout for legitimately long work. ",
                "Use run_in_background only for long-running services or watchers whose immediate output is not needed; include a short description and do not start duplicate background processes. ",
                "Run independent read-only investigations as separate parallel tool calls instead of chaining them with separators; chain commands only when they genuinely depend on each other."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout": { "type": "integer", "minimum": 1, "description": "Timeout in milliseconds for foreground commands. Defaults to 120000." },
                    "description": { "type": "string" },
                    "run_in_background": { "type": "boolean" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
    ]
}

pub fn execute_tool(name: &str, input: &Value) -> Result<String, String> {
    execute_tool_with_cancel(name, input, &|| false)
}

pub fn execute_tool_with_context(
    name: &str,
    input: &Value,
    context: ToolRunContext,
) -> Result<String, String> {
    execute_tool_with_cancel_and_progress_with_context(name, input, &|| false, |_| {}, context)
}

pub fn execute_tool_with_cancel(
    name: &str,
    input: &Value,
    should_cancel: &dyn Fn() -> bool,
) -> Result<String, String> {
    execute_tool_with_cancel_and_progress(name, input, should_cancel, |_| {})
}

pub fn execute_tool_with_cancel_and_progress(
    name: &str,
    input: &Value,
    should_cancel: &dyn Fn() -> bool,
    mut on_progress: impl FnMut(ToolProgress),
) -> Result<String, String> {
    execute_tool_with_cancel_and_progress_with_context(
        name,
        input,
        should_cancel,
        &mut on_progress,
        ToolRunContext::default(),
    )
}

pub fn execute_tool_with_cancel_and_progress_with_context(
    name: &str,
    input: &Value,
    should_cancel: &dyn Fn() -> bool,
    mut on_progress: impl FnMut(ToolProgress),
    context: ToolRunContext,
) -> Result<String, String> {
    match name {
        "bash" => from_value::<BashCommandInput>(input)
            .and_then(|input| run_bash(input, should_cancel, &mut on_progress, &context)),
        "read_file" => from_value::<ReadFileInput>(input).and_then(run_read_file),
        "WorkspaceLayout" => to_pretty_json(layout::layout_json()),
        "write_file" => {
            from_value::<WriteFileInput>(input).and_then(|input| run_write_file(input, &context))
        }
        "append_file" => {
            from_value::<AppendFileInput>(input).and_then(|input| run_append_file(input, &context))
        }
        "edit_file" => {
            from_value::<EditFileInput>(input).and_then(|input| run_edit_file(input, &context))
        }
        "change_list" => from_value::<FileChangeListInput>(input).and_then(run_change_list),
        "change_get" => from_value::<FileChangeGetInput>(input).and_then(run_change_get),
        "change_revert" => from_value::<FileChangeRevertInput>(input)
            .and_then(|input| run_change_revert(input, &context)),
        "glob_search" => from_value::<GlobSearchInputValue>(input).and_then(run_glob_search),
        "grep_search" => from_value::<GrepSearchInput>(input).and_then(run_grep_search),
        "memory" => from_value::<MemoryInput>(input).and_then(run_memory),
        "session_search" => from_value::<SessionSearchInput>(input).and_then(run_session_search),
        "WebFetch" => from_value::<WebFetchInput>(input).and_then(run_web_fetch),
        "WebSearch" => from_value::<WebSearchInput>(input).and_then(run_web_search),
        "LiteratureSearch" => from_value::<literature::LiteratureSearchInput>(input)
            .and_then(literature::run_literature_search),
        "LiteratureSearchProtocolCreate" => {
            from_value::<literature::LiteratureSearchProtocolCreateInput>(input)
                .and_then(literature::run_literature_search_protocol_create)
        }
        "LiteratureSearchPreview" => from_value::<literature::LiteratureSearchPreviewInput>(input)
            .and_then(literature::run_literature_search_preview),
        "LiteratureSearchExecute" => from_value::<literature::LiteratureSearchExecuteInput>(input)
            .and_then(literature::run_literature_search_execute),
        "LiteratureLibraryUpsert" => from_value::<literature::LiteratureLibraryUpsertInput>(input)
            .and_then(literature::run_literature_library_upsert),
        "LiteraturePdfDownload" => from_value::<literature::LiteraturePdfDownloadInput>(input)
            .and_then(literature::run_literature_pdf_download),
        "LiteratureBrowserDownloadTask" => {
            from_value::<literature::LiteratureBrowserDownloadTaskInput>(input)
                .and_then(literature::run_literature_browser_download_task)
        }
        "KnowledgeSearch" => from_value::<knowledge::KnowledgeSearchInput>(input)
            .and_then(knowledge::run_knowledge_search),
        "KnowledgeUpsert" => from_value::<knowledge::KnowledgeUpsertInput>(input)
            .and_then(knowledge::run_knowledge_upsert),
        "LaTeXCompile" => from_value::<LatexCompileInput>(input)
            .and_then(|input| run_latex_compile(input, should_cancel, &mut on_progress)),
        "LaTeXRender" => from_value::<LatexRenderInput>(input)
            .and_then(|input| run_latex_render(input, &context)),
        "NotebookExecute" => from_value::<notebook::NotebookExecuteInput>(input)
            .and_then(notebook::run_notebook_execute),
        "NotebookKernel" => from_value::<notebook::NotebookKernelInput>(input)
            .and_then(notebook::run_notebook_kernel),
        "NotebookRun" => {
            from_value::<notebook::NotebookRunInput>(input).and_then(notebook::run_notebook_run)
        }
        "NotebookSweep" => {
            from_value::<sweep::SweepSpec>(input).and_then(sweep::run_notebook_sweep)
        }
        "TodoWrite" => from_value::<TodoWriteInput>(input).and_then(run_todo_write),
        "LlmReview" => from_value::<LlmReviewInput>(input).and_then(run_llm_review),
        "Skill" => from_value::<SkillInput>(input).and_then(run_skill),
        "Agent" => from_value::<AgentInput>(input).and_then(run_agent),
        "ToolSearch" => from_value::<ToolSearchInput>(input).and_then(run_tool_search),
        "NotebookEdit" => from_value::<NotebookEditInput>(input).and_then(run_notebook_edit),
        "Sleep" => {
            from_value::<SleepInput>(input).and_then(|input| run_sleep(input, should_cancel))
        }
        "SendUserMessage" | "Brief" => from_value::<BriefInput>(input).and_then(run_brief),
        "Config" => from_value::<ConfigInput>(input).and_then(run_config),
        "StructuredOutput" => {
            from_value::<StructuredOutputInput>(input).and_then(run_structured_output)
        }
        "REPL" => from_value::<ReplInput>(input)
            .and_then(|input| run_repl(input, should_cancel, &context)),
        "PowerShell" => from_value::<PowerShellInput>(input)
            .and_then(|input| run_powershell(input, should_cancel, &mut on_progress, &context)),
        _ => Err(format!("unsupported tool: {name}")),
    }
}

fn from_value<T: for<'de> Deserialize<'de>>(input: &Value) -> Result<T, String> {
    serde_json::from_value(input.clone()).map_err(|error| error.to_string())
}

fn run_bash(
    input: BashCommandInput,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
    context: &ToolRunContext,
) -> Result<String, String> {
    run_json_with_workspace_audit("bash", context, || {
        serde_json::to_value(
            runtime::execute_bash_with_cancel_and_progress(input, should_cancel, |progress| {
                on_progress(managed_progress_to_tool_progress(progress));
            })
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    })
}

fn managed_progress_to_tool_progress(progress: runtime::ManagedCommandProgress) -> ToolProgress {
    let near_timeout = progress.timeout_ms.is_some_and(|timeout| {
        timeout > 0
            && (progress.elapsed_ms as f64) >= (timeout as f64 * TOOL_PROGRESS_NEAR_TIMEOUT_RATIO)
    });
    let message = if near_timeout {
        "Still running; close to timeout".to_string()
    } else {
        "Still running".to_string()
    };
    ToolProgress {
        elapsed_ms: progress.elapsed_ms,
        timeout_ms: progress.timeout_ms,
        pid: Some(progress.pid),
        stdout_tail: (!progress.stdout_tail.is_empty()).then_some(progress.stdout_tail),
        stderr_tail: (!progress.stderr_tail.is_empty()).then_some(progress.stderr_tail),
        near_timeout,
        message,
    }
}

#[allow(clippy::needless_pass_by_value)]
fn run_read_file(input: ReadFileInput) -> Result<String, String> {
    to_pretty_json(read_file(&input.path, input.offset, input.limit).map_err(io_to_string)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_write_file(input: WriteFileInput, context: &ToolRunContext) -> Result<String, String> {
    let content_chars = input.content.chars().count();
    if content_chars > MAX_WRITE_FILE_CONTENT_CHARS {
        return Err(format!(
            "write_file content is {content_chars} characters, above the {MAX_WRITE_FILE_CONTENT_CHARS}-character single-call limit. Split long generated files into smaller append_file chunks, then verify the file on disk."
        ));
    }
    to_pretty_json(
        write_file_with_context(
            &input.path,
            &input.content,
            &context.mutation_context("write_file"),
        )
        .map_err(io_to_string)?,
    )
}

#[allow(clippy::needless_pass_by_value)]
fn run_append_file(input: AppendFileInput, context: &ToolRunContext) -> Result<String, String> {
    let content_chars = input.content.chars().count();
    if content_chars > MAX_WRITE_FILE_CONTENT_CHARS {
        return Err(format!(
            "append_file content is {content_chars} characters, above the {MAX_WRITE_FILE_CONTENT_CHARS}-character single-call limit. Split the artifact into smaller append_file chunks, then verify the file on disk."
        ));
    }
    to_pretty_json(
        append_file_with_context(
            &input.path,
            &input.content,
            input.create_if_missing.unwrap_or(true),
            &context.mutation_context("append_file"),
        )
        .map_err(io_to_string)?,
    )
}

#[allow(clippy::needless_pass_by_value)]
fn run_edit_file(input: EditFileInput, context: &ToolRunContext) -> Result<String, String> {
    to_pretty_json(
        edit_file_with_context(
            &input.path,
            &input.old_string,
            &input.new_string,
            input.replace_all.unwrap_or(false),
            &context.mutation_context("edit_file"),
        )
        .map_err(io_to_string)?,
    )
}

#[allow(clippy::needless_pass_by_value)]
fn run_change_list(input: FileChangeListInput) -> Result<String, String> {
    to_pretty_json(list_file_changes(input).map_err(io_to_string)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_change_get(input: FileChangeGetInput) -> Result<String, String> {
    to_pretty_json(get_file_change(input).map_err(io_to_string)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_change_revert(
    input: FileChangeRevertInput,
    context: &ToolRunContext,
) -> Result<String, String> {
    to_pretty_json(
        revert_file_change(input, &context.mutation_context("change_revert"))
            .map_err(io_to_string)?,
    )
}

#[allow(clippy::needless_pass_by_value)]
fn run_glob_search(input: GlobSearchInputValue) -> Result<String, String> {
    to_pretty_json(glob_search(&input.pattern, input.path.as_deref()).map_err(io_to_string)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_grep_search(input: GrepSearchInput) -> Result<String, String> {
    to_pretty_json(grep_search(&input).map_err(io_to_string)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_memory(input: MemoryInput) -> Result<String, String> {
    use runtime::HotMemoryTarget;

    let workspace = std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let project_scope = runtime::project_scope(&workspace);
    let scope = match input.scope.as_deref().unwrap_or("project") {
        "global" => "global".to_string(),
        "project" => project_scope.clone(),
        other => return Err(format!("unsupported memory scope `{other}`")),
    };
    let source = input.source.as_deref().unwrap_or("assistant_tool");
    let target = input
        .target
        .as_deref()
        .unwrap_or("memory")
        .parse::<HotMemoryTarget>()?;

    if matches!(input.action.as_str(), "add" | "replace" | "remove")
        && runtime::memory_write_approval_enabled()
    {
        let pending = runtime::new_pending_write(
            &input.action,
            target,
            input.content,
            input.old_text,
            source,
            &scope,
            input.expires_at,
        );
        return to_pretty_json(runtime::stage_memory_write(pending)?);
    }

    match input.action.as_str() {
        "add" => to_pretty_json(runtime::add_hot_memory(
            target,
            input.content.as_deref().unwrap_or_default(),
            source,
            &scope,
            input.expires_at.as_deref(),
        )?),
        "replace" => to_pretty_json(runtime::replace_hot_memory(
            target,
            input.old_text.as_deref().unwrap_or_default(),
            input.content.as_deref().unwrap_or_default(),
            source,
            &scope,
            input.expires_at.as_deref(),
        )?),
        "remove" => to_pretty_json(runtime::remove_hot_memory(
            target,
            input.old_text.as_deref().unwrap_or_default(),
            &scope,
        )?),
        "list" => to_pretty_json(runtime::load_hot_memory(&workspace)?),
        "pending" => to_pretty_json(runtime::list_pending_for_scope(&project_scope)?),
        other => Err(format!("unsupported memory action `{other}`")),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn run_session_search(input: SessionSearchInput) -> Result<String, String> {
    to_pretty_json(runtime::search_sessions(
        &runtime::sessions_dir_from_env(),
        input.query.as_deref(),
        input.session_id.as_deref(),
        input.limit.unwrap_or(3).clamp(1, 20),
        input.window.unwrap_or(5).clamp(1, 30),
    )?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_web_fetch(input: WebFetchInput) -> Result<String, String> {
    to_pretty_json(execute_web_fetch(&input)?)
}

#[allow(clippy::needless_pass_by_value)]
fn run_web_search(input: WebSearchInput) -> Result<String, String> {
    to_pretty_json(execute_web_search(&input)?)
}

fn run_todo_write(input: TodoWriteInput) -> Result<String, String> {
    to_pretty_json(execute_todo_write(input)?)
}

fn run_skill(input: SkillInput) -> Result<String, String> {
    to_pretty_json(execute_skill(input)?)
}

fn run_agent(input: AgentInput) -> Result<String, String> {
    to_pretty_json(execute_agent(input)?)
}

fn run_tool_search(input: ToolSearchInput) -> Result<String, String> {
    to_pretty_json(execute_tool_search(input))
}

fn run_notebook_edit(input: NotebookEditInput) -> Result<String, String> {
    to_pretty_json(execute_notebook_edit(input)?)
}

fn run_sleep(input: SleepInput, should_cancel: &dyn Fn() -> bool) -> Result<String, String> {
    to_pretty_json(execute_sleep(input, should_cancel)?)
}

fn run_brief(input: BriefInput) -> Result<String, String> {
    to_pretty_json(execute_brief(input)?)
}

fn run_config(input: ConfigInput) -> Result<String, String> {
    to_pretty_json(execute_config(input)?)
}

fn run_structured_output(input: StructuredOutputInput) -> Result<String, String> {
    to_pretty_json(execute_structured_output(input))
}

fn run_latex_compile(
    input: LatexCompileInput,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> Result<String, String> {
    to_pretty_json(execute_latex_compile(input, should_cancel, on_progress)?)
}

fn run_latex_render(input: LatexRenderInput, context: &ToolRunContext) -> Result<String, String> {
    run_json_with_workspace_audit("LaTeXRender", context, || {
        serde_json::to_value(execute_latex_render(input)).map_err(|error| error.to_string())
    })
}

fn run_repl(
    input: ReplInput,
    should_cancel: &dyn Fn() -> bool,
    context: &ToolRunContext,
) -> Result<String, String> {
    run_json_with_workspace_audit("REPL", context, || {
        serde_json::to_value(execute_repl(input, should_cancel)?).map_err(|error| error.to_string())
    })
}

fn run_powershell(
    input: PowerShellInput,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
    context: &ToolRunContext,
) -> Result<String, String> {
    run_json_with_workspace_audit("PowerShell", context, || {
        serde_json::to_value(
            execute_powershell_with_cancel(input, should_cancel, on_progress)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    })
}

fn to_pretty_json<T: serde::Serialize>(value: T) -> Result<String, String> {
    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}

#[allow(clippy::needless_pass_by_value)]
fn io_to_string(error: std::io::Error) -> String {
    error.to_string()
}

fn is_symlink(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

#[derive(Debug, Clone)]
struct WorkspaceTextSnapshot {
    files: BTreeMap<PathBuf, String>,
}

#[derive(Debug, Clone)]
struct AuditedWorkspaceChange {
    record: FileChangeRecord,
    before: Option<String>,
    after: Option<String>,
}

fn run_json_with_workspace_audit(
    tool_name: &str,
    context: &ToolRunContext,
    run: impl FnOnce() -> Result<Value, String>,
) -> Result<String, String> {
    let before = capture_workspace_text_snapshot().ok();
    let mut output = run()?;
    if let Some(before) = before {
        if let Ok(after) = capture_workspace_text_snapshot() {
            let changes = record_workspace_snapshot_changes(tool_name, context, before, after);
            inject_workspace_audit_changes(&mut output, &changes);
        }
    }
    to_pretty_json(output)
}

fn capture_workspace_text_snapshot() -> std::io::Result<WorkspaceTextSnapshot> {
    let root = workspace_root_for_audit()?;
    let mut files = BTreeMap::new();
    collect_workspace_text_files(&root, &mut files)?;
    Ok(WorkspaceTextSnapshot { files })
}

fn workspace_root_for_audit() -> std::io::Result<PathBuf> {
    std::env::var("ARIS_WORKSPACE_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?)
        .canonicalize()
}

fn collect_workspace_text_files(
    dir: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> std::io::Result<()> {
    if files.len() >= WORKSPACE_AUDIT_MAX_FILES {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
        Err(error) => return Err(error),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if should_skip_audit_dir(&path) {
                continue;
            }
            collect_workspace_text_files(&path, files)?;
            continue;
        }
        if !file_type.is_file() || !is_auditable_text_path(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > WORKSPACE_AUDIT_MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let canonical = path.canonicalize().unwrap_or(path);
        files.insert(canonical, content);
        if files.len() >= WORKSPACE_AUDIT_MAX_FILES {
            return Ok(());
        }
    }
    Ok(())
}

fn should_skip_audit_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    WORKSPACE_AUDIT_IGNORED_DIRS
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn is_auditable_text_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            WORKSPACE_AUDIT_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn record_workspace_snapshot_changes(
    tool_name: &str,
    context: &ToolRunContext,
    before: WorkspaceTextSnapshot,
    after: WorkspaceTextSnapshot,
) -> Vec<AuditedWorkspaceChange> {
    let mut paths = before.files.keys().cloned().collect::<BTreeSet<_>>();
    paths.extend(after.files.keys().cloned());

    let mutation_context = context.mutation_context(tool_name);
    let mut changes = Vec::new();
    for path in paths {
        let before_content = before.files.get(&path).cloned();
        let after_content = after.files.get(&path).cloned();
        if before_content == after_content {
            continue;
        }
        let operation = match (before_content.as_ref(), after_content.as_ref()) {
            (None, Some(_)) => FileChangeOperation::Create,
            (Some(_), None) => FileChangeOperation::Delete,
            (Some(_), Some(_)) => FileChangeOperation::Update,
            (None, None) => continue,
        };
        let original = before_content.as_deref().unwrap_or("");
        let updated = after_content.as_deref().unwrap_or("");
        let structured_patch = make_audit_patch(original, updated);
        let unified_diff = make_audit_unified_diff(&display_audit_path(&path), original, updated);
        let Ok(record) = record_text_file_change(
            &mutation_context,
            &path,
            operation,
            before_content.as_deref(),
            after_content.as_deref(),
            structured_patch,
            unified_diff,
            None,
        ) else {
            continue;
        };
        if let Some(record) = record {
            changes.push(AuditedWorkspaceChange {
                record,
                before: before_content,
                after: after_content,
            });
        }
    }
    changes
}

fn inject_workspace_audit_changes(output: &mut Value, changes: &[AuditedWorkspaceChange]) {
    if changes.is_empty() {
        return;
    }
    let Some(object) = output.as_object_mut() else {
        return;
    };

    let changes_entry = object.entry("changes").or_insert_with(|| json!({}));
    if !changes_entry.is_object() {
        *changes_entry = json!({});
    }
    let Some(changes_object) = changes_entry.as_object_mut() else {
        return;
    };

    let mut change_ids = Vec::new();
    for change in changes {
        let path = change.record.path.clone();
        change_ids.push(Value::String(change.record.change_id.clone()));
        changes_object.insert(path, audited_change_json(change));
    }
    if changes.len() == 1 {
        object.insert(
            "changeId".to_string(),
            Value::String(changes[0].record.change_id.clone()),
        );
    }
    object.insert("changeIds".to_string(), Value::Array(change_ids));
}

fn audited_change_json(change: &AuditedWorkspaceChange) -> Value {
    match (change.before.as_ref(), change.after.as_ref()) {
        (None, Some(after)) => json!({
            "type": "add",
            "content": after,
            "changeId": change.record.change_id,
        }),
        (Some(before), None) => json!({
            "type": "delete",
            "content": before,
            "changeId": change.record.change_id,
        }),
        (Some(_), Some(_)) => json!({
            "type": "update",
            "unified_diff": change.record.unified_diff,
            "changeId": change.record.change_id,
        }),
        (None, None) => json!({}),
    }
}

fn make_audit_patch(original: &str, updated: &str) -> Vec<StructuredPatchHunk> {
    if original == updated {
        return Vec::new();
    }

    let original_lines = original.lines().collect::<Vec<_>>();
    let updated_lines = updated.lines().collect::<Vec<_>>();
    let mut start = 0usize;
    while start < original_lines.len()
        && start < updated_lines.len()
        && original_lines[start] == updated_lines[start]
    {
        start += 1;
    }

    let mut old_end = original_lines.len();
    let mut new_end = updated_lines.len();
    while old_end > start
        && new_end > start
        && original_lines[old_end - 1] == updated_lines[new_end - 1]
    {
        old_end -= 1;
        new_end -= 1;
    }

    let mut lines = Vec::new();
    for line in &original_lines[start..old_end] {
        lines.push(format!("-{line}"));
    }
    for line in &updated_lines[start..new_end] {
        lines.push(format!("+{line}"));
    }

    vec![StructuredPatchHunk {
        old_start: start + 1,
        old_lines: old_end.saturating_sub(start),
        new_start: start + 1,
        new_lines: new_end.saturating_sub(start),
        lines,
    }]
}

fn make_audit_unified_diff(file_path: &str, original: &str, updated: &str) -> String {
    let hunks = make_audit_patch(original, updated);
    if hunks.is_empty() {
        return String::new();
    }

    let mut diff = format!("--- {file_path}\n+++ {file_path}");
    for hunk in hunks {
        diff.push('\n');
        diff.push_str(&format!(
            "@@ -{} +{} @@",
            audit_unified_range(hunk.old_start, hunk.old_lines),
            audit_unified_range(hunk.new_start, hunk.new_lines),
        ));
        for line in hunk.lines {
            diff.push('\n');
            diff.push_str(&line);
        }
    }
    diff
}

fn audit_unified_range(start: usize, lines: usize) -> String {
    if lines == 1 {
        start.to_string()
    } else {
        format!("{start},{lines}")
    }
}

fn display_audit_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[derive(Debug, Deserialize)]
struct ReadFileInput {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct WriteFileInput {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AppendFileInput {
    path: String,
    content: String,
    create_if_missing: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct EditFileInput {
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct GlobSearchInputValue {
    pattern: String,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebFetchInput {
    url: String,
    prompt: String,
}

#[derive(Debug, Deserialize)]
struct WebSearchInput {
    query: String,
    allowed_domains: Option<Vec<String>>,
    blocked_domains: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MemoryInput {
    action: String,
    target: Option<String>,
    content: Option<String>,
    old_text: Option<String>,
    scope: Option<String>,
    source: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionSearchInput {
    query: Option<String>,
    session_id: Option<String>,
    limit: Option<usize>,
    window: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct TodoWriteInput {
    todos: Vec<TodoItem>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
struct TodoItem {
    content: String,
    #[serde(rename = "activeForm")]
    active_form: String,
    status: TodoStatus,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Deserialize)]
struct SkillInput {
    skill: String,
    args: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgentInput {
    description: String,
    prompt: String,
    subagent_type: Option<String>,
    name: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolSearchInput {
    query: String,
    max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct NotebookEditInput {
    notebook_path: String,
    cell_id: Option<String>,
    new_source: Option<String>,
    cell_type: Option<NotebookCellType>,
    edit_mode: Option<NotebookEditMode>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NotebookCellType {
    Code,
    Markdown,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NotebookEditMode {
    Replace,
    Insert,
    Delete,
}

#[derive(Debug, Deserialize)]
struct SleepInput {
    duration_ms: u64,
}

#[derive(Debug, Deserialize)]
struct BriefInput {
    message: String,
    attachments: Option<Vec<String>>,
    status: BriefStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BriefStatus {
    Normal,
    Proactive,
}

#[derive(Debug, Deserialize)]
struct ConfigInput {
    setting: String,
    value: Option<ConfigValue>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ConfigValue {
    String(String),
    Bool(bool),
    Number(f64),
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct StructuredOutputInput(BTreeMap<String, Value>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatexCompileInput {
    input_path: String,
    output_path: Option<String>,
    compiler: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatexRenderInput {
    template_path: String,
    data_path: String,
    output_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexCompileOutput {
    pub success: bool,
    pub input_path: String,
    pub output_path: String,
    pub engine: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub interrupted: bool,
    pub timed_out: bool,
    pub duration_ms: u128,
    pub return_code_interpretation: Option<String>,
    pub diagnostics: Vec<LatexDiagnostic>,
    pub repair_guidance: Option<String>,
    pub pdf_state: LatexPdfState,
    pub root_source_hash: String,
    pub pdf_hash: Option<String>,
    pub compiled_at_unix_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub file_path: Option<String>,
    pub line: Option<u32>,
}

/// Provenance state for the PDF selected after a LaTeX compile attempt.
/// `stale` is deliberately distinct from `partial`: it means a PDF exists but
/// was not produced or changed by this invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LatexPdfState {
    Fresh,
    Partial,
    Stale,
    Missing,
}

/// Desktop and agent callers share this compile request. Agents keep the
/// strict default (`continue_on_error: false`) through their tool schema.
#[derive(Debug, Clone)]
pub struct LatexCompileRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub compiler: Option<String>,
    pub timeout_ms: Option<u64>,
    pub clean_cache: bool,
    pub continue_on_error: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatexRenderOutput {
    template_path: String,
    data_path: String,
    output_path: String,
    rendered_chars: usize,
}

#[derive(Debug, Deserialize)]
struct ReplInput {
    code: String,
    language: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct PowerShellInput {
    command: String,
    timeout: Option<u64>,
    description: Option<String>,
    run_in_background: Option<bool>,
}

#[derive(Debug, Serialize)]
struct WebFetchOutput {
    bytes: usize,
    code: u16,
    #[serde(rename = "codeText")]
    code_text: String,
    result: String,
    #[serde(rename = "durationMs")]
    duration_ms: u128,
    url: String,
}

#[derive(Debug, Serialize)]
struct WebSearchOutput {
    query: String,
    results: Vec<WebSearchResultItem>,
    #[serde(rename = "durationSeconds")]
    duration_seconds: f64,
}

#[derive(Debug, Serialize)]
struct TodoWriteOutput {
    #[serde(rename = "oldTodos")]
    old_todos: Vec<TodoItem>,
    #[serde(rename = "newTodos")]
    new_todos: Vec<TodoItem>,
    #[serde(rename = "verificationNudgeNeeded")]
    verification_nudge_needed: Option<bool>,
}

#[derive(Debug, Serialize)]
struct SkillOutput {
    skill: String,
    path: String,
    args: Option<String>,
    description: Option<String>,
    prompt: String,

    /// v0.4.8: per-skill slice of `runtime::ExtractionReport`. `None` for
    /// filesystem skills (no bundled helpers) or when startup eager-extract
    /// was bypassed (test code).
    #[serde(rename = "helperReport", skip_serializing_if = "Option::is_none")]
    helper_report: Option<SkillHelperReport>,
}

#[derive(Debug, Serialize)]
struct SkillHelperReport {
    /// Absolute path to the cache root (set as `$ARIS_CACHE_DIR` at startup).
    /// `None` iff `runtime::ExtractionReport.hard_error` — helpers unavailable.
    #[serde(rename = "cacheDir", skip_serializing_if = "Option::is_none")]
    cache_dir: Option<String>,

    /// True iff `cache_dir.is_some() && failed_helpers.is_empty()`.
    /// False under partial failure even if `cache_dir` is set.
    #[serde(rename = "cacheUsable")]
    cache_usable: bool,

    /// Helpers visible to this skill (shared `tools/*` + skill-local +
    /// always-extracted `shared-references/*`). Absolute paths.
    #[serde(rename = "availableHelpers")]
    available_helpers: Vec<HelperEntry>,

    /// Helpers from BUNDLED_RESOURCES that failed to extract.
    /// v0.4.8 scope: extraction-failure slice. NOT "SKILL.md references that
    /// aren't bundled" — that static inference is deferred to v0.5.0.
    #[serde(rename = "failedHelpers")]
    failed_helpers: Vec<HelperEntry>,
}

#[derive(Debug, Serialize)]
struct HelperEntry {
    /// Bundle key (e.g., "tools/arxiv_fetch.py", "skills/research-wiki/research_wiki.py").
    key: String,
    /// Absolute path where the helper lives, or where it would have lived if missing.
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentTokenUsage {
    input_tokens: u32,
    output_tokens: u32,
    cache_creation_input_tokens: u32,
    cache_read_input_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentOutput {
    #[serde(rename = "agentId")]
    agent_id: String,
    name: String,
    description: String,
    #[serde(rename = "subagentType")]
    subagent_type: Option<String>,
    model: Option<String>,
    status: String,
    #[serde(rename = "outputFile")]
    output_file: String,
    #[serde(rename = "manifestFile")]
    manifest_file: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<AgentTokenUsage>,
}

#[derive(Debug, Clone)]
struct AgentJob {
    manifest: AgentOutput,
    prompt: String,
    system_prompt: Vec<String>,
    allowed_tools: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
struct ToolSearchOutput {
    matches: Vec<String>,
    query: String,
    normalized_query: String,
    #[serde(rename = "total_deferred_tools")]
    total_deferred_tools: usize,
    #[serde(rename = "pending_mcp_servers")]
    pending_mcp_servers: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct NotebookEditOutput {
    new_source: String,
    cell_id: Option<String>,
    cell_type: Option<NotebookCellType>,
    language: String,
    edit_mode: String,
    error: Option<String>,
    notebook_path: String,
    original_file: String,
    updated_file: String,
}

#[derive(Debug, Serialize)]
struct SleepOutput {
    duration_ms: u64,
    message: String,
}

#[derive(Debug, Serialize)]
struct BriefOutput {
    message: String,
    attachments: Option<Vec<ResolvedAttachment>>,
    #[serde(rename = "sentAt")]
    sent_at: String,
}

#[derive(Debug, Serialize)]
struct ResolvedAttachment {
    path: String,
    size: u64,
    #[serde(rename = "isImage")]
    is_image: bool,
}

#[derive(Debug, Serialize)]
struct ConfigOutput {
    success: bool,
    operation: Option<String>,
    setting: Option<String>,
    value: Option<Value>,
    #[serde(rename = "previousValue")]
    previous_value: Option<Value>,
    #[serde(rename = "newValue")]
    new_value: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct StructuredOutputResult {
    data: String,
    structured_output: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
struct ReplOutput {
    language: String,
    stdout: String,
    stderr: String,
    #[serde(rename = "exitCode")]
    exit_code: i32,
    #[serde(rename = "durationMs")]
    duration_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum WebSearchResultItem {
    SearchResult {
        tool_use_id: String,
        content: Vec<SearchHit>,
    },
    Commentary(String),
}

#[derive(Debug, Serialize)]
struct SearchHit {
    title: String,
    url: String,
}

fn execute_web_fetch(input: &WebFetchInput) -> Result<WebFetchOutput, String> {
    let started = Instant::now();
    let client = build_http_client()?;
    let request_url = normalize_fetch_url(&input.url)?;
    let response = client
        .get(request_url.clone())
        .send()
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let final_url = response.url().to_string();
    let code = status.as_u16();
    let code_text = status.canonical_reason().unwrap_or("Unknown").to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response.text().map_err(|error| error.to_string())?;
    let bytes = body.len();
    let normalized = normalize_fetched_content(&body, &content_type);
    let result = summarize_web_fetch(&final_url, &input.prompt, &normalized, &body, &content_type);

    Ok(WebFetchOutput {
        bytes,
        code,
        code_text,
        result,
        duration_ms: started.elapsed().as_millis(),
        url: final_url,
    })
}

fn execute_web_search(input: &WebSearchInput) -> Result<WebSearchOutput, String> {
    let started = Instant::now();
    let client = build_http_client()?;
    let search_url = build_search_url(&input.query)?;
    let response = client
        .get(search_url)
        .send()
        .map_err(|error| error.to_string())?;

    let final_url = response.url().clone();
    let html = response.text().map_err(|error| error.to_string())?;
    let mut hits = extract_search_hits(&html);

    if hits.is_empty() && final_url.host_str().is_some() {
        hits = extract_search_hits_from_generic_links(&html);
    }

    if let Some(allowed) = input.allowed_domains.as_ref() {
        hits.retain(|hit| host_matches_list(&hit.url, allowed));
    }
    if let Some(blocked) = input.blocked_domains.as_ref() {
        hits.retain(|hit| !host_matches_list(&hit.url, blocked));
    }

    dedupe_hits(&mut hits);
    hits.truncate(8);

    let summary = if hits.is_empty() {
        format!("No web search results matched the query {:?}.", input.query)
    } else {
        let rendered_hits = hits
            .iter()
            .map(|hit| format!("- [{}]({})", hit.title, hit.url))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "Search results for {:?}. Include a Sources section in the final answer.\n{}",
            input.query, rendered_hits
        )
    };

    Ok(WebSearchOutput {
        query: input.query.clone(),
        results: vec![
            WebSearchResultItem::Commentary(summary),
            WebSearchResultItem::SearchResult {
                tool_use_id: String::from("web_search_1"),
                content: hits,
            },
        ],
        duration_seconds: started.elapsed().as_secs_f64(),
    })
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("clawd-rust-tools/0.1")
        .build()
        .map_err(|error| error.to_string())
}

fn normalize_fetch_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        if host != "localhost" && host != "127.0.0.1" && host != "::1" {
            let mut upgraded = parsed;
            upgraded
                .set_scheme("https")
                .map_err(|()| String::from("failed to upgrade URL to https"))?;
            return Ok(upgraded.to_string());
        }
    }
    Ok(parsed.to_string())
}

fn build_search_url(query: &str) -> Result<reqwest::Url, String> {
    if let Ok(base) = std::env::var("CLAWD_WEB_SEARCH_BASE_URL") {
        let mut url = reqwest::Url::parse(&base).map_err(|error| error.to_string())?;
        url.query_pairs_mut().append_pair("q", query);
        return Ok(url);
    }

    let mut url = reqwest::Url::parse("https://html.duckduckgo.com/html/")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    Ok(url)
}

fn normalize_fetched_content(body: &str, content_type: &str) -> String {
    if content_type.contains("html") {
        html_to_text(body)
    } else {
        body.trim().to_string()
    }
}

fn summarize_web_fetch(
    url: &str,
    prompt: &str,
    content: &str,
    raw_body: &str,
    content_type: &str,
) -> String {
    let lower_prompt = prompt.to_lowercase();
    let compact = collapse_whitespace(content);

    let detail = if lower_prompt.contains("title") {
        extract_title(content, raw_body, content_type).map_or_else(
            || preview_text(&compact, 600),
            |title| format!("Title: {title}"),
        )
    } else if lower_prompt.contains("summary") || lower_prompt.contains("summarize") {
        preview_text(&compact, 900)
    } else {
        let preview = preview_text(&compact, 900);
        format!("Prompt: {prompt}\nContent preview:\n{preview}")
    };

    format!("Fetched {url}\n{detail}")
}

fn extract_title(content: &str, raw_body: &str, content_type: &str) -> Option<String> {
    if content_type.contains("html") {
        let lowered = raw_body.to_lowercase();
        if let Some(start) = lowered.find("<title>") {
            let after = start + "<title>".len();
            if let Some(end_rel) = lowered[after..].find("</title>") {
                let title =
                    collapse_whitespace(&decode_html_entities(&raw_body[after..after + end_rel]));
                if !title.is_empty() {
                    return Some(title);
                }
            }
        }
    }

    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut previous_was_space = false;

    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            '&' => {
                text.push('&');
                previous_was_space = false;
            }
            ch if ch.is_whitespace() => {
                if !previous_was_space {
                    text.push(' ');
                    previous_was_space = true;
                }
            }
            _ => {
                text.push(ch);
                previous_was_space = false;
            }
        }
    }

    collapse_whitespace(&decode_html_entities(&text))
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

pub(crate) fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

fn preview_text(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let shortened = input.chars().take(max_chars).collect::<String>();
    format!("{}…", shortened.trim_end())
}

fn extract_search_hits(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut remaining = html;

    while let Some(anchor_start) = remaining.find("result__a") {
        let after_class = &remaining[anchor_start..];
        let Some(href_idx) = after_class.find("href=") else {
            remaining = &after_class[1..];
            continue;
        };
        let href_slice = &after_class[href_idx + 5..];
        let Some((url, rest)) = extract_quoted_value(href_slice) else {
            remaining = &after_class[1..];
            continue;
        };
        let Some(close_tag_idx) = rest.find('>') else {
            remaining = &after_class[1..];
            continue;
        };
        let after_tag = &rest[close_tag_idx + 1..];
        let Some(end_anchor_idx) = after_tag.find("</a>") else {
            remaining = &after_tag[1..];
            continue;
        };
        let title = html_to_text(&after_tag[..end_anchor_idx]);
        if let Some(decoded_url) = decode_duckduckgo_redirect(&url) {
            hits.push(SearchHit {
                title: title.trim().to_string(),
                url: decoded_url,
            });
        }
        remaining = &after_tag[end_anchor_idx + 4..];
    }

    hits
}

fn extract_search_hits_from_generic_links(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut remaining = html;

    while let Some(anchor_start) = remaining.find("<a") {
        let after_anchor = &remaining[anchor_start..];
        let Some(href_idx) = after_anchor.find("href=") else {
            remaining = &after_anchor[2..];
            continue;
        };
        let href_slice = &after_anchor[href_idx + 5..];
        let Some((url, rest)) = extract_quoted_value(href_slice) else {
            remaining = &after_anchor[2..];
            continue;
        };
        let Some(close_tag_idx) = rest.find('>') else {
            remaining = &after_anchor[2..];
            continue;
        };
        let after_tag = &rest[close_tag_idx + 1..];
        let Some(end_anchor_idx) = after_tag.find("</a>") else {
            remaining = &after_anchor[2..];
            continue;
        };
        let title = html_to_text(&after_tag[..end_anchor_idx]);
        if title.trim().is_empty() {
            remaining = &after_tag[end_anchor_idx + 4..];
            continue;
        }
        let decoded_url = decode_duckduckgo_redirect(&url).unwrap_or(url);
        if decoded_url.starts_with("http://") || decoded_url.starts_with("https://") {
            hits.push(SearchHit {
                title: title.trim().to_string(),
                url: decoded_url,
            });
        }
        remaining = &after_tag[end_anchor_idx + 4..];
    }

    hits
}

fn extract_quoted_value(input: &str) -> Option<(String, &str)> {
    let quote = input.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &input[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some((rest[..end].to_string(), &rest[end + quote.len_utf8()..]))
}

fn decode_duckduckgo_redirect(url: &str) -> Option<String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Some(html_entity_decode_url(url));
    }

    let joined = if url.starts_with("//") {
        format!("https:{url}")
    } else if url.starts_with('/') {
        format!("https://duckduckgo.com{url}")
    } else {
        return None;
    };

    let parsed = reqwest::Url::parse(&joined).ok()?;
    if parsed.path() == "/l/" || parsed.path() == "/l" {
        for (key, value) in parsed.query_pairs() {
            if key == "uddg" {
                return Some(html_entity_decode_url(value.as_ref()));
            }
        }
    }
    Some(joined)
}

fn html_entity_decode_url(url: &str) -> String {
    decode_html_entities(url)
}

fn host_matches_list(url: &str, domains: &[String]) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    domains.iter().any(|domain| {
        let normalized = normalize_domain_filter(domain);
        !normalized.is_empty() && (host == normalized || host.ends_with(&format!(".{normalized}")))
    })
}

fn normalize_domain_filter(domain: &str) -> String {
    let trimmed = domain.trim();
    let candidate = reqwest::Url::parse(trimmed)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| trimmed.to_string());
    candidate
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn dedupe_hits(hits: &mut Vec<SearchHit>) {
    let mut seen = BTreeSet::new();
    hits.retain(|hit| seen.insert(hit.url.clone()));
}

fn execute_todo_write(input: TodoWriteInput) -> Result<TodoWriteOutput, String> {
    validate_todos(&input.todos)?;
    let store_path = todo_store_path()?;
    let old_todos = if store_path.exists() {
        serde_json::from_str::<Vec<TodoItem>>(
            &std::fs::read_to_string(&store_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };

    let all_done = input
        .todos
        .iter()
        .all(|todo| matches!(todo.status, TodoStatus::Completed));
    let persisted = if all_done {
        Vec::new()
    } else {
        input.todos.clone()
    };

    let payload = serde_json::to_string_pretty(&persisted).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(&store_path, payload.as_bytes())
        .map_err(|error| error.to_string())?;

    let verification_nudge_needed = (all_done
        && input.todos.len() >= 3
        && !input
            .todos
            .iter()
            .any(|todo| todo.content.to_lowercase().contains("verif")))
    .then_some(true);

    Ok(TodoWriteOutput {
        old_todos,
        new_todos: input.todos,
        verification_nudge_needed,
    })
}

fn execute_skill(input: SkillInput) -> Result<SkillOutput, String> {
    let requested = input
        .skill
        .trim()
        .trim_start_matches('/')
        .trim_start_matches('$');
    let resolution = runtime::registered_literature_skill(requested)
        .filter(|resolution| resolution.lifecycle == runtime::SkillLifecycle::Active);
    let resolved = resolution
        .as_ref()
        .map_or(requested, |resolution| resolution.canonical_name);

    // Try filesystem search roots first (user overrides take priority)
    if let Ok(skill_path) = resolve_skill_path(requested) {
        let raw_prompt = with_activated_skill_profile(
            std::fs::read_to_string(&skill_path).map_err(|e| e.to_string())?,
            resolution.as_ref(),
        );
        let description = parse_skill_description(&raw_prompt);
        let helper_report = build_helper_report(resolved);
        // Active filesystem skill dir = parent of SKILL.md. Used by the
        // resolver chain's Layer 1 (`<active_skill_dir>/tools/<helper>`).
        let active_skill_dir = skill_path
            .parent()
            .map(|p| forward_slash(&p.display().to_string()));
        let prompt = inject_resolver_preamble(
            &raw_prompt,
            helper_report.as_ref(),
            active_skill_dir.as_deref(),
        );
        return Ok(SkillOutput {
            skill: input.skill,
            path: forward_slash(&skill_path.display().to_string()),
            args: input.args,
            description,
            prompt,
            helper_report,
        });
    }

    // Fallback: bundled skills compiled into the binary.
    // No per-skill extraction here — startup eager extract (runtime::extract_bundle)
    // already materialised every BUNDLED_RESOURCES entry into the cache. We just
    // surface a per-skill slice of the report so the model knows where helpers live.
    for (name, content) in BUNDLED_SKILLS {
        if name.eq_ignore_ascii_case(resolved) {
            let content = with_activated_skill_profile((*content).to_string(), resolution.as_ref());
            let description = parse_skill_description(&content);
            let helper_report = build_helper_report(name);
            // Bundled skills have no on-disk skill dir; Layer 1 doesn't apply.
            let prompt = inject_resolver_preamble(&content, helper_report.as_ref(), None);
            return Ok(SkillOutput {
                skill: input.skill,
                path: format!("<bundled:{name}>"),
                args: input.args,
                description,
                prompt,
                helper_report,
            });
        }
    }

    Err(format!("unknown skill: {requested}"))
}

/// Normalise a path string to forward slashes. The cache and active-skill paths
/// flow into SKILL.md prompts and from there into the model's `bash` tool
/// invocations. POSIX-shell + git-bash + WSL all tolerate `/` even on Windows;
/// raw backslashes from `Path::display()` confuse the shell escaping.
fn forward_slash(p: &str) -> String {
    p.replace('\\', "/")
}

/// Build the per-skill slice of the process-global `ExtractionReport`.
///
/// Helpers in scope: shared (`tools/*`), always-extracted refs
/// (`shared-references/*`), and skill-local (`skills/<skill_name>/*`).
fn build_helper_report(skill_name: &str) -> Option<SkillHelperReport> {
    let report = runtime::extraction_report()?;

    let cache_dir = report
        .used_dir
        .as_ref()
        .map(|p| forward_slash(&p.display().to_string()));

    let skill_prefix = format!("skills/{skill_name}/");
    let in_scope = |key: &str| -> bool {
        key.starts_with("tools/")
            || key.starts_with("shared-references/")
            || key.starts_with(&skill_prefix)
    };

    let make_path = |key: &str| -> String {
        report
            .used_dir
            .as_ref()
            .map(|d| forward_slash(&d.join(key).display().to_string()))
            .unwrap_or_default()
    };

    let available_helpers: Vec<HelperEntry> = report
        .extracted
        .iter()
        .filter(|k| in_scope(k))
        .map(|k| HelperEntry {
            key: k.clone(),
            path: make_path(k),
            error: None,
        })
        .collect();

    let failed_helpers: Vec<HelperEntry> = report
        .failed
        .iter()
        .filter(|e| in_scope(&e.key))
        .map(|e| HelperEntry {
            key: e.key.clone(),
            path: make_path(&e.key),
            error: Some(e.error.clone()),
        })
        .collect();

    let cache_usable = cache_dir.is_some() && failed_helpers.is_empty();

    Some(SkillHelperReport {
        cache_dir,
        cache_usable,
        available_helpers,
        failed_helpers,
    })
}

/// Prepend a hard resolver preamble to the SKILL.md prompt so the model knows
/// how to resolve helper paths. This is the bridge while SKILL.md bodies (T15)
/// still use legacy `tools/<helper>` hardcoded paths.
///
/// `active_skill_dir` should be `Some(dirname(skill_md))` for filesystem skills,
/// `None` for bundled skills (Layer 1 omitted).
fn inject_resolver_preamble(
    prompt: &str,
    report: Option<&SkillHelperReport>,
    active_skill_dir: Option<&str>,
) -> String {
    let Some(report) = report else {
        return prompt.to_string();
    };
    let Some(cache_dir) = &report.cache_dir else {
        // No usable cache — preamble omitted; SKILL.md must rely on
        // project-workspace fallback at layer 4.
        return prompt.to_string();
    };

    let mut preamble = String::with_capacity(1024 + prompt.len());
    preamble.push_str("# Helper resolution (ARIS-Code v0.4.8+)\n\n");
    preamble.push_str("When invoking a bundled helper script, resolve its path via this fallback chain (in order, first hit wins):\n\n");
    let mut layer = 1u32;
    if let Some(dir) = active_skill_dir {
        preamble.push_str(&format!(
            "{layer}. `{dir}/tools/<helper>` (active filesystem skill dir, where this SKILL.md lives)\n"
        ));
        layer += 1;
    }
    preamble.push_str(&format!(
        "{layer}. `~/.config/SomniQ/<bundle-key>` (user-customised location; e.g. `~/.config/SomniQ/tools/foo.py` for shared helpers, `~/.config/SomniQ/skills/<name>/<rel>` for skill-local)\n"
    ));
    layer += 1;
    preamble.push_str(&format!(
        "{layer}. `{cache_dir}/<bundle-key>` (bundled fallback for this binary; also accessible as `$ARIS_CACHE_DIR/<bundle-key>`)\n"
    ));
    layer += 1;
    preamble.push_str(&format!(
        "{layer}. `<project_root>/tools/<helper>` (legacy compat with main-branch SomniQ layouts)\n\n"
    ));

    if report.available_helpers.is_empty() {
        preamble.push_str("No bundled helpers extracted for this skill.\n");
    } else {
        preamble.push_str("Bundled helpers available for this skill (cache layer):\n");
        for entry in &report.available_helpers {
            preamble.push_str(&format!("- `{}` → `{}`\n", entry.key, entry.path));
        }
    }
    if !report.failed_helpers.is_empty() {
        preamble.push_str(
            "\nWarning: the following bundled helpers failed to extract and may be unavailable:\n",
        );
        for entry in &report.failed_helpers {
            preamble.push_str(&format!(
                "- `{}` — {}\n",
                entry.key,
                entry.error.as_deref().unwrap_or("unknown error")
            ));
        }
    }
    preamble.push_str("\n---\n\n");
    preamble.push_str(prompt);
    preamble
}

fn validate_todos(todos: &[TodoItem]) -> Result<(), String> {
    if todos.is_empty() {
        return Err(String::from("todos must not be empty"));
    }
    // Allow multiple in_progress items for parallel workflows
    if todos.iter().any(|todo| todo.content.trim().is_empty()) {
        return Err(String::from("todo content must not be empty"));
    }
    if todos.iter().any(|todo| todo.active_form.trim().is_empty()) {
        return Err(String::from("todo activeForm must not be empty"));
    }
    Ok(())
}

fn todo_store_path() -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("CLAWD_TODO_STORE") {
        return Ok(std::path::PathBuf::from(path));
    }
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    Ok(cwd.join(".clawd-todos.json"))
}

fn skill_search_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();

    // 1. ~/.config/SomniQ/skills/ (SomniQ user-level, highest priority)
    roots.push(runtime::aris_user_skills_dir());

    // 2. Project-level .somniq/skills/
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(runtime::aris_project_skills_dir(&cwd));
    }

    // 3. Legacy Claude Code skills are opt-in compatibility only.
    if runtime::legacy_claude_skills_enabled() {
        roots.push(runtime::claude_user_skills_dir());

        if let Ok(cwd) = std::env::current_dir() {
            roots.push(runtime::claude_project_skills_dir(&cwd));
        }
    }

    // 4. CODEX_HOME/skills (explicit legacy compat)
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        roots.push(std::path::PathBuf::from(codex_home).join("skills"));
    }

    // 5. ARIS bundled share/skills/ (next to binary)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let share_skills = bin_dir
                .parent()
                .map(|p| p.join("share").join("aris").join("skills"))
                .unwrap_or_else(|| bin_dir.join("share").join("aris").join("skills"));
            roots.push(share_skills);
        }
    }

    roots
}

fn resolve_skill_path(skill: &str) -> Result<std::path::PathBuf, String> {
    let requested = skill.trim().trim_start_matches('/').trim_start_matches('$');
    if requested.is_empty() {
        return Err(String::from("skill must not be empty"));
    }
    // The literature registry only redirects activated aliases. Staged entries
    // remain discoverable for migration reporting without changing a user's
    // existing legacy workflow prematurely.
    let requested = runtime::activated_canonical_skill_name(requested).unwrap_or(requested);
    // Reject path traversal attempts
    if requested.contains("..") || requested.contains('/') || requested.contains('\\') {
        return Err(format!("invalid skill name: {requested}"));
    }

    for root in skill_search_roots() {
        // Direct match: root/<skill>/SKILL.md
        let direct = root.join(requested).join("SKILL.md");
        if direct.exists() && !is_symlink(&direct) {
            return Ok(direct);
        }

        // Case-insensitive scan
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                // Reject symlinks to prevent directory traversal
                if is_symlink(&entry.path()) {
                    continue;
                }
                let path = entry.path().join("SKILL.md");
                if !path.exists() || is_symlink(&path) {
                    continue;
                }
                if entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(requested)
                {
                    return Ok(path);
                }
            }
        }
    }

    Err(format!("unknown skill: {requested}"))
}

/// A discovered skill with parsed frontmatter metadata.
#[derive(Debug, Clone, Serialize)]
pub struct SkillMeta {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub allowed_tools: Option<String>,
    pub path: std::path::PathBuf,
}

/// Discover all available skills from all search roots.
pub fn discover_skills() -> Vec<SkillMeta> {
    let mut seen = std::collections::HashSet::new();
    let mut skills = Vec::new();

    for root in skill_search_roots() {
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            // Reject symlinks to prevent directory traversal
            if is_symlink(&entry.path()) {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.exists() || is_symlink(&skill_md) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // First-found wins (ARIS user > ARIS project > explicit compat > bundled)
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());

            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let meta = parse_skill_frontmatter(&name, &content, skill_md);
            skills.push(meta);
        }
    }

    // Bundled skills as final fallback (user overrides already took priority above)
    for (name, content) in BUNDLED_SKILLS {
        if seen.contains(*name) {
            continue;
        }
        seen.insert(name.to_string());
        let meta = parse_skill_frontmatter(
            name,
            content,
            std::path::PathBuf::from(format!("<bundled:{name}>")),
        );
        skills.push(meta);
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Return the raw `SKILL.md` markdown for a skill by name, resolving filesystem
/// skills first (ARIS user > ARIS project > explicit compat roots) and falling back to the bundled
/// copy. Used by external UIs (e.g. the desktop app) to preview a skill without
/// executing it. Returns `None` if no skill of that name exists.
pub fn skill_markdown(name: &str) -> Option<String> {
    let resolution = runtime::registered_literature_skill(name)
        .filter(|resolution| resolution.lifecycle == runtime::SkillLifecycle::Active);
    let resolved_name = resolution
        .as_ref()
        .map_or(name, |resolution| resolution.canonical_name);
    if let Ok(path) = resolve_skill_path(name) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return Some(with_activated_skill_profile(content, resolution.as_ref()));
        }
    }
    for (bundled_name, content) in BUNDLED_SKILLS {
        if bundled_name.eq_ignore_ascii_case(resolved_name) {
            return Some(with_activated_skill_profile(
                (*content).to_string(),
                resolution.as_ref(),
            ));
        }
    }
    None
}

fn with_activated_skill_profile(
    mut content: String,
    resolution: Option<&runtime::RegisteredSkillResolution>,
) -> String {
    let Some(resolution) = resolution.filter(|resolution| {
        !resolution
            .requested_name
            .eq_ignore_ascii_case(resolution.canonical_name)
    }) else {
        return content;
    };
    content.push_str(&format!(
        "\n\n## Activated compatibility profile\n\nThis invocation used the legacy alias `{}`. Run the canonical `{}` workflow with profile `{}` and preserve the alias-specific behavior described by that profile.\n",
        resolution.requested_name,
        resolution.canonical_name,
        resolution.profile.unwrap_or("default"),
    ));
    content
}

/// Parse YAML frontmatter from a SKILL.md file.
/// Expects `---` delimited YAML block at the top with fields like
/// name, description, argument-hint, allowed-tools.
fn parse_skill_frontmatter(dir_name: &str, content: &str, path: std::path::PathBuf) -> SkillMeta {
    let mut name = dir_name.to_string();
    let mut description = None;
    let mut argument_hint = None;
    let mut allowed_tools = None;

    // Check if content starts with YAML frontmatter
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        if let Some(end) = trimmed[3..].find("---") {
            let yaml_block = &trimmed[3..3 + end];
            for line in yaml_block.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("name:") {
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        name = val.to_string();
                    }
                } else if let Some(val) = line.strip_prefix("description:") {
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        description = Some(val.to_string());
                    }
                } else if let Some(val) = line.strip_prefix("argument-hint:") {
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        argument_hint = Some(val.to_string());
                    }
                } else if let Some(val) = line.strip_prefix("allowed-tools:") {
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        allowed_tools = Some(val.to_string());
                    }
                }
            }
        }
    }

    // Fallback: try old-style description: line anywhere in content
    if description.is_none() {
        description = parse_skill_description(content);
    }

    SkillMeta {
        name,
        description,
        argument_hint,
        allowed_tools,
        path,
    }
}

const DEFAULT_AGENT_MODEL: &str = "claude-opus-4-8";
/// Subagent fallback when DEFAULT_AGENT_MODEL is unavailable on the account
/// (404 not_found). Mirrors the main session's DEFAULT_MODEL_FALLBACK so a
/// user without Opus 4.8 access doesn't hit hard subagent failures.
const DEFAULT_AGENT_MODEL_FALLBACK: &str = "claude-opus-4-7";
const DEFAULT_AGENT_MAX_ITERATIONS: usize = 32;

/// Subagent system date — use the same dynamic today as the main runtime
/// (`runtime::today_iso`) so subagents don't get a frozen `"2026-03-31"`
/// in their system prompt. Helper fn rather than a const so it stays live.
fn default_agent_system_date() -> String {
    runtime::today_iso()
}

fn execute_agent(input: AgentInput) -> Result<AgentOutput, String> {
    execute_agent_with_spawn(input, spawn_agent_job)
}

fn execute_agent_with_spawn<F>(input: AgentInput, spawn_fn: F) -> Result<AgentOutput, String>
where
    F: FnOnce(AgentJob) -> Result<(), String>,
{
    execute_agent_with_spawn_and_tools(input, spawn_fn, None)
}

fn execute_agent_with_spawn_and_tools<F>(
    input: AgentInput,
    spawn_fn: F,
    allowed_tools_override: Option<BTreeSet<String>>,
) -> Result<AgentOutput, String>
where
    F: FnOnce(AgentJob) -> Result<(), String>,
{
    if input.description.trim().is_empty() {
        return Err(String::from("description must not be empty"));
    }
    if input.prompt.trim().is_empty() {
        return Err(String::from("prompt must not be empty"));
    }

    let agent_id = make_agent_id();
    let output_dir = agent_store_dir()?;
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let output_file = output_dir.join(format!("{agent_id}.md"));
    let manifest_file = output_dir.join(format!("{agent_id}.json"));
    let normalized_subagent_type = normalize_subagent_type(input.subagent_type.as_deref());
    let model = resolve_agent_model(input.model.as_deref());
    let agent_name = input
        .name
        .as_deref()
        .map(slugify_agent_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| slugify_agent_name(&input.description));
    let created_at = iso8601_now();
    let system_prompt = build_agent_system_prompt(&normalized_subagent_type)?;
    let allowed_tools = allowed_tools_override
        .unwrap_or_else(|| allowed_tools_for_subagent(&normalized_subagent_type));

    let output_contents = format!(
        "# Agent Task

- id: {}
- name: {}
- description: {}
- subagent_type: {}
- created_at: {}

## Prompt

{}
",
        agent_id, agent_name, input.description, normalized_subagent_type, created_at, input.prompt
    );
    std::fs::write(&output_file, output_contents).map_err(|error| error.to_string())?;

    let manifest = AgentOutput {
        agent_id,
        name: agent_name,
        description: input.description,
        subagent_type: Some(normalized_subagent_type),
        model: Some(model),
        status: String::from("running"),
        output_file: output_file.display().to_string(),
        manifest_file: manifest_file.display().to_string(),
        created_at: created_at.clone(),
        started_at: Some(created_at),
        completed_at: None,
        error: None,
        usage: None,
    };
    write_agent_manifest(&manifest)?;

    let manifest_for_spawn = manifest.clone();
    let job = AgentJob {
        manifest: manifest_for_spawn,
        prompt: input.prompt,
        system_prompt,
        allowed_tools,
    };
    if let Err(error) = spawn_fn(job) {
        let error = format!("failed to spawn sub-agent: {error}");
        persist_agent_terminal_state(&manifest, "failed", None, Some(error.clone()), None)?;
        return Err(error);
    }

    Ok(manifest)
}

fn spawn_agent_job(job: AgentJob) -> Result<(), String> {
    let thread_name = format!("clawd-agent-{}", job.manifest.agent_id);
    std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_agent_job(&job)));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    let _ = persist_agent_terminal_state(
                        &job.manifest,
                        "failed",
                        None,
                        Some(error),
                        None,
                    );
                }
                Err(_) => {
                    let _ = persist_agent_terminal_state(
                        &job.manifest,
                        "failed",
                        None,
                        Some(String::from("sub-agent thread panicked")),
                        None,
                    );
                }
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn run_agent_job(job: &AgentJob) -> Result<(), String> {
    let mut runtime = build_agent_runtime(job)?.with_max_iterations(DEFAULT_AGENT_MAX_ITERATIONS);
    let summary = runtime
        .run_turn(job.prompt.clone(), None)
        .map_err(|error| error.to_string())?;
    let final_text = final_assistant_text(&summary);
    persist_agent_terminal_state(
        &job.manifest,
        "completed",
        Some(final_text.as_str()),
        None,
        Some(AgentTokenUsage {
            input_tokens: summary.usage.input_tokens,
            output_tokens: summary.usage.output_tokens,
            cache_creation_input_tokens: summary.usage.cache_creation_input_tokens,
            cache_read_input_tokens: summary.usage.cache_read_input_tokens,
        }),
    )
}

fn build_agent_runtime(
    job: &AgentJob,
) -> Result<ConversationRuntime<SubagentRuntimeClient, SubagentToolExecutor>, String> {
    let model = job
        .manifest
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_AGENT_MODEL.to_string());
    let allowed_tools = job.allowed_tools.clone();
    let api_client = SubagentRuntimeClient::new(model, allowed_tools.clone())?;
    let tool_executor = SubagentToolExecutor::new(allowed_tools);
    Ok(ConversationRuntime::new(
        Session::new(),
        api_client,
        tool_executor,
        agent_permission_policy(),
        job.system_prompt.clone(),
    ))
}

fn build_agent_system_prompt(subagent_type: &str) -> Result<Vec<String>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut prompt = load_system_prompt(
        cwd,
        default_agent_system_date(),
        std::env::consts::OS,
        "unknown",
        None,
    )
    .map_err(|error| error.to_string())?;
    prompt.push(format!(
        "You are a background sub-agent of type `{subagent_type}`. Work only on the delegated task, use only the tools available to you, do not ask the user questions, and finish with a concise result. You are an individual contributor: do not spawn your own teammates or form nested teams."
    ));
    Ok(prompt)
}

fn resolve_agent_model(model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(DEFAULT_AGENT_MODEL)
        .to_string()
}

fn allowed_tools_for_subagent(subagent_type: &str) -> BTreeSet<String> {
    let tools = match subagent_type {
        "Explore" => vec![
            "read_file",
            "glob_search",
            "grep_search",
            "WebFetch",
            "WebSearch",
            "ToolSearch",
            "Skill",
            "StructuredOutput",
        ],
        "Plan" => vec![
            "read_file",
            "glob_search",
            "grep_search",
            "WebFetch",
            "WebSearch",
            "ToolSearch",
            "Skill",
            "TodoWrite",
            "StructuredOutput",
            "SendUserMessage",
        ],
        "Verification" => vec![
            "bash",
            "read_file",
            "glob_search",
            "grep_search",
            "WebFetch",
            "WebSearch",
            "ToolSearch",
            "TodoWrite",
            "StructuredOutput",
            "SendUserMessage",
            "PowerShell",
        ],
        "claw-code-guide" => vec![
            "read_file",
            "glob_search",
            "grep_search",
            "WebFetch",
            "WebSearch",
            "ToolSearch",
            "Skill",
            "StructuredOutput",
            "SendUserMessage",
        ],
        "statusline-setup" => vec![
            "bash",
            "read_file",
            "write_file",
            "append_file",
            "edit_file",
            "glob_search",
            "grep_search",
            "ToolSearch",
        ],
        _ => vec![
            "bash",
            "read_file",
            "write_file",
            "append_file",
            "edit_file",
            "glob_search",
            "grep_search",
            "WebFetch",
            "WebSearch",
            "TodoWrite",
            "Skill",
            "ToolSearch",
            "NotebookEdit",
            "Sleep",
            "SendUserMessage",
            "Config",
            "StructuredOutput",
            "REPL",
            "PowerShell",
        ],
    };
    apply_inherited_allowed_tools(tools.into_iter().map(str::to_string).collect())
}

fn inherited_allowed_tools() -> Option<BTreeSet<String>> {
    std::env::var("ARIS_ALLOWED_TOOLS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        })
        .filter(|tools| !tools.is_empty())
}

fn apply_inherited_allowed_tools(base: BTreeSet<String>) -> BTreeSet<String> {
    let inherited = inherited_allowed_tools();
    if let Some(inherited) = inherited.as_ref() {
        base.intersection(inherited)
            .cloned()
            .collect::<BTreeSet<_>>()
    } else {
        base
    }
}

fn agent_permission_policy() -> PermissionPolicy {
    mvp_tool_specs().into_iter().fold(
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        |policy, spec| policy.with_tool_requirement(spec.name, spec.required_permission),
    )
}

fn write_agent_manifest(manifest: &AgentOutput) -> Result<(), String> {
    std::fs::write(
        &manifest.manifest_file,
        serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn persist_agent_terminal_state(
    manifest: &AgentOutput,
    status: &str,
    result: Option<&str>,
    error: Option<String>,
    usage: Option<AgentTokenUsage>,
) -> Result<(), String> {
    append_agent_output(
        &manifest.output_file,
        &format_agent_terminal_output(status, result, error.as_deref()),
    )?;
    let mut next_manifest = manifest.clone();
    next_manifest.status = status.to_string();
    next_manifest.completed_at = Some(iso8601_now());
    next_manifest.error = error;
    next_manifest.usage = usage.or_else(|| manifest.usage.clone());
    write_agent_manifest(&next_manifest)
}

fn append_agent_output(path: &str, suffix: &str) -> Result<(), String> {
    use std::io::Write as _;

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(suffix.as_bytes())
        .map_err(|error| error.to_string())
}

fn format_agent_terminal_output(status: &str, result: Option<&str>, error: Option<&str>) -> String {
    let mut sections = vec![format!("\n## Result\n\n- status: {status}\n")];
    if let Some(result) = result.filter(|value| !value.trim().is_empty()) {
        sections.push(format!("\n### Final response\n\n{}\n", result.trim()));
    }
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        sections.push(format!("\n### Error\n\n{}\n", error.trim()));
    }
    sections.join("")
}

struct SubagentRuntimeClient {
    auth: AuthSource,
    base_url: String,
    send_betas: bool,
    model: String,
    allowed_tools: BTreeSet<String>,
    inner: SharedAnthropicRuntimeClient,
    /// Latches the subagent's Opus 4.8 to 4.7 fallback so it warns once and
    /// never re-probes on subsequent turns.
    model_fell_back: bool,
}

impl SubagentRuntimeClient {
    fn new(model: String, allowed_tools: BTreeSet<String>) -> Result<Self, String> {
        let auth = AuthSource::from_env_or_saved().map_err(|error| error.to_string())?;
        let base_url = read_base_url();
        let send_betas = read_send_betas();
        let inner =
            build_subagent_executor(auth.clone(), &base_url, send_betas, &model, &allowed_tools)?;
        Ok(Self {
            auth,
            base_url,
            send_betas,
            model,
            allowed_tools,
            inner,
            model_fell_back: false,
        })
    }

    fn rebuild_inner(&mut self) -> Result<(), String> {
        self.inner = build_subagent_executor(
            self.auth.clone(),
            &self.base_url,
            self.send_betas,
            &self.model,
            &self.allowed_tools,
        )?;
        Ok(())
    }
}

impl ApiClient for SubagentRuntimeClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        match self.inner.stream(request.clone()) {
            Ok(events) => Ok(events),
            Err(error)
                if error.is_model_unavailable()
                    && self.model == DEFAULT_AGENT_MODEL
                    && !self.model_fell_back =>
            {
                self.model_fell_back = true;
                self.model = DEFAULT_AGENT_MODEL_FALLBACK.to_string();
                eprintln!(
                    "\x1b[33mwarning:\x1b[0m {DEFAULT_AGENT_MODEL} is not available on this \
                     account; subagent falling back to {DEFAULT_AGENT_MODEL_FALLBACK}."
                );
                self.rebuild_inner().map_err(RuntimeError::new)?;
                self.inner.stream(request)
            }
            Err(error) => Err(error),
        }
    }
}

fn build_subagent_executor(
    auth: AuthSource,
    base_url: &str,
    send_betas: bool,
    model: &str,
    allowed_tools: &BTreeSet<String>,
) -> Result<SharedAnthropicRuntimeClient, String> {
    let tool_specs = tool_specs_for_allowed_tools(Some(allowed_tools))
        .into_iter()
        .map(|spec| ExecutorToolSpec::new(spec.name, spec.description, spec.input_schema))
        .collect::<Vec<_>>();
    SharedAnthropicRuntimeClient::new(
        auth,
        base_url.to_string(),
        send_betas,
        model.to_string(),
        !tool_specs.is_empty(),
        tool_specs,
        32_000,
        Box::new(NoopStreamObserver),
    )
}

struct SubagentToolExecutor {
    allowed_tools: BTreeSet<String>,
}

impl SubagentToolExecutor {
    fn new(allowed_tools: BTreeSet<String>) -> Self {
        Self { allowed_tools }
    }
}

impl ToolExecutor for SubagentToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        if !self.allowed_tools.contains(tool_name) {
            return Err(ToolError::new(format!(
                "tool `{tool_name}` is not enabled for this sub-agent"
            )));
        }
        let value = serde_json::from_str(input)
            .map_err(|error| ToolError::new(format!("invalid tool input JSON: {error}")))?;
        execute_tool(tool_name, &value).map_err(ToolError::new)
    }
}

fn tool_specs_for_allowed_tools(allowed_tools: Option<&BTreeSet<String>>) -> Vec<ToolSpec> {
    mvp_tool_specs()
        .into_iter()
        .filter(|spec| allowed_tools.is_none_or(|allowed| allowed.contains(spec.name)))
        .collect()
}

fn final_assistant_text(summary: &runtime::TurnSummary) -> String {
    runtime::assistant_text_from_turn_summary(summary)
}

#[allow(clippy::needless_pass_by_value)]
fn execute_tool_search(input: ToolSearchInput) -> ToolSearchOutput {
    let deferred = deferred_tool_specs();
    let max_results = input.max_results.unwrap_or(5).max(1);
    let query = input.query.trim().to_string();
    let normalized_query = normalize_tool_search_query(&query);
    let matches = search_tool_specs(&query, max_results, &deferred);

    ToolSearchOutput {
        matches,
        query,
        normalized_query,
        total_deferred_tools: deferred.len(),
        pending_mcp_servers: None,
    }
}

fn deferred_tool_specs() -> Vec<ToolSpec> {
    mvp_tool_specs()
        .into_iter()
        .filter(|spec| {
            !matches!(
                spec.name,
                "bash"
                    | "read_file"
                    | "write_file"
                    | "append_file"
                    | "edit_file"
                    | "change_list"
                    | "change_get"
                    | "change_revert"
                    | "glob_search"
                    | "grep_search"
                    | "memory"
                    | "session_search"
            )
        })
        .collect()
}

fn search_tool_specs(query: &str, max_results: usize, specs: &[ToolSpec]) -> Vec<String> {
    let lowered = query.to_lowercase();
    if let Some(selection) = lowered.strip_prefix("select:") {
        return selection
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .filter_map(|wanted| {
                let wanted = canonical_tool_token(wanted);
                specs
                    .iter()
                    .find(|spec| canonical_tool_token(spec.name) == wanted)
                    .map(|spec| spec.name.to_string())
            })
            .take(max_results)
            .collect();
    }

    let mut required = Vec::new();
    let mut optional = Vec::new();
    for term in lowered.split_whitespace() {
        if let Some(rest) = term.strip_prefix('+') {
            if !rest.is_empty() {
                required.push(rest);
            }
        } else {
            optional.push(term);
        }
    }
    let terms = if required.is_empty() {
        optional.clone()
    } else {
        required.iter().chain(optional.iter()).copied().collect()
    };

    let mut scored = specs
        .iter()
        .filter_map(|spec| {
            let name = spec.name.to_lowercase();
            let canonical_name = canonical_tool_token(spec.name);
            let normalized_description = normalize_tool_search_query(spec.description);
            let haystack = format!(
                "{name} {} {canonical_name}",
                spec.description.to_lowercase()
            );
            let normalized_haystack = format!("{canonical_name} {normalized_description}");
            if required.iter().any(|term| !haystack.contains(term)) {
                return None;
            }

            let mut score = 0_i32;
            for term in &terms {
                let canonical_term = canonical_tool_token(term);
                if haystack.contains(term) {
                    score += 2;
                }
                if name == *term {
                    score += 8;
                }
                if name.contains(term) {
                    score += 4;
                }
                if canonical_name == canonical_term {
                    score += 12;
                }
                if normalized_haystack.contains(&canonical_term) {
                    score += 3;
                }
            }

            if score == 0 && !lowered.is_empty() {
                return None;
            }
            Some((score, spec.name.to_string()))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    scored
        .into_iter()
        .map(|(_, name)| name)
        .take(max_results)
        .collect()
}

fn normalize_tool_search_query(query: &str) -> String {
    query
        .trim()
        .split(|ch: char| ch.is_whitespace() || ch == ',')
        .filter(|term| !term.is_empty())
        .map(canonical_tool_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn canonical_tool_token(value: &str) -> String {
    let mut canonical = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if let Some(stripped) = canonical.strip_suffix("tool") {
        canonical = stripped.to_string();
    }
    canonical
}

fn agent_store_dir() -> Result<std::path::PathBuf, String> {
    runtime::migrate_legacy_project_runtime_dirs(runtime::workspace_root_from_env())
        .map_err(|error| error.to_string())?;
    let dir = runtime::project_agent_store_dir_from_env();
    if dir.as_os_str().is_empty() {
        return Err("agent store path is empty".to_string());
    }
    Ok(dir)
}

fn make_agent_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("agent-{nanos}")
}

fn slugify_agent_name(description: &str) -> String {
    let mut out = description
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(32).collect()
}

fn normalize_subagent_type(subagent_type: Option<&str>) -> String {
    let trimmed = subagent_type.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return String::from("general-purpose");
    }

    match canonical_tool_token(trimmed).as_str() {
        "general" | "generalpurpose" | "generalpurposeagent" => String::from("general-purpose"),
        "explore" | "explorer" | "exploreagent" => String::from("Explore"),
        "plan" | "planagent" => String::from("Plan"),
        "verification" | "verificationagent" | "verify" | "verifier" => {
            String::from("Verification")
        }
        "claudecodeguide" | "claudecodeguideagent" | "guide" => String::from("claw-code-guide"),
        "statusline" | "statuslinesetup" => String::from("statusline-setup"),
        _ => trimmed.to_string(),
    }
}

fn iso8601_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[allow(clippy::too_many_lines)]
fn execute_notebook_edit(input: NotebookEditInput) -> Result<NotebookEditOutput, String> {
    let path = std::path::PathBuf::from(&input.notebook_path);
    if path.extension().and_then(|ext| ext.to_str()) != Some("ipynb") {
        return Err(String::from(
            "File must be a Jupyter notebook (.ipynb file).",
        ));
    }

    let original_file = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut notebook: serde_json::Value =
        serde_json::from_str(&original_file).map_err(|error| error.to_string())?;
    let language = notebook
        .get("metadata")
        .and_then(|metadata| metadata.get("kernelspec"))
        .and_then(|kernelspec| kernelspec.get("language"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("python")
        .to_string();
    let cells = notebook
        .get_mut("cells")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| String::from("Notebook cells array not found"))?;

    let edit_mode = input.edit_mode.unwrap_or(NotebookEditMode::Replace);
    let target_index = match input.cell_id.as_deref() {
        Some(cell_id) => Some(resolve_cell_index(cells, Some(cell_id), edit_mode)?),
        None if matches!(
            edit_mode,
            NotebookEditMode::Replace | NotebookEditMode::Delete
        ) =>
        {
            Some(resolve_cell_index(cells, None, edit_mode)?)
        }
        None => None,
    };
    let resolved_cell_type = match edit_mode {
        NotebookEditMode::Delete => None,
        NotebookEditMode::Insert => Some(input.cell_type.unwrap_or(NotebookCellType::Code)),
        NotebookEditMode::Replace => Some(input.cell_type.unwrap_or_else(|| {
            target_index
                .and_then(|index| cells.get(index))
                .and_then(cell_kind)
                .unwrap_or(NotebookCellType::Code)
        })),
    };
    let new_source = require_notebook_source(input.new_source, edit_mode)?;

    let cell_id = match edit_mode {
        NotebookEditMode::Insert => {
            let resolved_cell_type = resolved_cell_type.expect("insert cell type");
            let new_id = make_cell_id(cells.len());
            let new_cell = build_notebook_cell(&new_id, resolved_cell_type, &new_source);
            let insert_at = target_index.map_or(cells.len(), |index| index + 1);
            cells.insert(insert_at, new_cell);
            cells
                .get(insert_at)
                .and_then(|cell| cell.get("id"))
                .and_then(serde_json::Value::as_str)
                .map(ToString::to_string)
        }
        NotebookEditMode::Delete => {
            let removed = cells.remove(target_index.expect("delete target index"));
            removed
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToString::to_string)
        }
        NotebookEditMode::Replace => {
            let resolved_cell_type = resolved_cell_type.expect("replace cell type");
            let cell = cells
                .get_mut(target_index.expect("replace target index"))
                .ok_or_else(|| String::from("Cell index out of range"))?;
            cell["source"] = serde_json::Value::Array(source_lines(&new_source));
            cell["cell_type"] = serde_json::Value::String(match resolved_cell_type {
                NotebookCellType::Code => String::from("code"),
                NotebookCellType::Markdown => String::from("markdown"),
            });
            match resolved_cell_type {
                NotebookCellType::Code => {
                    if !cell.get("outputs").is_some_and(serde_json::Value::is_array) {
                        cell["outputs"] = json!([]);
                    }
                    if cell.get("execution_count").is_none() {
                        cell["execution_count"] = serde_json::Value::Null;
                    }
                }
                NotebookCellType::Markdown => {
                    if let Some(object) = cell.as_object_mut() {
                        object.remove("outputs");
                        object.remove("execution_count");
                    }
                }
            }
            cell.get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToString::to_string)
        }
    };

    let updated_file =
        serde_json::to_string_pretty(&notebook).map_err(|error| error.to_string())?;
    std::fs::write(&path, &updated_file).map_err(|error| error.to_string())?;

    Ok(NotebookEditOutput {
        new_source,
        cell_id,
        cell_type: resolved_cell_type,
        language,
        edit_mode: format_notebook_edit_mode(edit_mode),
        error: None,
        notebook_path: path.display().to_string(),
        original_file,
        updated_file,
    })
}

fn require_notebook_source(
    source: Option<String>,
    edit_mode: NotebookEditMode,
) -> Result<String, String> {
    match edit_mode {
        NotebookEditMode::Delete => Ok(source.unwrap_or_default()),
        NotebookEditMode::Insert | NotebookEditMode::Replace => source
            .ok_or_else(|| String::from("new_source is required for insert and replace edits")),
    }
}

fn build_notebook_cell(cell_id: &str, cell_type: NotebookCellType, source: &str) -> Value {
    let mut cell = json!({
        "cell_type": match cell_type {
            NotebookCellType::Code => "code",
            NotebookCellType::Markdown => "markdown",
        },
        "id": cell_id,
        "metadata": {},
        "source": source_lines(source),
    });
    if let Some(object) = cell.as_object_mut() {
        match cell_type {
            NotebookCellType::Code => {
                object.insert(String::from("outputs"), json!([]));
                object.insert(String::from("execution_count"), Value::Null);
            }
            NotebookCellType::Markdown => {}
        }
    }
    cell
}

fn cell_kind(cell: &serde_json::Value) -> Option<NotebookCellType> {
    cell.get("cell_type")
        .and_then(serde_json::Value::as_str)
        .map(|kind| {
            if kind == "markdown" {
                NotebookCellType::Markdown
            } else {
                NotebookCellType::Code
            }
        })
}

#[allow(clippy::needless_pass_by_value)]
fn execute_sleep(
    input: SleepInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<SleepOutput, String> {
    let started = Instant::now();
    let duration = Duration::from_millis(input.duration_ms);
    while started.elapsed() < duration {
        if runtime::is_interrupted() || should_cancel() {
            return Err(String::from("interrupted by user"));
        }
        let remaining = duration.saturating_sub(started.elapsed());
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
    Ok(SleepOutput {
        duration_ms: input.duration_ms,
        message: format!("Slept for {}ms", input.duration_ms),
    })
}

fn execute_brief(input: BriefInput) -> Result<BriefOutput, String> {
    if input.message.trim().is_empty() {
        return Err(String::from("message must not be empty"));
    }

    let attachments = input
        .attachments
        .as_ref()
        .map(|paths| {
            paths
                .iter()
                .map(|path| resolve_attachment(path))
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?;

    let message = match input.status {
        BriefStatus::Normal | BriefStatus::Proactive => input.message,
    };

    Ok(BriefOutput {
        message,
        attachments,
        sent_at: iso8601_timestamp(),
    })
}

fn resolve_attachment(path: &str) -> Result<ResolvedAttachment, String> {
    let resolved = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(&resolved).map_err(|error| error.to_string())?;
    Ok(ResolvedAttachment {
        path: resolved.display().to_string(),
        size: metadata.len(),
        is_image: is_image_path(&resolved),
    })
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
    )
}

fn execute_config(input: ConfigInput) -> Result<ConfigOutput, String> {
    let setting = input.setting.trim();
    if setting.is_empty() {
        return Err(String::from("setting must not be empty"));
    }
    let Some(spec) = supported_config_setting(setting) else {
        return Ok(ConfigOutput {
            success: false,
            operation: None,
            setting: None,
            value: None,
            previous_value: None,
            new_value: None,
            error: Some(format!("Unknown setting: \"{setting}\"")),
        });
    };

    let path = config_file_for_scope(spec.scope)?;
    let mut document = read_json_object(&path)?;

    if let Some(value) = input.value {
        let normalized = normalize_config_value(spec, value)?;
        let previous_value = get_nested_value(&document, spec.path).cloned();
        set_nested_value(&mut document, spec.path, normalized.clone());
        write_json_object(&path, &document)?;
        Ok(ConfigOutput {
            success: true,
            operation: Some(String::from("set")),
            setting: Some(setting.to_string()),
            value: Some(normalized.clone()),
            previous_value,
            new_value: Some(normalized),
            error: None,
        })
    } else {
        Ok(ConfigOutput {
            success: true,
            operation: Some(String::from("get")),
            setting: Some(setting.to_string()),
            value: get_nested_value(&document, spec.path).cloned(),
            previous_value: None,
            new_value: None,
            error: None,
        })
    }
}

fn execute_structured_output(input: StructuredOutputInput) -> StructuredOutputResult {
    StructuredOutputResult {
        data: String::from("Structured output provided successfully"),
        structured_output: input.0,
    }
}

fn execute_repl(input: ReplInput, should_cancel: &dyn Fn() -> bool) -> Result<ReplOutput, String> {
    if input.code.trim().is_empty() {
        return Err(String::from("code must not be empty"));
    }
    if repl_invokes_latex_compiler(&input.code) {
        return Err(String::from(
            "REPL must not invoke pdflatex/xelatex/lualatex/latexmk. Use LaTeXCompile so Windows paths, engine selection, cache recovery, diagnostics, and repair guardrails stay consistent.",
        ));
    }
    let runtime = resolve_repl_runtime(&input.language)?;
    let started = Instant::now();
    let mut command = runtime::hidden_command(runtime.program);
    command.args(runtime.args).arg(&input.code);
    let output = runtime::run_managed_command_with_cancel(
        &mut command,
        format!(
            "REPL {}: {}",
            input.language,
            truncate_process_label(&input.code)
        ),
        input.timeout_ms.map(Duration::from_millis),
        true,
        should_cancel,
    )
    .map_err(|error| error.to_string())?;

    Ok(ReplOutput {
        language: input.language,
        stdout: runtime::decode_process_text(&output.stdout),
        stderr: repl_stderr(&output),
        exit_code: output.status.code().unwrap_or(1),
        duration_ms: started.elapsed().as_millis(),
    })
}

fn repl_invokes_latex_compiler(code: &str) -> bool {
    let lower = code.to_ascii_lowercase();
    let names_tex_compiler = ["latexmk", "pdflatex", "xelatex", "lualatex"]
        .iter()
        .any(|compiler| lower.contains(compiler));
    if !names_tex_compiler {
        return false;
    }
    [
        "subprocess.",
        "os.system",
        "os.popen",
        "command::new",
        "processbuilder",
        "shell=true",
        "shell = true",
        "system(",
        "popen(",
        "spawn(",
        "run(",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with('!')
                && ["latexmk", "pdflatex", "xelatex", "lualatex"]
                    .iter()
                    .any(|compiler| line.contains(compiler))
        })
}

fn repl_stderr(output: &runtime::ManagedCommandOutput) -> String {
    let stderr = runtime::decode_process_text(&output.stderr);
    if output.timed_out {
        append_process_status_message(stderr, "REPL exceeded timeout")
    } else if output.interrupted {
        append_process_status_message(stderr, "REPL interrupted by user")
    } else {
        stderr
    }
}

struct ReplRuntime {
    program: &'static str,
    args: &'static [&'static str],
}

fn resolve_repl_runtime(language: &str) -> Result<ReplRuntime, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "python" | "py" => Ok(ReplRuntime {
            program: detect_first_command(&["python3", "python"])
                .ok_or_else(|| String::from("python runtime not found"))?,
            args: &["-c"],
        }),
        "javascript" | "js" | "node" => Ok(ReplRuntime {
            program: detect_first_command(&["node"])
                .ok_or_else(|| String::from("node runtime not found"))?,
            args: &["-e"],
        }),
        "sh" | "shell" | "bash" => Ok(ReplRuntime {
            program: detect_first_command(&["bash", "sh"])
                .ok_or_else(|| String::from("shell runtime not found"))?,
            args: &["-lc"],
        }),
        other => Err(format!("unsupported REPL language: {other}")),
    }
}

fn detect_first_command(commands: &[&'static str]) -> Option<&'static str> {
    commands
        .iter()
        .copied()
        .find(|command| runtime::command_exists(command))
}

#[derive(Clone, Copy)]
enum ConfigScope {
    Global,
    Settings,
}

#[derive(Clone, Copy)]
struct ConfigSettingSpec {
    scope: ConfigScope,
    kind: ConfigKind,
    path: &'static [&'static str],
    options: Option<&'static [&'static str]>,
}

#[derive(Clone, Copy)]
enum ConfigKind {
    Boolean,
    String,
}

fn supported_config_setting(setting: &str) -> Option<ConfigSettingSpec> {
    Some(match setting {
        "theme" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::String,
            path: &["theme"],
            options: None,
        },
        "editorMode" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::String,
            path: &["editorMode"],
            options: Some(&["default", "vim", "emacs"]),
        },
        "verbose" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["verbose"],
            options: None,
        },
        "preferredNotifChannel" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::String,
            path: &["preferredNotifChannel"],
            options: None,
        },
        "autoCompactEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["autoCompactEnabled"],
            options: None,
        },
        "autoMemoryEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::Boolean,
            path: &["autoMemoryEnabled"],
            options: None,
        },
        "autoDreamEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::Boolean,
            path: &["autoDreamEnabled"],
            options: None,
        },
        "fileCheckpointingEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["fileCheckpointingEnabled"],
            options: None,
        },
        "showTurnDuration" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["showTurnDuration"],
            options: None,
        },
        "terminalProgressBarEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["terminalProgressBarEnabled"],
            options: None,
        },
        "todoFeatureEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::Boolean,
            path: &["todoFeatureEnabled"],
            options: None,
        },
        "model" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::String,
            path: &["model"],
            options: None,
        },
        "alwaysThinkingEnabled" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::Boolean,
            path: &["alwaysThinkingEnabled"],
            options: None,
        },
        "permissions.defaultMode" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::String,
            path: &["permissions", "defaultMode"],
            options: Some(&["default", "plan", "acceptEdits", "dontAsk", "auto"]),
        },
        "language" => ConfigSettingSpec {
            scope: ConfigScope::Settings,
            kind: ConfigKind::String,
            path: &["language"],
            options: None,
        },
        "teammateMode" => ConfigSettingSpec {
            scope: ConfigScope::Global,
            kind: ConfigKind::String,
            path: &["teammateMode"],
            options: Some(&["tmux", "in-process", "auto"]),
        },
        _ => return None,
    })
}

fn normalize_config_value(spec: ConfigSettingSpec, value: ConfigValue) -> Result<Value, String> {
    let normalized = match (spec.kind, value) {
        (ConfigKind::Boolean, ConfigValue::Bool(value)) => Value::Bool(value),
        (ConfigKind::Boolean, ConfigValue::String(value)) => {
            match value.trim().to_ascii_lowercase().as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => return Err(String::from("setting requires true or false")),
            }
        }
        (ConfigKind::Boolean, ConfigValue::Number(_)) => {
            return Err(String::from("setting requires true or false"))
        }
        (ConfigKind::String, ConfigValue::String(value)) => Value::String(value),
        (ConfigKind::String, ConfigValue::Bool(value)) => Value::String(value.to_string()),
        (ConfigKind::String, ConfigValue::Number(value)) => json!(value),
    };

    if let Some(options) = spec.options {
        let Some(as_str) = normalized.as_str() else {
            return Err(String::from("setting requires a string value"));
        };
        if !options.iter().any(|option| option == &as_str) {
            return Err(format!(
                "Invalid value \"{as_str}\". Options: {}",
                options.join(", ")
            ));
        }
    }

    Ok(normalized)
}

fn config_file_for_scope(scope: ConfigScope) -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    Ok(match scope {
        ConfigScope::Global => config_home_dir()?.join("settings.json"),
        ConfigScope::Settings => cwd.join(".claude").join("settings.local.json"),
    })
}

fn config_home_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("CLAUDE_CONFIG_HOME") {
        return Ok(PathBuf::from(path));
    }
    let home = Ok::<String, String>(runtime::home_dir())?;
    Ok(PathBuf::from(home).join(".claude"))
}

fn read_json_object(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok(serde_json::Map::new());
            }
            serde_json::from_str::<Value>(&contents)
                .map_err(|error| error.to_string())?
                .as_object()
                .cloned()
                .ok_or_else(|| String::from("config file must contain a JSON object"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json_object(path: &Path, value: &serde_json::Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn get_nested_value<'a>(
    value: &'a serde_json::Map<String, Value>,
    path: &[&str],
) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut current = value.get(*first)?;
    for key in rest {
        current = current.as_object()?.get(*key)?;
    }
    Some(current)
}

fn set_nested_value(root: &mut serde_json::Map<String, Value>, path: &[&str], new_value: Value) {
    let (first, rest) = path.split_first().expect("config path must not be empty");
    if rest.is_empty() {
        root.insert((*first).to_string(), new_value);
        return;
    }

    let entry = root
        .entry((*first).to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(serde_json::Map::new());
    }
    let map = entry.as_object_mut().expect("object inserted");
    set_nested_value(map, rest, new_value);
}

fn iso8601_timestamp() -> String {
    if let Ok(output) = runtime::hidden_command("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
    {
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
    }
    iso8601_now()
}

fn execute_powershell_with_cancel(
    input: PowerShellInput,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::BashCommandOutput> {
    let _ = &input.description;
    let shell = detect_powershell_shell()?;
    execute_shell_command(
        shell,
        &input.command,
        input.timeout,
        input.run_in_background,
        should_cancel,
        on_progress,
    )
}

fn execute_latex_render(input: LatexRenderInput) -> Result<LatexRenderOutput, String> {
    let workspace = canonical_workspace_root()?;
    let template_path = resolve_existing_workspace_path(&input.template_path, &workspace)?;
    let data_path = resolve_existing_workspace_path(&input.data_path, &workspace)?;
    let output_path = resolve_output_workspace_path(&input.output_path, &workspace)?;
    if !latex_path_has_extension(&template_path, "tex") {
        return Err("LaTeXRender templatePath must point to a .tex file".to_string());
    }
    if !latex_path_has_extension(&data_path, "json") {
        return Err("LaTeXRender dataPath must point to a .json file".to_string());
    }
    if !latex_path_has_extension(&output_path, "tex") {
        return Err("LaTeXRender outputPath must end with .tex".to_string());
    }
    if template_path == output_path {
        return Err(
            "LaTeXRender outputPath must differ from templatePath so the template stays stable"
                .to_string(),
        );
    }

    let template = std::fs::read_to_string(&template_path).map_err(|error| {
        format!(
            "could not read LaTeX template {}: {error}",
            template_path.display()
        )
    })?;
    let data_text = std::fs::read_to_string(&data_path)
        .map_err(|error| format!("could not read LaTeX data {}: {error}", data_path.display()))?;
    let data: Value = serde_json::from_str(&data_text)
        .map_err(|error| format!("LaTeXRender dataPath must contain valid JSON: {error}"))?;
    if !data.is_object() {
        return Err("LaTeXRender dataPath must contain a JSON object at its root".to_string());
    }
    let rendered = render_latex_template(&template, &data, None, None)?;
    std::fs::write(&output_path, rendered.as_bytes()).map_err(|error| {
        format!(
            "could not write rendered LaTeX {}: {error}",
            output_path.display()
        )
    })?;

    Ok(LatexRenderOutput {
        template_path: workspace_relative_display(&template_path, &workspace),
        data_path: workspace_relative_display(&data_path, &workspace),
        output_path: workspace_relative_display(&output_path, &workspace),
        rendered_chars: rendered.chars().count(),
    })
}

fn render_latex_template(
    template: &str,
    root: &Value,
    current: Option<&Value>,
    index: Option<usize>,
) -> Result<String, String> {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = template[cursor..].find("{{#each ") {
        let start = cursor + relative_start;
        output.push_str(&render_latex_values(
            &template[cursor..start],
            root,
            current,
            index,
        )?);
        let marker_end = template[start..]
            .find("}}")
            .map(|offset| start + offset)
            .ok_or_else(|| "LaTeXRender found an unterminated {{#each ...}} marker".to_string())?;
        let path = template[start + "{{#each ".len()..marker_end].trim();
        if path.is_empty() {
            return Err("LaTeXRender {{#each ...}} requires a JSON array path".to_string());
        }
        let body_start = marker_end + 2;
        let (body_end, after_block) = find_latex_each_end(template, body_start)?;
        let values = resolve_latex_template_value(root, current, index, path)?;
        let rows = values
            .as_array()
            .ok_or_else(|| format!("LaTeXRender {{#each {path}}} expected a JSON array"))?;
        for (row_index, row) in rows.iter().enumerate() {
            output.push_str(&render_latex_template(
                &template[body_start..body_end],
                root,
                Some(row),
                Some(row_index),
            )?);
        }
        cursor = after_block;
    }
    output.push_str(&render_latex_values(
        &template[cursor..],
        root,
        current,
        index,
    )?);
    Ok(output)
}

fn find_latex_each_end(template: &str, body_start: usize) -> Result<(usize, usize), String> {
    let mut cursor = body_start;
    let mut depth = 1_u32;
    while cursor < template.len() {
        let next_open = template[cursor..]
            .find("{{#each ")
            .map(|offset| cursor + offset);
        let next_close = template[cursor..]
            .find("{{/each}}")
            .map(|offset| cursor + offset);
        match (next_open, next_close) {
            (_, None) => {
                return Err("LaTeXRender found {{#each ...}} without {{/each}}".to_string())
            }
            (Some(open), Some(close)) if open < close => {
                let marker_end = template[open..]
                    .find("}}")
                    .map(|offset| open + offset)
                    .ok_or_else(|| {
                        "LaTeXRender found an unterminated nested {{#each ...}} marker".to_string()
                    })?;
                depth += 1;
                cursor = marker_end + 2;
            }
            (_, Some(close)) => {
                depth -= 1;
                if depth == 0 {
                    return Ok((close, close + "{{/each}}".len()));
                }
                cursor = close + "{{/each}}".len();
            }
        }
    }
    Err("LaTeXRender found {{#each ...}} without {{/each}}".to_string())
}

fn render_latex_values(
    fragment: &str,
    root: &Value,
    current: Option<&Value>,
    index: Option<usize>,
) -> Result<String, String> {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = fragment[cursor..].find("{{") {
        let start = cursor + relative_start;
        output.push_str(&fragment[cursor..start]);
        let marker_end = fragment[start + 2..]
            .find("}}")
            .map(|offset| start + 2 + offset)
            .ok_or_else(|| "LaTeXRender found an unterminated {{field}} marker".to_string())?;
        let path = fragment[start + 2..marker_end].trim();
        if path.starts_with('#') || path.starts_with('/') {
            return Err(format!(
                "LaTeXRender unexpected template marker {{{{{path}}}}}"
            ));
        }
        if path == "@index" {
            let index = index.ok_or_else(|| {
                "LaTeXRender {{@index}} is only valid inside {{#each ...}}".to_string()
            })?;
            output.push_str(&index.to_string());
            cursor = marker_end + 2;
            continue;
        }
        let value = resolve_latex_template_value(root, current, index, path)?;
        output.push_str(&latex_escape_template_value(value)?);
        cursor = marker_end + 2;
    }
    output.push_str(&fragment[cursor..]);
    Ok(output)
}

fn resolve_latex_template_value<'a>(
    root: &'a Value,
    current: Option<&'a Value>,
    index: Option<usize>,
    path: &str,
) -> Result<&'a Value, String> {
    let (base, fields) = if path == "this" {
        (
            current.ok_or_else(|| {
                "LaTeXRender {{this}} is only valid inside {{#each ...}}".to_string()
            })?,
            "",
        )
    } else if let Some(fields) = path.strip_prefix("this.") {
        (
            current.ok_or_else(|| {
                "LaTeXRender {{this.*}} is only valid inside {{#each ...}}".to_string()
            })?,
            fields,
        )
    } else {
        (root, path)
    };
    let mut value = base;
    for field in fields.split('.').filter(|field| !field.is_empty()) {
        value = value
            .as_object()
            .and_then(|object| object.get(field))
            .ok_or_else(|| format!("LaTeXRender could not resolve JSON field `{path}`"))?;
    }
    let _ = index;
    Ok(value)
}

fn latex_escape_template_value(value: &Value) -> Result<String, String> {
    let text = match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => {
            return Err(
                "LaTeXRender markers must resolve to a scalar; use {{#each ...}} for arrays"
                    .to_string(),
            )
        }
    };
    Ok(text
        .chars()
        .map(|character| match character {
            '\\' => r"\textbackslash{}".to_string(),
            '{' => r"\{".to_string(),
            '}' => r"\}".to_string(),
            '$' => r"\$".to_string(),
            '&' => r"\&".to_string(),
            '#' => r"\#".to_string(),
            '%' => r"\%".to_string(),
            '_' => r"\_".to_string(),
            '~' => r"\textasciitilde{}".to_string(),
            '^' => r"\textasciicircum{}".to_string(),
            other => other.to_string(),
        })
        .collect())
}

fn execute_latex_compile(
    input: LatexCompileInput,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> Result<LatexCompileOutput, String> {
    let workspace = canonical_workspace_root()?;
    let input_path = resolve_existing_workspace_path(&input.input_path, &workspace)?;
    if !input_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"))
    {
        return Err("LaTeXCompile inputPath must point to a .tex file".to_string());
    }
    let output_path = match input.output_path.as_deref() {
        Some(path) => resolve_output_workspace_path(path, &workspace)?,
        None => input_path.with_extension("pdf"),
    };
    if !output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("LaTeXCompile outputPath must end with .pdf".to_string());
    }
    let mut output = compile_latex_document(
        LatexCompileRequest {
            input_path: input_path.clone(),
            output_path: output_path.clone(),
            compiler: input.compiler,
            timeout_ms: input.timeout_ms,
            clean_cache: false,
            continue_on_error: false,
        },
        &workspace,
        should_cancel,
        on_progress,
    )?;
    output.input_path = workspace_relative_display(&input_path, &workspace);
    output.output_path = workspace_relative_display(&output_path, &workspace);
    Ok(output)
}

/// Compile a TeX root with one shared engine-selection, cache-recovery,
/// cancellation, diagnostic, and provenance path for the desktop and Agent.
/// Paths must already have been validated by the caller.
pub fn compile_latex_document(
    request: LatexCompileRequest,
    workspace: &Path,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> Result<LatexCompileOutput, String> {
    let input_path = request.input_path;
    let output_path = request.output_path;
    let output_dir = output_path
        .parent()
        .ok_or_else(|| "outputPath must include a file name".to_string())?;
    let source_dir = input_path
        .parent()
        .ok_or_else(|| "inputPath must include a file name".to_string())?;
    // Capture the complete discoverable project input set before launching TeX.
    // The manifest is both the provenance hash shown to users and the guard
    // against accepting a PDF assembled while an external editor was writing.
    let input_snapshot = latex_input_snapshot(&input_path, workspace);
    let compile_input_hash = latex_input_manifest_hash(&input_snapshot, workspace);
    std::fs::create_dir_all(output_dir).map_err(|error| error.to_string())?;

    let expected_pdf = output_dir
        .join(
            input_path
                .file_stem()
                .ok_or_else(|| "inputPath must include a file name".to_string())?,
        )
        .with_extension("pdf");
    let expected_pdf_before = latex_output_fingerprint(&expected_pdf);
    let timeout_ms = runtime::resolve_foreground_shell_timeout_ms(request.timeout_ms);
    let started = Instant::now();
    let cache_note = if request.clean_cache {
        let removed = remove_known_latex_cache_files(&input_path, output_dir)?;
        Some(format!(
            "LaTeX cache cleared ({removed} auxiliary file(s) removed) before recompiling."
        ))
    } else {
        None
    };
    let (engine, output) = run_latex_compile_process(
        request.compiler.as_deref(),
        &input_path,
        source_dir,
        output_dir,
        timeout_ms,
        workspace,
        request.continue_on_error,
        should_cancel,
        on_progress,
    )?;
    if expected_pdf.is_file() && expected_pdf != output_path {
        std::fs::copy(&expected_pdf, &output_path).map_err(|error| error.to_string())?;
    }

    let stdout = cache_note.map_or_else(
        || runtime::decode_process_text(&output.stdout),
        |note| format!("{note}\n{}", runtime::decode_process_text(&output.stdout)),
    );
    let mut stderr = runtime::decode_process_text(&output.stderr);
    let mut return_code_interpretation = None;
    if output.timed_out {
        stderr = append_process_status_message(
            stderr,
            &format!("LaTeXCompile exceeded timeout of {timeout_ms} ms"),
        );
        return_code_interpretation = Some("timeout".to_string());
    } else if output.interrupted {
        stderr = append_process_status_message(stderr, "LaTeXCompile interrupted by user");
        return_code_interpretation = Some("interrupted".to_string());
    } else if let Some(code) = output.status.code().filter(|code| *code != 0) {
        return_code_interpretation = Some(format!("exit_code:{code}"));
    }

    let mut success = output.status.success() && output_path.is_file();
    if output.status.success() && !output_path.is_file() {
        success = false;
        stderr = append_process_status_message(stderr, "LaTeXCompile produced no output PDF");
        return_code_interpretation = Some("missing_output".to_string());
    }
    let inputs_changed = latex_input_snapshot_changed(&input_snapshot);
    if inputs_changed {
        success = false;
        stderr = append_process_status_message(
            stderr,
            "LaTeX project inputs changed during compilation; the generated PDF was not accepted. Recompile the stable project state.",
        );
        return_code_interpretation = Some("inputs_changed".to_string());
    }
    let pdf_state = if inputs_changed {
        if output_path.is_file() {
            LatexPdfState::Stale
        } else {
            LatexPdfState::Missing
        }
    } else {
        latex_pdf_state(
            success,
            request.continue_on_error,
            output.interrupted,
            output.timed_out,
            expected_pdf_before.as_ref(),
            latex_output_fingerprint(&expected_pdf).as_ref(),
            output_path.is_file(),
        )
    };
    let diagnostics = extract_latex_diagnostics(
        &stdout,
        &stderr,
        success,
        return_code_interpretation.as_deref(),
    );
    let repair_guidance = (!success).then(|| {
        if diagnostics.is_empty() {
            "Inspect the TeX toolchain diagnostic, make no speculative source rewrite, and rerun LaTeXCompile once the concrete failure is understood.".to_string()
        } else {
            "Fix only diagnostics[0] with the smallest source change, preserve the current diff, then rerun LaTeXCompile. Do not invoke a TeX compiler from REPL.".to_string()
        }
    });

    Ok(LatexCompileOutput {
        success,
        input_path: input_path.display().to_string(),
        output_path: output_path.display().to_string(),
        engine,
        stdout,
        stderr,
        exit_code: output.status.code(),
        interrupted: output.interrupted,
        timed_out: output.timed_out,
        duration_ms: started.elapsed().as_millis(),
        return_code_interpretation,
        diagnostics,
        repair_guidance,
        pdf_state,
        root_source_hash: compile_input_hash,
        pdf_hash: latex_file_hash(&output_path),
        compiled_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LatexOutputFingerprint {
    length: u64,
    modified: Option<SystemTime>,
}

fn latex_output_fingerprint(path: &Path) -> Option<LatexOutputFingerprint> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(LatexOutputFingerprint {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn latex_pdf_state(
    success: bool,
    continue_on_error: bool,
    interrupted: bool,
    timed_out: bool,
    before: Option<&LatexOutputFingerprint>,
    after: Option<&LatexOutputFingerprint>,
    output_exists: bool,
) -> LatexPdfState {
    if success {
        LatexPdfState::Fresh
    } else if continue_on_error && !interrupted && !timed_out && before != after && output_exists {
        LatexPdfState::Partial
    } else if output_exists {
        LatexPdfState::Stale
    } else {
        LatexPdfState::Missing
    }
}

fn latex_file_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Some(format!("{:x}", hasher.finalize()))
}

fn latex_source_without_comment(line: &str) -> &str {
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if character == '%' && !escaped {
            return &line[..index];
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    line
}

fn latex_source_command_arguments(line: &str, command: &str) -> Vec<String> {
    let needle = format!("\\{command}");
    let mut rest = line;
    let mut arguments = Vec::new();
    while let Some(index) = rest.find(&needle) {
        rest = &rest[index + needle.len()..];
        let mut trimmed = rest.trim_start();
        while let Some(optional) = trimmed.strip_prefix('[') {
            let Some(end) = optional.find(']') else {
                break;
            };
            trimmed = optional[end + 1..].trim_start();
        }
        let Some(argument) = trimmed.strip_prefix('{') else {
            continue;
        };
        let Some(end) = argument.find('}') else {
            continue;
        };
        arguments.push(argument[..end].trim().to_string());
        rest = &argument[end + 1..];
    }
    arguments
}

fn latex_source_command_pairs(line: &str, command: &str) -> Vec<(String, String)> {
    let needle = format!("\\{command}");
    let mut rest = line;
    let mut pairs = Vec::new();
    while let Some(index) = rest.find(&needle) {
        rest = &rest[index + needle.len()..];
        let mut trimmed = rest.trim_start();
        while let Some(optional) = trimmed.strip_prefix('[') {
            let Some(end) = optional.find(']') else {
                break;
            };
            trimmed = optional[end + 1..].trim_start();
        }
        let Some(first) = trimmed.strip_prefix('{') else {
            continue;
        };
        let Some(first_end) = first.find('}') else {
            continue;
        };
        let after_first = first[first_end + 1..].trim_start();
        let Some(second) = after_first.strip_prefix('{') else {
            rest = after_first;
            continue;
        };
        let Some(second_end) = second.find('}') else {
            rest = second;
            continue;
        };
        pairs.push((
            first[..first_end].trim().to_string(),
            second[..second_end].trim().to_string(),
        ));
        rest = &second[second_end + 1..];
    }
    pairs
}

fn latex_dependency_variants(base: &Path, value: &str, extensions: &[&str]) -> Vec<PathBuf> {
    let value = value
        .trim()
        .trim_matches(['\'', '"'])
        .trim_start_matches("file:");
    if value.is_empty() || value.contains('\\') || value.contains('#') {
        return Vec::new();
    }
    let value = value.replace('\\', "/");
    let path = base.join(value);
    if path.extension().is_some() || extensions.is_empty() {
        return vec![path];
    }
    extensions
        .iter()
        .map(|extension| path.with_extension(extension))
        .collect()
}

fn latex_discover_dependencies(source_path: &Path, compile_root_dir: &Path) -> Vec<PathBuf> {
    let Ok(source) = std::fs::read(source_path) else {
        return Vec::new();
    };
    let source = String::from_utf8_lossy(&source);
    let source_dir = source_path.parent().unwrap_or(compile_root_dir);
    let bases = if source_dir == compile_root_dir {
        vec![compile_root_dir]
    } else {
        vec![compile_root_dir, source_dir]
    };
    let mut dependencies = Vec::new();
    for line in source.lines().map(latex_source_without_comment) {
        for command in ["input", "include", "subfile"] {
            for argument in latex_source_command_arguments(line, command) {
                for base in &bases {
                    dependencies.extend(latex_dependency_variants(base, &argument, &["tex"]));
                }
            }
        }
        for command in ["import", "subimport"] {
            for (directory, file) in latex_source_command_pairs(line, command) {
                let joined = Path::new(&directory).join(file);
                let joined = joined.to_string_lossy();
                for base in [source_dir, compile_root_dir] {
                    dependencies.extend(latex_dependency_variants(base, &joined, &["tex"]));
                }
            }
        }
        for argument in latex_source_command_arguments(line, "includegraphics") {
            for base in &bases {
                dependencies.extend(latex_dependency_variants(
                    base,
                    &argument,
                    &["pdf", "png", "jpg", "jpeg", "eps", "svg"],
                ));
            }
        }
        for command in ["bibliography", "addbibresource"] {
            for argument in latex_source_command_arguments(line, command) {
                for item in argument.split(',') {
                    for base in &bases {
                        dependencies.extend(latex_dependency_variants(base, item, &["bib"]));
                    }
                }
            }
        }
        for argument in latex_source_command_arguments(line, "bibliographystyle") {
            for base in &bases {
                dependencies.extend(latex_dependency_variants(base, &argument, &["bst"]));
            }
        }
        for argument in latex_source_command_arguments(line, "documentclass") {
            for base in &bases {
                dependencies.extend(latex_dependency_variants(base, &argument, &["cls"]));
            }
        }
        for argument in latex_source_command_arguments(line, "usepackage") {
            for package in argument.split(',') {
                for base in &bases {
                    dependencies.extend(latex_dependency_variants(base, package, &["sty"]));
                }
            }
        }
    }
    dependencies
}

fn latex_input_snapshot(input_path: &Path, workspace: &Path) -> BTreeMap<PathBuf, String> {
    let Some(root_dir) = input_path.parent() else {
        return BTreeMap::new();
    };
    let mut pending = vec![input_path.to_path_buf()];
    let mut snapshot = BTreeMap::new();
    while let Some(path) = pending.pop() {
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if !path.starts_with(workspace) || snapshot.contains_key(&path) {
            continue;
        }
        let Some(hash) = latex_file_hash(&path) else {
            continue;
        };
        snapshot.insert(path.clone(), hash);
        let parse_dependencies = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "tex" | "sty" | "cls" | "bbx" | "cbx"
                )
            });
        if parse_dependencies {
            pending.extend(
                latex_discover_dependencies(&path, root_dir)
                    .into_iter()
                    .filter(|dependency| dependency.is_file()),
            );
        }
    }
    snapshot
}

fn latex_input_manifest_hash(snapshot: &BTreeMap<PathBuf, String>, workspace: &Path) -> String {
    let mut hasher = Sha256::new();
    for (path, hash) in snapshot {
        let relative = path.strip_prefix(workspace).unwrap_or(path);
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        hasher.update(hash.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn latex_input_snapshot_changed(snapshot: &BTreeMap<PathBuf, String>) -> bool {
    snapshot
        .iter()
        .any(|(path, expected_hash)| latex_file_hash(path).as_ref() != Some(expected_hash))
}

#[allow(clippy::too_many_arguments)]
fn run_latex_compile_process(
    compiler: Option<&str>,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    workspace: &Path,
    continue_on_error: bool,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> Result<(String, runtime::ManagedCommandOutput), String> {
    let preferred_engine = preferred_latex_engine(input_path);
    if let Some(compiler) = compiler.map(str::trim).filter(|value| !value.is_empty()) {
        if !matches!(compiler, "latexmk" | "xelatex" | "pdflatex" | "lualatex") {
            return Err(format!(
                "unsupported LaTeX compiler `{compiler}`; expected latexmk, xelatex, pdflatex, or lualatex"
            ));
        }
        if compiler == "latexmk" {
            let (engine, output) = run_latexmk_with_retries(
                preferred_engine,
                input_path,
                source_dir,
                output_dir,
                timeout_ms,
                workspace,
                continue_on_error,
                should_cancel,
                on_progress,
            )
            .map_err(|error| format!("LaTeX command `latexmk` failed to start: {error}"))?;
            return Ok((engine, output));
        }
        let output = run_latex_engine(
            compiler,
            input_path,
            source_dir,
            output_dir,
            timeout_ms,
            workspace,
            continue_on_error,
            should_cancel,
            on_progress,
        )
        .map_err(|error| format!("LaTeX command `{compiler}` failed to start: {error}"))?;
        return Ok((compiler.to_string(), output));
    }

    match run_latexmk_with_retries(
        preferred_engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
        workspace,
        continue_on_error,
        should_cancel,
        on_progress,
    ) {
        Ok((engine, output)) => return Ok((engine, output)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("LaTeX command `latexmk` failed to start: {error}")),
    }

    let mut not_found = vec!["latexmk".to_string()];
    for compiler in preferred_engine.fallback_engines() {
        match run_latex_engine(
            compiler,
            input_path,
            source_dir,
            output_dir,
            timeout_ms,
            workspace,
            continue_on_error,
            should_cancel,
            on_progress,
        ) {
            Ok(output) => return Ok(((*compiler).to_string(), output)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                not_found.push((*compiler).to_string());
            }
            Err(error) => {
                return Err(format!(
                    "LaTeX command `{compiler}` failed to start: {error}"
                ));
            }
        }
    }

    Err(format!(
        "LaTeX command not found. Tried: {}. Install TeX Live and ensure latexmk/xelatex/pdflatex/lualatex are on PATH.",
        not_found.join(", ")
    ))
}

#[allow(clippy::too_many_arguments)]
fn run_latexmk_with_retries(
    preferred_engine: LatexEnginePreference,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    workspace: &Path,
    continue_on_error: bool,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<(String, runtime::ManagedCommandOutput)> {
    let mut engine = preferred_engine;
    let mut output = run_latexmk(
        engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
        workspace,
        continue_on_error,
        should_cancel,
        on_progress,
    )?;
    if engine == LatexEnginePreference::PdfLatex && latex_output_needs_unicode_engine(&output) {
        engine = LatexEnginePreference::XeLatex;
        output = run_latexmk(
            engine,
            input_path,
            source_dir,
            output_dir,
            timeout_ms,
            workspace,
            continue_on_error,
            should_cancel,
            on_progress,
        )?;
    }
    if latexmk_output_reports_stale_failure(&output) {
        let removed = remove_known_latex_cache_files(input_path, output_dir)
            .map_err(std::io::Error::other)?;
        let mut retry = run_latexmk(
            engine,
            input_path,
            source_dir,
            output_dir,
            timeout_ms,
            workspace,
            continue_on_error,
            should_cancel,
            on_progress,
        )?;
        let note =
            format!("LaTeXCompile removed {removed} stale auxiliary file(s) and retried latexmk.");
        retry.stdout = join_process_bytes(note.into_bytes(), retry.stdout);
        output = retry;
    }
    Ok((engine.latexmk_label().to_string(), output))
}

#[allow(clippy::too_many_arguments)]
fn run_latexmk(
    engine: LatexEnginePreference,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    workspace: &Path,
    continue_on_error: bool,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::ManagedCommandOutput> {
    let mut process = runtime::hidden_command("latexmk");
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    process
        .arg(engine.latexmk_arg())
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-synctex=1")
        .arg(format!("-outdir={}", output_dir.display()));
    if !continue_on_error {
        process.arg("-halt-on-error");
    }
    process
        .arg(tex_input_name(input_path))
        .current_dir(source_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    run_latex_process(
        &mut process,
        "latexmk",
        input_path,
        workspace,
        timeout_ms,
        should_cancel,
        on_progress,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_latex_engine(
    engine: &str,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    workspace: &Path,
    continue_on_error: bool,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::ManagedCommandOutput> {
    let first = run_single_latex_engine(
        engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
        workspace,
        continue_on_error,
        should_cancel,
        on_progress,
    )?;
    if first.interrupted || first.timed_out || !first.status.success() {
        return Ok(first);
    }
    let second = run_single_latex_engine(
        engine,
        input_path,
        source_dir,
        output_dir,
        timeout_ms,
        workspace,
        continue_on_error,
        should_cancel,
        on_progress,
    )?;
    Ok(runtime::ManagedCommandOutput {
        stdout: join_process_bytes(first.stdout, second.stdout),
        stderr: join_process_bytes(first.stderr, second.stderr),
        status: second.status,
        interrupted: second.interrupted,
        timed_out: second.timed_out,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_single_latex_engine(
    engine: &str,
    input_path: &Path,
    source_dir: &Path,
    output_dir: &Path,
    timeout_ms: u64,
    workspace: &Path,
    continue_on_error: bool,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::ManagedCommandOutput> {
    let mut process = runtime::hidden_command(engine);
    let source_dir = tex_tool_path(source_dir);
    let output_dir = tex_tool_path(output_dir);
    process
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-synctex=1")
        .arg(format!("-output-directory={}", output_dir.display()));
    if !continue_on_error {
        process.arg("-halt-on-error");
    }
    process
        .arg(tex_input_name(input_path))
        .current_dir(source_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    run_latex_process(
        &mut process,
        engine,
        input_path,
        workspace,
        timeout_ms,
        should_cancel,
        on_progress,
    )
}

fn run_latex_process(
    process: &mut std::process::Command,
    compiler: &str,
    input_path: &Path,
    workspace: &Path,
    timeout_ms: u64,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::ManagedCommandOutput> {
    runtime::run_managed_command_with_cancel_and_progress(
        process,
        format!(
            "LaTeX compile ({compiler}): {}",
            truncate_process_label(&workspace_relative_display(input_path, workspace))
        ),
        Some(Duration::from_millis(timeout_ms)),
        true,
        should_cancel,
        |progress| on_progress(managed_progress_to_tool_progress(progress)),
    )
}

fn join_process_bytes(mut first: Vec<u8>, second: Vec<u8>) -> Vec<u8> {
    if first.is_empty() {
        return second;
    }
    if !second.is_empty() {
        if !first.ends_with(b"\n") {
            first.push(b'\n');
        }
        first.extend(second);
    }
    first
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LatexEnginePreference {
    PdfLatex,
    XeLatex,
    LuaLatex,
}

impl LatexEnginePreference {
    fn latexmk_arg(self) -> &'static str {
        match self {
            Self::PdfLatex => "-pdf",
            Self::XeLatex => "-xelatex",
            Self::LuaLatex => "-lualatex",
        }
    }

    fn latexmk_label(self) -> &'static str {
        match self {
            Self::PdfLatex => "latexmk -pdf",
            Self::XeLatex => "latexmk -xelatex",
            Self::LuaLatex => "latexmk -lualatex",
        }
    }

    fn fallback_engines(self) -> &'static [&'static str] {
        match self {
            Self::PdfLatex => &["pdflatex", "xelatex", "lualatex"],
            Self::XeLatex => &["xelatex", "lualatex", "pdflatex"],
            Self::LuaLatex => &["lualatex", "xelatex", "pdflatex"],
        }
    }
}

fn preferred_latex_engine(input_path: &Path) -> LatexEnginePreference {
    let Ok(source) = std::fs::read_to_string(input_path) else {
        return LatexEnginePreference::PdfLatex;
    };
    if let Some(engine) = latex_magic_comment_engine(&source) {
        return engine;
    }
    if latex_source_uses_luatex(&source) {
        return LatexEnginePreference::LuaLatex;
    }
    if latex_source_uses_unicode_engine(&source) {
        return LatexEnginePreference::XeLatex;
    }
    LatexEnginePreference::PdfLatex
}

fn latex_magic_comment_engine(source: &str) -> Option<LatexEnginePreference> {
    source.lines().take(40).find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if !(lower.contains("tex") && lower.contains("program")) {
            return None;
        }
        if lower.contains("lualatex") || lower.contains("luatex") {
            Some(LatexEnginePreference::LuaLatex)
        } else if lower.contains("xelatex") || lower.contains("xetex") {
            Some(LatexEnginePreference::XeLatex)
        } else if lower.contains("pdflatex") || lower.contains("pdftex") {
            Some(LatexEnginePreference::PdfLatex)
        } else {
            None
        }
    })
}

fn latex_source_uses_luatex(source: &str) -> bool {
    latex_source_uses_any_package(source, &["luacode", "luatexja", "luaotfload"])
        || latex_source_contains_any_command(source, &["directlua"])
}

fn latex_source_uses_unicode_engine(source: &str) -> bool {
    latex_source_uses_any_package(
        source,
        &[
            "fontspec",
            "xeCJK",
            "ctex",
            "unicode-math",
            "polyglossia",
            "mathspec",
            "xltxtra",
            "xunicode",
        ],
    ) || latex_source_uses_any_documentclass(
        source,
        &["ctexart", "ctexbook", "ctexrep", "ctexbeamer"],
    ) || latex_source_contains_any_command(
        source,
        &[
            "setmainfont",
            "setsansfont",
            "setmonofont",
            "setCJKmainfont",
            "setCJKsansfont",
            "setCJKmonofont",
            "CJKfontspec",
        ],
    )
}

fn latex_source_uses_any_package(source: &str, packages: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        ["usepackage", "RequirePackage"].iter().any(|command| {
            latex_command_arguments(line, command)
                .into_iter()
                .any(|argument| {
                    argument.split(',').any(|package| {
                        packages
                            .iter()
                            .any(|name| package.trim().eq_ignore_ascii_case(name))
                    })
                })
        })
    })
}

fn latex_source_uses_any_documentclass(source: &str, classes: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        latex_command_arguments(line, "documentclass")
            .into_iter()
            .any(|argument| {
                classes
                    .iter()
                    .any(|name| argument.trim().eq_ignore_ascii_case(name))
            })
    })
}

fn latex_source_contains_any_command(source: &str, commands: &[&str]) -> bool {
    source.lines().map(latex_line_without_comment).any(|line| {
        let lower = line.to_ascii_lowercase();
        commands
            .iter()
            .any(|command| lower.contains(&format!("\\{}", command.to_ascii_lowercase())))
    })
}

fn latex_line_without_comment(line: &str) -> &str {
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if character == '%' && !escaped {
            return &line[..index];
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    line
}

fn latex_command_arguments<'a>(line: &'a str, command: &str) -> Vec<&'a str> {
    let needle = format!("\\{command}");
    line.match_indices(&needle)
        .filter_map(|(offset, _)| {
            let tail = &line[offset + needle.len()..];
            let start = tail.find('{')?;
            let content = &tail[start + 1..];
            let end = content.find('}')?;
            Some(&content[..end])
        })
        .collect()
}

fn latex_path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn latex_output_needs_unicode_engine(output: &runtime::ManagedCommandOutput) -> bool {
    let combined = format!(
        "{}\n{}",
        runtime::decode_process_text(&output.stdout),
        runtime::decode_process_text(&output.stderr)
    )
    .to_ascii_lowercase();
    combined.contains("fontspec") && combined.contains("requires either xetex or luatex")
}

fn latexmk_output_reports_stale_failure(output: &runtime::ManagedCommandOutput) -> bool {
    let combined = format!(
        "{}\n{}",
        runtime::decode_process_text(&output.stdout),
        runtime::decode_process_text(&output.stderr)
    )
    .to_ascii_lowercase();
    combined.contains("gave an error in previous invocation of latexmk")
}

fn known_latex_cache_paths(input_path: &Path, output_dir: &Path) -> Vec<PathBuf> {
    let stem = input_path
        .file_stem()
        .unwrap_or_else(|| input_path.as_os_str())
        .to_string_lossy();
    [
        "aux",
        "bbl",
        "bcf",
        "blg",
        "fdb_latexmk",
        "fls",
        "lof",
        "log",
        "lot",
        "nav",
        "out",
        "run.xml",
        "snm",
        "synctex.gz",
        "toc",
        "vrb",
        "xdv",
    ]
    .into_iter()
    .map(|suffix| output_dir.join(format!("{stem}.{suffix}")))
    .collect()
}

fn remove_known_latex_cache_files(input_path: &Path, output_dir: &Path) -> Result<usize, String> {
    let mut removed = 0;
    for path in known_latex_cache_paths(input_path, output_dir) {
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|error| {
                format!("failed to remove LaTeX cache {}: {error}", path.display())
            })?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn tex_input_name(input_path: &Path) -> &std::ffi::OsStr {
    input_path
        .file_name()
        .unwrap_or_else(|| input_path.as_os_str())
}

#[cfg(target_os = "windows")]
fn tex_tool_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if value.starts_with(r"\\?\Volume{") {
        return path.to_path_buf();
    }
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn tex_tool_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn extract_latex_diagnostics(
    stdout: &str,
    stderr: &str,
    success: bool,
    return_code_interpretation: Option<&str>,
) -> Vec<LatexDiagnostic> {
    let combined = format!("{stdout}\n{stderr}");
    let lines = combined.lines().collect::<Vec<_>>();
    let mut diagnostics = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if let Some((file_path, source_line, message)) = parse_latex_file_line_diagnostic(line) {
            push_latex_diagnostic(
                &mut diagnostics,
                LatexDiagnostic {
                    severity: "error".to_string(),
                    code: "file_line_error".to_string(),
                    message,
                    file_path: Some(file_path),
                    line: Some(source_line),
                },
            );
            continue;
        }
        let Some(message) = line
            .strip_prefix('!')
            .map(str::trim)
            .filter(|message| !message.is_empty())
        else {
            continue;
        };
        let source_line = lines[index + 1..]
            .iter()
            .take(4)
            .find_map(|next| parse_latex_log_line_number(next.trim()));
        push_latex_diagnostic(
            &mut diagnostics,
            LatexDiagnostic {
                severity: "error".to_string(),
                code: latex_diagnostic_code(message).to_string(),
                message: message.to_string(),
                file_path: None,
                line: source_line,
            },
        );
    }
    for line in &lines {
        let line = line.trim();
        let Some(message) = latex_warning_message(line) else {
            continue;
        };
        push_latex_diagnostic(
            &mut diagnostics,
            LatexDiagnostic {
                severity: "warning".to_string(),
                code: "latex_warning".to_string(),
                message,
                file_path: None,
                line: latex_warning_input_line(line),
            },
        );
    }
    if diagnostics.is_empty() && !success {
        let message = return_code_interpretation
            .map(|status| {
                format!(
                    "LaTeX compilation failed ({status}) without a parseable source diagnostic."
                )
            })
            .unwrap_or_else(|| {
                "LaTeX compilation failed without a parseable source diagnostic.".to_string()
            });
        diagnostics.push(LatexDiagnostic {
            severity: "error".to_string(),
            code: "compile_failed".to_string(),
            message,
            file_path: None,
            line: None,
        });
    }
    diagnostics
}

fn latex_warning_message(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let warning_index = lower.find("warning:")?;
    let message = line[warning_index + "warning:".len()..].trim();
    (!message.is_empty()).then(|| message.to_string())
}

fn latex_warning_input_line(line: &str) -> Option<u32> {
    let lower = line.to_ascii_lowercase();
    let marker = "on input line ";
    let start = lower.find(marker)? + marker.len();
    lower[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn parse_latex_file_line_diagnostic(line: &str) -> Option<(String, u32, String)> {
    for (index, character) in line.char_indices() {
        if character != ':' {
            continue;
        }
        let rest = &line[index + 1..];
        let digits = rest
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>();
        if digits.is_empty() || !rest[digits.len()..].starts_with(':') {
            continue;
        }
        let file_path = line[..index].trim();
        if !file_path.to_ascii_lowercase().contains(".tex") {
            continue;
        }
        let message = rest[digits.len() + 1..].trim();
        if message.is_empty() {
            continue;
        }
        return Some((
            file_path.to_string(),
            digits.parse().ok()?,
            message.to_string(),
        ));
    }
    None
}

fn parse_latex_log_line_number(line: &str) -> Option<u32> {
    let number = line
        .strip_prefix("l.")?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    number.parse().ok()
}

fn latex_diagnostic_code(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("extra alignment") || lower.contains("misplaced alignment") {
        "table_alignment"
    } else if lower.contains("missing $") || lower.contains("math mode") {
        "math_mode"
    } else if lower.contains("undefined control sequence") {
        "undefined_control_sequence"
    } else if lower.contains("file `") && lower.contains("not found") {
        "missing_file"
    } else if lower.contains("emergency stop") {
        "emergency_stop"
    } else {
        "latex_error"
    }
}

fn push_latex_diagnostic(diagnostics: &mut Vec<LatexDiagnostic>, diagnostic: LatexDiagnostic) {
    if diagnostics.len() < 8 && !diagnostics.contains(&diagnostic) {
        diagnostics.push(diagnostic);
    }
}

fn canonical_workspace_root() -> Result<PathBuf, String> {
    let root = std::env::var("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    std::fs::canonicalize(&root).map_err(|error| error.to_string())
}

fn resolve_existing_workspace_path(path: &str, workspace: &Path) -> Result<PathBuf, String> {
    let candidate = lexically_normalize_path(&workspace_path_candidate(path, workspace)?);
    let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "could not resolve workspace path `{}`: {error}",
            candidate.display()
        )
    })?;
    ensure_workspace_child(&canonical, workspace)?;
    if !canonical.is_file() {
        return Err(format!("{} is not a file", canonical.display()));
    }
    Ok(canonical)
}

fn resolve_output_workspace_path(path: &str, workspace: &Path) -> Result<PathBuf, String> {
    let candidate = lexically_normalize_path(&workspace_path_candidate(path, workspace)?);
    let parent = candidate
        .parent()
        .ok_or_else(|| "outputPath must include a file name".to_string())?;
    let parent = canonicalize_path_allow_missing(parent)?;
    ensure_workspace_child(&parent, workspace)?;
    std::fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "outputPath must include a file name".to_string())?;
    Ok(parent.join(file_name))
}

fn workspace_path_candidate(path: &str, workspace: &Path) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    let input = Path::new(path);
    if input.is_absolute() {
        return Ok(input.to_path_buf());
    }

    let mut normalized = PathBuf::new();
    for component in input.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => normalized.push(part),
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("path `{path}` escapes the current workspace"));
                }
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(format!("path `{path}` is not a workspace-relative path"));
            }
        }
    }
    Ok(workspace.join(normalized))
}

fn canonicalize_path_allow_missing(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path).map_err(|error| error.to_string());
    }

    let mut missing = Vec::new();
    let mut ancestor = path;
    while !ancestor.exists() {
        let file_name = ancestor.file_name().ok_or_else(|| {
            format!(
                "could not resolve missing path ancestor for `{}`",
                path.display()
            )
        })?;
        missing.push(file_name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            format!(
                "could not resolve missing path ancestor for `{}`",
                path.display()
            )
        })?;
    }

    let mut canonical = std::fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(lexically_normalize_path(&canonical))
}

fn lexically_normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

fn ensure_workspace_child(path: &Path, workspace: &Path) -> Result<(), String> {
    if path.starts_with(workspace) {
        Ok(())
    } else {
        Err(format!(
            "path `{}` is outside the current workspace `{}`",
            path.display(),
            workspace.display()
        ))
    }
}

fn workspace_relative_display(path: &Path, workspace: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .display()
        .to_string()
        .replace('\\', "/")
}

fn detect_powershell_shell() -> std::io::Result<&'static str> {
    if runtime::command_exists("pwsh") {
        Ok("pwsh")
    } else if runtime::command_exists("powershell") {
        Ok("powershell")
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "PowerShell executable not found (expected `pwsh` or `powershell` in PATH)",
        ))
    }
}

#[allow(clippy::too_many_lines)]
fn execute_shell_command(
    shell: &str,
    command: &str,
    timeout: Option<u64>,
    run_in_background: Option<bool>,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(ToolProgress),
) -> std::io::Result<runtime::BashCommandOutput> {
    let command_arg = powershell_command_arg(command);
    if run_in_background.unwrap_or(false) {
        let mut process = runtime::hidden_command(shell);
        process
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(&command_arg)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let pid = runtime::spawn_managed_background(
            &mut process,
            format!("PowerShell background: {}", truncate_process_label(command)),
        )?;
        return Ok(runtime::BashCommandOutput {
            stdout: String::new(),
            stderr: String::new(),
            raw_output_path: None,
            interrupted: false,
            is_image: None,
            background_task_id: Some(pid.to_string()),
            backgrounded_by_user: Some(true),
            assistant_auto_backgrounded: Some(false),
            dangerously_disable_sandbox: None,
            return_code_interpretation: None,
            no_output_expected: Some(true),
            structured_content: None,
            persisted_output_path: None,
            persisted_output_size: None,
            sandbox_status: None,
        });
    }

    let mut process = runtime::hidden_command(shell);
    process
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(&command_arg);
    process
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let timeout_ms = runtime::resolve_foreground_shell_timeout_ms(timeout);
    let output = runtime::run_managed_command_with_cancel_and_progress(
        &mut process,
        format!("PowerShell: {}", truncate_process_label(command)),
        Some(Duration::from_millis(timeout_ms)),
        true,
        should_cancel,
        |progress| on_progress(managed_progress_to_tool_progress(progress)),
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.timed_out {
        return Ok(runtime::BashCommandOutput {
            stdout,
            stderr: append_process_status_message(
                stderr,
                &format!("Command exceeded timeout of {timeout_ms} ms"),
            ),
            raw_output_path: None,
            interrupted: true,
            is_image: None,
            background_task_id: None,
            backgrounded_by_user: None,
            assistant_auto_backgrounded: None,
            dangerously_disable_sandbox: None,
            return_code_interpretation: Some(String::from("timeout")),
            no_output_expected: Some(false),
            structured_content: None,
            persisted_output_path: None,
            persisted_output_size: None,
            sandbox_status: None,
        });
    }
    if output.interrupted {
        return Ok(runtime::BashCommandOutput {
            stdout,
            stderr: append_process_status_message(stderr, "Command interrupted by user"),
            raw_output_path: None,
            interrupted: true,
            is_image: None,
            background_task_id: None,
            backgrounded_by_user: None,
            assistant_auto_backgrounded: None,
            dangerously_disable_sandbox: None,
            return_code_interpretation: Some(String::from("interrupted")),
            no_output_expected: Some(false),
            structured_content: None,
            persisted_output_path: None,
            persisted_output_size: None,
            sandbox_status: None,
        });
    }

    Ok(runtime::BashCommandOutput {
        stdout,
        stderr,
        raw_output_path: None,
        interrupted: false,
        is_image: None,
        background_task_id: None,
        backgrounded_by_user: None,
        assistant_auto_backgrounded: None,
        dangerously_disable_sandbox: None,
        return_code_interpretation: output
            .status
            .code()
            .filter(|code| *code != 0)
            .map(|code| format!("exit_code:{code}")),
        no_output_expected: Some(output.stdout.is_empty() && output.stderr.is_empty()),
        structured_content: None,
        persisted_output_path: None,
        persisted_output_size: None,
        sandbox_status: None,
    })
}

fn powershell_command_arg(command: &str) -> String {
    #[cfg(windows)]
    {
        format!(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             $OutputEncoding = [Console]::OutputEncoding; {command}"
        )
    }

    #[cfg(not(windows))]
    {
        command.to_string()
    }
}

fn append_process_status_message(stderr: String, message: &str) -> String {
    if stderr.trim().is_empty() {
        message.to_string()
    } else {
        format!("{}\n{message}", stderr.trim_end())
    }
}

fn truncate_process_label(value: &str) -> String {
    const MAX: usize = 120;
    if value.chars().count() <= MAX {
        value.to_string()
    } else {
        let head = value.chars().take(MAX).collect::<String>();
        format!("{head}...")
    }
}

fn resolve_cell_index(
    cells: &[serde_json::Value],
    cell_id: Option<&str>,
    edit_mode: NotebookEditMode,
) -> Result<usize, String> {
    if cells.is_empty()
        && matches!(
            edit_mode,
            NotebookEditMode::Replace | NotebookEditMode::Delete
        )
    {
        return Err(String::from("Notebook has no cells to edit"));
    }
    if let Some(cell_id) = cell_id {
        cells
            .iter()
            .position(|cell| cell.get("id").and_then(serde_json::Value::as_str) == Some(cell_id))
            .ok_or_else(|| format!("Cell id not found: {cell_id}"))
    } else {
        Ok(cells.len().saturating_sub(1))
    }
}

fn source_lines(source: &str) -> Vec<serde_json::Value> {
    if source.is_empty() {
        return vec![serde_json::Value::String(String::new())];
    }
    source
        .split_inclusive('\n')
        .map(|line| serde_json::Value::String(line.to_string()))
        .collect()
}

fn format_notebook_edit_mode(mode: NotebookEditMode) -> String {
    match mode {
        NotebookEditMode::Replace => String::from("replace"),
        NotebookEditMode::Insert => String::from("insert"),
        NotebookEditMode::Delete => String::from("delete"),
    }
}

fn make_cell_id(index: usize) -> String {
    format!("cell-{}", index + 1)
}

fn parse_skill_description(contents: &str) -> Option<String> {
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("description:") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

// ─── LlmReview Tool ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LlmReviewInput {
    prompt: String,
    model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmReviewRun {
    pub text: String,
    pub usages: Vec<TokenUsage>,
}

struct ReviewerCancelObserver {
    cancelled: Arc<AtomicBool>,
}

impl StreamObserver for ReviewerCancelObserver {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn reviewer_stream_observer(cancelled: Option<Arc<AtomicBool>>) -> Box<dyn StreamObserver> {
    cancelled.map_or_else(
        || Box::new(NoopStreamObserver) as Box<dyn StreamObserver>,
        |cancelled| Box::new(ReviewerCancelObserver { cancelled }) as Box<dyn StreamObserver>,
    )
}

/// Execute a Reviewer request that can be cancelled by the owning desktop
/// chat turn. Provider streaming loops poll the observer even when the
/// Reviewer emits no user-visible deltas.
pub fn execute_llm_review_observed_with_cancel(
    prompt: String,
    model: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> Result<LlmReviewRun, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("interrupted by user".to_string());
    }
    run_llm_review_observed(LlmReviewInput { prompt, model }, Some(cancelled))
}

/// Route a model name to its OpenAI-compatible reviewer endpoint and API key
/// env var. Returns (key_env, default_base_url, provider_tag).
/// The provider_tag lets us compare against `ARIS_REVIEWER_PROVIDER` to detect
/// mismatches (e.g. executor requested `gpt-5.5` but user configured `kimi`).
fn route_openai_compat_model(model: &str) -> (&'static str, String, &'static str) {
    if model.contains("gemini") {
        (
            "GEMINI_API_KEY",
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".to_string(),
            "gemini",
        )
    } else if model.contains("glm") || model.contains("GLM") {
        (
            "GLM_API_KEY",
            "https://open.bigmodel.cn/api/paas/v4/chat/completions".to_string(),
            "glm",
        )
    } else if model.starts_with("MiniMax") || model.starts_with("minimax") {
        ("MINIMAX_API_KEY", minimax_chat_completions_url(), "minimax")
    } else if model.contains("kimi") || model.contains("moonshot") {
        (
            "KIMI_API_KEY",
            "https://api.moonshot.cn/v1/chat/completions".to_string(),
            "kimi",
        )
    } else if model.contains("deepseek") {
        (
            "DEEPSEEK_API_KEY",
            "https://api.deepseek.com/v1/chat/completions".to_string(),
            "deepseek",
        )
    } else {
        // Default: OpenAI (also covers gpt, o3, o4)
        (
            "OPENAI_API_KEY",
            "https://api.openai.com/v1/chat/completions".to_string(),
            "openai",
        )
    }
}

fn minimax_chat_completions_url() -> String {
    let base = std::env::var("ARIS_MINIMAX_BASE_URL")
        .or_else(|_| std::env::var("MINIMAX_BASE_URL"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.minimaxi.com/v1".to_string());
    openai_chat_completions_url(&base)
}

fn openai_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

/// True iff the given env var is set to a non-empty value.
fn env_non_empty(name: &str) -> bool {
    std::env::var(name).ok().filter(|k| !k.is_empty()).is_some()
}

/// Decide which model LlmReview should use for an OpenAI-compatible call.
///
/// The executor tool-call may specify a `model` override. Earlier versions of
/// ARIS always honored that override, which caused two failure modes when the
/// executor guessed wrong:
///
/// 1. The override routed to an API key env var that wasn't set (e.g. executor
///    specified `model="gpt-4o"` but the user configured Kimi as reviewer and
///    only `KIMI_API_KEY` is present).
/// 2. The override routed to a different provider than the user configured,
///    and — if that provider's key happened to be set for an unrelated reason —
///    the request silently hit the wrong reviewer.
///
/// v0.4.4 falls back to `configured_model` whenever the override is unusable
/// (key missing) or routes to a different provider than `configured_model`.
/// Provider consistency is derived from `configured_model` itself — we do NOT
/// read `ARIS_REVIEWER_PROVIDER` because `/reviewer <model>` updates the model
/// env var but leaves the provider env var stale, which would block legitimate
/// overrides (e.g. `/reviewer gpt-5.5` after `/setup Gemini`).
fn resolve_reviewer_model<'a>(input_model: Option<&'a str>, configured_model: &'a str) -> &'a str {
    let Some(requested) = input_model.filter(|s| !s.is_empty()) else {
        return configured_model;
    };

    if requested == configured_model {
        return requested;
    }

    let (requested_key_env, _, requested_provider) = route_openai_compat_model(requested);
    let (_, _, configured_provider) = route_openai_compat_model(configured_model);

    // Both must match: key available AND provider consistent with configured.
    if !env_non_empty(requested_key_env) || requested_provider != configured_provider {
        return configured_model;
    }

    requested
}

fn resolve_anthropic_compat_reviewer_model<'a>(
    input_model: Option<&'a str>,
    configured_model: &'a str,
    reviewer_provider: Option<&str>,
) -> &'a str {
    let Some(requested) = input_model.filter(|s| !s.is_empty()) else {
        return configured_model;
    };
    if requested == configured_model {
        return requested;
    }

    if reviewer_provider == Some("deepseek") {
        let (_, _, requested_provider) = route_openai_compat_model(requested);
        if requested_provider != "deepseek" {
            return configured_model;
        }
    }

    requested
}

fn run_llm_review(input: LlmReviewInput) -> Result<String, String> {
    run_llm_review_observed(input, None).map(|run| run.text)
}

fn run_llm_review_observed(
    input: LlmReviewInput,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<LlmReviewRun, String> {
    let env_reviewer_model = std::env::var("ARIS_REVIEWER_MODEL")
        .ok()
        .filter(|s| !s.is_empty());

    // Check for user-configured reviewer provider and base URL
    let reviewer_provider = std::env::var("ARIS_REVIEWER_PROVIDER")
        .ok()
        .filter(|s| !s.is_empty());
    if matches!(
        reviewer_provider.as_deref(),
        Some("none" | "disabled" | "off")
    ) {
        return Err(
            "LlmReview: reviewer is disabled in SomniQ settings. Configure a reviewer before using LlmReview."
                .to_string(),
        );
    }

    let configured_model = env_reviewer_model.as_deref().unwrap_or("gpt-5.5");
    let custom_base_url = std::env::var("ARIS_REVIEWER_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty());

    // Custom OpenAI-compatible reviewer mode. Uses ARIS_REVIEWER_AUTH_TOKEN as
    // the API key and ARIS_REVIEWER_BASE_URL for the endpoint. Routes through
    // the same OpenAI-compat call path — no third routing path added.
    if reviewer_provider.as_deref() == Some("custom") {
        let key = std::env::var("ARIS_REVIEWER_AUTH_TOKEN")
            .ok()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                "LlmReview: ARIS_REVIEWER_AUTH_TOKEN not set (needed for custom reviewer)"
                    .to_string()
            })?;
        // For Custom reviewer, refuse to fall back to gpt-5.5 — that would
        // silently send the user's request to the wrong model on their custom
        // proxy. Require explicit model from input or ARIS_REVIEWER_MODEL.
        let model = input
            .model
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(env_reviewer_model.as_deref())
            .ok_or_else(|| {
                "LlmReview: custom reviewer has no model configured. \
                 Set ARIS_REVIEWER_MODEL or run /setup → reviewer → Custom and \
                 provide a model name."
                    .to_string()
            })?;
        let base = custom_base_url.ok_or_else(|| {
            "LlmReview: ARIS_REVIEWER_BASE_URL not set (needed for custom reviewer)".to_string()
        })?;
        return call_openai_compat_reviewer(&key, &base, model, &input.prompt, cancelled);
    }

    // Anthropic-compatible reviewer mode (e.g., Claude via proxy, DeepSeek).
    // This path uses ARIS_REVIEWER_AUTH_TOKEN (Bearer) and ignores the openai-compat
    // key routing. We still honor an explicit input.model override here because
    // the target endpoint decides which Anthropic-format model name it accepts.
    if reviewer_provider.as_deref() == Some("anthropic-compat")
        || reviewer_provider.as_deref() == Some("deepseek")
    {
        let key = std::env::var("ARIS_REVIEWER_AUTH_TOKEN")
            .or_else(|_| std::env::var("ANTHROPIC_AUTH_TOKEN"))
            .ok()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                "LlmReview: ARIS_REVIEWER_AUTH_TOKEN not set (needed for anthropic-compat reviewer)"
                    .to_string()
            })?;
        let model = input.model.as_deref().filter(|s| !s.is_empty());
        let model = resolve_anthropic_compat_reviewer_model(
            model,
            configured_model,
            reviewer_provider.as_deref(),
        );
        let default_base = if reviewer_provider.as_deref() == Some("deepseek") {
            "https://api.deepseek.com/anthropic"
        } else {
            "https://api.anthropic.com"
        };
        let base = custom_base_url.unwrap_or_else(|| default_base.to_string());
        return call_anthropic_compat_reviewer(&key, &base, model, &input.prompt, cancelled);
    }

    // OpenAI-compat path: resolve model with fallback, then route to its endpoint.
    let _ = reviewer_provider; // kept for future use; resolution derives provider from model
    let model = resolve_reviewer_model(input.model.as_deref(), configured_model);
    let (key_env, default_base_url, _) = route_openai_compat_model(model);

    // Use custom base URL if provided, appending /chat/completions if needed
    let base_url = if let Some(ref custom) = custom_base_url {
        let trimmed = custom.trim_end_matches('/');
        if trimmed.ends_with("/chat/completions") {
            trimmed.to_string()
        } else if trimmed.ends_with("/v1") {
            format!("{trimmed}/chat/completions")
        } else {
            format!("{trimmed}/v1/chat/completions")
        }
    } else {
        default_base_url.to_string()
    };

    let key = std::env::var(key_env)
        .ok()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("LlmReview: {key_env} not set (needed for model '{model}')"))?;

    call_openai_compat_reviewer(&key, &base_url, model, &input.prompt, cancelled)
}

// Reviewer settings historically stored full endpoint URLs. The shared
// executor expects provider base URLs and appends the concrete route itself.
fn openai_executor_base_url(base_url_or_endpoint: &str) -> String {
    let trimmed = base_url_or_endpoint.trim().trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/chat/completions") {
        base.trim_end_matches('/').to_string()
    } else if trimmed.ends_with("/v1") || trimmed.ends_with("/openai") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

fn anthropic_executor_base_url(base_url_or_endpoint: &str) -> String {
    let trimmed = base_url_or_endpoint.trim().trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/v1/messages") {
        base.trim_end_matches('/').to_string()
    } else if let Some(base) = trimmed.strip_suffix("/v1") {
        base.trim_end_matches('/').to_string()
    } else {
        trimmed.to_string()
    }
}

fn run_reviewer_turn(
    client: aris_executor::ExecutorClient,
    prompt: &str,
) -> Result<LlmReviewRun, String> {
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        client,
        SubagentToolExecutor::new(BTreeSet::new()),
        PermissionPolicy::new(PermissionMode::ReadOnly),
        Vec::new(),
    );
    let summary = runtime
        .run_turn(prompt.to_string(), None)
        .map_err(|error| format!("LlmReview request failed: {error}"))?;
    let text = final_assistant_text(&summary).trim().to_string();
    if text.is_empty() {
        Err("LlmReview: empty reviewer response".to_string())
    } else {
        let usages = summary
            .assistant_messages
            .iter()
            .filter_map(|message| message.usage)
            .collect();
        Ok(LlmReviewRun { text, usages })
    }
}

fn call_anthropic_compat_reviewer(
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<LlmReviewRun, String> {
    let client = SharedAnthropicRuntimeClient::new(
        AuthSource::BearerToken(api_key.to_string()),
        anthropic_executor_base_url(base_url),
        false,
        model.to_string(),
        false,
        Vec::new(),
        8192,
        reviewer_stream_observer(cancelled),
    )
    .map(aris_executor::ExecutorClient::Anthropic)
    .map_err(|error| format!("LlmReview executor setup failed: {error}"))?;
    run_reviewer_turn(client, prompt)
}

fn call_openai_compat_reviewer(
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<LlmReviewRun, String> {
    let client = aris_executor::OpenAIRuntimeClient::new(
        aris_executor::OpenAIExecutorConfig {
            api_key: api_key.to_string(),
            base_url: openai_executor_base_url(base_url),
        },
        model.to_string(),
        false,
        Vec::new(),
        reviewer_stream_observer(cancelled),
    )
    .map(aris_executor::ExecutorClient::OpenAI)
    .map_err(|error| format!("LlmReview executor setup failed: {error}"))?;
    run_reviewer_turn(client, prompt)
}

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;
