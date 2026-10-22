import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SvgIcon } from "../SvgIcon";
import ofdm from "../assets/figure-styles/ofdm-v3.webp";
import hmm from "../assets/figure-styles/hmm-v3.webp";
import multiome from "../assets/figure-styles/multiome-v3.webp";
import transformer from "../assets/figure-styles/transformer-v3.webp";
import researchAgents from "../assets/figure-styles/research_agents-v3.webp";
import mapk from "../assets/figure-styles/mapk-v3.webp";
import { DEFAULT_STYLE_SPEC, STYLE_FAMILIES, STYLE_LAYOUTS, STYLE_PALETTES, STYLE_DENSITIES,
  compileFigureStyle, parseFigureStyle, type FigureStyleSpec, type StyleFamily } from "./figureStyles";
import { FIGURE_SCENARIOS, type FigureScenario } from "./figureScenarios";
import type { Language } from "./figureModel";

type Copy = [cn: string, en: string];
const IMAGES: Record<StyleFamily, string> = { schematic: ofdm, theory: hmm, panels: multiome, tensors: transformer, narrative: researchAgents, illustration: mapk };
interface Props {
  language: Language;
  value: string;
  onChange: (value: string) => void;
  preserveSource?: boolean;
  hasDescription?: boolean;
  onUseScenario?: (scenario: FigureScenario) => void;
}

/** Visual representation stays independent from the scenario's scientific
 * content. Uploaded references are reconstructed instead of restyled. */
export default function FigureStylePicker({ language, value, onChange, preserveSource = false, hasDescription = false, onUseScenario }: Props) {
  const [comparing, setComparing] = useState(false);
  const pick = (copy: Copy) => copy[language === "cn" ? 0 : 1];
  const spec = parseFigureStyle(value);
  const selected = STYLE_FAMILIES.find((family) => family.key === spec?.family);
  const change = (patch: Partial<FigureStyleSpec>) => onChange(compileFigureStyle({ ...(spec ?? DEFAULT_STYLE_SPEC), ...patch }));
  const keyboardPick = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % STYLE_FAMILIES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + STYLE_FAMILIES.length - 1) % STYLE_FAMILIES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = STYLE_FAMILIES.length - 1;
    else return;
    event.preventDefault();
    change({ family: STYLE_FAMILIES[next].key });
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return <div className="figure-field">
    <span className="figure-field-head">{pick(["图形风格", "Visual style"])}
      <button type="button" className="figure-link" onClick={() => setComparing(true)}><SvgIcon name="image" size={12} />{pick(["学科示例", "Discipline examples"])}</button>
    </span>
    <div className="figure-styles" role="radiogroup" aria-label={pick(["风格", "Style"])}>
      {STYLE_FAMILIES.map((family, index) => {
        const scenario = FIGURE_SCENARIOS[family.key];
        return <button key={family.key} type="button" role="radio" aria-label={pick(family.label)} aria-checked={spec?.family === family.key}
          disabled={preserveSource} tabIndex={spec?.family === family.key || (!selected && index === 0) ? 0 : -1} className={spec?.family === family.key ? "selected" : ""}
          title={pick(scenario.discipline) + " · " + pick(scenario.title)} onClick={() => change({ family: family.key })} onKeyDown={(event) => keyboardPick(event, index)}>
          <img src={IMAGES[family.key]} alt="" width={1536} height={1024} />
          <span>{pick(family.label)}</span><small>{pick(scenario.discipline)} · {pick(scenario.title)}</small>
        </button>;
      })}
    </div>
    <p className="figure-style-note">{preserveSource ? pick(["已导入图片，将保留原图风格。移除参考图后可设置新生成图的风格。", "The imported image keeps its original appearance. Remove it to style a newly generated figure."])
      : selected ? pick(selected.use) : pick(["已保留自定义风格；选择一种图形风格后可调整以下选项。", "Your custom style is preserved; choose a visual family to adjust the options below."])}
      <small>{pick(["学科示例展示适用场景，可放大查看。选择风格保留描述；载入场景才填入示例需求。", "Explore domain examples in detail. Selecting a style keeps your description; loading a scenario inserts its requirements."])}</small>
    </p>
    <fieldset className="figure-style-options" disabled={preserveSource || !spec}>
      <legend className="figure-sr-only">{pick(["风格细节", "Style details"])}</legend>
      <label><span>{pick(["布局", "Layout"])}</span><select aria-label={pick(["布局", "Layout"])} value={spec?.layout ?? "auto"} onChange={(event) => change({ layout: event.target.value as FigureStyleSpec["layout"] })}>
        {STYLE_LAYOUTS.map((item) => <option key={item.key} value={item.key}>{pick(item.label)}</option>)}
      </select></label>
      <label><span>{pick(["配色", "Palette"])}</span><select aria-label={pick(["配色", "Palette"])} value={spec?.palette ?? "muted"} onChange={(event) => change({ palette: event.target.value as FigureStyleSpec["palette"] })}>
        {STYLE_PALETTES.map((item) => <option key={item.key} value={item.key}>{pick(item.label)}</option>)}
      </select></label>
      <label><span>{pick(["间距", "Spacing"])}</span><select aria-label={pick(["间距", "Spacing"])} value={spec?.density ?? "balanced"} onChange={(event) => change({ density: event.target.value as FigureStyleSpec["density"] })}>
        {STYLE_DENSITIES.map((item) => <option key={item.key} value={item.key}>{pick(item.label)}</option>)}
      </select></label>
      <label className="figure-style-print"><input type="checkbox" checked={spec?.print ?? false} onChange={(event) => change({ print: event.target.checked })} />
        <span>{pick(["印刷适配", "Print ready"])}<small>{pick(["增强线条，灰度可辨", "Stronger lines, clear in grayscale"])}</small></span>
      </label>
    </fieldset>
    {comparing && <StyleComparison language={language} selected={spec?.family} preserveSource={preserveSource} hasDescription={hasDescription}
      onChoose={(family) => { change({ family }); setComparing(false); }}
      onUseScenario={onUseScenario ? (scenario) => { onUseScenario(scenario); setComparing(false); } : undefined}
      onClose={() => setComparing(false)} />}
  </div>;
}

