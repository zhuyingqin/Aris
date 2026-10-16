use super::*;

fn external_change(root: &Path) -> TypesetChangeSet {
    let revision = record_project_mutation(root, "external-change", "external", "watcher", None)
        .expect("external revision");
    create_change_set_at(
        root,
        TypesetChangeSetCreateInput {
            revision_id: revision.id,
            actor: "external".into(),
            origin: "watcher".into(),
            evidence: None,
            action_id: Some("external-1".into()),
        },
    )
    .expect("change set")
}

fn answer(root: &Path, batch: TypesetChangeSet, answer: &str) -> TypesetChangeSet {
    resolve_change_set_at(
        root,
        TypesetChangeSetResolveInput {
            id: batch.id,
            decisions: batch
                .decisions
                .into_iter()
                .map(|mut item| {
                    item.decision = answer.into();
                    item
                })
                .collect(),
        },
    )
    .expect("resolve")
}

#[test]
fn unrelated_activity_does_not_block_external_accept_or_get_reverted() {
    for decision in ["accept", "reject"] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::write(root.join("main.tex"), "before\n").unwrap();
        fs::write(root.join("experiment.py"), "original code\n").unwrap();
        ensure_project_revision(root).unwrap();
        fs::write(root.join("main.tex"), "external\n").unwrap();
        let batch = external_change(root);
        // These writes used to invalidate the entire manifest on every click.
        for name in [
            "experiment.py",
            "notes.md",
            "state.json",
            "results.csv",
            "worker.log",
        ] {
            fs::write(root.join(name), "unrelated ongoing work\n").unwrap();
        }
        let reopened = read_change_set(root, &change_set_path(root, &batch.id).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(reopened.decisions.len(), 1);
        assert_eq!(reopened.decisions[0].path, "main.tex");
        let result = answer(root, reopened, decision);
        assert_eq!(
            result.status,
            if decision == "accept" {
                "accepted"
            } else {
                "rejected"
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("main.tex")).unwrap(),
            if decision == "accept" {
                "external\n"
            } else {
                "before\n"
            }
        );
        for name in [
            "experiment.py",
            "notes.md",
            "state.json",
            "results.csv",
            "worker.log",
        ] {
            assert_eq!(
                fs::read_to_string(root.join(name)).unwrap(),
                "unrelated ongoing work\n"
            );
        }
    }
}

#[test]
fn a_new_source_edit_still_requires_review_and_is_never_overwritten() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("main.tex"), "before\n").unwrap();
    ensure_project_revision(root.path()).unwrap();
    fs::write(root.path().join("main.tex"), "external\n").unwrap();
    let batch = external_change(root.path());
    fs::write(root.path().join("main.tex"), "newer external edit\n").unwrap();
    let result = answer(root.path(), batch, "accept");
    assert_eq!(result.status, "pending");
    assert_eq!(result.decisions[0].decision, "pending");
    assert_eq!(
        fs::read_to_string(root.path().join("main.tex")).unwrap(),
        "newer external edit\n"
    );
}

