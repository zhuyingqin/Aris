use super::*;
use crate::conversation::{
    ApiClient, ApiRequest, AssistantEvent, ConversationRuntime, RuntimeError, StaticToolExecutor,
};
use crate::permissions::{PermissionMode, PermissionPolicy};
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

// ---- fixtures ---------------------------------------------------------------

#[derive(Clone, Debug)]
struct Recorded {
    session_id: String,
    kind: String,
    payload: Value,
}

type Log = Arc<Mutex<Vec<Recorded>>>;

fn recorder(log: &Log) -> AgentEventRecorder {
    let log = Arc::clone(log);
    Arc::new(move |session_id, kind, payload| {
        log.lock().unwrap().push(Recorded {
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            payload,
        });
    })
}

fn recorded(log: &Log, kind: &str) -> Vec<Recorded> {
    log.lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == kind)
        .cloned()
        .collect()
}

struct Harness {
    dir: tempfile::TempDir,
    log: Log,
    control: AgentControl,
    root: AgentHandle,
}

impl Harness {
    fn new() -> Self {
        Self::with(|_| {})
    }

    fn with(configure: impl FnOnce(&mut AgentControlConfig)) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let log = Log::default();
        let mut config = AgentControlConfig::new(dir.path().join("agents"));
        configure(&mut config);
        let control = AgentControl::open(config, recorder(&log)).expect("open");
        let root = control
            .register_root("chat-root", Some("project-1"))
            .expect("root");
        Self {
            dir,
            log,
            control,
            root,
        }
    }

    fn agents_dir(&self) -> PathBuf {
        self.dir.path().join("agents")
    }

    /// Reopen the same project directory as a new process would. The process
    /// that ran `self.control` is gone, and the operating system took its
    /// ownership lock with it.
    fn reopen(&self) -> (AgentControl, Log) {
        self.control.release_owner_lock();
        let log = Log::default();
        let control =
            AgentControl::open(AgentControlConfig::new(self.agents_dir()), recorder(&log))
                .expect("reopen");
        (control, log)
    }
}

fn spawn_request(parent: &str, name: &str) -> SpawnRequest {
    SpawnRequest {
        parent_session_id: parent.to_string(),
        name: name.to_string(),
        role: "scout".to_string(),
        origin: SpawnOrigin::Model,
        spawn_ref: Some("toolu_7".to_string()),
        parent_turn_id: Some("turn-parent".to_string()),
    }
}

fn controller_request(parent: &str, name: &str) -> SpawnRequest {
    SpawnRequest {
        role: "reviewer".to_string(),
        origin: SpawnOrigin::Controller,
        spawn_ref: Some("action-1".to_string()),
        ..spawn_request(parent, name)
    }
}

fn scout(control: &AgentControl, parent: &str, name: &str) -> AgentHandle {
    control
        .spawn(spawn_request(parent, name))
        .unwrap_or_else(|error| panic!("spawn {name}: {error}"))
}

fn send(
    control: &AgentControl,
    author: &str,
    target: &str,
    kind: MailKind,
    content: &str,
) -> Result<MailReceipt, AgentControlError> {
    control.send(SendRequest {
        author_session_id: author.to_string(),
        target: target.to_string(),
        kind,
        content: content.to_string(),
        trigger_turn: false,
        cause: MailCause::default(),
    })
}

fn controller_mail(
    control: &AgentControl,
    author: &str,
    recipient: &str,
    kind: MailKind,
    content: &str,
) -> Result<MailReceipt, AgentControlError> {
    control.deliver(ControllerMail {
        author_session_id: author.to_string(),
        recipient: AgentPath::parse(recipient).unwrap(),
        kind,
        content: content.to_string(),
        trigger_turn: false,
        cause: MailCause::default(),
    })
}

fn path(text: &str) -> AgentPath {
    AgentPath::parse(text).unwrap_or_else(|error| panic!("{text}: {error}"))
}

// ---- paths ------------------------------------------------------------------

#[test]
fn paths_parse_only_well_formed_absolute_names() {
    for good in [
        "/root",
        "/root/a",
        "/root/a_1/b2",
        "/root/~reviewer",
        "/root/~reviewer/~fork_1",
    ] {
        assert!(AgentPath::parse(good).is_ok(), "{good} should parse");
    }
    let too_long = format!("/root/{}", "a".repeat(33));
    for bad in [
        "",
        "root",
        "/",
        "/root/",
        "/rootx",
        "/root//a",
        "/root/A",
        "/root/a-b",
        "/root/a b",
        "/root/root",
        "/root/~root",
        "/root/~",
        "/root/a/",
        "/other/a",
        too_long.as_str(),
    ] {
        assert!(AgentPath::parse(bad).is_err(), "{bad:?} should not parse");
    }
}

#[test]
fn path_structure_is_readable_without_string_surgery() {
    let nested = path("/root/a/b");
    assert_eq!(nested.depth(), 2);
    assert_eq!(nested.name(), "b");
    assert_eq!(nested.parent(), Some(path("/root/a")));
    assert_eq!(AgentPath::root().parent(), None);
    assert_eq!(AgentPath::root().depth(), 0);
    assert!(nested.is_within(&path("/root/a")));
    assert!(nested.is_within(&AgentPath::root()));
    assert!(nested.is_within(&nested));
    assert!(
        !path("/root/ab").is_within(&path("/root/a")),
        "a shared prefix is not a shared ancestor"
    );
    assert!(!path("/root/a").is_reserved());
    assert!(path("/root/~reviewer").is_reserved());
    assert!(
        path("/root/~reviewer/fork").is_reserved(),
        "everything below a reserved agent is reserved"
    );
}

#[test]
fn a_name_a_model_chooses_can_never_be_reserved() {
    let root = AgentPath::root();
    assert_eq!(
        root.join("~reviewer"),
        Err(AgentControlError::ReservedName("~reviewer".to_string()))
    );
    assert!(matches!(
        root.join("Reviewer"),
        Err(AgentControlError::InvalidName(_))
    ));
    assert_eq!(root.join("scout_1"), Ok(path("/root/scout_1")));
    assert_eq!(root.join_reserved("~reviewer"), Ok(path("/root/~reviewer")));
    assert!(matches!(
        root.join_reserved("reviewer"),
        Err(AgentControlError::InvalidName(_))
    ));
}

#[test]
fn a_reference_is_a_name_below_the_author_or_an_absolute_path() {
    let scout = path("/root/scout_1");
    assert_eq!(
        scout.resolve_reference("helper"),
        Ok(path("/root/scout_1/helper"))
    );
    assert_eq!(
        scout.resolve_reference("/root/other"),
        Ok(path("/root/other"))
    );
    assert_eq!(scout.resolve_reference("  /root  "), Ok(AgentPath::root()));
    assert!(scout.resolve_reference("").is_err());
    assert!(scout.resolve_reference("../x").is_err());
    assert!(scout.resolve_reference("/elsewhere").is_err());
}

// ---- spawning and capacity ---------------------------------------------------

#[test]
fn a_child_hangs_below_its_parent_with_its_lineage_recorded() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");

    assert_eq!(child.path, path("/root/scout_1"));
    assert_eq!(child.root_session_id, "chat-root");
    let info = harness.control.info(&child.session_id).expect("info");
    assert_eq!(info.parent_session_id.as_deref(), Some("chat-root"));
    assert_eq!(info.role, "scout");
    assert_eq!(info.depth, 1);
    assert_eq!(info.origin, SpawnOrigin::Model);
    assert_eq!(info.status, AgentStatus::PendingInit);

    let lineage = recorded(&harness.log, EVENT_AGENT_LINEAGE)
        .pop()
        .expect("lineage event");
    assert_eq!(lineage.session_id, child.session_id);
    assert_eq!(lineage.payload["parentSessionId"], json!("chat-root"));
    assert_eq!(lineage.payload["parentTurnId"], json!("turn-parent"));
    assert_eq!(lineage.payload["spawnRef"], json!("toolu_7"));
    assert_eq!(lineage.payload["projectId"], json!("project-1"));
    assert_eq!(lineage.payload["path"], json!("/root/scout_1"));
}

#[test]
fn a_root_registers_once_and_a_sub_agent_cannot_pose_as_one() {
    let harness = Harness::new();
    let again = harness
        .control
        .register_root("chat-root", None)
        .expect("same root again");
    assert_eq!(again.session_id, harness.root.session_id);

    let child = scout(&harness.control, "chat-root", "scout_1");
    assert!(matches!(
        harness.control.register_root(&child.session_id, None),
        Err(AgentControlError::NotPermitted(_))
    ));
    assert!(matches!(
        harness.control.register_root("../escape", None),
        Err(AgentControlError::InvalidName(_))
    ));
}

#[test]
fn children_beyond_the_thread_limit_are_refused_until_one_is_closed() {
    let harness = Harness::new();
    let handles = (1..=DEFAULT_MAX_THREADS)
        .map(|n| scout(&harness.control, "chat-root", &format!("scout_{n}")))
        .collect::<Vec<_>>();

    let refused = harness
        .control
        .spawn(spawn_request("chat-root", "one_too_many"));
    assert_eq!(
        refused.unwrap_err(),
        AgentControlError::CapacityReached {
            max_threads: DEFAULT_MAX_THREADS
        }
    );

    harness
        .control
        .close(&handles[0].session_id, "finished")
        .expect("close");
    assert!(
        harness
            .control
            .spawn(spawn_request("chat-root", "one_too_many"))
            .is_ok(),
        "a closed agent's slot is reusable"
    );
}

