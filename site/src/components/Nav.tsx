import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { LANGUAGES, type Copy, type Lang, type Theme } from "../i18n";
import { ArrowIcon, GlobeIcon, MoonIcon, SparklesIcon, SunIcon, UserIcon } from "./icons";
import LanguageSelector from "./LanguageSelector";
import { independentAccountsEnabled, loadIndependentAccount, loadComputeUsage, logoutIndependentAccount, type IndependentAccount, type ComputeUsage } from "../independentAccount";

type Props = {
  copy: Copy;
  theme?: Theme;
  currentLang?: Lang;
  onSelectLang?: (lang: Lang) => void;
  onToggleLang?: () => void;
  onToggleTheme?: () => void;
};

export default function Nav({
  copy,
  theme = "dark",
  currentLang,
  onSelectLang,
  onToggleLang,
  onToggleTheme,
}: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [account, setAccount] = useState<IndependentAccount | null>(null);
  const [usage, setUsage] = useState<ComputeUsage | null>(null);
  useEffect(() => {
    if (!independentAccountsEnabled) return;
    let live = true;
    loadIndependentAccount().then(async value => {
      if (!live) return;
      setAccount(value);
      if (value?.compute_connected && !value.agreement_required) {
        const next = await loadComputeUsage();
        if (live) setUsage(next);
      }
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const { user, isAuthenticated, logout: legacyLogout, openAuthModal, formatTokens: authFormatTokens } = useAuth();
  const signedIn = independentAccountsEnabled ? !!account : isAuthenticated && !!user;
  const displayName = independentAccountsEnabled ? account?.user.display_name : user?.display_name || user?.username;
  const logout = () => {
    if (!independentAccountsEnabled) { legacyLogout(); return; }
    void logoutIndependentAccount().then(() => { setAccount(null); setUsage(null); })
      .catch(() => window.location.assign("./dashboard.html"));
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const effectiveLang: Lang =
    currentLang ?? (copy.htmlLang === "zh-CN" ? "zh" : copy.htmlLang === "es" ? "es" : "en");
  const isZh = effectiveLang === "zh";
  const formatTokens = (quota: number, customUnit?: string) =>
    authFormatTokens(quota, customUnit ?? (isZh ? " 词元" : " Tokens"));
  const quotaLabel = independentAccountsEnabled
    ? usage ? usage.quota.toLocaleString(effectiveLang) + (isZh ? " 额度单位" : " quota units") : "—"
    : formatTokens(user?.quota || 0);
  const homeHref = `./?lang=${effectiveLang}`;
  const dashboardHref = `./dashboard.html?lang=${effectiveLang}`;

  const handleLangSelect = (next: Lang) => {
    if (onSelectLang) {
      onSelectLang(next);
    } else if (onToggleLang) {
      onToggleLang();
    }
  };

  return (
    <header className={`nav${scrolled ? " nav--scrolled" : ""}`}>
      <div className="container nav-inner">
        <a className="brand" href={homeHref}>
          <img
            src="./app-logo.png"
            alt="SomniQ Logo"
            width={30}
            height={30}
            fetchPriority="high"
            decoding="async"
          />
          <span className="brand-name">{copy.nav.brand}</span>
        </a>

        <nav
          id="primary-navigation"
          className={`nav-links${menuOpen ? " nav-links--open" : ""}`}
          aria-label={copy.nav.brand}
        >
          {copy.nav.links.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </a>
          ))}

          {/* Mobile drawer language selection */}
          <div className="nav-drawer-lang-section">
            <div className="nav-drawer-lang-title">
              <GlobeIcon width={13} height={13} />
              <span>Language / 语言</span>
            </div>
            <div className="nav-drawer-lang-grid">
              {LANGUAGES.map((langItem) => {
                const isActive = langItem.code === effectiveLang;
                return (
                  <button
                    key={langItem.code}
                    type="button"
                    className={`nav-drawer-lang-btn ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      handleLangSelect(langItem.code);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="lang-btn-flag">{langItem.flag}</span>
                    <span>{langItem.nativeLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mobile drawer user account card */}
          <div className="nav-drawer-user-section">
            {signedIn ? (
              <div className="nav-drawer-user-card">
                <div className="nav-drawer-user-info">
                  <div className="nav-user-avatar">
                    <UserIcon width={16} height={16} />
                  </div>
                  <div className="nav-drawer-user-meta">
                    <span className="nav-drawer-username">{displayName}</span>
                    <span className="nav-drawer-quota">
                      <SparklesIcon width={12} height={12} />
                      {quotaLabel}
                    </span>
                  </div>
                </div>
                <div className="nav-drawer-user-actions">
                  <a
                    href={dashboardHref}
                    className="btn btn--primary nav-drawer-console-btn"
                    onClick={() => setMenuOpen(false)}
                  >
                    <span>{copy.nav.userCenter}</span>
                    <ArrowIcon width={14} height={14} />
                  </a>
                  <button
                    type="button"
                    className="nav-drawer-logout-btn"
                    onClick={() => {
                      setMenuOpen(false);
                      logout();
                    }}
                  >
                    {copy.dashboard.logout}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--primary nav-drawer-login-btn"
                onClick={() => {
                  setMenuOpen(false);
                  openAuthModal("login");
                }}
              >
                <UserIcon width={16} height={16} />
                <span>{copy.nav.login}</span>
              </button>
            )}
          </div>
        </nav>

        <div className="nav-actions">

          {signedIn ? (
            <a
              href={dashboardHref}
              className="nav-user-pill"
              title={copy.nav.userCenter}
            >
              <div className="nav-user-avatar">
                <UserIcon width={14} height={14} />
              </div>
              <span className="nav-user-name">{displayName}</span>
              <span className="nav-user-quota">{quotaLabel}</span>
            </a>
          ) : (
            <button
              type="button"
              className="nav-auth-btn"
              onClick={() => openAuthModal("login")}
              title={copy.auth.loginTitle}
            >
              <UserIcon width={14} height={14} />
              <span>{copy.nav.login}</span>
            </button>
          )}

          {onToggleTheme && (
            <button
              type="button"
              className="theme-toggle"
              onClick={onToggleTheme}
              aria-label={copy.themeToggleLabel}
              title={theme === "dark" ? copy.themeLightLabel : copy.themeDarkLabel}
            >
              {theme === "dark" ? <SunIcon width={17} height={17} /> : <MoonIcon width={17} height={17} />}
            </button>
          )}

          <LanguageSelector
            currentLang={effectiveLang}
            onSelectLang={handleLangSelect}
          />

          <button
            type="button"
            className="nav-burger"
            aria-label={copy.nav.menuLabel}
            aria-controls="primary-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
