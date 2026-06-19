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

function providerAuthNotice(email: string): string | null {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return "Gmail 的普通 Google 密码不能用于 IMAP LOGIN。优先使用 Continue with Gmail；只有已启用 IMAP 且生成了 Google 应用专用密码时，才使用下面的通用 IMAP/SMTP。";
  }
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain) || domain.endsWith(".onmicrosoft.com")) {
    return "Outlook.com / Microsoft 365 的密码式 IMAP/SMTP 路径不可用。请使用 Continue with Outlook 的 OAuth/Graph 连接。";
  }
  if (["126.com", "163.com", "yeah.net", "188.com"].includes(domain)) {
    return "网易邮箱需要先在网页端开启 IMAP/SMTP 服务，并使用客户端授权码作为密码。若出现 Unsafe Login，说明网易风控拒绝了当前客户端或登录环境，请先完成网页端安全验证，或联系 kefu@188.com。";
  }
  return null;
}

function accountSummary(accounts: MailAccount[]) {
  const connected = accounts.filter((account) => account.connected).length;
  if (accounts.length === 0) return "尚未连接邮箱";
  return `${connected}/${accounts.length} 个账户已连接`;
}

export default function MailSettings({ onOpen }: { onOpen: () => void }) {
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
              邮箱
              <span className="sp-role-badge sp-role-mail">Autoconfig</span>
              {connectedCount > 0 && <span className="sp-role-badge sp-role-running">已连接</span>}
            </div>
            <div className="sp-card-url">Provider API + IMAP/SMTP · Chat 可读取、整理和发送</div>
            <div className="sp-card-notes">{error ? "账户状态加载失败，进入详情页重试" : accountSummary(accounts)}</div>
          </div>
        </div>
        <div className="sp-card-actions" onClick={(event) => event.stopPropagation()}>
          <button className="sp-card-btn" title="配置邮箱" type="button" onClick={onOpen}>✎</button>
        </div>
      </div>
    </div>
  );
}

export function MailSettingsDetail() {
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
  const authNotice = useMemo(() => providerAuthNotice(form.email), [form.email]);

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
      setError("请先输入邮箱地址。");
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
          <div className="sp-field-label">邮箱连接</div>
          <div className="sp-field-hint">
            Gmail 和 Outlook 使用 OAuth/API。通用 IMAP/SMTP 仅用于仍支持授权码或应用专用密码的邮箱。
          </div>
        </div>
        <div className="mail-settings-summary-badges">
          <span className="sp-role-badge sp-role-mail">Provider API</span>
          <span className="sp-role-badge sp-role-mail">IMAP/SMTP</span>
          <span className={`sp-role-badge ${connectedCount > 0 ? "sp-role-running" : "sp-role-muted"}`}>
            {connectedCount > 0 ? `${connectedCount} 已连接` : "未连接"}
          </span>
        </div>
      </section>

      <section className="mail-settings-panel">
        <div className="mail-settings-oauth-card">
          <div className="mail-settings-oauth-copy">
            <strong>Gmail / Outlook 推荐连接方式</strong>
            <span>个人 Gmail、Outlook.com 和 Microsoft 365 应走 OAuth/API。不要在下面的通用 IMAP 表单里输入普通账户密码。</span>
          </div>
          <div className="mail-settings-oauth-actions">
            <button
              className="sp-btn sp-btn-primary"
              type="button"
              disabled={busy !== null}
              onClick={() => void connectProvider("gmail")}
            >
              {busy === "gmail" ? "连接中..." : "Continue with Gmail"}
            </button>
            <button
              className="sp-btn sp-btn-secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void connectProvider("outlook")}
            >
              {busy === "outlook" ? "连接中..." : "Continue with Outlook"}
            </button>
          </div>
        </div>

        <div className="mail-settings-panel-head">
          <div>
            <div className="sp-field-label">通用 IMAP/SMTP</div>
            <div className="sp-field-hint">先输入邮箱地址，自动发现服务器；再输入服务商授权码或应用专用密码测试连接。</div>
          </div>
        </div>

        <div className="sp-detail-row2">
          <Field label="邮箱地址">
            <input
              className="sp-input"
              value={form.email}
              placeholder="name@example.com"
              onChange={(event) => patch({ email: event.target.value })}
            />
          </Field>
          <Field label="显示名称">
            <input
              className="sp-input"
              value={form.displayName ?? ""}
              placeholder="发件时显示"
              onChange={(event) => patch({ displayName: event.target.value })}
            />
          </Field>
        </div>

        <div className="mail-settings-oauth-card">
          <div className="mail-settings-oauth-copy">
            <strong>自动发现 IMAP/SMTP</strong>
            <span>
              按 Thunderbird Autoconfig、Thunderbird ISPDB、内置服务商规则和通用域名猜测依次查找配置。
            </span>
            {discoveryResult && (
              <span>
                已使用：{discoveryResult.source}
                {discoveryResult.notes.length > 0 ? ` · ${discoveryResult.notes.join(" ")}` : ""}
              </span>
            )}
            {authNotice && <span className="mail-settings-oauth-warning">{authNotice}</span>}
          </div>
          <button
            className="sp-btn sp-btn-primary"
            type="button"
            disabled={busy !== null || !form.email.trim()}
            onClick={() => void discoverConfig()}
          >
            {busy === "discover" ? "发现中..." : "自动发现"}
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
              placeholder="默认使用邮箱地址"
              onChange={(event) => patch({ imapUsername: event.target.value })}
            />
          </Field>
          <Field label="Password">
            <input
              className="sp-input"
              type="password"
              value={form.imapPassword}
              placeholder="密码或应用专用密码"
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
            <strong>启用 SMTP 发件</strong>
            <span>关闭后 Chat 只能读取和整理邮件。</span>
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
                  placeholder="默认复用 IMAP 用户名"
                  onChange={(event) => patch({ smtpUsername: event.target.value })}
                />
              </Field>
              <Field label="Password">
                <input
                  className="sp-input"
                  type="password"
                  value={form.smtpPassword ?? ""}
                  placeholder="留空复用 IMAP 密码"
                  onChange={(event) => patch({ smtpPassword: event.target.value })}
                />
              </Field>
            </div>
          </>
        )}

        <div className="sp-detail-actions">
          <button className="sp-btn sp-btn-secondary" type="button" disabled={busy !== null} onClick={() => void testConnection()}>
            {busy === "test" ? "测试中..." : "测试连接"}
          </button>
          <button className="sp-btn sp-btn-primary" type="button" disabled={busy !== null} onClick={() => void connect()}>
            {busy === "connect" ? "连接中..." : "连接邮箱"}
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
            <div className="sp-field-label">已连接账户</div>
            <div className="sp-field-hint">{accounts.length > 0 ? accountSummary(accounts) : "连接后，Chat 和 Mail 页面会复用同一个账户服务。"}</div>
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
                  title="断开连接"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void disconnect(account.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mail-settings-empty">没有已连接的邮箱账户。</div>
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