#[test]
fn a_dropped_reservation_gives_back_its_slot_and_its_name() {
    let harness = Harness::new();
    let held = (1..=DEFAULT_MAX_THREADS)
        .map(|n| {
            harness
                .control
                .reserve(spawn_request("chat-root", &format!("scout_{n}")))
                .expect("reserve")
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        harness.control.reserve(spawn_request("chat-root", "late")),
        Err(AgentControlError::CapacityReached { .. })
    ));
    assert!(
        matches!(
            harness
                .control
                .reserve(spawn_request("chat-root", "scout_1")),
            Err(AgentControlError::NameInUse(_) | AgentControlError::CapacityReached { .. })
        ),
        "a promised name is taken too"
    );

    let mut held = held.into_iter();
    drop(held.next());

    let reservation = harness
        .control
        .reserve(spawn_request("chat-root", "scout_1"))
        .expect("the dropped reservation's slot and name are free again");
    assert_eq!(reservation.path(), &path("/root/scout_1"));
    assert!(
        harness.control.info("nothing-committed-yet").is_none(),
        "a reservation is not an agent"
    );
    drop(held);
    drop(reservation);
    assert!(harness
        .control
        .spawn(spawn_request("chat-root", "scout_1"))
        .is_ok());
}

#[test]
fn nesting_is_limited_by_depth() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    assert_eq!(
        harness
            .control
            .spawn(spawn_request(&child.session_id, "grandchild"))
            .unwrap_err(),
        AgentControlError::DepthLimit {
            max_depth: DEFAULT_MAX_DEPTH
        },
        "a sub-agent does not start sub-agents of its own by default"
    );

    let deeper = Harness::with(|config| config.max_depth = 2);
    let child = scout(&deeper.control, "chat-root", "scout_1");
    let grandchild = scout(&deeper.control, &child.session_id, "helper");
    assert_eq!(grandchild.path, path("/root/scout_1/helper"));
    assert_eq!(
        deeper
            .control
            .spawn(spawn_request(&grandchild.session_id, "too_deep"))
            .unwrap_err(),
        AgentControlError::DepthLimit { max_depth: 2 }
    );
}

#[test]
fn names_are_unique_among_live_agents_and_reusable_after_close() {
    let harness = Harness::new();
    let first = scout(&harness.control, "chat-root", "scout_1");
    assert_eq!(
        harness
            .control
            .spawn(spawn_request("chat-root", "scout_1"))
            .unwrap_err(),
        AgentControlError::NameInUse("scout_1".to_string())
    );

    harness.control.close(&first.session_id, "done").unwrap();
    let second = scout(&harness.control, "chat-root", "scout_1");
    assert_ne!(
        second.session_id, first.session_id,
        "the path is reused; the session never is"
    );
}

#[test]
fn spawning_under_an_unknown_or_closed_parent_is_refused() {
    let harness = Harness::with(|config| config.max_depth = 2);
    assert!(matches!(
        harness.control.spawn(spawn_request("ghost", "a")),
        Err(AgentControlError::UnknownAgent(_))
    ));
    let parent = scout(&harness.control, "chat-root", "parent");
    harness.control.close(&parent.session_id, "done").unwrap();
    assert!(matches!(
        harness
            .control
            .spawn(spawn_request(&parent.session_id, "late")),
        Err(AgentControlError::AgentClosed(_))
    ));
}

#[test]
fn a_parent_closed_during_commit_never_gains_a_live_child() {
    let harness = Harness::with(|config| config.max_depth = 2);
    let parent = scout(&harness.control, "chat-root", "parent");
    let reservation = harness
        .control
        .reserve(spawn_request(&parent.session_id, "child"))
        .expect("reserve");

    harness.control.close(&parent.session_id, "done").unwrap();
    let error = reservation.commit().unwrap_err();

    assert!(
        matches!(error, AgentControlError::AgentClosed(_)),
        "{error}"
    );
    assert!(harness
        .control
        .list_all("chat-root")
        .unwrap()
        .iter()
        .all(|info| info.path.name() != "child"));
}

#[test]
fn reserved_agents_need_the_controller_and_have_a_budget_of_their_own() {
    let harness = Harness::new();
    for origin in [
        SpawnOrigin::Model,
        SpawnOrigin::User,
        SpawnOrigin::Scheduled,
    ] {
        let request = SpawnRequest {
            origin,
            ..controller_request("chat-root", "~reviewer")
        };
        assert_eq!(
            harness.control.spawn(request).unwrap_err(),
            AgentControlError::ReservedName("~reviewer".to_string()),
            "{origin:?} must not be able to create a reserved agent"
        );
    }

    for n in 1..=DEFAULT_MAX_THREADS {
        scout(&harness.control, "chat-root", &format!("scout_{n}"));
    }
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .expect("the reviewer is never crowded out by scouts");
    assert_eq!(reviewer.path, path("/root/~reviewer"));

    for n in 2..=DEFAULT_MAX_RESERVED_THREADS {
        harness
            .control
            .spawn(controller_request("chat-root", &format!("~fork_{n}")))
            .expect("reserved budget");
    }
    assert_eq!(
        harness
            .control
            .spawn(controller_request("chat-root", "~fork_9"))
            .unwrap_err(),
        AgentControlError::CapacityReached {
            max_threads: DEFAULT_MAX_RESERVED_THREADS
        }
    );
    assert!(
        harness
            .control
            .spawn(spawn_request("chat-root", "scout_9"))
            .is_err(),
        "and the scouts' own budget is still full"
    );
}

#[test]
fn nothing_but_the_controller_works_inside_a_reserved_subtree() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();

    assert!(matches!(
        harness
            .control
            .spawn(spawn_request(&reviewer.session_id, "helper")),
        Err(AgentControlError::UnknownAgent(_))
    ));
    let fork = harness
        .control
        .spawn(controller_request(&reviewer.session_id, "~fork_1"))
        .expect("the controller may fork its own reviewer");
    assert_eq!(fork.path, path("/root/~reviewer/~fork_1"));
}

#[test]
fn a_failed_edge_write_aborts_the_spawn_and_leaks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    // The "directory" is a file, so the edge log can never be created.
    let blocker = dir.path().join("agents");
    let log = Log::default();
    let control =
        AgentControl::open(AgentControlConfig::new(&blocker), recorder(&log)).expect("open");
    assert!(control.owns_directory());
    let root = control.register_root("chat-root", None).unwrap();
    fs::create_dir(blocker.join("edges.jsonl")).unwrap();

    // ...but every spawn is refused for the real reason, never for capacity.
    for attempt in 0..(DEFAULT_MAX_THREADS + 3) {
        let error = control
            .spawn(spawn_request(&root.session_id, &format!("scout_{attempt}")))
            .unwrap_err();
        assert!(
            matches!(error, AgentControlError::Persistence(_)),
            "attempt {attempt}: {error}"
        );
    }
    assert_eq!(
        control.list_all("chat-root").unwrap().len(),
        1,
        "only the root exists"
    );
    assert!(recorded(&log, EVENT_AGENT_SPAWN).is_empty());
}

// ---- reaching agents: what a model may and may not see -----------------------

#[test]
fn a_name_is_relative_to_the_author_and_a_path_is_absolute() {
    let harness = Harness::new();
    let one = scout(&harness.control, "chat-root", "scout_1");
    let two = scout(&harness.control, "chat-root", "scout_2");

    // The root reaches its own child by name.
    send(
        &harness.control,
        "chat-root",
        "scout_1",
        MailKind::Task,
        "look at A",
    )
    .unwrap();
    // A sibling is reached by its full path...
    send(
        &harness.control,
        &one.session_id,
        "/root/scout_2",
        MailKind::Message,
        "psst",
    )
    .unwrap();
    // ...and a short name would mean a child of the author, which is not there.
    assert!(matches!(
        send(
            &harness.control,
            &one.session_id,
            "scout_2",
            MailKind::Message,
            "psst"
        ),
        Err(AgentControlError::UnknownAgent(_))
    ));
    send(
        &harness.control,
        &one.session_id,
        "/root",
        MailKind::Message,
        "report",
    )
    .unwrap();

    assert_eq!(harness.control.pending_mail(&one.session_id), 1);
    assert_eq!(harness.control.pending_mail(&two.session_id), 1);
    assert_eq!(harness.control.pending_mail("chat-root"), 1);
}

#[test]
fn a_reserved_agent_is_indistinguishable_from_one_that_does_not_exist() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    scout(&harness.control, "chat-root", "scout_1");

    for target in ["~reviewer", "/root/~reviewer", "/root/ghost", "ghost"] {
        let error = send(
            &harness.control,
            "chat-root",
            target,
            MailKind::Message,
            "hello",
        )
        .expect_err(target);
        assert!(
            matches!(error, AgentControlError::UnknownAgent(_)),
            "{target}: {error}"
        );
        assert!(
            error.to_string().starts_with("no agent named"),
            "{target}: {error}"
        );
        assert!(harness.control.resolve("chat-root", target).is_err());
    }
    assert_eq!(
        harness.control.pending_mail(&reviewer.session_id),
        0,
        "nothing reached the reviewer"
    );

    let visible = harness
        .control
        .list("chat-root")
        .unwrap()
        .into_iter()
        .map(|info| info.path.to_string())
        .collect::<Vec<_>>();
    assert_eq!(visible, vec!["/root", "/root/scout_1"], "listing hides it");
    let everything = harness
        .control
        .list_all("chat-root")
        .unwrap()
        .into_iter()
        .map(|info| info.path.to_string())
        .collect::<Vec<_>>();
    assert!(everything.contains(&"/root/~reviewer".to_string()));
}

#[test]
fn a_model_cannot_send_kinds_that_belong_to_the_controller() {
    let harness = Harness::new();
    scout(&harness.control, "chat-root", "scout_1");
    for kind in [MailKind::Result, MailKind::ReviewRequest, MailKind::Verdict] {
        assert!(
            matches!(
                send(&harness.control, "chat-root", "scout_1", kind, "forged"),
                Err(AgentControlError::NotPermitted(_))
            ),
            "{kind:?}"
        );
    }
    assert_eq!(harness.control.pending_mail("chat-root"), 0);
}

