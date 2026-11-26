// What a plugin's MCP server declared it needs, line by line, each with how
// far this computer enforces it. The labels come from the backend
// (`capability_enforcement`): this view shows them, it never infers them.
// The Chat approval card and the Plugins page use the same components.
import type { CapabilityChange, CapabilityEnforcement, Enforcement, LaunchNote, McpCapability } from "../api/plugins";
import type { Language } from "../store";
import { tr } from "../language";
import "./PluginCapabilities.css";

const LABEL: Record<Enforcement, [string, string, string]> = {
  enforced: ["已强制", "Enforced", "Aplicado"],
  "best-effort": ["尽力", "Best effort", "En lo posible"],
  declared: ["仅声明", "Declared only", "Solo declarado"],
};
const label = (level: Enforcement, language: Language) => tr(language, ...LABEL[level]);

function Badge({ level, language }: { level: Enforcement; language: Language }) {
  return <span className={`plugin-capability-level is-${level}`}>{label(level, language)}</span>;
}

const list = (items: string[], language: Language) => items.join(tr(language, "、", ", ", ", "));

/** One server's declaration, a line per limit, each with its level. */
export function ServerCapabilities({ capability, launch, enforcement, language }: {
  capability?: McpCapability | null; launch?: LaunchNote[]; enforcement?: CapabilityEnforcement | null; language: Language;
}) {
  if (!capability || !enforcement) {
    return <p className="plugin-capability-missing">{tr(language,
      "没有声明需要哪些能力，这个版本不能启用。",
      "It does not declare what it needs; this version cannot be enabled.",
      "No declara lo que necesita; esta versión no se puede activar.")}</p>;
  }
  const env = capability.env ?? [];
  const files = capability.workspaceFiles ?? [];
  const rows: [string, string, Enforcement][] = [
    [tr(language, "环境变量", "Environment", "Entorno"), env.length
      ? tr(language, `系统基础变量，加上你电脑上的 ${list(env, language)}`, `Platform variables, plus ${list(env, language)} from your computer`, `Variables de plataforma, más ${list(env, language)} de tu equipo`)
      : tr(language, "只有系统基础变量", "Platform variables only", "Solo variables de plataforma"), enforcement.environment],
    capability.network.access === "none"
      ? [tr(language, "网络", "Network", "Red"), tr(language, "不联网", "No network", "Sin red"), enforcement.networkNone]
      : [tr(language, "网络", "Network", "Red"), capability.network.hosts?.length
        ? tr(language, `需要：${list(capability.network.hosts, language)}`, `Needed: ${list(capability.network.hosts, language)}`, `Necesaria: ${list(capability.network.hosts, language)}`)
        : tr(language, "需要，任意地址", "Needed, any address", "Necesaria, cualquier dirección"), enforcement.networkHosts],
    [tr(language, "工作目录", "Working directory", "Directorio de trabajo"), tr(language, "插件自己的数据目录，不是项目目录", "Its own data directory, not the project", "Su propio directorio de datos, no el proyecto"), enforcement.workingDirectory],
    [tr(language, "项目目录", "Project", "Proyecto"), capability.workspace === "none"
      ? tr(language, "不访问", "No access", "Sin acceso")
      : capability.workspace === "read" ? tr(language, "读取", "Reads it", "Lo lee") : tr(language, "读写", "Reads and writes it", "Lo lee y escribe"), enforcement.workspaceAccess],
  ];
  if (files.length) rows.push([tr(language, "项目文件", "Project files", "Archivos del proyecto"),
    tr(language, `拿到 ${list(files, language)} 批准时的副本`, `Gets the copies of ${list(files, language)} you approve`, `Recibe las copias aprobadas de ${list(files, language)}`), enforcement.workspaceFiles]);
  rows.push([tr(language, "进程", "Processes", "Procesos"), tr(language, "随 SomniQ 退出一起结束", "End when SomniQ quits", "Terminan al cerrar SomniQ"), enforcement.processTree]);
  for (const note of launch ?? []) {
    rows.push(note.kind === "runtime-fetch"
      ? [tr(language, "运行时下载", "Downloads at start", "Descarga al iniciar"), tr(language,
        `${note.launcher} 下载 ${note.spec}，批准不覆盖下载的内容`, `${note.launcher} downloads ${note.spec}; the approval does not cover what it downloads`, `${note.launcher} descarga ${note.spec}; la aprobación no cubre lo descargado`), "declared"]
      : [tr(language, "快照外程序", "Program outside the package", "Programa fuera del paquete"), tr(language,
        `运行 ${note.program}，批准不覆盖它`, `Runs ${note.program}; the approval does not cover it`, `Ejecuta ${note.program}; la aprobación no lo cubre`), "declared"]);
  }
  return <dl className="plugin-capabilities">
    {rows.map(([name, value, level]) => <div key={name} className="plugin-capability-row">
      <dt>{name}</dt><dd><span>{value}</span><Badge level={level} language={language} /></dd>
    </div>)}
  </dl>;
}

