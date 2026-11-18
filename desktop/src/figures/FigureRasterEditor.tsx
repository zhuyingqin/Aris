import { useEffect, useRef, useState, type PointerEvent } from "react";
import { SvgIcon } from "../SvgIcon";
import { figureEditImage, figureEditResultDocument, figureResolveEditResult, figureRasterDocument, type ImageResultChoice } from "./figureApi";
import { imagePoint, rectangleRegion, regionArea, selectionMask, type ImagePoint, type ImageRegion } from "./rasterSelection";
import type { FigureRasterDocument, FigureView } from "./types";
import { statusLabel } from "./figureModel";
import FigureResizeHandle, { useFigurePanelSize } from "./FigureResizeHandle";

type Props = {
  view: FigureView; available: boolean; locked: boolean;
  t: (cn: string, en: string, es: string) => string;
  onUpdate: (view: FigureView) => void; onError: (error: string) => void;
  onNext: (document: FigureRasterDocument) => Promise<void>; onCancel: () => void;
};

export default function FigureRasterEditor({ view, available, locked, t, onUpdate, onError, onNext, onCancel }: Props) {
  const { run, projectId } = view;
  const [index, setIndex] = useState<number | null>(null);
  const [image, setImage] = useState<FigureRasterDocument | null>(null);
  const [resultChoice, setResultChoice] = useState<ImageResultChoice>("selection");
  const [resultPreview, setResultPreview] = useState<{ choice: ImageResultChoice; image: FigureRasterDocument } | null>(null);
  const [regions, setRegions] = useState<ImageRegion[]>([]);
  const [drawing, setDrawing] = useState<ImageRegion>([]);
  const [tool, setTool] = useState<"lasso" | "rectangle">("lasso");
  const [scope, setScope] = useState<"selection" | "whole">("selection");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const controlsRef = useRef<HTMLElement>(null);
  const layout = useFigurePanelSize("png-controls");
  const stroke = useRef<ImageRegion>([]);
  const versions = run.rasterVersions ?? [];
  const historyPrompt = versions.find((version) => version.index === image?.index)?.prompt;
  const result = run.pendingRasterEdit;
  const displayImage = result && resultChoice !== "keep" ? (resultPreview?.choice === resultChoice ? resultPreview.image : null) : image;
  const latest = versions.at(-1)?.index;
  const disabled = busy || locked || view.active;
  const unresolved = run.status === "unknown" || run.requests.some((r) => r.status === "unknown" || r.status === "submitted");
  const exhausted = run.requests.length >= 199 || versions.length >= 100;
  const editable = available && !disabled && !unresolved && !exhausted && !result;
  const hasArea = scope === "whole" || regions.length > 0;
  const submitHint = unresolved ? null : result ? t("请先选择如何采用返回图片。", "Choose how to use the returned image first.", "Primero elige cómo usar la imagen devuelta.")
    : !available ? t("请先在设置中配置 SomniImage。", "Configure SomniImage in Settings first.", "Primero configura SomniImage en Configuración.")
    : exhausted ? t("此任务的图片修改次数已用完，可点击下一步继续。", "This task has reached its image-edit limit. Use Next to continue.", "Esta tarea alcanzó su límite de ediciones de imagen. Usa Siguiente para continuar.")
    : view.active ? t("请等待当前任务完成。", "Wait for the current task to finish.", "Espera a que termine la tarea actual.")
    : busy ? t("正在提交…", "Submitting…", "Enviando…")
    : locked ? t("请先保存或放弃未保存的 SVG 编辑。", "Save or discard your SVG edits first.", "Primero guarda o descarta los cambios del SVG.")
    : !image ? t("正在载入图片…", "Loading image…", "Cargando imagen…")
    : drawing.length ? t("松开鼠标即可完成圈选。", "Release the pointer to finish selecting.", "Suelta el puntero para terminar la selección.")
    : !hasArea ? t("请先在左侧图片拖动圈选区域，或选择「整图修改」。", 'Drag over the image to select an area, or choose "Whole image".', "Arrastra sobre la imagen para seleccionar una zona o elige «Imagen completa».")
    : !prompt.trim() ? t("请填写想要怎样修改图片。", "Describe how you want to change the image.", "Describe cómo quieres cambiar la imagen.")
    : null;

  // New results open automatically; merely opening a historical revision is local.
  useEffect(() => { setIndex(latest ?? null); }, [latest]);
  useEffect(() => { if (result) { setIndex(result.parentIndex ?? null); setResultChoice("selection"); } }, [result?.requestId]);
  useEffect(() => {
    let disposed = false;
    setResultPreview(null);
    if (result?.requestId && resultChoice !== "keep") {
      void figureEditResultDocument(projectId, run.id, result.requestId, result.hash, resultChoice)
        .then((doc) => { if (!disposed) setResultPreview({ choice: resultChoice, image: doc }); }).catch((error) => { if (!disposed) onError(String(error)); });
    }
    return () => { disposed = true; };
  }, [projectId, run.id, result?.requestId, result?.hash, resultChoice]);
  useEffect(() => {
    let disposed = false;
    setImage(null); setRegions([]); setDrawing([]); stroke.current = [];
    void figureRasterDocument(projectId, run.id, index).then((doc) => { if (!disposed) setImage(doc); }).catch((e) => { if (!disposed) onError(String(e)); });
    return () => { disposed = true; };
  }, [projectId, run.id, index, run.sourceHash]);

  const point = (event: PointerEvent<SVGSVGElement>, clamp = false) => image ? imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), image.width, image.height, clamp) : null;
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || result || scope === "whole" || stroke.current.length || event.button !== 0 || regions.length >= 32) return;
    const start = point(event); if (!start) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = [start]; setDrawing([start]);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!stroke.current.length || disabled) return;
    const next = point(event, true); if (!next) return;
    if (tool === "rectangle") stroke.current = rectangleRegion(stroke.current[0], next);
    else if (stroke.current.length < 5000) {
      const previous = stroke.current.at(-1)!;
      if (Math.hypot(next.x - previous.x, next.y - previous.y) >= 0.5) stroke.current = [...stroke.current, next];
    }
    setDrawing([...stroke.current]);
  };
  const up = (event: PointerEvent<SVGSVGElement>) => {
    if (!stroke.current.length) return;
    move(event);
    const completed = [...stroke.current];
    if (completed.length >= 3 && regionArea(completed) >= 4) setRegions((all) => [...all, completed]);
    stroke.current = []; setDrawing([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const clear = () => { setRegions([]); setDrawing([]); stroke.current = []; };
  const changeScope = (next: "selection" | "whole") => { setScope(next); setDrawing([]); stroke.current = []; };
  const submit = async () => {
    if (submitting.current || !image || !editable || !prompt.trim() || !hasArea || stroke.current.length) return;
    submitting.current = true; setBusy(true);
    try {
      const areas = scope === "whole" ? [rectangleRegion({ x: 0, y: 0 }, { x: image.width, y: image.height })] : regions;
      const maskBase64 = selectionMask(image.width, image.height, areas);
      const instruction = prompt.trim();
      setPrompt("");
      const next = await figureEditImage({ projectId, id: run.id, baseIndex: image.index, expectedHash: image.hash, prompt: instruction, maskBase64 });
      onUpdate(next);
    } catch (e) { onError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const next = async () => {
    if (submitting.current || !image || disabled || result) return;
    submitting.current = true; setBusy(true);
    try { await onNext(image); } catch (e) { onError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const adoptResult = async () => {
    if (submitting.current || !result?.requestId || disabled || unresolved || !displayImage) return;
    submitting.current = true; setBusy(true);
    try {
      const next = await figureResolveEditResult(projectId, run.id, result.requestId, result.hash, resultChoice);
      onUpdate(next); setResultPreview(null); clear();
    } catch (error) { onError(String(error)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const points = (region: ImagePoint[]) => region.map((p) => `${p.x},${p.y}`).join(" ");

  return <div className="figure-raster-editor" aria-label={t("PNG 局部修改", "PNG region editor", "Editor de zonas PNG")}>
    <div className="figure-raster-workspace">
      {!result && <div className="figure-raster-toolbar">
        <div className="figure-segmented" role="group" aria-label={t("圈选工具", "Selection tools", "Herramientas de selección")}>
          <button type="button" className={scope === "selection" && tool === "lasso" ? "selected" : ""} aria-pressed={scope === "selection" && tool === "lasso"} disabled={disabled} onClick={() => { setTool("lasso"); changeScope("selection"); }}><SvgIcon name="edit" size={13} />{t("自由圈选", "Lasso", "Lazo")}</button>
          <button type="button" className={scope === "selection" && tool === "rectangle" ? "selected" : ""} aria-pressed={scope === "selection" && tool === "rectangle"} disabled={disabled} onClick={() => { setTool("rectangle"); changeScope("selection"); }}><SvgIcon name="grid" size={13} />{t("矩形", "Rectangle", "Rectángulo")}</button>
        </div>
        <button type="button" className="figure-button ghost" disabled={disabled || scope === "whole" || !regions.length} onClick={() => setRegions((all) => all.slice(0, -1))}>{t("撤销圈选", "Undo selection", "Deshacer selección")}</button>
        <button type="button" className="figure-button ghost" disabled={disabled || scope === "whole" || (!regions.length && !drawing.length)} onClick={clear}>{t("清除", "Clear", "Borrar")}</button>
        <span>{scope === "whole" ? t("修改范围：整张图片", "Scope: whole image", "Alcance: imagen completa") : t(`已选 ${regions.length} 个区域`, `${regions.length} ${regions.length === 1 ? "region" : "regions"} selected`, `${regions.length} ${regions.length === 1 ? "zona seleccionada" : "zonas seleccionadas"}`)}</span>
      </div>}
      <div className="figure-raster-surface">
        {displayImage ? <svg viewBox={`0 0 ${displayImage.width} ${displayImage.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={result ? t("图片结果预览", "Image result preview", "Vista previa del resultado") : t("圈选图片区域", "Select an image region", "Seleccionar una zona de la imagen")} className={disabled || result || scope === "whole" ? "locked" : ""}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { stroke.current = []; setDrawing([]); }}>
          <image href={displayImage.dataUrl} width={displayImage.width} height={displayImage.height} />
          {!result && (scope === "whole" ? <rect width={displayImage.width} height={displayImage.height} className="figure-raster-region whole" vectorEffect="non-scaling-stroke" />
            : regions.map((region, i) => <polygon key={i} points={points(region)} className="figure-raster-region" vectorEffect="non-scaling-stroke" />))}
          {drawing.length > 1 && <polyline points={points(drawing)} className="figure-raster-region drawing" vectorEffect="non-scaling-stroke" />}
        </svg> : <span className="figure-spin large" aria-label={t("载入图片", "Loading image…", "Cargando imagen…")} />}
        {view.active && <div className="figure-raster-progress"><span className="figure-spin" />{t(statusLabel(run.status, "cn"), statusLabel(run.status, "en"), statusLabel(run.status, "es"))}<button className="figure-button" onClick={onCancel}>{t("取消", "Cancel", "Cancelar")}</button></div>}
      </div>
      <p className="figure-raster-caption">{result ? t("切换查看结果，选择采用方式。原图仍保留。", "Preview the result and choose how to use it. The original is kept.", "Previsualiza el resultado y elige cómo usarlo. Se conserva el original.") : scope === "whole" ? t("整张图片都在修改范围内。修改结果保存为新版本，原图仍保留。", "The whole image can change. Results are saved as a new version; the original is kept.", "Puede cambiar toda la imagen. El resultado se guarda como una versión nueva y se conserva el original.")
        : t("在图上拖动圈出修改区域，可添加多个圈选。圈外像素保留原样。", "Drag to select an area; add more regions as needed. Pixels outside the selection stay unchanged.", "Arrastra para seleccionar una zona; añade más si lo necesitas. Los píxeles fuera de la selección no cambian.")}{displayImage && <span>{displayImage.width} × {displayImage.height}</span>}</p>
    </div>
    <FigureResizeHandle label={t("调整图片与修改区域宽度", "Resize image and edit panel", "Cambiar el ancho de la imagen y del panel de edición")} panelRef={controlsRef}
      directionX={-1} minWidth={240} reserveWidth={332} onResize={layout.resize} onReset={layout.reset} />
    <aside ref={controlsRef} style={layout.style} className="figure-raster-controls">
      <h2>{t("图片修改", "Image edits", "Edición de imagen")}</h2>
      {result && <section className="figure-raster-result" aria-label={t("采用图片结果", "Use image result", "Usar el resultado de imagen")}>
        <strong>{t("预览修改结果", "Preview edited image", "Vista previa de la imagen editada")}</strong>
        <p className="figure-hint">{t("图片画幅变化较大，请检查预览后应用修改。", "The image canvas changed considerably. Check the preview before applying your edit.", "El lienzo de la imagen cambió bastante. Revisa la vista previa antes de aplicar el cambio.")}</p>
        <label>{t("采用方式", "Apply as", "Aplicar como")}<select aria-label={t("采用方式", "Apply as", "Aplicar como")} disabled={disabled} value={resultChoice} onChange={(event) => setResultChoice(event.target.value as ImageResultChoice)}>
          <option value="selection">{t("仅应用圈选修改（推荐）", "Selected area only (recommended)", "Solo la zona seleccionada (recomendado)")}</option>
          <option value="returned">{t("使用整张修改图", "Use entire edited image", "Usar toda la imagen editada")}</option>
          <option value="keep">{t("保留原图", "Keep original", "Conservar el original")}</option>
        </select></label>
        <p className="figure-hint">{resultChoice === "returned" ? t("采用整张修改图和新画幅，圈外内容也可能变化。", "Uses the entire edited image and its new canvas; content outside the selection may change.", "Usa toda la imagen editada y su nuevo lienzo; el contenido fuera de la selección puede cambiar.") : resultChoice === "selection" ? t("保留原图尺寸与圈外内容，请检查选区内文字和形状。", "Keeps the original dimensions and content outside the selection. Check text and shapes within the edited area.", "Conserva las dimensiones originales y el contenido fuera de la selección. Revisa el texto y las formas de la zona editada.") : t("继续使用原图，修改图仍保留。", "Keeps the original. The edited image is also saved.", "Conserva el original. La imagen editada también se guarda.")}</p>
        <details><summary>{t("图片尺寸", "Image dimensions", "Dimensiones de la imagen")}</summary><p className="figure-hint">{t("修改图", "Edited", "Editada")} {result.width} × {result.height} · {t("原图", "Original", "Original")} {image?.width ?? "…"} × {image?.height ?? "…"}</p></details>
        <button type="button" className="figure-button primary block" disabled={disabled || unresolved || !displayImage} onClick={() => void adoptResult()}>{resultChoice === "returned" ? t("使用整张修改图", "Use entire edited image", "Usar toda la imagen editada") : resultChoice === "selection" ? t("应用修改", "Apply edit", "Aplicar cambio") : t("保留原图", "Keep original", "Conservar el original")}</button>
      </section>}
      <label>{t("图片版本", "Image version", "Versión de imagen")}<select aria-label={t("图片版本", "Image version", "Versión de imagen")} disabled={disabled || !!result} value={image?.index ?? index ?? ""} onChange={(e) => setIndex(Number(e.target.value))}>
        {!versions.length && image && <option value={image.index}>{t("原图", "Original", "Original")}</option>}
        {!image && <option value="">{t("载入中…", "Loading…", "Cargando…")}</option>}
        {versions.map((version) => <option key={version.index} value={version.index}>{version.index === 1 ? t("原图", "Original", "Original") : `${t("修改", "Edit", "Edición")} ${version.index - 1}`}{version.index === run.sourceRaster ? t(" · SVG 参考图", " · SVG reference", " · referencia del SVG") : ""}</option>)}
      </select></label>
      {historyPrompt && <details key={`history-${image?.index}`} className="figure-raster-prompt"><summary>{t("修改记录", "Edit history", "Historial de cambios")}</summary><p>{historyPrompt}</p></details>}
      {image?.resolvedPrompt && <details className="figure-raster-prompt"><summary>{t("Executor 整理的提示词", "Executor image prompt", "Prompt de imagen del Executor")}{image.promptModel && <small>{image.promptModel}</small>}</summary><p>{image.resolvedPrompt}</p></details>}
      {!result && <><div className="figure-raster-scope">
        <span>{t("修改范围", "Edit scope", "Alcance del cambio")}</span>
        <div className="figure-segmented" role="group" aria-label={t("修改范围", "Edit scope", "Alcance del cambio")}>
          <button type="button" className={scope === "selection" ? "selected" : ""} aria-pressed={scope === "selection"} disabled={disabled} onClick={() => changeScope("selection")}>{t("圈选区域", "Selected area", "Zona seleccionada")}</button>
          <button type="button" className={scope === "whole" ? "selected" : ""} aria-pressed={scope === "whole"} disabled={disabled} onClick={() => changeScope("whole")}>{t("整图修改", "Whole image", "Imagen completa")}</button>
        </div>
      </div>
      <label htmlFor={`png-prompt-${run.id}`}>{t("修改要求", "Edit instruction", "Instrucción de edición")}</label>
      <textarea id={`png-prompt-${run.id}`} placeholder={scope === "whole" ? t("例如：将 MA 模块移到储备池内部，其他布局尽量保持一致。", "For example: Move the MA module inside the reservoir and keep the rest of the layout consistent.", "Por ejemplo: mueve el módulo MA dentro del reservorio y mantén el resto del diseño igual.") : t("例如：把圈选框中的文字改为「输入层」，保持原字体和配色。", 'For example: Change the selected label to "Input layer", keeping its font and colors.', "Por ejemplo: cambia la etiqueta seleccionada a «Capa de entrada» y conserva su fuente y sus colores.")} value={prompt} maxLength={4000} disabled={disabled} onChange={(e) => setPrompt(e.target.value)} />
      <div className="figure-raster-submit">
        {!unresolved && <p id={`png-submit-hint-${run.id}`} className={`figure-hint${!hasArea && editable && image ? " selection-needed" : ""}`} role="status">{submitHint ?? (scope === "whole" ? t("AI 可修改整张图片，包括未圈选的部分。", "AI can change any part of the image.", "La IA puede cambiar cualquier parte de la imagen.") : t("只修改圈选区域，圈外像素保留原样。", "Only the selected area changes; other pixels stay unchanged.", "Solo cambia la zona seleccionada; el resto de los píxeles no cambia."))}</p>}
        <button type="button" className="figure-button primary block" disabled={!editable || !!submitHint} title={submitHint ?? undefined} aria-describedby={unresolved ? undefined : `png-submit-hint-${run.id}`} onClick={() => void submit()}><SvgIcon name="sparkle" size={14} />{scope === "whole" ? t("修改整图", "Edit whole image", "Editar toda la imagen") : t("修改选区", "Edit selection", "Editar la selección")}</button>
      </div></>}
      {run.error && <p className="figure-hint tone-danger">{run.error}</p>}
      <div className="figure-raster-next">
        <button type="button" className="figure-button primary block" disabled={!image || disabled || !!result} onClick={() => void next()}><SvgIcon name="play" size={13} />{t("下一步", "Next", "Siguiente")}</button>
      </div>
    </aside>
  </div>;
}
