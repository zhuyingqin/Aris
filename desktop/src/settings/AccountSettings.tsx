import { useEffect, useRef, useState, type ReactNode } from "react";
import { newapiUsageLogs, type NewApiAccount, type NewApiUsageLogPage } from "../api/tauri";
import { hasNativeBackend } from "../api/transport";
import { formatUserFacingError } from "../errorMessage";
import { readCachedUsageLogPages, writeCachedUsageLogPages } from "../accountCache";
import { epochToDate } from "../timestamp";
import { SvgIcon } from "../SvgIcon";
import { useStore, type Language } from "../store";
import { SETTINGS_COPY } from "./i18n";
import {
  formatQuota,
  formatUsageDate,
  formatUsageExact,
  quotaPercent,
  shortUsageId,
  subscriptionQuotaPercent,
  usageLogMeta,
} from "./settingsFormatters";
import { PREVIEW_SETTINGS_DATA, USAGE_LOG_PAGE_SIZE } from "./settingsPreviewData";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";

interface Props {
  language: Language;
  account: NewApiAccount | null;
  accountLoading: boolean;
  active?: boolean;
  onRefreshAccount: () => Promise<void>;
  children?: ReactNode;
}

export default function AccountSettings({
  language,
  account,
  accountLoading,
  active = true,
  onRefreshAccount,
  children,
}: Props) {
  const setError = useStore((state) => state.setError);
  const logout = useStore((state) => state.logout);
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const previewData = PREVIEW_SETTINGS_DATA[language];
  const PREVIEW_USAGE_LOGS = previewData.usageLogs;

  const [usageLoading, setUsageLoading] = useState(false);
  const [usageLogPage, setUsageLogPage] = useState(1);
  const [usageLogPages, setUsageLogPages] = useState<Record<number, NewApiUsageLogPage>>(() =>
    hasNativeBackend() ? readCachedUsageLogPages() : { [PREVIEW_USAGE_LOGS.page]: PREVIEW_USAGE_LOGS },
  );
  const [usageLogs, setUsageLogs] = useState<NewApiUsageLogPage | null>(() =>
    hasNativeBackend() ? readCachedUsageLogPages()[1] ?? null : PREVIEW_USAGE_LOGS,
  );
  const [usageLogError, setUsageLogError] = useState("");
  const usageLogPagesRef = useRef(usageLogPages);
  const usageRefreshPendingRef = useRef(false);
  const mountedRef = useRef(false);
  const requestPendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    usageLogPagesRef.current = usageLogPages;
  }, [usageLogPages]);

  const cacheUsageLogPage = (pageData: NewApiUsageLogPage, reset = false) => {
    setUsageLogPages((current) => {
      const next = reset ? {} : { ...current };
      next[pageData.page] = pageData;
      usageLogPagesRef.current = next;
      writeCachedUsageLogPages(next);
      return next;
    });
    setUsageLogs(pageData);
  };

  const loadUsageSummary = async (page = usageLogPage, options: { force?: boolean; refreshAccount?: boolean } = {}) => {
    if (!active || requestPendingRef.current) return;
    const cachedLogs = usageLogPagesRef.current[page];
    if (!options.force && cachedLogs) {
      setUsageLogs(cachedLogs);
      setUsageLogError("");
      return;
    }
    if (!hasNativeBackend()) {
      cacheUsageLogPage({ ...PREVIEW_USAGE_LOGS, page });
      return;
    }
    setUsageLoading(true);
    requestPendingRef.current = true;
    setUsageLogError("");
    try {
      if (options.refreshAccount || !account) {
        await onRefreshAccount();
      }
      if (!mountedRef.current) return;
      const nextLogs = await newapiUsageLogs(page, USAGE_LOG_PAGE_SIZE);
      if (!mountedRef.current) return;
      cacheUsageLogPage(nextLogs, options.force);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatUserFacingError(error, language);
      setUsageLogError(message);
      if (cachedLogs) {
        setUsageLogs(cachedLogs);
      }
      setError(message);
    } finally {
      requestPendingRef.current = false;
      if (mountedRef.current) setUsageLoading(false);
    }
  };

  const refreshUsage = () => {
    const firstPage = 1;
    setUsageLogPages({});
    usageLogPagesRef.current = {};
    writeCachedUsageLogPages({});
    setUsageLogs(null);
    usageRefreshPendingRef.current = true;
    if (usageLogPage === firstPage) {
      void loadUsageSummary(firstPage, { force: true, refreshAccount: true });
      usageRefreshPendingRef.current = false;
    } else {
      setUsageLogPage(firstPage);
    }
  };

  const goToUsageLogPage = (page: number) => {
    const nextPage = Math.max(1, page);
    setUsageLogs(usageLogPagesRef.current[nextPage] ?? null);
    setUsageLogError("");
    setUsageLogPage(nextPage);
  };

  useEffect(() => {
    if (!hasNativeBackend() || !active || !account) return;
    const refreshAccount = usageRefreshPendingRef.current;
    usageRefreshPendingRef.current = false;
    void loadUsageSummary(usageLogPage, refreshAccount ? { force: true, refreshAccount: true } : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageLogPage, active, account?.username]);

  const accountUsedQuota = account?.usedQuota ?? 0;
  const accountRemainingQuota = account?.quota ?? 0;
  const accountTotalQuota = accountUsedQuota + accountRemainingQuota;
  const accountUsagePercent = account ? quotaPercent(account) : 0;
  const subscriptionUsedQuota = account?.subscriptionUsedQuota ?? 0;
  const subscriptionRemainingQuota = account?.subscriptionQuota ?? 0;
  const subscriptionTotalQuota = subscriptionUsedQuota + subscriptionRemainingQuota;
  const subscriptionUsagePercent = account ? subscriptionQuotaPercent(account) : 0;
  const accountPageRefreshing = accountLoading || usageLoading;
  const usageLogTotal = usageLogs?.total ?? 0;
  const usageLogItems = usageLogs?.items ?? [];
  const usageLogPageCount = Math.max(1, Math.ceil(usageLogTotal / USAGE_LOG_PAGE_SIZE));
  const usageLogStart = usageLogTotal > 0 ? (usageLogPage - 1) * USAGE_LOG_PAGE_SIZE + 1 : 0;
  const usageLogEnd = usageLogTotal > 0 ? Math.min(usageLogStart + usageLogItems.length - 1, usageLogTotal) : 0;
  const canGoPrevUsageLogPage = usageLogPage > 1 && !usageLoading;
  const canGoNextUsageLogPage = usageLogPage < usageLogPageCount && !usageLoading;

  return (
    <div className="sp-account-section sp-account-usage-section">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{SETTINGS_LAYOUT_COPY[language].accountOverview}</div>
        </div>
        <div className="sp-update-actions">
          <button className="sp-btn sp-btn-secondary" onClick={refreshUsage} disabled={accountPageRefreshing} type="button">
            <SvgIcon name={accountPageRefreshing ? "spinner" : "refresh"} size={13} />
            {accountPageRefreshing ? copy.authRefreshing : copy.authRefresh}
          </button>
          <button className="sp-btn sp-btn-secondary" onClick={logout} type="button">
            <SvgIcon name="close" size={13} />
            {copy.authLogout}
          </button>
        </div>
      </div>

      {account ? (
        <>
          <div className="sp-usage-hero">
            <article className="sp-usage-quota-card account">
              <div className="sp-usage-quota-head">
                <span className="sp-usage-quota-icon"><SvgIcon name="credit" size={17} /></span>
                <div>
                  <span>{copy.accountTotalQuota}</span>
                  <strong>{formatQuota(accountTotalQuota)}</strong>
                </div>
                <span className="sp-usage-quota-percent">{accountUsagePercent}%</span>
              </div>
              <div className="sp-usage-progress" aria-label={`${copy.accountUsageRatio} ${accountUsagePercent}%`}>
                <div style={{ width: `${accountUsagePercent}%` }} />
              </div>
              <div className="sp-usage-quota-breakdown">
                <div>
                  <span>{copy.accountUsedQuota}</span>
                  <strong>{formatQuota(accountUsedQuota)}</strong>
                  <small>{formatUsageExact(accountUsedQuota)} {copy.creditUnit}</small>
                </div>
                <div>
                  <span>{copy.accountBalance}</span>
                  <strong>{formatQuota(accountRemainingQuota)}</strong>
                  <small>{formatUsageExact(accountRemainingQuota)} {copy.creditUnit}</small>
                </div>
              </div>
            </article>

            <article className="sp-usage-quota-card subscription">
              <div className="sp-usage-quota-head">
                <span className="sp-usage-quota-icon"><SvgIcon name="sparkle" size={17} /></span>
                <div>
                  <span>{copy.authSubscriptionLabel}</span>
                  <strong>{formatQuota(subscriptionTotalQuota)}</strong>
                </div>
                <span className="sp-usage-quota-percent">{subscriptionUsagePercent}%</span>
              </div>
              <div className="sp-usage-progress" aria-label={`${copy.subscriptionUsageRatio} ${subscriptionUsagePercent}%`}>
                <div style={{ width: `${subscriptionUsagePercent}%` }} />
              </div>
              <div className="sp-usage-quota-breakdown">
                <div>
                  <span>{copy.subscriptionUsed}</span>
                  <strong>{formatQuota(subscriptionUsedQuota)}</strong>
                  <small>{formatUsageExact(subscriptionUsedQuota)} {copy.creditUnit}</small>
                </div>
                <div>
                  <span>{copy.subscriptionBalance}</span>
                  <strong>{formatQuota(subscriptionRemainingQuota)}</strong>
                  <small>{formatUsageExact(subscriptionRemainingQuota)} {copy.creditUnit}</small>
                </div>
              </div>
            </article>
          </div>
        </>
      ) : null}
      {children}
      {account ? (
        <>
          <div className="sp-usage-detail-panel">
            <div className="sp-usage-card-head">
              <div className="sp-usage-card-title">{copy.callDetails}</div>
              <div className="sp-usage-card-range">
                {usageLogTotal > 0 ? copy.usageRange(usageLogStart, usageLogEnd, usageLogTotal) : copy.usageNoRecords}
              </div>
            </div>
            {usageLogError && usageLogItems.length > 0 && (
              <div className="sp-usage-foot">{usageLogError}</div>
            )}
            {usageLogError && usageLogItems.length === 0 ? (
              <div className="sp-usage-empty">{usageLogError}</div>
            ) : usageLoading && !usageLogs ? (
              <div className="sp-usage-empty">{copy.usageLoading}</div>
            ) : usageLogItems.length > 0 ? (
              <>
                <div className="sp-usage-table">
                  <div className="sp-usage-row sp-usage-row-call sp-usage-row-head">
                    <span>{copy.usageHeaders.time}</span>
                    <span>{copy.usageHeaders.model}</span>
                    <span>{copy.usageHeaders.token}</span>
                    <span>{copy.usageHeaders.tokens}</span>
                    <span>{copy.usageHeaders.quota}</span>
                    <span>{copy.usageHeaders.request}</span>
                  </div>
                  {usageLogItems.map((entry) => {
                    const requestId = entry.requestId || entry.upstreamRequestId;
                    const meta = usageLogMeta(entry.status, entry.typeLabel, language);
                    const createdAtDate = epochToDate(entry.createdAt);
                    return (
                      <div className="sp-usage-row sp-usage-row-call" key={entry.id}>
                        <span className="sp-usage-time" title={createdAtDate ? createdAtDate.toLocaleString() : undefined}>
                          {formatUsageDate(entry.createdAt)}
                        </span>
                        <span className="sp-usage-model" title={entry.model || undefined}>{entry.model || "-"}</span>
                        <span className="sp-usage-token" title={entry.tokenName || undefined}>{entry.tokenName || "-"}</span>
                        <span title={`${copy.systemPromptTitle} ${formatUsageExact(entry.promptTokens)} / ${copy.userPromptTitle} ${formatUsageExact(entry.completionTokens)}`}>
                          {formatUsageExact(entry.totalTokens)}
                        </span>
                        <span title={`${formatUsageExact(entry.quota)} ${copy.creditUnit}${meta ? ` · ${meta}` : ""}`}>{formatQuota(entry.quota)}</span>
                        <span className="sp-usage-request" title={requestId || undefined}>{shortUsageId(requestId)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="sp-usage-pagination">
                  <div className="sp-usage-pagination-summary">
                    {copy.usagePageSummary(USAGE_LOG_PAGE_SIZE, usageLogPage, usageLogPageCount)}
                  </div>
                  <div className="sp-usage-page-controls">
                    <button className="sp-usage-page-button" type="button" disabled={!canGoPrevUsageLogPage} onClick={() => goToUsageLogPage(usageLogPage - 1)}>
                      {copy.usagePrev}
                    </button>
                    <span className="sp-usage-page-indicator">{usageLoading ? "..." : usageLogPage}</span>
                    <button className="sp-usage-page-button" type="button" disabled={!canGoNextUsageLogPage} onClick={() => goToUsageLogPage(usageLogPage + 1)}>
                      {copy.usageNext}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="sp-usage-empty">{copy.usageEmpty}</div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
