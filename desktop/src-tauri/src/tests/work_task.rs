//! Work-task board rules.
//!
//! The store resolves through `ARIS_CONFIG_ROOT`, which is process-global, so
//! every test here holds `crate::test_env_lock()` for its body. Without that a
//! parallel test would write into whichever fixture happened to be installed —
//! or, with the variable unset, into the developer's real config directory.

use std::path::{Path, PathBuf};

use super::{
    cancel_core, create_core, delete_core, list_core, reorder_core, return_to_todo_core,
    start_core, update_core,
};
use crate::work_task::engine;
use crate::work_task::model::WorkTaskStatus;
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
    let changes =
        worktree::changes_against_base(Path::new(&tree.path), &tree.base_sha).expect("changes");
    store::update(&fixture.project_id, &task.id, |task| {
        task.worktree = Some(tree.clone());
        task.status = WorkTaskStatus::Review;
        task.changes = Some(changes.clone());
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

    let patch = engine::diff(&fixture.project_id, &task.id).expect("diff");
    assert!(patch.contains(".somniq/papers/survey/main.tex"));
    assert!(!patch.contains(".somniq/tmp/tool-output/call.log"));
    let repaired = store::get(&fixture.project_id, &task.id).expect("task");
    assert_eq!(repaired.changes.expect("changes").files_changed, 1);

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
    let error = engine::diff(&fixture.project_id, &task_id).expect_err("diff must fail");
    assert!(error.contains("gone from disk"), "unhelpful error: {error}");
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
#[test]
fn a_restart_fails_the_runs_that_did_not_survive_it() {
    let fixture = fixture("boot-interrupted");
    let running = create_core(&fixture.project_id, "Running".into(), String::new(), None).unwrap();
    let preparing =
        create_core(&fixture.project_id, "Preparing".into(), String::new(), None).unwrap();
    let queued = create_core(&fixture.project_id, "Queued".into(), String::new(), None).unwrap();
    let review = seed_reviewable(&fixture, "Reviewed");
    for (id, status) in [
        (&running.id, WorkTaskStatus::Running),
        (&preparing.id, WorkTaskStatus::Preparing),
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
    assert_eq!(status_of(&running.id), WorkTaskStatus::Failed);
    assert_eq!(status_of(&preparing.id), WorkTaskStatus::Failed);
    // Claiming is one atomic store update, so a queued row provably never
    // launched — failing it would throw away a queue the user lined up.
    assert_eq!(status_of(&queued.id), WorkTaskStatus::Queued);
    assert_eq!(status_of(&review), WorkTaskStatus::Review);

    let failed = store::get(&fixture.project_id, &running.id).expect("task");
    assert!(
        failed
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("interrupted")),
        "the card must say why: {:?}",
        failed.last_error
    );
    // Restartable, which is the whole point of failing rather than leaving it.
    assert!(start_core(&fixture.project_id, &fixture.project_path, &running.id).is_ok());
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
    let changes =
        worktree::changes_against_base(Path::new(&tree.path), &tree.base_sha).expect("changes");
    store::update(&fixture.project_id, &task.id, |task| {
        task.worktree = Some(tree.clone());
        task.status = WorkTaskStatus::Review;
        task.changes = Some(changes.clone());
        Ok(())
    })
    .expect("stage review");
    task.id
}
