import { useEffect, useMemo, useState } from "react";
import {
  configGet,
  newapiBootstrap,
  type NewApiAccount,
} from "../api/tauri";
import { hasNativeBackend } from "../api/transport";
import { isManagedAuthInvalidError, useStore } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { readCachedAccount, writeCachedAccount } from "../accountCache";
import { SETTINGS_TAB_REQUEST_EVENT, SETTINGS_TAB_REQUEST_KEY } from "../settingsTabRequest";
import { SvgIcon } from "../SvgIcon";
import { notifyChatModelsUpdated } from "../modelEvents";
import type { ConfigView } from "../types";
import { MailSettingsDetail } from "./MailSettings";
import MemorySettings from "./MemorySettings";
import RemoteControlPanel from "./RemoteControlPanel";
import Profile from "./Profile";
import AboutSettings from "./AboutSettings";
import AccountSettings from "./AccountSettings";
import GeneralSettings from "./GeneralSettings";
import ModelsSettings from "./ModelsSettings";
import Extensions from "../extensions/Extensions";
import { SETTINGS_COPY } from "./i18n";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_GROUP_LABELS,
  SETTINGS_NAV_LABELS,
  SETTINGS_NAV_MISC,
  isSettingsNavId,
  type SettingsNavId,
} from "./settingsNav";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import { useSettingsConnectionState } from "./useSettingsConnectionState";

type SettingsTab = SettingsNavId;

function readRequestedSettingsTab(): SettingsTab | null {
  try {
    const value = sessionStorage.getItem(SETTINGS_TAB_REQUEST_KEY);
    const resolved = value === "environment" ? "about" : isSettingsNavId(value) ? value : null;
    if (resolved) {
      sessionStorage.removeItem(SETTINGS_TAB_REQUEST_KEY);
      return resolved;
    }
  } catch {
    // Session storage can be disabled in embedded browser contexts.
  }
  return null;
}

