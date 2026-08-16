import { useEffect, useMemo, useState } from "react";
import {
  oracleWebAccountCreate,
  oracleWebAccountLogin,
  oracleWebAccountRemove,
  oracleWebRoleSet,
  oracleWebRuntimeInstall,
  oracleWebStatus,
} from "../api/tauri";
import { hasNativeBackend } from "../api/transport";
import { formatUserFacingError } from "../errorMessage";
import type { Language } from "../store";
import type { OracleWebStatusView } from "../types";

interface OracleWebSettingsProps {
  language: Language;
}

type RoleKey = "consult" | "reviewer" | "image";

/** The panel shows one short line per control. Everything that is read once —
 * the third-party boundary, the credential/cookie rules, the sign-in caveat —
 * lives in a single collapsed disclosure instead of repeating around the page. */
const COPY = {
  cn: {
    title: "ChatGPT 网页自动化",
    subtitle: "用你自己的 ChatGPT 订阅，无需 OpenAI API Key。",
    boundary: "第三方网页自动化",
    foldTitle: "使用须知：隐私、边界与风险",
    foldPrivacy: "SomniQ 通过开源 Oracle 驱动一个独立的浏览器 profile，不读取你的日常浏览器资料，也不保存密码。",
    foldBoundary: "走的是 ChatGPT 网页和你的订阅，不是 OpenAI 官方 API；网页改版、登录验证或服务条款变化都可能让任务暂停。",
    foldCookies: "Cookie 只留在本机的账号目录里；移除账号只会把目录归档，不会立即删除。",
    foldLogin: "登录窗口是普通浏览器窗口、不带自动化控制：只在那里输入密码，登录完成后关掉它再跑任务。打开过登录窗口不代表登录成功，第一次调用才会给出真实结果。",
    foldScope: "网页咨询只发送提示词和项目内附件；绑定的审稿账号优先于模型服务页的 Reviewer。",
    dataDir: "本机目录",
    nextRuntime: "下一步：安装 Oracle 运行时",
    nextBrowser: "下一步：装一个 Chromium 系浏览器，然后刷新",
    nextAccount: "下一步：创建账号并完成登录",
    nextConsult: "下一步：把「Chat 咨询」绑定到一个账号",
    connected: "已就绪，Chat 可以调用网页咨询",
    refresh: "刷新",
    refreshing: "刷新中…",
    runtimeTitle: "运行时",
    runtimeSub: "按需安装的可选组件，不含浏览器。",
    ready: "可用",
    missing: "未安装",
    incompatible: "版本不兼容",
    managed: "SomniQ 管理",
    system: "系统安装",
    environment: "开发配置",
    none: "无",
    install: "安装运行时",
    installing: "安装中…",
    installDetail: "约 250MB，不改动系统已装的 Node / Oracle。",
    browserTitle: "浏览器",
    browserSub: "从已安装的 Edge、Chrome、Brave、Chromium 或 Vivaldi 中选一个。",
    browserCount: "{count} 个",
    noBrowserPill: "未检测到",
    noBrowser: "未检测到 Chromium 系浏览器，装好后点刷新。",
    recommended: "推荐",
    accountTitle: "账号",
    accountSub: "每个账号一个独立 profile，并在账号卡上直接切换用途。",
    accountCount: "{count} 个",
    noAccountPill: "未创建",
    accountName: "名称",
    accountPlaceholder: "例如：GPT 审稿账号",
    browser: "浏览器",
    create: "创建账号",
    creating: "创建中…",
    noAccounts: "还没有账号。填个名称即可创建。",
    login: "打开登录",
    opening: "打开中…",
    lastOpened: "上次打开",
    never: "未登录",
    remove: "移除",
    removeQuestion: "移除该账号？本地 profile 会归档保留。",
    confirmRemove: "确认移除",
    cancel: "取消",
    removing: "移除中…",
    rolesTitle: "用途与路由",
    roleSaving: "正在保存…",
    consultRole: "Chat 咨询",
    consultRoleHint: "启用后，Chat 中提供网页咨询工具",
    reviewerRole: "独立审稿",
    reviewerRoleHint: "可选：用 ChatGPT 网页账号替代默认 Reviewer",
    reviewerFallbackHint: "关闭时使用「模型服务」Reviewer",
    imageRole: "图片生成",
    imageRoleHint: "用网页生成图片，存入项目 artifacts",
    accountCreated: "账号已创建，接着打开登录窗口。",
    loginOpened: "登录窗口已打开，登录完成后关掉它再跑任务。",
    removed: "账号已移除，本地 profile 已归档。",
    consultEnabled: "Chat 咨询已启用，下一条 Chat 消息生效。",
    consultDisabled: "Chat 咨询已关闭。",
    reviewerEnabled: "独立审稿已切换到 ChatGPT 网页账号，下一次审稿生效。",
    reviewerFallbackRestored: "独立审稿已恢复使用「模型服务」中的 Reviewer。",
    imageEnabled: "图片生成已启用，下一条 Chat 消息生效。",
    imageDisabled: "图片生成已关闭。",
    runtimeInstalled: "运行时已安装。",
    preview: "浏览器预览模式不会创建真实账号。请在 SomniQ 桌面应用中操作。",
  },
  en: {
    title: "ChatGPT webpage automation",
    subtitle: "Use your own ChatGPT subscription — no OpenAI API key.",
    boundary: "Third-party automation",
    foldTitle: "Before you start: privacy, boundary, risk",
    foldPrivacy: "SomniQ drives a separate browser profile through the open-source Oracle runtime. It never reads your everyday profile and never stores passwords.",
    foldBoundary: "This uses the ChatGPT website and your subscription, not the official OpenAI API. Website, verification, or terms changes can pause tasks.",
    foldCookies: "Cookies stay in the local account folder. Removing an account archives that folder instead of deleting it.",
    foldLogin: "The sign-in window is a normal browser window with no automation control: type your password only there and close it before running a task. Opening it does not verify sign-in — the first real call does.",
    foldScope: "Webpage consultation sends only prompts and project-local files. A bound reviewer account takes precedence over the model-services Reviewer.",
    dataDir: "Local folder",
    nextRuntime: "Next: install the Oracle runtime",
    nextBrowser: "Next: install a Chromium-family browser, then refresh",
    nextAccount: "Next: create an account and sign in",
    nextConsult: "Next: bind Chat consultation to an account",
    connected: "Ready — Chat can call webpage consultation",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    runtimeTitle: "Runtime",
    runtimeSub: "An optional on-demand component. The browser is not included.",
    ready: "Ready",
    missing: "Not installed",
    incompatible: "Incompatible version",
    managed: "SomniQ-managed",
    system: "System install",
    environment: "Development override",
    none: "None",
    install: "Install runtime",
    installing: "Installing…",
    installDetail: "About 250MB. System Node / Oracle installs are left untouched.",
    browserTitle: "Browser",
    browserSub: "Pick one of the installed Edge, Chrome, Brave, Chromium, or Vivaldi builds.",
    browserCount: "{count} found",
    noBrowserPill: "None found",
    noBrowser: "No Chromium-family browser found. Install one, then refresh.",
    recommended: "Recommended",
    accountTitle: "Account",
    accountSub: "Each account has its own profile and capability switches.",
    accountCount: "{count}",
    noAccountPill: "None yet",
    accountName: "Name",
    accountPlaceholder: "For example: GPT reviewer",
    browser: "Browser",
    create: "Create account",
    creating: "Creating…",
    noAccounts: "No accounts yet. Enter a name to create one.",
    login: "Open sign-in",
    opening: "Opening…",
    lastOpened: "Last opened",
    never: "Not signed in",
    remove: "Remove",
    removeQuestion: "Remove this account? Its local profile is archived, not deleted.",
    confirmRemove: "Confirm removal",
    cancel: "Cancel",
    removing: "Removing…",
    rolesTitle: "Capabilities and routing",
    roleSaving: "Saving…",
    consultRole: "Chat consultation",
    consultRoleHint: "When on, adds webpage consultation to Chat",
    reviewerRole: "Independent review",
    reviewerRoleHint: "Optional: replace the default Reviewer with a ChatGPT webpage account",
    reviewerFallbackHint: "When off, uses the Model Services Reviewer",
    imageRole: "Image generation",
    imageRoleHint: "Generates images into the project artifacts",
    accountCreated: "Account created. Open its sign-in window next.",
    loginOpened: "Sign-in window opened. Close it before running a task.",
    removed: "Account removed and its local profile archived.",
    consultEnabled: "Chat consultation is on for the next Chat message.",
    consultDisabled: "Chat consultation is off.",
    reviewerEnabled: "Independent review now uses the ChatGPT webpage account for the next review.",
    reviewerFallbackRestored: "Independent review now uses the Model Services Reviewer again.",
    imageEnabled: "Image generation is on for the next Chat message.",
    imageDisabled: "Image generation is off.",
    runtimeInstalled: "The runtime is installed.",
    preview: "Browser preview mode cannot create real accounts. Use the SomniQ desktop app.",
  },
} as const;

