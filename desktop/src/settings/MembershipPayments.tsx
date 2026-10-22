import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  newapiBootstrap, newapiPaymentCatalog, newapiPaymentCheckout, openExternalUrl,
  type NewApiAccount, type PaymentCatalog, type PaymentCheckout, type PaymentOffer,
} from "../api/tauri";
import { getAccountSessionRevision, writeCachedAccount } from "../accountCache";
import { formatUserFacingError } from "../errorMessage";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import { accountMenuPlan, isPaidAccountPlan } from "../accountMenuPlan";
import "./MembershipPayments.css";

const COPY = {
  cn: {
    title: "购买月度会员", close: "收起购买", single: "单次购买 · 不自动续费", plans: "选择套餐",
    upgrade: "会员升级", currentPlan: "当前套餐", upgradeTerms: "按所选套餐整月价格购买，不抵扣原套餐费用。", topPlan: "Pro 已是最高等级；再次购买会从本次付款起算新的月度周期。",
    loading: "正在读取当前账号的套餐价格…", retry: "重新读取价格", account: "购买账号", month: "1 个月",
    credits: "本期模型积分", alipay: "支付宝", method: "支付方式", cashier: "在浏览器打开支付宝电脑收银台，可扫码付款。",
    terms: "付款核验后生效一个月，积分随本期到期失效。已有套餐时，新购月份从本次付款起算，不顺延已有套餐。",
    consent: "我已核对套餐、金额，并同意", agreement: "用户服务协议", pay: "确认并前往支付宝支付",
    creating: "正在创建订单…", unavailable: "支付宝电脑支付暂不可用，请稍后重新检查。",
    studentUnavailable: "暂时无法核对学生身份，当前显示公开价格。可稍后重新读取价格。",
    student: "学生优惠", promotion: "优惠价", total: "本次实付", order: "订单号",
    pending: "付款后返回客户端，刷新账户查看实际会员与积分。收银台打开不代表付款成功。",
    reopen: "重新打开当前收银台", refresh: "刷新账户", refreshing: "正在核对账户…", chooseAgain: "重新选择套餐",
    uncertain: "暂时无法确认订单状态。请先核对账户，避免重复购买。", browserFailed: "浏览器未能打开，请重新打开当前收银台。",
    stale: "价格或权益已更新，请重新读取价格并核对后购买。", studentRequired: "学生认证已失效，请重新读取价格。",
    studentFailed: "暂时无法核对学生身份，请稍后重试。", invalid: "支付信息校验失败，请重新读取价格后重试。",
    changed: "登录账号已变化，请重新打开购买入口。", busy: "已有订单正在创建，请稍候。",
  },
  en: {
    title: "Buy a monthly plan", close: "Close purchase", single: "One payment · No auto-renewal", plans: "Choose a plan",
    upgrade: "Upgrade membership", currentPlan: "Current plan", upgradeTerms: "The selected plan is billed for a full month, without a credit for your existing plan.", topPlan: "Pro is the highest tier. Another purchase starts a new monthly period from this payment.",
    loading: "Loading prices for your account…", retry: "Reload prices", account: "Account", month: "1 month",
    credits: "Model credits for this period", alipay: "Alipay", method: "Payment method", cashier: "Open the Alipay desktop cashier in your browser and pay by QR code.",
    terms: "Your month starts after payment verification. Credits expire with this period. A new purchase starts from this payment and does not extend an existing period.",
    consent: "I have checked the plan and amount and agree to the", agreement: "User Service Agreement", pay: "Confirm and pay with Alipay",
    creating: "Creating order…", unavailable: "Alipay desktop payments are temporarily unavailable. Please check again later.",
    studentUnavailable: "Student eligibility could not be checked. Public prices are shown. You can reload prices later.",
    student: "Student price", promotion: "Special price", total: "Total due", order: "Order number",
    pending: "After payment, return here and refresh your account to check membership and credits. Opening the cashier does not confirm payment.",
    reopen: "Reopen current cashier", refresh: "Refresh account", refreshing: "Checking account…", chooseAgain: "Choose a plan again",
    uncertain: "The order status could not be confirmed. Check your account before purchasing again.", browserFailed: "The browser could not open. Reopen the current cashier to continue.",
    stale: "Prices or benefits changed. Reload prices and review your purchase again.", studentRequired: "Student eligibility expired. Please reload prices.",
    studentFailed: "Student eligibility could not be checked. Please try again later.", invalid: "Payment details could not be verified. Please reload prices.",
    changed: "The signed-in account changed. Reopen the purchase panel.", busy: "An order is already being created. Please wait.",
  },
};

