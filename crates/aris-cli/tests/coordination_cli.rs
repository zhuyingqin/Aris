use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

#[test]
fn cli_runs_approved_workflow_through_tool_and_persists_timeline() {
    let case = TestCase::new("approved-workflow");
    let args = json!({
        "action": "start",
        "name": "cli-approved",
        "script": "emitPhase(\"synthesis\")\nsaveResult(\"CLI workflow final\")",
        "approval": "allow_once"
    });
    let server = FakeOpenAiServer::start(vec![
        sse_tool_call("call_workflow", "Workflow", &args),
        sse_text("Workflow completed and saved."),
    ]);

    let output = run_aris_prompt(
        &case,
        server.base_url(),
        "Run the approved workflow smoke test.",
    );
    assert_success(&output);

    let requests = server.requests();
    assert!(
        requests
            .first()
            .is_some_and(|body| body.contains("\"Workflow\"") && body.contains("\"SpawnTeammate\"")),
        "first request should advertise workflow and team tools: {requests:?}"
    );
    assert!(
        output_stdout(&output).contains("Workflow completed and saved."),
        "stdout should contain final model text"
    );

    let manifest = only_workflow_manifest(case.run_state_dir());
    assert_eq!(manifest["status"], "completed");
    assert_eq!(manifest["result"], "CLI workflow final");
    assert_eq!(manifest["phases"][0]["status"], "completed");

    let sessions = session_files(case.cwd());
    assert_eq!(sessions.len(), 1, "one session should be persisted");
    let timeline = sessions[0].with_file_name(format!(
        "{}.timeline.json",
        sessions[0].file_stem().unwrap().to_string_lossy()
    ));
    assert!(timeline.exists(), "CLI should persist a timeline artifact");
}

#[test]
fn cli_approval_gate_keeps_workflow_result_uncommitted() {
    let case = TestCase::new("approval-gate");
    let args = json!({
        "action": "start",
        "name": "cli-needs-approval",
        "script": "emitPhase(\"approval\")\nsaveResult(\"SHOULD_NOT_BE_COMMITTED\")"
    });
    let server = FakeOpenAiServer::start(vec![
        sse_tool_call("call_workflow", "Workflow", &args),
        sse_text("Approval is required before execution."),
    ]);

    let output = run_aris_prompt(
        &case,
        server.base_url(),
        "Try to run an unapproved workflow.",
    );
    assert_success(&output);

    let manifest = only_workflow_manifest(case.run_state_dir());
    assert_eq!(manifest["status"], "approval_required");
    assert!(manifest.get("result").is_none_or(Value::is_null));
    assert_eq!(
        manifest["completedCache"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0),
        0,
        "approval-required workflow must not commit completed cache"
    );
}

