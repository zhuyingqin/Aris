//! Audited Chat sources for the existing Typeset ChangeSet review workflow.
//! These are scoped operations, never synthetic global project revisions.

use super::*;
use crate::change_review::{file_chains, file_chains_across_turns, snapshot_text, AuditedTurn};

fn records(root: &Path, source: &AuditedTurn) -> Result<Vec<runtime::FileChangeRecord>, String> {
    // Change ids are immutable and workspace-unique. Read by id across the
    // project so one pending review batch can span several Chat sessions.
    let selected = runtime::list_file_changes_for_workspace(
        root,
        runtime::FileChangeListInput {
            session_id: None,
            limit: None,
        },
    )
    .map_err(|error| error.to_string())?
    .records
        .into_iter()
        .filter(|record| source.change_ids.contains(&record.change_id))
        .collect::<Vec<_>>();
    if selected.len() != source.change_ids.len() {
        return Err("audited ChangeSet references missing or duplicate change ids".to_string());
    }
    Ok(selected)
}

fn relative_path(root: &Path, path: &str) -> Result<String, String> {
    fn normalized(path: &Path) -> PathBuf {
        // Ledger paths use forward slashes, including the Windows extended
        // prefix. Convert both spellings before comparing Path components.
        #[cfg(windows)]
        {
            let path = path.to_string_lossy().replace('/', "\\");
            let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
            };
            PathBuf::from(path)
        }
        #[cfg(not(windows))]
        {
            path.to_path_buf()
        }
    }
    let root = normalized(root);
    let path = normalized(Path::new(path));
    if let Ok(relative) = path.strip_prefix(&root) {
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }
    // Case-insensitive drive/ancestor spelling is a Windows-only fallback.
    // Compare components, never lowercase then slice a UTF-8 string by bytes.
    #[cfg(windows)]
    {
        let mut components = path.components();
        if root.components().all(|part| {
            components.next().is_some_and(|other| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&other.as_os_str().to_string_lossy())
            })
        }) {
            return Ok(components.as_path().to_string_lossy().replace('\\', "/"));
        }
    }
    Err("audited change is outside this workspace".to_string())
}

fn operations(root: &Path, source: &AuditedTurn) -> Result<Vec<TypesetRevisionOperation>, String> {
    let records = records(root, source)?;
    // A revert is bookkeeping for an earlier mutation, not an additional
    // authored revision to put beside it in the Typeset review.  Keeping both
    // records splits a simple `before -> temporary -> before -> final` turn
    // into several chains with the same path.  The projection then labelled
    // that ordinary final edit as `conflict`, which left the frontend with no
    // text operation (and consequently no diff hunks or next/previous arrows).
    //
    // `file_changes_for_turn` has already marked a reverted target as
    // `Reverted`; omit it as well as the successful `Revert` record.  A later
    // update that starts at the restored content remains as the one net change
    // to review.  Genuine disconnected writes still produce separate chains
    // and retain the explicit conflict safeguard below.
    let records = records
        .into_iter()
        .filter(|record| {
            record.status == runtime::FileChangeStatus::Applied
                && record.operation != runtime::FileChangeOperation::Revert
        })
        .collect::<Vec<_>>();
    let chains = if source.additional_turn_ids.is_empty() {
        file_chains(&records)
    } else {
        file_chains_across_turns(&records)
    };
    let mut operations = BTreeMap::<String, TypesetRevisionOperation>::new();
    for chain in chains {
        let first = chain.first().expect("nonempty chain");
        let last = chain.last().expect("nonempty chain");
        let path = relative_path(root, &first.canonical_path)?;
        workspace_path_for_revision(root, &path)?;
        if path
            .split('/')
            .any(|part| matches!(part, ".git" | "node_modules" | "target" | "__pycache__"))
            || path.starts_with(".somniq/changes/")
            || path.starts_with(".somniq/typeset/")
            || is_transient_revision_path(&path)
        {
            continue;
        }
        if let Some(existing) = operations.get_mut(&path) {
            existing.kind = "conflict".to_string();
            existing.id = format!("conflict:{path}");
            continue;
        }
        let kind = match (first.before.exists, last.after.exists) {
            (false, true) => "create",
            (true, false) => "delete",
            _ => "modify",
        };
        operations.insert(
            path.clone(),
            TypesetRevisionOperation {
                id: format!("{kind}:{path}"),
                kind: kind.to_string(),
                path,
                previous_path: None,
                before_hash: first.before.content_hash.clone(),
                after_hash: last.after.content_hash.clone(),
                bytes: last.after.byte_len.unwrap_or_default() as u64,
            },
        );
    }
    let stems = document_stems(operations.keys().map(String::as_str));
    Ok(operations
        .into_values()
        .filter(|operation| {
            reviewable_change_operation(operation, &stems)
                && (operation.kind == "conflict" || operation.before_hash != operation.after_hash)
        })
        .map(|mut operation| {
            // A stale per-file decision must fail after another write extends the
            // turn, even when its path and kind are unchanged.
            operation.id = format!(
                "{}:{}",
                operation.id,
                revision_file_hash(
                    format!(
                        "{:?}\0{:?}\0{:?}",
                        operation.before_hash, operation.after_hash, source.change_ids
                    )
                    .as_bytes()
                )
            );
            operation
        })
        .collect())
}

