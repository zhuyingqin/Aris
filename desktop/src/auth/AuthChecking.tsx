import { useStore } from "../store";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { LoginBackdrop } from "./LoginScene";
import { LOGIN_COPY } from "./i18n";
import "./login.css";

export default function AuthChecking() {
  const language = useStore((state) => state.language);
  const copy = LOGIN_COPY[language] ?? LOGIN_COPY.en;

  return (
    <div className="sq-login-root sq-auth-checking-root">
      <LoginBackdrop />
      <DesktopWindowControls />
      <div className="sq-auth-checking-container">
        <div className="sq-card sq-auth-checking-card" role="status" aria-live="polite">
          <div className="sq-auth-checking-visual" aria-hidden="true">
            <div className="sq-auth-checking-aura" />
            <div className="sq-auth-checking-ring sq-auth-checking-ring-outer" />
            <div className="sq-auth-checking-ring sq-auth-checking-ring-inner" />
            <div className="sq-auth-checking-sat-orbit">
              <div className="sq-auth-checking-sat" />
            </div>
            <img src={appLogo} alt="SomniQ" className="sq-auth-checking-logo" />
          </div>

          <div className="sq-brand-name sq-auth-checking-brand">SomniQ Studio</div>

          <div className="sq-auth-checking-message">
            <svg className="sq-btn-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="sq-btn-spinner-track" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
              <path className="sq-btn-spinner-head" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span>{copy.verifyingAuth}</span>
          </div>

          <div className="sq-auth-checking-sub">{copy.verifyingAuthSub}</div>

          <div className="sq-auth-checking-track" aria-hidden="true">
            <div className="sq-auth-checking-beam" />
          </div>
        </div>
      </div>
    </div>
  );
}