#[test]
fn cli_runs_team_coordination_tools_and_persists_shared_state() {
    let case = TestCase::new("team-coordination");
    let spawn_args = json!({
        "teamId": "team-cli",
        "teamName": "CLI Team",
        "teamDesign": valid_team_design(),
        "description": "Audit coordination state",
        "prompt": "Inspect shared state and report back.",
        "subagentType": "Explore",
        "role": "state-auditor",
        "responsibility": "Inspect persisted team coordination state and report whether the expected records exist.",
        "contextScope": "Only inspect the current smoke-test run-state and teammate manifest files.",
        "deliverable": "A concise state audit result for the lead session.",
        "successCriteria": [
            "Confirms team, task, mailbox, and event records are present.",
            "Does not modify unrelated files or create extra teammates."
        ],
        "stopCondition": "Stop after the shared state audit result is complete and recorded.",
        "name": "scout",
        "taskId": "task-cli",
        "taskTitle": "Audit coordination state"
    });
    let message_args = json!({
        "teamId": "team-cli",
        "from": "lead",
        "to": "scout",
        "subject": "handoff",
        "body": "Use the shared mailbox for coordination.",
        "taskId": "task-cli"
    });
    let complete_args = json!({
        "teamId": "team-cli",
        "taskId": "task-cli",
        "actor": "lead",
        "result": "CLI team state persisted"
    });
    let list_args = json!({
        "teamId": "team-cli",
        "includeMessages": true,
        "includeEvents": true
    });
    let server = FakeOpenAiServer::start(vec![
        sse_tool_call("call_spawn", "SpawnTeammate", &spawn_args),
        sse_tool_call("call_message", "SendMessage", &message_args),
        sse_tool_call("call_complete", "CompleteTask", &complete_args),
        sse_tool_call("call_list", "ListTeam", &list_args),
        sse_text("Team coordination state is visible."),
    ]);

    let output = run_aris_prompt(
        &case,
        server.base_url(),
        "Run the team coordination smoke test.",
    );
    assert_success(&output);

    let requests = server.requests();
    assert!(
        requests.first().is_some_and(|body| {
            body.contains("\"SpawnTeammate\"")
                && body.contains("\"teamDesign\"")
                && body.contains("\"SendMessage\"")
                && body.contains("\"CompleteTask\"")
                && body.contains("\"ListTeam\"")
        }),
        "first request should advertise team coordination tools: {requests:?}"
    );
    assert!(
        output_stdout(&output).contains("Team coordination state is visible."),
        "stdout should contain final model text"
    );

    let team = read_json(case.run_state_dir().join("teams").join("team-cli.json"));
    assert_eq!(team["name"], "CLI Team");
    assert_eq!(team["design"]["coordinator"], "lead session");
    assert_eq!(team["members"].as_array().map(Vec::len).unwrap_or(0), 1);
    assert_eq!(team["members"][0]["taskId"], "task-cli");
    assert_eq!(team["members"][0]["role"], "state-auditor");

    let tasks = read_json(case.run_state_dir().join("tasks.json"));
    let task = tasks
        .as_array()
        .expect("tasks array")
        .iter()
        .find(|task| task["taskId"] == "task-cli")
        .expect("task-cli persisted");
    assert_eq!(task["status"], "completed");
    assert_eq!(task["result"], "CLI team state persisted");

    let mailbox = read_json(case.run_state_dir().join("mailbox.jsonl"));
    assert_eq!(mailbox["body"], "Use the shared mailbox for coordination.");
    assert_eq!(mailbox["status"], "delivered");

    let events = json_lines(case.run_state_dir().join("events.jsonl"));
    for kind in [
        "TeamCreated",
        "TaskCreated",
        "TeammateSpawned",
        "MessageSent",
        "TaskCompleted",
    ] {
        assert!(
            events.iter().any(|event| event["kind"] == kind),
            "missing event kind {kind}: {events:?}"
        );
    }

    let agent_manifests = fs::read_dir(case.agent_store_dir())
        .expect("agents dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    assert_eq!(agent_manifests.len(), 1, "one teammate agent manifest");

    let sessions = session_files(case.cwd());
    assert_eq!(sessions.len(), 1, "one session should be persisted");
}

#[test]
fn cli_rejects_team_spawn_without_design_contract() {
    let case = TestCase::new("team-contract-required");
    let spawn_args = json!({
        "teamId": "team-missing-design",
        "teamName": "Missing Design Team",
        "description": "Write the paper",
        "prompt": "Write the whole paper with other agents.",
        "subagentType": "Write",
        "name": "writer"
    });
    let server = FakeOpenAiServer::start(vec![
        sse_tool_call("call_spawn", "SpawnTeammate", &spawn_args),
        sse_text("The invalid team spawn was rejected."),
    ]);

    let output = run_aris_prompt(
        &case,
        server.base_url(),
        "Try to start an unstructured paper-writing team.",
    );
    assert_success(&output);

    let requests = server.requests();
    assert!(
        requests
            .get(1)
            .is_some_and(|body| body.contains("teamDesign is required")),
        "second request should contain the SpawnTeammate validation error: {requests:?}"
    );
    assert!(
        !case
            .run_state_dir()
            .join("teams")
            .join("team-missing-design.json")
            .exists(),
        "invalid team should not be persisted"
    );
}

#[test]
fn cli_rejects_overlapping_team_roles_and_tasks() {
    let case = TestCase::new("team-overlap-rejected");
    let first = valid_spawn_args(
        "team-overlap",
        "writer-a",
        "paper-writer",
        "Draft Method Section",
        "Draft the method section from the supplied evidence only.",
        "Produce a bounded method-section draft for the lead integrator.",
    );
    let second = valid_spawn_args(
        "team-overlap",
        "writer-b",
        "paper-writer",
        "Draft Method Section",
        "Draft the same method section again in parallel.",
        "Produce a second method-section draft for comparison.",
    );
    let server = FakeOpenAiServer::start(vec![
        sse_tool_call("call_first", "SpawnTeammate", &first),
        sse_tool_call("call_second", "SpawnTeammate", &second),
        sse_text("The overlapping teammate was rejected."),
    ]);

    let output = run_aris_prompt(
        &case,
        server.base_url(),
        "Start a paper-writing team with a duplicate writer role.",
    );
    assert_success(&output);

    let requests = server.requests();
    assert!(
        requests.get(2).is_some_and(|body| {
            body.contains("role `paper-writer` already exists")
                || body.contains("task title `Draft Method Section` already exists")
        }),
        "third request should contain the overlap validation error: {requests:?}"
    );

    let team = read_json(case.run_state_dir().join("teams").join("team-overlap.json"));
    assert_eq!(team["members"].as_array().map(Vec::len).unwrap_or(0), 1);
    let tasks = read_json(case.run_state_dir().join("tasks.json"));
    assert_eq!(
        tasks
            .as_array()
            .expect("tasks array")
            .iter()
            .filter(|task| task["teamId"] == "team-overlap")
            .count(),
        1,
        "overlapping second task should not be persisted"
    );
}

struct TestCase {
    root: PathBuf,
    cwd: PathBuf,
    home: PathBuf,
}

impl TestCase {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = workspace_root()
            .join("target")
            .join("cli-smoke")
            .join(format!("{unique}-{name}"));
        let cwd = root.join("workspace");
        let home = root.join("home");
        fs::create_dir_all(&cwd).expect("create smoke cwd");
        fs::create_dir_all(&home).expect("create smoke home");
        Self { root, cwd, home }
    }

    fn cwd(&self) -> &Path {
        &self.cwd
    }

    fn run_state_dir(&self) -> PathBuf {
        self.cwd.join(".claude").join("run-state")
    }

    fn agent_store_dir(&self) -> PathBuf {
        self.root.join(".clawd-agents")
    }
}

