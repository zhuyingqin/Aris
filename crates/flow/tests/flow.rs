//! Public-API tests for the flow runtime. All offline except `live_minimax_pilot`,
//! which is `#[ignore]` and requires `MINIMAX_API_KEY` (run with `--ignored`).

use std::collections::BTreeMap;

use flow::{
    compute_key, default_minimax_role, fold, idea_pilot, strip_think, Binding, CachePolicy,
    FlowDef, FlowEvent, FlowRunner, LogEntry, Ref, Step, StepKey, StepKind,
};

fn roles() -> BTreeMap<String, flow::RoleRef> {
    let mut m = BTreeMap::new();
    m.insert("r".to_string(), default_minimax_role());
    m
}

fn llm_step(id: &str, role: &str, inputs: Vec<Binding>) -> Step {
    Step {
        id: id.to_string(),
        kind: StepKind::Llm {
            role: role.to_string(),
            prompt_template: "{x}".to_string(),
        },
        inputs,
        cache: CachePolicy::Keyed,
    }
}

#[test]
fn compute_key_is_deterministic_and_sensitive() {
    let flow = idea_pilot();
    let step = flow.step("brainstorm").expect("brainstorm step");
    let role = flow.roles.get("researcher").expect("role");

    let mut inputs = BTreeMap::new();
    inputs.insert("topic".to_string(), "diffusion".to_string());
    inputs.insert("survey".to_string(), "S".to_string());

    let k1 = compute_key(step, role, &inputs);
    assert_eq!(
        k1,
        compute_key(step, role, &inputs),
        "same inputs → same key"
    );
    assert_eq!(k1.0.len(), 64, "sha256 hex is 64 chars");

    // Changing an input invalidates the key (and thus everything downstream).
    let mut changed = inputs.clone();
    changed.insert("survey".to_string(), "S-different".to_string());
    assert_ne!(
        k1,
        compute_key(step, role, &changed),
        "input change → new key"
    );

    // Changing the model invalidates the key — the P1 heterogeneous-model seam.
    let mut other_model = role.clone();
    other_model.model = "SomeOtherModel".to_string();
    assert_ne!(
        k1,
        compute_key(step, &other_model, &inputs),
        "model change → new key"
    );
}

#[test]
fn idea_pilot_validates_and_roundtrips_through_json() {
    let flow = idea_pilot();
    flow.validate().expect("pilot is a valid DAG");

    // The flow is a reusable artifact: serialize → deserialize → still valid.
    let json = serde_json::to_string_pretty(&flow).expect("serialize");
    let back: FlowDef = serde_json::from_str(&json).expect("deserialize");
    back.validate().expect("roundtripped flow is valid");
    assert_eq!(back.steps.len(), 4);
    assert_eq!(back.name, "idea-pilot");
}

#[test]
fn validate_rejects_bad_graphs() {
    // Duplicate step id.
    let dup = FlowDef {
        name: "dup".to_string(),
        args_schema: serde_json::Value::Null,
        roles: roles(),
        steps: vec![llm_step("a", "r", vec![]), llm_step("a", "r", vec![])],
    };
    assert!(dup.validate().is_err(), "duplicate ids rejected");

    // Forward reference (a depends on b defined later).
    let forward = FlowDef {
        name: "fwd".to_string(),
        args_schema: serde_json::Value::Null,
        roles: roles(),
        steps: vec![
            llm_step(
                "a",
                "r",
                vec![Binding {
                    name: "x".to_string(),
                    source: Ref::Step {
                        step: "b".to_string(),
                    },
                }],
            ),
            llm_step("b", "r", vec![]),
        ],
    };
    assert!(forward.validate().is_err(), "forward references rejected");

    // Undefined role.
    let ghost = FlowDef {
        name: "ghost".to_string(),
        args_schema: serde_json::Value::Null,
        roles: roles(),
        steps: vec![llm_step("a", "ghost", vec![])],
    };
    assert!(ghost.validate().is_err(), "undefined role rejected");
}

#[test]
fn fold_reconstructs_state_at_each_prefix() {
    let key = StepKey("deadbeef".to_string());
    let entries = vec![
        LogEntry {
            seq: 0,
            ts_ms: 0,
            event: FlowEvent::RunStarted {
                run_id: "r1".to_string(),
                flow_name: "f".to_string(),
                args: serde_json::Value::Null,
                parent: None,
            },
        },
        LogEntry {
            seq: 1,
            ts_ms: 0,
            event: FlowEvent::StepCompleted {
                step: "a".to_string(),
                key: key.clone(),
                cached: false,
                output_len: 3,
            },
        },
        LogEntry {
            seq: 2,
            ts_ms: 0,
            event: FlowEvent::StepCompleted {
                step: "b".to_string(),
                key: key.clone(),
                cached: true,
                output_len: 3,
            },
        },
        LogEntry {
            seq: 3,
            ts_ms: 0,
            event: FlowEvent::RunFinished {
                result_step: Some("b".to_string()),
            },
        },
    ];

    // Rewind to just after RunStarted: nothing completed yet.
    let s1 = fold(&entries, Some(1));
    assert_eq!(s1.run_id.as_deref(), Some("r1"));
    assert_eq!(s1.completed.len(), 0);
    assert!(!s1.finished);

    // After the first StepCompleted.
    let s2 = fold(&entries, Some(2));
    assert!(s2.completed.contains_key("a"));
    assert!(!s2.cached.contains("a"));

    // After the second (cached) StepCompleted.
    let s3 = fold(&entries, Some(3));
    assert_eq!(s3.completed.len(), 2);
    assert!(s3.cached.contains("b"));
    assert!(!s3.finished);

    // Full fold.
    let all = fold(&entries, None);
    assert!(all.finished);
    assert_eq!(all.result_step.as_deref(), Some("b"));
    assert_eq!(all.events_folded, 4);
}

#[test]
fn strip_think_removes_reasoning_blocks() {
    assert_eq!(strip_think("<think>reasoning</think>answer"), "answer");
    assert_eq!(
        strip_think("a<think>one</think>b<think>two</think>c"),
        "abc"
    );
    // Unterminated (truncated) block: drop from <think> onward.
    assert_eq!(strip_think("visible<think>cut off"), "visible");
    // No think block: unchanged.
    assert_eq!(strip_think("plain answer"), "plain answer");
}

#[test]
#[ignore = "hits the live MiniMax API; run with --ignored and MINIMAX_API_KEY set"]
fn live_minimax_pilot() {
    if std::env::var("MINIMAX_API_KEY").map_or(true, |k| k.is_empty()) {
        eprintln!("skipping live_minimax_pilot: MINIMAX_API_KEY not set");
        return;
    }
    // Isolate storage so the test does not pollute the repo's .clawd-flows.
    let home = std::env::temp_dir().join(format!("flow-live-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("ARIS_FLOW_HOME", &home);

    let topic = "contrastive pretraining for tabular data";
    let mut runner =
        FlowRunner::fresh(idea_pilot(), serde_json::json!({ "topic": topic })).expect("fresh");
    let run_id = runner.run_id().to_string();
    let outcome = runner.run().expect("run completes");
    let result = outcome.result.expect("has a result");
    assert!(!result.trim().is_empty(), "review step produced output");

    // Resume must be fully cached (no network) and reproduce the same result.
    let mut resumed = FlowRunner::resume(&run_id).expect("resume");
    let again = resumed.run().expect("resume completes");
    assert_eq!(again.result.as_deref(), Some(result.as_str()));

    std::env::remove_var("ARIS_FLOW_HOME");
}
