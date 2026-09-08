//! Projection of the shared mutation ledger for Desktop review surfaces.
//! No second write journal: Chat and Typeset reference the same change ids and
//! materialize the existing blobs only when they need review content.

use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditedTurn {
    pub session_id: String,
    pub turn_id: String,
    pub change_ids: Vec<String>,
    /// Additional Chat turns folded into this pending review batch. The first
    /// turn remains the stable identity for backwards-compatible ChangeSets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_turn_ids: Vec<String>,
}

/// Connect exact snapshot endpoints within one turn and path. Ledger appends
/// can race after writes, so arrival order is not mutation order. Ambiguous
/// endpoints and intervening edits stay separate rather than guessing.
pub fn file_chains(records: &[runtime::FileChangeRecord]) -> Vec<Vec<runtime::FileChangeRecord>> {
    file_chains_grouped(records, false)
}

/// Connect a deliberately merged review without changing snapshot ownership.
/// Unknown endpoints, branches and disconnected writes retain separate chains.
pub fn file_chains_across_turns(records: &[runtime::FileChangeRecord]) -> Vec<Vec<runtime::FileChangeRecord>> {
    file_chains_grouped(records, true)
}

fn file_chains_grouped(records: &[runtime::FileChangeRecord], across_turns: bool) -> Vec<Vec<runtime::FileChangeRecord>> {
    let mut groups = BTreeMap::new();
    for record in records {
        groups
            .entry((
                &record.canonical_path,
                if across_turns { None } else { Some((&record.session_id, &record.turn_id)) },
            ))
            .or_insert_with(Vec::new)
            .push(record);
    }
    let mut chains = Vec::new();
    for group in groups.into_values() {
        let mut starts = BTreeMap::new();
        let mut ends = BTreeMap::new();
        for (index, record) in group.iter().enumerate() {
            // An existing file without a hash is unknown, not an empty file.
            if !record.before.exists || record.before.content_hash.is_some() {
                starts
                    .entry((record.before.exists, &record.before.content_hash))
                    .or_insert_with(Vec::new)
                    .push(index);
            }
            if !record.after.exists || record.after.content_hash.is_some() {
                ends.entry((record.after.exists, &record.after.content_hash))
                    .or_insert_with(Vec::new)
                    .push(index);
            }
        }
        let mut next = vec![None; group.len()];
        let mut previous = vec![None; group.len()];
        for (endpoint, from) in ends {
            if let Some(to) = starts.get(&endpoint) {
                if from.len() == 1 && to.len() == 1 && from[0] != to[0] {
                    next[from[0]] = Some(to[0]);
                    previous[to[0]] = Some(from[0]);
                }
            }
        }
        let mut visited = vec![false; group.len()];
        // Start with open chains, then complete cycles (whose net diff is zero).
        let order = (0..group.len())
            .filter(|&index| previous[index].is_none())
            .chain((0..group.len()).filter(|&index| previous[index].is_some()));
        for start in order {
            let mut chain = Vec::new();
            let mut cursor = Some(start);
            while let Some(index) = cursor {
                if visited[index] {
                    break;
                }
                visited[index] = true;
                chain.push(group[index].clone());
                cursor = next[index];
            }
            if !chain.is_empty() {
                chains.push(chain);
            }
        }
    }
    chains
}

pub fn snapshot_text(
    workspace: &Path,
    session_id: &str,
    snapshot: &runtime::FileSnapshot,
) -> Result<Option<String>, String> {
    runtime::file_snapshot_content_for_workspace(workspace, session_id, snapshot)
        .map_err(|error| error.to_string())
}

