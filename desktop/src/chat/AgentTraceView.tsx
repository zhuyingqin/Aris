import type { Language } from "../store";
import { tr } from "../language";
import type { AgentInteraction, AgentInteractionKind, AgentTrace } from "../api/agentTasks";

const kindLabels: Record<Language, Record<AgentInteractionKind, string>> = {
  cn: { spawn_agent: "创建", assign_task: "任务", send_message: "消息", agent_result: "结果", close_agent: "关闭", review_request: "审阅请求", review_verdict: "审阅结论" },
  en: { spawn_agent: "Spawn", assign_task: "Task", send_message: "Message", agent_result: "Result", close_agent: "Close", review_request: "Review request", review_verdict: "Verdict" },
  es: { spawn_agent: "Crear", assign_task: "Tarea", send_message: "Mensaje", agent_result: "Resultado", close_agent: "Cerrar", review_request: "Solicitud de revisión", review_verdict: "Veredicto" },
};
const turnStates: Record<Language, Record<string, string>> = {
  cn: { completed: "已完成", interrupted: "已停止", errored: "失败" },
  en: { completed: "Completed", interrupted: "Stopped", errored: "Failed" },
  es: { completed: "Completado", interrupted: "Detenido", errored: "Falló" },
};

/** Ids are long and random; the tail tells them apart, the title keeps the whole. */
function Id({ value }: { value?: string | null }) {
  if (!value) return null;
  return <code className="agent-trace-id" title={value}>{value.length > 14 ? `…${value.slice(-12)}` : value}</code>;
}

function Source({ edge, language }: { edge: AgentInteraction; language: Language }) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  return <span className="agent-trace-source">
    {t("来自", "from", "de")} <strong>{edge.fromPath ?? "?"}</strong>
    {edge.sourceTurnId && <> · {t("回合", "turn", "turno")} <Id value={edge.sourceTurnId} /></>}
    {edge.sourceToolUseId && <> · {t("工具调用", "tool call", "llamada a herramienta")} <Id value={edge.sourceToolUseId} /></>}
    {edge.sourceActionId && <> · {t("控制器动作", "controller action", "acción del controlador")} <Id value={edge.sourceActionId} /></>}
  </span>;
}

function Delivery({ edge, language }: { edge: AgentInteraction; language: Language }) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  return <span className="agent-trace-source">
    → <strong>{edge.toPath ?? "?"}</strong>
    {edge.deliveredTurnId
      ? <> · {t("已在回合", "read in turn", "leído en el turno")} <Id value={edge.deliveredTurnId} />{t(" 读取", "", "")}</>
      : <> · {t("尚未被读取", "not read yet", "aún sin leer")}</>}
  </span>;
}

/**
 * One child's place in the agent graph: what started it, and for each of its
 * turns the mail it read, the tools it called and what it sent back. A result
 * can be followed from the turn that wrote it to the parent's tool call.
 */
export default function AgentTraceView({ trace, childSessionId, language }: {
  trace: AgentTrace;
  childSessionId: string;
  language: Language;
}) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const node = trace.nodes.find(candidate => candidate.sessionId === childSessionId);
  if (!node) return <p className="agent-task-panel-empty">{t("尚无可追溯的交互", "No interactions to trace yet", "Aún no hay interacciones que rastrear")}</p>;
  const edges = new Map(trace.edges.map(edge => [edge.id, edge]));
  const pick = (ids: string[]) => ids.map(id => edges.get(id)).filter((edge): edge is AgentInteraction => Boolean(edge));
  const spawn = trace.edges.find(edge => edge.kind === "spawn_agent" && edge.toSessionId === childSessionId);
  const close = trace.edges.find(edge => edge.kind === "close_agent" && edge.toSessionId === childSessionId);
  const kind = (edge: AgentInteraction) => kindLabels[language][edge.kind];

  return <div className="agent-trace" aria-label={t("交互追溯", "Interaction trace", "Traza de interacciones")}>
    {spawn && <p className="agent-trace-origin"><span className="agent-trace-kind">{kind(spawn)}</span><Source edge={spawn} language={language} /></p>}
    {node.turns.length === 0 && <p className="agent-task-panel-empty">{t("子智能体还没有开始执行", "The subagent has not run yet", "El subagente aún no se ha ejecutado")}</p>}
    <ol className="agent-trace-turns">
      {node.turns.map((turn, index) => {
        const received = pick(turn.received);
        const sent = pick(turn.sent);
        return <li key={turn.turnId} data-status={turn.status ?? "running"}>
          <header>
            <strong>{t(`第 ${index + 1} 轮`, `Turn ${index + 1}`, `Turno ${index + 1}`)}</strong>
            <span>{turn.status ? turnStates[language][turn.status] ?? turn.status : (t("进行中", "Running", "En ejecución"))}</span>
            <Id value={turn.turnId} />
          </header>
          {turn.reason && <small className="agent-trace-reason">{turn.reason}</small>}
          {received.length > 0 && <section aria-label={t("读取", "Read", "Leído")}>
            <h4>{t("读取", "Read", "Leído")}</h4>
            <ul>{received.map(edge => <li key={edge.id}><span className="agent-trace-kind">{kind(edge)}</span><Source edge={edge} language={language} /></li>)}</ul>
          </section>}
          <section aria-label={t("工具调用", "Tool calls", "Llamadas a herramientas")}>
            <h4>{t("工具调用", "Tool calls", "Llamadas a herramientas")}</h4>
            {turn.tools.length
              ? <ul>{turn.tools.map((call, position) => <li key={`${call.toolUseId ?? call.toolName}-${position}`} data-error={call.isError ? "true" : undefined}>
                <code>{call.toolName}</code>
                {call.isError ? <span className="agent-trace-failed">{t("失败", "failed", "falló")}</span> : !call.finishedTs && <span>{t("进行中", "running", "en ejecución")}</span>}
                <Id value={call.toolUseId} />
              </li>)}</ul>
              : <p className="agent-trace-none">{t("本轮没有调用工具", "No tools called in this turn", "No se llamó a ninguna herramienta en este turno")}</p>}
          </section>
          {sent.length > 0 && <section aria-label={t("发出", "Sent", "Enviado")}>
            <h4>{t("发出", "Sent", "Enviado")}</h4>
            <ul>{sent.map(edge => <li key={edge.id}>
              <span className="agent-trace-kind">{kind(edge)}</span>
              {edge.status && edge.kind === "agent_result" && <span>{turnStates[language][edge.status] ?? edge.status}</span>}
              <Delivery edge={edge} language={language} />
            </li>)}</ul>
          </section>}
        </li>;
      })}
    </ol>
    {close && <p className="agent-trace-origin"><span className="agent-trace-kind">{kind(close)}</span><span className="agent-trace-source">{close.status}</span></p>}
  </div>;
}
