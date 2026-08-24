import { useCallback, useEffect, useState } from "react";
import { COPY, detectTheme, persistTheme, useAutoLang, RELEASES_URL, type Lang, type Theme } from "./i18n";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Nav from "./components/Nav";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import UserDashboard from "./components/UserDashboard";
import PwaInstallBanner from "./components/PwaInstallBanner";
import { ArrowIcon, CheckIcon, WindowsIcon } from "./components/icons";

function PricingContent({
  lang,
  theme,
  onSelectLang,
  onToggleLang,
  onToggleTheme,
}: {
  lang: Lang;
  theme: Theme;
  onSelectLang: (lang: Lang) => void;
  onToggleLang: () => void;
  onToggleTheme: () => void;
}) {
  const { user, formatTokens } = useAuth();
  const copy = COPY[lang];
  const { pricing } = copy;
  const isZh = lang === "zh";

  const isPro = user ? user.role >= 10 || user.group === "vip" || user.group === "千研" || ((user.quota ?? 0) > 0) : false;
  const hasActivePlan = isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研";
  const remaining = user?.quota || 0;
  const used = user?.used_quota || 0;
  const usdValue = (remaining / 500000).toFixed(2);

  return (
    <div className={`page pricing-page lang-${lang} theme-${theme}`}>
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob--blue" />
        <span className="aurora-blob aurora-blob--violet" />
        <span className="aurora-grid" />
      </div>

      <PwaInstallBanner copy={copy} />
      <Nav
        copy={copy}
        theme={theme}
        currentLang={lang}
        onSelectLang={onSelectLang}
        onToggleLang={onToggleLang}
        onToggleTheme={onToggleTheme}
      />

      <main id="main">
        <section className="pricing-hero">
          <div className="container pricing-hero-inner">
            <div className="pricing-copy">
              <p className="section-kicker">{pricing.kicker}</p>
              <h1>{pricing.title}</h1>
              <p className="pricing-lede">{pricing.lede}</p>
              <a className="pricing-back" href={`./?lang=${lang}`}>
                {pricing.backHome}
                <ArrowIcon className="btn-arrow" width={16} height={16} />
              </a>
            </div>

            {hasActivePlan ? (
              /* Active new-api Subscription Card */
              <article className="pricing-plan" aria-label={isZh ? "当前已生效订阅" : "Active Subscription"}>
                <div className="pricing-plan-head">
                  <div>
                    <p className="pricing-plan-name">
                      {user?.group === "千研"
                        ? isZh
                          ? "千研科研 Pro 会员"
                          : "Thousand Research Pro"
                        : isZh
                        ? "SomniQ 科研专业版"
                        : "SomniQ Pro Tier"}
                    </p>
                    <p style={{ color: "var(--cyan)", fontSize: "13px" }}>
                      {isZh ? `已绑定 new-api 分组: ${user?.group || "千研"}` : `Active new-api Group: ${user?.group || "千研"}`}
                    </p>
                  </div>
                  <span className="pricing-plan-badge" style={{ background: "#10b981", color: "#000" }}>
                    {isZh ? "● 履约中" : "● Active"}
                  </span>
                </div>

                <div className="pricing-price" style={{ flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                    <strong style={{ fontSize: "32px" }}>{formatTokens(remaining)}</strong>
                    <span style={{ fontSize: "13px", color: "var(--text-faint)" }}>≈ ${usdValue} USD</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    {isZh ? `累计消耗: ${formatTokens(used)}` : `Total Used: ${formatTokens(used)}`}
                  </span>
                </div>

                <div className="pricing-actions" style={{ gap: "10px", marginTop: "24px" }}>
                  <a className="btn btn--primary" href={isZh ? "./dashboard.html?lang=zh" : "./dashboard.html?lang=en"}>
                    <CheckIcon width={16} height={16} />
                    {isZh ? "进入控制台管理算力" : "Go to Dashboard"}
                    <ArrowIcon className="btn-arrow" width={16} height={16} />
                  </a>
                  <a className="btn btn--outline" href="./remote/" target="_blank" rel="noreferrer noopener">
                    {isZh ? "打开手机远程工作台" : "Launch Remote PWA"}
                  </a>
                </div>
              </article>
            ) : (
              /* Standard Subscription Plan */
              <article className="pricing-plan" aria-label={pricing.planName}>
                <div className="pricing-plan-head">
                  <div>
                    <p className="pricing-plan-name">{pricing.planName}</p>
                    <p>{pricing.planDescription}</p>
                  </div>
                  <span className="pricing-plan-badge">{pricing.badge}</span>
                </div>

                <div className="pricing-price">
                  <strong>{pricing.price}</strong>
                  <span>{pricing.priceLabel}</span>
                </div>

                <div className="pricing-includes">
                  <h2>{pricing.includesTitle}</h2>
                  <ul>
                    {pricing.includes.map((item) => (
                      <li key={item}>
                        <span aria-hidden="true">✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="pricing-actions">
                  <a className="btn btn--primary" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
                    <WindowsIcon width={17} height={17} />
                    {pricing.cta}
                    <ArrowIcon className="btn-arrow" width={17} height={17} />
                  </a>
                </div>
              </article>
            )}
          </div>
        </section>
      </main>

      <Footer copy={copy} />

      <AuthModal copy={copy} />
      <UserDashboard copy={copy} />
    </div>
  );
}

export default function PricingApp() {
  const [lang, setLang] = useAutoLang();
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const copy = COPY[lang];
  const { pricing } = copy;

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
    document.title = pricing.docTitle;
  }, [copy.htmlLang, pricing.docTitle]);

  useEffect(() => {
    persistTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Listen to browser/OS theme changes dynamically
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e: MediaQueryListEvent) => {
      const stored = window.localStorage.getItem("somniq-site-theme");
      if (!stored) {
        setTheme(e.matches ? "light" : "dark");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleLang = useCallback(() => {
    setLang((current) => (current === "zh" ? "en" : current === "en" ? "es" : "zh"));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <AuthProvider>
      <PricingContent
        lang={lang}
        theme={theme}
        onSelectLang={setLang}
        onToggleLang={toggleLang}
        onToggleTheme={toggleTheme}
      />
    </AuthProvider>
  );
}
