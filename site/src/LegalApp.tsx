import { useEffect } from "react";
import { AUTO_RENEW_OFFER, yuan } from "./billingConfig";
import { COPY, useAutoLang } from "./i18n";
import {
  LEGAL_SUPPORT_EMAIL,
  SERVICE_PROVIDER_ADDRESS,
  USER_SERVICE_AGREEMENT,
  USER_SERVICE_AGREEMENT_UPDATED_AT,
  USER_SERVICE_AGREEMENT_VERSION,
} from "./userServiceAgreement";

import LanguageSelector from "./components/LanguageSelector";
import "./legalDocument.css";

const backLabels = { zh: "返回套餐页面", en: "Back to pricing", es: "Volver a los planes" };

export default function LegalApp() {
  const [lang, setLang] = useAutoLang();
  const copy = COPY[lang];
  const content = USER_SERVICE_AGREEMENT[lang];

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
    document.title = `${content.title} — SomniQ Studio`;
    // The browser may resolve the fragment before React renders the sections.
    const section = document.getElementById(window.location.hash.slice(1));
    if (section?.classList.contains("legal-section")) {
      section.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }, [copy.htmlLang, content.title]);

  return (
    <div className={`legal-document theme-light lang-${lang}`}>
      <header className="legal-toolbar">
        <a className="legal-brand" href={`./?lang=${lang}`}>SomniQ Studio</a>
        <div className="legal-toolbar-actions">
          <a href={`./pricing.html?lang=${lang}`}>{backLabels[lang]}</a>
          <LanguageSelector currentLang={lang} onSelectLang={setLang} />
        </div>
      </header>
      <main id="main" className="legal-main">
        <div className="container">
          <article className="legal-card">
            <header className="legal-document-heading">
              <p className="section-kicker">SomniQ Studio · {content.version} {USER_SERVICE_AGREEMENT_VERSION}</p>
              <h1>{content.title}</h1>
              <p className="legal-updated">
                {content.updated}: <time dateTime={USER_SERVICE_AGREEMENT_UPDATED_AT}>{USER_SERVICE_AGREEMENT_UPDATED_AT}</time>
              </p>
            </header>
            <p className="legal-intro">{content.intro}</p>
            <dl className="legal-facts">
              <div><dt>{content.provider}</dt><dd>{AUTO_RENEW_OFFER.merchantLegalName || content.providerPending}</dd></div>
              <div><dt>{content.address}</dt><dd>{SERVICE_PROVIDER_ADDRESS || content.addressPending}</dd></div>
              <div><dt>{content.contact}</dt><dd><a href={`mailto:${LEGAL_SUPPORT_EMAIL}`}>{LEGAL_SUPPORT_EMAIL}</a></dd></div>
              <div><dt>{content.effective}</dt><dd>{content.effectiveValue}</dd></div>
            </dl>
            <aside className="legal-notice" aria-labelledby="legal-notice-title">
              <h2 id="legal-notice-title">{content.noticeTitle}</h2>
              <p>{content.notice}</p>
            </aside>
            <details className="legal-contents">
              <summary id="legal-toc-title">{content.contents}</summary>
            <nav className="legal-toc" aria-labelledby="legal-toc-title">
              <ol role="list">
                {content.sections.map((section, index) => (
                  <li key={section.id}>
                    <a href={`#legal-${section.id}`}>
                      <span className="legal-toc-number">{String(index + 1).padStart(2, "0")}</span>
                      <span>{section.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            </details>
            {content.sections.map((section, index) => (
              <section className="legal-section" id={`legal-${section.id}`} aria-labelledby={`legal-${section.id}-title`} tabIndex={-1} key={section.id}>
                <h2 id={`legal-${section.id}-title`}>{index + 1}. {section.title}</h2>
                {section.paragraphs.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex}>
                    <span className="legal-clause-number">{index + 1}.{paragraphIndex + 1}</span>{" "}
                    {paragraph.important ? <strong>{paragraph.text}</strong> : paragraph.text}
                  </p>
                ))}
                {section.id === "auto-renewal" && (
                  <div className="legal-offer" aria-labelledby="legal-offer-title">
                    <h3 id="legal-offer-title">{content.offer.title}</h3>
                    <dl className="legal-facts">
                      <div><dt>{content.offer.plan}</dt><dd>{AUTO_RENEW_OFFER.planName}</dd></div>
                      <div><dt>{content.offer.merchant}</dt><dd>{AUTO_RENEW_OFFER.merchantLegalName || content.providerPending}</dd></div>
                      <div><dt>{content.offer.amount}</dt><dd>{yuan(AUTO_RENEW_OFFER.amountFen)} / {content.offer.perMonth} ({AUTO_RENEW_OFFER.currency})</dd></div>
                      <div><dt>{content.offer.period}</dt><dd>{content.offer.periodValue}</dd></div>
                      <div><dt>{content.offer.method}</dt><dd>{content.offer.methodValue}</dd></div>
                    </dl>
                  </div>
                )}
              </section>
            ))}
          </article>
        </div>
      </main>
      <footer className="legal-document-footer">© {new Date().getFullYear()} {AUTO_RENEW_OFFER.merchantLegalName || "SomniQ Studio"}</footer>
    </div>
  );
}
