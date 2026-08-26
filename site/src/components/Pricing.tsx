import { useCallback } from "react";
import type { Copy } from "../i18n";
import { RELEASES_URL } from "../i18n";
import Section from "./Section";
import { ArrowIcon, CheckIcon, DeepSeekLogo, MiniMaxLogo, OpenAILogo, SparklesIcon, WindowsIcon } from "./icons";
import { useAuth } from "../context/AuthContext";

type Props = {
  copy: Copy;
};

export default function Pricing({ copy }: Props) {
  const { pricing } = copy;
  const { user, formatTokens: authFormatTokens } = useAuth();
  const isZh = copy.htmlLang === "zh-CN";
  const isEs = copy.htmlLang === "es";

  const formatTokens = useCallback(
    (quota: number, customUnit?: string) =>
      authFormatTokens(quota, customUnit ?? (isZh ? " 词元" : " Tokens")),
    [authFormatTokens, isZh]
  );

  const isPro = user ? user.role >= 10 || user.group === "vip" || user.group === "千研" || ((user.quota ?? 0) > 0) : false;
  const hasActivePlan = isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研";
  const remaining = user?.quota || 0;
  const used = user?.used_quota || 0;
  const usdValue = (remaining / 500000).toFixed(2);

  const renderLogo = (id: string) => {
    if (id === "gpt") return <OpenAILogo width={24} height={24} className="model-logo-svg model-logo-svg--openai" />;
    if (id === "minimax") return <MiniMaxLogo width={24} height={24} className="model-logo-svg model-logo-svg--minimax" />;
    return <DeepSeekLogo width={24} height={24} className="model-logo-svg model-logo-svg--deepseek" />;
  };

  return (
    <Section
      id="pricing"
      kicker={pricing.kicker}
      title={pricing.title}
      lede={pricing.lede}
      align="center"
      tone="raised"
    >
      {/* ── 1. Model Quota & Market Comparison Table ── */}
      <div className="pricing-table-section" data-reveal>
        <div className="pricing-models-head">
          <div className="pricing-models-title-wrap">
            <span className="pricing-models-badge">
              <SparklesIcon width={14} height={14} />
              {pricing.comparisonTitle}
            </span>
            <p className="pricing-models-subtitle">{pricing.comparisonSubtitle}</p>
          </div>
          <div className="pricing-savings-pill">
            <span>{pricing.saveBadge}</span>
          </div>
        </div>

        <div className="pricing-table-container">
          <table className="pricing-comparison-table">
            <thead>
              <tr>
                <th scope="col" className="col-model">{pricing.tableColumns.model}</th>
                <th scope="col" className="col-rates">{pricing.tableColumns.rates}</th>
                <th scope="col" className="col-quota-tokens">{pricing.tableColumns.quotaTokens}</th>
                <th scope="col" className="col-usage">{pricing.tableColumns.estimatedUsage}</th>
              </tr>
            </thead>
            <tbody>
              {pricing.tableRows.map((row) => (
                <tr key={row.id} className={`pricing-table-row pricing-table-row--${row.brandColor}`}>
                  <td className="cell-model">
                    <div className="table-model-box">
                      <span className={`table-model-icon table-model-icon--${row.brandColor}`}>
                        {renderLogo(row.id)}
                      </span>
                      <div>
                        <strong className="table-model-name">{row.name}</strong>
                        <span className="table-model-role">{row.roleTag}</span>
                      </div>
                    </div>
                  </td>
                  <td className="cell-rates">
                    <div className="table-rates-list">
                      {row.rates.map((rate, idx) => (
                        <div key={idx} className="table-rate-item">
                          <span className="table-rate-label">{rate.item}</span>
                          <strong className="table-rate-price">{rate.price}</strong>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="cell-quota-tokens">
                    <div className="table-quota-tokens-box">
                      <strong className="table-tokens-val">{row.quotaTokens}</strong>
                      <span className="table-multiplier-badge">{row.multiplierBadge}</span>
                    </div>
                  </td>
                  <td className="cell-usage">
                    <span className="table-usage-text">{row.estimatedUsage}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="pricing-table-footnote">{pricing.tableFooterNote}</p>
      </div>

      {/* ── 2. Pro Subscription Card & Actions ── */}
      <div className="pricing-plan-wrapper" data-reveal style={{ marginTop: "36px" }}>
        {hasActivePlan ? (
          /* Active User Subscription Card */
          <article className="pricing-plan" aria-label={isZh ? "当前已生效订阅" : isEs ? "Suscripción Activa" : "Active Subscription"}>
            <div className="pricing-plan-head">
              <div>
                <p className="pricing-plan-name">
                  {user?.group === "千研"
                    ? isZh
                      ? "千研科研 Pro 会员"
                      : isEs
                      ? "Membresía Pro Mil Investigaciones"
                      : "Thousand Research Pro"
                    : isZh
                    ? "SomniQ 科研专业版"
                    : isEs
                    ? "SomniQ Nivel Pro"
                    : "SomniQ Pro Tier"}
                </p>
                <p style={{ color: "var(--cyan)", fontSize: "13px" }}>
                  {isZh
                    ? `已绑定 new-api 分组: ${user?.group || "千研"}`
                    : isEs
                    ? `Grupo new-api vinculado: ${user?.group || "千研"}`
                    : `Active new-api Group: ${user?.group || "千研"}`}
                </p>
              </div>
              <span className="pricing-plan-badge" style={{ background: "#10b981", color: "#000" }}>
                {isZh ? "● 履约中" : isEs ? "● Activo" : "● Active"}
              </span>
            </div>

            <div className="pricing-price" style={{ flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <strong style={{ fontSize: "36px" }}>{formatTokens(remaining)}</strong>
                <span style={{ fontSize: "14px", color: "var(--text-faint)" }}>≈ ${usdValue} USD</span>
              </div>
              <span style={{ fontSize: "13px", color: "var(--text-dim)" }}>
                {isZh
                  ? `累计已消耗: ${formatTokens(used)}`
                  : isEs
                  ? `Consumo acumulado: ${formatTokens(used)}`
                  : `Total Used: ${formatTokens(used)}`}
              </span>
            </div>

            <div className="pricing-actions" style={{ gap: "12px", marginTop: "24px" }}>
              <a className="btn btn--primary" href={`./dashboard.html?lang=${copy.htmlLang === "zh-CN" ? "zh" : copy.htmlLang === "es" ? "es" : "en"}`}>
                <CheckIcon width={16} height={16} />
                {isZh ? "进入控制台管理算力" : isEs ? "Ir a la Consola de Cómputo" : "Go to Dashboard"}
                <ArrowIcon className="btn-arrow" width={16} height={16} />
              </a>
              <a className="btn btn--outline" href="./remote/" target="_blank" rel="noreferrer noopener">
                {isZh ? "打开手机远程工作台" : isEs ? "Abrir PWA Remota Móvil" : "Launch Remote PWA"}
              </a>
            </div>
          </article>
        ) : (
          /* Standard Pro Subscription Plan */
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
              <span className="pricing-plan-savings-tag">{pricing.saveBadge}</span>
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
              <a className="btn btn--primary btn--lg" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
                <WindowsIcon width={18} height={18} />
                {pricing.cta}
                <ArrowIcon className="btn-arrow" width={18} height={18} />
              </a>
            </div>
          </article>
        )}
      </div>
    </Section>
  );
}
