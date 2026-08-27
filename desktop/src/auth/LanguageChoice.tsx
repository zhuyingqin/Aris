import type { CSSProperties } from "react";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { SvgIcon } from "../SvgIcon";
import { useStore, type Language, type Theme } from "../store";
import { DreamScene, LoginBackdrop } from "./LoginScene";
import "./login.css";

type FieldVar = CSSProperties & { "--i"?: number };
const field = (i: number) => ({ "--i": i } as FieldVar);

export default function LanguageChoice() {
  const setLanguage = useStore((state) => state.setLanguage);
  const language = useStore((state) => state.language);
  const theme = useStore((state) => state.theme);
  const themePreferenceSet = useStore((state) => state.themePreferenceSet);
  const setTheme = useStore((state) => state.setTheme);
  const chooseLanguage = (next: Language) => setLanguage(next);
  const chooseTheme = (next: Theme) => setTheme(next);

  return (
    <div className="sq-login-root">
      <LoginBackdrop />
      <DesktopWindowControls />
      <div className="sq-login-columns">
        <div className="sq-login-hero" aria-hidden="true">
          <DreamScene />
          <div className="sq-tagline">
            <div className="sq-tagline-main">Seek in Dreams, harvest on waking</div>
            <div className="sq-tagline-sub">SEEK IN DREAMS, HARVEST ON WAKING.</div>
          </div>
        </div>

        <section className="sq-card sq-language-card sq-first-run-card" aria-labelledby="sq-language-title">
          <div className="sq-brand sq-field" style={field(0)}>
            <img src={appLogo} alt="SomniQ" className="sq-logo" />
            <div>
              <div className="sq-brand-name">SomniQ Studio</div>
              <div className="sq-brand-sub">Welcome</div>
            </div>
          </div>

          <div className="sq-language-intro sq-field" style={field(1)}>
            <h1 id="sq-language-title">Set up your workspace</h1>
            <p>Choose your language and appearance before you begin.</p>
            <p lang="zh-CN">开始使用前，选择界面语言和主题。</p>
          </div>

          <div className="sq-first-run-choices sq-field" style={field(2)}>
            <div className="sq-choice-group">
              <div className="sq-choice-label">Language / 语言</div>
              <div className="sq-language-options" role="radiogroup" aria-label="Language / 语言">
                <button
                  type="button"
                  role="radio"
                  aria-checked={language === "en"}
                  className={`sq-language-option${language === "en" ? " active" : ""}`}
                  autoFocus
                  onClick={() => chooseLanguage("en")}
                >
                  <span className="sq-language-option-name">English</span>
                  <span className="sq-language-option-detail">Continue in English</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={language === "cn"}
                  className={`sq-language-option${language === "cn" ? " active" : ""}`}
                  onClick={() => chooseLanguage("cn")}
                >
                  <span className="sq-language-option-name" lang="zh-CN">简体中文</span>
                  <span className="sq-language-option-detail" lang="zh-CN">使用中文继续</span>
                </button>
              </div>
            </div>

            <div className="sq-choice-group">
              <div className="sq-choice-label">Appearance / 界面主题</div>
              <div className="sq-theme-options" role="radiogroup" aria-label="Appearance / 界面主题">
                {[
                  { value: "light" as const, label: "Light", detail: "Bright workspace", icon: "sun" as const },
                  { value: "dark" as const, label: "Dark", detail: "Low-light workspace", icon: "moon" as const },
                ].map((option) => {
                  const active = themePreferenceSet && theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`sq-theme-option${active ? " active" : ""}`}
                      data-theme-option={option.value}
                      onClick={() => chooseTheme(option.value)}
                    >
                      <SvgIcon name={option.icon} size={17} />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.detail}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <p className="sq-language-footnote sq-field" style={field(3)}>
            You can change these choices later in Settings. You can start right after sign-in — no API key setup is needed.
            <span lang="zh-CN">稍后可在设置中更改。登录后即可开始，无需额外设置 API Key。</span>
          </p>
        </section>
      </div>
    </div>
  );
}
