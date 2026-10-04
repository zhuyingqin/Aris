import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  resolveSettingsPageId,
  type SettingsPageId,
} from "./settingsNav";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import { useSettingsConnectionState } from "./useSettingsConnectionState";
import { usePreferenceSave } from "./usePreferenceSave";
import { SettingsPage } from "./SettingsPrimitives";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";

type SettingsTab = SettingsPageId;

function readRequestedSettingsTab(): SettingsTab | null {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("settingsTab") || params.get("settings");
      const requested = resolveSettingsPageId(fromUrl);
      if (requested) return requested;
    }
  } catch {
    // URL search params may fail in constrained environments.
  }
  try {
    const value = sessionStorage.getItem(SETTINGS_TAB_REQUEST_KEY);
    const resolved = resolveSettingsPageId(value);
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
  const hideMail = useStore((state) => state.hideMail);
  const currentProjectId = useStore((state) => state.currentProject?.id);
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const previewData = PREVIEW_SETTINGS_DATA[language];
  const PREVIEW_CONFIG_VIEW = previewData.configView;
  const PREVIEW_ACCOUNT = previewData.account;
  const PREVIEW_SYSTEM_PROMPT = previewData.systemPrompt;
  const PREVIEW_USER_PROMPT = previewData.userPrompt;
  const [configView, setConfigView] = useState<ConfigView | null>(() => hasNativeBackend() ? null : PREVIEW_CONFIG_VIEW);
  const [managedModels, setManagedModels] = useState<string[]>(() => hasNativeBackend() ? readCachedAccount()?.models ?? [] : PREVIEW_CONFIG_VIEW.managedModels ?? []);
  const [account, setAccount] = useState<NewApiAccount | null>(() => hasNativeBackend() ? readCachedAccount() : PREVIEW_ACCOUNT);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(() => readRequestedSettingsTab() ?? "general");
  // Keep forms mounted after their first visit so category switches retain drafts.
  const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(() => new Set([activeSettingsTab]));
  const preferences = usePreferenceSave();
  const navRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<SettingsTab, number>());

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = scrollPositions.current.get(activeSettingsTab) ?? 0;
    navRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSettingsTab, Boolean(configView)]);

  useEffect(() => {
    setVisitedTabs((current) => current.has(activeSettingsTab) ? current : new Set([...current, activeSettingsTab]));
  }, [activeSettingsTab]);

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
    setConfigView((current) => current ? { ...current, language: PREVIEW_CONFIG_VIEW.language } : PREVIEW_CONFIG_VIEW);
    setManagedModels(PREVIEW_CONFIG_VIEW.managedModels ?? []);
    setAccount(PREVIEW_ACCOUNT);
  }, [language]);

  // Sync the confirmed account, available models and the persistent cache.
  const applyRefreshedAccount = (next: NewApiAccount) => {
    setAccount(next);
    setManagedModels(next.models);
    setConfigView((current) => current ? { ...current, managedModels: next.models } : current);
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
        setAccount(null);
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
      const resolved = resolveSettingsPageId(detail);
      if (resolved) {
        openRequestedTab(resolved);
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

  const navLabels = SETTINGS_NAV_LABELS[language];
  const navGroupLabels = SETTINGS_NAV_GROUP_LABELS[language];
  const layoutCopy = SETTINGS_LAYOUT_COPY[language];

  return (
    <div className="st-page sp-settings-page sp-settings-shell">
      <aside className="sp-settings-nav" aria-label={copy.settingsCategories}>
        <div className="sp-settings-nav-scroll" role="tablist" ref={navRef}>
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
      <div className="sp-settings-content" ref={contentRef} onScroll={(event) => scrollPositions.current.set(activeSettingsTab, event.currentTarget.scrollTop)}>

      {!configView && activeSettingsTab !== "profile" && <div className="empty">{copy.loading}</div>}

      {(activeSettingsTab === "profile" || visitedTabs.has("profile")) && (
        <SettingsPage kind="profile" title={layoutCopy.profile} hidden={activeSettingsTab !== "profile"}>
          <Profile account={account} language={language} active={activeSettingsTab === "profile"} accountError={accountError}
            renderActivity={(activity) => hasNativeBackend() ? <AccountSettings
              key={account?.username ?? "signed-out"}
              language={language}
              account={account}
              accountLoading={accountLoading}
              active={activeSettingsTab === "profile"}
              onRefreshAccount={loadAccount}
            >{activity}</AccountSettings> : activity}
          />
        </SettingsPage>
      )}

      {configView && <>
      {activeSettingsTab === "general" && (
        <GeneralSettings
          language={language}
          configView={configView}
          advForm={connection.advForm}
          preferences={preferences}
          saveLanguage={connection.saveLanguage}
          memorySaveState={connection.memorySaveState}
          memorySaveError={connection.memorySaveError}
          saveMemoryWriteApproval={connection.saveMemoryWriteApproval}
          retryMemoryWriteApproval={connection.retryMemoryWriteApproval}
          previewSystemPrompt={PREVIEW_SYSTEM_PROMPT}
          previewUserPrompt={PREVIEW_USER_PROMPT}
        />
      )}

      {(activeSettingsTab === "mail" || visitedTabs.has("mail")) && (
        <SettingsPage kind="mail" title={layoutCopy.mail} hidden={activeSettingsTab !== "mail"}><div className="sp-mail-page">
          <MailSettingsDetail />
        </div></SettingsPage>
      )}

      {(activeSettingsTab === "memory" || visitedTabs.has("memory")) && (
        <SettingsPage kind="memory" title={layoutCopy.memory} hidden={activeSettingsTab !== "memory"}><MemorySettings key={currentProjectId} language={language} /></SettingsPage>
      )}

      {activeSettingsTab === "models" && (
        <SettingsPage kind="models" title={layoutCopy.models}><ModelsSettings
          language={language}
          configView={configView}
          account={account}
          managedModels={managedModels}
          connection={connection}
        /></SettingsPage>
      )}

      {(activeSettingsTab === "extensions" || visitedTabs.has("extensions")) && (
        <SettingsPage kind="extensions" title={layoutCopy.extensions} hidden={activeSettingsTab !== "extensions"}><div className="sp-extensions-embed">
          <Extensions embedded />
        </div></SettingsPage>
      )}

      {(activeSettingsTab === "remote" || visitedTabs.has("remote")) && (
        <SettingsPage kind="remote" title={layoutCopy.remote} hidden={activeSettingsTab !== "remote"}><div className="remote-control-page">
          <RemoteControlPanel language={language} onError={setError} />
        </div></SettingsPage>
      )}

      {(activeSettingsTab === "about" || visitedTabs.has("about")) && (
        <SettingsPage kind="about" title={layoutCopy.about} hidden={activeSettingsTab !== "about"}><AboutSettings
          language={language}
          appVersion={configView.appVersion}
          pythonEnvironmentPath={configView.pythonEnvironmentPath ?? ""}
          onConfigRefreshed={setConfigView}
        /></SettingsPage>
      )}
      </>}
      </div>
    </div>
  );
}
