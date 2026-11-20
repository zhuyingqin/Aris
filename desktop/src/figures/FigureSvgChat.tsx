import { useRef, useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { figureEditSvg } from "./figureApi";
import type { FigureView } from "./types";
import FigureResizeHandle, { useFigurePanelSize } from "./FigureResizeHandle";

type T = (cn: string, en: string, es: string) => string;
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
  const panelRef = useRef<HTMLElement>(null);
  const layout = useFigurePanelSize("svg-chat");
  // Retain the ID across an ambiguous IPC failure, so retry cannot send twice.
  const submission = useRef<{ key: string; id: string } | null>(null);
  const latest = run.versions.at(-1);
  const unresolved = run.requests.some((request) => request.status === "unknown" || request.status === "submitted");
  const blocked = dirty ? t("请先保存或放弃当前编辑。", "Save or discard your current edits first.", "Primero guarda o descarta los cambios actuales.")
    : historical ? t("返回当前版本后可继续修改。", "Return to the current version to continue editing.", "Vuelve a la versión actual para seguir editando.")
    : view.active || busy || sending ? t("正在处理，请等待完成。", "Working on this figure. Please wait.", "Trabajando en esta figura. Espera un momento.")
    : unresolved ? t("上一请求的结果尚未确认，暂时无法提交修改。", "The previous request is unresolved; editing is temporarily unavailable.", "La solicitud anterior sigue sin resolverse; la edición no está disponible por ahora.")
    : run.pendingRasterEdit ? t("请先处理 PNG 修改结果。", "Apply or discard the PNG result first.", "Primero aplica o descarta el resultado PNG.")
    : !latest ? t("保存 SVG 版本后即可通过对话修改。", "Save an SVG version to edit it through chat.", "Guarda una versión SVG para editarla mediante el chat.") : null;
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
  return <section ref={panelRef} style={layout.style} className="figure-float figure-svg-chat" aria-label={t("SVG 对话修改", "Edit SVG with chat", "Editar el SVG con chat")}>
    <header><SvgIcon name="messageCircle" size={14} /><strong>{t("SVG 对话修改", "Edit SVG with chat", "Editar el SVG con chat")}</strong>
      <button type="button" className="figure-icon-button" aria-label={t("收起 SVG 对话", "Close SVG chat", "Cerrar el chat del SVG")} onClick={onClose}><SvgIcon name="close" size={12} /></button>
    </header>
    <div className="figure-svg-chat-history" aria-live="polite">
      {(run.svgEdits ?? []).map((edit) => {
        const version = run.versions.find((version) => version.index === edit.resultVersion);
        const running = edit.status === "running";
        const reviewed = version?.reviewStatus === "accepted" || version?.reviewStatus === "visual_pending" && edit.status === "completed";
        return <article key={edit.id} className="figure-svg-turn">
          <p className="figure-svg-instruction">{edit.prompt}</p>
          <div className="figure-svg-reply">
            <span>{running ? (run.status === "reviewing" ? t("修改已保存，正在独立审查…", "Edit saved; independent review in progress…", "Cambio guardado; revisión independiente en curso…") : t("正在修改 SVG…", "Editing SVG…", "Editando el SVG…"))
              : version ? (reviewed ? (version.reviewStatus === "accepted" ? t("修改已保存，审查通过。", "Edit saved and review passed.", "Cambio guardado y revisión superada.") : t("修改已保存，结构通过，视觉待检查。", "Edit saved; structure passed, visual check pending.", "Cambio guardado; estructura aprobada, revisión visual pendiente."))
                : t("修改已保存，仍需检查。", "Edit saved; further checking is needed.", "Cambio guardado; hace falta revisarlo más."))
              : t("修改未完成，原版本已保留。", "Edit did not complete. The original version is preserved.", "El cambio no se completó. Se conserva la versión original.")}</span>
            {version && <button type="button" disabled={dirty || busy || view.active} onClick={() => onVersion(version.index === latest?.index ? null : version.index)}>{t("查看", "View", "Ver")} v{version.index}</button>}
            {edit.error && <details><summary>{t("查看原因", "Details", "Detalles")}</summary><p>{edit.error}</p></details>}
            {version && run.review?.versionHash === version.hash && run.review.issues.length > 0 && <ul>{run.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
          </div>
        </article>;
      })}
    </div>
    <form className="figure-svg-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label htmlFor="figure-svg-instruction">{t("修改要求", "Your changes", "Tus cambios")}</label>
      <textarea id="figure-svg-instruction" aria-label={t("SVG 修改要求", "SVG edit instructions", "Instrucciones de edición del SVG")} value={prompt} maxLength={4000} disabled={sending || view.active}
        placeholder={t("例如：把右侧模块向下移，修正重叠的箭头，其他部分保持不变。", "For example: move the right module down and fix overlapping arrows. Keep the rest unchanged.", "Por ejemplo: baja el módulo de la derecha y corrige las flechas superpuestas. Deja el resto igual.")}
        onChange={(event) => setPrompt(event.target.value)} />
      {blocked && <p className="figure-hint" role="status">{blocked}</p>}
      {historical && <button type="button" className="figure-button" disabled={dirty || busy || view.active} onClick={() => onVersion(null)}>{t("返回当前版本", "Back to current", "Volver a la actual")}</button>}
      <div className="figure-svg-submit-actions">
        <button type="submit" className="figure-button primary" disabled={!!blocked || !prompt.trim()}><SvgIcon name="send" size={13} />{t("修改 SVG", "Edit SVG", "Editar SVG")}</button>
        <button type="button" className="figure-icon-button" style={{ visibility: view.active ? "visible" : "hidden" }} aria-label={t("取消 SVG 修改", "Cancel SVG edit", "Cancelar la edición del SVG")} title={t("取消 SVG 修改", "Cancel SVG edit", "Cancelar la edición del SVG")} onClick={onCancel}><SvgIcon name="stop" size={14} /></button>
      </div>
    </form>
    <FigureResizeHandle className="edge-start" label={t("调整 SVG 对话宽度", "Resize SVG chat width", "Cambiar el ancho del chat del SVG")} panelRef={panelRef}
      directionX={-1} minWidth={260} reserveWidth={344} onResize={layout.resize} onReset={layout.reset} />
    <FigureResizeHandle className="corner-bottom-start" axis="both" label={t("调整 SVG 对话大小", "Resize SVG chat", "Cambiar el tamaño del chat del SVG")}
      panelRef={panelRef} directionX={-1} minWidth={260} reserveWidth={344} onResize={layout.resize} onReset={layout.reset} />
  </section>;
}
