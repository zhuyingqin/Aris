import type { ReactNode } from "react";
import { COPY, APP_VERSION, RELEASES_URL, type Lang, type Theme } from "../i18n";
import { CONSOLE_COPY } from "../consoleI18n";
import LanguageSelector from "./LanguageSelector";
import PwaInstallBanner from "./PwaInstallBanner";
import { HomeIcon, SunIcon, MoonIcon, UserIcon, LogoutIcon, ChartBarIcon, SparklesIcon, SmartphoneIcon, CheckIcon, WindowsIcon, RefreshIcon, ShieldCheckIcon } from "./icons";

export type ConsoleTab = "activity" | "usage" | "remote" | "plan" | "admin";
type Props = {
  lang: Lang; theme: Theme; onSelectLang: (lang: Lang) => void; onToggleTheme: () => void;
  user: { id: string | number; username: string; display_name?: string } | null;
  activeTab: ConsoleTab; onSelectTab: (tab: ConsoleTab) => void;
  onLogout: () => void; onRefresh: () => void; refreshing: boolean;
  quotaLabel: string; balanceLabel: string; remainingPercent: number;
  tierName?: string; onlineCount?: number; isAdmin?: boolean; showInstallBanner?: boolean;
  children: ReactNode; overlay?: ReactNode;
};

