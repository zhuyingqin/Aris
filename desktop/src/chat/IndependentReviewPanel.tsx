import type { Language } from "../store";
import type { IndependentReviewResult } from "../api/tauri";
import type { IndependentReviewState } from "./useIndependentReview";

function verdictLabel(result: IndependentReviewResult, language: Language) {
  const labels = language === "cn"
    ? { pass: "通过", revise: "需要修订", needs_user: "需要用户决策", unavailable: "审查不可用" }
    : { pass: "Passed", revise: "Revision required", needs_user: "Needs user", unavailable: "Review unavailable" };
  return labels[result.verdict];
}

function phaseLabel(state: IndependentReviewState, language: Language) {
  if (language === "cn") {
    if (state.phase === "reviewing") return "独立审查中";
    if (state.phase === "revising") return `Executor 修订中 ${state.revision}/${state.maxRevisions}`;
    return "独立审查已完成";
  }
  if (state.phase === "reviewing") return "Independent review in progress";
  if (state.phase === "revising") return `Executor revising ${state.revision}/${state.maxRevisions}`;
  return "Independent review complete";
}

export default function IndependentReviewPanel({
  state,
  language,
  onClear,
}: {
  state: IndependentReviewState;
  language: Language;
  onClear?: () => void;
}) {
  const latest = state.rounds[state.rounds.length - 1]?.result;
  const copy = language === "cn"
    ? {
      title: "独立 Reviewer",
      independent: "独立身份",
      executor: "Executor",
      reviewer: "Reviewer",
      issues: "发现的问题",
      checked: "已核查证据",
      missing: "缺失检查",
      instructions: "修订要求",
      clear: "清除审查记录",
      clearBusy: "审查运行时不能清除，请先停止当前任务。",
      waiting: "Reviewer 正在对照请求、工具证据、工作区文件和成功标准寻找反例。",
      exhausted: "已达到最多两轮自动修订，剩余问题不会被伪装成已通过。",
    }
    : {
      title: "Independent Reviewer",
      independent: "Independent identity",
      executor: "Executor",
      reviewer: "Reviewer",
      issues: "Issues found",
      checked: "Evidence checked",
      missing: "Missing checks",
      instructions: "Revision instructions",
      clear: "Clear review history",
      clearBusy: "Stop the current task before clearing an active review.",
      waiting: "The Reviewer is checking the request, tool evidence, workspace files, and success criteria for counterexamples.",
      exhausted: "The two automatic revision rounds are exhausted; unresolved issues are not presented as passed.",
    };

  return (
    <div className="independent-review-panel">
      <header className="independent-review-head">
        <div>
          <span className="independent-review-eyebrow">{copy.independent}</span>
          <h2>{copy.title}</h2>
        </div>
        <div className="independent-review-head-actions">
          <span className={`independent-review-phase phase-${state.phase}`}>{phaseLabel(state, language)}</span>
          {onClear && (
            <button
              type="button"
              className="independent-review-clear"
              onClick={onClear}
              disabled={state.phase === "reviewing" || state.phase === "revising"}
              title={state.phase === "reviewing" || state.phase === "revising" ? copy.clearBusy : copy.clear}
            >
              {copy.clear}
            </button>
          )}
        </div>
      </header>

      {!latest ? (
        <div className="independent-review-waiting">
          <span className="independent-review-spinner" aria-hidden="true" />
          <p>{copy.waiting}</p>
        </div>
      ) : (
        <div className="independent-review-scroll">
          <section className="independent-review-identity">
            <div><span>{copy.executor}</span><strong>{latest.executorProvider} / {latest.executorModel}</strong></div>
            <div><span>{copy.reviewer}</span><strong>{latest.reviewerProvider || "—"} / {latest.reviewerModel || "—"}</strong></div>
          </section>

          <section className={`independent-review-verdict verdict-${latest.verdict}`}>
            <span>{verdictLabel(latest, language)}</span>
            <p>{latest.summary}</p>
            {latest.exhausted && <small>{copy.exhausted}</small>}
          </section>

          {state.rounds.map((round) => (
            <details key={round.attempt} className="independent-review-round" open={round.attempt === state.rounds[state.rounds.length - 1]?.attempt}>
              <summary>
                <span>Review {round.attempt}</span>
                <strong className={`verdict-${round.result.verdict}`}>{verdictLabel(round.result, language)}</strong>
              </summary>
              <div className="independent-review-round-body">
                {round.result.issues.length > 0 && (
                  <section>
                    <h3>{copy.issues}</h3>
                    {round.result.issues.map((issue, index) => (
                      <article key={`${round.attempt}-${index}`} className={`independent-review-issue severity-${issue.severity}`}>
                        <div><span>{issue.severity || "issue"}</span><strong>{issue.title}</strong></div>
                        <p>{issue.detail}</p>
                        {issue.evidence && <small>{issue.evidence}</small>}
                        {issue.recommendation && <p className="recommendation">{issue.recommendation}</p>}
                      </article>
                    ))}
                  </section>
                )}
                {round.result.evidenceChecked.length > 0 && (
                  <section><h3>{copy.checked}</h3><ul>{round.result.evidenceChecked.map((item) => <li key={item}>{item}</li>)}</ul></section>
                )}
                {round.result.missingChecks.length > 0 && (
                  <section><h3>{copy.missing}</h3><ul>{round.result.missingChecks.map((item) => <li key={item}>{item}</li>)}</ul></section>
                )}
                {round.result.revisionInstructions.length > 0 && (
                  <section><h3>{copy.instructions}</h3><ol>{round.result.revisionInstructions.map((item) => <li key={item}>{item}</li>)}</ol></section>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
