// Computer-use mode in Chat: the composer toggle, the in-chat banner, the
// window-access card, and the hook that keeps them in sync with the backend.
// The always-on-top pill on every monitor and the frame around the window
// being read are separate windows (control-indicator.html).
import { useCallback, useEffect, useState } from "react";

import {
  chatComputerUseGet,
  chatComputerUseSet,
  computerAccessPending,
  computerAccessRespond,
  computerControlStatus,
  computerControlStop,
  isTauri,
} from "../api/tauri";
import { controlTitle, formatElapsed, type ControlStatus } from "../computerControl/indicatorCopy";
import { tr, type Language } from "../language";
import { SvgIcon } from "../SvgIcon";
import "./ComputerUse.css";

/** One window offered on the access card. Mirrors the helper's `list_windows`. */
export interface AccessWindow {
  hwnd: number;
  pid: number;
  exe: string;
  title: string | null;
  tier: "read_only" | "requires_grant" | string;
  tierReason: string;
  minimized: boolean;
}

/** Mirrors the `computer-access-request` payload. */
export interface ComputerAccessRequest {
  sessionId: string;
  toolUseId: string;
  reason: string;
  /** Model and endpoint the window's content will be sent to. */
  model: string;
  windows: AccessWindow[];
  hiddenByPolicy?: number;
}

export interface ComputerUseState {
  enabled: boolean;
  busy: boolean;
  /** This session currently has a turn running in computer-use mode. */
  controlling: boolean;
  controlSinceMs: number | null;
  /** Title of the window this session may read right now. */
  observingTitle: string | null;
  pendingAccess: ComputerAccessRequest | null;
  change: (enabled: boolean) => Promise<void>;
  stop: () => Promise<void>;
  respondAccess: (toolUseId: string, hwnd: number | null) => Promise<void>;
}

async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => handler(message.payload));
}

export function useComputerUse(
  sessionId: string,
  onError: (message: string) => void,
): ComputerUseState {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [requests, setRequests] = useState<ComputerAccessRequest[]>([]);

  useEffect(() => {
    if (!isTauri()) {
      setEnabled(false);
      return;
    }
    let live = true;
    chatComputerUseGet(sessionId)
      .then((value) => {
        if (live) setEnabled(value);
      })
      .catch(() => {
        if (live) setEnabled(false);
      });
    // A card sent while this chat was not on screen is still waiting.
    computerAccessPending(sessionId)
      .then((pending) => {
        if (!live) return;
        setRequests((current) => [
          ...current.filter((request) => request.sessionId !== sessionId),
          ...pending,
        ]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (live) stops.push(stop);
      else stop();
    };
    computerControlStatus()
      .then((status) => {
        if (live) setControl(status);
      })
      .catch(() => undefined);
    // Without these events the UI only misses live updates; the fetches
    // above still show the current state.
    subscribe<ControlStatus>("computer-control-changed", setControl).then(keep).catch(() => undefined);
    subscribe<ComputerAccessRequest>("computer-access-request", (request) =>
      setRequests((current) => [...current.filter((item) => item.toolUseId !== request.toolUseId), request]),
    ).then(keep).catch(() => undefined);
    subscribe<{ toolUseId: string }>("computer-access-resolved", ({ toolUseId }) =>
      setRequests((current) => current.filter((item) => item.toolUseId !== toolUseId)),
    ).then(keep).catch(() => undefined);
    return () => {
      live = false;
      stops.forEach((stop) => stop());
    };
  }, []);

  const change = useCallback(
    async (next: boolean) => {
      if (!isTauri()) {
        setEnabled(next);
        return;
      }
      setBusy(true);
      try {
        setEnabled(await chatComputerUseSet(sessionId, next));
      } catch (error) {
        onError(String(error));
      } finally {
        setBusy(false);
      }
    },
    [onError, sessionId],
  );

  const stop = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await computerControlStop();
    } catch (error) {
      onError(String(error));
    }
  }, [onError]);

  const respondAccess = useCallback(
    async (toolUseId: string, hwnd: number | null) => {
      setRequests((current) => current.filter((item) => item.toolUseId !== toolUseId));
      if (!isTauri()) return;
      try {
        await computerAccessRespond(toolUseId, hwnd);
      } catch (error) {
        onError(String(error));
      }
    },
    [onError],
  );

  const controlling = Boolean(control?.active && control.sessionIds.includes(sessionId));
  const observing = control?.observing && control.observing.sessionId === sessionId ? control.observing : null;
  return {
    enabled,
    busy,
    controlling,
    controlSinceMs: controlling ? control?.sinceMs ?? null : null,
    observingTitle: observing?.title ?? null,
    pendingAccess: requests.find((request) => request.sessionId === sessionId) ?? null,
    change,
    stop,
    respondAccess,
  };
}