fn diff_projection(workspace: &Path, chain: &[runtime::FileChangeRecord]) -> Value {
    let first = chain.first().expect("nonempty chain");
    let last = chain.last().expect("nonempty chain");
    let mut value = json!({
        "path": first.path,
        "sessionId": first.session_id,
        "turnId": first.turn_id,
        "changeIds": chain.iter().map(|record| &record.change_id).collect::<Vec<_>>(),
        "beforeHash": first.before.content_hash,
        "afterHash": last.after.content_hash,
        "beforeExists": first.before.exists,
        "afterExists": last.after.exists,
        "availability": "unavailable",
        "unifiedDiff": "",
    });
    let comparison = (|| {
        let before = snapshot_text(workspace, &first.session_id, &first.before)?;
        let after = snapshot_text(workspace, &last.session_id, &last.after)?;
        crate::textdiff::text_diff(
            before.as_deref().unwrap_or_default(),
            after.as_deref().unwrap_or_default(),
            &first.path,
            3,
        )
    })();
    match comparison {
        Ok(diff) => {
            value["addedLines"] = json!(diff.added);
            value["removedLines"] = json!(diff.removed);
            let patch = diff.unified_patch(&first.path, first.before.exists, last.after.exists);
            // Keep the JSON envelope valid and the counts exact even if the
            // rendered patch exceeds the transcript's budget.
            if diff.too_large_to_chunk || patch.len() > 48_000 {
                value["availability"] = json!("too_large");
            } else {
                value["availability"] = json!("exact");
                value["unifiedDiff"] = json!(patch);
            }
        }
        Err(error) => value["reason"] = json!(error),
    }
    value
}

/// Enrich the UI copy only. The compact model result and session context stay
/// unchanged; the durable Chat event log retains this authoritative projection.
pub fn tool_output_for_review(
    workspace: &Path,
    session_id: &str,
    tool_use_id: &str,
    output: &str,
) -> String {
    let mut value = match serde_json::from_str::<Value>(output) {
        Ok(value) if value.is_object() => value,
        _ => return crate::tool_output::tool_output_for_ui(output, None),
    };
    let Some(change_id) = value.get("changeId").and_then(Value::as_str) else {
        // Shell/REPL workspace auditing already records one ledger id per
        // changed file. Reuse that map and the same single-record projection.
        if let Some(changes) = value.get("changes").and_then(Value::as_object) {
            let mut projected = serde_json::Map::new();
            let mut patch_budget = 48_000usize;
            for (path, change) in changes {
                let Some(change_id) = change.get("changeId").and_then(Value::as_str) else {
                    continue;
                };
                let output = tool_output_for_review(
                    workspace,
                    session_id,
                    tool_use_id,
                    &json!({"changeId": change_id}).to_string(),
                );
                let Ok(mut projection) = serde_json::from_str::<Value>(&output) else {
                    continue;
                };
                if projection.get("audit").is_none() {
                    // A missing ledger record is unavailable evidence, never a
                    // license to present the old bounded patch as exact.
                    projection["audit"] = json!({
                        "path": path, "changeIds": [change_id], "availability": "unavailable",
                    });
                }
                for key in ["audit", "turnDiff"] {
                    if let Some(audit) = projection.get_mut(key) {
                        let bytes = audit
                            .get("unifiedDiff")
                            .and_then(Value::as_str)
                            .map_or(0, str::len);
                        if bytes > patch_budget {
                            audit["unifiedDiff"] = json!("");
                            audit["availability"] = json!("too_large");
                        } else {
                            patch_budget -= bytes;
                        }
                    }
                }
                projected.insert(path.clone(), projection);
            }
            if !projected.is_empty() {
                value.as_object_mut().expect("object").remove("changes");
                let compact = crate::tool_output::tool_output_for_ui(&value.to_string(), None);
                let mut compact: Value =
                    serde_json::from_str(&compact).unwrap_or_else(|_| json!({"output": compact}));
                if !compact.is_object() {
                    compact = json!({"output": compact});
                }
                compact["changes"] = Value::Object(projected);
                return compact.to_string();
            }
        }
        return crate::tool_output::tool_output_for_ui(output, None);
    };
    let record = runtime::get_file_change_for_workspace(
        workspace,
        runtime::FileChangeGetInput {
            session_id: Some(session_id.to_string()),
            change_id: change_id.to_string(),
        },
    );
    let Ok(found) = record else {
        return crate::tool_output::tool_output_for_ui(output, None);
    };
    let record = found.record;
    if record.tool_use_id.as_deref() != Some(tool_use_id) {
        return crate::tool_output::tool_output_for_ui(output, None);
    }
    let audit = diff_projection(workspace, std::slice::from_ref(&record));
    value["audit"] = audit;
    // Discard any earlier bounded/fabricated representation. `audit` carries
    // an explicit unavailable state when exact blobs or Git are unavailable.
    value.as_object_mut().expect("object").remove("changes");
    if let Some(turn_id) = &record.turn_id {
        if let Ok(records) = runtime::file_changes_for_turn(workspace, session_id, turn_id) {
            if let Some(chain) = file_chains(&records)
                .into_iter()
                .find(|chain| chain.iter().any(|item| item.change_id == record.change_id))
            {
                if chain.len() > 1 {
                    value["turnDiff"] = diff_projection(workspace, &chain);
                }
            }
        }
    }
    // Tool outputs can contain optional whole-file content. Apply the existing
    // compactor before attaching bounded review evidence, not after it.
    let audit = value.as_object_mut().expect("object").remove("audit");
    let turn_diff = value.as_object_mut().expect("object").remove("turnDiff");
    let compact = crate::tool_output::tool_output_for_ui(&value.to_string(), None);
    let mut compact =
        serde_json::from_str::<Value>(&compact).unwrap_or_else(|_| json!({"output": compact}));
    if !compact.is_object() {
        compact = json!({"output": compact});
    }
    compact["audit"] = audit.unwrap_or(Value::Null);
    if let Some(turn_diff) = turn_diff {
        compact["turnDiff"] = turn_diff;
    }
    compact.to_string()
}

