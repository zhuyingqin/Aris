//! Work-task board rules.
//!
//! The store resolves through `ARIS_CONFIG_ROOT`, which is process-global, so
//! every test here holds `crate::test_env_lock()` for its body. Without that a
//! parallel test would write into whichever fixture happened to be installed —
//! or, with the variable unset, into the developer's real config directory.

use std::path::{Path, PathBuf};

use super::{
    artifact_export_core, cancel_core, create_core, delete_core, list_core, pause_core,
    queue_scheduled_run, reorder_core, reply_core, return_to_todo_core, snapshot_core, start_core,
    update_core,
};
use crate::work_task::engine;
use crate::work_task::model::{
    WorkTaskEmptyReason, WorkTaskFileChangeKind, WorkTaskPendingAction, WorkTaskStatus,
    WorkTaskStopReason,
};
use crate::work_task::store;
use crate::work_task::worktree;

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

/// An isolated config root plus a real git repository to cut worktrees from.
struct Fixture {
    _temp: tempfile::TempDir,
    _config: EnvGuard,
    _serial: std::sync::MutexGuard<'static, ()>,
    project_path: PathBuf,
    project_id: String,
}

fn fixture(name: &str) -> Fixture {
    let serial = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let temp = tempfile::tempdir().expect("tempdir");
    let config = EnvGuard::set("ARIS_CONFIG_ROOT", temp.path().join("config"));
    let project_path = temp.path().join("repo");
    init_repo(&project_path);
    Fixture {
        _temp: temp,
        _config: config,
        _serial: serial,
        project_path,
        project_id: format!("proj-{name}"),
    }
}

fn git(root: &Path, args: &[&str]) {
    let output = crate::process::hidden_command("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(root: &Path) {
    std::fs::create_dir_all(root).expect("repo dir");
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.email", "task@example.com"]);
    git(root, &["config", "user.name", "Task Runner"]);
    std::fs::write(root.join("README.md"), "seed\n").expect("seed");
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "seed"]);
}

/// Put a task into review with committed work, the way a finished run leaves
/// it — without running a model.
fn seed_reviewable(fixture: &Fixture, title: &str) -> String {
    let task = create_core(
        &fixture.project_id,
        title.into(),
        "do the thing".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    std::fs::write(Path::new(&tree.path).join("answer.md"), "42\n").expect("write");
    worktree::commit_all(Path::new(&tree.path), "task: answer", &tree.base_sha).expect("commit");
    let snapshot =
        engine::capture_snapshot(Path::new(&tree.path), &tree.base_sha).expect("snapshot");
    store::update(&fixture.project_id, &task.id, |task| {
        task.worktree = Some(tree.clone());
        task.status = WorkTaskStatus::Review;
        task.changes = Some(snapshot.changes());
        task.review_snapshot = Some(snapshot.clone());
        task.result_summary = Some("wrote the answer".into());
        Ok(())
    })
    .expect("stage review");
    task.id
}

#[test]
fn a_task_needs_a_title() {
    let fixture = fixture("title");
    assert!(create_core(&fixture.project_id, "   ".into(), String::new(), None).is_err());
    let task = create_core(
        &fixture.project_id,
        " Rewrite section 3 ".into(),
        String::new(),
        None,
    )
    .expect("create");
    assert_eq!(task.title, "Rewrite section 3");
    assert_eq!(task.status, WorkTaskStatus::Todo);
}

/// A project with no repository has nowhere to isolate the work. Refusing at
/// queue time rather than at launch keeps the card where the user can see why.
#[test]
fn starting_a_task_outside_a_repository_is_refused_before_the_card_moves() {
    let fixture = fixture("no-repo");
    let bare = fixture._temp.path().join("not-a-repo");
    std::fs::create_dir_all(&bare).expect("dir");
    let task =
        create_core(&fixture.project_id, "Task".into(), String::new(), None).expect("create");

    let error = start_core(&fixture.project_id, &bare, &task.id).expect_err("must refuse");
    assert!(error.contains("Git repository"), "unhelpful error: {error}");
    assert_eq!(
        store::get(&fixture.project_id, &task.id)
            .expect("task")
            .status,
        WorkTaskStatus::Todo,
        "a refused start must leave the card in todo"
    );
}

/// The prompt is replayed at launch, so a running task's instruction must not
/// be editable — the card would end up describing work nobody asked for.
#[test]
fn an_engine_owned_task_cannot_be_edited_or_deleted() {
    let fixture = fixture("owned");
    let task =
        create_core(&fixture.project_id, "Task".into(), "original".into(), None).expect("create");
    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::Running;
        Ok(())
    })
    .expect("mark running");

    let edit = update_core(
        &fixture.project_id,
        &task.id,
        Some("changed".into()),
        None,
        None,
    )
    .expect_err("edit must be refused");
    assert!(edit.contains("cancel it first"), "unhelpful error: {edit}");

    let delete = delete_core(&fixture.project_id, &fixture.project_path, &task.id)
        .expect_err("delete must be refused");
    assert!(
        delete.contains("cancel it first"),
        "unhelpful error: {delete}"
    );

    assert_eq!(
        store::get(&fixture.project_id, &task.id)
            .expect("task")
            .prompt,
        "original"
    );
}

/// The race guard. A cancel bumps the generation so a turn finishing a moment
/// later settles nothing — without this the card the user just dropped comes
/// back as if the run had succeeded.
#[test]
fn cancelling_bumps_the_generation_so_a_late_completion_settles_nothing() {
    let fixture = fixture("generation");
    let task =
        create_core(&fixture.project_id, "Task".into(), String::new(), None).expect("create");
    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::Running;
        task.run_seq = 1;
        Ok(())
    })
    .expect("mark running");

    let cancelled =
        cancel_core(&fixture.project_id, &fixture.project_path, &task.id).expect("cancel");
    assert_eq!(cancelled.status, WorkTaskStatus::Canceled);
    assert_eq!(cancelled.run_seq, 2, "cancel must claim a new generation");

    // The in-flight turn's settle, arriving late for generation 1.
    let stale = store::update(&fixture.project_id, &task.id, |task| {
        if task.run_seq != 1 {
            return Err("superseded by a newer run".to_string());
        }
        task.status = WorkTaskStatus::Review;
        Ok(())
    });
    assert!(stale.is_err(), "a stale generation must not write");
    assert_eq!(
        store::get(&fixture.project_id, &task.id)
            .expect("task")
            .status,
        WorkTaskStatus::Canceled
    );
}

