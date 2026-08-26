import type { Copy } from "../i18n";
import { RELEASES_URL, APP_VERSION } from "../i18n";

type Props = { copy: Copy; hideCta?: boolean };

export default function Footer({ copy, hideCta = false }: Props) {
  const isZh = copy.htmlLang === "zh-CN";
  const isEs = copy.htmlLang === "es";

  const pricingHref = isZh ? "./pricing.html?lang=zh" : isEs ? "./pricing.html?lang=es" : "./pricing.html?lang=en";

  return (
    <footer className="footer">
      <div className="container">
        {/* Pre-Footer Action Banner */}
        {!hideCta && (
          <div className="footer-cta-card" data-reveal>
            <div className="footer-cta-content">
              <div className="footer-cta-badge">
                <span className="footer-cta-dot" />
                <span>{isZh ? "开启未来科研体验 · LOCAL-FIRST AUTONOMOUS RESEARCH" : isEs ? "INVESTIGACIÓN AUTÓNOMA LOCAL-FIRST" : "NEXT-GEN RESEARCH WORKFLOW"}</span>
              </div>
              <h2>{isZh ? "梦中求索，醒时有获" : isEs ? "Busca en sueños, cosecha al despertar" : "Seek in Dreams, harvest on waking"}</h2>
              <p>
                {isZh
                  ? "内置 DeepSeek、MiniMax、GPT 等顶尖科研大模型算力包，16 步独立审查，所有数据 100% 保存在本机磁盘。"
                  : isEs
                  ? "Equipado con modelos DeepSeek, MiniMax y GPT, bucle de revisión en 16 pasos y privacidad 100% local."
                  : "Equipped with DeepSeek, MiniMax, GPT models, 16-step reviewer loop, and 100% local data privacy."}
              </p>
            </div>

            <div className="footer-cta-actions">
              <a href={RELEASES_URL} className="btn btn--primary footer-cta-btn" target="_blank" rel="noreferrer noopener">
                <span>{isZh ? `立即下载 Windows 版 (v${APP_VERSION})` : isEs ? `Descargar para Windows (v${APP_VERSION})` : `Download for Windows (v${APP_VERSION})`}</span>
                <span className="btn-arrow" aria-hidden="true">→</span>
              </a>
              <a href={pricingHref} className="btn btn--ghost footer-cta-btn">
                <span>{isZh ? "查看订阅方案 (¥79/月)" : isEs ? "Ver Planes de Suscripción" : "View Pricing & Plans"}</span>
              </a>
            </div>
          </div>
        )}

        {/* Multi-Column Main Footer Links */}
        <div className="footer-grid">
          {/* Col 1: Brand & Philosophy */}
          <div className="footer-col footer-col--brand">
            <div className="footer-brand-title">
              <img src="./app-logo.png" alt="SomniQ Logo" width={32} height={32} />
              <strong>{copy.nav.brand}</strong>
            </div>
            <p className="footer-brand-tagline">{copy.footer.tagline}</p>
            <div className="footer-status-pill">
              <span className="footer-status-dot" />
              <span>{isZh ? "本地优先 · 隐私数据绝不上云" : isEs ? "Local-First · Privacidad Absoluta" : "Local-First · Zero Cloud Leakage"}</span>
            </div>
            <p className="footer-built-note">
              {isZh ? "基于 Tauri 2.0 + Rust 高性能内核构建" : isEs ? "Construido con Tauri 2.0 y motor Rust de alto rendimiento" : "Built on Tauri 2.0 + Rust Engine"}
            </p>
          </div>

          {/* Col 2: Core Features */}
          <div className="footer-col">
            <h4>{isZh ? "核心特性" : isEs ? "Características" : "Features"}</h4>
            <ul>
              <li><a href="#does">{isZh ? "自主研究链路 (Executor)" : isEs ? "Flujo Autónomo (Executor)" : "Autonomous Pipeline"}</a></li>
              <li><a href="#review">{isZh ? "16 步独立审查 (Reviewer Loop)" : isEs ? "Auditoría en 16 Pasos (Reviewer)" : "16-Stage Review Loop"}</a></li>
              <li><a href="#benchmark">{isZh ? "PseudoBench 评测基准" : isEs ? "Evaluación PseudoBench" : "PseudoBench Benchmark"}</a></li>
              <li><a href="#memory">{isZh ? "三层长效科研记忆" : isEs ? "Memoria Científica en 3 Niveles" : "3-Tier Research Memory"}</a></li>
            </ul>
          </div>

          {/* Col 3: Compute & Models */}
          <div className="footer-col">
            <h4>{isZh ? "内置模型与算力" : isEs ? "Modelos y Cómputo" : "Models & Compute"}</h4>
            <ul>
              <li><span>{isZh ? "DeepSeek V4Flash (推理与生成)" : isEs ? "DeepSeek V4Flash (Razonamiento y Código)" : "DeepSeek V4Flash (Reasoning & Generation)"}</span></li>
              <li><span>{isZh ? "MiniMax-V3 (海量文献理解)" : isEs ? "MiniMax-V3 (Comprensión de Literatura)" : "MiniMax-V3 (Literature Comprehension)"}</span></li>
              <li><span>{isZh ? "Codex · GPT (方法与逻辑把关)" : isEs ? "Codex · GPT (Auditoría Rigurosa)" : "Codex · GPT (Independent Audit)"}</span></li>
              <li>
                <a href={pricingHref} className="footer-link-highlight">
                  {isZh ? "专业版订阅 (¥79/月 含额度)" : isEs ? "Plan Pro (Suscripción con Cómputo)" : "Pro Plan (Subscription & Credits)"}
                </a>
              </li>
            </ul>
          </div>

          {/* Col 4: Downloads & Support */}
          <div className="footer-col">
            <h4>{isZh ? "下载与支持" : isEs ? "Descargas y Soporte" : "Downloads & Support"}</h4>
            <ul>
              <li><a href={RELEASES_URL} target="_blank" rel="noreferrer noopener">{isZh ? "最新安装包下载" : isEs ? "Descargar Aplicación" : "Download App"}</a></li>
              <li><a href={pricingHref}>{isZh ? "订阅方案与算力" : isEs ? "Planes y Suscripción" : "Pricing & Plans"}</a></li>
              <li><a href="#does">{isZh ? "功能特性概览" : isEs ? "Resumen de Funcionalidades" : "Features Overview"}</a></li>
              <li><a href="#review">{isZh ? "16 步独立审查流程" : isEs ? "Proceso de Auditoría en 16 Pasos" : "16-Step Review Loop"}</a></li>
            </ul>
          </div>
        </div>

        {/* Footer Bottom Bar */}
        <div className="footer-bottom-bar">
          <p className="footer-copy-text">
            © {new Date().getFullYear()} SomniQ Studio · {copy.footer.license}
          </p>
          <div className="footer-bottom-badges">
            <span className="footer-platform-badge">Windows x64</span>
            <span className="footer-platform-badge">Local-First</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