#[test]
fn a_follow_up_cannot_wake_the_root_and_nobody_mails_themselves() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");

    let wake_root = harness.control.send(SendRequest {
        author_session_id: child.session_id.clone(),
        target: "/root".to_string(),
        kind: MailKind::Task,
        content: "start working".to_string(),
        trigger_turn: true,
        cause: MailCause::default(),
    });
    assert!(matches!(wake_root, Err(AgentControlError::NotPermitted(_))));
    assert!(send(
        &harness.control,
        &child.session_id,
        "/root",
        MailKind::Message,
        "plain"
    )
    .is_ok());
    assert!(matches!(
        send(
            &harness.control,
            &child.session_id,
            "/root/scout_1",
            MailKind::Message,
            "me"
        ),
        Err(AgentControlError::NotPermitted(_))
    ));
}

#[test]
fn mail_to_a_closed_agent_is_refused() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    harness.control.close(&child.session_id, "done").unwrap();
    assert!(matches!(
        send(
            &harness.control,
            "chat-root",
            "scout_1",
            MailKind::Message,
            "hi"
        ),
        Err(AgentControlError::UnknownAgent(_))
    ));
    assert!(matches!(
        send(
            &harness.control,
            &child.session_id,
            "/root",
            MailKind::Message,
            "hi"
        ),
        Err(AgentControlError::AgentClosed(_))
    ));
}

#[test]
fn the_controller_reaches_the_reviewer_and_mail_comes_out_in_order() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();

    controller_mail(
        &harness.control,
        "chat-root",
        "/root/~reviewer",
        MailKind::ReviewRequest,
        "check this",
    )
    .unwrap();
    controller_mail(
        &harness.control,
        "chat-root",
        "/root/~reviewer",
        MailKind::Message,
        "and this",
    )
    .unwrap();
    assert_eq!(harness.control.pending_mail(&reviewer.session_id), 2);

    let taken = harness.control.take_mail(&reviewer.session_id);
    assert_eq!(
        taken
            .iter()
            .map(|mail| (mail.kind, mail.content.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (MailKind::ReviewRequest, "check this"),
            (MailKind::Message, "and this")
        ]
    );
    assert!(taken
        .iter()
        .all(|mail| mail.author == AgentPath::root() && mail.recipient == path("/root/~reviewer")));
    assert!(harness.control.take_mail(&reviewer.session_id).is_empty());

    assert!(matches!(
        controller_mail(
            &harness.control,
            "chat-root",
            "/root/ghost",
            MailKind::Message,
            "x"
        ),
        Err(AgentControlError::UnknownAgent(_))
    ));
}

#[test]
fn a_wish_for_a_turn_is_visible_to_the_driver() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    send(
        &harness.control,
        "chat-root",
        "scout_1",
        MailKind::Message,
        "fyi",
    )
    .unwrap();
    assert!(!harness.control.has_pending_trigger(&child.session_id));

    harness
        .control
        .send(SendRequest {
            author_session_id: "chat-root".to_string(),
            target: "scout_1".to_string(),
            kind: MailKind::Task,
            content: "now do this".to_string(),
            trigger_turn: true,
            cause: MailCause::default(),
        })
        .unwrap();
    assert!(harness.control.has_pending_trigger(&child.session_id));
    assert_eq!(harness.control.take_mail(&child.session_id).len(), 2);
    assert!(!harness.control.has_pending_trigger(&child.session_id));
}

#[test]
fn an_empty_message_is_refused_and_a_huge_one_is_bounded() {
    let harness = Harness::new();
    scout(&harness.control, "chat-root", "scout_1");
    assert!(matches!(
        send(
            &harness.control,
            "chat-root",
            "scout_1",
            MailKind::Message,
            "  \n "
        ),
        Err(AgentControlError::NotPermitted(_))
    ));

    let huge = "x".repeat(MAX_MAIL_CONTENT_CHARS + 5_000);
    send(
        &harness.control,
        "chat-root",
        "scout_1",
        MailKind::Message,
        &huge,
    )
    .unwrap();
    let child = harness.control.resolve("chat-root", "scout_1").unwrap();
    let mail = harness.control.take_mail(&child.session_id).pop().unwrap();
    assert!(mail.content.chars().count() < MAX_MAIL_CONTENT_CHARS + 200);
    assert!(mail.content.contains("truncated"));
}

// ---- waiting -----------------------------------------------------------------

#[test]
fn waiting_wakes_the_moment_mail_arrives() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let control = harness.control.clone();
    let sender = child.session_id.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        send(&control, &sender, "/root", MailKind::Message, "ready").unwrap();
    });

    let started = Instant::now();
    let outcome = harness.control.wait_for_mail(
        "chat-root",
        Duration::from_secs(10),
        &AtomicBool::new(false),
    );
    thread.join().unwrap();

    assert_eq!(outcome, MailWait::Mail);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn waiting_times_out_and_stop_cuts_it_short() {
    let harness = Harness::new();
    let outcome = harness.control.wait_for_mail(
        "chat-root",
        Duration::from_millis(120),
        &AtomicBool::new(false),
    );
    assert_eq!(outcome, MailWait::TimedOut);

    let cancel = Arc::new(AtomicBool::new(false));
    let raised = Arc::clone(&cancel);
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        raised.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let outcome = harness
        .control
        .wait_for_mail("chat-root", Duration::from_secs(45), &cancel);
    thread.join().unwrap();
    assert_eq!(outcome, MailWait::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a Stop must not sit behind a long wait: {:?}",
        started.elapsed()
    );
}

#[test]
fn waiting_ends_when_the_agent_is_closed_or_unknown() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let control = harness.control.clone();
    let id = child.session_id.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        control.close(&id, "done").unwrap();
    });
    let outcome = harness.control.wait_for_mail(
        &child.session_id,
        Duration::from_secs(10),
        &AtomicBool::new(false),
    );
    thread.join().unwrap();
    assert_eq!(outcome, MailWait::Closed);
    assert_eq!(
        harness
            .control
            .wait_for_mail("ghost", Duration::from_secs(10), &AtomicBool::new(false)),
        MailWait::Closed
    );
}

// ---- status and results ------------------------------------------------------

#[test]
fn status_is_a_pure_function_of_runtime_events() {
    let finished = |outcome, last_message: Option<&str>| EventType::TurnFinished {
        outcome,
        last_message: last_message.map(str::to_string),
    };
    assert_eq!(
        agent_status_from_event(&EventType::TurnStarted),
        Some(AgentStatus::Running)
    );
    assert_eq!(
        agent_status_from_event(&finished(TurnOutcome::Completed, Some("answer"))),
        Some(AgentStatus::Completed(Some("answer".to_string())))
    );
    assert_eq!(
        agent_status_from_event(&finished(TurnOutcome::Completed, None)),
        Some(AgentStatus::Completed(None))
    );
    assert_eq!(
        agent_status_from_event(&finished(TurnOutcome::Interrupted, None)),
        Some(AgentStatus::Interrupted)
    );
    assert_eq!(
        agent_status_from_event(&finished(
            TurnOutcome::Failed {
                message: "boom".to_string()
            },
            None
        )),
        Some(AgentStatus::Errored("boom".to_string()))
    );
    assert_eq!(
        agent_status_from_event(&EventType::SessionEnd),
        Some(AgentStatus::Shutdown)
    );
    assert_eq!(
        agent_status_from_event(&EventType::UserPrompt {
            preview: String::new(),
            is_slash_command: false
        }),
        None,
        "events that say nothing about the turn do not move the status"
    );

    assert!(AgentStatus::Completed(None).is_final());
    assert!(AgentStatus::Errored(String::new()).is_final());
    assert!(AgentStatus::Shutdown.is_final());
    assert!(AgentStatus::NotFound.is_final());
    assert!(!AgentStatus::PendingInit.is_final());
    assert!(!AgentStatus::Running.is_final());
    assert!(
        !AgentStatus::Interrupted.is_final(),
        "stopped work has not been answered"
    );
}

/// A scripted model: one response per request.
struct Scripted(std::collections::VecDeque<Result<Vec<AssistantEvent>, RuntimeError>>);