function StyleComparison({ language, selected, preserveSource, hasDescription, onChoose, onUseScenario, onClose }: {
  language: Language; selected?: StyleFamily; preserveSource: boolean; hasDescription: boolean;
  onChoose: (family: StyleFamily) => void; onUseScenario?: (scenario: FigureScenario) => void; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const previewOrigin = useRef<StyleFamily | null>(null);
  const [detail, setDetail] = useState<StyleFamily | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const pick = (copy: Copy) => copy[language === "cn" ? 0 : 1];
  const activeScenario = detail ? FIGURE_SCENARIOS[detail] : null;
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); opener?.focus(); };
  }, []);
  useEffect(() => {
    setActualSize(false);
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
    if (detail) backRef.current?.focus();
    else if (previewOrigin.current) dialogRef.current?.querySelector<HTMLButtonElement>('[data-scene-preview="' + previewOrigin.current + '"]')?.focus();
  }, [detail]);
  const actions = (family: StyleFamily) => <div className="figure-scenario-actions">
    <button type="button" className="figure-button" disabled={preserveSource} onClick={() => onChoose(family)}>{pick(["使用此风格", "Use this style"])}{selected === family && <SvgIcon name="check" size={12} />}</button>
    {onUseScenario && <button type="button" className="figure-button" disabled={preserveSource} onClick={() => onUseScenario(FIGURE_SCENARIOS[family])}>
      {hasDescription ? pick(["替换描述并载入场景", "Replace description with scenario"]) : pick(["载入场景示例", "Load scenario"])}
    </button>}
  </div>;

  return <dialog ref={dialogRef} className="figure-style-dialog" aria-labelledby="figure-style-comparison-title" aria-describedby="figure-style-comparison-description"
    onCancel={(event) => { event.preventDefault(); if (detail) setDetail(null); else onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><h2 id="figure-style-comparison-title">{activeScenario ? pick(activeScenario.title) : pick(["学科场景示例", "Discipline scenarios"])}</h2>
      <p id="figure-style-comparison-description">{activeScenario ? pick(activeScenario.discipline) + " · " + pick(activeScenario.features)
        : pick(["用各学科的复杂场景理解图形表达：点开图片查看模块、分支、反馈与注释。风格可跨学科使用，示例不包含实验结果。", "Explore visual languages through complex domain scenarios. Open an image to inspect modules, branches, feedback and annotations. Styles work across disciplines; examples contain no experimental results."])}</p>
      {preserveSource && <p>{pick(["当前导入图片按原样重建，移除参考图后可选用风格或载入场景。", "The imported image is rebuilt as shown. Remove it to choose a style or load a scenario."])}</p>}</div>
      <button type="button" className="figure-icon-button" aria-label={pick(["关闭风格对比", "Close style comparison"])} onClick={onClose}><SvgIcon name="close" size={16} /></button>
    </header>
    {detail && activeScenario ? <div className="figure-scenario-detail">
      <div className="figure-scenario-toolbar"><button ref={backRef} type="button" className="figure-button" onClick={() => setDetail(null)}>{pick(["返回学科示例", "Back to scenarios"])}</button>
        <button type="button" className="figure-button" aria-pressed={actualSize} onClick={() => setActualSize((previous) => !previous)}>{actualSize ? pick(["适应窗口", "Fit to window"]) : pick(["原始尺寸", "Original size"])}</button>
        {actualSize && <small>{pick(["滚动查看图中细节", "Scroll to inspect details"])}</small>}
      </div>
      <div className={`figure-scenario-image${actualSize ? " actual-size" : ""}`} tabIndex={actualSize ? 0 : undefined} aria-label={actualSize ? pick(["可滚动的场景原图", "Scrollable original scenario"]) : undefined}>
        <img src={IMAGES[detail]} width={1536} height={1024} alt={pick(activeScenario.title)} />
      </div>
      <div className="figure-scenario-detail-copy">{actions(detail)}
        <details><summary>{pick(["查看场景绘图需求", "View scenario requirements"])}</summary><p>{pick(activeScenario.description)}</p></details>
        {activeScenario.sources.length > 0 && <p className="figure-scenario-sources">{pick(["参考依据：", "References: "])}{activeScenario.sources.map((source, index) => <span key={source.url}>{index > 0 && " · "}<a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></span>)}</p>}
      </div>
    </div> : <div className="figure-style-comparison">
      {STYLE_FAMILIES.map((family) => {
        const scenario = FIGURE_SCENARIOS[family.key];
        return <article key={family.key} className={selected === family.key ? "selected" : ""}>
          <button type="button" className="figure-scenario-preview" data-scene-preview={family.key} aria-label={pick(["查看" + scenario.title[0] + "细节", "View " + scenario.title[1] + " details"])}
            onClick={() => { previewOrigin.current = family.key; setDetail(family.key); }}>
            <img src={IMAGES[family.key]} width={1536} height={1024} alt={pick(scenario.title)} />
            <span>{pick(["查看细节", "View details"])}</span>
          </button>
          <div><span className="figure-scenario-discipline">{pick(scenario.discipline)}</span><h3>{pick(scenario.title)}</h3>
            <span className="figure-style-traits">{pick(family.label)} · {pick(scenario.features)}</span>
            {actions(family.key)}
          </div>
        </article>;
      })}
    </div>}
  </dialog>;
}
