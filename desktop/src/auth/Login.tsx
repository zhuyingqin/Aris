import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  newapiAuthStatus,
  newapiSendVerification,
  openExternalUrl,
  type NewApiAuthStatus,
} from "../api/tauri";
import appLogo from "../assets/app-logo.png";
import { DEFAULT_AUTH_SERVER, useStore } from "../store";

// Self-contained sign-in screen shown before the app shell when the user has
// not authenticated to the managed gateway. Styling is inline with CSS-variable
// fallbacks so it renders in both themes without touching the global stylesheet.

const wrap: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  overflowY: "auto",
  background: "var(--app-bg, #0e0f13)",
  color: "var(--text, #e6e7ea)",
};

const card: CSSProperties = {
  width: 340,
  maxWidth: "calc(100vw - 48px)",
  padding: "28px 26px",
  borderRadius: 8,
  background: "var(--panel, #16181d)",
  border: "1px solid var(--border, #2a2d34)",
  boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  margin: "auto",
};

const label: CSSProperties = { fontSize: 12, opacity: 0.7, marginBottom: 6 };

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid var(--border, #2a2d34)",
  background: "var(--input-bg, #0e0f13)",
  color: "inherit",
  fontSize: 14,
  outline: "none",
};

const button: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent, #4f7cff)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid var(--border, #2a2d34)",
  background: "var(--input-bg, #0e0f13)",
  color: "inherit",
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const switcher: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: 4,
  borderRadius: 8,
  background: "var(--input-bg, #0e0f13)",
  border: "1px solid var(--border, #2a2d34)",
};

const switchButton: CSSProperties = {
  border: "none",
  borderRadius: 6,
  padding: "7px 10px",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
};

const alertBase: CSSProperties = {
  fontSize: 12.5,
  borderRadius: 8,
  padding: "8px 10px",
};

const brand: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  marginBottom: 4,
};

const brandIcon: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 12,
  objectFit: "cover",
  boxShadow: "0 10px 28px rgba(0,0,0,0.24)",
};

const brandName: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  lineHeight: 1.05,
};

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
    <div style={wrap} data-tauri-drag-region>
      <form style={card} onSubmit={onSubmit}>
        <div style={brand}>
          <img src={appLogo} alt="SomniQ" style={brandIcon} />
          <div>
            <div style={brandName}>SomniQ Studio</div>
            <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
              {mode === "register" ? "创建 New API 账号" : "登录以继续"}
            </div>
          </div>
        </div>

        <div
          style={{ ...switcher, gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
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
              style={{
                ...switchButton,
                background: mode === value ? "var(--panel, #16181d)" : "transparent",
                color: mode === value ? "var(--text, #e6e7ea)" : "var(--text-dim, #8a97a6)",
              }}
            >
              {text}
            </button>
          ))}
        </div>

        <div>
          <div style={label}>账号</div>
          <input
            style={input}
            value={username}
            autoFocus
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
          />
        </div>

        <div>
          <div style={label}>密码</div>
          <input
            style={input}
            type="password"
            value={password}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "8-20 位密码" : "密码"}
          />
        </div>

        {mode === "register" && (
          <>
            <div>
              <div style={label}>确认密码</div>
              <input
                style={input}
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
              />
            </div>

            {needsEmailVerification && (
              <>
                <div>
                  <div style={label}>邮箱</div>
                  <input
                    style={input}
                    type="email"
                    value={email}
                    autoComplete="email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                  />
                </div>

                <div>
                  <div style={label}>验证码</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      style={input}
                      value={verificationCode}
                      autoComplete="one-time-code"
                      spellCheck={false}
                      onChange={(e) => setVerificationCode(e.target.value)}
                      placeholder="邮箱验证码"
                    />
                    <button
                      type="button"
                      onClick={sendVerificationCode}
                      disabled={codeBusy || codeCooldown > 0 || !email.trim() || turnstileRequired}
                      style={{
                        ...secondaryButton,
                        opacity: codeBusy || codeCooldown > 0 || !email.trim() || turnstileRequired ? 0.65 : 1,
                      }}
                    >
                      {codeCooldown > 0 ? `${codeCooldown}s` : codeBusy ? "发送中" : "发送"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {legalRequired && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  color: "var(--text-dim, #8a97a6)",
                }}
              >
                <input
                  type="checkbox"
                  checked={legalAccepted}
                  onChange={(e) => setLegalAccepted(e.target.checked)}
                />
                我已阅读并同意服务条款和隐私政策
              </label>
            )}

            {turnstileRequired && (
              <div
                role="alert"
                style={{
                  ...alertBase,
                  color: "var(--warning, #fbbf24)",
                  background: "rgba(251,191,36,0.08)",
                  border: "1px solid rgba(251,191,36,0.35)",
                }}
              >
                当前服务器开启了人机验证，请在网页端注册后返回登录。
                <button
                  type="button"
                  onClick={() => void openExternalUrl(`${resolvedServer}/sign-up`)}
                  style={{
                    marginLeft: 8,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--accent, #4f7cff)",
                    cursor: "pointer",
                  }}
                >
                  打开网页注册
                </button>
              </div>
            )}
          </>
        )}

        {statusError && mode === "register" && (
          <div
            role="alert"
            style={{
              ...alertBase,
              color: "var(--warning, #fbbf24)",
              background: "rgba(251,191,36,0.08)",
              border: "1px solid rgba(251,191,36,0.35)",
            }}
          >
            {statusError}
          </div>
        )}

        {notice && (
          <div
            role="status"
            style={{
              ...alertBase,
              color: "var(--success, #34d399)",
              background: "rgba(52,211,153,0.08)",
              border: "1px solid rgba(52,211,153,0.35)",
            }}
          >
            {notice}
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              ...alertBase,
              color: "var(--danger, #f87171)",
              background: "var(--danger-bg, rgba(248,113,113,0.08))",
              border: "1px solid var(--danger, rgba(248,113,113,0.35))",
            }}
          >
            {error}
          </div>
        )}

        <button type="submit" style={{ ...button, opacity: submitDisabled ? 0.7 : 1 }} disabled={submitDisabled}>
          {busy ? (mode === "register" ? "注册中..." : "登录中...") : mode === "register" ? "创建账号" : "登录"}
        </button>
      </form>
    </div>
  );
}
