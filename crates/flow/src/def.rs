//! The reusable flow artifact: a DAG of typed steps that serializes to `flow.json`.
//!
//! P0 only *executes* [`StepKind::Llm`] steps, but the other variants are declared
//! now so the on-disk shape is stable for later phases (P1 heterogeneous agents,
//! P2 fan-out, P4 agent-team controller).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable identifier for a step within a flow (e.g. `"survey"`, `"review"`).
pub type StepId = String;

/// A complete, reusable flow definition. Serializes 1:1 to `flow.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowDef {
    /// Human-facing name; becomes the `/command` name when saved (P5).
    pub name: String,
    /// JSON-Schema-ish description of the `args` this flow accepts. Free-form in P0.
    #[serde(default)]
    pub args_schema: Value,
    /// Named roles. A role binds a model + provider + endpoint — the seam that lets
    /// different steps run on different models in P1.
    pub roles: BTreeMap<String, RoleRef>,
    /// The steps, in definition order. Edges are expressed via [`Binding`] sources.
    pub steps: Vec<Step>,
}

/// Binds a logical role name to a concrete model on a concrete provider endpoint.
///
/// `model` participates in every [`crate::store::StepKey`], so swapping a step's
/// model in P1 naturally invalidates only that step's (and downstream) cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleRef {
    /// Model id, e.g. `"MiniMax-M2.7"`.
    pub model: String,
    /// Provider tag, e.g. `"minimax"`. Routes to the right client in P1.
    pub provider: String,
    /// OpenAI-compatible base url, e.g. `"https://api.minimaxi.com/v1"`.
    pub base_url: String,
    /// Optional max output tokens for this role.
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// One node in the flow DAG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Stable id, unique within the flow.
    pub id: StepId,
    /// What this step does.
    pub kind: StepKind,
    /// Named inputs resolved before the step runs; referenced by name in templates.
    #[serde(default)]
    pub inputs: Vec<Binding>,
    /// How this step participates in the content-addressed cache.
    #[serde(default)]
    pub cache: CachePolicy,
}

/// The behaviour of a step. Only [`StepKind::Llm`] is executed in P0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StepKind {
    /// A single model completion. `prompt_template` may contain `{name}` placeholders
    /// matching this step's input bindings.
    Llm {
        /// Role name (key into [`FlowDef::roles`]).
        role: String,
        /// Prompt with `{binding_name}` placeholders.
        prompt_template: String,
    },
    /// P1: a full sub-agent (tools enabled) on the role's model.
    Agent {
        /// Role name.
        role: String,
        /// Prompt with `{binding_name}` placeholders.
        prompt_template: String,
    },
    /// P2: fan a template out across each element of an upstream list.
    Map {
        /// Binding name whose resolved value is a JSON array.
        over: String,
        /// Role name.
        role: String,
        /// Per-element prompt with `{item}` plus this step's bindings.
        prompt_template: String,
    },
    /// P2: combine multiple inputs into one result.
    Reduce {
        /// Role name.
        role: String,
        /// Prompt with `{binding_name}` placeholders.
        prompt_template: String,
    },
    /// P3: a human checkpoint that pauses the run.
    Gate {
        /// Message shown at the gate.
        prompt: String,
    },
    /// P4: a controller that decides the next step(s) at run time.
    Controller {
        /// Role name driving the decision.
        role: String,
    },
}

impl StepKind {
    /// Short tag used in error messages for not-yet-implemented kinds.
    #[must_use]
    pub fn tag(&self) -> &'static str {
        match self {
            StepKind::Llm { .. } => "llm",
            StepKind::Agent { .. } => "agent",
            StepKind::Map { .. } => "map",
            StepKind::Reduce { .. } => "reduce",
            StepKind::Gate { .. } => "gate",
            StepKind::Controller { .. } => "controller",
        }
    }
}

/// A named input to a step, sourced from an upstream step, a run `arg`, or a constant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// Template variable name (used as `{name}` in prompts).
    pub name: String,
    /// Where the value comes from.
    pub source: Ref,
}

/// A reference resolved into a string before a step runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum Ref {
    /// The output text of another step.
    Step {
        /// The upstream step id.
        step: StepId,
    },
    /// A value from the run's `args`, by top-level key.
    Arg {
        /// The arg key.
        arg: String,
    },
    /// A literal constant.
    Const {
        /// The literal value (stringified if not already a string).
        value: Value,
    },
}

/// How a step participates in the content-addressed cache.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CachePolicy {
    /// Cache by [`crate::store::StepKey`] (default). Reused on resume/fork.
    #[default]
    Keyed,
    /// Never reuse; always re-execute.
    Never,
}

/// The default MiniMax role used by [`idea_pilot`]. Pure (no env reads); the
/// provider applies `MINIMAX_BASE_URL` / `MINIMAX_MODEL` overrides at run time.
#[must_use]
pub fn default_minimax_role() -> RoleRef {
    RoleRef {
        model: "MiniMax-M2.7".to_string(),
        provider: "minimax".to_string(),
        base_url: "https://api.minimaxi.com/v1".to_string(),
        // Headroom: M2.7 spends tokens on <think> before the answer. Paired with
        // reasoning_effort=low in the provider, a hard prompt lands ~1.8k tokens.
        max_tokens: Some(8192),
    }
}

