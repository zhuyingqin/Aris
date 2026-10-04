import type { Language } from "../store";
import EnvironmentSettings from "./EnvironmentSettings";
import BuiltinToolAvailabilitySettings from "./BuiltinToolAvailabilitySettings";
import UpdateSettings from "./UpdateSettings";
import type { ConfigView } from "../types";

interface Props {
  language: Language;
  appVersion: string;
  pythonEnvironmentPath?: string;
  onConfigRefreshed?: (config: ConfigView) => void;
}

export default function AboutSettings({ language, appVersion, pythonEnvironmentPath, onConfigRefreshed }: Props) {
  return <>
    <UpdateSettings language={language} appVersion={appVersion} />
    <EnvironmentSettings language={language} pythonEnvironmentPath={pythonEnvironmentPath ?? ""} onConfigRefreshed={onConfigRefreshed ?? (() => {})} />
    <BuiltinToolAvailabilitySettings language={language} />
  </>;
}
