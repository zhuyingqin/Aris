//! The serial runner. Walks a flow's steps in definition (topological) order;
//! each step is content-addressed, so resume and fork reuse prior results.
//!
//! `run`, `resume`, and `fork` all share one walk — the only difference is what is
//! already present in the store (and, for fork, an optional parent store consulted
//! for steps strictly *before* the fork point).
//!
//! Step execution goes through a [`ProviderFactory`] (default: MiniMax). The
//! indirection is the P1 seam for heterogeneous models and lets the resume/fork
//! semantics be tested offline with a deterministic fake.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::def::{step_role, Binding, CachePolicy, FlowDef, Ref, RoleRef, Step, StepKind};
use crate::error::{FlowError, Result};
use crate::event::{now_ms, FlowEvent, FlowEventLog};
use crate::provider::{Completer, MiniMaxProvider};
use crate::store::{compute_key, run_dir, StepResult, StepStore};

/// Builds a [`Completer`] for a role. The seam that lets different steps run on
/// different models (P1) and lets tests inject a deterministic fake.
pub type ProviderFactory = Box<dyn Fn(&RoleRef) -> Result<Box<dyn Completer>>>;

/// The default factory: a MiniMax client per role.
#[must_use]
pub fn default_provider_factory() -> ProviderFactory {
    Box::new(|role| Ok(Box::new(MiniMaxProvider::from_role(role)?) as Box<dyn Completer>))
}

/// Persisted run manifest (`run.json`) — lets resume/fork recover the flow + args.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunManifest {
    /// This run's id.
    pub run_id: String,
    /// The flow definition (captured so the run is self-describing/replayable).
    pub flow: FlowDef,
    /// The run arguments.
    pub args: Value,
    /// Parent run id, when this run is a fork.
    #[serde(default)]
    pub parent: Option<String>,
    /// Unix-epoch milliseconds at creation.
    pub created_at_ms: u128,
}

/// Outcome of a completed (or partially completed) run.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// The run id.
    pub run_id: String,
    /// The terminal step's output (the run result), if the run finished.
    pub result: Option<String>,
    /// Per-step outputs produced/loaded during this walk.
    pub outputs: BTreeMap<String, String>,
}

/// A single execution of a flow against one run directory.
pub struct FlowRunner {
    run_id: String,
    run_dir: PathBuf,
    flow: FlowDef,
    args: Value,
    store: StepStore,
    log: FlowEventLog,
    /// For fork: parent store consulted for steps with index `< reuse_before`.
    parent_store: Option<StepStore>,
    reuse_before: usize,
    outputs: BTreeMap<String, String>,
    providers: HashMap<String, Box<dyn Completer>>,
    provider_factory: ProviderFactory,
}

impl FlowRunner {
    /// Start a fresh run of `flow` with `args` (MiniMax provider).
    ///
    /// # Errors
    /// Propagates validation, IO, and serialization failures.
    pub fn fresh(flow: FlowDef, args: Value) -> Result<Self> {
        Self::fresh_with_factory(flow, args, default_provider_factory())
    }

    /// Resume an existing run (MiniMax provider).
    ///
    /// # Errors
    /// Returns [`FlowError::RunNotFound`] if the manifest is missing.
    pub fn resume(run_id: &str) -> Result<Self> {
        Self::resume_with_factory(run_id, default_provider_factory())
    }

    /// Fork an existing run from `from_step` (MiniMax provider).
    ///
    /// # Errors
    /// Returns [`FlowError::UnknownStep`] if `from_step` is not in the parent flow.
    pub fn fork(parent_run_id: &str, from_step: &str) -> Result<Self> {
        Self::fork_with_factory(parent_run_id, from_step, default_provider_factory())
    }

    /// Start a fresh run with an explicit provider factory.
    ///
    /// # Errors
    /// Propagates validation, IO, and serialization failures.
    pub fn fresh_with_factory(
        flow: FlowDef,
        args: Value,
        factory: ProviderFactory,
    ) -> Result<Self> {
        flow.validate()?;
        let run_id = make_run_id();
        let dir = run_dir(&run_id);
        let manifest = RunManifest {
            run_id: run_id.clone(),
            flow: flow.clone(),
            args: args.clone(),
            parent: None,
            created_at_ms: now_ms(),
        };
        let reuse_before = flow.steps.len(); // no parent; bound is irrelevant
        let mut runner = Self::assemble(run_id, dir, flow, args, None, reuse_before, factory)?;
        write_manifest(&runner.run_dir, &manifest)?;
        runner.log.append(FlowEvent::RunStarted {
            run_id: runner.run_id.clone(),
            flow_name: runner.flow.name.clone(),
            args: runner.args.clone(),
            parent: None,
        })?;
        Ok(runner)
    }