/// A merge is the one thing the user cannot interrupt: the base branch is
/// being written.
#[test]
fn a_merging_task_cannot_be_cancelled() {
    let fixture = fixture("merging");
    let task =
        create_core(&fixture.project_id, "Task".into(), String::new(), None).expect("create");
    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::Merging;
        Ok(())
    })
    .expect("mark merging");

    let error =
        cancel_core(&fixture.project_id, &fixture.project_path, &task.id).expect_err("must refuse");
    assert!(error.contains("merged"), "unhelpful error: {error}");
}

/// The closing half of the loop: accepting lands the work in the user's own
/// checkout and retires the card.
#[test]
fn accepting_a_reviewed_task_lands_its_work_and_finishes_the_card() {
    let fixture = fixture("accept");
    let task_id = seed_reviewable(&fixture, "Write the answer");

    let done =
        engine::accept(&fixture.project_id, &fixture.project_path, &task_id).expect("accept");

    assert_eq!(done.status, WorkTaskStatus::Done);
    assert!(
        done.merge_commit.is_some(),
        "a landed task records its commit"
    );
    assert!(
        fixture.project_path.join("answer.md").is_file(),
        "the work must reach the user's checkout"
    );
    // The isolation is gone, but the branch survives as the pre-merge handle.
    assert!(!Path::new(&done.worktree.expect("worktree").path).exists());
}

/// Versions that excluded the whole `.somniq/` directory left generated
/// papers dirty in the worktree while recording a zero-file review. Opening
/// the diff must recover those deliverables, update the card, and make Accept
/// land them without also landing runtime cache files.
#[test]
fn reading_a_legacy_zero_diff_recovers_generated_artifacts() {
    let fixture = fixture("recover-artifacts");
    let task = create_core(
        &fixture.project_id,
        "Build survey".into(),
        "write it".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    let tree_path = Path::new(&tree.path);
    std::fs::create_dir_all(tree_path.join(".somniq/papers/survey")).expect("paper dir");
    std::fs::write(
        tree_path.join(".somniq/papers/survey/main.tex"),
        "survey body\n",
    )
    .expect("paper");
    std::fs::create_dir_all(tree_path.join(".somniq/tmp/tool-output")).expect("runtime dir");
    std::fs::write(
        tree_path.join(".somniq/tmp/tool-output/call.log"),
        "runtime cache\n",
    )
    .expect("runtime cache");
    store::update(&fixture.project_id, &task.id, |current| {
        current.worktree = Some(tree.clone());
        current.status = WorkTaskStatus::Review;
        current.changes = Some(Default::default());
        Ok(())
    })
    .expect("legacy review");

    let snapshot =
        engine::review_snapshot(&fixture.project_id, &task.id).expect("review snapshot");
    let paths = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths, [".somniq/papers/survey/main.tex"]);
    assert!(snapshot.empty_reason.is_none());
    let patch = engine::review_patch(&fixture.project_id, &task.id, None).expect("patch");
    assert!(patch.contains(".somniq/papers/survey/main.tex"));
    assert!(!patch.contains(".somniq/tmp/tool-output/call.log"));
    let repaired = store::get(&fixture.project_id, &task.id).expect("task");
    assert_eq!(repaired.changes.expect("changes").files_changed, 1);
    // The recovered snapshot is persisted, so the next view does not have to
    // rediscover it — and the pinned head is what the patch is read at.
    let stored = repaired.review_snapshot.expect("snapshot persisted");
    assert_eq!(stored.files.len(), 1);
    assert!(!stored.head_sha.is_empty());

    let done = engine::accept(&fixture.project_id, &fixture.project_path, &task.id)
        .expect("accept recovered task");
    assert_eq!(done.status, WorkTaskStatus::Done);
    assert!(fixture
        .project_path
        .join(".somniq/papers/survey/main.tex")
        .is_file());
    assert!(
        !fixture
            .project_path
            .join(".somniq/tmp/tool-output/call.log")
            .exists(),
        "runtime cache must not be merged"
    );
}

/// Only a reviewed task can be accepted. Anything else would merge a branch
/// that is still being written.
#[test]
fn only_a_reviewed_task_can_be_accepted() {
    let fixture = fixture("accept-guard");
    let task =
        create_core(&fixture.project_id, "Task".into(), String::new(), None).expect("create");
    let error = engine::accept(&fixture.project_id, &fixture.project_path, &task.id)
        .expect_err("must refuse");
    assert!(error.contains("review"), "unhelpful error: {error}");
}

/// A failed merge returns the card to review rather than failing it: the work
/// is intact, and the user is the one who can resolve what went wrong.
#[test]
fn a_merge_that_cannot_run_returns_the_card_to_review_with_the_reason() {
    let fixture = fixture("merge-refused");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    // The user wandered off the base branch.
    git(&fixture.project_path, &["checkout", "-b", "elsewhere"]);

    let error = engine::accept(&fixture.project_id, &fixture.project_path, &task_id)
        .expect_err("must refuse");
    assert!(
        error.contains("elsewhere"),
        "error should name the branch: {error}"
    );

    let task = store::get(&fixture.project_id, &task_id).expect("task");
    assert_eq!(task.status, WorkTaskStatus::Review);
    assert_eq!(task.last_error.as_deref(), Some(error.as_str()));

    // The failure is recoverable, so the card must not be marked unmergeable:
    // the user switches back and accepts again.
    let listed = list_core(&fixture.project_id, &fixture.project_path);
    let card = listed.iter().find(|task| task.id == task_id).expect("card");
    assert!(
        !card.worktree_missing,
        "a refused merge must not read as lost work"
    );
    git(&fixture.project_path, &["checkout", "main"]);
    let done = engine::accept(&fixture.project_id, &fixture.project_path, &task_id)
        .expect("the second attempt must be allowed");
    assert_eq!(done.status, WorkTaskStatus::Done);
}

