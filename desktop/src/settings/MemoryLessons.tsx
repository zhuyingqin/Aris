import { useEffect, useState } from "react";

import {
  isTauri,
  memoryLessonDelete,
  memoryLessonSetActive,
  memoryLessonsSetEnabled,
  memoryLessonsStatus,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type { MemoryLessonView, MemoryLessonsView } from "../types";
import { tr, type Language } from "../language";

interface Props {
  language: Language;
}

// Browser-only preview so the layout can be checked outside the app.
const PREVIEW: MemoryLessonsView = {
  enabled: true,
  lessons: [
    {
      id: "preview-1",
      projectId: "default",
      tool: "PowerShell",
      statement: "本机中文 CSV 多为 GBK：读取报 UnicodeDecodeError 'utf-8' codec can't decode 时用 encoding='gbk' 打开",
      seen: 3,
      recalled: 5,
      status: "active",
      lastSeenAtMs: Date.now() - 86_400_000,
      lastRecalledAtMs: Date.now() - 3_600_000,
      sources: 2,
    },
    {
      id: "preview-2",
      projectId: "default",
      tool: "bash",
      statement: "直接运行包内脚本报 ModuleNotFoundError: No module named 'src' 时，在项目根目录用 python -m src.x 运行",
      seen: 1,
      recalled: 2,
      status: "stale",
      lastSeenAtMs: Date.now() - 20 * 86_400_000,
      lastRecalledAtMs: Date.now() - 2 * 86_400_000,
      sources: 1,
    },
  ],
};

/**
 * Lessons learned from tool failures that were fixed later in the same turn.
 * When a tool fails again with a matching error, up to three are attached to
 * that failed result (never to the system prompt). This list is where the
 * user sees, switches off, or deletes them.
 */
export default function MemoryLessons({ language }: Props) {
  const t = <T,>(cn: T, en: T, es: T) => tr(language, cn, en, es);
  const [view, setView] = useState<MemoryLessonsView | null>(isTauri() ? null : PREVIEW);
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    if (!isTauri()) return;
    try {
      setView(await memoryLessonsStatus());
      setError("");
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      if (isTauri()) {
        await action();
        await load();
      }
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
      setConfirmDelete("");
    }
  };

  const toggleEnabled = () => {
    if (!view) return;
    const next = !view.enabled;
    if (!isTauri()) {
      setView({ ...view, enabled: next });
      return;
    }
    void run("enabled", () => memoryLessonsSetEnabled(next));
  };

  const setActive = (lesson: MemoryLessonView, active: boolean) => {
    if (!isTauri() && view) {
      setView({
        ...view,
        lessons: view.lessons.map((item) => (item.id === lesson.id ? { ...item, status: active ? "active" : "archived" } : item)),
      });
      return;
    }
    void run(`status:${lesson.id}`, () => memoryLessonSetActive(lesson.id, active));
  };

  const remove = (lesson: MemoryLessonView) => {
    if (confirmDelete !== lesson.id) {
      setConfirmDelete(lesson.id);
      return;
    }
    if (!isTauri() && view) {
      setView({ ...view, lessons: view.lessons.filter((item) => item.id !== lesson.id) });
      setConfirmDelete("");
      return;
    }
    void run(`delete:${lesson.id}`, () => memoryLessonDelete(lesson.id));
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "active":
        return t("生效", "Active", "Activa");
      case "stale":
        return t("可能失效", "May be outdated", "Puede estar obsoleta");
      default:
        return t("已停用", "Off", "Desactivada");
    }
  };

  const lessons = view?.lessons ?? [];
  const active = lessons.filter((lesson) => lesson.status === "active").length;

  return (
    <section className="sp-update-section memory-lessons-section" aria-label={t("踩坑教训", "Lessons from errors", "Lecciones de errores")}>
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{t("踩坑教训", "Lessons from errors", "Lecciones de errores")}</div>
          <div className="sp-section-sub">
            {t(
              "工具报错后被修好时，记下\"什么错→怎么修\"。再遇到同类报错时，附在那次报错结果后给模型参考，不进系统提示。",
              "When a failed tool call gets fixed, the error and its fix are kept. If a similar error comes up again, the lesson is attached to that failed result for the model; it never enters the system prompt.",
              "Cuando una llamada fallida se corrige, se guardan el error y su solución. Si vuelve a aparecer un error parecido, la lección se adjunta a ese resultado para el modelo; nunca entra en el prompt del sistema.")}
          </div>
        </div>
        <button
          type="button"
          className="settings-switch"
          role="switch"
          aria-label={t("启用踩坑教训", "Use lessons from errors", "Usar lecciones de errores")}
          aria-checked={Boolean(view?.enabled)}
          disabled={!view || Boolean(busy)}
          onClick={toggleEnabled}
        >
          <span />
        </button>
      </div>

      <div className="memory-lessons-summary">
        {view
          ? t(
            `共 ${lessons.length} 条，${active} 条生效。两次附上后报错仍未修好会标为"可能失效"；180 天未用会自动停用；删除聊天会删除只从该聊天学到的教训。`,
            `${lessons.length} lessons, ${active} active. A lesson attached twice in a row without the error getting fixed is marked "may be outdated"; unused for 180 days, it is switched off; deleting a chat deletes lessons learned only from it.`,
            `${lessons.length} lecciones, ${active} activas. Si se adjunta dos veces seguidas sin que el error se corrija, se marca como "puede estar obsoleta"; tras 180 días sin uso se desactiva; al borrar un chat se borran las lecciones aprendidas solo de él.`)
          : error
            ? t("教训库不可用", "Lessons unavailable", "Lecciones no disponibles")
            : t("正在读取…", "Loading…", "Cargando…")}
      </div>

      {lessons.length > 0 && (
        <ul className="memory-lessons-list">
          {lessons.map((lesson) => (
            <li className={`memory-lesson memory-lesson-${lesson.status}`} key={lesson.id}>
              <div className="memory-lesson-body">
                <span className="memory-lesson-statement">{lesson.statement}</span>
                <small>
                  {lesson.tool} · {statusLabel(lesson.status)} · {t(
                    `踩到 ${lesson.seen} 次 · 附上 ${lesson.recalled} 次`,
                    `hit ${lesson.seen}× · attached ${lesson.recalled}×`,
                    `ocurrió ${lesson.seen}× · adjuntada ${lesson.recalled}×`)}
                </small>
              </div>
              <div className="memory-lesson-actions">
                <button
                  type="button"
                  className="sp-btn sp-btn-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => setActive(lesson, lesson.status !== "active")}
                >
                  {lesson.status === "active" ? t("停用", "Turn off", "Desactivar") : t("恢复", "Restore", "Restaurar")}
                </button>
                <button
                  type="button"
                  className={`sp-btn ${confirmDelete === lesson.id ? "sp-btn-danger" : "sp-btn-secondary"}`}
                  disabled={Boolean(busy)}
                  onClick={() => remove(lesson)}
                  onBlur={() => setConfirmDelete((current) => (current === lesson.id ? "" : current))}
                >
                  {confirmDelete === lesson.id ? t("确认删除", "Confirm delete", "Confirmar") : t("删除", "Delete", "Eliminar")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="sp-system-prompt-error" role="alert">{error}</div>}
    </section>
  );
}
