import { useRef, useState } from "react";
import { useAppearance, SURFACES, UI_FONTS, type Appearance } from "../appearance";
import { applyAppearancePreset, exportAppearancePreset, parseAppearancePreset, resetAppearance } from "../appearanceTransfer";
import { prepareWallpaper, readWallpaperAsset, writeWallpaperAsset } from "../chatWallpaper";
import { useEditorSettings } from "../editor/useEditorSettings";
import { EDITOR_FONT_FAMILIES, EDITOR_FONT_SIZES, EDITOR_LINE_HEIGHTS, setEditorSettings } from "../editor/editorSettings";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import { PreferenceFeedback, SettingsChoice, SettingsFeedback, SettingsSection, SettingRow } from "./SettingsPrimitives";
import type { PreferenceSave } from "./usePreferenceSave";

export const APPEARANCE_COPY = {
  cn: {
    surface: "背景风格", font: "界面字体", customAccent: "自定义主题色", chat: "聊天背景", wallpaper: "背景图片",
    upload: "导入图片", remove: "移除图片", opacity: "图片透明度", fit: "显示方式", local: "仅保存在本机。PNG / JPEG / WebP，≤12 MB。",
    preview: "实时预览", question: "帮我整理这次研究的发现。", answer: "研究概览", sample: "可以。先整理关键发现、支持证据，以及下一步需要验证的问题。",
    previewHint: "选择后即时应用于聊天窗口。", message: "给 SomniQ 发消息…",
    imageMissing: "背景图片无法读取，请重新导入。",
    advanced: "高级外观", bodyMode: "正文字号", bodySize: "聊天正文字号", lineHeight: "正文行距", readingWidth: "阅读宽度", density: "界面密度",
    corners: "圆角", shadows: "阴影", reducedMotion: "减少动画", editorFont: "编辑器字体", editorSize: "编辑器字号", editorHeight: "编辑器行距",
    editorScope: "与代码和排版编辑器共用设置。", themeFiles: "外观方案", export: "导出主题", import: "导入主题", reset: "恢复默认",
    transferNote: "不包含本地背景图片。", imageError: "图片导入失败", themeError: "无法导入主题文件",
    values: { default: "默认", warm: "暖白 / 暖灰", cool: "冷白 / 蓝灰", neutral: "中性灰", contrast: "纯白 / 纯黑", system: "系统字体", serif: "衬线字体",
      none: "无", mountains: "远山", orbit: "星轨", grid: "方格", custom: "本地图片", cover: "铺满", contain: "完整显示", tile: "平铺",
      auto: "跟随界面", manual: "自定义", compact: "紧凑", standard: "标准", relaxed: "宽松", narrow: "窄", wide: "宽", comfortable: "宽松",
      square: "小圆角", round: "大圆角", soft: "柔和", mono: "等宽", sans: "无衬线", normal: "标准" } as Record<string, string>,
  },
  en: {
    surface: "Background palette", font: "Interface font", customAccent: "Custom accent", chat: "Chat background", wallpaper: "Background image",
    upload: "Import image", remove: "Remove image", opacity: "Image opacity", fit: "Image layout", local: "Local only. PNG / JPEG / WebP, up to 12 MB.",
    preview: "Live preview", question: "Help me organize the research findings.", answer: "Research overview", sample: "Let's group the key findings, supporting evidence, and questions to explore next.",
    previewHint: "Changes apply instantly to your chats.", message: "Message SomniQ…",
    imageMissing: "The background image could not be loaded. Import it again.",
    advanced: "Advanced appearance", bodyMode: "Body text size", bodySize: "Chat body text size", lineHeight: "Body line spacing", readingWidth: "Reading width", density: "Interface density",
    corners: "Corners", shadows: "Shadows", reducedMotion: "Reduce motion", editorFont: "Editor font", editorSize: "Editor text size", editorHeight: "Editor line spacing",
    editorScope: "Shared with code and typesetting editors.", themeFiles: "Appearance presets", export: "Export theme", import: "Import theme", reset: "Restore defaults",
    transferNote: "Local background images are excluded.", imageError: "Could not import image", themeError: "Could not import theme",
    values: { default: "Default", warm: "Warm", cool: "Cool", neutral: "Neutral", contrast: "White / Black", system: "System font", serif: "Serif",
      none: "None", mountains: "Mountains", orbit: "Orbit", grid: "Grid", custom: "Local image", cover: "Fill", contain: "Fit", tile: "Tile",
      auto: "Follow interface", manual: "Custom", compact: "Compact", standard: "Standard", relaxed: "Relaxed", narrow: "Narrow", wide: "Wide", comfortable: "Comfortable",
      square: "Small radius", round: "Large radius", soft: "Soft", mono: "Monospace", sans: "Sans serif", normal: "Standard" } as Record<string, string>,
  },
};

