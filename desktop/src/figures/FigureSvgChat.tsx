import { useRef, useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { figureEditSvg } from "./figureApi";
import type { FigureView } from "./types";

type T = (cn: string, en: string) => string;
interface Props {
  view: FigureView; dirty: boolean; busy: boolean; historical: boolean; t: T;
  onUpdate: (view: FigureView) => void; onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
  onClose: () => void; onVersion: (index: number | null) => void; onCancel: () => void;
}

export default function FigureSvgChat({ view, dirty, busy, historical, t, onUpdate, onError, onBusy, onClose, onVersion, onCancel }: Props) {
  const { run } = view;
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  // Retain the ID across an ambiguous IPC failure, so retry cannot send twice.
  const submission = useRef<{ key: string; id: string } | null>(null);
  const latest = run.versions.at(-1);
  const unresolved = run.requests.some((request) => request.status === "unknown" || request.status === "submitted");
  const blocked = dirty ? t("请先保存或放弃当前编辑。", "Save or discard your current edits first.")
    : historical ? t("返回当前版本后可继续修改。", "Return to the current version to continue editing.")
    : view.active || busy || sending ? t("正在处理，请等待完成。", "Working on this figure. Please wait.")
    : unresolved ? t("上一请求的结果尚未确认，暂时无法提交修改。", "The previous request is unresolved; editing is temporarily unavailable.")
    : run.pendingRasterEdit ? t("请先处理 PNG 修改结果。", "Apply or discard the PNG result first.")
    : !latest ? t("保存 SVG 版本后即可通过对话修改。", "Save an SVG version to edit it through chat.") : null;
  const send = async () => {
    if (blocked || submitting.current || !latest || !prompt.trim()) return;
    const instruction = prompt.trim();
    const key = JSON.stringify([latest.index, latest.hash, instruction]);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID().replace(/-/g, "") };
    submitting.current = true; setSending(true); onBusy(true);
    try {
      const next = await figureEditSvg({ projectId: view.projectId, id: run.id, editId: submission.current.id, baseIndex: latest.index, expectedHash: latest.hash, prompt: instruction });
      onUpdate(next); setPrompt(""); submission.current = null;
    } catch (error) { onError(String(error)); }
    finally { submitting.current = false; setSending(false); onBusy(false); }
  };
  return <section className="figure-float figure-svg-chat" aria-label={t("SVG 对话修改", "Edit SVG with chat")}>
    <header><SvgIcon name="messageCircle" size={14} /><strong>{t("SVG 对话修改", "Edit SVG with chat")}</strong>
      <button type="button" className="figure-icon-button" aria-label={t("收起 SVG 对话", "Close SVG chat")} onClick={onClose}><SvgIcon name="close" size={12} /></button>
    </header>
    <div className="figure-svg-chat-history" aria-live="polite">
      <p className="figure-hint">{t("描述要改的文字、箭头或布局。修改后保存新版本，并独立审查。", "Describe changes to labels, arrows or layout. Each edit saves a new version and receives an independent review.")}</p>
      {(run.svgEdits ?? []).map((edit) => {
        const version = run.versions.find((version) => version.index === edit.resultVersion);
        const running = edit.status === "running";
        const reviewed = version?.reviewStatus === "accepted" || version?.reviewStatus === "visual_pending" && edit.status === "completed";
        return <article key={edit.id} className="figure-svg-turn">
          <p className="figure-svg-instruction">{edit.prompt}</p>
          <div className="figure-svg-reply">
            <span>{running ? (run.status === "reviewing" ? t("修改已保存，正在独立审查…", "Edit saved; independent review in progress…") : t("正在修改 SVG…", "Editing SVG…"))
              : version ? (reviewed ? (version.reviewStatus === "accepted" ? t("修改已保存，审查通过。", "Edit saved and review passed.") : t("修改已保存，结构通过，视觉待检查。", "Edit saved; structure passed, visual check pending."))
                : t("修改已保存，仍需检查。", "Edit saved; further checking is needed."))
              : t("修改未完成，原版本已保留。", "Edit did not complete. The original version is preserved.")}</span>
            {version && <button type="button" disabled={dirty || busy || view.active} onClick={() => onVersion(version.index === latest?.index ? null : version.index)}>{t("查看", "View")} v{version.index}</button>}
            {edit.error && <details><summary>{t("查看原因", "Details")}</summary><p>{edit.error}</p></details>}
            {version && run.review?.versionHash === version.hash && run.review.issues.length > 0 && <ul>{run.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
          </div>
        </article>;
      })}
    </div>
    <form className="figure-svg-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label htmlFor="figure-svg-instruction">{t("修改要求", "Your changes")}</label>
      <textarea id="figure-svg-instruction" aria-label={t("SVG 修改要求", "SVG edit instructions")} value={prompt} maxLength={4000} disabled={sending || view.active}
        placeholder={t("例如：把右侧模块向下移，修正重叠的箭头，其他部分保持不变。", "For example: move the right module down and fix overlapping arrows. Keep the rest unchanged.")}
        onChange={(event) => setPrompt(event.target.value)} />
      {blocked && <p className="figure-hint" role="status">{blocked}</p>}
      {historical && <button type="button" className="figure-button" disabled={dirty || busy || view.active} onClick={() => onVersion(null)}>{t("返回当前版本", "Back to current")}</button>}
      <div className="figure-svg-submit-actions">
        <button type="submit" className="figure-button primary" disabled={!!blocked || !prompt.trim()}><SvgIcon name="send" size={13} />{t("修改 SVG", "Edit SVG")}</button>
        <button type="button" className="figure-icon-button" style={{ visibility: view.active ? "visible" : "hidden" }} aria-label={t("取消 SVG 修改", "Cancel SVG edit")} title={t("取消 SVG 修改", "Cancel SVG edit")} onClick={onCancel}><SvgIcon name="stop" size={14} /></button>
      </div>
    </form>
  </section>;
}