export function ComputerUsePill({
  language,
  enabled,
  disabled,
  onChange,
}: {
  language: Language;
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`chat-pill chat-computer-use-pill${enabled ? " is-on" : ""}`}
      aria-pressed={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      title={enabled
        ? tr(language, "关闭电脑操作模式，恢复本对话的全部工具", "Turn computer-use mode off and restore this chat's tools", "Desactivar el modo de uso del ordenador y restaurar las herramientas de este chat")
        : tr(language, "开启电脑操作模式：本对话只能读文件、提问，并在你同意后只读查看你指定的一个窗口；Shell、代码执行、MCP、插件和项目 hooks 全部停用", "Turn computer-use mode on: this chat can only read files, ask you, and with your consent view one window you pick (read-only); shell, code execution, MCP, plugins and project hooks are disabled", "Activar el modo de uso del ordenador: este chat solo puede leer archivos, preguntarte y, con tu permiso, ver una ventana que elijas (solo lectura); se desactivan shell, ejecución de código, MCP, complementos y hooks del proyecto")}
    >
      <SvgIcon name="desktop" size={13} />
      <span>{tr(language, "电脑操作", "Computer use", "Uso del ordenador")}</span>
    </button>
  );
}

export function ComputerUseBanner({
  language,
  controlling,
  controlSinceMs,
  observingTitle = null,
  onStop,
}: {
  language: Language;
  controlling: boolean;
  controlSinceMs: number | null;
  observingTitle?: string | null;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!controlling) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [controlling]);
  return (
    <div className={`chat-computer-use-banner${controlling ? " is-controlling" : ""}`} role="status">
      <span className="chat-computer-use-dot" aria-hidden="true" />
      <div className="chat-computer-use-text">
        <strong>
          {controlling
            ? controlTitle(language, observingTitle)
            : tr(language, "电脑操作模式已开启", "Computer-use mode is on", "El modo de uso del ordenador está activado")}
          {controlling && controlSinceMs ? <span className="chat-computer-use-elapsed">{formatElapsed(now - controlSinceMs)}</span> : null}
        </strong>
        <span>
          {tr(
            language,
            "本对话只能读项目文件、向你提问，并在你同意后只读查看你选的一个窗口；Shell、代码执行、MCP、插件和项目 hooks 已停用，调用会被直接拒绝。运行时每块屏幕顶部会显示提示条。",
            "This chat can only read project files, ask you questions and, with your consent, view one window you pick (read-only). Shell, code execution, MCP, plugins and project hooks are disabled, and calls to them are refused. While it runs, a banner shows at the top of every screen.",
            "Este chat solo puede leer archivos del proyecto, hacerte preguntas y, con tu permiso, ver una ventana que elijas (solo lectura). Shell, ejecución de código, MCP, complementos y hooks del proyecto están desactivados y sus llamadas se rechazan. Mientras se ejecuta, aparece un aviso en la parte superior de cada pantalla.",
          )}
        </span>
      </div>
      {controlling && (
        <button type="button" className="chat-computer-use-stop" onClick={onStop}>
          {tr(language, "停止", "Stop", "Detener")}
        </button>
      )}
    </div>
  );
}

