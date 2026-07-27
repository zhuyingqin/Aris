import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  mailAccountsGet,
  mailAutoconfig,
  mailConnect,
  mailDisconnect,
  mailGenericConnect,
  mailGenericTest,
} from "../api/tauri";
import type {
  GenericMailAccountInput,
  GenericMailTestResult,
  MailAccount,
  MailAutoconfigResult,
  MailSocketSecurity,
} from "../types";
import { useStore, type Language } from "../store";
import { SvgIcon } from "../SvgIcon";

const DEFAULT_MAIL: GenericMailAccountInput = {
  email: "",
  displayName: "",
  imapHost: "",
  imapPort: 993,
  imapSecurity: "tls",
  imapUsername: "",
  imapPassword: "",
  smtpEnabled: true,
  smtpHost: "",
  smtpPort: 465,
  smtpSecurity: "tls",
  smtpUsername: "",
  smtpPassword: "",
};

const MAIL_COPY: Record<Language, {
  mail: string;
  connected: string;
  notConnected: string;
  cardDescription: string;
  cardError: string;
  configure: string;
  accountSummaryEmpty: string;
  accountSummary: (connected: number, total: number) => string;
  detailTitle: string;
  detailSub: string;
  connectedCount: (count: number) => string;
  oauthTitle: string;
  oauthSub: string;
  connecting: string;
  genericTitle: string;
  genericSub: string;
  emailAddress: string;
  displayName: string;
  displayNamePlaceholder: string;
  discoverTitle: string;
  discoverSub: string;
  discoverUsed: (source: string, notes: string[]) => string;
  discovering: string;
  discover: string;
  defaultEmail: string;
  passwordPlaceholder: string;
  enableSmtp: string;
  enableSmtpSub: string;
  defaultImapUser: string;
  reuseImapPassword: string;
  testTesting: string;
  testConnection: string;
  connectMailbox: string;
  connectedAccounts: string;
  connectedAccountsSub: string;
  disconnect: string;
  noConnectedAccounts: string;
  emailRequired: string;
  gmailNotice: string;
  outlookNotice: string;
  neteaseNotice: string;
}> = {
  cn: {
    mail: "邮箱",
    connected: "已连接",
    notConnected: "未连接",
    cardDescription: "Provider API + IMAP/SMTP · 对话可读取、整理和发送",
    cardError: "账户状态加载失败，进入详情页重试",
    configure: "配置邮箱",
    accountSummaryEmpty: "尚未连接邮箱",
    accountSummary: (connected, total) => `${connected}/${total} 个账户已连接`,
    detailTitle: "邮箱连接",
    detailSub: "Gmail 和 Outlook 使用 OAuth/API。通用 IMAP/SMTP 仅用于仍支持授权码或应用专用密码的邮箱。",
    connectedCount: (count) => `${count} 已连接`,
    oauthTitle: "Gmail / Outlook 推荐连接方式",
    oauthSub: "个人 Gmail、Outlook.com 和 Microsoft 365 应走 OAuth/API。不要在下面的通用 IMAP 表单里输入普通账户密码。",
    connecting: "连接中...",
    genericTitle: "通用 IMAP/SMTP",
    genericSub: "先输入邮箱地址，自动发现服务器；再输入服务商授权码或应用专用密码测试连接。",
    emailAddress: "邮箱地址",
    displayName: "显示名称",
    displayNamePlaceholder: "发件时显示",
    discoverTitle: "自动发现 IMAP/SMTP",
    discoverSub: "按 Thunderbird Autoconfig、Thunderbird ISPDB、内置服务商规则和通用域名猜测依次查找配置。",
    discoverUsed: (source, notes) => `已使用：${source}${notes.length > 0 ? ` · ${notes.join(" ")}` : ""}`,
    discovering: "发现中...",
    discover: "自动发现",
    defaultEmail: "默认使用邮箱地址",
    passwordPlaceholder: "密码或应用专用密码",
    enableSmtp: "启用 SMTP 发件",
    enableSmtpSub: "关闭后对话只能读取和整理邮件。",
    defaultImapUser: "默认复用 IMAP 用户名",
    reuseImapPassword: "留空复用 IMAP 密码",
    testTesting: "测试中...",
    testConnection: "测试连接",
    connectMailbox: "连接邮箱",
    connectedAccounts: "已连接账户",
    connectedAccountsSub: "连接后，对话和 Mail 页面会复用同一个账户服务。",
    disconnect: "断开连接",
    noConnectedAccounts: "没有已连接的邮箱账户。",
    emailRequired: "请先输入邮箱地址。",
    gmailNotice: "Gmail 的普通 Google 密码不能用于 IMAP LOGIN。优先使用 Continue with Gmail；只有已启用 IMAP 且生成了 Google 应用专用密码时，才使用下面的通用 IMAP/SMTP。",
    outlookNotice: "Outlook.com / Microsoft 365 的密码式 IMAP/SMTP 路径不可用。请使用 Continue with Outlook 的 OAuth/Graph 连接。",
    neteaseNotice: "网易邮箱需要先在网页端开启 IMAP/SMTP 服务，并使用客户端授权码作为密码。若出现 Unsafe Login，说明网易风控拒绝了当前客户端或登录环境，请先完成网页端安全验证，或联系 kefu@188.com。",
  },
  en: {
    mail: "Mail",
    connected: "Connected",
    notConnected: "Not connected",
    cardDescription: "Provider API + IMAP/SMTP · Chat can read, organize, and send",
    cardError: "Account status failed to load. Open details to retry.",
    configure: "Configure mail",
    accountSummaryEmpty: "No mailbox connected",
    accountSummary: (connected, total) => `${connected}/${total} accounts connected`,
    detailTitle: "Mail Connections",
    detailSub: "Gmail and Outlook use OAuth/API. Generic IMAP/SMTP is only for providers that still support app passwords or authorization codes.",
    connectedCount: (count) => `${count} connected`,
    oauthTitle: "Recommended for Gmail / Outlook",
    oauthSub: "Personal Gmail, Outlook.com, and Microsoft 365 should use OAuth/API. Do not enter a normal account password in the generic IMAP form below.",
    connecting: "Connecting...",
    genericTitle: "Generic IMAP/SMTP",
    genericSub: "Enter an email address to discover servers, then test with the provider authorization code or app password.",
    emailAddress: "Email address",
    displayName: "Display name",
    displayNamePlaceholder: "Shown when sending",
    discoverTitle: "Discover IMAP/SMTP",
    discoverSub: "Checks Thunderbird Autoconfig, Thunderbird ISPDB, built-in provider rules, and common domain guesses.",
    discoverUsed: (source, notes) => `Using: ${source}${notes.length > 0 ? ` · ${notes.join(" ")}` : ""}`,
    discovering: "Discovering...",
    discover: "Auto-discover",
    defaultEmail: "Defaults to email address",
    passwordPlaceholder: "Password or app password",
    enableSmtp: "Enable SMTP sending",
    enableSmtpSub: "When off, Chat can only read and organize mail.",
    defaultImapUser: "Defaults to IMAP username",
    reuseImapPassword: "Leave blank to reuse IMAP password",
    testTesting: "Testing...",
    testConnection: "Test connection",
    connectMailbox: "Connect mailbox",
    connectedAccounts: "Connected Accounts",
    connectedAccountsSub: "After connecting, Chat and Mail reuse the same account service.",
    disconnect: "Disconnect",
    noConnectedAccounts: "No connected mail accounts.",
    emailRequired: "Enter an email address first.",
    gmailNotice: "A normal Google password cannot be used for Gmail IMAP LOGIN. Prefer Continue with Gmail; use generic IMAP/SMTP only after enabling IMAP and creating a Google app password.",
    outlookNotice: "Password-based IMAP/SMTP is unavailable for Outlook.com / Microsoft 365. Use Continue with Outlook for OAuth/Graph.",
    neteaseNotice: "NetEase mail requires IMAP/SMTP to be enabled in webmail and a client authorization code as the password. Unsafe Login means NetEase rejected this client or login environment.",
  },
};

