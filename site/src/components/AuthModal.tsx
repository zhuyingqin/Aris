import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import type { Copy } from "../i18n";
import { CloseIcon, LockIcon, SparklesIcon, UserIcon } from "./icons";

type Props = {
  copy: Copy;
};

export default function AuthModal({ copy }: Props) {
  const {
    authModalOpen,
    authModalMode,
    closeAuthModal,
    openAuthModal,
    login,
    register,
  } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  if (!authModalOpen) return null;

  const { auth } = copy;
  const isRegister = authModalMode === "register";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    const trimmedUser = username.trim();
    if (!trimmedUser || (isRegister && trimmedUser.length < 3)) {
      setErrorMsg(auth.usernameRequired);
      return;
    }

    if (!password || (isRegister && password.length < 8)) {
      setErrorMsg(auth.passwordTooShort);
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setErrorMsg(auth.passwordMismatch);
      return;
    }

    setLoading(true);
    try {
      if (isRegister) {
        const res = await register(trimmedUser, password, email);
        if (res.success) {
          setSuccessMsg(auth.registerSuccess);
        } else {
          setErrorMsg(res.message || auth.errorDefault);
        }
      } else {
        const res = await login(trimmedUser, password);
        if (res.success) {
          setSuccessMsg(auth.loginSuccess);
        } else {
          setErrorMsg(res.message || auth.errorDefault);
        }
      }
    } catch {
      setErrorMsg(auth.errorDefault);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (mode: "login" | "register") => {
    setErrorMsg("");
    setSuccessMsg("");
    openAuthModal(mode);
  };

  return (
    <div className="auth-overlay" onClick={closeAuthModal}>
      <div
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="auth-close-btn"
          onClick={closeAuthModal}
          aria-label={copy.dashboard.close}
        >
          <CloseIcon width={18} height={18} />
        </button>

        <div className="auth-header">
          <div className="auth-badge">
            <SparklesIcon width={16} height={16} />
            <span>{isRegister ? auth.registerTitle : auth.loginTitle}</span>
          </div>
          <h2 id="auth-modal-title" className="auth-title">
            {isRegister ? auth.registerTitle : auth.loginTitle}
          </h2>
          <p className="auth-subtitle">{auth.subtitle}</p>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            className={`auth-tab ${!isRegister ? "auth-tab--active" : ""}`}
            onClick={() => switchMode("login")}
            role="tab"
            aria-selected={!isRegister}
          >
            {auth.loginTitle}
          </button>
          <button
            type="button"
            className={`auth-tab ${isRegister ? "auth-tab--active" : ""}`}
            onClick={() => switchMode("register")}
            role="tab"
            aria-selected={isRegister}
          >
            {auth.registerTitle}
          </button>
        </div>

        {errorMsg && (
          <div className="auth-alert auth-alert--error" role="alert">
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="auth-alert auth-alert--success" role="status">
            <span>{successMsg}</span>
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="auth-username">{auth.usernameLabel}</label>
            <div className="input-wrap">
              <UserIcon className="input-icon" width={16} height={16} />
              <input
                id="auth-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={auth.usernamePlaceholder}
                autoComplete="username"
                required
                disabled={loading}
              />
            </div>
          </div>

          {isRegister && (
            <div className="form-group">
              <label htmlFor="auth-email">{auth.emailLabel}</label>
              <div className="input-wrap">
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={auth.emailPlaceholder}
                  autoComplete="email"
                  disabled={loading}
                />
              </div>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="auth-password">{auth.passwordLabel}</label>
            <div className="input-wrap">
              <LockIcon className="input-icon" width={16} height={16} />
              <input
                id="auth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={auth.passwordPlaceholder}
                autoComplete={isRegister ? "new-password" : "current-password"}
                required
                disabled={loading}
              />
            </div>
          </div>

          {isRegister && (
            <div className="form-group">
              <label htmlFor="auth-confirm-password">
                {auth.confirmPasswordLabel}
              </label>
              <div className="input-wrap">
                <LockIcon className="input-icon" width={16} height={16} />
                <input
                  id="auth-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={auth.confirmPasswordPlaceholder}
                  autoComplete="new-password"
                  required
                  disabled={loading}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="btn btn--primary btn--block auth-submit-btn"
            disabled={loading}
          >
            {loading
              ? isRegister
                ? auth.registering
                : auth.loggingIn
              : isRegister
              ? auth.registerSubmit
              : auth.loginSubmit}
          </button>
        </form>

        <div className="auth-footer">
          {isRegister ? (
            <button
              type="button"
              className="auth-switch-link"
              onClick={() => switchMode("login")}
            >
              {auth.hasAccount}
            </button>
          ) : (
            <button
              type="button"
              className="auth-switch-link"
              onClick={() => switchMode("register")}
            >
              {auth.noAccount}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