    /// Resume with an explicit provider factory.
    ///
    /// # Errors
    /// Returns [`FlowError::RunNotFound`] if the manifest is missing.
    pub fn resume_with_factory(run_id: &str, factory: ProviderFactory) -> Result<Self> {
        let manifest = read_manifest(run_id)?;
        let dir = run_dir(run_id);
        let reuse_before = manifest.flow.steps.len();
        Self::assemble(
            manifest.run_id,
            dir,
            manifest.flow,
            manifest.args,
            None,
            reuse_before,
            factory,
        )
    }

    /// Fork from `from_step` with an explicit provider factory. Steps before it are
    /// reused from the parent's store; `from_step` and downstream re-execute.
    ///
    /// # Errors
    /// Returns [`FlowError::UnknownStep`] if `from_step` is not in the parent flow.
    pub fn fork_with_factory(
        parent_run_id: &str,
        from_step: &str,
        factory: ProviderFactory,
    ) -> Result<Self> {
        let manifest = read_manifest(parent_run_id)?;
        let fork_index = manifest
            .flow
            .steps
            .iter()
            .position(|s| s.id == from_step)
            .ok_or_else(|| FlowError::UnknownStep(from_step.to_string()))?;

        let parent_store = StepStore::open(&run_dir(parent_run_id))?;
        let run_id = make_run_id();
        let dir = run_dir(&run_id);
        let new_manifest = RunManifest {
            run_id: run_id.clone(),
            flow: manifest.flow.clone(),
            args: manifest.args.clone(),
            parent: Some(parent_run_id.to_string()),
            created_at_ms: now_ms(),
        };
        let mut runner = Self::assemble(
            run_id,
            dir,
            manifest.flow,
            manifest.args,
            Some(parent_store),
            fork_index,
            factory,
        )?;
        write_manifest(&runner.run_dir, &new_manifest)?;
        runner.log.append(FlowEvent::RunStarted {
            run_id: runner.run_id.clone(),
            flow_name: runner.flow.name.clone(),
            args: runner.args.clone(),
            parent: Some(parent_run_id.to_string()),
        })?;
        Ok(runner)
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble(
        run_id: String,
        dir: PathBuf,
        flow: FlowDef,
        args: Value,
        parent_store: Option<StepStore>,
        reuse_before: usize,
        provider_factory: ProviderFactory,
    ) -> Result<Self> {
        let store = StepStore::open(&dir)?;
        let log = FlowEventLog::open_append(&dir)?;
        Ok(Self {
            run_id,
            run_dir: dir,
            flow,
            args,
            store,
            log,
            parent_store,
            reuse_before,
            outputs: BTreeMap::new(),
            providers: HashMap::new(),
            provider_factory,
        })
    }

    /// This run's id.
    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Execute the whole flow to completion (or until a step fails).
    ///
    /// # Errors
    /// On the first step failure, emits `StepFailed` and returns the error; the
    /// run directory is left intact so the run can be resumed.
    pub fn run(&mut self) -> Result<RunOutcome> {
        let steps = self.flow.steps.clone();
        for (index, step) in steps.iter().enumerate() {
            if let Err(error) = self.run_step(index, step) {
                self.log.append(FlowEvent::StepFailed {
                    step: step.id.clone(),
                    error: error.to_string(),
                })?;
                return Err(error);
            }
        }
        let result_step = steps.last().map(|s| s.id.clone());
        self.log.append(FlowEvent::RunFinished {
            result_step: result_step.clone(),
        })?;
        let result = result_step.and_then(|id| self.outputs.get(&id).cloned());
        Ok(RunOutcome {
            run_id: self.run_id.clone(),
            result,
            outputs: self.outputs.clone(),
        })
    }

    fn run_step(&mut self, index: usize, step: &Step) -> Result<()> {
        let role_name = step_role(&step.kind).ok_or_else(|| {
            FlowError::NotImplemented(format!("{} (step {})", step.kind.tag(), step.id))
        })?;
        let role = self
            .flow
            .roles
            .get(role_name)
            .ok_or_else(|| {
                FlowError::InvalidGraph(format!("step {} role {role_name} undefined", step.id))
            })?
            .clone();

        let resolved = self.resolve_inputs(step)?;
        let key = compute_key(step, &role, &resolved);

        self.log.append(FlowEvent::StepStarted {
            step: step.id.clone(),
            key: key.clone(),
            role: role_name.to_string(),
            model: role.model.clone(),
        })?;

        // Cache lookup: own store first, then (for steps before a fork point) parent.
        let mut output: Option<String> = None;
        if step.cache == CachePolicy::Keyed {
            if let Some(found) = self.store.get(&key)? {
                output = Some(found.output);
            } else if index < self.reuse_before {
                if let Some(parent) = &self.parent_store {
                    if self.store.import_from(parent, &key)? {
                        output = self.store.get(&key)?.map(|r| r.output);
                    }
                }
            }
        }
        let cached = output.is_some();

        let output = if let Some(text) = output {
            text
        } else {
            let prompt = render_prompt(&step.kind, &resolved, &step.id)?;
            let provider = self.provider_for(role_name, &role)?;
            let completion = provider.complete(&prompt)?;
            self.store.put(&StepResult {
                key: key.clone(),
                step: step.id.clone(),
                model: role.model.clone(),
                output: completion.output.clone(),
                created_at_ms: now_ms(),
                usage: completion.usage,
            })?;
            completion.output
        };

        self.outputs.insert(step.id.clone(), output.clone());
        self.log.append(FlowEvent::StepCompleted {
            step: step.id.clone(),
            key,
            cached,
            output_len: output.chars().count(),
        })?;
        Ok(())
    }

    fn provider_for(&mut self, role_name: &str, role: &RoleRef) -> Result<&dyn Completer> {
        if !self.providers.contains_key(role_name) {
            let provider = (self.provider_factory)(role)?;
            self.providers.insert(role_name.to_string(), provider);
        }
        Ok(self.providers[role_name].as_ref())
    }

    fn resolve_inputs(&self, step: &Step) -> Result<BTreeMap<String, String>> {
        let mut map = BTreeMap::new();
        for binding in &step.inputs {
            map.insert(binding.name.clone(), self.resolve_ref(step, binding)?);
        }
        Ok(map)
    }

    fn resolve_ref(&self, step: &Step, binding: &Binding) -> Result<String> {
        match &binding.source {
            Ref::Step { step: dep } => {
                self.outputs
                    .get(dep)
                    .cloned()
                    .ok_or_else(|| FlowError::UnresolvedInput {
                        step: step.id.clone(),
                        reference: format!("step:{dep}"),
                        reason: "upstream output not available".to_string(),
                    })
            }
            Ref::Arg { arg } => {
                let value = self
                    .args
                    .get(arg)
                    .ok_or_else(|| FlowError::UnresolvedInput {
                        step: step.id.clone(),
                        reference: format!("arg:{arg}"),
                        reason: "missing in run args".to_string(),
                    })?;
                Ok(value_to_string(value))
            }
            Ref::Const { value } => Ok(value_to_string(value)),
        }
    }
}

/// Render a step's prompt by substituting `{name}` placeholders with resolved inputs.
/// Only [`StepKind::Llm`] is executed in P0; other kinds return [`FlowError::NotImplemented`].
fn render_prompt(
    kind: &StepKind,
    resolved: &BTreeMap<String, String>,
    step_id: &str,
) -> Result<String> {
    let template = match kind {
        StepKind::Llm {
            prompt_template, ..
        } => prompt_template,
        other => {
            return Err(FlowError::NotImplemented(format!(
                "{} (step {step_id})",
                other.tag()
            )))
        }
    };
    let mut prompt = template.clone();
    for (name, value) in resolved {
        prompt = prompt.replace(&format!("{{{name}}}"), value);
    }
    Ok(prompt)
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn make_run_id() -> String {
    format!("run-{}-{}", now_ms(), std::process::id())
}

/// Path to a run's manifest.
#[must_use]
pub fn manifest_path(run_dir: &std::path::Path) -> PathBuf {
    run_dir.join("run.json")
}

fn write_manifest(run_dir: &std::path::Path, manifest: &RunManifest) -> Result<()> {
    std::fs::create_dir_all(run_dir)
        .map_err(|e| FlowError::io(run_dir.display().to_string(), e))?;
    let path = manifest_path(run_dir);
    let bytes = serde_json::to_vec_pretty(manifest)?;
    std::fs::write(&path, bytes).map_err(|e| FlowError::io(path.display().to_string(), e))
}

/// Load a run's manifest by id.
///
/// # Errors
/// Returns [`FlowError::RunNotFound`] if the manifest does not exist.
pub fn read_manifest(run_id: &str) -> Result<RunManifest> {
    let path = manifest_path(&run_dir(run_id));
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(FlowError::RunNotFound(run_id.to_string()))
        }
        Err(e) => Err(FlowError::io(path.display().to_string(), e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::def::idea_pilot;
    use crate::provider::Completion;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

    static FS_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Deterministic offline completer: output is a hash of the prompt, so re-running
    /// a step with identical inputs yields an identical key (cache hit on resume).
    struct Fake {
        calls: Arc<AtomicUsize>,
    }
    impl Completer for Fake {
        fn complete(&self, prompt: &str) -> Result<Completion> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut hasher = Sha256::new();
            hasher.update(prompt.as_bytes());
            let digest = format!("{:x}", hasher.finalize());
            Ok(Completion {
                output: format!("ans-{}", &digest[..8]),
                usage: None,
            })
        }
        #[allow(clippy::unnecessary_literal_bound)]
        fn model(&self) -> &str {
            "fake"
        }
    }
    fn fake_factory(calls: Arc<AtomicUsize>) -> ProviderFactory {
        Box::new(move |_role| {
            Ok(Box::new(Fake {
                calls: calls.clone(),
            }) as Box<dyn Completer>)
        })
    }

    /// Isolate `.clawd-flows` to a unique temp dir AND serialize fs-touching tests
    /// (they share the process-global `ARIS_FLOW_HOME` env var).
    struct FlowHomeGuard {
        _lock: MutexGuard<'static, ()>,
    }
    impl FlowHomeGuard {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let lock = FS_TEST_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let home = std::env::temp_dir().join(format!(
                "flow-it-{}-{}-{n}",
                std::process::id(),
                now_ms()
            ));
            std::fs::create_dir_all(&home).unwrap();
            std::env::set_var("ARIS_FLOW_HOME", &home);
            FlowHomeGuard { _lock: lock }
        }
    }
    impl Drop for FlowHomeGuard {
        fn drop(&mut self) {
            std::env::remove_var("ARIS_FLOW_HOME");
        }
    }

    #[test]
    fn resume_reuses_cache_and_fork_reexecutes_from_step() {
        let _guard = FlowHomeGuard::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let args = serde_json::json!({ "topic": "unit-test topic" });

        // Fresh run: all 4 steps execute.
        let mut r1 =
            FlowRunner::fresh_with_factory(idea_pilot(), args, fake_factory(calls.clone()))
                .unwrap();
        let run_id = r1.run_id().to_string();
        let out1 = r1.run().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            4,
            "fresh run executes 4 steps"
        );
        assert!(out1.result.is_some());

        // Resume: every step is cached, so no new provider calls, identical result.
        let before = calls.load(Ordering::SeqCst);
        let mut r2 = FlowRunner::resume_with_factory(&run_id, fake_factory(calls.clone())).unwrap();
        let out2 = r2.run().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            before,
            "resume makes zero provider calls"
        );
        assert_eq!(
            out2.result, out1.result,
            "resume reproduces the result from cache"
        );

        // Fork from "novelty" (index 2): survey + brainstorm reused, novelty + review re-run.
        let before = calls.load(Ordering::SeqCst);
        let mut r3 =
            FlowRunner::fork_with_factory(&run_id, "novelty", fake_factory(calls.clone())).unwrap();
        let _ = r3.run().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            before + 2,
            "fork re-executes exactly the fork step and its downstream"
        );
    }

    #[test]
    fn fork_unknown_step_errors() {
        let _guard = FlowHomeGuard::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut r = FlowRunner::fresh_with_factory(
            idea_pilot(),
            serde_json::json!({ "topic": "t" }),
            fake_factory(calls.clone()),
        )
        .unwrap();
        let run_id = r.run_id().to_string();
        r.run().unwrap();
        let result = FlowRunner::fork_with_factory(&run_id, "nope", fake_factory(calls));
        assert!(matches!(result, Err(FlowError::UnknownStep(_))));
    }
}