#[test]
fn legacy_queues_and_ledgers_drop_unrelated_files_before_accepting() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    fs::write(root.join("main.tex"), "before\n").unwrap();
    ensure_project_revision(root).unwrap();
    fs::write(root.join("main.tex"), "external\n").unwrap();
    let mut batch = external_change(root);
    let mut ledger = load_revision_ledger(root).unwrap();
    let before = store_revision_blob(root, b"old").unwrap();
    let after = store_revision_blob(root, b"recorded").unwrap();
    for path in ["notes.md", "state.json", "main.pdf"] {
        for (index, revision) in ledger.revisions.iter_mut().enumerate() {
            revision.files.push(TypesetRevisionFile {
                path: path.into(),
                content_hash: if index == 0 {
                    before.clone()
                } else {
                    after.clone()
                },
                bytes: if index == 0 { 3 } else { 8 },
            });
            revision.files.sort_by(|a, b| a.path.cmp(&b.path));
        }
        batch.decisions.push(TypesetChangeSetDecision {
            operation_id: format!("modify:{path}"),
            path: path.into(),
            decision: "pending".into(),
            resolved_hash: None,
            resolved_bytes: None,
            hunk_decisions: Vec::new(),
            hunk_ids: Vec::new(),
        });
        fs::write(root.join(path), "latest unrelated content").unwrap();
    }
    save_revision_ledger(root, &ledger).unwrap();
    write_json(&change_set_path(root, &batch.id).unwrap(), &batch).unwrap();
    let reopened = stored_change_sets(root).unwrap();
    assert_eq!(reopened[0].decisions.len(), 1);
    assert_eq!(reopened[0].decisions[0].path, "main.tex");
    // An already-open client may still submit the obsolete decisions.
    assert_eq!(answer(root, batch, "accept").status, "accepted");
    for path in ["notes.md", "state.json", "main.pdf"] {
        assert_eq!(
            fs::read_to_string(root.join(path)).unwrap(),
            "latest unrelated content"
        );
    }
}

#[test]
fn legacy_queue_with_only_unrelated_files_no_longer_blocks_the_editor() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    fs::write(root.join("main.tex"), "unchanged\n").unwrap();
    let base = ensure_project_revision(root).unwrap();
    let mut target = base.clone();
    target.id = "revision-legacy-target".into();
    target.parent_revision_id = Some(base.id.clone());
    target.files.push(TypesetRevisionFile {
        path: "notes.md".into(),
        content_hash: "unneeded-blob".into(),
        bytes: 1,
    });
    save_revision_ledger(
        root,
        &TypesetRevisionLedger {
            version: REVISION_LEDGER_VERSION,
            head_revision_id: Some(target.id.clone()),
            revisions: vec![base.clone(), target.clone()],
        },
    )
    .unwrap();
    let batch = TypesetChangeSet {
        id: "changeset-legacy".into(),
        audited_turn: None,
        base_revision_id: base.id,
        revision_id: target.id,
        actor: "external".into(),
        origin: "watcher".into(),
        evidence: None,
        status: "pending".into(),
        decisions: vec![TypesetChangeSetDecision {
            operation_id: "create:notes.md".into(),
            path: "notes.md".into(),
            decision: "pending".into(),
            resolved_hash: None,
            resolved_bytes: None,
            hunk_decisions: Vec::new(),
            hunk_ids: Vec::new(),
        }],
        resulting_revision_id: None,
        created_at_ms: 1,
        updated_at_ms: 1,
        action_id: "legacy".into(),
        carried_from: None,
        carried_paths: vec!["notes.md".into()],
    };
    write_json(&change_set_path(root, &batch.id).unwrap(), &batch).unwrap();
    let reopened = stored_change_sets(root).unwrap();
    assert_eq!(reopened[0].status, "ignored");
    assert!(reopened[0].decisions.is_empty());
    assert!(reopened[0].carried_paths.is_empty());
    assert_eq!(answer(root, batch, "accept").status, "ignored");
}

#[test]
fn latex_sources_and_figure_inputs_are_in_scope_but_general_project_files_are_not() {
    let root = tempfile::tempdir().unwrap();
    let related = [
        "MAIN.TEX",
        "chapter.ltx",
        "appendix.latex",
        "refs.bib",
        "journal.bst",
        "article.cls",
        "custom.sty",
        "style.bbx",
        "style.cbx",
        "diagram.tikz",
        "figure.png",
        "figure.pdf",
    ];
    let unrelated = [
        "README.md",
        "config.json",
        "train.py",
        "main.rs",
        "package.ts",
        "results.csv",
        "notes.txt",
        "project.yaml",
        "main.pdf",
        "main.aux",
        "main.log",
        "main.synctex.gz",
    ];
    for path in related.iter().chain(&unrelated) {
        fs::write(root.path().join(path), "content").unwrap();
    }
    let files = snapshot_project_files(root.path()).unwrap();
    let paths = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(paths, related.into_iter().collect());
}