/// A local research-library file at the same path as a task artifact is not a
/// user cleanup request. Accept preserves it, leaves the semantic conflict in
/// the isolated checkout, and marks the same task as owned by the merge Agent.
#[test]
fn an_untracked_collision_is_handed_to_the_merge_agent() {
    let fixture = fixture("agent-merge-untracked");
    let task = create_core(
        &fixture.project_id,
        "Update the paper library".into(),
        "merge new papers".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    let relative = ".somniq/papers/library.json";
    std::fs::create_dir_all(Path::new(&tree.path).join(".somniq/papers")).expect("task papers");
    std::fs::write(
        Path::new(&tree.path).join(relative),
        "{\"records\":[\"task\"]}\n",
    )
    .expect("task library");
    worktree::commit_all(Path::new(&tree.path), "task: papers", &tree.base_sha)
        .expect("task commit");
    store::update(&fixture.project_id, &task.id, |task| {
        task.worktree = Some(tree.clone());
        task.status = WorkTaskStatus::Review;
        Ok(())
    })
    .expect("stage review");
    std::fs::create_dir_all(fixture.project_path.join(".somniq/papers")).expect("local papers");
    std::fs::write(
        fixture.project_path.join(relative),
        "{\"records\":[\"local\"]}\n",
    )
    .expect("local library");

    let error = engine::accept(&fixture.project_id, &fixture.project_path, &task.id)
        .expect_err("semantic conflict");
    let repairing =
        engine::prepare_merge_repair(&fixture.project_id, &fixture.project_path, &task.id, &error)
            .expect("hand off to Agent");

    assert_eq!(repairing.status, WorkTaskStatus::Merging);
    assert!(repairing.merge_intent.is_some());
    assert!(repairing.session_id.is_some());
    assert!(worktree::has_unmerged_paths(Path::new(&tree.path)).expect("conflict"));
    // The local version is now recoverable from the base branch's history.
    let preserved = crate::process::hidden_command("git")
        .current_dir(&fixture.project_path)
        .args(["show", &format!("HEAD:{relative}")])
        .output()
        .expect("show preserved");
    assert!(preserved.status.success());
    assert_eq!(
        String::from_utf8_lossy(&preserved.stdout).trim(),
        "{\"records\":[\"local\"]}"
    );
}

/// Returning a task throws its work away and puts a clean card back on the
/// board — including the worktree, which would otherwise be a branch nothing
/// points at.
#[test]
fn returning_a_reviewed_task_discards_its_worktree_and_its_result() {
    let fixture = fixture("return");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let before = store::get(&fixture.project_id, &task_id).expect("task");
    let tree_path = before.worktree.expect("worktree").path;

    let task =
        return_to_todo_core(&fixture.project_id, &fixture.project_path, &task_id).expect("return");

    assert_eq!(task.status, WorkTaskStatus::Todo);
    assert!(task.worktree.is_none());
    assert!(task.result_summary.is_none());
    assert!(task.changes.is_none());
    assert!(!Path::new(&tree_path).exists(), "worktree must be gone");
    assert!(
        !fixture.project_path.join("answer.md").exists(),
        "returned work must not have leaked into the checkout"
    );
}

/// The board reads the diff to decide whether "accept" is even offerable. A
/// worktree deleted behind the app's back must be reported as such rather than
/// silently showing an empty diff.
#[test]
fn a_vanished_worktree_is_reported_on_the_card_and_by_the_diff() {
    let fixture = fixture("vanished");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let task = store::get(&fixture.project_id, &task_id).expect("task");
    let tree = task.worktree.expect("worktree");
    // Removed outside Git, the way a user cleaning up temp files would.
    std::fs::remove_dir_all(&tree.path).expect("remove worktree");

    let listed = list_core(&fixture.project_id, &fixture.project_path);
    let card = listed.iter().find(|task| task.id == task_id).expect("card");
    assert!(
        card.worktree_missing,
        "the board must know the work is gone"
    );
    let error =
        engine::review_patch(&fixture.project_id, &task_id, None).expect_err("patch must fail");
    assert!(error.contains("gone from disk"), "unhelpful error: {error}");

    // The snapshot survives the checkout, because it describes what the run
    // produced rather than what is readable right now. Reporting "no changes"
    // here would invite the user to discard a result nobody ever inspected.
    let snapshot = engine::review_snapshot(&fixture.project_id, &task_id).expect("snapshot");
    assert_eq!(snapshot.files.len(), 1, "the recorded result must survive");

    // With no snapshot recorded at all, it says the work is unreadable rather
    // than that it does not exist.
    store::update(&fixture.project_id, &task_id, |task| {
        task.review_snapshot = None;
        Ok(())
    })
    .expect("clear snapshot");
    let blind = engine::review_snapshot(&fixture.project_id, &task_id).expect("snapshot");
    assert_eq!(
        blind.empty_reason,
        Some(WorkTaskEmptyReason::WorktreeMissing)
    );
}

/// Board order drives the launch queue, so a drag has to be durable and must
/// not disturb cards that were not part of it.
#[test]
fn reordering_rewrites_only_the_named_cards() {
    let fixture = fixture("reorder");
    let first =
        create_core(&fixture.project_id, "First".into(), String::new(), None).expect("create");
    let second =
        create_core(&fixture.project_id, "Second".into(), String::new(), None).expect("create");
    let third =
        create_core(&fixture.project_id, "Third".into(), String::new(), None).expect("create");

    reorder_core(&fixture.project_id, &[third.id.clone(), first.id.clone()]).expect("reorder");

    let ordered = store::list(&fixture.project_id)
        .into_iter()
        .map(|task| task.title)
        .collect::<Vec<_>>();
    assert_eq!(ordered[0], "Third");
    assert_eq!(ordered[1], "First");
    // The card that was not dragged keeps its original ordering key, so it
    // sorts after the two that were just renumbered from zero.
    assert_eq!(ordered[2], "Second");
    assert_eq!(
        store::get(&fixture.project_id, &second.id)
            .expect("task")
            .sort_order,
        second.sort_order
    );
}

/// Deleting takes the isolation with it, or the worktree is stranded with
/// nothing left on the board referencing it.
#[test]
fn deleting_a_task_also_removes_its_worktree() {
    let fixture = fixture("delete");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree_path = store::get(&fixture.project_id, &task_id)
        .expect("task")
        .worktree
        .expect("worktree")
        .path;

    delete_core(&fixture.project_id, &fixture.project_path, &task_id).expect("delete");

    assert!(store::get(&fixture.project_id, &task_id).is_none());
    assert!(!Path::new(&tree_path).exists());
}

/// Board columns render freshest-first, so a reorder must not hand the frontend
/// a set of timestamps that re-sorts the cards the user just arranged.
#[test]
fn reordering_does_not_invert_the_dragged_order_on_the_board() {
    let fixture = fixture("reorder-freshness");
    let first = create_core(&fixture.project_id, "First".into(), String::new(), None).unwrap();
    let second = create_core(&fixture.project_id, "Second".into(), String::new(), None).unwrap();
    let third = create_core(&fixture.project_id, "Third".into(), String::new(), None).unwrap();

    // The user drags them into this order.
    reorder_core(
        &fixture.project_id,
        &[third.id.clone(), first.id.clone(), second.id.clone()],
    )
    .expect("reorder");

    // The board sorts by `updatedAt` descending. Reordered cards must tie, so
    // the fallback is the sortOrder just written.
    let tasks = store::list(&fixture.project_id);
    let stamps = tasks.iter().map(|task| task.updated_at).collect::<Vec<_>>();
    assert_eq!(
        stamps
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        1,
        "a single drag must stamp one timestamp, got {stamps:?}"
    );
}
// ── Recovery from an interrupted process ─────────────────────────────────────

/// Put a task into the state a process that died mid-merge leaves behind.
fn stage_interrupted_merge(
    fixture: &Fixture,
    task_id: &str,
    tree: &crate::work_task::model::WorkTaskWorktree,
) {
    let base_head = worktree::resolve(&fixture.project_path, &tree.base_branch).expect("head");
    store::update(&fixture.project_id, task_id, |task| {
        task.status = WorkTaskStatus::Merging;
        task.merge_intent = Some(crate::work_task::model::WorkTaskMergeIntent {
            branch: tree.branch.clone(),
            base_branch: tree.base_branch.clone(),
            base_head,
            started_at: 0,
        });
        Ok(())
    })
    .expect("stage merging");
}

fn worktree_of(fixture: &Fixture, task_id: &str) -> crate::work_task::model::WorkTaskWorktree {
    store::get(&fixture.project_id, task_id)
        .expect("task")
        .worktree
        .expect("worktree")
}

/// A task that was mid-run when SomniQ closed must not sit in `running`
/// forever: that status blocks edit and delete, so the card would be stranded
/// with no way out at all.
///
/// It lands on `interrupted`, not `failed`: nothing went wrong with the work,
/// and saying "failed" would invite the user to throw away a checkout that is
/// intact and resumable.
#[test]
fn a_restart_interrupts_the_runs_that_did_not_survive_it() {
    let fixture = fixture("boot-interrupted");
    let running = create_core(&fixture.project_id, "Running".into(), String::new(), None).unwrap();
    let preparing =
        create_core(&fixture.project_id, "Preparing".into(), String::new(), None).unwrap();
    let asking = create_core(&fixture.project_id, "Asking".into(), String::new(), None).unwrap();
    let queued = create_core(&fixture.project_id, "Queued".into(), String::new(), None).unwrap();
    let review = seed_reviewable(&fixture, "Reviewed");
    store::update(&fixture.project_id, &asking.id, |task| {
        task.pending_action = Some(WorkTaskPendingAction::Question {
            tool_use_id: "toolu_dead".into(),
            header: None,
            question: "Which section?".into(),
            options: Vec::new(),
            asked_at: 1,
        });
        Ok(())
    })
    .expect("stage question");
    for (id, status) in [
        (&running.id, WorkTaskStatus::Running),
        (&preparing.id, WorkTaskStatus::Preparing),
        (&asking.id, WorkTaskStatus::AwaitingInput),
        (&queued.id, WorkTaskStatus::Queued),
    ] {
        store::update(&fixture.project_id, id, |task| {
            task.status = status;
            Ok(())
        })
        .expect("stage status");
    }

    engine::reconcile_projects(&fixture.project_id, &fixture.project_path);

    let status_of = |id: &str| store::get(&fixture.project_id, id).expect("task").status;
    assert_eq!(status_of(&running.id), WorkTaskStatus::Interrupted);
    assert_eq!(status_of(&preparing.id), WorkTaskStatus::Interrupted);
    assert_eq!(status_of(&asking.id), WorkTaskStatus::AwaitingInput);
    // Claiming is one atomic store update, so a queued row provably never
    // launched — failing it would throw away a queue the user lined up.
    assert_eq!(status_of(&queued.id), WorkTaskStatus::Queued);
    assert_eq!(status_of(&review), WorkTaskStatus::Review);

    let interrupted = store::get(&fixture.project_id, &running.id).expect("task");
    assert!(
        interrupted
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("resume")),
        "the card must say why and what to do: {:?}",
        interrupted.last_error
    );
    assert_eq!(
        interrupted.stop_reason,
        Some(WorkTaskStopReason::Shutdown),
        "the reason decides whether the checkout survives",
    );
    // The question is durable rather than wired to a dead in-memory channel,
    // so restarting the app must not throw it away.
    let recovered = store::get(&fixture.project_id, &asking.id).expect("task");
    assert!(recovered.pending_action.is_some());

    // Restartable, which is the whole point of interrupting rather than
    // leaving it — and it resumes rather than starting over.
    assert!(start_core(&fixture.project_id, &fixture.project_path, &running.id).is_ok());
}

