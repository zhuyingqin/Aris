import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  newapiAuthStatus,
  newapiSendVerification,
  openExternalUrl,
  type NewApiAuthStatus,
} from "../api/tauri";
import appLogo from "../assets/app-logo.png";
import DesktopWindowControls from "../DesktopWindowControls";
import { DEFAULT_AUTH_SERVER, useStore } from "../store";
import { DreamScene, LoginBackdrop } from "./LoginScene";
import "./login.css";

// Self-contained sign-in screen shown before the app shell when the user has
// not authenticated to the managed gateway. Renders the SomniQ dreamscape —
// an animated night sky where a sleeping researcher's soul rises to light up
// the logo's knowledge-graph constellation — behind a glass sign-in card.
// Styling lives in login.css (sq- prefixed, night-themed by design).

type FieldVar = CSSProperties & { "--i"?: number };

const field = (i: number) => ({ "--i": i } as FieldVar);

type AuthMode = "login" | "register";
const MANAGED_MODEL_SERVER_LABEL = "通用模型服务器";

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

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:https?:\/\/)?106\.53\.28\.124:18080(?:\/v1)?/gi, MANAGED_MODEL_SERVER_LABEL);
}

export default function Login() {
  const login = useStore((s) => s.login);
  const register = useStore((s) => s.register);
  const storedServer = useStore((s) => s.authServer);
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
            setStatusError(`无法读取服务器注册配置：${errorMessage(err)}`);
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
  }, [resolvedServer]);

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
        ["login", "登录"],
        ["register", "注册"],
      ]
    : [["login", "登录"]];

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
      setError("请先输入邮箱");
      return;
    }
    if (turnstileRequired) {
      setError("当前服务器开启了人机验证，请先在网页端完成注册");
      return;
    }
    setCodeBusy(true);
    try {
      await newapiSendVerification({
        baseUrl: resolvedServer,
        email: email.trim(),
      });
      setNotice("验证码已发送，请检查邮箱");
      setCodeCooldown(30);
    } catch (err) {
      setError(errorMessage(err));
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
          throw new Error("正在读取服务器注册配置，请稍后");
        }
        if (!registerSupported) {
          throw new Error("当前服务器未开放账号密码注册");
        }
        if (turnstileRequired) {
          throw new Error("当前服务器开启了人机验证，请先在网页端完成注册");
        }
        if (password !== confirmPassword) {
          throw new Error("两次输入的密码不一致");
        }
        if (password.length < 8 || password.length > 20) {
          throw new Error("密码长度需要为 8-20 位");
        }
        if (legalRequired && !legalAccepted) {
          throw new Error("请先同意相关条款");
        }
        if (needsEmailVerification) {
          if (!email.trim()) throw new Error("请输入邮箱");
          if (!verificationCode.trim()) throw new Error("请输入验证码");
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
        setNotice("注册成功，请登录");
      } else {
        if (!passwordLoginEnabled) {
          throw new Error("当前服务器未开放账号密码登录");
        }
        await login(resolvedServer, username.trim(), password);
      }
    } catch (err) {
      setError(errorMessage(err));
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
            <div className="sq-tagline-main">睡梦中科研 · 灵感出鞘</div>
            <div className="sq-tagline-sub">RESEARCH NEVER SLEEPS — IT DREAMS.</div>
          </div>
        </div>

        <form className="sq-card" onSubmit={onSubmit}>
          <div className="sq-brand sq-field" style={field(0)}>
            <img src={appLogo} alt="SomniQ" className="sq-logo" />
            <div>
              <div className="sq-brand-name">SomniQ Studio</div>
              <div className="sq-brand-sub">
                {mode === "register" ? "创建 New API 账号" : "登录以继续"}
              </div>
            </div>
          </div>

          <div
            className="sq-tabs sq-field"
            style={{ ...field(1), gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
            role="tablist"
            aria-label="认证方式"
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
            <div className="sq-label">账号</div>
            <input
              className="sq-input"
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="用户名"
            />
          </div>

          <div className="sq-field" style={field(3)}>
            <div className="sq-label">密码</div>
            <input
              className="sq-input"
              type="password"
              value={password}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "8-20 位密码" : "密码"}
            />
          </div>

          {mode === "register" && (
            <>
              <div className="sq-field" style={field(0)}>
                <div className="sq-label">确认密码</div>
                <input
                  className="sq-input"
                  type="password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                />
              </div>

              {needsEmailVerification && (
                <>
                  <div className="sq-field" style={field(1)}>
                    <div className="sq-label">邮箱</div>
                    <input
                      className="sq-input"
                      type="email"
                      value={email}
                      autoComplete="email"
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                    />
                  </div>

                  <div className="sq-field" style={field(2)}>
                    <div className="sq-label">验证码</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="sq-input"
                        value={verificationCode}
                        autoComplete="one-time-code"
                        spellCheck={false}
                        onChange={(e) => setVerificationCode(e.target.value)}
                        placeholder="邮箱验证码"
                      />
                      <button
                        type="button"
                        className="sq-btn-secondary"
                        onClick={sendVerificationCode}
                        disabled={codeBusy || codeCooldown > 0 || !email.trim() || turnstileRequired}
                      >
                        {codeCooldown > 0 ? `${codeCooldown}s` : codeBusy ? "发送中" : "发送"}
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
                  我已阅读并同意服务条款和隐私政策
                </label>
              )}

              {turnstileRequired && (
                <div role="alert" className="sq-alert sq-alert-warn">
                  当前服务器开启了人机验证，请在网页端注册后返回登录。
                  <button
                    type="button"
                    className="sq-linkbtn"
                    onClick={() => void openExternalUrl(`${resolvedServer}/sign-up`)}
                  >
                    打开网页注册
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

          <button type="submit" className="sq-btn sq-field" style={field(4)} disabled={submitDisabled}>
            {busy ? (mode === "register" ? "注册中..." : "登录中...") : mode === "register" ? "创建账号" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
