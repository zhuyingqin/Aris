import type { Language } from "../store";
import { languageLocale, tr } from "../language";
import { useEffect, useId, useRef, useState } from "react";
import { chatAgentDetail, chatAgentTrace, type AgentTaskCard, type AgentTaskDetail, type AgentTaskEvent, type AgentTrace } from "../api/agentTasks";
import { SvgIcon } from "../SvgIcon";
import { AgentTaskStatusIcon, agentTaskLabels, isAgentTaskActive } from "./AgentTaskCards";
import { AgentTaskElapsed, AgentTaskIdentity, agentTaskActivity, agentTaskDisplayName } from "./agentTaskPresentation";
import AgentTraceView from "./AgentTraceView";
import ChatMessage from "./ChatMessage";

function eventLabel(event: AgentTaskEvent, language: Language): string {
  const names: Record<string, string> = tr(language, {
    "agent.lineage": "创建子会话", "agent.execution": "绑定模型与执行预算",
    "agent.turn.started": "开始执行", "agent.turn.finished": "本轮结束",
    "agent.tool.started": "开始工具调用", "agent.tool.finished": event.isError ? "工具调用失败" : "工具调用完成",
    "agent.mail.sent": "发送消息或结果", "agent.mail.delivered": "接收消息",
    "agent.interrupted": "停止执行", "agent.recovered": "恢复检查点", "agent.close": "关闭子会话",
  }, {
    "agent.lineage": "Child session created", "agent.execution": "Model and budget bound",
    "agent.turn.started": "Execution started", "agent.turn.finished": "Turn finished",
    "agent.tool.started": "Tool started", "agent.tool.finished": event.isError ? "Tool failed" : "Tool completed",
    "agent.mail.sent": "Message or result sent", "agent.mail.delivered": "Message received",
    "agent.interrupted": "Execution stopped", "agent.recovered": "Checkpoint restored", "agent.close": "Session closed",
  }, {
    "agent.lineage": "Sesión hija creada", "agent.execution": "Modelo y presupuesto asignados",
    "agent.turn.started": "Ejecución iniciada", "agent.turn.finished": "Turno finalizado",
    "agent.tool.started": "Herramienta iniciada", "agent.tool.finished": event.isError ? "La herramienta falló" : "Herramienta completada",
    "agent.mail.sent": "Mensaje o resultado enviado", "agent.mail.delivered": "Mensaje recibido",
    "agent.interrupted": "Ejecución detenida", "agent.recovered": "Punto de control restaurado", "agent.close": "Sesión cerrada",
  });
  return [names[event.kind] ?? event.kind, event.toolName ?? event.model].filter(Boolean).join(" · ");
}

const ignoreAction = () => undefined;