impl Scripted {
    fn answers(texts: &[&str]) -> Self {
        Self(
            texts
                .iter()
                .map(|text| {
                    Ok(vec![
                        AssistantEvent::TextDelta((*text).to_string()),
                        AssistantEvent::StopReason("end_turn".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                })
                .collect(),
        )
    }
}

impl ApiClient for Scripted {
    fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.0
            .pop_front()
            .unwrap_or_else(|| Err(RuntimeError::new("the script has no response left")))
    }
}

fn runtime_for(
    control: &AgentControl,
    agent: &AgentHandle,
    turn_id: &str,
    model: Scripted,
) -> ConversationRuntime<Scripted, StaticToolExecutor> {
    control.begin_turn(&agent.session_id, turn_id).unwrap();
    ConversationRuntime::new(
        Session::new(),
        model,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .without_retrieval_guard()
    .with_event_sink(Box::new(
        control.lifecycle_sink(&agent.session_id, Some(turn_id)),
    ))
}

#[test]
fn a_child_turn_reports_exactly_one_result_to_its_parent() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let mut runtime = runtime_for(
        &harness.control,
        &child,
        "turn-c1",
        Scripted::answers(&["found three papers", "found two more"]),
    );

    runtime.run_turn("go", None).unwrap();

    assert_eq!(
        harness.control.status(&child.session_id),
        AgentStatus::Completed(Some("found three papers".to_string()))
    );
    let mail = harness.control.take_mail("chat-root");
    assert_eq!(mail.len(), 1, "one finished turn, one result: {mail:?}");
    assert_eq!(mail[0].kind, MailKind::Result);
    assert_eq!(mail[0].author, path("/root/scout_1"));
    assert_eq!(mail[0].recipient, AgentPath::root());
    assert_eq!(mail[0].content, "found three papers");
    assert!(!mail[0].trigger_turn, "a result never wakes its parent");
    assert_eq!(mail[0].cause.turn_id.as_deref(), Some("turn-c1"));

    // The same terminal event observed again is not a second result.
    let repeated = EventType::TurnFinished {
        outcome: TurnOutcome::Completed,
        last_message: Some("found three papers".to_string()),
    };
    harness
        .control
        .observe_event(&child.session_id, Some("turn-c1"), &repeated);
    harness
        .control
        .observe_event(&child.session_id, Some("turn-c1"), &repeated);
    assert_eq!(harness.control.pending_mail("chat-root"), 0);

    // The next turn is a new report.
    harness
        .control
        .begin_turn(&child.session_id, "turn-c2")
        .unwrap();
    let mut runtime = runtime.with_event_sink(Box::new(
        harness
            .control
            .lifecycle_sink(&child.session_id, Some("turn-c2")),
    ));
    runtime.run_turn("go on", None).unwrap();
    let mail = harness.control.take_mail("chat-root");
    assert_eq!(mail.len(), 1);
    assert_eq!(mail[0].content, "found two more");
}

#[test]
fn a_failed_child_turn_tells_the_parent_what_went_wrong() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let mut runtime = runtime_for(&harness.control, &child, "turn-c1", Scripted::answers(&[]));

    runtime.run_turn("do it", None).unwrap_err();

    assert!(matches!(
        harness.control.status(&child.session_id),
        AgentStatus::Errored(message) if message.contains("no response left")
    ));
    let mail = harness.control.take_mail("chat-root");
    assert_eq!(mail.len(), 1);
    assert_eq!(mail[0].kind, MailKind::Result);
    assert!(
        mail[0].content.starts_with("The agent failed:"),
        "{}",
        mail[0].content
    );
}

#[test]
fn a_cancelled_child_turn_sends_nothing_and_the_agent_can_run_again() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let sink = |harness: &Harness, turn: &str| {
        harness
            .control
            .lifecycle_sink(&child.session_id, Some(turn))
    };
    let mut first = sink(&harness, "turn-1");
    let event = |event_type| RuntimeEvent {
        timestamp: String::new(),
        session_id: String::new(),
        event_type,
    };

    first.emit(&event(EventType::TurnStarted));
    assert_eq!(
        harness.control.status(&child.session_id),
        AgentStatus::Running
    );
    first.emit(&event(EventType::TurnFinished {
        outcome: TurnOutcome::Interrupted,
        last_message: None,
    }));

    assert_eq!(
        harness.control.status(&child.session_id),
        AgentStatus::Interrupted
    );
    assert_eq!(
        harness.control.pending_mail("chat-root"),
        0,
        "a stop the caller asked for is not a result"
    );

    harness
        .control
        .begin_turn(&child.session_id, "turn-2")
        .unwrap();
    let mut second = sink(&harness, "turn-2");
    second.emit(&event(EventType::TurnStarted));
    second.emit(&event(EventType::TurnFinished {
        outcome: TurnOutcome::Completed,
        last_message: Some("done after all".to_string()),
    }));
    assert_eq!(harness.control.take_mail("chat-root").len(), 1);
}

#[test]
fn a_closed_agent_stays_closed_when_a_late_event_arrives() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    harness.control.close(&child.session_id, "stopped").unwrap();

    harness.control.observe_event(
        &child.session_id,
        Some("turn-late"),
        &EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message: Some("too late".to_string()),
        },
    );

    assert_eq!(
        harness.control.status(&child.session_id),
        AgentStatus::Shutdown
    );
    assert_eq!(harness.control.pending_mail("chat-root"), 0);
}

#[test]
fn a_session_end_event_closes_the_agent_and_frees_its_slot_and_name() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");

    harness
        .control
        .observe_event(&child.session_id, None, &EventType::SessionEnd);

    assert_eq!(
        harness.control.status(&child.session_id),
        AgentStatus::Shutdown
    );
    assert!(child.cancel.load(Ordering::SeqCst));
    assert_eq!(harness.control.list_all("chat-root").unwrap().len(), 1);
    assert!(harness
        .control
        .spawn(spawn_request("chat-root", "scout_1"))
        .is_ok());
    // A session the control never heard of is simply ignored.
    harness
        .control
        .observe_event("ghost", None, &EventType::SessionEnd);
}

#[test]
fn the_root_has_a_status_but_reports_to_nobody() {
    let harness = Harness::new();
    harness
        .control
        .observe_event("chat-root", Some("turn-r1"), &EventType::TurnStarted);
    assert_eq!(harness.control.status("chat-root"), AgentStatus::Running);
    harness.control.observe_event(
        "chat-root",
        Some("turn-r1"),
        &EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message: Some("hello".to_string()),
        },
    );
    assert_eq!(
        harness.control.status("chat-root"),
        AgentStatus::Completed(Some("hello".to_string()))
    );
    assert_eq!(
        harness.control.status("never-heard-of-it"),
        AgentStatus::NotFound
    );
    assert!(recorded(&harness.log, EVENT_AGENT_RESULT).is_empty());
}

// ---- the tree on disk --------------------------------------------------------

fn edge_rows(harness: &Harness) -> Vec<Value> {
    fs::read_to_string(harness.agents_dir().join(EDGE_LOG_FILE))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("edge row is JSON"))
        .collect()
}

#[test]
fn spawning_and_closing_are_appended_as_open_and_closed_rows() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");

    let rows = edge_rows(&harness);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], json!("open"));
    assert_eq!(rows[0]["child"], json!(child.session_id));
    assert_eq!(rows[0]["lineage"]["path"], json!("/root/scout_1"));
    assert_eq!(rows[0]["lineage"]["parentTurnId"], json!("turn-parent"));

    harness
        .control
        .close(&child.session_id, "finished")
        .unwrap();
    let rows = edge_rows(&harness);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["status"], json!("closed"));
    assert_eq!(rows[1]["reason"], json!("finished"));
    assert_eq!(rows[1]["child"], json!(child.session_id));

    let edges = read_edges(&harness.agents_dir());
    assert_eq!(edges.len(), 1, "two rows, one link");
    assert_eq!(edges[0].status, EdgeStatus::Closed);
    assert_eq!(edges[0].closed_reason.as_deref(), Some("finished"));
    assert_eq!(
        edges[0]
            .lineage
            .as_ref()
            .map(|lineage| lineage.path.to_string()),
        Some("/root/scout_1".to_string())
    );
}

#[test]
fn an_agent_left_open_by_a_dead_process_is_recovered_as_shutdown_exactly_once() {
    let harness = Harness::new();
    let alive = scout(&harness.control, "chat-root", "scout_1");
    let finished = scout(&harness.control, "chat-root", "scout_2");
    harness.control.close(&finished.session_id, "done").unwrap();
    drop(harness.control.clone());

    // A new process opens the same project.
    let (control, log) = harness.reopen();
    let recovered = control.recovered_agents();
    assert_eq!(recovered.len(), 1, "{recovered:?}");
    assert_eq!(recovered[0].lineage.session_id, alive.session_id);
    assert_eq!(recovered[0].lineage.path, path("/root/scout_1"));
    assert_eq!(recovered[0].status, AgentStatus::Shutdown);
    assert!(
        control
            .info(&alive.session_id)
            .is_some_and(|info| info.status == AgentStatus::Shutdown),
        "a dead agent remains auditable history"
    );
    let closes = recorded(&log, EVENT_AGENT_CLOSE);
    assert_eq!(closes.len(), 1);
    assert_eq!(closes[0].session_id, alive.session_id);
    assert_eq!(closes[0].payload["reason"], json!("orphaned"));

    // The log now says so, so the next start finds nothing to recover.
    let edges = read_edges(&harness.agents_dir());
    assert!(edges.iter().all(|edge| edge.status == EdgeStatus::Closed));
    let orphaned = edges
        .iter()
        .find(|edge| edge.child == alive.session_id)
        .expect("edge");
    assert_eq!(orphaned.closed_reason.as_deref(), Some("orphaned"));
    // The recovering process ends too; only then is the directory free again.
    drop(control);
    let (again, _) = harness.reopen();
    assert!(again.owns_directory());
    assert!(again.recovered_agents().is_empty());
}

#[test]
fn recovered_orphans_do_not_occupy_capacity() {
    let harness = Harness::new();
    for n in 1..=DEFAULT_MAX_THREADS {
        scout(&harness.control, "chat-root", &format!("scout_{n}"));
    }

    let (control, _) = harness.reopen();
    assert_eq!(control.recovered_agents().len(), DEFAULT_MAX_THREADS);
    let root = control.register_root("chat-root", None).unwrap();
    control.begin_turn("chat-root", "after-restart").unwrap();
    for n in 1..=DEFAULT_MAX_THREADS {
        let mut request = spawn_request(&root.session_id, &format!("scout_{n}"));
        request.parent_turn_id = Some("after-restart".into());
        control
            .spawn(request)
            .expect("the dead agents' names and slots are free");
    }
}

#[test]
fn a_second_live_process_leaves_the_first_ones_agents_alone() {
    let harness = Harness::new();
    let alive = scout(&harness.control, "chat-root", "scout_1");
    assert!(harness.control.owns_directory());

    // A second instance of the app opens the same project while the first runs.
    let log = Log::default();
    let second = AgentControl::open(
        AgentControlConfig::new(harness.agents_dir()),
        recorder(&log),
    )
    .expect("a second open still works");

    assert!(!second.owns_directory(), "the lock is already taken");
    assert!(second.recovered_agents().is_empty());
    assert!(
        recorded(&log, EVENT_AGENT_CLOSE).is_empty(),
        "nothing is announced as orphaned"
    );
    let edges = read_edges(&harness.agents_dir());
    assert_eq!(edges.len(), 1);
    assert_eq!(
        edges[0].status,
        EdgeStatus::Open,
        "the running agent stays open"
    );
    assert!(harness.control.info(&alive.session_id).is_some());

    // A second writer must not overwrite the owner's durable mailbox.
    assert!(matches!(
        second.register_root("other-chat", None),
        Err(AgentControlError::Persistence(_))
    ));
}

