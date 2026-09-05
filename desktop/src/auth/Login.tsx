import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  newapiAuthStatus,
  newapiSendVerification,
  openExternalUrl,
  type NewApiAuthStatus,
} from "../api/tauri";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { DEFAULT_AUTH_SERVER, useStore, type Language } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { DreamScene, LoginBackdrop } from "./LoginScene";
import { LOGIN_COPY } from "./i18n";
import "./login.css";

// Self-contained sign-in screen shown before the app shell when the user has
// not authenticated to the managed gateway. Renders the SomniQ dreamscape —
// an animated night sky where a sleeping researcher's soul rises to light up
// the logo's knowledge-graph constellation — behind a glass sign-in card.
// Styling lives in login.css (sq- prefixed, night-themed by design).

type FieldVar = CSSProperties & { "--i"?: number };

const field = (i: number) => ({ "--i": i } as FieldVar);

type AuthMode = "login" | "register";
function trimServer(server: string) {
  return (server.trim() || DEFAULT_AUTH_SERVER).replace(/\/+$/, "");
}

function readAffCode(): string | undefined {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get("aff")?.trim();
    if (fromSearch) {
      localStorage.setItem("aff", fromSearch);
      return fromSearch;
    }
    return localStorage.getItem("aff")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown, language: Language) {
  return formatUserFacingError(error, language);
}

