---
name: research-review
description: Get a deep critical review of research from GPT via Codex MCP and, when requested, produce a standardized LaTeX review report. Use when user says "review my research", "help me review", "get external review", "审稿报告", "LaTeX review report", or wants critical feedback on research ideas, papers, experimental results, or manuscript submissions.
argument-hint: [topic-or-scope]
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit, Agent, mcp__codex__codex, mcp__codex__codex-reply
---

# Research Review via Codex MCP

Run a multi-round critical review of research work with an external high-reasoning reviewer. For formal manuscript reviews, produce the final report from the bundled LaTeX template so every report uses the same structure, scoring language, issue taxonomy, and appendix layout.

## Constants

- `REVIEWER_MODEL = gpt-5.5` - Model used via Codex MCP. Must be an OpenAI model, such as `gpt-5.5`, `o3`, or `gpt-4o`.
- `REVIEWER_BACKEND = codex` - Default Codex MCP reviewer. Override with `-- reviewer: oracle-pro` for GPT-5.4 Pro via Oracle MCP. See `../shared-references/reviewer-routing.md`.
- `LATEX_REPORT_TEMPLATE = templates/research_review_report.tex` - Canonical formal review report template.
- `LATEX_REPORT_ENGINE = xelatex` - Required for Chinese/English mixed reports. Prefer `latexmk -xelatex` when available.
- `DEFAULT_REPORT_DIR = .aris/reviews/<paper-slug>/` - Use when the user does not specify an output directory.

## Context: $ARGUMENTS

## Output Modes

- **Quick critical review**: Return concise Markdown and save reviewer traces when external review is used.
- **Formal manuscript review report**: Create a `.tex` report from `templates/research_review_report.tex`; compile to PDF when a LaTeX engine is available.
- **Template or format maintenance**: If the user asks to standardize review reports, update this skill and the bundled template rather than creating an ad hoc report file.

## Prerequisites

- Codex MCP should expose `mcp__codex__codex` and `mcp__codex__codex-reply`.
- If Codex MCP is unavailable, run the same review loop locally and preserve the same deliverable structure.
- For LaTeX reports, use UTF-8 source and `xelatex`. If no LaTeX engine is available, still save the `.tex` source and state that compilation was not run.

## Workflow

### Step 1: Gather Research Context

Before calling the external reviewer, compile a comprehensive briefing:

1. Read project narrative documents, such as `STORY.md`, `README.md`, paper drafts, rebuttals, supplements, code notes, and result logs.
2. Read memory/notes files for key findings and experiment history.
3. Identify the core claims, method, evidence, known weaknesses, target venue, and review questions.
4. For manuscript reports, also identify the LaTeX/PDF source, code/data availability, cited-paper list, and any literature-search artifacts.

### Step 2: Initial Review

Send a detailed prompt with xhigh reasoning:

```yaml
mcp__codex__codex:
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    [Full research context + specific questions]
    Please act as a senior ML reviewer (NeurIPS/ICML level unless a venue is specified). Identify:
    1. Logical gaps or unjustified claims
    2. Missing experiments that would strengthen the story
    3. Narrative weaknesses
    4. Whether the contribution is sufficient for the target venue
    Please be brutally honest and actionable.
```

### Step 3: Iterative Dialogue

Use `mcp__codex__codex-reply` with the returned `threadId` to continue the conversation.

For each round:

1. Respond to criticisms with evidence or counterarguments.
2. Ask targeted follow-ups on the most actionable points.
3. Request specific deliverables: experiment designs, claims matrices, paper outlines, or mock venue reviews.

Useful follow-up prompts:

- "If we reframe X as Y, does that change your assessment?"
- "What is the minimum experiment to satisfy concern Z?"
- "Please design the minimal additional experiment package with the highest acceptance lift per GPU week."
- "Please write a mock NeurIPS/ICML/NCAA review with scores."
- "Give me a results-to-claims matrix for possible experimental outcomes."

### Step 4: Converge

Stop iterating when:

- The core claims and their evidence requirements are clear.
- A concrete experiment or revision plan is established.
- The narrative structure and likely reviewer objections are settled.

### Step 5: Document

For quick reviews, save a self-contained Markdown review document with:

- Round-by-round summary of criticisms and responses
- Final consensus on claims, narrative, and experiments
- Claims matrix
- Prioritized TODO list with estimated compute costs
- Paper outline if discussed

For formal LaTeX reports:

