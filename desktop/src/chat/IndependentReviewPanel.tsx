import type { Language } from "../store";
import { tr } from "../language";
import type { IndependentReviewResult } from "../api/tauri";
import type { IndependentReviewState } from "./useIndependentReview";

function verdictLabel(result: IndependentReviewResult, language: Language) {
  const labels = tr(
    language,
    { pass: "通过", revise: "需要修订", needs_user: "需要用户决策", unavailable: "审查不可用" },
    { pass: "Passed", revise: "Revision required", needs_user: "Needs user", unavailable: "Review unavailable" },
    { pass: "Aprobado", revise: "Requiere revisión", needs_user: "Requiere tu decisión", unavailable: "Revisión no disponible" },
  );
  return labels[result.verdict];
}

function phaseLabel(state: IndependentReviewState, language: Language) {
  if (language === "cn") {
    if (state.phase === "reviewing") return "独立审查中";
    if (state.phase === "revising") return `Executor 修订中 ${state.revision}/${state.maxRevisions}`;
    return "独立审查已完成";
  }
  if (language === "es") {
    if (state.phase === "reviewing") return "Revisión independiente en curso";
    if (state.phase === "revising") return `Executor revisando ${state.revision}/${state.maxRevisions}`;
    return "Revisión independiente completada";
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
  const copy = tr(
    language,
    {
      title: "独立 Reviewer",
      independent: "独立身份",
      executor: "Executor",
      reviewer: "Reviewer",
      issues: "发现的问题",
      checked: "已核查证据",
      toolChecks: "Reviewer 工具调用",
      rubrics: "插件审查细则",
      rubricOmitted: "因长度未下发（本轮未检查）",
      rubricUnknown: "Reviewer 引用了未下发的细则（已忽略）",
      rubricCorrected: "有 critical 细则被违反，控制器已把“通过”改为“需修改”。",
      rubricResult: { met: "满足", violated: "违反", not_applicable: "不适用", unverified: "无法核实", unreported: "未报告" },
      criterion: "细则",
      missing: "缺失检查",
      instructions: "修订要求",
      clear: "清除审查记录",
      clearBusy: "审查运行时不能清除，请先停止当前任务。",
      waiting: "Reviewer 正在对照请求、工具证据、工作区文件和成功标准寻找反例。",
      exhausted: "已达到最多两轮自动修订，剩余问题不会被伪装成已通过。",
    },
    {
      title: "Independent Reviewer",
      independent: "Independent identity",
      executor: "Executor",
      reviewer: "Reviewer",
      issues: "Issues found",
      checked: "Evidence checked",
      toolChecks: "Reviewer tool calls",
      rubrics: "Plugin review rubrics",
      rubricOmitted: "Left out for length (not checked this round)",
      rubricUnknown: "Cited by the Reviewer but never sent (ignored)",
      rubricCorrected: "A critical criterion was violated, so the controller changed pass to revise.",
      rubricResult: { met: "Met", violated: "Violated", not_applicable: "Not applicable", unverified: "Unverified", unreported: "Not reported" },
      criterion: "Criterion",
      missing: "Missing checks",
      instructions: "Revision instructions",
      clear: "Clear review history",
      clearBusy: "Stop the current task before clearing an active review.",
      waiting: "The Reviewer is checking the request, tool evidence, workspace files, and success criteria for counterexamples.",
      exhausted: "The two automatic revision rounds are exhausted; unresolved issues are not presented as passed.",
    },
    {
      title: "Reviewer independiente",
      independent: "Identidad independiente",
      executor: "Executor",
      reviewer: "Reviewer",
      issues: "Problemas encontrados",
      checked: "Evidencia comprobada",
      toolChecks: "Llamadas a herramientas del Reviewer",
      rubrics: "Criterios de revisión del plugin",
      rubricOmitted: "Omitido por extensión (no se comprobó en esta ronda)",
      rubricUnknown: "Citado por el Reviewer pero nunca enviado (ignorado)",
      rubricCorrected: "Se incumplió un criterio crítico, así que el controlador cambió «aprobado» por «revisar».",
      rubricResult: { met: "Cumplido", violated: "Incumplido", not_applicable: "No aplica", unverified: "Sin verificar", unreported: "Sin informar" },
      criterion: "Criterio",
      missing: "Comprobaciones pendientes",
      instructions: "Instrucciones de revisión",
      clear: "Borrar historial de revisión",
      clearBusy: "Detén la tarea actual antes de borrar una revisión activa.",
      waiting: "El Reviewer está buscando contraejemplos en la solicitud, la evidencia de herramientas, los archivos del espacio de trabajo y los criterios de éxito.",
      exhausted: "Se agotaron las dos rondas de revisión automática; los problemas sin resolver no se presentan como aprobados.",
    },
  );

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
                <span>{tr(language, "Review", "Review", "Revisión")} {round.attempt}</span>
                <strong className={`verdict-${round.result.verdict}`}>{verdictLabel(round.result, language)}</strong>
              </summary>
              <div className="independent-review-round-body">
                {round.result.issues.length > 0 && (
                  <section>
                    <h3>{copy.issues}</h3>
                    {round.result.issues.map((issue, index) => (
                      <article key={`${round.attempt}-${index}`} className={`independent-review-issue severity-${issue.severity}`}>
                        <div><span>{issue.severity || "issue"}</span><strong>{issue.title}</strong></div>
                        {issue.criterion && <code className="independent-review-criterion" title={copy.criterion}>{issue.criterion}</code>}
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
                {/* The controller's record of the Reviewer's own tool calls, which can repeat, so the index is part of the key. */}
                {round.result.toolChecks && round.result.toolChecks.length > 0 && (
                  <section><h3>{copy.toolChecks}</h3><ul className="independent-review-tool-checks">{round.result.toolChecks.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></section>
                )}
                {/* Recorded by the controller, not the Reviewer: what this round's packet carried, what it left out, and the result per criterion. */}
                {round.result.rubrics && (
                  <section className="independent-review-rubrics">
                    <h3>{copy.rubrics}</h3>
                    {round.result.rubrics.verdictCorrected && <p className="independent-review-rubric-corrected">{copy.rubricCorrected}</p>}
                    {(round.result.rubrics.checks ?? []).length > 0 && (
                      <ul>{(round.result.rubrics.checks ?? []).map((check) => (
                        <li key={check.criterion} data-result={check.result}>
                          <code>{check.criterion}</code> <span className="independent-review-rubric-result">{copy.rubricResult[check.result] ?? check.result}</span>
                          {check.note && <small> {check.note}</small>}
                        </li>
                      ))}</ul>
                    )}
                    {(round.result.rubrics.omitted ?? []).length > 0 && (
                      <p><span>{copy.rubricOmitted}: </span>{(round.result.rubrics.omitted ?? []).map((key) => <code key={key}>{key}</code>)}</p>
                    )}
                    {(round.result.rubrics.unknownCriteria ?? []).length > 0 && (
                      <p><span>{copy.rubricUnknown}: </span>{(round.result.rubrics.unknownCriteria ?? []).map((key) => <code key={key}>{key}</code>)}</p>
                    )}
                  </section>
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