impl Drop for TestCase {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct FakeOpenAiServer {
    addr: String,
    requests: Arc<Mutex<Vec<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeOpenAiServer {
    fn start(responses: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
        listener.set_nonblocking(false).expect("blocking listener");
        let addr = listener.local_addr().expect("local addr").to_string();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            let mut responses = VecDeque::from(responses);
            while let Some(response) = responses.pop_front() {
                let (mut stream, _) = listener.accept().expect("accept request");
                let body = read_http_body(&mut stream);
                requests_for_thread
                    .lock()
                    .expect("requests lock")
                    .push(body);
                write_http_response(&mut stream, &response);
            }
        });
        Self {
            addr,
            requests,
            handle: Some(handle),
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().expect("requests lock").clone()
    }
}

impl Drop for FakeOpenAiServer {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.join().expect("fake server thread");
        }
    }
}

fn run_aris_prompt(case: &TestCase, base_url: String, prompt: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_aris"))
        .current_dir(case.cwd())
        .env("HOME", &case.home)
        .env("USERPROFILE", &case.home)
        .env("CLAUDE_CONFIG_HOME", case.home.join(".claude"))
        .env("CLAWD_AGENT_STORE", case.agent_store_dir())
        .env("EXECUTOR_PROVIDER", "openai")
        .env("EXECUTOR_API_KEY", "sk-test")
        .env("EXECUTOR_BASE_URL", base_url)
        .env("ARIS_STREAM_RETRY_BUDGET", "0")
        .args([
            "--model",
            "MiniMax-M2.7",
            "--output-format",
            "json",
            "prompt",
            prompt,
        ])
        .output()
        .expect("run aris")
}