#[test]
fn the_ownership_lock_lives_exactly_as_long_as_the_control_and_its_clones() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path().join("agents");
    let open =
        |log: &Log| AgentControl::open(AgentControlConfig::new(&agents), recorder(log)).unwrap();
    let first = open(&Log::default());
    let root = first.register_root("chat-root", None).unwrap();
    let child = scout(&first, &root.session_id, "scout_1");
    let clone = first.clone();
    drop(first);

    // A clone is the same control, so the directory is still owned...
    let during = open(&Log::default());
    assert!(!during.owns_directory());
    assert!(during.recovered_agents().is_empty());
    drop(during);
    drop(clone);

    // ...and only when the last one is gone does the next start recover.
    let after = open(&Log::default());
    assert!(after.owns_directory());
    assert_eq!(after.recovered_agents().len(), 1);
    assert_eq!(
        after.recovered_agents()[0].lineage.session_id,
        child.session_id
    );
}

#[test]
fn agent_session_ids_are_recognised_by_their_exact_shape() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    assert!(
        is_agent_session_id(&child.session_id),
        "{}",
        child.session_id
    );
    assert!(is_agent_session_id("agent-0123456789abcdef-12"));
    for not_an_agent in [
        "chat-root",
        "agent",
        "agent-",
        "agent-xyz-1",
        "agent-0123456789abcdef",
        "agent-0123456789abcdef-",
        "agent-0123456789abcdef-x",
        "agent-0123456789abcdef-1-2",
        "xagent-0123456789abcdef-1",
    ] {
        assert!(!is_agent_session_id(not_an_agent), "{not_an_agent}");
    }
}

#[test]
fn damaged_rows_in_the_edge_log_do_not_hide_the_rest() {
    let harness = Harness::new();
    let first = scout(&harness.control, "chat-root", "scout_1");
    let path = harness.agents_dir().join(EDGE_LOG_FILE);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"this is not json\n").unwrap();
    file.write_all(&[0xff, 0xfe, 0x80, b'\n']).unwrap();
    file.write_all(b"{\"v\":1,\"status\":\"open\"}\n").unwrap();
    drop(file);
    let second = scout(&harness.control, "chat-root", "scout_2");

    let children = read_edges(&harness.agents_dir())
        .into_iter()
        .map(|edge| edge.child)
        .collect::<Vec<_>>();

    assert_eq!(children, vec![first.session_id, second.session_id]);
}

// ---- cascade -----------------------------------------------------------------

#[test]
fn cancelling_a_subtree_raises_every_flag_below_it_and_only_those() {
    let harness = Harness::with(|config| {
        config.max_depth = 3;
        config.max_threads = 3;
    });
    let a = scout(&harness.control, "chat-root", "a");
    let b = scout(&harness.control, &a.session_id, "b");
    let c = scout(&harness.control, "chat-root", "c");
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    let raised = |handle: &AgentHandle| handle.cancel.load(Ordering::SeqCst);

    assert_eq!(harness.control.cancel_subtree(&a.session_id), 2);
    assert!(raised(&a) && raised(&b));
    assert!(!raised(&c) && !raised(&reviewer) && !raised(&harness.root));

    // Stop on the root reaches everything, the reviewer included.
    assert_eq!(harness.control.cancel_subtree("chat-root"), 5);
    assert!(raised(&c) && raised(&reviewer) && raised(&harness.root));
    assert_eq!(harness.control.cancel_subtree("ghost"), 0);
}

#[test]
fn a_reserved_agents_outcome_is_not_mailed_to_the_agent_above_it() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    let scout_handle = scout(&harness.control, "chat-root", "scout_1");
    let settle = |session_id: &str| {
        harness
            .control
            .observe_event(session_id, Some("turn-x"), &EventType::TurnStarted);
        harness.control.observe_event(
            session_id,
            Some("turn-x"),
            &EventType::TurnFinished {
                outcome: TurnOutcome::Completed,
                last_message: Some("{\"verdict\":\"revise\"}".to_string()),
            },
        );
    };

    settle(&reviewer.session_id);

    assert_eq!(
        harness.control.status(&reviewer.session_id),
        AgentStatus::Completed(Some("{\"verdict\":\"revise\"}".to_string())),
        "the status still follows the turn: the controller reads it from there"
    );
    assert_eq!(
        harness.control.pending_mail("chat-root"),
        0,
        "the Executor never receives the Reviewer's verdict from its mailbox"
    );
    assert!(recorded(&harness.log, EVENT_AGENT_RESULT).is_empty());

    // An ordinary child is the other way round: its result is the parent's mail.
    settle(&scout_handle.session_id);
    assert_eq!(harness.control.pending_mail("chat-root"), 1);
    assert_eq!(recorded(&harness.log, EVENT_AGENT_RESULT).len(), 1);
}

#[test]
fn the_controller_delivers_a_whole_review_packet_where_a_model_is_cut_short() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    let packet = "p".repeat(MAX_MAIL_CONTENT_CHARS + 40_000);

    let receipt = harness
        .control
        .deliver(ControllerMail {
            author_session_id: "chat-root".to_string(),
            recipient: reviewer.path.clone(),
            kind: MailKind::ReviewRequest,
            content: packet.clone(),
            trigger_turn: true,
            cause: MailCause::default(),
        })
        .unwrap();

    assert!(receipt.trigger_turn);
    let mail = harness
        .control
        .take_mail(&reviewer.session_id)
        .pop()
        .unwrap();
    assert_eq!(mail.kind, MailKind::ReviewRequest);
    assert_eq!(mail.content, packet, "nothing of the packet was cut");
    let too_big = "p".repeat(MAX_CONTROLLER_MAIL_CONTENT_CHARS + 10);
    harness
        .control
        .deliver(ControllerMail {
            author_session_id: "chat-root".to_string(),
            recipient: reviewer.path.clone(),
            kind: MailKind::ReviewRequest,
            content: too_big,
            trigger_turn: true,
            cause: MailCause::default(),
        })
        .unwrap();
    let mail = harness
        .control
        .take_mail(&reviewer.session_id)
        .pop()
        .unwrap();
    assert!(
        mail.content.contains("truncated"),
        "the controller's own bound still holds"
    );
}

#[test]
fn a_new_turn_uses_a_fresh_flag_and_never_revives_an_old_worker() {
    let harness = Harness::new();
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    harness.control.cancel_subtree("chat-root");
    assert!(reviewer.cancel.load(Ordering::SeqCst));

    let resumed = harness
        .control
        .begin_turn(&reviewer.session_id, "review-next")
        .unwrap();
    assert!(!resumed.cancel.load(Ordering::SeqCst));
    assert!(reviewer.cancel.load(Ordering::SeqCst));
    assert!(
        harness.root.cancel.load(Ordering::SeqCst),
        "only the named agent's flag moves"
    );

    harness.control.close(&reviewer.session_id, "done").unwrap();
    assert!(harness
        .control
        .begin_turn(&reviewer.session_id, "review-closed")
        .is_err());
    assert!(reviewer.cancel.load(Ordering::SeqCst), "closing is final");
    assert!(harness.control.begin_turn("ghost", "review-ghost").is_err());
}

#[test]
fn closing_a_parent_closes_everything_below_it_and_frees_the_slots() {
    let harness = Harness::with(|config| {
        config.max_depth = 3;
        config.max_threads = 3;
    });
    let a = scout(&harness.control, "chat-root", "a");
    let b = scout(&harness.control, &a.session_id, "b");
    let c = scout(&harness.control, "chat-root", "c");

    let report = harness.control.close(&a.session_id, "done").unwrap();

    assert_eq!(
        report.closed,
        vec![b.session_id.clone(), a.session_id.clone()],
        "deepest first"
    );
    assert_eq!(report.persistence_error, None);
    assert_eq!(harness.control.status(&a.session_id), AgentStatus::Shutdown);
    assert_eq!(harness.control.status(&b.session_id), AgentStatus::Shutdown);
    assert_ne!(harness.control.status(&c.session_id), AgentStatus::Shutdown);
    assert!(a.cancel.load(Ordering::SeqCst) && b.cancel.load(Ordering::SeqCst));
    assert_eq!(
        harness
            .control
            .list_all("chat-root")
            .unwrap()
            .iter()
            .map(|info| info.path.to_string())
            .collect::<Vec<_>>(),
        vec!["/root", "/root/c"]
    );
    assert!(harness
        .control
        .close(&a.session_id, "again")
        .unwrap()
        .closed
        .is_empty());
}

#[test]
fn closing_the_root_closes_the_whole_tree() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();

    let report = harness.control.close("chat-root", "chat deleted").unwrap();

    assert_eq!(report.closed.len(), 3);
    for id in [&child.session_id, &reviewer.session_id, "chat-root"] {
        assert_eq!(harness.control.status(id), AgentStatus::Shutdown, "{id}");
    }
    assert!(matches!(
        harness.control.close("ghost", "x"),
        Err(AgentControlError::UnknownAgent(_))
    ));
}

// ---- events ------------------------------------------------------------------