1. Copy `templates/research_review_report.tex` to `.aris/reviews/<paper-slug>/<YYYY-MM-DD>_review_report.tex` unless the user specifies another path.
2. Fill the metadata commands at the top: title, short name, venue, manuscript id, reviewer name, date, recommendation, score, confidence, and review scope.
3. Fill the required sections below in order. Omit a section only when it truly does not apply, and leave a one-sentence "not evaluated" note when evidence is unavailable.
4. Keep every evidence-bearing criticism traceable to manuscript sections, equations, tables, figures, experiments, cited papers, or external-review trace excerpts.
5. Compile with `latexmk -xelatex -interaction=nonstopmode -halt-on-error <report>.tex` when available. Fallback to two `xelatex -interaction=nonstopmode -halt-on-error <report>.tex` passes.

Update project memory/notes with key review conclusions when the project uses memory files.

## Required LaTeX Report Sections

Use this plan for formal paper-review reports. Keep section names stable unless the user requests a venue-specific format.

1. **摘要与审稿结论** - State the manuscript, review scope, top evidence, final recommendation, confidence, and 3-5 decisive reasons.
2. **稿件信息与审查范围** - Record paper title, venue, manuscript id, reviewed files, code/data/supplement availability, literature-search sources, external reviewer backend, and known limitations.
3. **文献检索与创新性审查** - Describe search strategy, date, databases, query families, screening rules, number of hits/selected papers, and closest prior work. Do not claim novelty without verified citations.
4. **论文主张与创新点评估** - Convert author-stated contributions into a claims table with evidence, overlap with prior work, support level, and required fixes.
5. **方法与逻辑审查** - Check problem formulation, assumptions, method pipeline, loss/objective consistency, ablations implied by the method, and chapter-to-chapter reasoning.
6. **理论与数学审查** - Check definitions, notation, theorem/proposition validity, proof gaps, optimization claims, complexity, convergence, and unsupported theoretical language.
7. **实验与实证严谨性审查** - Check datasets, splits, baselines, metrics, statistical testing, sensitivity studies, compute budget, reproducibility, and whether results support each claim.
8. **写作、图表与可读性审查** - Check structure, language, terminology consistency, figure/table quality, missing explanations, and venue-style issues.
9. **外部 LLM 审查摘要** - Include only if an external reviewer was used. Summarize thread id, model/backend, strongest independent criticisms, disagreements, and how they affected the final decision.
10. **综合评价与修改清单** - Provide strengths, major issues, moderate issues, minor issues, required revisions by priority, final recommendation, and review limitations.
11. **附录 A: 文献检索记录** - Include queries, selected references, bibliographic keys, and verification notes.
12. **附录 B: 证据矩阵** - Map every major criticism to source evidence and required author action.
13. **附录 C: 外部审查追踪摘要** - Include trace path and concise excerpts or summaries; do not paste unbounded raw transcripts into the report body.

## Issue Taxonomy

Each reported issue should include:

- **Severity**: Major, Moderate, or Minor
- **Evidence**: manuscript location, experiment/table/figure/equation, citation, or trace reference
- **Impact**: why it affects acceptance, correctness, novelty, reproducibility, or readability
- **Required action**: minimum author response or experiment needed to resolve it
- **Confidence**: High, Medium, or Low

## Key Rules

- Always use `config: {"model_reasoning_effort": "xhigh"}` for external reviews.
- Send comprehensive context in Round 1; the external model cannot read local files.
- Be honest about weaknesses. Push back on criticisms you disagree with, but accept valid ones.
- Focus on actionable feedback: ask what experiment, analysis, rewrite, or citation would fix the problem.
- Document the `threadId` for potential future resumption.
- Make review documents self-contained.
- Do not mix template/preamble changes with report-content changes unless the user asked to modify the format.
- Do not fabricate literature-search counts, citations, DOI metadata, reviewer traces, or experiment results. Mark missing evidence explicitly.

## Prompt Templates

### Initial review

"I'm going to present a complete ML research project for your critical review. Please act as a senior reviewer for [venue]. Identify logical gaps, unsupported claims, missing experiments, narrative weaknesses, and whether the contribution is sufficient. Be specific and actionable."

### Experiment design

"Please design the minimal additional experiment package that gives the highest acceptance lift per GPU week. Our compute: [describe]. Be specific about configurations, datasets, metrics, and success/failure interpretations."

### Paper structure

"Please turn this into a concrete paper outline with section-by-section claims, figure/table plan, and where each claim is supported."

### Claims matrix

"Please give me a results-to-claims matrix: what claim is allowed under each possible outcome of experiments X and Y?"

### Mock review

"Please write a mock [venue] review with Summary, Strengths, Weaknesses, Questions for Authors, Score, Confidence, and What Would Move Toward Accept."

## Review Tracing

After each `mcp__codex__codex` or `mcp__codex__codex-reply` reviewer call, save the trace following `../shared-references/review-tracing.md` (Policy C - forensic; never silently skip). Use `save_trace.sh` resolved per `../shared-references/integration-contract.md` section 2, or write files directly to `.aris/traces/research-review/<date>_run<NN>/`. Respect the `--- trace:` parameter, defaulting to `full`.
