//! Reader-facing explanations with durable, source-bound Chat attempts.
//! These are executor drafts; no task or model response can grant review status.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeSet;

pub const GUIDE_PROTOCOL: &str = "paper-guide-v1";
pub const MAX_GUIDE_TOPICS: usize = 8;
pub const MAX_GUIDE_ATTEMPTS: usize = 3;
fn default_attempt_limit() -> usize {
    MAX_GUIDE_ATTEMPTS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideTaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideEvidence {
    /// PDF page number, starting at one (as displayed in the reader).
    pub page: usize,
    pub image_sha256: Option<String>,
    pub text_sha256: Option<String>,
    pub text_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideAttempt {
    pub session_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub evidence: Vec<GuideEvidence>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideTask<T> {
    pub status: GuideTaskStatus,
    pub result: Option<T>,
    pub attempts: Vec<GuideAttempt>,
    #[serde(default = "default_attempt_limit")]
    pub attempt_limit: usize,
    pub error: Option<String>,
}

impl<T> Default for GuideTask<T> {
    fn default() -> Self {
        Self {
            status: GuideTaskStatus::Pending,
            result: None,
            attempts: vec![],
            attempt_limit: MAX_GUIDE_ATTEMPTS,
            error: None,
        }
    }
}

impl<T> GuideTask<T> {
    /// Called only by an explicit user continuation, never by the automatic driver.
    pub fn reopen_exhausted_attempts(&mut self) {
        if self.status != GuideTaskStatus::Completed && self.attempts.len() >= self.attempt_limit {
            self.attempt_limit = self.attempts.len().saturating_add(MAX_GUIDE_ATTEMPTS);
        }
    }

    pub fn resume(&mut self) {
        if self.status == GuideTaskStatus::Running {
            self.interrupt("interrupted");
        }
        if self.status != GuideTaskStatus::Completed {
            self.status = if self.attempts.len() < self.attempt_limit {
                GuideTaskStatus::Pending
            } else {
                GuideTaskStatus::Failed
            };
        }
    }

    pub fn begin(
        &mut self,
        session_id: String,
        evidence: Vec<GuideEvidence>,
    ) -> Result<(), String> {
        if self.status != GuideTaskStatus::Pending
            || self.attempts.len() >= self.attempt_limit
            || session_id.is_empty()
        {
            return Err("Explanation task is not eligible for another attempt".into());
        }
        if evidence.is_empty() || !evidence.iter().any(|item| item.image_sha256.is_some()) {
            return Err("Explanation requires original page images, not perception drafts".into());
        }
        self.status = GuideTaskStatus::Running;
        self.error = None;
        self.attempts.push(GuideAttempt {
            session_id,
            started_at: crate::now_iso8601(),
            finished_at: None,
            status: "running".into(),
            evidence,
            error: None,
        });
        Ok(())
    }

    pub fn finish(&mut self, session_id: &str, result: Result<T, String>) -> Result<(), String> {
        let attempt = self
            .attempts
            .last_mut()
            .ok_or("Missing explanation attempt")?;
        if self.status != GuideTaskStatus::Running || attempt.session_id != session_id {
            return Err("Explanation attempt is stale or cancelled".into());
        }
        attempt.finished_at = Some(crate::now_iso8601());
        match result {
            Ok(result) => {
                self.result = Some(result);
                self.status = GuideTaskStatus::Completed;
                attempt.status = "completed".into();
            }
            Err(error) => {
                let error: String = error.chars().take(2000).collect();
                self.status = GuideTaskStatus::Failed;
                self.error = Some(error.clone());
                attempt.status = "failed".into();
                attempt.error = Some(error);
            }
        }
        Ok(())
    }

    /// Only rejected model output is eligible for automatic retry.
    pub fn retry_invalid_output(&mut self, received_output: bool) {
        if received_output
            && self.status == GuideTaskStatus::Failed
            && self.attempts.len() < self.attempt_limit
        {
            self.status = GuideTaskStatus::Pending;
        }
    }

    pub fn interrupt(&mut self, reason: &str) {
        if self.status == GuideTaskStatus::Running {
            if let Some(attempt) = self.attempts.last_mut() {
                attempt.finished_at = Some(crate::now_iso8601());
                attempt.status = reason.into();
            }
            self.status = GuideTaskStatus::Pending;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideSectionKind {
    Problem,
    Method,
    Evidence,
    Limitations,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideSection {
    pub kind: GuideSectionKind,
    pub content: String,
    pub source_pages: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideTopicKind {
    Figure,
    Formula,
    Experiment,
    Concept,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideTopic {
    pub kind: GuideTopicKind,
    pub title: String,
    pub learning_goal: String,
    pub source_pages: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideOutline {
    pub overview: Vec<GuideSection>,
    pub topics: Vec<GuideTopic>,
    pub cautions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplanationOrigin {
    Paper,
    Teaching,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationStep {
    pub title: String,
    pub explanation: String,
    pub origin: ExplanationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideLesson {
    pub intuition: String,
    pub notation: String,
    pub assumptions: String,
    pub steps: Vec<ExplanationStep>,
    /// An explicitly illustrative teaching example, never a claimed paper experiment.
    pub example: Option<String>,
    pub evidence: String,
    pub check_question: String,
    pub check_answer: String,
    pub source_pages: Vec<usize>,
    pub cautions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideLessonTask {
    pub topic: GuideTopic,
    pub task: GuideTask<GuideLesson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperGuide {
    pub protocol_version: String,
    pub outline: GuideTask<GuideOutline>,
    pub lessons: Vec<GuideLessonTask>,
}

impl Default for PaperGuide {
    fn default() -> Self {
        Self {
            protocol_version: GUIDE_PROTOCOL.into(),
            outline: GuideTask::default(),
            lessons: vec![],
        }
    }
}

impl PaperGuide {
    pub fn resume(&mut self) -> Result<(), String> {
        if self.protocol_version != GUIDE_PROTOCOL {
            return Err("Explanation protocol changed; a new explanation is required".into());
        }
        self.outline.resume();
        for lesson in &mut self.lessons {
            lesson.task.resume();
        }
        Ok(())
    }

    pub fn cancel(&mut self) {
        self.outline.interrupt("cancelled");
        for lesson in &mut self.lessons {
            lesson.task.interrupt("cancelled");
        }
    }

    pub fn complete(&self) -> bool {
        self.outline.status == GuideTaskStatus::Completed
            && !self.lessons.is_empty()
            && self
                .lessons
                .iter()
                .all(|lesson| lesson.task.status == GuideTaskStatus::Completed)
    }

    pub fn finish_outline(
        &mut self,
        session_id: &str,
        result: Result<GuideOutline, String>,
    ) -> Result<(), String> {
        self.outline.finish(session_id, result)?;
        if let Some(outline) = &self.outline.result {
            self.lessons = outline
                .topics
                .iter()
                .cloned()
                .map(|topic| GuideLessonTask {
                    topic,
                    task: GuideTask::default(),
                })
                .collect();
        }
        Ok(())
    }

    pub fn fail_active(&mut self, error: &str) {
        if self.outline.status == GuideTaskStatus::Running {
            if let Some(attempt) = self.outline.attempts.last() {
                let id = attempt.session_id.clone();
                let _ = self.outline.finish(&id, Err(error.into()));
            }
        }
        for lesson in &mut self.lessons {
            if lesson.task.status == GuideTaskStatus::Running {
                if let Some(attempt) = lesson.task.attempts.last() {
                    let id = attempt.session_id.clone();
                    let _ = lesson.task.finish(&id, Err(error.into()));
                }
            }
        }
    }
}

fn parse<T: DeserializeOwned>(text: &str) -> Result<T, String> {
    if text.len() > 128 * 1024 {
        return Err("Explanation output exceeds its size budget".into());
    }
    let text = text.trim();
    let json = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|body| body.trim().strip_suffix("```"))
        .unwrap_or(text)
        .trim();
    serde_json::from_str(json).map_err(|error| format!("Invalid explanation JSON: {error}"))
}

/// Accept the observed source-bearing caution shape without losing its citations.
/// Other field types and unknown keys remain strict; no arbitrary JSON is flattened.
fn parse_with_cautions<T: DeserializeOwned>(
    text: &str,
    supplied_pages: &[usize],
) -> Result<T, String> {
    let mut value: serde_json::Value = parse(text)?;
    let supplied = supplied_pages.iter().copied().collect::<BTreeSet<_>>();
    if let Some(cautions) = value
        .get_mut("cautions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for (index, item) in cautions.iter_mut().enumerate() {
            if item.is_string() {
                continue;
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct CitedCaution {
                content: String,
                source_pages: Vec<usize>,
            }
            let caution: CitedCaution = serde_json::from_value(item.clone())
                .map_err(|error| format!("cautions[{index}]: expected a string or {{content: string, sourcePages: number[]}}: {error}"))?;
            if !text_bound(&caution.content, 1500)
                || !pages_valid(&caution.source_pages, &supplied, supplied.len())
            {
                return Err(format!("cautions[{index}]: content must be nonempty and sourcePages must be unique supplied original pages"));
            }
            let pages = caution
                .source_pages
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            *item = serde_json::Value::String(format!("{}\n\n(PDF: {pages})", caution.content));
        }
    }
    serde_json::from_value(value).map_err(|error| format!("Invalid explanation JSON: {error}"))
}

fn text_bound(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}
fn pages_valid(pages: &[usize], available: &BTreeSet<usize>, max: usize) -> bool {
    !pages.is_empty()
        && pages.len() <= max
        && pages.iter().all(|page| available.contains(page))
        && pages.iter().collect::<BTreeSet<_>>().len() == pages.len()
}
fn cautions_valid(cautions: &[String]) -> bool {
    cautions.len() <= 12 && cautions.iter().all(|text| text_bound(text, 1500))
}

pub fn parse_outline(
    text: &str,
    total_pages: usize,
    supplied_pages: &[usize],
) -> Result<GuideOutline, String> {
    let result: GuideOutline = parse_with_cautions(text, supplied_pages)?;
    let supplied: BTreeSet<usize> = supplied_pages.iter().copied().collect();
    let all: BTreeSet<usize> = (1..=total_pages).collect();
    let kinds: BTreeSet<_> = result.overview.iter().map(|section| section.kind).collect();
    if result.overview.len() < 3
        || result.overview.len() > 4
        || kinds.len() != result.overview.len()
        || ![
            GuideSectionKind::Problem,
            GuideSectionKind::Method,
            GuideSectionKind::Evidence,
        ]
        .iter()
        .all(|kind| kinds.contains(kind))
        || result.topics.is_empty()
        || result.topics.len() > MAX_GUIDE_TOPICS
        || result.topics.iter().any(|topic| {
            !text_bound(&topic.title, 200)
                || !text_bound(&topic.learning_goal, 1000)
                || !pages_valid(&topic.source_pages, &all, 4)
        })
        || !cautions_valid(&result.cautions)
    {
        return Err(
            "Explanation outline has invalid content or cites original pages not supplied".into(),
        );
    }
    for (index, section) in result.overview.iter().enumerate() {
        if !text_bound(&section.content, 5000) {
            return Err(format!(
                "overview[{index}].content must contain 1..5000 characters"
            ));
        }
        if !pages_valid(&section.source_pages, &supplied, supplied.len()) {
            return Err(format!("overview[{index}].sourcePages must be nonempty, unique, and refer only to original evidence supplied in this turn"));
        }
    }
    Ok(result)
}

pub fn parse_lesson(text: &str, supplied_pages: &[usize]) -> Result<GuideLesson, String> {
    let result: GuideLesson = parse_with_cautions(text, supplied_pages)?;
    // Legacy saved lessons may omit examples; newly generated lessons must include one.
    if !result
        .example
        .as_ref()
        .is_some_and(|text| text_bound(text, 8000))
    {
        return Err("example: include a simple worked teaching problem with givens, a question, step-by-step solution, answer, and connection to this topic (one nonempty Markdown string, at most 8000 characters)".into());
    }
    let supplied = supplied_pages.iter().copied().collect();
    if !text_bound(&result.intuition, 6000)
        || result.notation.chars().count() > 6000
        || result.assumptions.chars().count() > 6000
        || result.steps.is_empty()
        || result.steps.len() > 8
        || result
            .steps
            .iter()
            .any(|step| !text_bound(&step.title, 250) || !text_bound(&step.explanation, 6000))
        || result
            .example
            .as_ref()
            .is_some_and(|text| !text_bound(text, 8000))
        || !text_bound(&result.evidence, 6000)
        || !text_bound(&result.check_question, 2000)
        || !text_bound(&result.check_answer, 4000)
        || !pages_valid(&result.source_pages, &supplied, 4)
        || !cautions_valid(&result.cautions)
    {
        return Err(
            "Explanation lesson has invalid content or cites original pages not supplied".into(),
        );
    }
    Ok(result)
}

pub fn outline_prompt(language: &str, total_pages: usize) -> String {
    format!(
        r#"Build a reader-facing guide to this AI/ML paper, in language {language}. The reader knows basic ML but has not read this paper. Explain the research problem, the method's causal story, and what the experiments support. This is not transcription or a generic summary.
Use ONLY the original evidence supplied below for overview claims. A derived page inventory is only a retrieval index and may contain errors; it cannot establish facts. Source page numbers start at 1; the document has {total_pages} pages. Overview citations MUST refer to supplied original material. Topics may request 1–4 pages from this document to read in their next turn.
Select 3–6 important teaching topics (at most 8). Cover a method/architecture figure, a central formula or reasoning difficulty, and an experimental table when present. Prefer substantive method pages to appendix illustrations. Do not manufacture modalities absent from the paper. Each topic should answer one reader question and its sourcePages must include the original figure/formula/table and necessary definitions or adjacent context. Keep learningGoal to one short sentence; it is a learning objective, not the lesson itself.
Return ONLY JSON matching this schema, without extra keys:
{{"overview":[{{"kind":"problem|method|evidence|limitations","content":"reader-facing explanation","sourcePages":[1]}}],"topics":[{{"kind":"figure|formula|experiment|concept","title":"question or concept","learningGoal":"what the reader should understand","sourcePages":[1]}}],"cautions":[]}}
FORMAT CONTRACT: overview content, topic title and learningGoal are strings. cautions is an array of strings, e.g. ["The datasets differ; see PDF pages 12 and 15"], never objects. sourcePages contains integer page numbers. Return JSON without a code fence.
Use exactly one kind per entry. Include problem, method and evidence overview sections; limitations is optional when supported by source. Preserve scope, assumptions, baselines and dataset/split distinctions. If sources disagree or the input is incomplete, state the concrete uncertainty. No Reviewer verdicts, adaptive reader claims, or recognition-completeness claims. Math uses LaTeX $...$ or multiline $$ delimiters with correct JSON escaping."#
    )
}

pub fn lesson_prompt(language: &str, topic: &GuideTopic) -> String {
    format!(
        r#"Teach one topic from the attached original paper pages in language {language}. Topic metadata is a proposed learning goal, not evidence: {}
Read the ORIGINAL images and text again. Do not rely on a perception transcript. Explain what the visual elements or symbols mean, how the mechanism works step by step, and why this topic matters to the paper's argument. For figures, follow actual boxes/arrows/axes and relate them to the method. For formulas, retain variable definitions and assumptions, explain each step and distinguish paper statements from teaching derivations. For experimental tables, explicitly match row AND column headers, metric, split, units and baseline; a blank or merged cell is not a guessed number. If a value cannot be read confidently, say so and omit a numerical conclusion based on it.
Return ONLY JSON with these fields and no extras:
{{"intuition":"plain-language intuition","notation":"symbols or visual legend; empty if not applicable","assumptions":"conditions and scope","steps":[{{"title":"step title","explanation":"explanation with math where helpful","origin":"paper|teaching"}}],"example":"a required simple worked teaching problem: givens, question, step-by-step solution, answer, and connection to the paper; NOT a claimed paper experiment","evidence":"what the original evidence supports, and what it does not establish","checkQuestion":"one short understanding question","checkAnswer":"answer and why","sourcePages":[1],"cautions":[]}}
FORMAT CONTRACT: intuition, notation, assumptions, evidence, checkQuestion, checkAnswer, each step's title and explanation MUST be JSON strings, never objects or arrays. example MUST be a nonempty Markdown string, never null or an object. Only steps, sourcePages and cautions are arrays. cautions contains strings only, e.g. ["This comparison uses different datasets"], not objects. For notation or assumptions lists, put Markdown bullets separated by JSON newline escapes inside ONE string. Escape Markdown exactly once for JSON: the JSON string "$\\sqrt{{d}}$" decodes to the Markdown formula $\sqrt{{d}}$; use \n for newlines, not \\n. Return JSON without a code fence.
All sourcePages must be among the actual supplied pages. Use 3–6 substantive steps, each with exact origin paper or teaching. Clearly distinguish intuitive analogy, illustrative numeric examples and added derivation from the paper's original results. Any step adding a mathematical justification or analogy beyond the page is teaching, even if it starts from a paper formula. Keep the explanation concrete; avoid generic advice. Formula notation uses correctly grouped LaTeX in $...$ or multiline $$...$$. Use math delimiters around symbolic expressions so the reader can see rendered formulas.
Every selected topic is a key understanding difficulty and MUST include one SIMPLE worked problem in example. Use short Markdown subheadings in the requested language: Givens and question / Step-by-step solution / Answer / Connection to the paper. Choose tiny inputs (e.g. two or three values, a small vector, or a short sequence) and show substituted numbers and intermediate results, not just an analogy or instructions to try it. For conceptual or figure topics, use a concrete input and trace it through the mechanism; arithmetic is not required when inappropriate. For experimental topics, use clearly invented teaching data to demonstrate how to interpret the metric or comparison, without inventing paper results. Explicitly label all constructed numbers and simplifications as teaching choices, preserve the method's relevant assumptions, and explain what the toy problem does NOT establish. The problem must be solvable using this lesson alone. checkQuestion is a separate short transfer question, not a substitute for the worked solution.
Before returning, check your explanation's consistency against the originals and recompute any example arithmetic. State the exact assumptions required by a derivation, and carry them into the intuition and checkAnswer too. A variance calculation, asymptotic bound, motivation, or observation does NOT prove guaranteed training behavior, accuracy, runtime, or generalization. Distinguish a fixed illustrative vector from a random variable distribution; do not claim a fixed vector satisfies distributional assumptions. Distinguish training from inference. Do not turn the paper's 'suspect', 'may', or 'similar' into a theorem. If a derivation, number, or interpretation cannot be justified, omit that claim and say what remains uncertain. Do not fabricate experiments, complete a proof beyond evidence without labeling it, or claim independent review."#,
        serde_json::to_string(topic).unwrap_or_default()
    )
}

#[cfg(test)]
#[path = "tests/paper_guide.rs"]
mod tests;