export default function AppearanceSettings({ language, preferences, section }: {
  language: Language; preferences: PreferenceSave; section: "basic" | "chat" | "advanced";
}) {
  const value = useAppearance((s) => s.value);
  const patch = useAppearance((s) => s.patch);
  const wallpaperError = useAppearance((s) => s.wallpaperError);
  const editor = useEditorSettings();
  const file = useRef<HTMLInputElement>(null);
  const themeFile = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const copy = APPEARANCE_COPY[language];
  const chatSaveStates = ["wallpaper", "image", "wallpaperOpacity", "wallpaperFit"]
    .map((key) => preferences.feedback[`appearance-${key}`]?.state);
  const chatSaved = chatSaveStates.includes("saved") && !chatSaveStates.some((state) => state === "saving" || state === "error");
  const feedback = (key: string) => section === "chat" && preferences.feedback[`appearance-${key}`]?.state === "saved" ? null
    : <PreferenceFeedback preferences={preferences} preference={`appearance-${key}`} language={language} />;
  const save = (key: string, operation: () => void | Promise<void>) => void preferences.save(`appearance-${key}`, operation);
  const update = (key: keyof Appearance, next: unknown) => save(key, () => patch({ [key]: next }));
  const select = (key: keyof Appearance, title: string, options: readonly string[]) => <SettingRow title={title} feedback={feedback(key)}>
    <div className="appearance-controls"><select aria-label={title} value={String(value[key])} onChange={(e) => update(key, e.currentTarget.value)}>
      {options.map((option) => <option key={option} value={option}>{copy.values[option]}</option>)}
    </select></div>
  </SettingRow>;
  const range = (key: "wallpaperOpacity" | "bodySize", title: string, min: number, max: number, suffix: string) => <SettingRow title={title} feedback={feedback(key)}>
    <div className="appearance-controls"><input type="range" aria-label={title} min={min} max={max} value={value[key]}
      onChange={(e) => update(key, Number(e.currentTarget.value))} /><output>{value[key]}{suffix}</output></div>
  </SettingRow>;

  const changeImage = async (asset: Awaited<ReturnType<typeof prepareWallpaper>> | undefined) => {
    const previous = await readWallpaperAsset();
    await writeWallpaperAsset(asset);
    try {
      const current = useAppearance.getState().value;
      patch({ wallpaper: asset ? "custom" : current.wallpaper === "custom" ? "none" : current.wallpaper,
        wallpaperName: asset?.name ?? "", wallpaperRevision: crypto.randomUUID() });
    } catch (error) { await writeWallpaperAsset(previous); throw error; }
  };

  if (section === "basic") return <>
    {value.customAccent && <SettingRow title={copy.customAccent} feedback={feedback("customAccent")}>
      <div className="appearance-controls"><input aria-label={copy.customAccent} type="color" value={value.customAccent}
        onChange={(e) => update("customAccent", e.currentTarget.value)} /><output>{value.customAccent.toUpperCase()}</output></div>
    </SettingRow>}
    {select("surface", copy.surface, SURFACES)}
    {select("font", copy.font, UI_FONTS)}
  </>;

  if (section === "chat") return <SettingsSection title={copy.chat}>
    <div className="appearance-chat-body"><div className="appearance-chat-layout">
      <div className="appearance-chat-controls">
        <div className="appearance-wallpaper-picker">
          <div className="appearance-field-heading">
            <div className="appearance-field-title">{copy.wallpaper}</div>
            {chatSaved && <SettingsFeedback state="saved" message={GENERAL_PAGE_COPY[language].preferenceSaved} />}
          </div>
          <SettingsChoice label={copy.wallpaper} value={value.wallpaper} disabled={imageBusy} variant="preview"
            options={["none", "mountains", "orbit", "grid", ...(value.wallpaperName ? ["custom"] : [])].map((option) => ({
              value: option, label: copy.values[option], icon: <span className="appearance-wallpaper-thumb" data-wallpaper={option} aria-hidden="true"
                style={option === "custom" && value.wallpaper === "custom" ? { backgroundImage: "var(--chat-wallpaper, none)" } : undefined}>
                {option === "none" && <SvgIcon name="minus" size={18} />}
                {option === "custom" && (value.wallpaper !== "custom" || wallpaperError) && <SvgIcon name="image" size={18} />}
                <span className="appearance-wallpaper-check"><SvgIcon name="check" size={11} /></span>
              </span>,
            }))} onChange={(next) => update("wallpaper", next)} />
          {feedback("wallpaper")}
        </div>
        <div className="appearance-image-import">
          <div className="appearance-image-actions">
            <input ref={file} type="file" hidden aria-label={copy.upload} accept="image/png,image/jpeg,image/webp" onChange={(event) => {
              const selected = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (!selected) return;
              setImageBusy(true);
              save("image", async () => {
                try { await changeImage(await prepareWallpaper(selected)); }
                catch (error) { throw new Error(`${copy.imageError}: ${error instanceof Error ? error.message : String(error)}`); }
                finally { setImageBusy(false); }
              });
            }} />
            <button type="button" className="sp-btn sp-btn-secondary" disabled={imageBusy} onClick={() => file.current?.click()}>
              <SvgIcon name={imageBusy ? "spinner" : "upload"} size={14} />{copy.upload}
            </button>
            {value.wallpaperName && <><span className="appearance-file-name" title={value.wallpaperName}>{value.wallpaperName}</span>
              <button type="button" className="sp-btn sp-btn-secondary appearance-image-remove" aria-label={copy.remove} title={copy.remove} disabled={imageBusy} onClick={() => {
                setImageBusy(true); save("image", async () => { try { await changeImage(undefined); } finally { setImageBusy(false); } });
              }}><SvgIcon name="trash" size={14} /></button></>}
          </div>
          <p className="appearance-image-hint">{copy.local}</p>
          {feedback("image")}
        </div>
        {value.wallpaper !== "none" && <div className="appearance-wallpaper-options">
          {range("wallpaperOpacity", copy.opacity, 0, 40, "%")}
          {select("wallpaperFit", copy.fit, ["cover", "contain", "tile"])}
        </div>}
        {value.wallpaper === "custom" && wallpaperError && <SettingsFeedback state="error" message={copy.imageMissing} />}
      </div>
      <div className="appearance-preview-wrap">
        <div className="appearance-preview-label"><span>{copy.preview}</span><span className="appearance-preview-background">{copy.values[value.wallpaper]}</span></div>
        <div className="appearance-preview" role="group" aria-label={copy.preview}>
          <div className="appearance-preview-header"><SvgIcon name="messageCircle" size={14} /><span>{copy.answer}</span></div>
          <div className="appearance-preview-messages">
            <div className="appearance-preview-user">{copy.question}</div>
            <div className="appearance-preview-assistant">
              <span className="appearance-preview-avatar" aria-hidden="true"><SvgIcon name="sparkle" size={14} /></span>
              <div className="appearance-preview-answer"><strong>SomniQ</strong><p>{copy.sample}</p></div>
            </div>
          </div>
          <div className="appearance-preview-composer" aria-hidden="true">
            <SvgIcon name="plus" size={15} /><span>{copy.message}</span><span className="appearance-preview-send"><SvgIcon name="send" size={12} /></span>
          </div>
        </div>
        <p className="appearance-preview-hint">{copy.previewHint}</p>
      </div>
    </div></div>
  </SettingsSection>;

  return <div className="appearance-advanced-section"><SettingsSection title={copy.advanced}>
    <SettingRow title={copy.bodyMode} feedback={feedback("bodySize")}>
      <div className="appearance-controls"><select aria-label={copy.bodyMode} value={value.bodySize ? "manual" : "auto"}
        onChange={(e) => update("bodySize", e.currentTarget.value === "auto" ? 0 : 16)}>
        <option value="auto">{copy.values.auto}</option><option value="manual">{copy.values.manual}</option>
      </select></div>
    </SettingRow>
    {!!value.bodySize && range("bodySize", copy.bodySize, 12, 26, " px")}
    {select("lineHeight", copy.lineHeight, ["compact", "standard", "relaxed"])}
    {select("readingWidth", copy.readingWidth, ["narrow", "standard", "wide"])}
    {select("density", copy.density, ["compact", "standard", "comfortable"])}
    {select("corners", copy.corners, ["default", "square", "round"])}
    {select("shadows", copy.shadows, ["default", "none", "soft"])}
    <SettingRow title={copy.reducedMotion} feedback={feedback("reducedMotion")}>
      <button type="button" role="switch" aria-label={copy.reducedMotion} className="settings-switch" aria-checked={value.reducedMotion}
        onClick={() => update("reducedMotion", !value.reducedMotion)}><span /></button>
    </SettingRow>
    <SettingRow title={copy.editorFont} description={copy.editorScope} feedback={feedback("editorFont")}>
      <div className="appearance-controls"><select aria-label={copy.editorFont} value={editor.fontFamily}
        onChange={(e) => { const fontFamily = e.currentTarget.value as typeof editor.fontFamily;
          save("editorFont", () => { setEditorSettings({ fontFamily }, { requirePersistence: true }); }); }}>
        {EDITOR_FONT_FAMILIES.map((option) => <option key={option} value={option}>{copy.values[option]}</option>)}
      </select></div>
    </SettingRow>
    <SettingRow title={copy.editorSize} feedback={feedback("editorSize")}>
      <div className="appearance-controls"><select aria-label={copy.editorSize} value={editor.fontSize}
        onChange={(e) => { const fontSize = Number(e.currentTarget.value);
          save("editorSize", () => { setEditorSettings({ fontSize }, { requirePersistence: true }); }); }}>
        {EDITOR_FONT_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
      </select></div>
    </SettingRow>
    <SettingRow title={copy.editorHeight} feedback={feedback("editorHeight")}>
      <div className="appearance-controls"><select aria-label={copy.editorHeight} value={editor.lineHeight}
        onChange={(e) => { const lineHeight = e.currentTarget.value as typeof editor.lineHeight;
          save("editorHeight", () => { setEditorSettings({ lineHeight }, { requirePersistence: true }); }); }}>
        {EDITOR_LINE_HEIGHTS.map((option) => <option key={option} value={option}>{copy.values[option]}</option>)}
      </select></div>
    </SettingRow>
    <SettingRow title={copy.themeFiles} feedback={feedback("transfer")}>
      <div className="appearance-transfer">
        <button className="sp-btn sp-btn-secondary" onClick={() => {
          const url = URL.createObjectURL(new Blob([exportAppearancePreset()], { type: "application/json" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "somniq-theme.json"; anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 3000);
        }}>{copy.export}</button>
        <button className="sp-btn sp-btn-secondary" onClick={() => themeFile.current?.click()}>{copy.import}</button>
        <button className="sp-btn sp-btn-secondary" onClick={() => save("transfer", resetAppearance)}>{copy.reset}</button>
        <input ref={themeFile} type="file" hidden aria-label={copy.import} accept=".json,application/json" onChange={(e) => {
          const selected = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!selected) return;
          save("transfer", async () => {
            try { if (selected.size > 100_000) throw new Error("Theme file is too large."); applyAppearancePreset(parseAppearancePreset(await selected.text())); }
            catch (error) { throw new Error(`${copy.themeError}: ${error instanceof Error ? error.message : String(error)}`); }
          });
        }} /><span className="appearance-transfer-note">{copy.transferNote}</span>
      </div>
    </SettingRow>
  </SettingsSection></div>;
}
