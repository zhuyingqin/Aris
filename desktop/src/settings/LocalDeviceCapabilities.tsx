import { useCallback, useEffect, useRef, useState } from "react";

import {
  computeCapabilities,
  computeNodeConfigGet,
  computeNodeConfigSet,
  isTauri,
} from "../api/tauri";
import { ImageAssistRoster } from "../remote/ImageAssistRoster";
import { ImageAssistReadiness } from "../remote/ImageAssistReadiness";
import type { Language } from "../store";
import type { ComputeNodeCapabilities, ComputeNodeConfig } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { SettingRow, SettingsSection } from "./SettingsPrimitives";

interface LocalDeviceCapabilitiesProps {
  language: Language;
  onError?: (message: string) => void;
}

const PREVIEW_CONFIG: ComputeNodeConfig = {
  acceptRemoteJobs: false,
  acceptRemoteAgentChats: false,
  maxParallelJobs: 2,
  acceptImageHelp: false,
  imageHelpDailyLimit: 10,
  preferImageHelp: false,
};

export default function LocalDeviceCapabilities({
  language,
  onError,
}: LocalDeviceCapabilitiesProps) {
  const copy = SETTINGS_COPY[language].localCapabilities;
  const [config, setConfig] = useState<ComputeNodeConfig | null>(() => isTauri() ? null : PREVIEW_CONFIG);
  const [capabilities, setCapabilities] = useState<ComputeNodeCapabilities | null>(null);
  const [message, setMessage] = useState("");
  const latestConfigRef = useRef<ComputeNodeConfig | null>(config);
  const configWriteChainRef = useRef<Promise<void>>(Promise.resolve());

  const reportError = useCallback((reason: unknown) => {
    const detail = String(reason);
    setMessage(detail);
    onError?.(detail);
  }, [onError]);

  const updateConfigDraft = (patch: Partial<ComputeNodeConfig>) => {
    setConfig((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      latestConfigRef.current = next;
      return next;
    });
  };

  const persistConfig = useCallback((next: ComputeNodeConfig) => {
    latestConfigRef.current = next;
    setConfig(next);
    if (!isTauri()) return;
    configWriteChainRef.current = configWriteChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await computeNodeConfigSet(
          next.acceptRemoteJobs,
          next.acceptRemoteAgentChats,
          next.maxParallelJobs,
          next.acceptImageHelp,
          next.imageHelpDailyLimit,
          next.preferImageHelp,
        );
        const latest = latestConfigRef.current;
        if (
          latest?.acceptRemoteJobs === next.acceptRemoteJobs
          && latest.acceptRemoteAgentChats === next.acceptRemoteAgentChats
          && latest.maxParallelJobs === next.maxParallelJobs
          && latest.acceptImageHelp === next.acceptImageHelp
          && latest.imageHelpDailyLimit === next.imageHelpDailyLimit
          && latest.preferImageHelp === next.preferImageHelp
        ) {
          latestConfigRef.current = saved;
          setConfig(saved);
        }
      })
      .catch(reportError);
  }, [reportError]);

  useEffect(() => {
    if (!isTauri()) return;
    void Promise.all([computeNodeConfigGet(), computeCapabilities()])
      .then(([nextConfig, nextCapabilities]) => {
        latestConfigRef.current = nextConfig;
        setConfig(nextConfig);
        setCapabilities(nextCapabilities);
      })
      .catch(reportError);
  }, [reportError]);

  if (!config) {
    return <div className="sp-remote-empty">{copy.loading}</div>;
  }

  return (
    <div className="settings-remote-capabilities">
      {message && <span className="sp-remote-message" role="status">{message}</span>}

      <SettingsSection title={copy.title} actions={
        <span className={"sp-remote-capability-badge" + (config.acceptRemoteJobs ? " enabled" : "")}>
          {config.acceptRemoteJobs ? copy.badgeAccepting : copy.badgeLocalOnly}
        </span>
      }>
        <SettingRow title={copy.maxParallelJobsLabel} description={capabilities
          ? [capabilities.logicalCpus + " CPU", capabilities.platform, capabilities.architecture].join(" · ")
          : copy.detectingCapabilities}>
          <input
            className="settings-remote-parallel-input"
            aria-label={copy.maxParallelJobsLabel}
            type="number"
            min={1}
            max={64}
            value={config.maxParallelJobs}
            onChange={(event) => updateConfigDraft({
              maxParallelJobs: Math.max(1, Math.min(64, Number(event.target.value) || 1)),
            })}
            onBlur={() => persistConfig(config)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingRow>

        <SettingRow title={copy.acceptRemoteJobsTitle} description={copy.acceptRemoteJobsDesc}>
          <button type="button" className="settings-switch" role="switch"
            aria-label={copy.acceptRemoteJobsTitle} aria-checked={config.acceptRemoteJobs}
            onClick={() => persistConfig({ ...config, acceptRemoteJobs: !config.acceptRemoteJobs })}>
            <span />
          </button>
        </SettingRow>

        <SettingRow title={copy.acceptRemoteAgentChatsTitle} description={copy.acceptRemoteAgentChatsDesc}>
          <button type="button" className="settings-switch" role="switch"
            aria-label={copy.acceptRemoteAgentChatsTitle} aria-checked={config.acceptRemoteAgentChats}
            onClick={() => persistConfig({ ...config, acceptRemoteAgentChats: !config.acceptRemoteAgentChats })}>
            <span />
          </button>
        </SettingRow>

        <SettingRow title={copy.acceptImageHelpTitle} description={copy.acceptImageHelpDesc}
          feedback={<ImageAssistReadiness enabled={config.acceptImageHelp} language={language} />}>
          <button type="button" className="settings-switch" role="switch"
            aria-label={copy.acceptImageHelpTitle} aria-checked={config.acceptImageHelp}
            onClick={() => persistConfig({ ...config, acceptImageHelp: !config.acceptImageHelp })}>
            <span />
          </button>
        </SettingRow>

        <SettingRow title={copy.preferImageHelpTitle} description={copy.preferImageHelpDesc}>
          <button type="button" className="settings-switch" role="switch"
            aria-label={copy.preferImageHelpTitle} aria-checked={config.preferImageHelp}
            onClick={() => persistConfig({ ...config, preferImageHelp: !config.preferImageHelp })}>
            <span />
          </button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={copy.imageAssistRosterTitle} description={copy.imageAssistRosterDesc}>
        <div className="settings-remote-roster-body">
          <ImageAssistRoster language={language} />
        </div>
      </SettingsSection>
    </div>
  );
}