pub(super) fn review_operations(
    root: &Path,
    ledger: &TypesetRevisionLedger,
    change_set: &TypesetChangeSet,
) -> Result<Vec<TypesetRevisionOperation>, String> {
    match &change_set.audited_turn {
        Some(source) => operations(root, source),
        None => unattributed_operations(root, change_set_operations(ledger, change_set)?),
    }
}

/// The watcher may observe an audited write before its Chat event. Suppress
/// only transitions whose exact endpoint hashes form a known Chat chain.
/// Other paths and interleaved changes remain external review material.
pub(super) fn unattributed_operations(
    root: &Path,
    operations: Vec<TypesetRevisionOperation>,
) -> Result<Vec<TypesetRevisionOperation>, String> {
    let records = runtime::list_file_changes_for_workspace(
        root,
        runtime::FileChangeListInput {
            session_id: None,
            limit: None,
        },
    )
    .map_err(|error| error.to_string())?
    .records;
    let mut by_path = BTreeMap::<String, Vec<Vec<runtime::FileChangeRecord>>>::new();
    for chain in file_chains(&records) {
        if chain[0].turn_id.is_none() {
            continue;
        }
        if let Ok(path) = relative_path(root, &chain[0].canonical_path) {
            by_path.entry(path).or_default().push(chain);
        }
    }
    Ok(operations
        .into_iter()
        .filter(|operation| {
            let Some(chains) = by_path.get(&operation.path) else {
                return true;
            };
            !chains.iter().any(|chain| {
                chain.iter().enumerate().any(|(index, first)| {
                    first.before.content_hash == operation.before_hash
                        && chain[index..]
                            .iter()
                            .any(|last| last.after.content_hash == operation.after_hash)
                })
            })
        })
        .collect())
}

pub(super) fn blob_bytes(
    root: &Path,
    change_set: &TypesetChangeSet,
    hash: &str,
) -> Result<Vec<u8>, String> {
    if let Some(source) = &change_set.audited_turn {
        for record in records(root, source)? {
            for snapshot in [&record.before, &record.after] {
                if snapshot.content_hash.as_deref() == Some(hash) {
                    return snapshot_text(root, &record.session_id, snapshot)?
                        .map(String::into_bytes)
                        .ok_or_else(|| "audited snapshot is absent".to_string());
                }
            }
        }
        return Err("hash does not belong to this audited ChangeSet".to_string());
    }
    revision_blob_bytes(root, hash)
}

pub(super) fn text_for_hash(
    root: &Path,
    change_set: &TypesetChangeSet,
    hash: Option<&str>,
) -> Result<Option<String>, String> {
    hash.map(|hash| {
        files::decode_text_bytes(&blob_bytes(root, change_set, hash)?)
            .map_err(|_| "audited snapshot is not reviewable UTF-8 text".to_string())
    })
    .transpose()
}

