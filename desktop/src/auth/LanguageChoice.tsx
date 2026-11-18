import { useState, type CSSProperties } from "react";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { SvgIcon } from "../SvgIcon";
import { LANGUAGE_OPTIONS, languageLocale, useStore, type Language, type Theme } from "../store";
import { DreamScene, LoginBackdrop } from "./LoginScene";
import { LOGIN_COPY } from "./i18n";
import "./login.css";

type FieldVar = CSSProperties & { "--i"?: number };
const field = (i: number) => ({ "--i": i } as FieldVar);

const COPY: Record<Language, {
  welcome: string; title: string; intro: string; language: string; appearance: string;
  light: string; dark: string; start: string; footnote: string;
}> = {
  cn: {
    welcome: "欢迎", title: "设置工作区", intro: "选择界面语言与外观主题", language: "语言", appearance: "主题",
    light: "浅色", dark: "深色", start: "开始使用", footnote: "稍后可在设置中更改",
  },
  en: {
    welcome: "Welcome", title: "Set up your workspace", intro: "Choose your language and appearance.", language: "Language",
    appearance: "Appearance", light: "Light", dark: "Dark", start: "Get started",
    footnote: "You can change these choices later in Settings.",
  },
  es: {
    welcome: "Bienvenido", title: "Configura tu espacio de trabajo", intro: "Elige el idioma y la apariencia.", language: "Idioma",
    appearance: "Apariencia", light: "Claro", dark: "Oscuro", start: "Empezar",
    footnote: "Puedes cambiar estas opciones más tarde en Ajustes.",
  },
};

export default function LanguageChoice() {
  const setLanguage = useStore((state) => state.setLanguage);
  const setTheme = useStore((state) => state.setTheme);
  // Selections stay local until the user confirms. Writing them straight to the
  // store would set the preference flags, and this screen is gated on those --
  // clicking the second choice would drop the user into the workspace mid-setup.
  // The current defaults start out selected so the confirm button is never dead.
  const [language, chooseLanguage] = useState<Language>(() => useStore.getState().language);
  const [theme, chooseTheme] = useState<Theme>(() => useStore.getState().theme);

  const copy = COPY[language];

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
            <div className="sq-tagline-main">{LOGIN_COPY[language].taglineMain}</div>
            <div className="sq-tagline-sub">{LOGIN_COPY[language].taglineSub}</div>
          </div>
        </div>

        <section className="sq-card sq-language-card sq-first-run-card" aria-labelledby="sq-language-title">
          <div className="sq-brand sq-field" style={field(0)}>
            <img src={appLogo} alt="SomniQ" className="sq-logo" />
            <div>
              <div className="sq-brand-name">SomniQ Studio</div>
              <div className="sq-brand-sub">{copy.welcome}</div>
            </div>
          </div>

          <div className="sq-language-intro sq-field" style={field(1)}>
            <h1 id="sq-language-title">{copy.title}</h1>
            <p>{copy.intro}</p>
          </div>

          <div className="sq-first-run-choices sq-field" style={field(2)}>
            <div className="sq-choice-group">
              <div className="sq-choice-label">{copy.language}</div>
              <div className="sq-language-options" role="radiogroup" aria-label={copy.language}>
                {LANGUAGE_OPTIONS.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={language === option.value}
                    className={`sq-language-option${language === option.value ? " active" : ""}`}
                    autoFocus={index === 0}
                    onClick={() => chooseLanguage(option.value)}
                  >
                    <span className="sq-language-option-name" lang={languageLocale(option.value)}>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="sq-choice-group">
              <div className="sq-choice-label">{copy.appearance}</div>
              <div className="sq-theme-options" role="radiogroup" aria-label={copy.appearance}>
                {[
                  { value: "light" as const, label: copy.light, icon: "sun" as const },
                  { value: "dark" as const, label: copy.dark, icon: "moon" as const },
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
            <span lang={languageLocale(language)}>{copy.start}</span>
          </button>

          <p className="sq-language-footnote sq-field" style={field(4)}>
            {copy.footnote}
          </p>
        </section>
      </div>
    </div>
  );
}