const planName = (group: PaymentOffer["group"]) => ({ go: "Go", plus: "Plus", pro: "Pro" })[group];

export default function MembershipPayments({ language, account, active, onClose }: {
  language: Language; account: NewApiAccount; active: boolean; onClose: () => void;
}) {
  const t = COPY[language];
  const currentPlan = accountMenuPlan(account, language);
  const paidMembership = isPaidAccountPlan(currentPlan.tier);
  const titleId = useId();
  const [catalog, setCatalog] = useState<PaymentCatalog | null>(null);
  const [selectedPlan, setSelected] = useState<PaymentOffer["group"] | null>(null);
  const selected = selectedPlan ?? (currentPlan.tier === "go" ? "plus" : paidMembership ? "pro" : "go");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkout, setCheckout] = useState<PaymentCheckout | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [accountChecked, setAccountChecked] = useState(false);
  const mountedRef = useRef(false);
  const creatingRef = useRef(false);
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);
  const sessionRef = useRef(getAccountSessionRevision());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const current = () => mountedRef.current && getAccountSessionRevision() === sessionRef.current;
  const price = (fen: number) => new Intl.NumberFormat(language === "cn" ? "zh-CN" : "en-US", {
    style: "currency", currency: "CNY", minimumFractionDigits: 2,
  }).format(fen / 100);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const message = (failure: unknown) => {
    const code = String(failure);
    if (code.includes("PAYMENT_ORDER_UNCERTAIN")) return t.uncertain;
    if (code.includes("PAYMENT_STALE_PRICE")) return t.stale;
    if (code.includes("PAYMENT_STUDENT_REQUIRED")) return t.studentRequired;
    if (code.includes("PAYMENT_STUDENT_UNAVAILABLE")) return t.studentFailed;
    if (code.includes("PAYMENT_ACCOUNT_CHANGED")) return t.changed;
    if (code.includes("PAYMENT_IN_PROGRESS")) return t.busy;
    if (code.includes("PAYMENT_INVALID_")) return t.invalid;
    if (code.includes("PAYMENT_UNAVAILABLE")) return t.unavailable;
    return formatUserFacingError(failure, language);
  };

  const load = async () => {
    if (!current() || loadingRef.current || creatingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setConsent(false);
    setError("");
    setCatalog(null);
    try {
      const next = await newapiPaymentCatalog();
      if (current()) setCatalog(next);
    } catch (failure) {
      if (current()) setError(message(failure));
    } finally {
      loadingRef.current = false;
      if (current()) setLoading(false);
    }
  };

  const refreshAccount = useCallback(async () => {
    if (!current() || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError("");
    try {
      const next = await newapiBootstrap();
      if (!current()) return;
      writeCachedAccount(next);
      setAccountChecked(true);
    } catch (failure) {
      if (current()) setError(formatUserFacingError(failure, language));
    } finally {
      refreshingRef.current = false;
      if (current()) setRefreshing(false);
    }
  }, [language]);

  useEffect(() => {
    if (!active) return;
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
    headingRef.current?.focus({ preventScroll: true });
    if (!catalog && !checkout && !uncertain) void load();
    // Preserve the quote and current order while switching settings pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || (!checkout && !uncertain)) return;
    const onFocus = () => { void refreshAccount(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, checkout, uncertain, refreshAccount]);

  const reopen = async (order: PaymentCheckout) => {
    try { await openExternalUrl(order.cashierUrl); }
    catch { if (current()) setError(t.browserFailed); }
  };

  const offer = catalog?.offers.find((item) => item.group === selected);
  const canPay = current() && Boolean(offer && consent && catalog?.purchaseEnabled && catalog.pagePayEnabled)
    && !loading && !creating && !checkout && !uncertain;
  const pay = async () => {
    if (!canPay || !offer || !catalog || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError("");
    setAccountChecked(false);
    try {
      const order = await newapiPaymentCheckout({ userId: catalog.userId, group: offer.group,
        expectedRevision: offer.revision, expectedFen: offer.priceFen, priceKind: offer.priceKind });
      if (!current()) return;
      // Keep this order if opening the browser fails. Retrying opens the same
      // cashier instead of creating another payable order.
      setCheckout(order);
      await reopen(order);
    } catch (failure) {
      if (!current()) return;
      setConsent(false);
      const code = String(failure);
      setError(code.includes("PAYMENT_ORDER_UNCERTAIN") ? "" : message(failure));
      if (code.includes("PAYMENT_ORDER_UNCERTAIN") || code.includes("PAYMENT_INVALID_ORDER")
        || code.includes("PAYMENT_INVALID_CASHIER")) setUncertain(true);
      else setCatalog(null);
    } finally {
      creatingRef.current = false;
      if (current()) setCreating(false);
    }
  };

  if (!active) return null;
  return <section className="sp-membership" aria-labelledby={titleId}>
    <div className="sp-membership-heading">
      <div><h3 ref={headingRef} tabIndex={-1} id={titleId}>{paidMembership ? t.upgrade : t.title}</h3><p>{t.single}</p></div>
      <button className="sp-btn sp-btn-secondary" type="button" onClick={onClose} disabled={creating} aria-label={t.close}>
        <SvgIcon name="close" size={14} />
      </button>
    </div>
    {error && <p className="sp-membership-error" role="alert">{error}</p>}
    {loading && <p role="status">{t.loading}</p>}
    {checkout || uncertain ? <div className="sp-membership-pending">
      <p role="status">{uncertain ? t.uncertain : t.pending}</p>
      {checkout && <p className="sp-membership-order">{t.order}: {checkout.tradeNo}</p>}
      <div className="sp-membership-actions">
        {checkout && <button className="sp-btn sp-btn-primary" type="button" onClick={() => { setError(""); void reopen(checkout); }}>{t.reopen}</button>}
        <button className="sp-btn sp-btn-secondary" type="button" disabled={refreshing} onClick={() => { void refreshAccount(); }}>{refreshing ? t.refreshing : t.refresh}</button>
        {accountChecked && <button className="sp-btn sp-btn-secondary" type="button" onClick={() => {
          setCheckout(null); setUncertain(false); setAccountChecked(false); void load();
        }}>{t.chooseAgain}</button>}
      </div>
    </div> : <>
      {catalog && <>
        <p>{t.currentPlan}: <strong>{currentPlan.label}</strong></p>
        {currentPlan.tier === "pro" && <p>{t.topPlan}</p>}
        <div className="sp-membership-plans" role="group" aria-label={t.plans}>
          {catalog.offers.map((item) => <button type="button" className="sp-membership-plan" key={item.group}
            aria-pressed={item.group === selected} disabled={creating} onClick={() => {
              setSelected(item.group); setConsent(false); setError("");
            }}>
            <strong>{planName(item.group)}</strong>
            {item.group === currentPlan.tier && <span className="sp-membership-current">{t.currentPlan}</span>}
            <span className="sp-membership-price">{price(item.priceFen)} <small>/ {t.month}</small></span>
            <span>{(item.totalAmount / 5_000).toLocaleString(language === "cn" ? "zh-CN" : "en-US")} {t.credits}</span>
            {item.priceKind !== "original" && <span className="sp-membership-discount">{item.priceKind === "student" ? t.student : t.promotion} <del>{price(item.originalFen)}</del></span>}
          </button>)}
        </div>
        <dl className="sp-membership-summary">
          <div><dt>{t.account}</dt><dd>{account.username}</dd></div>
          <div><dt>{t.method}</dt><dd>{t.alipay}</dd></div>
          {offer && <div><dt>{t.total}</dt><dd>{price(offer.priceFen)}</dd></div>}
        </dl>
        <p>{t.cashier}</p>
        <p id={`${titleId}-terms`}>{paidMembership && `${t.upgradeTerms} `}{t.terms}</p>
        {catalog.studentCheckUnavailable && <p role="status">{t.studentUnavailable}</p>}
        {(!catalog.purchaseEnabled || !catalog.pagePayEnabled) && <p role="status">{t.unavailable}</p>}
        <div className="sp-membership-consent">
          <label><input type="checkbox" checked={consent} disabled={creating} aria-describedby={`${titleId}-terms`}
            onChange={(event) => setConsent(event.target.checked)} />{t.consent}</label>
          <a href={`https://ensuanx.com/user-service-agreement.html?lang=${language === "cn" ? "zh" : "en"}`}
            onClick={(event) => { event.preventDefault(); void openExternalUrl(event.currentTarget.href).catch((failure) => setError(message(failure))); }}>
            {t.agreement}
          </a>
        </div>
      </>}
      <div className="sp-membership-actions">
        {catalog && <button className="sp-btn sp-btn-primary" type="button" disabled={!canPay} onClick={() => { void pay(); }}>
          {creating ? t.creating : t.pay}
        </button>}
        <button className="sp-btn sp-btn-secondary" type="button" disabled={loading || creating} onClick={() => { void load(); }}>{t.retry}</button>
      </div>
    </>}
  </section>;
}