#[test]
fn spawning_writes_the_parents_spawn_event_under_the_turn_that_caused_it() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");

    let spawn = recorded(&harness.log, EVENT_AGENT_SPAWN)
        .pop()
        .expect("spawn event");
    assert_eq!(
        spawn.session_id, "chat-root",
        "it belongs to the parent's log"
    );
    assert_eq!(spawn.payload["turnId"], json!("turn-parent"));
    assert_eq!(spawn.payload["childSessionId"], json!(child.session_id));
    assert_eq!(spawn.payload["childPath"], json!("/root/scout_1"));
    assert_eq!(spawn.payload["origin"], json!("model"));
    assert_eq!(spawn.payload["spawnRef"], json!("toolu_7"));
    assert_eq!(spawn.payload["depth"], json!(1));
}

#[test]
fn mail_events_name_the_senders_turn_and_the_receivers() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    harness
        .control
        .send(SendRequest {
            author_session_id: "chat-root".to_string(),
            target: "scout_1".to_string(),
            kind: MailKind::Task,
            content: "look at section 3".to_string(),
            trigger_turn: true,
            cause: MailCause {
                turn_id: Some("turn-sender".to_string()),
                tool_use_id: Some("toolu_9".to_string()),
                action_id: None,
            },
        })
        .unwrap();

    let sent = recorded(&harness.log, EVENT_AGENT_MAIL_SENT).pop().unwrap();
    assert_eq!(sent.session_id, "chat-root", "recorded in the author's log");
    assert_eq!(sent.payload["turnId"], json!("turn-sender"));
    assert_eq!(sent.payload["toolUseId"], json!("toolu_9"));
    assert_eq!(sent.payload["triggerTurn"], json!(true));
    assert_eq!(sent.payload["to"], json!("/root/scout_1"));
    assert_eq!(sent.payload["toSessionId"], json!(child.session_id));

    harness
        .control
        .begin_turn(&child.session_id, "turn-receiver")
        .unwrap();
    let mut input = harness
        .control
        .turn_input_source(&child.session_id, Some("turn-receiver"));
    let delivered = input.take_ready();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].from, "/root");
    assert_eq!(delivered[0].kind, "task");
    assert_eq!(delivered[0].text, "look at section 3");
    assert_eq!(delivered[0].id, sent.payload["mailId"].as_str().unwrap());
    assert!(input.take_ready().is_empty(), "handed out once");

    let events = recorded(&harness.log, EVENT_AGENT_MAIL_DELIVERED);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].session_id, child.session_id,
        "recorded in the receiver's log"
    );
    assert_eq!(events[0].payload["turnId"], json!("turn-receiver"));
    assert_eq!(events[0].payload["sentTurnId"], json!("turn-sender"));
    assert_eq!(events[0].payload["fromSessionId"], json!("chat-root"));
}

#[test]
fn a_result_leaves_a_trail_in_both_logs() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let mut runtime = runtime_for(
        &harness.control,
        &child,
        "turn-c1",
        Scripted::answers(&["done"]),
    );
    runtime.run_turn("go", None).unwrap();

    let sent = recorded(&harness.log, EVENT_AGENT_MAIL_SENT);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].session_id, child.session_id);
    assert_eq!(sent[0].payload["turnId"], json!("turn-c1"));
    assert_eq!(sent[0].payload["kind"], json!("result"));

    let result = recorded(&harness.log, EVENT_AGENT_RESULT);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].session_id, "chat-root");
    assert_eq!(result[0].payload["turnId"], json!("turn-parent"));
    assert_eq!(result[0].payload["childTurnId"], json!("turn-c1"));
    assert_eq!(result[0].payload["status"], json!("completed"));
    assert_eq!(result[0].payload["mailId"], sent[0].payload["mailId"]);
}

#[test]
fn closing_is_recorded_for_the_agent_and_for_its_parent() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    harness
        .control
        .close(&child.session_id, "finished")
        .unwrap();

    let closes = recorded(&harness.log, EVENT_AGENT_CLOSE);
    assert_eq!(closes.len(), 2);
    assert!(closes
        .iter()
        .any(|event| event.session_id == child.session_id
            && event.payload["reason"] == json!("finished")));
    assert!(closes.iter().any(|event| event.session_id == "chat-root"
        && event.payload["childSessionId"] == json!(child.session_id)));
}

#[test]
fn every_agent_event_carries_a_turn_id_field() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    let reviewer = harness
        .control
        .spawn(controller_request("chat-root", "~reviewer"))
        .unwrap();
    send(
        &harness.control,
        "chat-root",
        "scout_1",
        MailKind::Message,
        "hi",
    )
    .unwrap();
    controller_mail(
        &harness.control,
        "chat-root",
        "/root/~reviewer",
        MailKind::ReviewRequest,
        "x",
    )
    .unwrap();
    harness
        .control
        .turn_input_source(&child.session_id, None)
        .take_ready();
    let mut runtime = runtime_for(
        &harness.control,
        &child,
        "turn-c1",
        Scripted::answers(&["ok"]),
    );
    runtime.run_turn("go", None).unwrap();
    harness.control.close(&reviewer.session_id, "done").unwrap();
    harness.control.close(&child.session_id, "done").unwrap();

    let events = harness.log.lock().unwrap().clone();
    assert!(
        events.len() >= 8,
        "the scenario should have produced many events"
    );
    for event in events {
        assert!(event.kind.starts_with("agent."), "{}", event.kind);
        assert!(
            event.payload.get("turnId").is_some(),
            "{} has no turnId field: {}",
            event.kind,
            event.payload
        );
    }
}

#[test]
fn a_recorder_may_call_back_into_the_control_without_deadlocking() {
    let dir = tempfile::tempdir().unwrap();
    let control_slot: Arc<Mutex<Option<AgentControl>>> = Arc::default();
    let seen = Arc::new(AtomicU64::new(0));
    let recorder: AgentEventRecorder = {
        let control_slot = Arc::clone(&control_slot);
        let seen = Arc::clone(&seen);
        Arc::new(move |session_id, _kind, _payload| {
            // Every callback re-enters the control, which would deadlock if the
            // control still held its lock while calling out.
            if let Some(control) = control_slot.lock().unwrap().clone() {
                let _ = control.status(session_id);
                let _ = control.list_all("chat-root");
                seen.fetch_add(1, Ordering::SeqCst);
            }
        })
    };
    let control =
        AgentControl::open(AgentControlConfig::new(dir.path().join("agents")), recorder).unwrap();
    *control_slot.lock().unwrap() = Some(control.clone());
    let (done_tx, done_rx) = mpsc::channel();

    std::thread::spawn(move || {
        control.register_root("chat-root", None).unwrap();
        let child = control
            .spawn(spawn_request("chat-root", "scout_1"))
            .unwrap();
        send_via(&control, "chat-root", "scout_1");
        control.observe_event(
            &child.session_id,
            Some("t"),
            &EventType::TurnFinished {
                outcome: TurnOutcome::Completed,
                last_message: Some("x".to_string()),
            },
        );
        control.close(&child.session_id, "done").unwrap();
        done_tx.send(()).unwrap();
    });

    done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the control deadlocked while delivering an event");
    assert!(seen.load(Ordering::SeqCst) >= 4);
}

fn send_via(control: &AgentControl, author: &str, target: &str) {
    send(control, author, target, MailKind::Message, "hi").unwrap();
}

// ---- durability of the trace ---------------------------------------------------

#[test]
fn agent_events_survive_event_log_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chat-root.events.jsonl");
    let row = |seq: u32, kind: &str| {
        format!(
            "{{\"version\":1,\"seq\":{seq},\"ts\":1,\"sessionId\":\"chat-root\",\"kind\":\"{kind}\",\"payload\":{{}}}}\n"
        )
    };
    // Rows before a checkpoint and before a reset are normally dead weight.
    let log = [
        row(1, "agent.spawn"),
        row(2, "tool_call"),
        row(3, "agent.mail.sent"),
        row(4, "session_reset"),
        row(5, "assistant_delta"),
        row(6, "agent.result"),
        row(7, "session_checkpoint"),
        row(8, "assistant_delta"),
        row(9, "agent.close"),
    ]
    .concat();
    fs::write(&path, log).unwrap();

    let outcome = crate::compact_session_event_log(&path).expect("compact");

    let kept = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        kept,
        vec![
            "agent.spawn",
            "agent.mail.sent",
            "session_reset",
            "agent.result",
            "session_checkpoint",
            "assistant_delta",
            "agent.close"
        ],
        "the stream rows behind the reset and checkpoint went; every agent row stayed"
    );
    assert_eq!(outcome.removed_lines, 2);
}

fn task_contract() -> AgentTask {
    AgentTask {
        reason: "independent recovery verification".into(),
        task: "inspect checkpoints".into(),
        inputs: "existing session evidence".into(),
        deliverable: "findings and paths".into(),
        stop_condition: "report gaps after inspection".into(),
        model: "executor-from-parent".into(),
        connection: "configured host".into(),
        permission: "workspace-write intersect read-only".into(),
        workspace: "project-1".into(),
        max_iterations: 4,
        max_seconds: 30,
    }
}

