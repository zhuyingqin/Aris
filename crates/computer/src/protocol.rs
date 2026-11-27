//! Wire protocol between the desktop app and the `somniq-computer` helper:
//! one JSON object per line on stdin, one per line on stdout, answered in
//! order. The desktop side speaks it with plain `serde_json::Value`s so it
//! does not have to link this crate (and its UI Automation bindings).
//!
//! ```text
//! → {"id":3,"op":"snapshot","hwnd":198812,"filter":"interactive","maxChars":12000}
//! ← {"id":3,"ok":true,"result":{"snapshotSeq":2,"text":"[e1] Window …", …}}
//! ← {"id":4,"ok":false,"error":{"code":"WINDOW_GONE","message":"…"}}
//! ```
//!
//! Every operation is read-only.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::image::Region;
use crate::snapshot::Filter;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Op {
    Ping,
    /// Every non-protected visible top-level window, titles included. Only
    /// the desktop's consent card shows these titles; the model never gets
    /// the list.
    ListWindows,
    Window {
        hwnd: isize,
    },
    Snapshot {
        hwnd: isize,
        #[serde(default)]
        filter: Option<Filter>,
        #[serde(default)]
        max_chars: Option<usize>,
        /// Render only the subtree under this element of the *previous*
        /// snapshot; refused as stale if that element changed.
        #[serde(default, rename = "ref")]
        reference: Option<usize>,
    },
    Find {
        hwnd: isize,
        query: String,
        #[serde(default)]
        limit: Option<usize>,
    },
    Screenshot {
        hwnd: isize,
        #[serde(default)]
        max_long_edge: Option<u32>,
        #[serde(default)]
        region: Option<Region>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    #[must_use]
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    #[must_use]
    pub fn error(id: u64, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

/// Parses one request line. A malformed line still yields its `id` when one
/// can be read, so the caller can answer the right request.
pub fn parse_request(line: &str) -> Result<Request, (u64, String)> {
    serde_json::from_str::<Request>(line).map_err(|error| {
        let id = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_u64))
            .unwrap_or(0);
        (id, error.to_string())
    })
}

#[cfg(test)]
#[path = "tests/protocol.rs"]
mod tests;
