import { useState, type CSSProperties } from "react";
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
  const setTheme = useStore((state) => state.setTheme);
  // Selections stay local until the user confirms. Writing them straight to the
  // store would set the preference flags, and this screen is gated on those --
  // clicking the second choice would drop the user into the workspace mid-setup.
  // The current defaults start out selected so the confirm button is never dead.
  const [language, chooseLanguage] = useState<Language>(() => useStore.getState().language);
  const [theme, chooseTheme] = useState<Theme>(() => useStore.getState().theme);

  const confirm = () => {
    setLanguage(language);
    setTheme(theme);
  };

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
              <div className="sq-brand-sub">{language === "cn" ? "欢迎" : "Welcome"}</div>
            </div>
          </div>

          <div className="sq-language-intro sq-field" style={field(1)}>
            <h1 id="sq-language-title">{language === "cn" ? "设置工作区" : "Set up your workspace"}</h1>
            <p>{language === "cn" ? "选择界面语言与外观主题" : "Choose your language and appearance."}</p>
          </div>

          <div className="sq-first-run-choices sq-field" style={field(2)}>
            <div className="sq-choice-group">
              <div className="sq-choice-label">{language === "cn" ? "语言" : "Language"}</div>
              <div className="sq-language-options" role="radiogroup" aria-label={language === "cn" ? "语言" : "Language"}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={language === "en"}
                  className={`sq-language-option${language === "en" ? " active" : ""}`}
                  autoFocus
                  onClick={() => chooseLanguage("en")}
                >
                  <span className="sq-language-option-name">English</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={language === "cn"}
                  className={`sq-language-option${language === "cn" ? " active" : ""}`}
                  onClick={() => chooseLanguage("cn")}
                >
                  <span className="sq-language-option-name" lang="zh-CN">简体中文</span>
                </button>
              </div>
            </div>

            <div className="sq-choice-group">
              <div className="sq-choice-label">{language === "cn" ? "主题" : "Appearance"}</div>
              <div className="sq-theme-options" role="radiogroup" aria-label={language === "cn" ? "主题" : "Appearance"}>
                {[
                  { value: "light" as const, label: language === "cn" ? "浅色" : "Light", icon: "sun" as const },
                  { value: "dark" as const, label: language === "cn" ? "深色" : "Dark", icon: "moon" as const },
                ].map((option) => {
                  const active = theme === option.value;
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
                      <strong>{option.label}</strong>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="sq-btn sq-first-run-confirm sq-field"
            style={field(3)}
            onClick={confirm}
          >
            <span lang={language === "cn" ? "zh-CN" : "en"}>{language === "cn" ? "开始使用" : "Get started"}</span>
          </button>

          <p className="sq-language-footnote sq-field" style={field(4)}>
            {language === "cn" ? "稍后可在设置中更改" : "You can change these choices later in Settings."}
          </p>
        </section>
      </div>
    </div>
  );
}