pub(crate) fn capture_turn(
    root: &Path,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<TypesetChangeSet>, String> {
    let _guard = lock_revision_state()?;
    capture_turn_unlocked(root, session_id, turn_id)
}

/// Re-project only pending decisions. Unchanged files retain staged answers;
/// changed endpoints require review again.
fn refresh_projection(root: &Path, batch: &mut TypesetChangeSet) -> Result<(), String> {
    let projected = operations(root, batch.audited_turn.as_ref().expect("audited source"))?;
    let previous = &batch.decisions;
    batch.decisions = projected.into_iter().map(|operation| {
        previous.iter().find(|decision| decision.operation_id == operation.id && decision.path == operation.path)
            .cloned().unwrap_or(TypesetChangeSetDecision {
                operation_id: operation.id,
                path: operation.path,
                decision: "pending".to_string(),
                resolved_hash: None,
                resolved_bytes: None,
                hunk_decisions: Vec::new(),
                hunk_ids: Vec::new(),
            })
    }).collect();
    batch.status = if batch.decisions.is_empty() { "ignored" } else { "pending" }.to_string();
    Ok(())
}

fn extend_source(target: &mut AuditedTurn, source: &AuditedTurn) {
    for turn in std::iter::once(&source.turn_id).chain(source.additional_turn_ids.iter()) {
        if *turn != target.turn_id && !target.additional_turn_ids.contains(turn) {
            target.additional_turn_ids.push(turn.clone());
        }
    }
    target.change_ids.extend(source.change_ids.iter().cloned());
    target.change_ids.sort();
    target.change_ids.dedup();
}

/// One pending audited Chat batch per project. Keep absorbed records as
/// non-pending history; writing the survivor first makes retries idempotent.
pub(super) fn merge_pending(
    root: &Path,
    mut batches: Vec<TypesetChangeSet>,
) -> Result<Vec<TypesetChangeSet>, String> {
    let indices = batches.iter().enumerate()
        .filter(|(_, item)| item.status == "pending" && item.actor == "chat" && item.audited_turn.is_some())
        .map(|(index, _)| index).collect::<Vec<_>>();
    let Some(&first) = indices.first() else { return Ok(batches); };
    let mut merged = batches[first].clone();
    let before = serde_json::to_value(&merged).map_err(|error| error.to_string())?;
    // Normalize even a single batch left by an interrupted migration.
    let source = merged.audited_turn.as_mut().expect("audited source");
    source.change_ids.sort();
    source.change_ids.dedup();
    for &index in indices.iter().skip(1) {
        extend_source(source, batches[index].audited_turn.as_ref().expect("audited source"));
        merged.decisions.extend(batches[index].decisions.iter().cloned());
    }
    refresh_projection(root, &mut merged)?;
    if before != serde_json::to_value(&merged).map_err(|error| error.to_string())? {
        merged.updated_at_ms = now_ms().max(merged.updated_at_ms + 1);
        write_json(&change_set_path(root, &merged.id)?, &merged)?;
    }
    batches[first] = merged;
    for &index in indices.iter().skip(1) {
        batches[index].status = "merged".to_string();
        batches[index].updated_at_ms = now_ms();
        write_json(&change_set_path(root, &batches[index].id)?, &batches[index])?;
    }
    Ok(batches)
}

fn capture_turn_unlocked(
    root: &Path,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<TypesetChangeSet>, String> {
    let turn_records = runtime::file_changes_for_turn(root, session_id, turn_id)
        .map_err(|error| error.to_string())?;
    if turn_records.is_empty() { return Ok(None); }
    let stored = merge_pending(root, stored_change_sets(root)?)?;
    let all_ids = turn_records.iter().map(|record| record.change_id.clone()).collect::<Vec<_>>();
    // A late tool/done event must not resurrect already answered mutations.
    let completed_ids = stored.iter()
        .filter(|batch| batch.status != "pending" && batch.status != "merged")
        .filter_map(|batch| batch.audited_turn.as_ref())
        .flat_map(|source| source.change_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let source = AuditedTurn {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        change_ids: all_ids.iter().filter(|id| !completed_ids.contains(*id)).cloned().collect(),
        additional_turn_ids: Vec::new(),
    };
    if source.change_ids.is_empty() {
        return Ok(stored.into_iter().find(|batch| batch.status != "merged" && batch.audited_turn.as_ref()
            .is_some_and(|source| all_ids.iter().all(|id| source.change_ids.contains(id)))));
    }
    if let Some(mut existing) = stored.iter().find(|batch|
        batch.status == "pending" && batch.actor == "chat" && batch.audited_turn.is_some()
    ).cloned() {
        let existing_source = existing.audited_turn.as_mut().expect("audited source");
        if source.change_ids.iter().all(|id| existing_source.change_ids.contains(id)) {
            return Ok(Some(existing));
        }
        // Also extend a turn already in the batch: tools append new mutations
        // throughout that turn, not just when it first appears.
        extend_source(existing_source, &source);
        refresh_projection(root, &mut existing)?;
        existing.updated_at_ms = now_ms().max(existing.updated_at_ms + 1);
        write_json(&change_set_path(root, &existing.id)?, &existing)?;
        return Ok(Some(existing));
    }
    let at = now_ms();
    // Include ids in a new identity so later edits in an already answered turn
    // cannot overwrite that completed batch.
    let id = format!("changeset-audit-{}", revision_file_hash(
        format!("{session_id}\\0{turn_id}\\0{:?}", source.change_ids).as_bytes()
    ));
    let mut batch = TypesetChangeSet {
        id,
        audited_turn: Some(source),
        base_revision_id: String::new(),
        revision_id: String::new(),
        actor: "chat".to_string(),
        origin: "chat".to_string(),
        evidence: Some(format!("{session_id}/{turn_id}")),
        status: "pending".to_string(),
        decisions: Vec::new(),
        resulting_revision_id: None,
        created_at_ms: at,
        updated_at_ms: at,
        action_id: turn_id.to_string(),
        carried_from: None,
        carried_paths: Vec::new(),
    };
    refresh_projection(root, &mut batch)?;
    if batch.decisions.is_empty() { return Ok(None); }
    write_json(&change_set_path(root, &batch.id)?, &batch)?;
    Ok(Some(batch))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn resolve_at(
    root: &Path,
    change_set: TypesetChangeSet,
    decisions: Vec<TypesetChangeSetDecision>,
) -> Result<TypesetChangeSet, String> {
    // The visible project can change while review work is on the blocking
    // pool. Keep both writes and their runtime audit in the captured project.
    let execution = runtime::ProjectExecutionContext::new(root)
        .with_env("ARIS_WORKSPACE_ROOT", root.as_os_str());
    runtime::with_project_execution_context(&execution, || {
        resolve_in_workspace(root, change_set, decisions)
    })
}

fn resolve_in_workspace(
    root: &Path,
    mut change_set: TypesetChangeSet,
    decisions: Vec<TypesetChangeSetDecision>,
) -> Result<TypesetChangeSet, String> {
    let source = change_set.audited_turn.as_ref().expect("audited source");
    let operations = operations(root, source)?;
    let mut seen = BTreeSet::new();
    if decisions.len() != operations.len()
        || decisions.iter().any(|decision| {
            !seen.insert(&decision.operation_id)
                || !operations.iter().any(|operation| {
                    operation.id == decision.operation_id && operation.path == decision.path
                })
                || !matches!(
                    decision.decision.as_str(),
                    "pending" | "accept" | "reject" | "partial"
                )
        })
    {
        return Err("invalid audited ChangeSet decisions".to_string());
    }
    // Partial content must be the content staged for this exact operation, not
    // an arbitrary hash supplied by a client or another review.
    for decision in decisions
        .iter()
        .filter(|decision| decision.decision == "partial")
    {
        let staged = change_set
            .decisions
            .iter()
            .find(|item| item.operation_id == decision.operation_id);
        if staged.is_none_or(|item| {
            item.decision != "partial"
                || item.resolved_hash != decision.resolved_hash
                || item.resolved_bytes != decision.resolved_bytes
        }) {
            return Err("partial review has no matching staged result".to_string());
        }
    }
    change_set.decisions = decisions;
    change_set.updated_at_ms = now_ms();
    let state_path = change_set_path(root, &change_set.id)?;
    if change_set
        .decisions
        .iter()
        .any(|decision| decision.decision == "pending")
    {
        write_json(&state_path, &change_set)?;
        return Ok(change_set);
    }
    // Preflight all affected paths. Accept is an acknowledgement and never
    // writes incoming bytes back over a later user edit.
    let mut writes = Vec::new();
    for operation in &operations {
        let decision = change_set
            .decisions
            .iter()
            .find(|item| item.operation_id == operation.id)
            .expect("validated");
        if decision.decision == "accept" {
            continue;
        }
        if operation.kind == "conflict" {
            return Err(format!("{} contains interleaved edits; its Chat changes cannot be safely rejected as one span", operation.path));
        }
        let target = workspace_path_for_revision(root, &operation.path)?;
        // Canonicalize the existing ancestor, rejecting paths redirected by a
        // symlink since the audit was recorded.
        let mut ancestor = target.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("missing path ancestor")?;
        }
        if !ancestor
            .canonicalize()
            .map_err(|error| error.to_string())?
            .starts_with(root.canonicalize().map_err(|error| error.to_string())?)
        {
            return Err("review target was redirected outside the project".to_string());
        }
        let current = read_optional(&target)?;
        let incoming = operation
            .after_hash
            .as_deref()
            .map(|hash| blob_bytes(root, &change_set, hash))
            .transpose()?;
        let desired = if decision.decision == "partial" {
            Some(revision_blob_bytes(
                root,
                decision
                    .resolved_hash
                    .as_deref()
                    .ok_or("missing staged content")?,
            )?)
        } else {
            operation
                .before_hash
                .as_deref()
                .map(|hash| blob_bytes(root, &change_set, hash))
                .transpose()?
        };
        let desired = if current == incoming || current == desired {
            desired
        } else if let (Some(incoming), Some(current), Some(desired)) =
            (&incoming, &current, &desired)
        {
            let merged = crate::textdiff::three_way_merge(
                std::str::from_utf8(incoming).map_err(|error| error.to_string())?,
                std::str::from_utf8(current).map_err(|error| error.to_string())?,
                std::str::from_utf8(desired).map_err(|error| error.to_string())?,
                &operation.path,
            )?;
            if !merged.clean {
                return Err(format!(
                    "{} changed after this Chat turn; review conflicts with the current content",
                    operation.path
                ));
            }
            Some(merged.content.into_bytes())
        } else {
            return Err(format!(
                "{} was created or deleted after this Chat turn; no content was overwritten",
                operation.path
            ));
        };
        if current != desired {
            writes.push((target, current, desired));
        }
    }
    let context = runtime::FileMutationContext {
        session_id: Some(source.session_id.clone()),
        tool_name: "typeset_review".to_string(),
        ..Default::default()
    };
    let mut applied = Vec::new();
    for (target, current, desired) in &writes {
        if let Err(error) = runtime::compare_and_replace_text_file(
            target,
            current.as_deref(),
            desired.as_deref(),
            &context,
        ) {
            let mut rollback_errors = Vec::new();
            for index in applied.into_iter().rev() {
                let (target, before, after): &(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>) =
                    &writes[index];
                if let Err(rollback) = runtime::compare_and_replace_text_file(
                    target,
                    after.as_deref(),
                    before.as_deref(),
                    &context,
                ) {
                    rollback_errors.push(rollback.to_string());
                }
            }
            return Err(format!(
                "review write failed: {error}; rollback conflicts: {}",
                rollback_errors.join("; ")
            ));
        }
        applied.push(applied.len());
    }
    let result = capture_project_revision_at_unlocked(
        root,
        None,
        "changeset-review".to_string(),
        "user".to_string(),
        "review".to_string(),
        Some(change_set.id.clone()),
    )?;
    change_set.status = if change_set
        .decisions
        .iter()
        .all(|item| item.decision == "accept")
    {
        "accepted"
    } else if change_set
        .decisions
        .iter()
        .all(|item| item.decision == "reject")
    {
        "rejected"
    } else {
        "partially-accepted"
    }
    .to_string();
    change_set.resulting_revision_id = Some(result.id);
    write_json(&state_path, &change_set)?;
    Ok(change_set)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_workspace(test: impl FnOnce(&Path)) {
        let root = tempfile::tempdir().expect("workspace");
        let context = runtime::ProjectExecutionContext::new(root.path())
            .with_env("ARIS_WORKSPACE_ROOT", root.path().as_os_str());
        runtime::with_project_execution_context(&context, || test(root.path()));
    }

    fn record(root: &Path, tool: &str, before: &str, after: &str) -> runtime::FileChangeRecord {
        record_at(root, "paper.tex", tool, before, after)
    }

    fn record_at(
        root: &Path,
        name: &str,
        tool: &str,
        before: &str,
        after: &str,
    ) -> runtime::FileChangeRecord {
        let path = root.join(name);
        fs::write(&path, after).expect("mutate");
        runtime::record_text_file_change(
            &runtime::FileMutationContext {
                session_id: Some("chat-session".to_string()),
                turn_id: Some("turn-test".to_string()),
                tool_use_id: Some(tool.to_string()),
                tool_name: "edit_file".to_string(),
            },
            &path,
            runtime::FileChangeOperation::Update,
            Some(before),
            Some(after),
            Vec::new(),
            String::new(),
            None,
        )
        .expect("record")
        .expect("changed")
    }

    fn captured(root: &Path) -> TypesetChangeSet {
        capture_turn(root, "chat-session", "turn-test")
            .expect("capture")
            .expect("changeset")
    }

    fn decisions(change_set: &TypesetChangeSet, answer: &str) -> Vec<TypesetChangeSetDecision> {
        change_set
            .decisions
            .iter()
            .cloned()
            .map(|mut decision| {
                decision.decision = answer.to_string();
                decision
            })
            .collect()
    }

    #[test]
    fn reject_restores_only_the_audited_file() {
        in_workspace(|root| {
            record(root, "tool-1", "original\n", "chat\n");
            fs::write(root.join("notes.tex"), "unrelated user content").unwrap();
            let change_set = captured(root);
            let other = tempfile::tempdir().unwrap();
            let switched = runtime::ProjectExecutionContext::new(other.path())
                .with_env("ARIS_WORKSPACE_ROOT", other.path().as_os_str());
            let rejected = runtime::with_project_execution_context(&switched, || {
                resolve_at(root, change_set.clone(), decisions(&change_set, "reject"))
            })
            .unwrap();
            assert_eq!(rejected.status, "rejected");
            assert_eq!(
                fs::read_to_string(root.join("paper.tex")).unwrap(),
                "original\n"
            );
            assert_eq!(
                fs::read_to_string(root.join("notes.tex")).unwrap(),
                "unrelated user content"
            );
            let audit = runtime::list_file_changes_for_workspace(
                root,
                runtime::FileChangeListInput {
                    session_id: Some("chat-session".to_string()),
                    limit: None,
                },
            )
            .unwrap();
            assert!(audit
                .records
                .iter()
                .any(|record| record.tool_name == "typeset_review"));
            assert!(!other.path().join(".somniq/changes").exists());
        });
    }

    #[test]
    fn accept_acknowledges_without_rewriting_later_content_or_reading_audit_blobs() {
        in_workspace(|root| {
            let recorded = record(root, "tool-1", "original\n", "chat\n");
            let change_set = captured(root);
            let path = root.join("paper.tex");
            fs::write(&path, "later user content\n").unwrap();
            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            // Accept needs only the identity/hashes; removing the old blob
            // ensures it cannot implement acknowledgement by rewriting it.
            let blob = recorded.before.blob_ref.as_ref().unwrap();
            let ledger = runtime::change_ledger_root_for_path(&path);
            let candidates = walkdir::WalkDir::new(&ledger)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && entry.path().ends_with(blob))
                .map(|entry| entry.into_path())
                .collect::<Vec<_>>();
            assert_eq!(candidates.len(), 1);
            fs::remove_file(&candidates[0]).unwrap();
            let accepted =
                resolve_at(root, change_set.clone(), decisions(&change_set, "accept")).unwrap();
            assert_eq!(accepted.status, "accepted");
            assert_eq!(fs::read_to_string(&path).unwrap(), "later user content\n");
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        });
    }

    #[test]
    fn reject_merges_around_a_later_user_edit_and_stops_on_overlap() {
        in_workspace(|root| {
            let before = "original\n1\n2\n3\n4\n5\n6\n7\nend\n";
            let incoming = before.replacen("original", "chat", 1);
            record(root, "tool-1", before, &incoming);
            let change_set = captured(root);
            fs::write(root.join("paper.tex"), incoming.replace("end", "user end")).unwrap();
            resolve_at(root, change_set.clone(), decisions(&change_set, "reject")).unwrap();
            assert_eq!(
                fs::read_to_string(root.join("paper.tex")).unwrap(),
                before.replace("end", "user end")
            );
        });
        in_workspace(|root| {
            record(root, "tool-1", "original\n", "chat\n");
            let change_set = captured(root);
            fs::write(root.join("paper.tex"), "user conflict\n").unwrap();
            assert!(
                resolve_at(root, change_set.clone(), decisions(&change_set, "reject")).is_err()
            );
            assert_eq!(
                fs::read_to_string(root.join("paper.tex")).unwrap(),
                "user conflict\n"
            );
            assert_eq!(
                read_change_set(&change_set_path(root, &change_set.id).unwrap())
                    .unwrap()
                    .unwrap()
                    .status,
                "pending"
            );
        });
    }

    #[test]
    fn turn_diff_is_net_content_and_interleaved_edits_stay_conflicts() {
        in_workspace(|root| {
            let first = record(root, "tool-1", "original\n", "temporary\n");
            let second = record(root, "tool-2", "temporary\n", "final\n");
            let output = crate::change_review::tool_output_for_review(
                root,
                "chat-session",
                "tool-2",
                &serde_json::json!({ "changeId": second.change_id }).to_string(),
            );
            let output: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(
                output["turnDiff"]["changeIds"],
                serde_json::json!([first.change_id, second.change_id])
            );
            assert_eq!(output["turnDiff"]["addedLines"], 1);
            assert_eq!(output["turnDiff"]["removedLines"], 1);
            assert!(output["turnDiff"]["unifiedDiff"]
                .as_str()
                .unwrap()
                .contains("-original\n+final"));
            let old = captured(root);
            record(root, "tool-3", "user edit\n", "chat again\n");
            let extended = captured(root);
            let operations = operations(root, extended.audited_turn.as_ref().unwrap()).unwrap();
            assert_eq!(operations.len(), 1);
            assert_eq!(operations[0].kind, "conflict");
            assert!(resolve_at(root, extended.clone(), decisions(&old, "reject")).is_err());
            assert!(resolve_at(root, extended.clone(), decisions(&extended, "reject")).is_err());
            assert_eq!(
                fs::read_to_string(root.join("paper.tex")).unwrap(),
                "chat again\n"
            );
        });
    }

    #[test]
    fn reverted_temporary_edit_does_not_turn_final_edit_into_conflict() {
        in_workspace(|root| {
            let temporary = record(root, "tool-temporary", "original\n", "temporary\n");
            let reverted = runtime::revert_file_change(
                runtime::FileChangeRevertInput {
                    change_id: temporary.change_id.clone(),
                    session_id: Some("chat-session".to_string()),
                },
                &runtime::FileMutationContext {
                    session_id: Some("chat-session".to_string()),
                    turn_id: Some("turn-test".to_string()),
                    tool_use_id: Some("tool-revert".to_string()),
                    tool_name: "change_revert".to_string(),
                },
            )
            .expect("revert temporary edit");
            assert!(reverted.reverted);
            let final_edit = record(root, "tool-final", "original\n", "final\n");

            let change_set = captured(root);
            let operations = operations(root, change_set.audited_turn.as_ref().unwrap())
                .expect("project audited operations");
            assert_eq!(operations.len(), 1);
            assert_eq!(operations[0].kind, "modify");
            assert_eq!(operations[0].before_hash, final_edit.before.content_hash);
            assert_eq!(operations[0].after_hash, final_edit.after.content_hash);
            assert_eq!(
                text_for_hash(root, &change_set, operations[0].after_hash.as_deref())
                    .expect("load final snapshot"),
                Some("final\n".to_string())
            );
        });
    }

    #[test]
    fn multi_file_tool_outputs_use_the_same_ledger_projection() {
        in_workspace(|root| {
            let first = record(root, "tool-first", "original\n", "middle\n");
            let paper = record(root, "tool-shell", "middle\n", "final\n");
            let chapter = record_at(
                root,
                "chapter.tex",
                "tool-shell",
                "chapter before\n",
                "chapter after\n",
            );
            let output = crate::change_review::tool_output_for_review(root, "chat-session", "tool-shell",
                &serde_json::json!({
                    "changeIds": [paper.change_id, chapter.change_id],
                    "changes": {
                        "paper.tex": { "type": "update", "changeId": paper.change_id, "unified_diff": "bounded obsolete patch" },
                        "chapter.tex": { "type": "update", "changeId": chapter.change_id, "unified_diff": "bounded obsolete patch" },
                    },
                }).to_string());
            let output: serde_json::Value = serde_json::from_str(&output).unwrap();
            let paper = &output["changes"]["paper.tex"];
            assert_eq!(paper["audit"]["availability"], "exact");
            assert!(paper["audit"]["unifiedDiff"]
                .as_str()
                .unwrap()
                .contains("-middle\n+final"));
            assert_eq!(paper["turnDiff"]["changeIds"][0], first.change_id);
            assert!(paper["turnDiff"]["unifiedDiff"]
                .as_str()
                .unwrap()
                .contains("-original\n+final"));
            assert_eq!(output["changes"]["chapter.tex"]["audit"]["addedLines"], 1);
            assert_eq!(captured(root).decisions.len(), 2);
        });
    }

    #[test]
    fn partial_review_uses_staged_content_and_preserves_later_user_edits() {
        in_workspace(|root| {
            let before = "first\n1\n2\n3\nmiddle\n5\n6\n7\nlast\n";
            let incoming = before
                .replace("first", "chat first")
                .replace("last", "chat last");
            record(root, "tool-1", before, &incoming);
            let mut change_set = captured(root);
            let desired = before.replace("last", "chat last");
            let hash = store_revision_blob(root, desired.as_bytes()).unwrap();
            change_set.decisions[0].decision = "partial".to_string();
            change_set.decisions[0].resolved_hash = Some(hash);
            change_set.decisions[0].resolved_bytes = Some(desired.len() as u64);
            fs::write(
                root.join("paper.tex"),
                incoming.replace("middle", "user middle"),
            )
            .unwrap();
            let resolved =
                resolve_at(root, change_set.clone(), change_set.decisions.clone()).unwrap();
            assert_eq!(resolved.status, "partially-accepted");
            assert_eq!(
                fs::read_to_string(root.join("paper.tex")).unwrap(),
                desired.replace("middle", "user middle")
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn relative_paths_handle_windows_extended_and_unicode_paths() {
        assert_eq!(
            relative_path(
                Path::new(r"C:\研究\İstanbul"),
                "//?/C:/研究/İstanbul/章节.tex"
            )
            .unwrap(),
            "章节.tex"
        );
        assert_eq!(
            relative_path(
                Path::new(r"\\server\share\论文"),
                "//?/UNC/server/share/论文/paper.tex"
            )
            .unwrap(),
            "paper.tex"
        );
        assert!(relative_path(Path::new(r"C:\research"), "C:/research-other/paper.tex").is_err());
    }
}