export default function Settings() {
  const setError = useStore((state) => state.setError);
  const language = useStore((state) => state.language);
  const logout = useStore((state) => state.logout);
  const setTab = useStore((state) => state.setTab);
  const hideMail = useStore((state) => state.hideMail);
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const previewData = PREVIEW_SETTINGS_DATA[language];
  const PREVIEW_CONFIG_VIEW = previewData.configView;
  const PREVIEW_ACCOUNT = previewData.account;
  const PREVIEW_SYSTEM_PROMPT = previewData.systemPrompt;
  const PREVIEW_USER_PROMPT = previewData.userPrompt;
  const [configView, setConfigView] = useState<ConfigView | null>(() => hasNativeBackend() ? null : PREVIEW_CONFIG_VIEW);
  const [managedModels, setManagedModels] = useState<string[]>(() => hasNativeBackend() ? [] : PREVIEW_CONFIG_VIEW.managedModels ?? []);
  const [account, setAccount] = useState<NewApiAccount | null>(() => hasNativeBackend() ? readCachedAccount() : PREVIEW_ACCOUNT);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(() => readRequestedSettingsTab() ?? "general");

  const connection = useSettingsConnectionState({
    configView,
    setConfigView,
    setManagedModels,
    account,
    setAccount,
    previewManagedModels: PREVIEW_CONFIG_VIEW.managedModels ?? [],
  });
  const { loadConfig, loadManagedModels } = connection;

  useEffect(() => {
    if (!hasNativeBackend()) return;
    configGet().then(loadConfig).catch((error) => setError(formatUserFacingError(error, language)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setError]);

  useEffect(() => {
    if (hasNativeBackend()) return;
    setConfigView(PREVIEW_CONFIG_VIEW);
    setManagedModels(PREVIEW_CONFIG_VIEW.managedModels ?? []);
    setAccount(PREVIEW_ACCOUNT);
  }, [language]);

  // Shared by loadAccount and AccountSettings' saveAccountGroup: both apply a
  // freshly confirmed account the same way (sync managedModels/configView,
  // notify Chat, persist the cache).
  const applyRefreshedAccount = (next: NewApiAccount) => {
    setAccount(next);
    if (next.models.length > 0) {
      setManagedModels(next.models);
      setConfigView((current) => current ? { ...current, managedModels: next.models } : current);
      notifyChatModelsUpdated();
    }
    writeCachedAccount(next);
  };

  const loadAccount = async () => {
    if (!hasNativeBackend()) {
      applyRefreshedAccount(PREVIEW_ACCOUNT);
      return;
    }
    setAccountLoading(true);
    setAccountError("");
    try {
      applyRefreshedAccount(await newapiBootstrap());
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setAccountError(message);
      if (isManagedAuthInvalidError(error)) {
        writeCachedAccount(null);
        logout();
      }
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    if (!hasNativeBackend()) return;
    void loadManagedModels();
    void loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openRequestedTab = (tab: SettingsTab) => {
      setActiveSettingsTab(tab);
      try {
        sessionStorage.removeItem(SETTINGS_TAB_REQUEST_KEY);
      } catch {
        // Session storage may be unavailable.
      }
    };
    const onSettingsTabRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (detail === "environment") {
        openRequestedTab("about");
        return;
      }
      if (isSettingsNavId(detail)) {
        openRequestedTab(detail);
        return;
      }
      const requested = readRequestedSettingsTab();
      if (requested) openRequestedTab(requested);
    };
    const requested = readRequestedSettingsTab();
    if (requested) openRequestedTab(requested);
    window.addEventListener(SETTINGS_TAB_REQUEST_EVENT, onSettingsTabRequest);
    return () => {
      window.removeEventListener(SETTINGS_TAB_REQUEST_EVENT, onSettingsTabRequest);
    };
  }, []);

  const visibleNavGroups = useMemo(() => {
    return SETTINGS_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.id === "mail" && hideMail) return false;
        return true;
      }),
    })).filter((group) => group.items.length > 0);
  }, [hideMail]);

  useEffect(() => {
    if (hideMail && activeSettingsTab === "mail") {
      setActiveSettingsTab("general");
    }
  }, [hideMail, activeSettingsTab]);

  if (!configView) return <div className="board"><div className="empty">{copy.loading}</div></div>;

  const navMisc = SETTINGS_NAV_MISC[language];
  const navLabels = SETTINGS_NAV_LABELS[language];
  const navGroupLabels = SETTINGS_NAV_GROUP_LABELS[language];

  return (
    <div className="st-page sp-settings-page sp-settings-shell">
      <aside className="sp-settings-nav" aria-label={copy.settingsCategories}>
        <div className="sp-settings-nav-head">
          <button type="button" className="sp-settings-back" onClick={() => setTab("chat")}>
            <span className="sp-settings-back-icon"><SvgIcon name="chevronLeft" size={14} /></span>
            <span>{navMisc.back}</span>
          </button>
        </div>
        <div className="sp-settings-nav-scroll" role="tablist">
          {visibleNavGroups.map((group) => (
            <div className="sp-settings-nav-group" key={group.id}>
              <div className="sp-settings-nav-group-title">{navGroupLabels[group.id]}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={activeSettingsTab === item.id}
                  className={`sp-nav-item${activeSettingsTab === item.id ? " active" : ""}`}
                  onClick={() => setActiveSettingsTab(item.id)}
                >
                  <span className="sp-nav-item-icon">{item.icon}</span>
                  <span className="sp-nav-item-label">{navLabels[item.id]}</span>
                  {item.external && (
                    <span className="sp-nav-item-ext"><SvgIcon name="externalLink" size={12} /></span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div
        className={`sp-settings-content${
          activeSettingsTab === "extensions"
            ? " sp-settings-content-flush"
            : activeSettingsTab === "remote"
              ? " sp-settings-content-remote"
              : ""
        }`}
      >

      {activeSettingsTab === "profile" && (
        <Profile account={account} language={language} />
      )}

      {activeSettingsTab === "general" && (
        <GeneralSettings
          language={language}
          configView={configView}
          advForm={connection.advForm}
          setAdvForm={connection.setAdvForm}
          saveState={connection.saveState}
          save={connection.save}
          resetOpState={connection.resetOpState}
          previewSystemPrompt={PREVIEW_SYSTEM_PROMPT}
          previewUserPrompt={PREVIEW_USER_PROMPT}
        />
      )}

      {activeSettingsTab === "mail" && (
        <div className="sp-mail-page">
          <MailSettingsDetail />
        </div>
      )}

      {activeSettingsTab === "memory" && (
        <MemorySettings language={language} />
      )}

      {activeSettingsTab === "models" && (
        <ModelsSettings
          language={language}
          configView={configView}
          account={account}
          managedModels={managedModels}
          connection={connection}
        />
      )}

      {activeSettingsTab === "extensions" && (
        <div className="sp-extensions-embed">
          <Extensions />
        </div>
      )}

      {activeSettingsTab === "remote" && (
        <div className="remote-control-page">
          <RemoteControlPanel language={language} onError={setError} />
        </div>
      )}

      {activeSettingsTab === "account" && (
        <AccountSettings
          language={language}
          account={account}
          accountLoading={accountLoading}
          accountError={accountError}
          onRefreshAccount={loadAccount}
          onAccountRefreshed={applyRefreshedAccount}
        />
      )}

      {activeSettingsTab === "about" && (
        <AboutSettings
          language={language}
          appVersion={configView.appVersion}
          pythonEnvironmentPath={configView.pythonEnvironmentPath ?? ""}
          onConfigRefreshed={setConfigView}
        />
      )}
      </div>
    </div>
  );
}