#[cfg(test)]
mod tests {
    use super::file_chains;
    use runtime::{FileChangeOperation, FileChangeRecord, FileChangeStatus, FileSnapshot};

    fn snapshot(hash: &str) -> FileSnapshot {
        FileSnapshot {
            exists: true,
            content_hash: Some(hash.to_string()),
            blob_ref: None,
            byte_len: None,
            line_count: None,
        }
    }

    fn record(id: &str, before: &str, after: &str) -> FileChangeRecord {
        FileChangeRecord {
            change_id: id.to_string(),
            session_id: "session".to_string(),
            turn_id: Some("turn".to_string()),
            tool_use_id: Some(format!("tool-{id}")),
            tool_name: "edit_file".to_string(),
            path: "paper.tex".to_string(),
            canonical_path: "C:/workspace/paper.tex".to_string(),
            operation: FileChangeOperation::Update,
            before: snapshot(before),
            after: snapshot(after),
            unified_diff: String::new(),
            structured_patch: Vec::new(),
            timestamp: String::new(),
            status: FileChangeStatus::Applied,
            reversible: true,
            non_reversible_reason: None,
            reverts: None,
            reverted_by: None,
        }
    }

    #[test]
    fn file_chains_follow_hashes_when_append_order_is_reversed() {
        let records = vec![
            record("second", "middle", "final"),
            record("first", "original", "middle"),
        ];
        let chains = file_chains(&records);

        assert_eq!(chains.len(), 1);
        assert_eq!(
            chains[0]
                .iter()
                .map(|record| record.change_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn file_chains_leave_ambiguous_endpoints_disconnected() {
        let records = vec![
            record("first", "original", "middle"),
            record("branch-a", "middle", "final-a"),
            record("branch-b", "middle", "final-b"),
        ];

        assert_eq!(file_chains(&records).len(), 3);
    }

    #[test]
    fn file_chains_do_not_bridge_an_intervening_edit() {
        let records = vec![
            record("first", "original", "middle"),
            record("later", "foreign", "final"),
        ];

        assert_eq!(file_chains(&records).len(), 2);
    }
}