/// The P0 pilot flow: survey → brainstorm → novelty → review, mirroring the shape
/// of the `idea-discovery` skill but self-contained on a single MiniMax role.
///
/// The research topic is supplied at run time as `args.topic`.
#[must_use]
pub fn idea_pilot() -> FlowDef {
    let role = "researcher".to_string();
    let mut roles = BTreeMap::new();
    roles.insert(role.clone(), default_minimax_role());

    let arg_topic = || Binding {
        name: "topic".to_string(),
        source: Ref::Arg {
            arg: "topic".to_string(),
        },
    };
    let from_step = |name: &str, step: &str| Binding {
        name: name.to_string(),
        source: Ref::Step {
            step: step.to_string(),
        },
    };

    let steps = vec![
        Step {
            id: "survey".to_string(),
            kind: StepKind::Llm {
                role: role.clone(),
                prompt_template: "You are a research surveyor. In 4-6 concise bullet \
                    points, survey the key methods and the main open problems for: \
                    {topic}."
                    .to_string(),
            },
            inputs: vec![arg_topic()],
            cache: CachePolicy::Keyed,
        },
        Step {
            id: "brainstorm".to_string(),
            kind: StepKind::Llm {
                role: role.clone(),
                prompt_template: "Topic: {topic}\n\nSurvey:\n{survey}\n\nPropose exactly 3 \
                    novel research ideas. For each, give a one-line idea and one line on \
                    why it is new relative to the survey."
                    .to_string(),
            },
            inputs: vec![arg_topic(), from_step("survey", "survey")],
            cache: CachePolicy::Keyed,
        },
        Step {
            id: "novelty".to_string(),
            kind: StepKind::Llm {
                role: role.clone(),
                prompt_template: "Critically assess the novelty of each idea below. For \
                    each, state LIKELY-NOVEL or LIKELY-EXISTS with one sentence of \
                    justification.\n\nIdeas:\n{ideas}"
                    .to_string(),
            },
            inputs: vec![from_step("ideas", "brainstorm")],
            cache: CachePolicy::Keyed,
        },
        Step {
            id: "review".to_string(),
            kind: StepKind::Llm {
                role,
                prompt_template: "You are an adversarial reviewer. Given the ideas and the \
                    novelty assessment, pick the single most promising idea and give a \
                    3-sentence go/no-go verdict.\n\nIdeas:\n{ideas}\n\nNovelty:\n{novelty}"
                    .to_string(),
            },
            inputs: vec![
                from_step("ideas", "brainstorm"),
                from_step("novelty", "novelty"),
            ],
            cache: CachePolicy::Keyed,
        },
    ];

    FlowDef {
        name: "idea-pilot".to_string(),
        args_schema: serde_json::json!({
            "type": "object",
            "properties": { "topic": { "type": "string" } },
            "required": ["topic"]
        }),
        roles,
        steps,
    }
}

impl FlowDef {
    /// Look up a step by id.
    #[must_use]
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// Validate that the flow is a runnable DAG: unique ids, every `Ref::Step`
    /// points at a real earlier step, and roles referenced by steps exist.
    ///
    /// Steps are required to appear in topological order (a step may only
    /// reference steps defined before it), which keeps the P0 serial runner simple.
    ///
    /// # Errors
    /// Returns [`crate::FlowError::InvalidGraph`] / [`crate::FlowError::UnknownStep`].
    pub fn validate(&self) -> crate::Result<()> {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for step in &self.steps {
            if !seen.insert(step.id.as_str()) {
                return Err(crate::FlowError::InvalidGraph(format!(
                    "duplicate step id: {}",
                    step.id
                )));
            }
            if let Some(role) = step_role(&step.kind) {
                if !self.roles.contains_key(role) {
                    return Err(crate::FlowError::InvalidGraph(format!(
                        "step {} references undefined role {role}",
                        step.id
                    )));
                }
            }
            for binding in &step.inputs {
                if let Ref::Step { step: dep } = &binding.source {
                    if !seen.contains(dep.as_str()) {
                        return Err(crate::FlowError::InvalidGraph(format!(
                            "step {} references step {dep} which is not defined earlier",
                            step.id
                        )));
                    }
                }
            }
        }
        Ok(())
    }
}

/// The role name a step runs under, if any.
#[must_use]
pub fn step_role(kind: &StepKind) -> Option<&str> {
    match kind {
        StepKind::Llm { role, .. }
        | StepKind::Agent { role, .. }
        | StepKind::Map { role, .. }
        | StepKind::Reduce { role, .. }
        | StepKind::Controller { role } => Some(role.as_str()),
        StepKind::Gate { .. } => None,
    }
}