#[test]
fn stopped_workers_cannot_write_results_or_checkpoints_into_a_followup() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    let first = h.control.begin_turn(&child.session_id, "old").unwrap();
    h.control
        .observe_event(&child.session_id, Some("old"), &EventType::TurnStarted);
    h.control.cancel_subtree(&child.session_id);
    let second = h.control.begin_turn(&child.session_id, "new").unwrap();
    assert!(first.cancel.load(Ordering::SeqCst));
    assert!(!second.cancel.load(Ordering::SeqCst));
    h.control
        .observe_event(&child.session_id, Some("new"), &EventType::TurnStarted);
    for event in [
        EventType::TurnStarted,
        EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message: Some("stale result".into()),
        },
        EventType::SessionEnd,
    ] {
        h.control
            .observe_event(&child.session_id, Some("old"), &event);
    }
    assert_eq!(h.control.status(&child.session_id), AgentStatus::Running);
    assert_eq!(h.control.pending_mail("chat-root"), 0);
    assert!(h
        .control
        .checkpoint(&child.session_id, Some("old"), &Session::new())
        .is_err());
    h.control.observe_event(
        &child.session_id,
        Some("new"),
        &EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message: Some("accepted result".into()),
        },
    );
    h.control
        .observe_event(&child.session_id, Some("new"), &EventType::TurnStarted);
    h.control.observe_event(
        &child.session_id,
        Some("new"),
        &EventType::TurnFinished {
            outcome: TurnOutcome::Failed {
                message: "late error".into(),
            },
            last_message: None,
        },
    );
    assert_eq!(
        h.control.status(&child.session_id),
        AgentStatus::Completed(Some("accepted result".into()))
    );
    assert_eq!(
        h.control.take_mail("chat-root")[0].content,
        "accepted result"
    );
}

#[test]
fn retired_or_stopped_authors_cannot_deliver_mail_or_commit_a_spawn() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control.begin_turn("chat-root", "parent-old").unwrap();
    let mut request = spawn_request("chat-root", "reserved");
    request.parent_turn_id = Some("parent-old".into());
    let reservation = h.control.reserve(request.clone()).unwrap();
    h.control.cancel_subtree("chat-root");
    h.control.begin_turn("chat-root", "parent-new").unwrap();
    assert!(reservation.commit().is_err());
    assert!(h.control.reserve(request).is_err());
    let error = h
        .control
        .send(SendRequest {
            author_session_id: "chat-root".into(),
            target: child.path.to_string(),
            kind: MailKind::Task,
            content: "late request".into(),
            trigger_turn: true,
            cause: MailCause {
                turn_id: Some("parent-old".into()),
                ..MailCause::default()
            },
        })
        .unwrap_err();
    assert!(error.to_string().contains("stale or stopped"));
    assert_eq!(h.control.pending_mail(&child.session_id), 0);
}

#[test]
fn retired_parent_cannot_restart_rebind_or_interrupt_a_current_child() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control.begin_turn("chat-root", "parent-old").unwrap();
    h.control
        .set_task(&child.session_id, task_contract())
        .unwrap();
    h.control.cancel_subtree("chat-root");
    h.control.begin_turn("chat-root", "parent-new").unwrap();
    let mut current = task_contract();
    current.model = "current-executor".into();
    h.control
        .begin_child_turn(
            "chat-root",
            "parent-new",
            &child.session_id,
            "child-new",
            current.clone(),
        )
        .unwrap();
    h.control.observe_event(
        &child.session_id,
        Some("child-new"),
        &EventType::TurnStarted,
    );
    assert!(h
        .control
        .begin_child_turn(
            "chat-root",
            "parent-old",
            &child.session_id,
            "late-child",
            task_contract()
        )
        .is_err());
    assert!(h
        .control
        .interrupt_child("chat-root", "parent-old", &child.session_id)
        .is_err());
    h.control
        .observe_event(&child.session_id, Some("child-old"), &EventType::SessionEnd);
    let info = h.control.info(&child.session_id).unwrap();
    assert_eq!(info.status, AgentStatus::Running);
    assert_eq!(info.task.unwrap(), current);
    h.control
        .interrupt_child("chat-root", "parent-new", &child.session_id)
        .unwrap();
    assert_eq!(
        h.control.status(&child.session_id),
        AgentStatus::Interrupted
    );
}

#[test]
fn restart_retains_unknown_tool_intents_and_never_executes_them() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control
        .set_task(&child.session_id, task_contract())
        .unwrap();
    h.control
        .begin_turn(&child.session_id, "child-before-crash")
        .unwrap();
    let mut session = Session::new();
    session.messages.push(ConversationMessage::assistant(vec![
        ContentBlock::ToolUse {
            id: "external-intent".into(),
            name: "WebFetch".into(),
            input: r#"{"url":"https://example.org"}"#.into(),
        },
    ]));
    h.control
        .checkpoint(&child.session_id, Some("child-before-crash"), &session)
        .unwrap();
    let (restored, _) = h.reopen();
    let info = restored.info(&child.session_id).unwrap();
    assert_eq!(info.status, AgentStatus::Interrupted);
    assert!(info
        .interruption_reason
        .unwrap()
        .contains("uncertain tool calls"));
    assert_eq!(
        read_edges(&h.agents_dir())[0].status,
        EdgeStatus::Open,
        "resumable task has not been closed"
    );
    assert_eq!(
        session.unresolved_tool_calls(),
        vec![("external-intent".into(), "WebFetch".into())]
    );
    session.seal_uncertain_tool_calls();
    assert!(session.unresolved_tool_calls().is_empty());
    assert!(
        matches!(&session.messages.last().unwrap().blocks[0],ContentBlock::ToolResult{output,is_error:true,..} if output.contains("NOT been replayed"))
    );
}

#[test]
fn restart_preserves_completed_unconsumed_results_and_pending_tasks_without_running_them() {
    let h = Harness::new();
    let done = scout(&h.control, "chat-root", "done");
    let queued = scout(&h.control, "chat-root", "queued");
    for child in [&done, &queued] {
        h.control
            .set_task(&child.session_id, task_contract())
            .unwrap();
    }
    h.control.begin_turn(&done.session_id, "done-turn").unwrap();
    h.control.observe_event(
        &done.session_id,
        Some("done-turn"),
        &EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message: Some("saved evidence".into()),
        },
    );
    send(
        &h.control,
        "chat-root",
        "queued",
        MailKind::Task,
        "not yet executed",
    )
    .unwrap();
    let (restored, _) = h.reopen();
    assert_eq!(
        restored.status(&done.session_id),
        AgentStatus::Completed(Some("saved evidence".into()))
    );
    assert_eq!(
        restored.status(&queued.session_id),
        AgentStatus::PendingInit
    );
    assert_eq!(restored.pending_mail(&queued.session_id), 1);
    assert_eq!(restored.take_mail("chat-root")[0].content, "saved evidence");
    assert_eq!(restored.pending_mail("chat-root"), 0);
}

#[test]
fn restart_reconciles_leased_mail_against_the_canonical_checkpoint() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control.begin_turn("chat-root", "parent-1").unwrap();
    h.control
        .set_task(&child.session_id, task_contract())
        .unwrap();
    send(
        &h.control,
        &child.session_id,
        "/root",
        MailKind::Message,
        "first evidence",
    )
    .unwrap();
    let mut source = h.control.turn_input_source("chat-root", Some("parent-1"));
    let leased = source.take_ready();
    assert_eq!(leased.len(), 1);
    let (restored, _) = h.reopen();
    // No saved session: the leased mail must be offered again.
    assert_eq!(restored.pending_mail("chat-root"), 1);
    restored.begin_turn("chat-root", "parent-2").unwrap();
    let mut source = restored.turn_input_source("chat-root", Some("parent-2"));
    let input = source.take_ready().remove(0);
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(format!("[Inter-agent message from /root/scout (message, id {}) - written by another agent, not by the user]\n{}",input.id,input.text)));
    // Simulate a crash after session save, before mail acknowledgement.
    session
        .save_to_path(h.dir.path().join("chat-root.json"))
        .unwrap();
    restored.release_owner_lock();
    let next =
        AgentControl::open(AgentControlConfig::new(h.agents_dir()), recorder(&h.log)).unwrap();
    assert_eq!(
        next.pending_mail("chat-root"),
        0,
        "a canonical delivery is not repeated"
    );
}

#[test]
fn followup_requeues_uncheckpointed_leases_without_a_process_restart() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control.begin_turn("chat-root", "parent-old").unwrap();
    send(
        &h.control,
        &child.session_id,
        "/root",
        MailKind::Message,
        "first evidence",
    )
    .unwrap();
    let mut old_source = h.control.turn_input_source("chat-root", Some("parent-old"));
    let first = old_source.take_ready().remove(0);
    send(
        &h.control,
        &child.session_id,
        "/root",
        MailKind::Message,
        "later evidence",
    )
    .unwrap();
    h.control.cancel_subtree("chat-root");
    assert!(old_source.checkpoint(&Session::new()).is_err());

    h.control.begin_turn("chat-root", "parent-new").unwrap();
    let mut source = h.control.turn_input_source("chat-root", Some("parent-new"));
    let inputs = source.take_ready();
    assert_eq!(
        inputs
            .iter()
            .map(|input| input.text.as_str())
            .collect::<Vec<_>>(),
        ["first evidence", "later evidence"]
    );
    assert_eq!(
        inputs[0].id, first.id,
        "a retry keeps the stable delivery id"
    );
    let mut session = Session::new();
    for input in inputs {
        session.messages.push(ConversationMessage::user_text(format!(
            "[Inter-agent message from {} ({}, id {}) - written by another agent, not by the user]\n{}",
            input.from, input.kind, input.id, input.text,
        )));
    }
    source.checkpoint(&session).unwrap();
    h.control.begin_turn("chat-root", "parent-next").unwrap();
    assert_eq!(h.control.pending_mail("chat-root"), 0);
    assert_eq!(h.reopen().0.pending_mail("chat-root"), 0);
}

