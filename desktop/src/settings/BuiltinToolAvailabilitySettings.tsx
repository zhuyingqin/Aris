import { useEffect, useState } from "react";
import { chatResearchProviderAvailability, isTauri } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import type { BuiltinToolAvailability } from "../types";

const COPY = {
  cn: {
    title: "检索工具可用性",
    subtitle: "检测网页搜索与文献搜索；不可用的提供方不会发送给 Chat。",
    refresh: "重新检测",
    checking: "检测中…",
    ready: "可用",
    unavailable: "不可用",
    empty: "尚未检测到检索工具。",
    preview: "浏览器预览不运行桌面检索工具检测。",
  },
  en: {
    title: "Research tool availability",
    subtitle: "Checks web and literature search; unavailable providers stay out of Chat.",
    refresh: "Check again",
    checking: "Checking…",
    ready: "Available",
    unavailable: "Unavailable",
    empty: "No research tools were detected.",
    preview: "Desktop research tool checks are unavailable in browser preview.",
  },
} as const;

export default function BuiltinToolAvailabilitySettings({ language }: { language: Language }) {
  const copy = COPY[language];
  const [tools, setTools] = useState<BuiltinToolAvailability[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!isTauri()) return;
    setLoading(true);
    setError("");
    try {
      setTools(await chatResearchProviderAvailability());
    } catch (refreshError) {
      setError(formatUserFacingError(refreshError, language));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  return (
    <section className="sp-update-section sp-tool-availability-section">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{copy.title}</div>
          <div className="sp-section-sub">{copy.subtitle}</div>
        </div>
        <div className="sp-update-actions">
          <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void refresh()} disabled={loading || !isTauri()}>
            <SvgIcon name={loading ? "spinner" : "refresh"} size={13} />
            {loading ? copy.checking : copy.refresh}
          </button>
        </div>
      </div>
      {!isTauri() ? (
        <div className="sp-field-hint">{copy.preview}</div>
      ) : error ? (
        <div className="sp-update-message sp-update-message-error" role="status">{error}</div>
      ) : tools.length === 0 && !loading ? (
        <div className="sp-field-hint">{copy.empty}</div>
      ) : (
        <div className="sp-tool-availability-grid" aria-busy={loading}>
          {tools.map((tool) => (
            <div className={`sp-tool-availability-item${tool.available ? "" : " is-unavailable"}`} key={tool.name}>
              <div className="sp-tool-availability-name">{tool.name}</div>
              <span className={`sp-env-badge sp-env-badge-${tool.available ? "ready" : "missing"}`}>
                {tool.available ? copy.ready : copy.unavailable}
              </span>
              <div className="sp-tool-availability-reason">{tool.reason}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
