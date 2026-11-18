import type { Language } from "../store";
import { tr } from "../language";
import { useEffect, useState } from "react";
import type { AgentTaskCard } from "../api/agentTasks";


export function agentTaskName(agent: Pick<AgentTaskCard, "path">): string {
  return agent.path.split("/").filter(Boolean).at(-1) ?? agent.path;
}

/** Copy per language, in the order Chinese, English, Spanish (see `tr`). */
type Trilingual = [string, string, string];

const taskNames: Record<string, Trilingual> = {
  survey: ["文献检索", "Literature search", "Búsqueda bibliográfica"], literature: ["文献检索", "Literature search", "Búsqueda bibliográfica"],
  literature_review: ["文献核查", "Literature review", "Revisión bibliográfica"],
  limits: ["局限核查", "Limitations check", "Revisión de limitaciones"], research_gaps: ["研究空白", "Research gaps", "Vacíos de investigación"],
  frontend: ["界面核查", "Frontend review", "Revisión del frontend"], frontend_review: ["界面核查", "Frontend review", "Revisión del frontend"],
  backend: ["后端核查", "Backend review", "Revisión del backend"], backend_review: ["后端核查", "Backend review", "Revisión del backend"],
  rust: ["Rust 核查", "Rust review", "Revisión de Rust"], rust_review: ["Rust 核查", "Rust review", "Revisión de Rust"],
  integration: ["集成核查", "Integration review", "Revisión de integración"], integration_review: ["集成核查", "Integration review", "Revisión de integración"],
  methods: ["方法核查", "Methods review", "Revisión de métodos"], method_review: ["方法核查", "Methods review", "Revisión de métodos"],
  evidence: ["证据核查", "Evidence check", "Verificación de evidencia"], evidence_check: ["证据核查", "Evidence check", "Verificación de evidencia"],
  tests: ["测试核查", "Test review", "Revisión de pruebas"], test_review: ["测试核查", "Test review", "Revisión de pruebas"],
};

function pick(language: Language, copy: Trilingual): string {
  return tr(language, copy[0], copy[1], copy[2]);
}