/// Pausing keeps the task's checkout, and resuming continues into it rather
/// than cutting a fresh one.
///
/// The difference is the whole point of having `paused` at all: `worktree`'s
/// `create` deletes any leftover checkout for the task id, so a resume that
/// went through it would destroy exactly the work the user asked to keep.
#[test]
fn pausing_keeps_the_checkout_and_resuming_reuses_it() {
    let fixture = fixture("pause-resume");
    let task = create_core(
        &fixture.project_id,
        "Long job".into(),
        "keep going".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    std::fs::write(Path::new(&tree.path).join("draft.md"), "half done\n").expect("write");
    store::update(&fixture.project_id, &task.id, |staged| {
        staged.status = WorkTaskStatus::Running;
        staged.worktree = Some(tree.clone());
        staged.session_id = Some("work-task-session".into());
        Ok(())
    })
    .expect("stage run");

    // Nothing is listening (no live turn in a unit test), so the pause has to
    // finish its own handshake rather than leave the card at `pausing`.
    let paused = pause_core(&fixture.project_id, &task.id).expect("pause");
    assert_eq!(paused.status, WorkTaskStatus::Paused);
    assert_eq!(paused.stop_reason, Some(WorkTaskStopReason::Pause));
    assert!(
        Path::new(&tree.path).join("draft.md").is_file(),
        "a pause must not touch the half-finished work",
    );

    // Editable while paused: no turn is executing, so the card is the user's.
    update_core(
        &fixture.project_id,
        &task.id,
        Some("Long job, narrowed".into()),
        None,
        None,
    )
    .expect("a paused task is editable");

    let resumed =
        start_core(&fixture.project_id, &fixture.project_path, &task.id).expect("resume");
    assert_eq!(resumed.status, WorkTaskStatus::Queued);
    assert_eq!(
        resumed.worktree.as_ref().map(|tree| tree.path.clone()),
        Some(tree.path.clone()),
        "a resume continues in the same checkout",
    );
    assert_eq!(
        resumed.session_id.as_deref(),
        Some("work-task-session"),
        "a resume continues the same transcript",
    );
    assert_eq!(
        resumed.stop_reason, None,
        "the queued card must not still claim it is stopped",
    );
}

/// Only a live run can be paused. A queued card has nothing to wind down, and
/// offering a pause that silently does nothing is worse than refusing it.
#[test]
fn pausing_a_task_that_is_not_running_is_refused() {
    let fixture = fixture("pause-idle");
    let task = create_core(&fixture.project_id, "Idle".into(), String::new(), None).expect("create");
    let error = pause_core(&fixture.project_id, &task.id).expect_err("must refuse");
    assert!(error.contains("todo"), "the error must say why: {error}");

    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::Queued;
        Ok(())
    })
    .expect("queue");
    assert!(pause_core(&fixture.project_id, &task.id).is_err());
    assert_eq!(
        store::get(&fixture.project_id, &task.id)
            .expect("task")
            .status,
        WorkTaskStatus::Queued,
        "a refused pause must leave the card where it was",
    );

    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::AwaitingInput;
        task.pending_action = Some(WorkTaskPendingAction::Question {
            tool_use_id: "toolu_1".into(),
            header: None,
            question: "Which section?".into(),
            options: Vec::new(),
            asked_at: 1,
        });
        Ok(())
    })
    .expect("park question");
    assert!(pause_core(&fixture.project_id, &task.id).is_err());
}

