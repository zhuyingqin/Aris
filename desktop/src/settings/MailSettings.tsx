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
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import { SETTINGS_COPY, type SettingsMailCopy } from "./i18n";

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

function providerLabel(provider: MailAccount["provider"], copy: SettingsMailCopy) {
  if (provider === "gmail" || provider === "outlook") return copy.providerApiBadge;
  return "IMAP/SMTP";
}

function providerAuthNotice(email: string, copy: SettingsMailCopy): string | null {
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

function accountSummary(accounts: MailAccount[], copy: SettingsMailCopy) {
  const connected = accounts.filter((account) => account.connected).length;
  if (accounts.length === 0) return copy.accountSummaryEmpty;
  return copy.accountSummary(connected, accounts.length);
}

export default function MailSettings({ onOpen }: { onOpen: () => void }) {
  const language = useStore((state) => state.language);
  const copy = SETTINGS_COPY[language].mail;
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
              <span className="sp-role-badge sp-role-mail">{copy.autoconfigBadge}</span>
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
  const copy = SETTINGS_COPY[language].mail;
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
        message: copy.mailboxConnectedMessage,
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
          <span className="sp-role-badge sp-role-mail">{copy.providerApiBadge}</span>
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
              {busy === "gmail" ? copy.connecting : copy.continueWithGmail}
            </button>
            <button
              className="sp-btn sp-btn-secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void connectProvider("outlook")}
            >
              {busy === "outlook" ? copy.connecting : copy.continueWithOutlook}
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

        <div className="mail-settings-subtitle">{copy.incomingImapTitle}</div>
        <div className="mail-settings-grid">
          <Field label={copy.fieldHost}>
            <input
              className="sp-input"
              value={form.imapHost}
              placeholder="imap.example.com"
              onChange={(event) => patch({ imapHost: event.target.value })}
            />
          </Field>
          <Field label={copy.fieldPort}>
            <input
              className="sp-input"
              type="number"
              value={form.imapPort}
              onChange={(event) => patch({ imapPort: Number(event.target.value) })}
            />
          </Field>
          <Field label={copy.fieldSecurity}>
            <SecuritySelect value={form.imapSecurity} onChange={(value) => patch({ imapSecurity: value })} copy={copy} />
          </Field>
          <Field label={copy.fieldUsername}>
            <input
              className="sp-input"
              value={form.imapUsername}
              placeholder={copy.defaultEmail}
              onChange={(event) => patch({ imapUsername: event.target.value })}
            />
          </Field>
          <Field label={copy.fieldPassword}>
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
            <div className="mail-settings-subtitle">{copy.outgoingSmtpTitle}</div>
            <div className="mail-settings-grid">
              <Field label={copy.fieldHost}>
                <input
                  className="sp-input"
                  value={form.smtpHost ?? ""}
                  placeholder="smtp.example.com"
                  onChange={(event) => patch({ smtpHost: event.target.value })}
                />
              </Field>
              <Field label={copy.fieldPort}>
                <input
                  className="sp-input"
                  type="number"
                  value={form.smtpPort ?? 465}
                  onChange={(event) => patch({ smtpPort: Number(event.target.value) })}
                />
              </Field>
              <Field label={copy.fieldSecurity}>
                <SecuritySelect
                  value={form.smtpSecurity ?? "tls"}
                  onChange={(value) => patch({ smtpSecurity: value })}
                  copy={copy}
                />
              </Field>
              <Field label={copy.fieldUsername}>
                <input
                  className="sp-input"
                  value={form.smtpUsername ?? ""}
                  placeholder={copy.defaultImapUser}
                  onChange={(event) => patch({ smtpUsername: event.target.value })}
                />
              </Field>
              <Field label={copy.fieldPassword}>
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
                    {providerLabel(account.provider, copy)}
                    {!account.connected && copy.disconnectedSuffix}
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
  copy,
}: {
  value: MailSocketSecurity;
  onChange: (value: MailSocketSecurity) => void;
  copy: SettingsMailCopy;
}) {
  return (
    <select
      className="sp-input"
      value={value}
      onChange={(event) => onChange(event.target.value as MailSocketSecurity)}
    >
      <option value="tls">TLS</option>
      <option value="starttls">STARTTLS</option>
      <option value="none">{copy.securityNoneOption}</option>
    </select>
  );
}