#[test]
fn followup_does_not_redeliver_a_saved_lease_when_stop_prevented_acknowledgement() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control.begin_turn("chat-root", "parent-old").unwrap();
    send(
        &h.control,
        &child.session_id,
        "/root",
        MailKind::Message,
        "saved evidence",
    )
    .unwrap();
    let mut source = h.control.turn_input_source("chat-root", Some("parent-old"));
    let input = source.take_ready().remove(0);
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text(format!(
        "[Inter-agent message from {} ({}, id {}) - written by another agent, not by the user]\n{}",
        input.from, input.kind, input.id, input.text,
    )));
    session
        .save_to_path(h.dir.path().join("chat-root.json"))
        .unwrap();
    // Canonical events commit before the convenience manifest. Recovery must
    // recognize the delivery even if interruption left only the event log.
    fs::remove_file(h.dir.path().join("chat-root.json")).unwrap();
    h.control.cancel_subtree("chat-root");
    assert!(source.checkpoint(&session).is_err());
    h.control.begin_turn("chat-root", "parent-new").unwrap();
    assert_eq!(
        h.control.pending_mail("chat-root"),
        0,
        "canonical delivery must not repeat"
    );
    assert_eq!(
        Session::load_from_path(h.dir.path().join("chat-root.json")).unwrap(),
        session
    );
}

#[test]
fn recovered_running_tasks_require_explicit_resume_and_retain_project_and_reason() {
    let h = Harness::new();
    let child = scout(&h.control, "chat-root", "scout");
    h.control
        .set_task(&child.session_id, task_contract())
        .unwrap();
    h.control
        .begin_turn(&child.session_id, "running-before-exit")
        .unwrap();
    h.control.observe_event(
        &child.session_id,
        Some("running-before-exit"),
        &EventType::TurnStarted,
    );
    h.control.activity(
        &child.session_id,
        "running-before-exit",
        "read_file: recovery.rs",
    );
    let (restored, _) = h.reopen();
    let info = restored.info(&child.session_id).unwrap();
    assert_eq!(info.status, AgentStatus::Interrupted);
    assert!(info.interruption_reason.unwrap().contains("not replayed"));
    assert_eq!(
        info.last_activity.as_deref(),
        Some("read_file: recovery.rs")
    );
    assert_eq!(info.project_id.as_deref(), Some("project-1"));
    assert_eq!(info.task.unwrap().reason, task_contract().reason);
    assert!(restored
        .begin_turn(&child.session_id, "explicit-resume")
        .is_ok());
}

// ---- driving a real turn --------------------------------------------------------

#[test]
fn process_exit_restores_pending_results_and_unknown_calls_without_reexecution() {
    const FIXTURE_ENV: &str = "ARIS_COLLABORATION_RECOVERY_TEST_ROOT";
    if let Some(directory) = std::env::var_os(FIXTURE_ENV) {
        let directory = PathBuf::from(directory);
        let control = AgentControl::open(
            AgentControlConfig::new(directory.join("agents")),
            recorder(&Log::default()),
        )
        .unwrap();
        control
            .register_root("chat-root", Some("project-1"))
            .unwrap();
        control.begin_turn("chat-root", "turn-parent").unwrap();
        let done = scout(&control, "chat-root", "done");
        let queued = scout(&control, "chat-root", "queued");
        for child in [&done, &queued] {
            control
                .set_task(&child.session_id, task_contract())
                .unwrap();
        }
        control.begin_turn(&done.session_id, "done-turn").unwrap();
        control.observe_event(
            &done.session_id,
            Some("done-turn"),
            &EventType::TurnFinished {
                outcome: TurnOutcome::Completed,
                last_message: Some("durable process evidence".into()),
            },
        );
        control
            .send(SendRequest {
                author_session_id: "chat-root".into(),
                target: "queued".into(),
                kind: MailKind::Task,
                content: "not executed before exit".into(),
                trigger_turn: true,
                cause: MailCause {
                    turn_id: Some("turn-parent".into()),
                    ..MailCause::default()
                },
            })
            .unwrap();
        let mut session = Session::new();
        session.messages.push(ConversationMessage::assistant(vec![
            ContentBlock::ToolUse {
                id: "uncertain-operation".into(),
                name: "external_action".into(),
                input: "{}".into(),
            },
        ]));
        control
            .checkpoint("chat-root", Some("turn-parent"), &session)
            .unwrap();
        // No Drop or graceful shutdown: the OS releases the process-owned lock.
        std::process::exit(0);
    }

    let directory = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "agent_control::tests::process_exit_restores_pending_results_and_unknown_calls_without_reexecution", "--nocapture"])
        .env(FIXTURE_ENV, directory.path())
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let control = AgentControl::open(
        AgentControlConfig::new(directory.path().join("agents")),
        recorder(&Log::default()),
    )
    .unwrap();
    assert!(
        control.owns_directory(),
        "the dead process released its owner lock"
    );
    let done = control.resolve("chat-root", "done").unwrap();
    let queued = control.resolve("chat-root", "queued").unwrap();
    assert_eq!(
        control.status(&done.session_id),
        AgentStatus::Completed(Some("durable process evidence".into()))
    );
    assert_eq!(control.status(&queued.session_id), AgentStatus::PendingInit);
    assert_eq!(control.pending_mail(&queued.session_id), 1);
    assert_eq!(
        control.pending_mail("chat-root"),
        1,
        "completed result awaits its parent"
    );
    assert!(control
        .info("chat-root")
        .unwrap()
        .interruption_reason
        .unwrap()
        .contains("uncertain tool calls"));

    struct RecoveryModel(Arc<Mutex<Vec<Vec<ConversationMessage>>>>);
    impl ApiClient for RecoveryModel {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.0.lock().unwrap().push(request.messages);
            Ok(vec![
                AssistantEvent::TextDelta("Only saved evidence was used.".into()),
                AssistantEvent::MessageStop,
            ])
        }
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    control.begin_turn("chat-root", "explicit-resume").unwrap();
    let mut resumed = ConversationRuntime::new(
        Session::load_from_path(directory.path().join("chat-root.json")).unwrap(),
        RecoveryModel(requests.clone()),
        StaticToolExecutor::new().register("external_action", |_| {
            panic!("uncertain operation was replayed")
        }),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["reconcile saved evidence".into()],
    )
    .with_turn_input_source(Box::new(
        control.turn_input_source("chat-root", Some("explicit-resume")),
    ))
    .with_focus_nudge(false);
    resumed
        .run_turn("Continue using saved evidence", None)
        .unwrap();
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert!(captured[0].iter().flat_map(|message| &message.blocks).any(
        |block| matches!(block, ContentBlock::ToolResult { tool_use_id, output, is_error: true, .. }
            if tool_use_id == "uncertain-operation" && output.contains("NOT been replayed"))
    ));
    assert_eq!(captured[0].iter().flat_map(|message| &message.blocks).filter(|block|
        matches!(block, ContentBlock::Text { text } if text.contains("durable process evidence"))).count(), 1);
    drop(captured);
    drop(resumed);
    drop(control);
    let reopened = AgentControl::open(
        AgentControlConfig::new(directory.path().join("agents")),
        recorder(&Log::default()),
    )
    .unwrap();
    assert_eq!(
        reopened.pending_mail("chat-root"),
        0,
        "consumed result is not redelivered"
    );
    assert_eq!(
        reopened.status(&queued.session_id),
        AgentStatus::PendingInit,
        "unstarted work stays unstarted"
    );
}

/// The root agent's model: asks for a tool on its first request, answers on
/// its second, and keeps every request it was sent.
struct Root {
    calls: usize,
    requests: Arc<Mutex<Vec<Vec<ConversationMessage>>>>,
}

impl ApiClient for Root {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.calls += 1;
        self.requests.lock().unwrap().push(request.messages);
        Ok(if self.calls == 1 {
            vec![
                AssistantEvent::ToolUse {
                    id: "call-1".to_string(),
                    name: "wait_a_moment".to_string(),
                    input: "{}".to_string(),
                },
                AssistantEvent::MessageStop,
            ]
        } else {
            vec![
                AssistantEvent::TextDelta("thanks".to_string()),
                AssistantEvent::MessageStop,
            ]
        })
    }
}

#[test]
fn mail_that_arrives_mid_turn_reaches_the_next_request_once_through_the_adapter() {
    let harness = Harness::new();
    let child = scout(&harness.control, "chat-root", "scout_1");
    harness.control.begin_turn("chat-root", "turn-r1").unwrap();

    let requests: Arc<Mutex<Vec<Vec<ConversationMessage>>>> = Arc::default();
    let scout_side = harness.control.clone();
    let scout_id = child.session_id.clone();
    // While the root's tool runs, the scout reports in.
    let tools = StaticToolExecutor::new().register("wait_a_moment", move |_| {
        send(
            &scout_side,
            &scout_id,
            "/root",
            MailKind::Message,
            "section 3 is ready",
        )
        .unwrap();
        Ok("waited".to_string())
    });
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        Root {
            calls: 0,
            requests: Arc::clone(&requests),
        },
        tools,
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_turn_input_source(Box::new(
        harness
            .control
            .turn_input_source("chat-root", Some("turn-r1")),
    ));

    runtime.run_turn("coordinate", None).unwrap();

    let requests = requests.lock().unwrap();
    let delivered = |messages: &Vec<ConversationMessage>| {
        messages
            .iter()
            .filter(|message| message.role == MessageRole::User)
            .flat_map(|message| &message.blocks)
            .filter(|block| matches!(block, ContentBlock::Text { text } if text.starts_with("[Inter-agent message")))
            .count()
    };
    assert_eq!(delivered(&requests[0]), 0);
    assert_eq!(
        delivered(&requests[1]),
        1,
        "the mail joined the very next request"
    );
    assert!(requests[1].iter().any(|message| message.blocks.iter().any(
        |block| matches!(block, ContentBlock::Text { text } if text.contains("from /root/scout_1") && text.ends_with("section 3 is ready"))
    )));
    assert_eq!(harness.control.pending_mail("chat-root"), 0);

    let delivered_events = recorded(&harness.log, EVENT_AGENT_MAIL_DELIVERED);
    assert_eq!(
        delivered_events.len(),
        1,
        "and was recorded as delivered once"
    );
    assert_eq!(delivered_events[0].payload["turnId"], json!("turn-r1"));
    assert_eq!(delivered_events[0].session_id, "chat-root");
}
