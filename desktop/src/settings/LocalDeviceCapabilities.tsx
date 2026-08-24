import { useCallback, useEffect, useRef, useState } from "react";

import {
  computeCapabilities,
  computeNodeConfigGet,
  computeNodeConfigSet,
  isTauri,
} from "../api/tauri";
import { ImageAssistRoster } from "../remote/ImageAssistRoster";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ComputeNodeCapabilities, ComputeNodeConfig } from "../types";
import { SETTINGS_COPY } from "./i18n";

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
    <section className="sp-remote-capabilities" aria-labelledby="remote-capabilities-title">
      <div className="sp-remote-devices-head">
        <div>
          <div className="sp-section-title" id="remote-capabilities-title">{copy.title}</div>
          <div className="sp-section-sub">{copy.subtitle}</div>
        </div>
        <span className={"sp-remote-capability-badge" + (config.acceptRemoteJobs ? " enabled" : "")}>
          {config.acceptRemoteJobs ? copy.badgeAccepting : copy.badgeLocalOnly}
        </span>
      </div>

      {message && <span className="sp-remote-message" role="status">{message}</span>}

      <div className="sp-remote-capability-grid">
        <div className="sp-remote-capability-card">
          <label>
            <span className="sp-remote-capability-card-label">{copy.maxParallelJobsLabel}</span>
            <input
              className="sp-remote-capability-parallel-input"
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
          </label>
          <small>
            {capabilities
              ? [capabilities.logicalCpus + " CPU", capabilities.platform, capabilities.architecture].join(" · ")
              : copy.detectingCapabilities}
          </small>
          <SvgIcon name="edit" size={14} className="sp-remote-capability-card-edit" />
        </div>
      </div>

      <label className="sp-remote-capability-toggle">
        <span className="sp-remote-capability-icon"><SvgIcon name="shieldCheck" size={18} /></span>
        <span className="sp-remote-capability-copy">
          <strong>{copy.acceptRemoteJobsTitle}</strong>
          <small>{copy.acceptRemoteJobsDesc}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptRemoteJobs}
          onChange={(event) => persistConfig({ ...config, acceptRemoteJobs: event.target.checked })}
        />
      </label>

      <label className="sp-remote-capability-toggle">
        <span className="sp-remote-capability-icon"><SvgIcon name="user" size={18} /></span>
        <span className="sp-remote-capability-copy">
          <strong>{copy.acceptRemoteAgentChatsTitle}</strong>
          <small>{copy.acceptRemoteAgentChatsDesc}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptRemoteAgentChats}
          onChange={(event) => persistConfig({
            ...config,
            acceptRemoteAgentChats: event.target.checked,
          })}
        />
      </label>

      <label className="sp-remote-capability-toggle">
        <span className="sp-remote-capability-icon"><SvgIcon name="image" size={18} /></span>
        <span className="sp-remote-capability-copy">
          <strong>{copy.acceptImageHelpTitle}</strong>
          <small>{copy.acceptImageHelpDesc}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.acceptImageHelp}
          onChange={(event) => persistConfig({
            ...config,
            acceptImageHelp: event.target.checked,
          })}
        />
      </label>

      <label className="sp-remote-capability-toggle">
        <span className="sp-remote-capability-icon"><SvgIcon name="image" size={18} /></span>
        <span className="sp-remote-capability-copy">
          <strong>{copy.preferImageHelpTitle}</strong>
          <small>{copy.preferImageHelpDesc}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={config.preferImageHelp}
          onChange={(event) => persistConfig({
            ...config,
            preferImageHelp: event.target.checked,
          })}
        />
      </label>

      <div className="sp-remote-capability-roster">
        <div className="sp-section-title">{copy.imageAssistRosterTitle}</div>
        <div className="sp-section-sub">{copy.imageAssistRosterDesc}</div>
        <ImageAssistRoster language={language} />
      </div>
    </section>
  );
}