export default function Login() {
  const login = useStore((s) => s.login);
  const register = useStore((s) => s.register);
  const storedServer = useStore((s) => s.authServer);
  const language = useStore((s) => s.language);
  const copy = LOGIN_COPY[language];
  const [mode, setMode] = useState<AuthMode>("login");
  const resolvedServer = useMemo(() => trimServer(storedServer), [storedServer]);
  const [authStatus, setAuthStatus] = useState<NewApiAuthStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [affCode] = useState(readAffCode);

  useEffect(() => {
    let cancelled = false;
    setStatusBusy(true);
    setStatusError(null);
    const timer = window.setTimeout(() => {
      newapiAuthStatus(resolvedServer)
        .then((status) => {
          if (!cancelled) setAuthStatus(status);
        })
        .catch((err) => {
          if (!cancelled) {
            setAuthStatus(null);
            setStatusError(copy.fetchStatusFailed(errorMessage(err, language)));
          }
        })
        .finally(() => {
          if (!cancelled) setStatusBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolvedServer, copy, language]);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setTimeout(() => setCodeCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCooldown]);

  const registerSupported = Boolean(authStatus?.registerEnabled && authStatus.passwordRegisterEnabled);
  const showRegisterTab = authStatus ? registerSupported : true;
  const passwordLoginEnabled = authStatus?.passwordLoginEnabled ?? true;
  const needsEmailVerification = Boolean(authStatus?.emailVerification);
  const turnstileRequired = Boolean(authStatus?.turnstileCheck);
  const legalRequired = Boolean(authStatus?.userAgreementEnabled || authStatus?.privacyPolicyEnabled);
  const tabs: Array<[AuthMode, string]> = showRegisterTab
    ? [
        ["login", copy.tabLogin],
        ["register", copy.tabRegister],
      ]
    : [["login", copy.tabLogin]];

  useEffect(() => {
    if (authStatus && !registerSupported && mode === "register") {
      setMode("login");
      setError(null);
    }
  }, [authStatus, mode, registerSupported]);

  const submitDisabled =
    busy ||
    statusBusy ||
    (mode === "login" && !passwordLoginEnabled) ||
    (mode === "register" &&
      (!authStatus || !registerSupported || turnstileRequired || (legalRequired && !legalAccepted)));
  const sendVerificationCode = async () => {
    if (codeBusy || codeCooldown > 0) return;
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError(copy.errorEmailRequired);
      return;
    }
    if (turnstileRequired) {
      setError(copy.errorTurnstileRequired);
      return;
    }
    setCodeBusy(true);
    try {
      await newapiSendVerification({
        baseUrl: resolvedServer,
        email: email.trim(),
      });
      setNotice(copy.noticeCodeSent);
      setCodeCooldown(30);
    } catch (err) {
      setError(errorMessage(err, language));
    } finally {
      setCodeBusy(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "register") {
        if (!authStatus) {
          throw new Error(copy.errorStatusLoading);
        }
        if (!registerSupported) {
          throw new Error(copy.errorRegisterNotSupported);
        }
        if (turnstileRequired) {
          throw new Error(copy.errorTurnstileRequired);
        }
        if (password !== confirmPassword) {
          throw new Error(copy.errorPasswordMismatch);
        }
        if (password.length < 8 || password.length > 20) {
          throw new Error(copy.errorPasswordLength);
        }
        if (legalRequired && !legalAccepted) {
          throw new Error(copy.errorLegalRequired);
        }
        if (needsEmailVerification) {
          if (!email.trim()) throw new Error(copy.errorEmailRequiredShort);
          if (!verificationCode.trim()) throw new Error(copy.errorVerificationCodeRequired);
        }
        await register(resolvedServer, username.trim(), password, {
          email: needsEmailVerification ? email.trim() : undefined,
          verificationCode: needsEmailVerification ? verificationCode.trim() : undefined,
          affCode,
        });
        setMode("login");
        setPassword("");
        setConfirmPassword("");
        setVerificationCode("");
        setNotice(copy.noticeRegisterSuccess);
      } else {
        if (!passwordLoginEnabled) {
          throw new Error(copy.errorPasswordLoginNotSupported);
        }
        await login(resolvedServer, username.trim(), password);
      }
    } catch (err) {
      setError(errorMessage(err, language));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sq-login-root">
      <LoginBackdrop />
      <DesktopWindowControls />
      <div className="sq-login-columns">
        <div className="sq-login-hero" aria-hidden="true">
          <DreamScene />
          <div className="sq-tagline">
            <div className="sq-tagline-main">{copy.taglineMain}</div>
            <div className="sq-tagline-sub">{copy.taglineSub}</div>
          </div>
        </div>

        <form className="sq-card" onSubmit={onSubmit}>
          <div className="sq-brand sq-field" style={field(0)}>
            <img src={appLogo} alt="SomniQ" className="sq-logo" />
            <div>
              <div className="sq-brand-name">SomniQ Studio</div>
              <div className="sq-brand-sub">
                {mode === "register" ? copy.brandSubRegister : copy.brandSubLogin}
              </div>
            </div>
          </div>

          <div
            className="sq-tabs sq-field"
            style={{ ...field(1), gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
            role="tablist"
            aria-label={copy.authMethodAriaLabel}
          >
            {tabs.map(([value, text]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => {
                  setMode(value);
                  setError(null);
                  setNotice(null);
                }}
                className={mode === value ? "sq-tab active" : "sq-tab"}
              >
                {text}
              </button>
            ))}
          </div>

          <div className="sq-field" style={field(2)}>
            <div className="sq-label">{copy.accountLabel}</div>
            <input
              className="sq-input"
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              placeholder={copy.usernamePlaceholder}
            />
          </div>

          <div className="sq-field" style={field(3)}>
            <div className="sq-label">{copy.passwordLabel}</div>
            <input
              className="sq-input"
              type="password"
              value={password}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? copy.passwordPlaceholderRegister : copy.passwordPlaceholderLogin}
            />
          </div>

          {mode === "register" && (
            <>
              <div className="sq-field" style={field(0)}>
                <div className="sq-label">{copy.confirmPasswordLabel}</div>
                <input
                  className="sq-input"
                  type="password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={copy.confirmPasswordPlaceholder}
                />
              </div>

              {needsEmailVerification && (
                <>
                  <div className="sq-field" style={field(1)}>
                    <div className="sq-label">{copy.emailLabel}</div>
                    <input
                      className="sq-input"
                      type="email"
                      value={email}
                      autoComplete="email"
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={copy.emailPlaceholder}
                    />
                  </div>

                  <div className="sq-field" style={field(2)}>
                    <div className="sq-label">{copy.verificationCodeLabel}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="sq-input"
                        value={verificationCode}
                        autoComplete="one-time-code"
                        spellCheck={false}
                        onChange={(e) => setVerificationCode(e.target.value)}
                        placeholder={copy.verificationCodePlaceholder}
                      />
                      <button
                        type="button"
                        className={`sq-btn-secondary${codeBusy ? " sq-btn-secondary-busy" : ""}`}
                        onClick={sendVerificationCode}
                        disabled={codeBusy || codeCooldown > 0 || !email.trim() || turnstileRequired}
                      >
                        {codeBusy && (
                          <svg className="sq-btn-spinner sq-btn-spinner-sm" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <circle className="sq-btn-spinner-track" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
                            <path className="sq-btn-spinner-head" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                          </svg>
                        )}
                        <span>
                          {codeCooldown > 0 ? copy.sendCodeCooldown(codeCooldown) : codeBusy ? copy.sendingCode : copy.sendCode}
                        </span>
                      </button>
                    </div>
                  </div>
                </>
              )}

              {legalRequired && (
                <label className="sq-legal sq-field" style={field(3)}>
                  <input
                    type="checkbox"
                    checked={legalAccepted}
                    onChange={(e) => setLegalAccepted(e.target.checked)}
                  />
                  {copy.legalAgreement}
                </label>
              )}

              {turnstileRequired && (
                <div role="alert" className="sq-alert sq-alert-warn">
                  {copy.turnstileNotice}
                  <button
                    type="button"
                    className="sq-linkbtn"
                    onClick={() => void openExternalUrl(`${resolvedServer}/sign-up`)}
                  >
                    {copy.openWebRegister}
                  </button>
                </div>
              )}
            </>
          )}

          {statusError && mode === "register" && (
            <div role="alert" className="sq-alert sq-alert-warn">
              {statusError}
            </div>
          )}

          {notice && (
            <div role="status" className="sq-alert sq-alert-ok">
              {notice}
            </div>
          )}

          {error && (
            <div role="alert" className="sq-alert sq-alert-err">
              {error}
            </div>
          )}

          <button
            type="submit"
            className={`sq-btn sq-field${busy ? " sq-btn-busy" : ""}`}
            style={field(4)}
            disabled={submitDisabled}
          >
            {busy && (
              <svg className="sq-btn-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="sq-btn-spinner-track" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
                <path className="sq-btn-spinner-head" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            )}
            <span>
              {busy
                ? mode === "register"
                  ? copy.submitRegistering
                  : copy.submitLoggingIn
                : mode === "register"
                  ? copy.submitRegister
                  : copy.submitLogin}
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}