export function agentTaskDisplayName(agent: Pick<AgentTaskCard, "path">, language: Language): string {
  const name = agentTaskName(agent);
  const key = name.replace(/^agent_/, "").replace(/_agent$/, "");
  const known = Object.prototype.hasOwnProperty.call(taskNames, key) ? taskNames[key] : undefined;
  if (known) return pick(language, known);
  return name.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

const toolLabels: Record<string, Trilingual> = {
  read_file: ["读取文件", "Reading file", "Leyendo archivo"], Read: ["读取文件", "Reading file", "Leyendo archivo"],
  grep_search: ["检索内容", "Searching content", "Buscando contenido"], Grep: ["检索内容", "Searching content", "Buscando contenido"],
  glob_search: ["查找文件", "Finding files", "Buscando archivos"], Glob: ["查找文件", "Finding files", "Buscando archivos"],
  ScopusSearch: ["检索 Scopus 文献", "Searching Scopus", "Buscando en Scopus"], WebSearch: ["检索网页", "Searching the web", "Buscando en la web"],
  WebFetch: ["读取网页", "Reading web page", "Leyendo página web"], web_fetch: ["读取网页", "Reading web page", "Leyendo página web"],
  ProjectEvidenceSearch: ["检索项目证据", "Searching project evidence", "Buscando evidencia del proyecto"],
  send_message: ["回传消息", "Sending a message", "Enviando un mensaje"],
};

export function agentTaskActivity(agent: AgentTaskCard, language: Language): string {
  const activity = agent.lastActivity?.trim();
  const state = agent.status.state;
  if (state === "completed" || state === "errored" || state === "interrupted" || state === "shutdown") {
    const outcomes = tr(language, {
      completed: "任务已完成，可查看结果", errored: "执行失败，可查看详情",
      interrupted: "已停止，进展已保留", shutdown: "已停止，进展已保留",
    }, {
      completed: "Task completed; view results", errored: "Execution failed; view details",
      interrupted: "Stopped; progress saved", shutdown: "Stopped; progress saved",
    }, {
      completed: "Tarea completada; ver resultados", errored: "La ejecución falló; ver detalles",
      interrupted: "Detenida; progreso guardado", shutdown: "Detenida; progreso guardado",
    });
    return agent.status.message || outcomes[state];
  }
  if (!activity) return agent.status.message || agent.task.task;
  const match = /^([\w]+)(\s*[·:]\s*|\s+|$)([\s\S]*)$/.exec(activity);
  const label = match && Object.prototype.hasOwnProperty.call(toolLabels, match[1]) ? toolLabels[match[1]] : undefined;
  return label ? [pick(language, label), match![3]].filter(Boolean).join(" · ") : activity;
}

// Identity depends only on the canonical child ID, never list order or status.
export function agentTaskIdentity(sessionId: string): { shape: number; color: number } {
  let hash = 2166136261;
  for (const letter of sessionId) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0;
  return { shape: hash % 8, color: (hash >>> 8) % 8 };
}

const shapes = [
  "M8 1.5 14.5 8 8 14.5 1.5 8Z M8 5 11 8 8 11 5 8Z",
  "M8 1.5 10 5.5 14.5 6 11 9.5 12 14 8 12 4 14 5 9.5 1.5 6 6 5.5Z",
  "M4 2.5H12V6H4Z M2.5 10H6V13.5H2.5Z M10 10H13.5V13.5H10Z M8 6V8H4.25V10 M8 8H11.75V10",
  "M8 1.5 14 5V11L8 14.5 2 11V5Z M2 5 8 8.5 14 5 M8 8.5V14.5",
  "M3 2.5H6.5V6H3Z M9.5 2.5H13V6H9.5Z M3 10H6.5V13.5H3Z M9.5 10H13V13.5H9.5Z M6.5 4.25H9.5 M4.75 6V10 M11.25 6V10 M6.5 11.75H9.5",
  "M8 1.5 11 5 14.5 8 11 11 8 14.5 5 11 1.5 8 5 5Z M5 5 11 11 M11 5 5 11",
  "M8 2 13.2 5V11L8 14 2.8 11V5Z M5.4 6.5 8 5 10.6 6.5V9.5L8 11 5.4 9.5Z",
  "M5 2.5 8 5.5 11 2.5 14 5.5 11 8.5 14 11.5 11 14.5 8 11.5 5 14.5 2 11.5 5 8.5 2 5.5Z",
];

export function AgentTaskIdentity({ agent, size = 22, showStatus = false }: {
  agent: Pick<AgentTaskCard, "sessionId" | "status">;
  size?: number;
  showStatus?: boolean;
}) {
  const { shape, color } = agentTaskIdentity(agent.sessionId);
  return <span className={`agent-identity agent-identity-color-${color}`} style={{ width: size, height: size }}
    data-agent-id={agent.sessionId} data-identity={`${shape}-${color}`} aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round">
      <path d={shapes[shape]} />
    </svg>
    {showStatus && <i className={`agent-identity-status is-${agent.status.state}`} />}
  </span>;
}

/** Display only recorded execution time. Old records without timestamps stay blank. */
export function AgentTaskElapsed({ agent, language }: { agent: AgentTaskCard; language: Language }) {
  const [now, setNow] = useState(Date.now);
  const ticking = Number.isFinite(agent.startedAt) && !Number.isFinite(agent.finishedAt)
    && ["running", "waiting"].includes(agent.status.state);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, agent.startedAt]);
  if (!Number.isFinite(agent.startedAt) || (!Number.isFinite(agent.finishedAt) && !ticking)) return null;
  const elapsed = Math.max(0, (agent.finishedAt ?? now) - agent.startedAt!);
  const seconds = Math.floor(elapsed / 1000);
  const value = seconds < 60 ? `${seconds}s` : seconds < 3600
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return <time className="agent-task-elapsed" title={tr(language, "本轮执行用时", "Run time", "Tiempo de esta ejecución")}
    dateTime={`PT${seconds}S`}>{value}</time>;
}