export default function OracleWebSettings({ language }: OracleWebSettingsProps) {
  const copy = COPY[language];
  const nativeBackend = hasNativeBackend();
  const [status, setStatus] = useState<OracleWebStatusView | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [browserPath, setBrowserPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [openingAccountId, setOpeningAccountId] = useState<string | null>(null);
  const [settingRole, setSettingRole] = useState<RoleKey | null>(null);
  const [pendingRole, setPendingRole] = useState<{ key: RoleKey; accountId: string | null } | null>(null);
  const [confirmRemovalId, setConfirmRemovalId] = useState<string | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await oracleWebStatus();
      setStatus(next);
      setBrowserPath((current) => {
        if (current && next.browsers.some((browser) => browser.path === current)) return current;
        return next.browsers.find((browser) => browser.recommended)?.path ?? next.browsers[0]?.path ?? "";
      });
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // This panel owns its request lifecycle and is only mounted for its active settings tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runtimeSource = useMemo(() => {
    const source = status?.runtime.source;
    if (source === "managed") return copy.managed;
    if (source === "system") return copy.system;
    if (source === "environment") return copy.environment;
    return copy.none;
  }, [copy, status?.runtime.source]);

  const runtimeReady = status?.runtime.status === "ready";
  const runtimeStatusLabel = runtimeReady
    ? copy.ready
    : status?.runtime.status === "incompatible"
      ? copy.incompatible
      : copy.missing;

  const accounts = status?.accounts ?? [];
  const browsers = status?.browsers ?? [];

  const createAccount = async () => {
    if (!displayName.trim() || !browserPath || !nativeBackend) return;
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const next = await oracleWebAccountCreate({
        displayName: displayName.trim(),
        browserPath,
      });
      setStatus(next);
      setDisplayName("");
      setNotice(copy.accountCreated);
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setCreating(false);
    }
  };

  const installRuntime = async () => {
    if (!nativeBackend) return;
    setInstalling(true);
    setError("");
    setNotice("");
    try {
      const next = await oracleWebRuntimeInstall();
      setStatus(next);
      setNotice(copy.runtimeInstalled);
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setInstalling(false);
    }
  };

  const openLogin = async (accountId: string) => {
    setOpeningAccountId(accountId);
    setError("");
    setNotice("");
    try {
      const launched = await oracleWebAccountLogin(accountId);
      setStatus((current) =>
        current
          ? {
              ...current,
              accounts: current.accounts.map((account) =>
                account.id === launched.account.id ? launched.account : account,
              ),
            }
          : current,
      );
      setNotice(copy.loginOpened);
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setOpeningAccountId(null);
    }
  };

  const setRole = async (role: RoleKey, accountId: string | null) => {
    setSettingRole(role);
    setPendingRole({ key: role, accountId });
    setError("");
    setNotice("");
    try {
      const next = await oracleWebRoleSet({ role, accountId });
      setStatus(next);
      setNotice(
        role === "consult"
          ? accountId
            ? copy.consultEnabled
            : copy.consultDisabled
          : role === "reviewer"
            ? accountId
              ? copy.reviewerEnabled
              : copy.reviewerFallbackRestored
            : accountId
              ? copy.imageEnabled
              : copy.imageDisabled,
      );
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setPendingRole(null);
      setSettingRole(null);
    }
  };

  const removeAccount = async (accountId: string) => {
    if (!nativeBackend) return;
    setRemovingAccountId(accountId);
    setError("");
    setNotice("");
    try {
      const next = await oracleWebAccountRemove(accountId);
      setStatus(next);
      setConfirmRemovalId(null);
      setNotice(copy.removed);
    } catch (cause) {
      setError(formatUserFacingError(cause));
    } finally {
      setRemovingAccountId(null);
    }
  };

  /** Each route is single-valued in the backend. Keep the pending selection
   * visible while it is saved so a controlled picker never jumps back to its
   * stale value. */
  const roles = useMemo(
    () => [
      {
        key: "consult" as const,
        label: copy.consultRole,
        hint: copy.consultRoleHint,
        accountId: pendingRole?.key === "consult" ? pendingRole.accountId : status?.consultAccountId ?? null,
      },
      {
        key: "reviewer" as const,
        label: copy.reviewerRole,
        hint: copy.reviewerRoleHint,
        accountId: pendingRole?.key === "reviewer" ? pendingRole.accountId : status?.reviewerAccountId ?? null,
      },
      {
        key: "image" as const,
        label: copy.imageRole,
        hint: copy.imageRoleHint,
        accountId: pendingRole?.key === "image" ? pendingRole.accountId : status?.imageAccountId ?? null,
      },
    ],
    [copy, pendingRole, status],
  );

  const progress = useMemo(() => {
    const browserReady = browsers.length > 0;
    const accountReady = accounts.some((account) => account.lastLoginLaunchedAt);
    const consultReady = runtimeReady && browserReady && accountReady && Boolean(status?.consultAccountId);
    const done = [runtimeReady, browserReady, accountReady, consultReady].filter(Boolean).length;
    return {
      done,
      accountReady,
      ready: done === 4,
      next: !runtimeReady
        ? copy.nextRuntime
        : !browserReady
          ? copy.nextBrowser
          : !accountReady
            ? copy.nextAccount
            : !consultReady
              ? copy.nextConsult
              : copy.connected,
    };
  }, [accounts, browsers, copy, runtimeReady, status?.consultAccountId]);

  const formatOpenedAt = (timestamp?: number | null) => {
    if (!timestamp) return copy.never;
    return `${copy.lastOpened} ${new Intl.DateTimeFormat(language === "cn" ? "zh-CN" : "en", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(timestamp * 1000))}`;
  };

  return (
    <div className="oracle-web-page">
      <section className="sp-update-section oracle-web-hero">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.title}</div>
            <div className="sp-section-sub">{copy.subtitle}</div>
          </div>
          <span className="oracle-web-boundary-badge">{copy.boundary}</span>
        </div>

        <div className={`oracle-web-actionbar ${progress.ready ? "ready" : ""}`}>
          <span className="oracle-web-progress">{progress.done}/4</span>
          <span className="oracle-web-next">{progress.next}</span>
          <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? copy.refreshing : copy.refresh}
          </button>
        </div>

        <details className="oracle-web-fold">
          <summary>{copy.foldTitle}</summary>
          <ul>
            <li>{copy.foldPrivacy}</li>
            <li>{copy.foldBoundary}</li>
            <li>{copy.foldScope}</li>
            <li>{copy.foldCookies}</li>
            <li>{copy.foldLogin}</li>
          </ul>
          {status?.dataDir && (
            <div className="oracle-web-path" title={status.dataDir}>{copy.dataDir}: {status.dataDir}</div>
          )}
        </details>
      </section>

      {!nativeBackend && <div className="oracle-web-message">{copy.preview}</div>}
      {error && <div className="oracle-web-message error" role="alert">{error}</div>}
      {notice && <div className="oracle-web-message success" role="status">{notice}</div>}

      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title"><span className="oracle-web-step">1</span>{copy.runtimeTitle}</div>
            <div className="sp-section-sub">{copy.runtimeSub}</div>
          </div>
          <span className={`oracle-web-pill ${runtimeReady ? "ok" : "todo"}`}>{runtimeStatusLabel}</span>
        </div>
        <div className="oracle-web-meta">
          <span>{runtimeSource}</span>
          {status?.runtime.version && <span>v{status.runtime.version}</span>}
        </div>
        {!runtimeReady && (
          <>
            {status?.runtime.message && <div className="oracle-web-muted">{status.runtime.message}</div>}
            {status?.runtime.installSupported && (
              <div className="oracle-web-install-row">
                <button
                  className="sp-btn sp-btn-primary"
                  type="button"
                  onClick={() => void installRuntime()}
                  disabled={installing || !nativeBackend}
                >
                  {installing ? copy.installing : copy.install}
                </button>
                <span>{copy.installDetail}</span>
              </div>
            )}
          </>
        )}
      </section>

      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title"><span className="oracle-web-step">2</span>{copy.browserTitle}</div>
            <div className="sp-section-sub">{copy.browserSub}</div>
          </div>
          <span className={`oracle-web-pill ${browsers.length ? "ok" : "todo"}`}>
            {browsers.length ? copy.browserCount.replace("{count}", String(browsers.length)) : copy.noBrowserPill}
          </span>
        </div>
        {browsers.length ? (
          <div className="oracle-web-browser-pills">
            {browsers.map((browser) => (
              <span className="oracle-web-browser-pill" key={browser.id} title={browser.path}>
                <span className="oracle-web-browser-mark">{browser.name.slice(0, 1)}</span>
                {browser.name}
                {browser.recommended && <small>{copy.recommended}</small>}
              </span>
            ))}
          </div>
        ) : (
          <div className="oracle-web-empty">{copy.noBrowser}</div>
        )}
      </section>

      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title"><span className="oracle-web-step">3</span>{copy.accountTitle}</div>
            <div className="sp-section-sub">{copy.accountSub}</div>
          </div>
          <span className={`oracle-web-pill ${progress.accountReady ? "ok" : "todo"}`}>
            {accounts.length ? copy.accountCount.replace("{count}", String(accounts.length)) : copy.noAccountPill}
          </span>
        </div>

        <div className="oracle-web-account-form">
          <label>
            <span>{copy.accountName}</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={copy.accountPlaceholder}
              maxLength={80}
            />
          </label>
          <label>
            <span>{copy.browser}</span>
            <select value={browserPath} onChange={(event) => setBrowserPath(event.target.value)}>
              {browsers.map((browser) => (
                <option value={browser.path} key={browser.id}>{browser.name}</option>
              ))}
            </select>
          </label>
          <button
            className="sp-btn sp-btn-primary"
            type="button"
            onClick={() => void createAccount()}
            disabled={creating || !displayName.trim() || !browserPath || !nativeBackend}
          >
            {creating ? copy.creating : copy.create}
          </button>
        </div>

        {!accounts.length ? (
          <div className="oracle-web-empty">{copy.noAccounts}</div>
        ) : (
          <div className="oracle-web-account-list">
            {accounts.map((account) => (
              <article className="oracle-web-account-card" key={account.id} title={account.profilePath}>
                <div className="oracle-web-account-main">
                  <span className="oracle-web-account-avatar">{account.displayName.slice(0, 1).toUpperCase()}</span>
                  <div className="oracle-web-account-copy">
                    <div className="oracle-web-account-name">{account.displayName}</div>
                    <div className="oracle-web-meta">
                      <span>{account.browserName}</span>
                      <span className={account.lastLoginLaunchedAt ? "" : "warn"}>
                        {formatOpenedAt(account.lastLoginLaunchedAt)}
                      </span>
                    </div>
                  </div>
                  <div className="oracle-web-account-action">
                    <button
                      className="sp-btn sp-btn-secondary"
                      type="button"
                      onClick={() => void openLogin(account.id)}
                      disabled={openingAccountId === account.id || removingAccountId === account.id}
                    >
                      {openingAccountId === account.id ? copy.opening : copy.login}
                    </button>
                    <button
                      className="oracle-web-remove-link"
                      type="button"
                      onClick={() => setConfirmRemovalId(account.id)}
                      disabled={confirmRemovalId === account.id || openingAccountId === account.id}
                    >
                      {copy.remove}
                    </button>
                  </div>
                </div>
                <div className="oracle-web-account-routes" aria-label={`${account.displayName} · ${copy.rolesTitle}`}>
                  {roles.map((role) => {
                    const checked = role.accountId === account.id;
                    const label = `${account.displayName} · ${role.label}`;
                    const saving = settingRole === role.key;
                    return (
                      <label
                        className={`oracle-web-account-route ${checked ? "active" : ""}`}
                        title={role.hint}
                        key={role.key}
                      >
                        <span className="oracle-web-account-route-copy">
                          <span className="oracle-web-account-route-name">{role.label}</span>
                          <span className="oracle-web-account-route-hint">
                            {saving
                              ? copy.roleSaving
                              : role.key === "reviewer"
                                ? copy.reviewerFallbackHint
                                : role.hint}
                          </span>
                        </span>
                        <span className="oracle-web-switch">
                          <input
                            type="checkbox"
                            aria-label={label}
                            aria-busy={saving}
                            checked={checked}
                            disabled={settingRole !== null || removingAccountId === account.id}
                            onChange={() => void setRole(role.key, checked ? null : account.id)}
                          />
                          <span className="oracle-web-switch-track" aria-hidden="true" />
                        </span>
                      </label>
                    );
                  })}
                </div>
                {confirmRemovalId === account.id && (
                  <div className="oracle-web-remove-confirm" role="group" aria-label={copy.removeQuestion}>
                    <strong>{copy.removeQuestion}</strong>
                    <div>
                      <button
                        className="sp-btn sp-btn-danger"
                        type="button"
                        onClick={() => void removeAccount(account.id)}
                        disabled={removingAccountId === account.id}
                      >
                        {removingAccountId === account.id ? copy.removing : copy.confirmRemove}
                      </button>
                      <button
                        className="sp-btn sp-btn-secondary"
                        type="button"
                        onClick={() => setConfirmRemovalId(null)}
                        disabled={removingAccountId === account.id}
                      >
                        {copy.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
