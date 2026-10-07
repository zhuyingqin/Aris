import { useState, type DragEvent, type ReactNode } from "react";
import { SvgIcon } from "../SvgIcon";
import { STYLE_PRESETS, callEstimate } from "./figureModel";
import type { FigureConnections } from "./types";

/** One description, a style preset, an optional reference image and three
 * model choices. No uploaded image means SomniImage generates the reference. */
export interface FigureDraft {
  description: string; style: string;
  image: { base64: string; url: string; name: string } | null;
  executorModel: string | null; reviewerModel: string | null; imageModel: string | null;
}
export interface FigureModelOptions { executor: string[]; reviewer: string[]; image: string[] }

export const EMPTY_DRAFT: FigureDraft = { description: "", style: STYLE_PRESETS[0].value, image: null, executorModel: null, reviewerModel: null, imageModel: null };
const MAX_DESCRIPTION = 40000;
/** Starting points shown only while the description is empty. */
const EXAMPLES: { label: [string, string]; text: [string, string] }[] = [
  { label: ["神经网络架构", "Network architecture"], text: [
    "Transformer 编码器结构图\n自下而上：输入嵌入 + 位置编码 → N× 编码层（多头自注意力 → Add & Norm → 前馈网络 → Add & Norm）→ 输出表示。每个子层画出残差连接，N× 用虚线框标出。",
    "Transformer encoder architecture\nBottom to top: input embedding + positional encoding → N× encoder layer (multi-head self-attention → Add & Norm → feed-forward → Add & Norm) → output representation. Draw the residual connection of each sub-layer and mark N× with a dashed box."] },
  { label: ["训练流程", "Training pipeline"], text: [
    "模型训练流程图\n从左到右：数据集 → 预处理与增强 → 模型 → 损失计算 → 优化器更新；损失到模型画反向传播的虚线箭头。下方标注验证集评估与早停。",
    "Model training pipeline\nLeft to right: dataset → preprocessing and augmentation → model → loss → optimizer update; a dashed back-propagation arrow from loss to model. Validation evaluation and early stopping underneath."] },
  { label: ["方法对比", "Method comparison"], text: [
    "方法对比示意图\n左右两栏：左为基线方法（单阶段直接预测），右为本文方法（检索 → 推理 → 校验三阶段）。共享模块用相同颜色，新增模块用强调色。",
    "Method comparison\nTwo columns: the baseline on the left (single-stage direct prediction), ours on the right (retrieve → reason → verify). Shared modules use the same color; new modules use an accent color."] },
  { label: ["系统工作流", "System workflow"], text: [
    "多智能体研究系统工作流\n规划者把子任务分给执行者；执行者生成代码并运行实验，结果交给独立审查者；审查者把反馈送回执行者，并向规划者发起复核请求。执行者通过环境（工具、数据集、API）访问数据。",
    "Multi-agent research workflow\nThe Planner sends sub-tasks to the Executor; the Executor writes code and runs experiments, passing results to an independent Reviewer; the Reviewer sends feedback to the Executor and review requests to the Planner. The Executor reaches data through the Environment (tools, datasets, APIs)."] },
];

/** The model each role will use: the user's pick, else the resolved default. */
export function effectiveModels(draft: FigureDraft, connections: FigureConnections | null) {
  return {
    executor: draft.executorModel ?? connections?.executor.model ?? "",
    reviewer: draft.reviewerModel ?? connections?.reviewer.model ?? "",
    image: draft.imageModel ?? connections?.image.model ?? "",
  };
}

/** Miniature of each preset so the choice is visual, not a style prompt. */
function StyleThumb({ preset }: { preset: string }) {
  const art: Record<string, ReactNode> = {
    academic: <><rect x="6" y="8" width="22" height="12" rx="2" fill="#dbeafe" stroke="#3b82f6" /><rect x="52" y="8" width="22" height="12" rx="2" fill="#dcfce7" stroke="#22c55e" /><rect x="29" y="30" width="22" height="12" rx="2" fill="#ffedd5" stroke="#f97316" /><path d="M28 14h24M17 20l14 10M63 20 49 30" stroke="#475569" fill="none" /></>,
    minimal: <><rect x="6" y="8" width="22" height="12" rx="1" fill="none" stroke="#334155" /><rect x="52" y="8" width="22" height="12" rx="1" fill="none" stroke="#334155" /><rect x="29" y="30" width="22" height="12" rx="1" fill="none" stroke="#334155" /><path d="M28 14h24M17 20l14 10M63 20 49 30" stroke="#94a3b8" fill="none" /></>,
    soft: <><rect x="3" y="4" width="74" height="20" rx="7" fill="#f3e8ff" /><rect x="8" y="9" width="20" height="10" rx="5" fill="#e9d5ff" /><rect x="52" y="9" width="20" height="10" rx="5" fill="#fbcfe8" /><rect x="27" y="30" width="26" height="13" rx="6" fill="#ccfbf1" /><path d="M40 24v6" stroke="#a78bfa" fill="none" /></>,
    print: <><rect x="6" y="8" width="22" height="12" fill="#fff" stroke="#000" strokeWidth="2" /><rect x="52" y="8" width="22" height="12" fill="#000" /><rect x="29" y="30" width="22" height="12" fill="#fff" stroke="#0072b2" strokeWidth="2" /><path d="M28 14h24M17 20l14 10M63 20 49 30" stroke="#000" strokeWidth="1.6" fill="none" /></>,
  };
  return <svg viewBox="0 0 80 48" aria-hidden>{art[preset]}</svg>;
}