// Shared original console layout. Identity contracts stay in their own callers.
export default function ConsoleShell({lang, theme, onSelectLang, onToggleTheme, user, activeTab,
  onSelectTab, onLogout, onRefresh, refreshing, quotaLabel, balanceLabel, remainingPercent,
  tierName, onlineCount = 0, isAdmin = false, showInstallBanner = true, children, overlay}: Props) {
  const copy = COPY[lang]; const c = CONSOLE_COPY[lang];
  return (
    <div className={`console-root lang-${lang} theme-${theme}`}>
      {/* SomniQ Signature Aurora Background */}
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob--blue" />
        <span className="aurora-blob aurora-blob--violet" />
        <span className="aurora-grid" />
      </div>

      {showInstallBanner && <PwaInstallBanner copy={copy} />}

      {/* Top Header Bar */}
      <header className="console-header">
        <div className="console-header-left">
          <a className="brand console-brand" href={`./?lang=${lang}`} title={c.header.returnHomeTitle}>
            <img src="./app-logo.png" alt="SomniQ Logo" width={26} height={26} />
            <span className="brand-name">SomniQ</span>
            <span className="brand-name-sub">Studio</span>
          </a>
          <span className="console-crumb-divider" aria-hidden="true">/</span>
          <span className="console-pill-badge">
            <span className="console-badge-dot" aria-hidden="true" />
            {c.header.consoleBadge}
          </span>
        </div>

        <div className="console-header-right">
          <a
            className="console-link-home"
            href={`./?lang=${lang}`}
            title={c.header.returnHomeTitle}
          >
            <HomeIcon width={14} height={14} />
            <span className="console-link-home-text">{c.header.returnHome}</span>
          </a>

          <button
            type="button"
            className="theme-toggle"
            onClick={onToggleTheme}
            title={theme === "dark" ? copy.themeLightLabel : copy.themeDarkLabel}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <SunIcon width={15} height={15} /> : <MoonIcon width={15} height={15} />}
          </button>

          <LanguageSelector
            currentLang={lang}
            onSelectLang={onSelectLang}
          />

          {user && (
            <div className="console-user-pill" title={`${user.display_name || user.username} (#${user.id})`}>
              <div className="console-avatar">
                <UserIcon width={13} height={13} />
              </div>
              <span className="console-username">{user.display_name || user.username}</span>
              <button
                type="button"
                className="console-logout-btn"
                data-testid="account-logout"
                onClick={onLogout}
                title={c.header.logout}
                aria-label={c.header.logout}
              >
                <LogoutIcon width={13} height={13} />
                <span className="console-logout-text">{c.header.logout}</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Console Body: Left Sidebar + Main Content */}
      <div className="console-body">
        {/* Left Navigation Sidebar */}
        <aside className="console-sidebar">
          <nav className="console-nav" aria-label="Console navigation">
            {/* Group 1: 科研分析 / RESEARCH & ANALYTICS */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.analyticsTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "activity" ? "console-nav-item--active" : ""}`}
                  onClick={() => onSelectTab("activity")}
                  title={c.nav.activityTitle}
                >
                  <ChartBarIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.activityFull}</span>
                  <span className="console-nav-label-short">{c.nav.activityShort}</span>
                </button>

                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "usage" ? "console-nav-item--active" : ""}`}
                  onClick={() => onSelectTab("usage")}
                  title={c.nav.usageTitle}
                >
                  <SparklesIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.usageFull}</span>
                  <span className="console-nav-label-short">{c.nav.usageShort}</span>
                </button>
              </div>
            </div>

            {/* Group 2: 协同终端 / WORKSPACES & CLIENTS */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.terminalsTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item console-nav-item--remote ${activeTab === "remote" ? "console-nav-item--active" : ""}`}
                  onClick={() => onSelectTab("remote")}
                  title={c.nav.remoteTitle}
                >
                  <SmartphoneIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.remoteFull}</span>
                  <span className="console-nav-label-short">{c.nav.remoteShort}</span>
                  {onlineCount > 0 && (
                    <span className="console-nav-badge console-nav-badge--online">
                      {c.nav.onlineCount(onlineCount)}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Group 3: 算力与账户 / BILLING & ACCOUNT */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.accountTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "plan" ? "console-nav-item--active" : ""}`}
                  onClick={() => onSelectTab("plan")}
                  title={c.nav.planTitle}
                >
                  <CheckIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.planFull}</span>
                  <span className="console-nav-label-short">{c.nav.planShort}</span>
                  {tierName && (
                    <span className="console-nav-badge console-nav-badge--pro">{tierName}</span>
                  )}
                </button>
              </div>
            </div>

            {isAdmin && <div className="console-nav-group">
              <div className="console-nav-section-title"><span>{lang === "zh" ? "管理员" : lang === "es" ? "Administración" : "Administration"}</span></div>
              <button type="button" className={"console-nav-item " + (activeTab === "admin" ? "console-nav-item--active" : "")} onClick={() => onSelectTab("admin")}>
                <ShieldCheckIcon width={15} height={15} /><span>{lang === "zh" ? "会员与模型管理" : lang === "es" ? "Planes y modelos" : "Plans and models"}</span>
              </button>
            </div>}

            {/* Group 4: 资源生态 / ECOSYSTEM & DOCS */}
            <div className="console-nav-group console-nav-group--resources">
              <div className="console-nav-section-title">
                <span>{c.nav.resourcesTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <a
                  className="console-nav-item console-nav-link"
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={c.nav.desktopTitle}
                >
                  <WindowsIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.desktopFull}</span>
                  <span className="console-nav-label-short">{c.nav.desktopShort}</span>
                  <span className="console-nav-badge console-nav-badge--version">v{APP_VERSION}</span>
                </a>
              </div>
            </div>
          </nav>

          {/* Sidebar Bottom Quota Card */}
          <div className="console-sidebar-footer">
            <div className="console-mini-quota">
              <div className="mini-quota-head">
                <span className="mini-quota-label">{c.nav.miniQuotaLabel}</span>
                <span className="mini-quota-usd">{balanceLabel}</span>
              </div>
              <div className="mini-quota-bar">
                <div className="mini-quota-fill" style={{ width: `${remainingPercent}%` }} />
              </div>
              <div className="mini-quota-foot">
                <span className="mini-quota-tokens">{quotaLabel}</span>
                <button
                  type="button"
                  className={`mini-refresh-btn ${refreshing ? "mini-refresh-btn--spin" : ""}`}
                  onClick={onRefresh}
                  disabled={refreshing}
                  title={c.nav.miniQuotaRefresh}
                >
                  <RefreshIcon width={12} height={12} />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Console Canvas */}
        <main className="console-main">{children}</main>
      </div>
      {overlay}
    </div>
  );
}
