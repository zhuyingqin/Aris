import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import EnvironmentSettings from "./EnvironmentSettings";
import BuiltinToolAvailabilitySettings from "./BuiltinToolAvailabilitySettings";
import type { ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { SettingsSection } from "./SettingsPrimitives";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";

interface Props {
  language: Language;
  appVersion: string;
  pythonEnvironmentPath?: string;
  onConfigRefreshed?: (config: ConfigView) => void;
}

export default function AboutSettings({ language, appVersion, pythonEnvironmentPath, onConfigRefreshed }: Props) {
  const copy = SETTINGS_COPY[language].general;
  return <>
    <SettingsSection title="SomniQ Studio">
      <div className="sp-update-meta">{copy.aboutCurrentVersion(appVersion)}</div>
    </SettingsSection>
    <SettingsSection title={SETTINGS_LAYOUT_COPY[language].links}>
      <div className="sp-about-links-row">
        <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris" target="_blank" rel="noreferrer">
          <SvgIcon name="externalLink" size={13} />{copy.aboutLinkRepo}
        </a>
        <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/releases" target="_blank" rel="noreferrer">
          <SvgIcon name="externalLink" size={13} />{copy.aboutLinkReleases}
        </a>
        {/* HEAD, not a branch name: release branches move and a pinned one 404s. */}
        <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/blob/HEAD/LICENSE" target="_blank" rel="noreferrer">
          <SvgIcon name="externalLink" size={13} />{copy.aboutLinkLicense}
        </a>
      </div>
    </SettingsSection>
    <EnvironmentSettings language={language} pythonEnvironmentPath={pythonEnvironmentPath ?? ""} onConfigRefreshed={onConfigRefreshed ?? (() => {})} />
    <BuiltinToolAvailabilitySettings language={language} />
  </>;
}