fn assert_success(output: &std::process::Output) {
    assert!(
        output.status.success(),
        "aris failed\nstdout:\n{}\nstderr:\n{}",
        output_stdout(output),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn output_stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn sse_tool_call(id: &str, name: &str, arguments: &Value) -> String {
    let arguments = serde_json::to_string(arguments).expect("arguments json");
    let chunk = json!({
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let chunk = json!({
        "choices": [{
            "delta": { "content": text },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 5,
            "completion_tokens": 3,
            "total_tokens": 8
        }
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}

fn valid_team_design() -> Value {
    json!({
        "rationale": "The task needs bounded parallel work with a separate verification path.",
        "coordinationPattern": "lead-coordinator-with-specialized-teammates",
        "coordinator": "lead session",
        "contextPolicy": "The lead passes only task-specific artifacts and teammates use structured tool handoffs.",
        "verificationPlan": "The lead checks each deliverable against persisted files and task success criteria.",
        "stopCondition": "Stop when all assigned deliverables satisfy their success criteria and are integrated.",
        "maxTeammates": 4
    })
}

fn valid_spawn_args(
    team_id: &str,
    name: &str,
    role: &str,
    task_title: &str,
    responsibility: &str,
    deliverable: &str,
) -> Value {
    json!({
        "teamId": team_id,
        "teamName": "Paper Writing Team",
        "teamDesign": valid_team_design(),
        "description": task_title,
        "prompt": responsibility,
        "subagentType": "Write",
        "role": role,
        "responsibility": responsibility,
        "contextScope": "Use only the supplied paper plan, evidence notes, and current run-state records.",
        "deliverable": deliverable,
        "successCriteria": [
            "The deliverable is scoped to the assigned section and cites evidence boundaries.",
            "The teammate records completion only after the requested artifact is available."
        ],
        "stopCondition": "Stop after the assigned writing artifact is complete and handed back.",
        "name": name,
        "taskId": format!("task-{name}"),
        "taskTitle": task_title
    })
}

fn read_http_body(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    loop {
        let read = stream.read(&mut temp).expect("read request");
        assert!(read > 0, "request closed before headers");
        buffer.extend_from_slice(&temp[..read]);
        if let Some(header_end) = find_header_end(&buffer) {
            let header = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            let body_start = header_end + 4;
            while buffer.len() < body_start + content_length {
                let read = stream.read(&mut temp).expect("read request body");
                assert!(read > 0, "request closed before full body");
                buffer.extend_from_slice(&temp[..read]);
            }
            return String::from_utf8_lossy(&buffer[body_start..body_start + content_length])
                .to_string();
        }
    }
}

fn write_http_response(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn only_workflow_manifest(run_state_dir: PathBuf) -> Value {
    let workflow_dir = run_state_dir.join("workflows");
    let manifests = fs::read_dir(&workflow_dir)
        .expect("workflow dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("manifest.json"))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    assert_eq!(manifests.len(), 1, "expected one workflow manifest");
    serde_json::from_str(&fs::read_to_string(&manifests[0]).expect("manifest contents"))
        .expect("manifest json")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(
        &fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("json file should exist and be readable: {}", path.display())
        }),
    )
    .unwrap_or_else(|error| panic!("valid json at {}: {error}", path.display()))
}

fn json_lines(path: PathBuf) -> Vec<Value> {
    fs::read_to_string(&path)
        .unwrap_or_else(|_| {
            panic!(
                "jsonl file should exist and be readable: {}",
                path.display()
            )
        })
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("valid jsonl at {}: {error}", path.display()))
        })
        .collect()
}

fn session_files(cwd: &Path) -> Vec<PathBuf> {
    let session_dir = cwd.join(".claude").join("sessions");
    let mut files = fs::read_dir(session_dir)
        .expect("sessions dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|ext| ext.to_str()) == Some("json")
                && !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".timeline.json"))
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("workspace root")
        .to_path_buf()
}
