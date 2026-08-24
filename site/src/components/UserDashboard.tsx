import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import type { Copy } from "../i18n";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  RefreshIcon,
  SmartphoneIcon,
  SparklesIcon,
  UserIcon,
} from "./icons";

type Props = {
  copy: Copy;
};

export default function UserDashboard({ copy }: Props) {
  const {
    user,
    dashboardOpen,
    closeDashboard,
    logout,
    refreshUser,
    formatTokens,
  } = useAuth();

  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!dashboardOpen || !user) return null;

  const { dashboard } = copy;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshUser();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  const handleCopyToken = () => {
    if (!user.token) return;
    navigator.clipboard.writeText(user.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const remaining = user.quota || 0;
  const used = user.used_quota || 0;
  const total = remaining + used;
  const remainingPercent =
    total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 100;

  const isPro = user.role > 1 || user.quota > 10_000_000;

  return (
    <div className="dashboard-overlay" onClick={closeDashboard}>
      <div
        className="dashboard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="dashboard-close-btn"
          onClick={closeDashboard}
          aria-label={dashboard.close}
        >
          <CloseIcon width={18} height={18} />
        </button>

        {/* Header */}
        <div className="dashboard-header">
          <div className="dashboard-avatar">
            <UserIcon width={28} height={28} />
          </div>
          <div className="dashboard-title-wrap">
            <div className="dashboard-user-row">
              <h2 id="dashboard-modal-title" className="dashboard-username">
                {user.display_name || user.username}
              </h2>
              <span
                className={`dashboard-badge ${
                  isPro ? "dashboard-badge--pro" : "dashboard-badge--free"
                }`}
              >
                <SparklesIcon width={12} height={12} />
                {isPro ? dashboard.tierPro : dashboard.tierFree}
              </span>
            </div>
            <p className="dashboard-uid">
              {dashboard.userId}: #{user.id} · {user.email || dashboard.unbound}
            </p>
          </div>
        </div>

        <div className="dashboard-content">
          {/* AI Compute Quota Card */}
          <div className="dashboard-card dashboard-card--quota">
            <div className="card-header">
              <span className="card-kicker">{dashboard.quotaKicker}</span>
              <button
                type="button"
                className={`quota-refresh-btn ${
                  refreshing ? "quota-refresh-btn--spin" : ""
                }`}
                onClick={handleRefresh}
                disabled={refreshing}
                title={dashboard.quotaRefresh}
              >
                <RefreshIcon width={15} height={15} />
                <span>{refreshing ? dashboard.quotaRefreshing : dashboard.quotaRefresh}</span>
              </button>
            </div>

            <div className="quota-metric-large">
              <span className="quota-number">{formatTokens(remaining)}</span>
              <span className="quota-label">{dashboard.quotaRemaining}</span>
            </div>

            <div className="quota-progress-bar">
              <div
                className="quota-progress-fill"
                style={{ width: `${remainingPercent}%` }}
              />
            </div>

            <div className="quota-submetrics">
              <div className="submetric">
                <span className="submetric-label">{dashboard.quotaUsed}</span>
                <span className="submetric-val">{formatTokens(used)}</span>
              </div>
              <div className="submetric">
                <span className="submetric-label">{dashboard.quotaRemaining}</span>
                <span className="submetric-val">{remainingPercent.toFixed(1)}%</span>
              </div>
            </div>
          </div>

          {/* Remote Workbench Card */}
          <div className="dashboard-card dashboard-card--remote">
            <div className="card-header">
              <span className="card-kicker">{dashboard.remoteKicker}</span>
            </div>
            <div className="remote-card-body">
              <div className="remote-card-text">
                <h3 className="remote-title">{dashboard.remoteTitle}</h3>
                <p className="remote-desc">{dashboard.remoteDesc}</p>
              </div>
              <a
                className="btn btn--primary remote-launch-btn"
                href="./remote/"
                target="_blank"
                rel="noreferrer noopener"
              >
                <SmartphoneIcon width={16} height={16} />
                <span>{dashboard.openRemoteBtn}</span>
              </a>
            </div>
          </div>

          {/* API Token / Secret Card (Optional copy) */}
          {user.token && (
            <div className="dashboard-card dashboard-card--token">
              <div className="card-header">
                <span className="card-kicker">{dashboard.securityKicker}</span>
              </div>
              <p className="token-desc">{dashboard.tokenDesc}</p>
              <div className="token-box">
                <code className="token-code">
                  {user.token.slice(0, 8)}••••••••••••••••••••{user.token.slice(-6)}
                </code>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm token-copy-btn"
                  onClick={handleCopyToken}
                >
                  {copied ? (
                    <>
                      <CheckIcon width={14} height={14} />
                      <span>{dashboard.copied}</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon width={14} height={14} />
                      <span>{dashboard.copyToken}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="dashboard-footer">
          <button
            type="button"
            className="btn btn--ghost dashboard-logout-btn"
            onClick={logout}
          >
            {dashboard.logout}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={closeDashboard}
          >
            {dashboard.close}
          </button>
        </div>
      </div>
    </div>
  );
}