function tierLabel(language: Language, tier: string): string | null {
  return tier === "read_only"
    ? tr(language, "浏览器/终端/IDE：本来就只能看", "Browser / terminal / IDE: view only", "Navegador / terminal / IDE: solo ver")
    : null;
}

export function ComputerAccessCard({
  language,
  request,
  onRespond,
}: {
  language: Language;
  request: ComputerAccessRequest;
  onRespond: (toolUseId: string, hwnd: number | null) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [request.toolUseId]);
  return (
    <div className="chat-computer-access-card" role="dialog" aria-label={tr(language, "查看窗口的请求", "Request to view a window", "Solicitud para ver una ventana")}>
      <div className="chat-computer-access-head">
        <SvgIcon name="desktop" size={15} />
        <strong>{tr(language, "SomniQ 想查看你电脑上的一个窗口", "SomniQ wants to view one window on your computer", "SomniQ quiere ver una ventana de tu ordenador")}</strong>
      </div>
      <p className="chat-computer-access-reason">
        <span>{tr(language, "理由：", "Reason: ", "Motivo: ")}</span>{request.reason}
      </p>
      <p className="chat-computer-access-note">
        {tr(
          language,
          `只读：能读取所选窗口的控件文字和截图，不能点击或输入；本轮结束后失效。这些内容会发送给 ${request.model}。窗口列表只给你看，模型看不到。`,
          `Read-only: it can read the chosen window's controls and take screenshots of it, never click or type; access ends with this turn. That content is sent to ${request.model}. Only you see this list.`,
          `Solo lectura: puede leer los controles de la ventana elegida y capturarla, nunca hacer clic ni escribir; el acceso termina con este turno. Ese contenido se envía a ${request.model}. Solo tú ves esta lista.`,
        )}
      </p>
      <ul className="chat-computer-access-list">
        {request.windows.map((window) => {
          const label = tierLabel(language, window.tier);
          return (
            <li key={window.hwnd}>
              <label className={selected === window.hwnd ? "is-selected" : undefined}>
                <input
                  type="radio"
                  name={`computer-access-${request.toolUseId}`}
                  checked={selected === window.hwnd}
                  onChange={() => setSelected(window.hwnd)}
                />
                <span className="chat-computer-access-title">{window.title || tr(language, "（无标题）", "(untitled)", "(sin título)")}</span>
                <span className="chat-computer-access-exe">{window.exe}</span>
                {window.minimized && <span className="chat-computer-access-tag">{tr(language, "已最小化", "Minimized", "Minimizada")}</span>}
                {label && <span className="chat-computer-access-tag">{label}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {request.hiddenByPolicy ? (
        <p className="chat-computer-access-hidden">
          {tr(
            language,
            `另有 ${request.hiddenByPolicy} 个窗口不能被查看，已隐藏（SomniQ 自身、系统与凭据界面、密码管理器、聊天邮件、远程桌面、其他 AI 客户端）。`,
            `${request.hiddenByPolicy} more windows cannot be viewed and are hidden (SomniQ itself, system and credential screens, password managers, chat and mail, remote desktop, other AI clients).`,
            `Otras ${request.hiddenByPolicy} ventanas no se pueden ver y están ocultas (SomniQ, pantallas del sistema y credenciales, gestores de contraseñas, chat y correo, escritorio remoto, otros clientes de IA).`,
          )}
        </p>
      ) : null}
      <div className="chat-computer-access-actions">
        <button type="button" className="chat-computer-access-deny" onClick={() => onRespond(request.toolUseId, null)}>
          {tr(language, "拒绝", "Refuse", "Rechazar")}
        </button>
        <button
          type="button"
          className="chat-computer-access-allow"
          disabled={selected === null}
          onClick={() => selected !== null && onRespond(request.toolUseId, selected)}
        >
          {tr(language, "允许查看所选窗口", "Allow viewing this window", "Permitir ver esta ventana")}
        </button>
      </div>
    </div>
  );
}