#[test]
fn answering_a_question_queues_a_new_turn_without_a_live_channel() {
    let fixture = fixture("question-reply");
    let task = create_core(
        &fixture.project_id,
        "Choose scope".into(),
        "Rewrite the paper".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    store::update(&fixture.project_id, &task.id, |task| {
        task.status = WorkTaskStatus::AwaitingInput;
        task.worktree = Some(tree.clone());
        task.session_id = Some("work-task-question".into());
        task.pending_action = Some(WorkTaskPendingAction::Question {
            tool_use_id: "toolu_1".into(),
            header: Some("Scope".into()),
            question: "Rewrite section 3 or the whole paper?".into(),
            options: vec!["Section 3".into(), "Whole paper".into()],
            asked_at: 1,
        });
        task.last_heartbeat_at = None;
        Ok(())
    })
    .expect("park question");

    let queued = reply_core(&fixture.project_id, &task.id, "Section 3").expect("reply");
    assert_eq!(queued.status, WorkTaskStatus::Queued);
    assert!(queued.pending_action.is_none());
    assert!(queued.last_heartbeat_at.is_none());
    let context = queued.resume_context.as_deref().expect("continuation context");
    assert!(context.contains("Rewrite section 3 or the whole paper?"));
    assert!(context.contains("Section 3"));
    assert_eq!(queued.session_id.as_deref(), Some("work-task-question"));
    assert_eq!(queued.worktree.as_ref().map(|tree| tree.path.as_str()), Some(tree.path.as_str()));
    assert!(Path::new(&tree.path).is_dir());
}

/// A cancel still discards the checkout, even though it now travels through
/// the same stop handshake as a pause. Getting this wrong would leave a
/// worktree and a branch nothing references after every Stop.
#[test]
fn cancelling_still_discards_the_checkout_that_a_pause_would_keep() {
    let fixture = fixture("cancel-discards");
    let task_id = seed_reviewable(&fixture, "Throw away");
    let tree = worktree_of(&fixture, &task_id);
    store::update(&fixture.project_id, &task_id, |task| {
        task.status = WorkTaskStatus::Running;
        Ok(())
    })
    .expect("stage run");

    let canceled =
        cancel_core(&fixture.project_id, &fixture.project_path, &task_id).expect("cancel");
    assert_eq!(canceled.status, WorkTaskStatus::Canceled);
    assert_eq!(canceled.stop_reason, Some(WorkTaskStopReason::Cancel));
    assert!(canceled.worktree.is_none());
    assert!(!Path::new(&tree.path).is_dir(), "the checkout must be gone");
}

/// The board discards change events at or below the revision it already holds,
/// so a revision that repeats loses a real change and one that jumps backwards
/// loses every change in between.
#[test]
fn the_snapshot_revision_advances_with_every_write() {
    let fixture = fixture("revision");
    let empty = snapshot_core(&fixture.project_id, &fixture.project_path);
    assert_eq!(empty.revision, 0);
    assert!(empty.tasks.is_empty());

    let task =
        create_core(&fixture.project_id, "One".into(), String::new(), None).expect("create");
    let after_create = snapshot_core(&fixture.project_id, &fixture.project_path);
    assert_eq!(after_create.revision, 1);
    assert_eq!(after_create.tasks.len(), 1);

    update_core(
        &fixture.project_id,
        &task.id,
        Some("One, renamed".into()),
        None,
        None,
    )
    .expect("rename");
    let after_update = snapshot_core(&fixture.project_id, &fixture.project_path);
    assert_eq!(after_update.revision, 2);

    delete_core(&fixture.project_id, &fixture.project_path, &task.id).expect("delete");
    let after_delete = snapshot_core(&fixture.project_id, &fixture.project_path);
    assert_eq!(after_delete.revision, 3);
    assert!(after_delete.tasks.is_empty());

    // And it is the same number the change event carries, so an event emitted
    // right after a write cannot be mistaken for one the board already has.
    assert_eq!(engine::current_revision_for_test(&fixture.project_id), 3);
}

/// A task that changed nothing and a task whose result cannot be read are not
/// the same thing, and the board used to render both as "no changes were
/// produced" — which reads as "your task did nothing" in a case where the work
/// may be sitting right there, unreadable.
#[test]
fn an_empty_result_says_which_kind_of_empty_it_is() {
    let fixture = fixture("empty-reason");
    let task = create_core(
        &fixture.project_id,
        "Just read things".into(),
        String::new(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    // A run that touched nothing: the model read the repository and answered
    // in the transcript.
    store::update(&fixture.project_id, &task.id, |current| {
        current.worktree = Some(tree.clone());
        current.status = WorkTaskStatus::Review;
        Ok(())
    })
    .expect("stage review");

    let snapshot =
        engine::review_snapshot(&fixture.project_id, &task.id).expect("review snapshot");
    assert!(snapshot.files.is_empty());
    assert_eq!(
        snapshot.empty_reason,
        Some(WorkTaskEmptyReason::NoRepositoryChanges),
        "a deliberate no-op is not the same as an unreadable result",
    );
    assert!(!snapshot.base_sha.is_empty());

    // A card that never had a checkout produced nothing at all.
    let never_ran =
        create_core(&fixture.project_id, "Never ran".into(), String::new(), None).expect("create");
    assert_eq!(
        engine::review_snapshot(&fixture.project_id, &never_ran.id)
            .expect("snapshot")
            .empty_reason,
        Some(WorkTaskEmptyReason::NothingProduced),
    );
}

/// The shape PR 4 exists to fix: a task asked to write a report produced
/// something real, but it could only be obtained by merging a commit into the
/// user's repository. Deliverables now leave through the artifact store, and
/// the diff stays empty — correctly, and with a reason that says so.
#[test]
fn standalone_deliverables_leave_through_the_store_not_the_repository() {
    let fixture = fixture("artifacts");
    let task = create_core(
        &fixture.project_id,
        "Write the report".into(),
        String::new(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    let tree_path = Path::new(&tree.path);

    let staging = tools::layout::task_output_dir_at(tree_path);
    std::fs::create_dir_all(&staging).expect("staging");
    std::fs::write(staging.join("report.pdf"), b"%PDF-1.7\x00 report\n").expect("report");

    worktree::commit_all(tree_path, "task: report", &tree.base_sha).expect("commit");
    // Nothing staged for the branch: the deliverable is not a repository
    // change and must not become one.
    let files = worktree::review_files(tree_path, &tree.base_sha, "HEAD").expect("files");
    assert!(
        files.is_empty(),
        "a deliverable must not be committed: {files:?}"
    );
    assert!(
        !fixture.project_path.join(".somniq/task-output").exists(),
        "the staging directory must not reach the user's checkout",
    );

    let artifacts = crate::work_task::artifacts::import(&fixture.project_id, &task.id, tree_path)
        .expect("import");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].title, "report.pdf");

    store::update(&fixture.project_id, &task.id, |current| {
        current.worktree = Some(tree.clone());
        current.status = WorkTaskStatus::Review;
        Ok(())
    })
    .expect("stage review");

    let snapshot =
        engine::review_snapshot(&fixture.project_id, &task.id).expect("review snapshot");
    assert!(snapshot.files.is_empty());
    assert_eq!(snapshot.artifacts.len(), 1);
    assert_eq!(
        snapshot.empty_reason,
        Some(WorkTaskEmptyReason::ArtifactsOnly),
        "an empty diff beside a real deliverable is not 'nothing was produced'",
    );

    // Exporting is how it leaves SomniQ, and the card records where it went.
    let destination = fixture._temp.path().join("Desktop/Report.pdf");
    let exported = artifact_export_core(
        &fixture.project_id,
        &task.id,
        &snapshot.artifacts[0].id,
        &destination.to_string_lossy(),
    )
    .expect("export");
    assert_eq!(
        std::fs::read(&destination).expect("read"),
        b"%PDF-1.7\x00 report\n"
    );
    assert_eq!(
        exported.review_snapshot.expect("snapshot").artifacts[0]
            .exported_path
            .as_deref(),
        Some(destination.to_string_lossy().as_ref()),
    );

    // And deleting the card collects the deliverables, which nothing else
    // would — they live outside the repository.
    let managed = PathBuf::from(&snapshot.artifacts[0].managed_path);
    assert!(managed.is_file());
    delete_core(&fixture.project_id, &fixture.project_path, &task.id).expect("delete");
    assert!(!managed.exists(), "the store entry must go with the card");
    // The user's own export is theirs and is left alone.
    assert!(destination.is_file());
}

/// Re-running a card must not leave the previous attempt's result on it.
///
/// The visible failure this pins: a task passes review, the user sends it back
/// for another go, and the new run fails — the card would still have shown the
/// old run's file counts and "passed independent review", both of which are
/// claims about work that is no longer on the branch.
#[test]
fn restarting_a_task_drops_the_previous_attempts_result() {
    let fixture = fixture("stale-result");
    let task_id = seed_reviewable(&fixture, "Rewrite section 3");
    store::update(&fixture.project_id, &task_id, |task| {
        task.review_state = Some(crate::work_task::model::WorkTaskReviewState {
            round: 1,
            max_rounds: 2,
            verdict: crate::work_task::model::WorkTaskVerdict::Pass,
            summary: "Looks right.".into(),
            issues: Vec::new(),
            reviewer_model: "reviewer".into(),
            exhausted: false,
            checked_at: 1,
        });
        Ok(())
    })
    .expect("stage a passed review");

    // Straight from review back to the queue, the way a retry does.
    store::update(&fixture.project_id, &task_id, |task| {
        task.status = WorkTaskStatus::Failed;
        Ok(())
    })
    .expect("stage failed");
    let restarted =
        start_core(&fixture.project_id, &fixture.project_path, &task_id).expect("restart");

    assert_eq!(restarted.status, WorkTaskStatus::Queued);
    assert!(restarted.changes.is_none(), "stale file counts survived");
    assert!(restarted.result_summary.is_none());
    assert!(restarted.review_snapshot.is_none());
    assert!(
        restarted.review_state.is_none(),
        "a verdict about the previous attempt survived into the next one",
    );
    // But the checkout and transcript stay, because this is a resume.
    assert!(restarted.worktree.is_some());
}

/// A scheduled automation produces an ordinary work task, so it gets the same
/// isolation, review and recovery as one the user made by hand — rather than
/// the old path, which ran the model straight against the user's checkout with
/// `lastRunAt` as its only trace.
#[test]
fn a_scheduled_firing_becomes_an_ordinary_queued_task() {
    let fixture = fixture("scheduled");
    let queued = queue_scheduled_run(
        &fixture.project_id,
        &fixture.project_path,
        "automation-1",
        "Nightly literature sweep".into(),
        "Update the library.".into(),
        None,
    )
    .expect("queue");

    assert_eq!(queued.status, WorkTaskStatus::Queued);
    assert_eq!(queued.title, "Nightly literature sweep");
    assert_eq!(queued.scheduled_task_id.as_deref(), Some("automation-1"));

    // A second firing while the first is still going is skipped, not stacked:
    // two runs editing the same branch is the failure a short interval would
    // otherwise produce every night.
    store::update(&fixture.project_id, &queued.id, |task| {
        task.status = WorkTaskStatus::Running;
        Ok(())
    })
    .expect("stage running");
    let error = queue_scheduled_run(
        &fixture.project_id,
        &fixture.project_path,
        "automation-1",
        "Nightly literature sweep".into(),
        "Update the library.".into(),
        None,
    )
    .expect_err("must skip");
    assert!(error.contains("still running"), "unhelpful error: {error}");

    // A different automation is unaffected, and so is the same one once its
    // previous run has settled.
    queue_scheduled_run(
        &fixture.project_id,
        &fixture.project_path,
        "automation-2",
        "Other".into(),
        "Do the other thing.".into(),
        None,
    )
    .expect("a different automation may run");
    store::update(&fixture.project_id, &queued.id, |task| {
        task.status = WorkTaskStatus::Review;
        Ok(())
    })
    .expect("settle");
    queue_scheduled_run(
        &fixture.project_id,
        &fixture.project_path,
        "automation-1",
        "Nightly literature sweep".into(),
        "Update the library.".into(),
        None,
    )
    .expect("the next firing runs once the previous one has settled");
}

/// A rename is not a delete plus an add, and a reviewer told it was would
/// think content was thrown away and rewritten.
#[test]
fn a_renamed_file_is_reported_as_a_rename_with_its_old_path() {
    let fixture = fixture("rename");
    // The file has to exist in the commit the task was cut from. A file
    // created and then moved inside the task is just an add, and Git is right
    // to say so.
    let task_id = seed_reviewable(&fixture, "Move the readme");
    let tree = worktree_of(&fixture, &task_id);
    let tree_path = Path::new(&tree.path);

    git(tree_path, &["mv", "README.md", "docs-readme.md"]);
    worktree::commit_all(tree_path, "task: rename", &tree.base_sha).expect("commit");
    store::update(&fixture.project_id, &task_id, |task| {
        task.review_snapshot = None;
        Ok(())
    })
    .expect("force a fresh snapshot");

    let snapshot = engine::review_snapshot(&fixture.project_id, &task_id).expect("snapshot");
    let renamed = snapshot
        .files
        .iter()
        .find(|file| file.path == "docs-readme.md")
        .expect("the destination must be listed");
    assert_eq!(renamed.change_kind, WorkTaskFileChangeKind::Renamed);
    assert_eq!(renamed.previous_path.as_deref(), Some("README.md"));
    assert!(
        !snapshot.files.iter().any(|file| file.path == "README.md"),
        "the old path must not also appear as a deletion: {:?}",
        snapshot.files,
    );
}

/// A merge interrupted AFTER it landed must finish as done — reporting it as
/// unmerged would invite a second merge of work already on the branch.
#[test]
fn a_merge_that_had_already_landed_is_recovered_as_done() {
    let fixture = fixture("boot-merge-landed");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree = worktree_of(&fixture, &task_id);

    // The world as it looks if the process died right after stage B.
    git(
        &fixture.project_path,
        &["merge", "--no-ff", "--no-edit", &tree.branch],
    );
    stage_interrupted_merge(&fixture, &task_id, &tree);

    engine::reconcile_projects(&fixture.project_id, &fixture.project_path);

    let task = store::get(&fixture.project_id, &task_id).expect("task");
    assert_eq!(task.status, WorkTaskStatus::Done);
    assert!(
        task.merge_commit.is_some(),
        "a landed merge records its commit"
    );
    assert!(task.merge_intent.is_none(), "the intent must be cleared");
    assert!(fixture.project_path.join("answer.md").is_file());
}

/// A merge interrupted BEFORE it landed goes back to review, so the user can
/// simply accept again.
#[test]
fn a_merge_that_never_landed_is_recovered_back_to_review() {
    let fixture = fixture("boot-merge-lost");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree = worktree_of(&fixture, &task_id);
    stage_interrupted_merge(&fixture, &task_id, &tree);

    engine::reconcile_projects(&fixture.project_id, &fixture.project_path);

    let task = store::get(&fixture.project_id, &task_id).expect("task");
    assert_eq!(task.status, WorkTaskStatus::Review);
    assert!(task.merge_intent.is_none());
    assert!(task.merge_commit.is_none(), "nothing landed, so no commit");
    assert!(
        !fixture.project_path.join("answer.md").exists(),
        "the base branch must be untouched"
    );
    // And the recovered card is acceptable again.
    let done = engine::accept(&fixture.project_id, &fixture.project_path, &task_id)
        .expect("second attempt");
    assert_eq!(done.status, WorkTaskStatus::Done);
}

/// A `merging` row with no recorded intent was interrupted before any Git
/// command ran. It must still be resolved: a merging card cannot be cancelled
/// by the user, so an unresolved one is a dead card.
#[test]
fn a_merging_row_without_an_intent_is_still_given_a_way_out() {
    let fixture = fixture("boot-merge-no-intent");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    store::update(&fixture.project_id, &task_id, |task| {
        task.status = WorkTaskStatus::Merging;
        task.merge_intent = None;
        Ok(())
    })
    .expect("stage merging");

    engine::reconcile_projects(&fixture.project_id, &fixture.project_path);

    assert_eq!(
        store::get(&fixture.project_id, &task_id)
            .expect("task")
            .status,
        WorkTaskStatus::Review
    );
}

/// The live merge path records its intent before touching Git, which is the
/// only thing that makes the recovery above possible.
#[test]
fn a_merge_records_what_it_is_about_to_do_before_doing_it() {
    let fixture = fixture("merge-intent");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree = worktree_of(&fixture, &task_id);

    let done =
        engine::accept(&fixture.project_id, &fixture.project_path, &task_id).expect("accept");
    // Cleared on the way out, so a leftover intent always means "interrupted".
    assert!(done.merge_intent.is_none());

    // The refusal path clears it too, or every later boot would try to recover
    // a merge that already resolved.
    let second = seed_reviewable(&fixture, "Another");
    git(&fixture.project_path, &["checkout", "-b", "elsewhere"]);
    let _ = engine::accept(&fixture.project_id, &fixture.project_path, &second);
    let task = store::get(&fixture.project_id, &second).expect("task");
    assert_eq!(task.status, WorkTaskStatus::Review);
    assert!(task.merge_intent.is_none());
    drop(tree);
}

// ── Cancelled worktrees ──────────────────────────────────────────────────────

/// A cancel with nothing listening is the end of the line for that card, so its
/// checkout is released here or never.
#[test]
fn cancelling_an_idle_task_releases_its_worktree() {
    let fixture = fixture("cancel-idle");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree_path = worktree_of(&fixture, &task_id).path;

    let cancelled =
        cancel_core(&fixture.project_id, &fixture.project_path, &task_id).expect("cancel");

    assert_eq!(cancelled.status, WorkTaskStatus::Canceled);
    assert!(
        cancelled.worktree.is_none(),
        "the record must be cleared too"
    );
    assert!(!Path::new(&tree_path).exists(), "the checkout must be gone");
}

/// While a turn is running, the worktree is the directory it is working in.
/// Cancelling must not pull it out from under the turn — teardown waits for the
/// run to wind down.
#[test]
fn cancelling_a_live_task_leaves_its_worktree_for_the_run_to_release() {
    let fixture = fixture("cancel-live");
    let task_id = seed_reviewable(&fixture, "Write the answer");
    let tree_path = worktree_of(&fixture, &task_id).path;
    // Stand in for a live run: something is listening for the cancel.
    let flag = engine::register_cancel_for_test(&task_id);

    cancel_core(&fixture.project_id, &fixture.project_path, &task_id).expect("cancel");

    assert!(
        flag.load(std::sync::atomic::Ordering::SeqCst),
        "the run must be signalled"
    );
    assert!(
        Path::new(&tree_path).exists(),
        "a live run's directory must not be removed underneath it"
    );

    // Once the run winds down it releases the checkout.
    engine::release_cancelled_worktree_for_test(
        &fixture.project_id,
        &fixture.project_path,
        &task_id,
    );
    assert!(!Path::new(&tree_path).exists());
    assert!(store::get(&fixture.project_id, &task_id)
        .expect("task")
        .worktree
        .is_none());
}
/// Two accepted tasks land on the same base branch, and stage B is a
/// fast-forward that is only guaranteed to be one while nothing else moves the
/// branch underneath it. With the concurrency ceiling at two, accepting both
/// cards in quick succession is an ordinary thing to do.
///
/// Serialized, the second merge simply sees the first one's result as its new
/// base and lands on top. Unserialized, the two `merge --ff-only` calls race
/// for the same branch and at least one of them cannot be a fast-forward.
#[test]
fn two_tasks_accepted_at_once_both_land() {
    let fixture = fixture("merge-race");
    // Different files, so nothing here depends on conflict handling — the only
    // thing under test is that the two merges do not overlap.
    let first = seed_reviewable_with(&fixture, "First", "first.md");
    let second = seed_reviewable_with(&fixture, "Second", "second.md");

    let project_id = fixture.project_id.clone();
    let project_path = fixture.project_path.clone();
    let outcomes = std::thread::scope(|scope| {
        let left = scope.spawn(|| engine::accept(&project_id, &project_path, &first));
        let right = scope.spawn(|| engine::accept(&project_id, &project_path, &second));
        (
            left.join().expect("left thread"),
            right.join().expect("right thread"),
        )
    });

    assert!(
        outcomes.0.is_ok() && outcomes.1.is_ok(),
        "both merges must land: {:?} / {:?}",
        outcomes.0.as_ref().err(),
        outcomes.1.as_ref().err()
    );
    assert!(fixture.project_path.join("first.md").is_file());
    assert!(fixture.project_path.join("second.md").is_file());
    for id in [&first, &second] {
        let task = store::get(&fixture.project_id, id).expect("task");
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert!(task.merge_commit.is_some());
    }
    // And the repository is left clean, not mid-merge.
    let status = crate::process::hidden_command("git")
        .current_dir(&fixture.project_path)
        .args(["status", "--porcelain"])
        .output()
        .expect("status");
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the project checkout must not be left dirty"
    );
}

/// [`seed_reviewable`] with the produced file named, so two tasks can be staged
/// without colliding on the same path.
fn seed_reviewable_with(fixture: &Fixture, title: &str, file_name: &str) -> String {
    let task = create_core(
        &fixture.project_id,
        title.into(),
        "do the thing".into(),
        None,
    )
    .expect("create");
    let tree =
        worktree::create(&fixture.project_path, &fixture.project_id, &task.id).expect("worktree");
    std::fs::write(Path::new(&tree.path).join(file_name), "content\n").expect("write");
    worktree::commit_all(Path::new(&tree.path), "task: work", &tree.base_sha).expect("commit");
    let snapshot =
        engine::capture_snapshot(Path::new(&tree.path), &tree.base_sha).expect("snapshot");
    store::update(&fixture.project_id, &task.id, |task| {
        task.worktree = Some(tree.clone());
        task.status = WorkTaskStatus::Review;
        task.changes = Some(snapshot.changes());
        task.review_snapshot = Some(snapshot.clone());
        Ok(())
    })
    .expect("stage review");
    task.id
}