/** What the labels mean, under the lines that use them. */
export function EnforcementLegend({ declared, language }: { declared: boolean; language: Language }) {
  return <div className="plugin-capability-legend">
    <p><strong>{label("enforced", language)}</strong>{tr(language,
      "：宿主这样设置了插件进程，例如它的环境、它所在的作业。和 SomniQ 同一用户运行的恶意代码仍可能用别的手段拿到更多。",
      ": the host set the plugin's process up this way, e.g. its environment and the job it belongs to. Code running as the same user may still get more by other means.",
      ": el host configuró así el proceso del plugin, p. ej. su entorno y el trabajo al que pertenece. Código del mismo usuario aún puede obtener más por otros medios.")}</p>
    <p><strong>{label("best-effort", language)}</strong>{tr(language, "：宿主做了，但存在已知的绕过方式。", ": the host did it, but there is a known way around it.", ": el host lo hizo, pero hay una forma conocida de evitarlo.")}</p>
    <p><strong>{label("declared", language)}</strong>{tr(language, "：宿主在这台电脑上做不到，靠插件自觉遵守。", ": the host cannot do it on this computer; the plugin is trusted to keep to it.", ": el host no puede hacerlo en este equipo; se confía en que el plugin lo respete.")}</p>
    {declared && <p className="plugin-capability-legend-warn">{tr(language,
      "标“仅声明”的限制在这台电脑上靠插件自觉遵守。",
      "The limits marked “declared only” rest on the plugin keeping to them on this computer.",
      "Los límites marcados “solo declarado” dependen de que el plugin los respete en este equipo.")}</p>}
  </div>;
}

/** Whether any line of these servers is only declared. */
export function anyDeclared(servers: { capability?: McpCapability | null; launch?: LaunchNote[] }[], enforcement?: CapabilityEnforcement | null): boolean {
  if (!enforcement) return false;
  return servers.some((server) => (server.launch?.length ?? 0) > 0 || Boolean(server.capability && (
    enforcement.workspaceAccess === "declared"
    || (server.capability.network.access === "none" ? enforcement.networkNone : enforcement.networkHosts) === "declared"
    || enforcement.processTree === "declared")));
}

/** Skill scripts the Agent may run with Bash, outside any declaration. */
export function SkillScriptsNote({ scripts, language }: { scripts?: string[]; language: Language }) {
  if (!scripts?.length) return null;
  return <p className="plugin-capability-scripts">{tr(language,
    `Skill 带 ${scripts.length} 个脚本（${list(scripts, language)}）。Agent 用 Bash 运行它们时，它们拿到完整环境，不受上面的声明约束。`,
    `Its skills carry ${scripts.length} scripts (${list(scripts, language)}). When the Agent runs them with Bash they get the full environment; the declarations above do not apply.`,
    `Sus skills incluyen ${scripts.length} scripts (${list(scripts, language)}). Cuando el Agent los ejecuta con Bash obtienen el entorno completo; las declaraciones anteriores no se aplican.`)}</p>;
}

const ITEM: Record<CapabilityChange["item"], [string, string, string]> = {
  declaration: ["能力声明", "Declaration", "Declaración"],
  env: ["透传变量", "Variables from your computer", "Variables de tu equipo"],
  network: ["网络", "Network", "Red"],
  hosts: ["网络地址", "Network addresses", "Direcciones de red"],
  workspace: ["项目目录", "Project access", "Acceso al proyecto"],
  workspaceFiles: ["项目文件", "Project files", "Archivos del proyecto"],
};

/** How a server's declaration changes in an upgrade; what it gains is highlighted. */
export function CapabilityChanges({ server, changes, language }: { server: string; changes?: CapabilityChange[]; language: Language }) {
  if (!changes?.length) return null;
  return <ul className="plugin-capability-changes" aria-label={`${server} · ${tr(language, "能力变化", "Capability changes", "Cambios de capacidades")}`}>
    {changes.map((change) => change.item === "declaration" ? <li key={change.item}>
      {/* A declaration appearing or going away: its lines say the rest. */}
      <span className="plugin-capability-item">{server} · {tr(language, ...ITEM[change.item])}</span>
      <span>{change.to === "true"
        ? tr(language, "新版本写明了它需要什么，见下方各行", "The new version says what it needs; see the lines below", "La nueva versión indica lo que necesita; mira las líneas de abajo")
        : tr(language, "新版本不再声明它需要什么，不能启用", "The new version no longer says what it needs and cannot be enabled", "La nueva versión ya no indica lo que necesita y no se puede activar")}</span>
    </li> : <li key={change.item} className={change.expands ? "is-expands" : undefined}>
      <span className="plugin-capability-item">{server} · {tr(language, ...ITEM[change.item])}</span>
      {change.added?.map((value) => <code key={`+${value}`}>+ {value}</code>)}
      {change.removed?.map((value) => <code key={`-${value}`}>− {value}</code>)}
      {(change.from != null || change.to != null) && <code>{change.from === "*" ? tr(language, "任意地址", "any address", "cualquier dirección") : change.from} → {change.to === "*" ? tr(language, "任意地址", "any address", "cualquier dirección") : change.to}</code>}
      {change.expands && <span className="plugin-capability-gain">{tr(language, "扩大", "More access", "Más acceso")}</span>}
    </li>)}
  </ul>;
}
