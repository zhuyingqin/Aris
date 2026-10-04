import { useEffect, useState } from "react";
import { isTauri, somniImageSettings, somniImageSettingsSet, type SomniImageSettingsView } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { isImageGenerationModel } from "../imageModels";
import type { Language } from "../store";
import { SettingRow, SettingsFeedback, SettingsSection } from "./SettingsPrimitives";

const COPY = {
  cn: { title: "Somni 绘图", description: "对话模型会整理你的要求，构建完整提示词后调用绘图服务。图片和生成记录保存在当前项目。",
    enabled: "通过 Somni 账号绘图", quota: "使用当前账号的模型服务与额度。", model: "绘图模型",
    empty: "登录后点击上方“同步模型”，获取可用的绘图模型。", ready: "已就绪，在对话中描述你想画的图片即可。",
    unavailable: "绘图尚未就绪，请登录并同步模型。", saving: "保存中…", saved: "已保存", preview: "浏览器预览不调用绘图服务。" },
  en: { title: "Somni drawing", description: "The chat model turns your request into a complete prompt, then calls the drawing service. Images and generation records stay in the current project.",
    enabled: "Draw with your Somni account", quota: "Uses your current account's model service and quota.", model: "Drawing model",
    empty: "Sign in and sync models above to load available drawing models.", ready: "Ready. Describe the image you want in Chat.",
    unavailable: "Drawing is not ready. Sign in and sync models.", saving: "Saving…", saved: "Saved", preview: "Browser preview does not call the drawing service." },
} as const;

export default function SomniImageSettings({ language, models }: { language: Language; models: string[] }) {
  const copy = COPY[language];
  const [settings, setSettings] = useState<SomniImageSettingsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const modelKey = models.join("\n");
  useEffect(() => {
    let active = true;
    if (isTauri()) {
      void somniImageSettings().then((value) => { if (active) setSettings(value); })
        .catch((failure) => { if (active) setError(formatUserFacingError(failure, language)); });
    } else {
      const drawings = models.filter(isImageGenerationModel);
      setSettings({ enabled: true, model: drawings.includes("gpt-image-2") ? "gpt-image-2" : drawings[0] ?? null, models: drawings, available: false });
    }
    return () => { active = false; };
  }, [modelKey, language]);

  const save = async (enabled: boolean, model: string | null) => {
    setSaving(true); setSaved(false); setError("");
    try { setSettings(await somniImageSettingsSet(enabled, model)); setSaved(true); }
    catch (failure) { setError(formatUserFacingError(failure, language)); }
    finally { setSaving(false); }
  };

  return <SettingsSection title={copy.title} description={copy.description}>
    <SettingRow title={copy.enabled} description={copy.quota}>
      <button type="button" className="settings-switch" role="switch" aria-label={copy.enabled} aria-checked={settings?.enabled ?? false}
        disabled={!settings || saving || !isTauri()} onClick={() => void save(!settings?.enabled, settings?.model ?? null)}><span /></button>
    </SettingRow>
    <SettingRow title={copy.model}>
      {settings && settings.models.length > 0 ? <select className="sp-settings-select" aria-label={copy.model}
        value={settings.model ?? ""} disabled={saving || !isTauri()} onChange={(event) => void save(settings.enabled, event.target.value)}>
        {settings.model && !settings.models.includes(settings.model) && <option value={settings.model} disabled>{settings.model}</option>}
        {settings.models.map((model) => <option key={model} value={model}>{model}</option>)}
      </select> : <span className="sp-field-hint">{copy.empty}</span>}
    </SettingRow>
    <p className="sp-field-hint">{!isTauri() ? copy.preview : settings?.available ? copy.ready : copy.unavailable}</p>
    <SettingsFeedback state={error ? "error" : saving ? "saving" : saved ? "saved" : "idle"}
      message={error || (saving ? copy.saving : copy.saved)} />
  </SettingsSection>;
}
