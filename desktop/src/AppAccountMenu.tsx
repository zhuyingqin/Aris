import type { KeyboardEventHandler, Ref } from "react";
import { SvgIcon } from "./SvgIcon";
import type { Language } from "./store";
import type { AccountMenuPlan } from "./accountMenuPlan";
import { formatQuota } from "./settings/settingsFormatters";

interface Props {
  language: Language;
  name: string;
  initials: string;
  avatar: string | null;
  plan: AccountMenuPlan;
  open: boolean;
  rootRef?: Ref<HTMLDivElement>;
  triggerRef?: Ref<HTMLButtonElement>;
  onMenuKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onToggle: () => void;
  onSettings: () => void;
  onLogout: () => void;
}

const COPY = {
  cn: { menu: "用户菜单", quota: "套餐额度", remaining: "剩余额度", remainingPercent: (percent: number) => `剩余 ${percent}%`, unavailable: "额度信息暂不可用", settings: "设置", logout: "退出登录" },
  en: { menu: "User menu", quota: "Plan allowance", remaining: "Remaining allowance", remainingPercent: (percent: number) => `${percent}% remaining`, unavailable: "Allowance unavailable", settings: "Settings", logout: "Sign out" },
};

const UsageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.3 11.8a5.8 5.8 0 119.4 0M8 8.4l2.6-2.6M5 12.8h6" />
  </svg>
);

const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 3H3.8a1 1 0 00-1 1v8a1 1 0 001 1h2.7M9.5 5.2L12.3 8l-2.8 2.8M12.1 8H6.2" />
  </svg>
);

export default function AppAccountMenu({ language, name, initials, avatar, plan, open, rootRef, triggerRef, onMenuKeyDown, onToggle, onSettings, onLogout }: Props) {
  const copy = COPY[language];
  const amount = plan.remaining === null ? "—" : formatQuota(plan.remaining);
  const renderAvatar = (profile = false) => (
    <span className={`account-tier-avatar ${profile ? "account-menu-profile-avatar" : "sidebar-user-avatar"}`} aria-hidden="true">
      {avatar ? <img src={avatar} alt="" /> : initials}
    </span>
  );

  return (
    <div className="app-account" data-plan-tier={plan.tier} ref={rootRef}>
      {open && (
        <div className="sidebar-user-menu account-menu-popover" role="menu" aria-label={copy.menu} onKeyDown={onMenuKeyDown}>
          <div className="account-menu-profile" role="presentation">
            {renderAvatar(true)}
            <div className="account-menu-identity">
              <strong title={name}>{name}</strong>
              <span className="account-menu-plan" title={plan.label}>
                {plan.tier === "pro" && <SvgIcon name="sparkle" size={12} />}
                {plan.label}
              </span>
            </div>
          </div>
          <section className="account-menu-quota" role="group" aria-label={copy.quota}>
            <div className="account-menu-quota-title"><UsageIcon /><strong>{copy.quota}</strong></div>
            <div className="account-menu-quota-summary">
              <span>{plan.remaining === null ? copy.unavailable : copy.remaining}</span>
              <strong>{amount}</strong>
            </div>
            {plan.remainingPercent !== null && (
              <>
                <div className="account-menu-meter" role="progressbar" aria-label={copy.remaining} aria-valuemin={0} aria-valuemax={100} aria-valuenow={plan.remainingPercent} aria-valuetext={`${copy.remainingPercent(plan.remainingPercent)} · ${amount}`}>
                  <span style={{ width: `${plan.remainingPercent}%` }} />
                </div>
                <span className="account-menu-quota-caption">{copy.remainingPercent(plan.remainingPercent)}</span>
              </>
            )}
          </section>
          <div className="account-menu-divider" role="separator" />
          <button className="sidebar-user-menu-row account-menu-action" type="button" role="menuitem" data-onboarding-target="user-settings" onClick={onSettings}>
            <SvgIcon name="settings" size={16} /><span>{copy.settings}</span><span className="account-menu-shortcut">Ctrl+,</span>
          </button>
          <button className="sidebar-user-menu-row account-menu-action" type="button" role="menuitem" onClick={onLogout}>
            <LogoutIcon /><span>{copy.logout}</span>
          </button>
        </div>
      )}
      <button ref={triggerRef} className="app-account-button account-menu-trigger" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={copy.menu} title={`${name} · ${plan.label}`} data-onboarding-target="user-menu" onClick={onToggle}>
        {renderAvatar()}
        {plan.tier === "pro" && <span className="account-menu-pro-mark" aria-hidden="true"><SvgIcon name="sparkle" size={9} /></span>}
      </button>
    </div>
  );
}