function normalizeMail(input: GenericMailAccountInput): GenericMailAccountInput {
  const email = input.email.trim();
  const imapUsername = input.imapUsername.trim() || email;
  return {
    ...input,
    email,
    displayName: input.displayName?.trim() || email,
    imapHost: input.imapHost.trim(),
    imapPort: Number(input.imapPort) || 993,
    imapUsername,
    smtpEnabled: Boolean(input.smtpEnabled),
    smtpHost: input.smtpHost?.trim() || "",
    smtpPort: Number(input.smtpPort) || (input.smtpSecurity === "starttls" ? 587 : 465),
    smtpUsername: input.smtpUsername?.trim() || imapUsername,
    smtpPassword: input.smtpPassword || input.imapPassword,
  };
}

function providerLabel(provider: MailAccount["provider"]) {
  if (provider === "gmail" || provider === "outlook") return "Provider API";
  return "IMAP/SMTP";
}

function providerAuthNotice(email: string, copy: typeof MAIL_COPY[Language]): string | null {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return copy.gmailNotice;
  }
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain) || domain.endsWith(".onmicrosoft.com")) {
    return copy.outlookNotice;
  }
  if (["126.com", "163.com", "yeah.net", "188.com"].includes(domain)) {
    return copy.neteaseNotice;
  }
  return null;
}