export default function AgentTaskPanel({ sessionId, projectId, childSessionId, agent, language, visible, busy, stopping, error, onStop, onResume, onOpenEvidence, onOpenList }: {
  sessionId: string;
  projectId: string;
  childSessionId: string;
  agent?: AgentTaskCard;
  language: Language;
  visible: boolean;
  busy: boolean;
  stopping: boolean;
  error?: string;
  onStop: (agent: AgentTaskCard) => void;
  onResume: (target: string) => void;
  onOpenEvidence: (path: string) => void;
  onOpenList?: () => void;
}) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const scope = JSON.stringify([projectId, sessionId, childSessionId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; detail?: AgentTaskDetail; error?: string }>({ scope });
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<"conversation" | "activity" | "trace">("conversation");
  const [traceSnapshot, setTraceSnapshot] = useState<{ scope: string; trace?: AgentTrace; error?: string }>({ scope });
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const viewId = useId();
  const detail = snapshot.scope === scope ? snapshot.detail : undefined;
  const detailError = snapshot.scope === scope ? snapshot.error : undefined;
  const currentAgent = detail?.info && (!agent || (detail.info.revision ?? 0) > (agent.revision ?? 0)) ? detail.info : agent ?? detail?.info;

  useEffect(() => {
    if (!visible) return;
    let live = true;
    // Coalesce tool/status events and let their durable checkpoint finish first.
    const timer = window.setTimeout(() => {
      void chatAgentDetail(sessionId, projectId, childSessionId).then(next => {
        if (live) setSnapshot({ scope, detail: next });
      }).catch(reason => {
        if (live) setSnapshot(previous => ({ scope, detail: previous.scope === scope ? previous.detail : undefined, error: String(reason) }));
      });
    }, 100);
    return () => { live = false; window.clearTimeout(timer); };
  }, [sessionId, projectId, childSessionId, scope, visible, agent?.revision, agent?.lastActivity, agent?.status.state, refresh]);

  // The graph spans the whole tree's logs, so it is read only while it is shown.
  useEffect(() => {
    if (!visible || view !== "trace") return;
    let live = true;
    const timer = window.setTimeout(() => {
      void chatAgentTrace(sessionId, projectId).then(next => {
        if (live) setTraceSnapshot({ scope, trace: next });
      }).catch(reason => {
        if (live) setTraceSnapshot(previous => ({ scope, trace: previous.scope === scope ? previous.trace : undefined, error: String(reason) }));
      });
    }, 100);
    return () => { live = false; window.clearTimeout(timer); };
  }, [sessionId, projectId, scope, visible, view, agent?.revision, agent?.status.state, refresh]);
  const trace = traceSnapshot.scope === scope ? traceSnapshot.trace : undefined;
  const traceError = traceSnapshot.scope === scope ? traceSnapshot.error : undefined;

  useEffect(() => {
    if (visible && followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail, view, visible]);

  const active = currentAgent ? isAgentTaskActive(currentAgent) : false;
  const resumable = currentAgent?.resumable !== false && currentAgent && (currentAgent.status.state === "interrupted" || currentAgent.status.state === "errored" || (currentAgent.status.state === "pending_init" && !busy));
  return <div className="agent-task-panel">
    {onOpenList && <button type="button" className="agent-task-back" onClick={onOpenList}><SvgIcon name="chevronLeft" size={12} />{t("所有子智能体", "All agents", "Todos los agentes")}</button>}
    <header className="agent-task-panel-head">
      {currentAgent && <AgentTaskIdentity agent={currentAgent} size={28} showStatus />}
      <div className="agent-task-panel-heading">
        <h2 title={currentAgent?.path}>{currentAgent ? agentTaskDisplayName(currentAgent, language) : (t("子智能体", "Agent", "Agente"))}</h2>
        <small role="status">{currentAgent ? agentTaskLabels[language][currentAgent.status.state] : (t("正在读取任务…", "Loading task…", "Cargando tarea…"))}</small>
      </div>
      <div className="agent-task-panel-actions">
        {currentAgent && <AgentTaskElapsed agent={currentAgent} language={language} />}
        <button type="button" onClick={() => setRefresh(value => value + 1)} aria-label={t("刷新子会话", "Refresh agent conversation", "Actualizar conversación del agente")} title={t("刷新子会话", "Refresh agent conversation", "Actualizar conversación del agente")}><SvgIcon name="refresh" size={13} /></button>
        {resumable && <button type="button" disabled={busy || stopping} onClick={() => onResume(currentAgent.path)}><SvgIcon name="play" size={12} />{t("继续原任务", "Continue task", "Continuar tarea")}</button>}
        {active && <button type="button" disabled={stopping} onClick={() => onStop(currentAgent!)}><SvgIcon name="stop" size={11} />{stopping ? (t("停止中", "Stopping…", "Deteniendo…")) : (t("停止", "Stop", "Detener"))}</button>}
      </div>
    </header>
    {currentAgent && <div className="agent-task-panel-description">
      <p>{currentAgent.task.task}</p>
      <details><summary>{t("任务详情", "Task details", "Detalles de la tarea")}</summary><dl>
        <dt>{t("委派理由", "Reason", "Motivo")}</dt><dd>{currentAgent.task.reason}</dd>
        <dt>{t("交付要求", "Deliverable", "Entregable")}</dt><dd>{currentAgent.task.deliverable}</dd>
        <dt>{t("输入", "Inputs", "Entradas")}</dt><dd>{currentAgent.task.inputs}</dd>
        <dt>{t("停止条件", "Stop condition", "Condición de parada")}</dt><dd>{currentAgent.task.stopCondition}</dd>
        <dt>{t("执行配置", "Execution", "Ejecución")}</dt><dd>{currentAgent.task.model} · {currentAgent.task.connection}<br />{currentAgent.task.permission}<br />{currentAgent.path} · {currentAgent.task.maxIterations} {t("轮", "iterations", "iteraciones")} · {currentAgent.task.maxSeconds}s<br />{currentAgent.task.workspace}</dd>
      </dl></details>
    </div>}
    {currentAgent && <div className="agent-task-panel-activity" aria-live="polite">
      <AgentTaskStatusIcon state={currentAgent.status.state} />
      <span title={currentAgent.lastActivity ?? undefined}>{agentTaskActivity(currentAgent, language)}</span>
    </div>}
    <div className="agent-task-panel-views" role="tablist" aria-label={t("子会话视图", "Agent views", "Vistas del agente")}>
      {(["conversation", "activity", "trace"] as const).map(item => <button key={item} type="button" role="tab" id={`${viewId}-${item}`} aria-selected={view === item} aria-controls={`${viewId}-content`} onClick={() => { followRef.current = item !== "trace"; setView(item); }}>
        {item === "conversation" ? (t("对话", "Conversation", "Conversación")) : item === "activity" ? (t("运行记录", "Activity", "Actividad")) : (t("追溯", "Trace", "Traza"))}
      </button>)}
    </div>
    {(detailError || error || currentAgent?.persistenceError) && <p className="agent-task-error" role="alert">{detailError || error || currentAgent?.persistenceError}</p>}
    <div className="agent-task-panel-scroll" ref={scrollRef} role="tabpanel" id={`${viewId}-content`} aria-labelledby={`${viewId}-${view}`} onScroll={event => {
      const node = event.currentTarget;
      followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    }}>
      {currentAgent?.status.state === "errored" && currentAgent.status.message && <p className="agent-task-error" role="alert">{currentAgent.status.message}</p>}
      {currentAgent?.interruptionReason && <p className="agent-task-panel-result">{currentAgent.interruptionReason}</p>}
      {view === "conversation" ? <>
        {detail?.turns?.length ? detail.turns.map(turn => <ChatMessage key={turn.id} turn={{ ...turn, readOnly: true }} canRetry={false} onEdit={ignoreAction} onRetry={ignoreAction} onContinue={ignoreAction} />)
          : detail?.transcript ? <pre className="agent-task-transcript">{detail.transcript}</pre>
            : <p className="agent-task-panel-empty">{!detail && !detailError ? (t("正在读取对话…", "Loading conversation…", "Cargando conversación…")) : (t("对话将在子智能体保存进展后显示。", "The conversation will appear as the agent saves progress.", "La conversación aparecerá a medida que el agente guarde su progreso."))}</p>}
        {!detail?.turns?.length && !detail?.transcript && currentAgent?.status.message && <p className="agent-task-panel-result">{currentAgent.status.message}</p>}
      </> : view === "trace" ? (trace ? <AgentTraceView trace={trace} childSessionId={childSessionId} language={language} />
        : traceError ? <p className="agent-task-error" role="alert">{traceError}</p>
          : <p className="agent-task-panel-empty">{t("正在读取交互记录…", "Loading interactions…", "Cargando interacciones…")}</p>)
      : detail?.timeline?.length ? <ol className="agent-task-timeline" aria-label={t("执行时间线", "Execution timeline", "Cronología de ejecución")}>
        {detail.timeline.map(event => <li key={`${event.seq}-${event.kind}`}>
          <time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleString(languageLocale(language))}</time>
          <span>{eventLabel(event, language)}</span>
          {event.reason && <small>{event.reason}</small>}
        </li>)}
      </ol> : <p className="agent-task-panel-empty">{t("尚无执行记录", "No execution events yet", "Aún no hay eventos de ejecución")}</p>}
    </div>
    <footer className="agent-task-panel-footer">
      <span title={currentAgent?.task.model}>{t("只读子会话", "Read-only agent conversation", "Conversación del agente de solo lectura")}</span>
      {currentAgent && <button type="button" onClick={() => onOpenEvidence(currentAgent.evidencePath)}><SvgIcon name="document" size={12} />{t("执行证据", "Execution evidence", "Evidencia de ejecución")}</button>}
    </footer>
  </div>;
}