interface Props {
  t: (cn: string, en: string) => string; language: "cn" | "en";
  draft: FigureDraft; onDraft: (patch: Partial<FigureDraft>) => void;
  connections: FigureConnections | null; options: FigureModelOptions;
  busy: boolean; canSubmit: boolean;
  onUpload: (file?: File) => void; onSubmit: () => void; onOpenSettings: () => void;
}

/** New figure: describe and configure on the left; the canvas area previews
 * the reference image or shows where the editable SVG will open. */
export default function FigureComposer({ t, language, draft, onDraft, connections, options, busy, canSubmit, onUpload, onSubmit, onOpenSettings }: Props) {
  const [dragging, setDragging] = useState(false);
  const generate = !draft.image;
  const estimate = callEstimate(generate ? "generate" : "import");
  const models = effectiveModels(draft, connections);
  const pick = (copy: [string, string]) => copy[language === "cn" ? 0 : 1];
  // Executor and Reviewer must differ; moving the Executor onto the current
  // Reviewer hands the review to the next available model.
  const chooseExecutor = (model: string) => {
    const patch: Partial<FigureDraft> = { executorModel: model };
    if (model === models.reviewer) patch.reviewerModel = options.reviewer.find((candidate) => candidate !== model) ?? null;
    onDraft(patch);
  };
  const withCurrent = (list: string[], current: string) => current && !list.includes(current) ? [current, ...list] : list;
  const imageUnavailable = generate && !!connections && !connections.image.available;
  const dropHandlers = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => { if (!e.dataTransfer.files?.length) return; e.preventDefault(); setDragging(false); onUpload(e.dataTransfer.files[0]); },
  };

  return <div className="figure-new">
    <aside className="figure-spec" aria-label={t("图形规格", "Figure specification")}>
      <div className="figure-spec-scroll">
        <section className="figure-panel">
          <h2><b>1</b>{t("描述图形", "Describe the figure")}</h2>
          <div className={`figure-describe${dragging ? " dragging" : ""}`} {...dropHandlers}>
            <textarea aria-label={t("图形描述", "Figure description")} value={draft.description} onChange={(e) => onDraft({ description: e.target.value })} maxLength={MAX_DESCRIPTION} rows={8}
              placeholder={t("你想画什么？写清模块、标签、关系和箭头方向，标题会自动简化。数据图请提供真实数据。", "What do you want to create? Name modules, labels, relations and arrow directions. A concise title is created automatically. Use real data for plots.")} />
            <div className="figure-describe-bar">
              <label className="figure-attach" title={t("PNG / JPEG / WebP，≤ 10 MB", "PNG / JPEG / WebP, ≤ 10 MB")}>
                <SvgIcon name="attachment" size={13} />{draft.image ? t("替换参考图", "Replace image") : t("添加参考图", "Add reference image")}
                <input type="file" aria-label={t("上传参考图", "Upload reference image")} accept="image/png,image/jpeg,image/webp" onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <span className="figure-count">{draft.description.length.toLocaleString("en-US")} / {MAX_DESCRIPTION.toLocaleString("en-US")}</span>
            </div>
          </div>
          {draft.image ? <div className="figure-attached">
            <img src={draft.image.url} alt="" />
            <span><strong>{draft.image.name}</strong><small>{t("将按此图重建，不再生图", "Rebuilt from this image; nothing is generated")}</small></span>
            <button type="button" className="figure-icon-button" aria-label={t("移除参考图", "Remove reference image")} title={t("移除，改为生成", "Remove and generate instead")} onClick={() => onDraft({ image: null })}><SvgIcon name="close" size={12} /></button>
          </div> : <p className={`figure-hint${imageUnavailable ? " tone-danger" : ""}`}>{imageUnavailable
            ? t("SomniImage 不可用：请添加参考图，或在模型设置中登录并开启 SomniImage。", "SomniImage is unavailable: add a reference image, or sign in and enable SomniImage in Model settings.")
            : t("Executor 整理需求后生成 PNG，确认图片后再重建为可编辑 SVG。", "The Executor plans the PNG from your requirements; confirm the image before rebuilding it as editable SVG.")}</p>}
          {!draft.description && <div className="figure-examples">
            <span>{t("快速示例", "Quick examples")}</span>
            <div>{EXAMPLES.map((example) => <button key={example.label[1]} type="button" onClick={() => onDraft({ description: pick(example.text) })}>{pick(example.label)}</button>)}</div>
          </div>}
        </section>

        <section className="figure-panel">
          <h2><b>2</b>{t("设置", "Settings")}</h2>
          <div className="figure-field">
            <span className="figure-field-head">{t("风格预设", "Style preset")}</span>
            <div className="figure-styles" role="radiogroup" aria-label={t("风格", "Style")}>
              {STYLE_PRESETS.map((preset) => <button key={preset.key} type="button" role="radio" aria-checked={draft.style === preset.value} className={draft.style === preset.value ? "selected" : ""} onClick={() => onDraft({ style: preset.value })}>
                <StyleThumb preset={preset.key} /><span>{pick(preset.label)}</span>
              </button>)}
            </div>
          </div>
          <div className="figure-field">
            <span className="figure-field-head">{t("模型", "Models")}<button type="button" className="figure-link" onClick={onOpenSettings}><SvgIcon name="settings" size={12} />{t("模型设置", "Model settings")}</button></span>
            <div className="figure-models">
              <label className="figure-model">
                <span className="figure-role-tag">Executor · {t("重建 SVG", "Rebuilds SVG")}</span>
                <select aria-label={t("Executor 模型", "Executor model")} value={models.executor} onChange={(e) => chooseExecutor(e.target.value)}>
                  {withCurrent(options.executor, models.executor).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <label className="figure-model reviewer">
                <span className="figure-role-tag"><SvgIcon name="shieldCheck" size={11} />Reviewer · {t("独立审查", "Independent")}</span>
                <select aria-label={t("Reviewer 模型", "Reviewer model")} value={models.reviewer} onChange={(e) => onDraft({ reviewerModel: e.target.value })}>
                  {withCurrent(options.reviewer, models.reviewer).filter((model) => model !== models.executor || model === models.reviewer).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <label className={`figure-model image${generate ? "" : " inactive"}`}>
                <span className="figure-role-tag"><SvgIcon name="sparkle" size={11} />{t("生图模型", "Image model")}{!generate && <small>{t("已有参考图，不调用", "unused with a reference image")}</small>}</span>
                <select aria-label={t("生图模型", "Image model")} value={models.image} disabled={!generate || options.image.length === 0} onChange={(e) => onDraft({ imageModel: e.target.value })}>
                  {options.image.length === 0 && <option value="">{t("未配置", "Not configured")}</option>}
                  {withCurrent(options.image, models.image).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
            </div>
          </div>
        </section>
      </div>
      <footer className="figure-spec-cta">
        <button type="button" className="figure-button primary block" disabled={!canSubmit} onClick={onSubmit}>
          <SvgIcon name={generate ? "sparkle" : "play"} size={14} />{busy ? t("正在启动…", "Starting…") : generate ? t("生成图形", "Generate figure") : t("预览参考图", "Preview reference")}
        </button>
        <small>{t("先预览和圈选修改 PNG，确认后再重建 SVG。", "Preview and edit the PNG, then confirm to build SVG.")}</small>
        {generate && <small>{t("先由 Executor 理解需求并整理提示词，再调用生图模型。", "Executor plans the prompt before the image model generates the PNG.")}</small>}
        <small>{t(`预计 ${estimate.usual} 次调用 · 最多 ${estimate.max} 次；首次使用另计最多 2 次视觉探针`, `About ${estimate.usual} calls · up to ${estimate.max}; first use adds up to 2 vision probes`)}</small>
      </footer>
    </aside>

    <div className={`figure-preview${dragging ? " dragging" : ""}`} {...dropHandlers}>
      {draft.image ? <figure className="figure-preview-image">
        <img src={draft.image.url} alt={t("参考图预览", "Reference preview")} />
        <figcaption><SvgIcon name="image" size={12} />{t("参考图 · 将重建为可编辑 SVG", "Reference · will be rebuilt as editable SVG")}</figcaption>
      </figure> : <div className="figure-preview-empty">
        <svg viewBox="0 0 120 80" aria-hidden><rect x="8" y="10" width="34" height="20" rx="4" /><rect x="78" y="10" width="34" height="20" rx="4" /><rect x="43" y="50" width="34" height="20" rx="4" /><path d="M42 20h36M25 30l22 20M95 30 73 50" /></svg>
        <strong>{t("先生成 PNG，满意后再重建 SVG", "Generate a PNG, then confirm to build SVG")}</strong>
        <p>{t("可以直接改字、移动、分组，保存为新版本后再交给独立 Reviewer 审查。", "Edit text, move and group elements, then save a version for the independent Reviewer.")}</p>
        <ol>{[t("生成参考图", "Generate reference"), t("预览与圈选修改", "Preview and edit"), t("重建 SVG", "Rebuild SVG"), t("独立审查", "Independent review")].map((step, index) => <li key={step}><b>{index + 1}</b>{step}</li>)}</ol>
        <small>{t("也可以把已有图片拖到这里，直接重建。", "Or drop an existing image here to rebuild it directly.")}</small>
      </div>}
    </div>
  </div>;
}
