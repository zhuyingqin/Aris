import type { CSSProperties } from "react";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { useStore, type Language } from "../store";
import { DreamScene, LoginBackdrop } from "./LoginScene";
import "./login.css";

type FieldVar = CSSProperties & { "--i"?: number };
const field = (i: number) => ({ "--i": i } as FieldVar);

export default function LanguageChoice() {
  const setLanguage = useStore((state) => state.setLanguage);
  const choose = (language: Language) => setLanguage(language);

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

        <section className="sq-card sq-language-card" aria-labelledby="sq-language-title">
          <div className="sq-brand sq-field" style={field(0)}>
            <img src={appLogo} alt="SomniQ" className="sq-logo" />
            <div>
              <div className="sq-brand-name">SomniQ Studio</div>
              <div className="sq-brand-sub">Welcome</div>
            </div>
          </div>

          <div className="sq-language-intro sq-field" style={field(1)}>
            <h1 id="sq-language-title">Choose your language</h1>
            <p>Select the language you want to use in SomniQ.</p>
            <p lang="zh-CN">选择你希望在 SomniQ 中使用的语言。</p>
          </div>

          <div className="sq-language-options sq-field" style={field(2)} aria-label="Language / 语言">
            <button type="button" className="sq-language-option" autoFocus onClick={() => choose("en")}>
              <span className="sq-language-option-name">English</span>
              <span className="sq-language-option-detail">Continue in English</span>
            </button>
            <button type="button" className="sq-language-option" onClick={() => choose("cn")}>
              <span className="sq-language-option-name" lang="zh-CN">简体中文</span>
              <span className="sq-language-option-detail" lang="zh-CN">使用中文继续</span>
            </button>
          </div>

          <p className="sq-language-footnote sq-field" style={field(3)}>
            You can change this later in Settings. <span lang="zh-CN">稍后可在设置中更改。</span>
          </p>
        </section>
      </div>
    </div>
  );
}