function accountSummary(accounts: MailAccount[], copy: typeof MAIL_COPY[Language]) {
  const connected = accounts.filter((account) => account.connected).length;
  if (accounts.length === 0) return copy.accountSummaryEmpty;
  return copy.accountSummary(connected, accounts.length);
}

export default function MailSettings({ onOpen }: { onOpen: () => void }) {
  const language = useStore((state) => state.language);
  const copy = MAIL_COPY[language];
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mailAccountsGet()
      .then((next) => {
        setAccounts(next);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const connectedCount = useMemo(
    () => accounts.filter((account) => account.connected).length,
    [accounts],
  );

  return (
    <div className="sp-card-wrap">
      <div className="sp-card sp-bridge-card">
        <div
          className="sp-card-click-zone"
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          <div className="sp-card-icon sp-card-icon-mail" aria-hidden="true">M</div>
          <div className="sp-card-body">
            <div className="sp-card-name">
              {copy.mail}
              <span className="sp-role-badge sp-role-mail">Autoconfig</span>
              {connectedCount > 0 && <span className="sp-role-badge sp-role-running">{copy.connected}</span>}
            </div>
            <div className="sp-card-url">{copy.cardDescription}</div>
            <div className="sp-card-notes">{error ? copy.cardError : accountSummary(accounts, copy)}</div>
          </div>
        </div>
        <div className="sp-card-actions" onClick={(event) => event.stopPropagation()}>
          <button className="sp-card-btn" title={copy.configure} type="button" onClick={onOpen}><SvgIcon name="edit" size={15} /></button>
        </div>
      </div>
    </div>
  );
}

export function MailSettingsDetail() {
  const language = useStore((state) => state.language);
  const copy = MAIL_COPY[language];
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [form, setForm] = useState<GenericMailAccountInput>(DEFAULT_MAIL);
  const [discoveryResult, setDiscoveryResult] = useState<MailAutoconfigResult | null>(null);
  const [testResult, setTestResult] = useState<GenericMailTestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectedCount = useMemo(
    () => accounts.filter((account) => account.connected).length,
    [accounts],
  );
  const authNotice = useMemo(() => providerAuthNotice(form.email, copy), [form.email, copy]);

  useEffect(() => {
    mailAccountsGet().then(setAccounts).catch((e) => setError(String(e)));
  }, []);

  const patch = (next: Partial<GenericMailAccountInput>) => {
    setForm((current) => ({ ...current, ...next }));
    if ("email" in next) setDiscoveryResult(null);
    setTestResult(null);
    setError(null);
  };

  const discoverConfig = async () => {
    const email = form.email.trim();
    if (!email) {
      setError(copy.emailRequired);
      return;
    }
    setBusy("discover");
    setError(null);
    setTestResult(null);
    try {
      const result = await mailAutoconfig(email);
      setDiscoveryResult(result);
      setForm((current) => ({
        ...current,
        email,
        displayName: current.displayName?.trim() || result.displayName || email,
        imapHost: result.imapHost,
        imapPort: result.imapPort,
        imapSecurity: result.imapSecurity,
        imapUsername: result.imapUsername || email,
        smtpEnabled: result.smtpEnabled,
        smtpHost: result.smtpHost,
        smtpPort: result.smtpPort,
        smtpSecurity: result.smtpSecurity,
        smtpUsername: result.smtpUsername || result.imapUsername || email,
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await mailGenericTest(normalizeMail(form)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("connect");
    setError(null);
    setTestResult(null);
    try {
      const account = await mailGenericConnect(normalizeMail(form));
      setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
      setTestResult({
        ok: true,
        imapOk: true,
        smtpOk: Boolean(form.smtpEnabled),
        message: "Mailbox connected.",
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const connectProvider = async (provider: "gmail" | "outlook") => {
    setBusy(provider);
    setError(null);
    setTestResult(null);
    try {
      const account = await mailConnect(provider);
      setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      setAccounts(await mailDisconnect(id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sp-detail-form mail-settings-detail">
      <section className="mail-settings-summary">
        <div>
          <div className="sp-field-label">{copy.detailTitle}</div>
          <div className="sp-field-hint">
            {copy.detailSub}
          </div>
        </div>
        <div className="mail-settings-summary-badges">
          <span className="sp-role-badge sp-role-mail">Provider API</span>
          <span className="sp-role-badge sp-role-mail">IMAP/SMTP</span>
          <span className={`sp-role-badge ${connectedCount > 0 ? "sp-role-running" : "sp-role-muted"}`}>
            {connectedCount > 0 ? copy.connectedCount(connectedCount) : copy.notConnected}
          </span>
        </div>
      </section>

      <section className="mail-settings-panel">
        <div className="mail-settings-oauth-card">
          <div className="mail-settings-oauth-copy">
            <strong>{copy.oauthTitle}</strong>
            <span>{copy.oauthSub}</span>
          </div>
          <div className="mail-settings-oauth-actions">
            <button
              className="sp-btn sp-btn-primary"
              type="button"
              disabled={busy !== null}
              onClick={() => void connectProvider("gmail")}
            >
              {busy === "gmail" ? copy.connecting : "Continue with Gmail"}
            </button>
            <button
              className="sp-btn sp-btn-secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void connectProvider("outlook")}
            >
              {busy === "outlook" ? copy.connecting : "Continue with Outlook"}
            </button>
          </div>
        </div>

        <div className="mail-settings-panel-head">
          <div>
            <div className="sp-field-label">{copy.genericTitle}</div>
            <div className="sp-field-hint">{copy.genericSub}</div>
          </div>
        </div>

        <div className="sp-detail-row2">
          <Field label={copy.emailAddress}>
            <input
              className="sp-input"
              value={form.email}
              placeholder="name@example.com"
              onChange={(event) => patch({ email: event.target.value })}
            />
          </Field>
          <Field label={copy.displayName}>
            <input
              className="sp-input"
              value={form.displayName ?? ""}
              placeholder={copy.displayNamePlaceholder}
              onChange={(event) => patch({ displayName: event.target.value })}
            />
          </Field>
        </div>

        <div className="mail-settings-oauth-card">
          <div className="mail-settings-oauth-copy">
            <strong>{copy.discoverTitle}</strong>
            <span>{copy.discoverSub}</span>
            {discoveryResult && (
              <span>{copy.discoverUsed(discoveryResult.source, discoveryResult.notes)}</span>
            )}
            {authNotice && <span className="mail-settings-oauth-warning">{authNotice}</span>}
          </div>
          <button
            className="sp-btn sp-btn-primary"
            type="button"
            disabled={busy !== null || !form.email.trim()}
            onClick={() => void discoverConfig()}
          >
            {busy === "discover" ? copy.discovering : copy.discover}
          </button>
        </div>

        <div className="mail-settings-subtitle">Incoming IMAP</div>
        <div className="mail-settings-grid">
          <Field label="Host">
            <input
              className="sp-input"
              value={form.imapHost}
              placeholder="imap.example.com"
              onChange={(event) => patch({ imapHost: event.target.value })}
            />
          </Field>
          <Field label="Port">
            <input
              className="sp-input"
              type="number"
              value={form.imapPort}
              onChange={(event) => patch({ imapPort: Number(event.target.value) })}
            />
          </Field>
          <Field label="Security">
            <SecuritySelect value={form.imapSecurity} onChange={(value) => patch({ imapSecurity: value })} />
          </Field>
          <Field label="Username">
            <input
              className="sp-input"
              value={form.imapUsername}
              placeholder={copy.defaultEmail}
              onChange={(event) => patch({ imapUsername: event.target.value })}
            />
          </Field>
          <Field label="Password">
            <input
              className="sp-input"
              type="password"
              value={form.imapPassword}
              placeholder={copy.passwordPlaceholder}
              onChange={(event) => patch({ imapPassword: event.target.value })}
            />
          </Field>
        </div>

        <label className="mail-settings-toggle">
          <input
            type="checkbox"
            checked={form.smtpEnabled}
            onChange={(event) => patch({ smtpEnabled: event.target.checked })}
          />
          <span>
            <strong>{copy.enableSmtp}</strong>
            <span>{copy.enableSmtpSub}</span>
          </span>
        </label>

        {form.smtpEnabled && (
          <>
            <div className="mail-settings-subtitle">Outgoing SMTP</div>
            <div className="mail-settings-grid">
              <Field label="Host">
                <input
                  className="sp-input"
                  value={form.smtpHost ?? ""}
                  placeholder="smtp.example.com"
                  onChange={(event) => patch({ smtpHost: event.target.value })}
                />
              </Field>
              <Field label="Port">
                <input
                  className="sp-input"
                  type="number"
                  value={form.smtpPort ?? 465}
                  onChange={(event) => patch({ smtpPort: Number(event.target.value) })}
                />
              </Field>
              <Field label="Security">
                <SecuritySelect
                  value={form.smtpSecurity ?? "tls"}
                  onChange={(value) => patch({ smtpSecurity: value })}
                />
              </Field>
              <Field label="Username">
                <input
                  className="sp-input"
                  value={form.smtpUsername ?? ""}
                  placeholder={copy.defaultImapUser}
                  onChange={(event) => patch({ smtpUsername: event.target.value })}
                />
              </Field>
              <Field label="Password">
                <input
                  className="sp-input"
                  type="password"
                  value={form.smtpPassword ?? ""}
                  placeholder={copy.reuseImapPassword}
                  onChange={(event) => patch({ smtpPassword: event.target.value })}
                />
              </Field>
            </div>
          </>
        )}

        <div className="sp-detail-actions">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={busy !== null} onClick={() => void testConnection()}>
            {busy === "test" ? copy.testTesting : copy.testConnection}
          </button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={busy !== null} onClick={() => void connect()}>
            {busy === "connect" ? copy.connecting : copy.connectMailbox}
          </button>
          {testResult && (
            <span className={`mail-settings-result ${testResult.ok ? "ok" : "failed"}`}>
              {testResult.message}
            </span>
          )}
        </div>
      </section>

      <section className="mail-settings-panel">
        <div className="mail-settings-panel-head">
          <div>
            <div className="sp-field-label">{copy.connectedAccounts}</div>
            <div className="sp-field-hint">{accounts.length > 0 ? accountSummary(accounts, copy) : copy.connectedAccountsSub}</div>
          </div>
        </div>

        {accounts.length > 0 ? (
          <div className="mail-account-list">
            {accounts.map((account) => (
              <div className="mail-account-row" key={account.id}>
                <div className="mail-account-main">
                  <strong>{account.email}</strong>
                  <span>
                    {providerLabel(account.provider)}
                    {!account.connected && " · disconnected"}
                  </span>
                </div>
                <button
                  className="sp-card-btn sp-card-btn-danger"
                  title={copy.disconnect}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void disconnect(account.id)}
                >
                  <SvgIcon name="close" size={15} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mail-settings-empty">{copy.noConnectedAccounts}</div>
        )}
      </section>

      {error && (
        <div className="mail-settings-error">
          {error}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="sp-field">
      <div className="sp-field-label">{label}</div>
      {children}
    </label>
  );
}

function SecuritySelect({
  value,
  onChange,
}: {
  value: MailSocketSecurity;
  onChange: (value: MailSocketSecurity) => void;
}) {
  return (
    <select
      className="sp-input"
      value={value}
      onChange={(event) => onChange(event.target.value as MailSocketSecurity)}
    >
      <option value="tls">TLS</option>
      <option value="starttls">STARTTLS</option>
      <option value="none">None / local bridge</option>
    </select>
  );
}
