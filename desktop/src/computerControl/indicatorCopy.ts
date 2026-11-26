// Copy and formatting for the computer-control indicator, kept free of DOM and
// Tauri imports so it can be unit-tested and shared with the chat banner.
import { isLanguage, tr, type Language } from "../language";

/** Mirrors `computer_control::ControlStatus`. */
export interface ControlStatus {
  active: boolean;
  sessionIds: string[];
  sinceMs: number | null;
  /** The one window a session was allowed to read, while it may. */
  observing?: { sessionId: string; exe: string; title: string } | null;
  language: string;
}

/** `title` for the window being read, or null while no window is granted. */
export function controlTitle(language: Language, observingTitle: string | null | undefined): string {
  if (observingTitle) {
    return tr(
      language,
      `SomniQ 正在查看「${observingTitle}」`,
      `SomniQ is viewing “${observingTitle}”`,
      `SomniQ está viendo «${observingTitle}»`,
    );
  }
  return tr(
    language,
    "SomniQ 电脑操作模式运行中",
    "SomniQ computer-use mode is running",
    "Modo de uso del ordenador de SomniQ en ejecución",
  );
}

export function indicatorCopy(language: string, sessionCount: number, observingTitle?: string | null) {
  const lang: Language = isLanguage(language) ? language : "cn";
  const base = controlTitle(lang, observingTitle);
  return {
    htmlLang: tr(lang, "zh-CN", "en", "es"),
    title: sessionCount > 1
      ? `${base}${tr(lang, `（${sessionCount} 个对话）`, ` (${sessionCount} chats)`, ` (${sessionCount} chats)`)}`
      : base,
    tooltip: tr(
      lang,
      "电脑操作模式下的对话正在运行。随时可以点“停止”中断它。",
      "A chat in computer-use mode is running. You can stop it at any time.",
      "Hay un chat en modo de uso del ordenador en ejecución. Puedes detenerlo en cualquier momento.",
    ),
    stop: tr(lang, "停止", "Stop", "Detener"),
    stopping: tr(lang, "正在停止…", "Stopping…", "Deteniendo…"),
    stopTitle: tr(
      lang,
      "停止所有电脑操作模式下正在运行的对话",
      "Stop every chat running in computer-use mode",
      "Detener todos los chats en modo de uso del ordenador",
    ),
  };
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
