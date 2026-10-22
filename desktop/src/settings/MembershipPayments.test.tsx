// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  newapiBootstrap, newapiPaymentCatalog, newapiPaymentCheckout, openExternalUrl,
  type PaymentCatalog, type PaymentCheckout,
} from "../api/tauri";
import { readCachedAccount, writeCachedAccount } from "../accountCache";
import MembershipPayments from "./MembershipPayments";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";

vi.mock("../api/tauri", () => ({
  newapiBootstrap: vi.fn(), newapiPaymentCatalog: vi.fn(), newapiPaymentCheckout: vi.fn(), openExternalUrl: vi.fn(),
}));

const account = { ...PREVIEW_SETTINGS_DATA.cn.account, group: "default", subscriptionName: "", subscriptionDesc: "", subscriptionQuota: 0, subscriptionUsedQuota: 0 };
const catalog = (): PaymentCatalog => ({
  userId: 17, purchaseEnabled: true, pagePayEnabled: true, studentCheckUnavailable: false,
  offers: ["go", "plus", "pro"].map((group, index) => ({
    group: group as "go" | "plus" | "pro", planId: index + 8, priceFen: 1900 + index * 2000,
    originalFen: 2900 + index * 2000, promotionFen: 1900 + index * 2000, studentFen: null,
    totalAmount: (index + 1) * 30_000_000, priceKind: "promotion", revision: 2,
  })),
});
const checkout: PaymentCheckout = {
  cashierUrl: "https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=test",
  tradeNo: "SUBUSR17NOAbcd121792000000",
};
const renderPanel = (active = true) => render(<MembershipPayments language="cn" account={account} active={active} onClose={vi.fn()} />);
const agree = () => fireEvent.click(screen.getByRole("checkbox"));
const submit = () => fireEvent.click(screen.getByRole("button", { name: "确认并前往支付宝支付" }));

beforeEach(() => {
  vi.mocked(newapiPaymentCatalog).mockReset().mockResolvedValue(catalog());
  vi.mocked(newapiPaymentCheckout).mockReset().mockResolvedValue(checkout);
  vi.mocked(openExternalUrl).mockReset().mockResolvedValue(undefined);
  vi.mocked(newapiBootstrap).mockReset().mockResolvedValue({ ...account, group: "go", subscriptionQuota: 30_000_000 });
  writeCachedAccount(account);
});
afterEach(() => { cleanup(); writeCachedAccount(null); });

describe("Desktop membership payments", () => {
  it("keeps the agreed plan when a background account refresh changes the membership tier", async () => {
    const panel = renderPanel();
    await screen.findByRole("checkbox");
    agree();
    panel.rerender(<MembershipPayments language="cn" account={{ ...account, group: "plus", subscriptionName: "Plus" }} active onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Go/ }).getAttribute("aria-pressed")).toBe("true");
    submit();
    await waitFor(() => expect(newapiPaymentCheckout).toHaveBeenCalledWith(expect.objectContaining({ group: "go", expectedFen: 1900 })));
  });

  it.each([['go', 'plus'], ['plus', 'pro'], ['pro', 'pro']] as const)("shows the current %s plan and selects %s for an existing member", async (tier, selected) => {
    const member = { ...account, group: tier, subscriptionName: tier };
    writeCachedAccount(member);
    render(<MembershipPayments language="cn" account={member} active onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "会员升级" });
    const plan = await screen.findByRole("button", { name: new RegExp(`^${selected === "plus" ? "Plus" : "Pro"}`) });
    expect(plan.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/不抵扣原套餐费用/)).toBeTruthy();
    if (tier === "pro") expect(screen.getByText(/Pro 已是最高等级/)).toBeTruthy();
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    agree(); submit();
    await waitFor(() => expect(newapiPaymentCheckout).toHaveBeenCalledWith(expect.objectContaining({ group: selected })));
  });

  it("loads personalized prices only when opened and requires fresh consent for each plan", async () => {
    const panel = renderPanel(false);
    expect(newapiPaymentCatalog).not.toHaveBeenCalled();
    panel.rerender(<MembershipPayments language="cn" account={account} active onClose={vi.fn()} />);
    await screen.findByRole("button", { name: /Go.*19.00/ });
    expect(screen.getByRole("button", { name: "确认并前往支付宝支付" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/不顺延已有套餐/)).toBeTruthy();
    agree();
    expect(screen.getByRole("button", { name: "确认并前往支付宝支付" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: /Plus.*39.00/ }));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    agree(); submit();
    await waitFor(() => expect(newapiPaymentCheckout).toHaveBeenCalledWith({
      userId: 17, group: "plus", expectedRevision: 2, expectedFen: 3900, priceKind: "promotion",
    }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(checkout.cashierUrl));
    expect(screen.getByText(/收银台打开不代表付款成功/)).toBeTruthy();
  });

  it("creates one order while pending, refreshes actual account state on return, and retains that order across page switches", async () => {
    let finish!: (order: PaymentCheckout) => void;
    vi.mocked(newapiPaymentCheckout).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const panel = renderPanel();
    await screen.findByRole("checkbox");
    agree(); submit();
    fireEvent.click(screen.getByRole("button", { name: "正在创建订单…" }));
    expect(newapiPaymentCheckout).toHaveBeenCalledTimes(1);
    await act(async () => { finish(checkout); });
    panel.rerender(<MembershipPayments language="cn" account={account} active={false} onClose={vi.fn()} />);
    panel.rerender(<MembershipPayments language="cn" account={account} active onClose={vi.fn()} />);
    expect(newapiPaymentCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByText(new RegExp(checkout.tradeNo))).toBeTruthy();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(readCachedAccount()?.group).toBe("go"));
    expect(newapiBootstrap).toHaveBeenCalledTimes(1);
    expect(newapiPaymentCheckout).toHaveBeenCalledTimes(1);
  });

  it("reopens the existing cashier after browser failure without making another purchase", async () => {
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("no browser"));
    renderPanel();
    await screen.findByRole("checkbox"); agree(); submit();
    await screen.findByText("浏览器未能打开，请重新打开当前收银台。");
    fireEvent.click(screen.getByRole("button", { name: "重新打开当前收银台" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(2));
    expect(newapiPaymentCheckout).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenLastCalledWith(checkout.cashierUrl);
  });

  it("requires a fresh quote and consent after stale prices instead of retrying payment", async () => {
    vi.mocked(newapiPaymentCheckout).mockRejectedValueOnce("PAYMENT_STALE_PRICE");
    renderPanel(); await screen.findByRole("checkbox"); agree(); submit();
    await screen.findByText("价格或权益已更新，请重新读取价格并核对后购买。");
    expect(screen.queryByRole("checkbox")).toBeNull();
    const updated = catalog(); updated.offers[0].priceFen = 1800; updated.offers[0].promotionFen = 1800; updated.offers[0].revision = 3;
    vi.mocked(newapiPaymentCatalog).mockResolvedValue(updated);
    fireEvent.click(screen.getByRole("button", { name: "重新读取价格" }));
    await screen.findByRole("button", { name: /Go.*18.00/ });
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    expect(newapiPaymentCheckout).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it.each(["purchaseEnabled", "pagePayEnabled"] as const)("blocks purchases when %s is disabled", async flag => {
    const unavailable = catalog(); unavailable[flag] = false;
    vi.mocked(newapiPaymentCatalog).mockResolvedValue(unavailable);
    renderPanel(); await screen.findByRole("checkbox"); agree(); submit();
    expect(screen.getByText("支付宝电脑支付暂不可用，请稍后重新检查。")).toBeTruthy();
    expect(newapiPaymentCheckout).not.toHaveBeenCalled();
  });

  it("blocks further orders on an ambiguous response until the account is checked", async () => {
    vi.mocked(newapiPaymentCheckout).mockRejectedValueOnce("PAYMENT_ORDER_UNCERTAIN");
    vi.mocked(newapiBootstrap).mockRejectedValueOnce(new Error("offline"));
    renderPanel(); await screen.findByRole("checkbox"); agree(); submit();
    await screen.findByRole("button", { name: "刷新账户" });
    expect(screen.queryByRole("button", { name: "确认并前往支付宝支付" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新读取价格" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新账户" }));
    await screen.findByText("offline");
    expect(screen.queryByRole("button", { name: "重新选择套餐" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新账户" }));
    await screen.findByRole("button", { name: "重新选择套餐" });
    expect(newapiPaymentCheckout).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale checkout after the account signs out", async () => {
    let finish!: (order: PaymentCheckout) => void;
    vi.mocked(newapiPaymentCheckout).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderPanel(); await screen.findByRole("checkbox"); agree(); submit();
    writeCachedAccount(null);
    await act(async () => { finish(checkout); });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("shows student eligibility and uses the account-specific price kind", async () => {
    const student = catalog(); student.offers[0].studentFen = 1500; student.offers[0].priceFen = 1500; student.offers[0].priceKind = "student";
    vi.mocked(newapiPaymentCatalog).mockResolvedValue(student);
    renderPanel(); await screen.findByRole("button", { name: /Go.*15.00.*学生优惠/ });
    agree(); submit();
    await waitFor(() => expect(newapiPaymentCheckout).toHaveBeenCalledWith(expect.objectContaining({ expectedFen: 1500, priceKind: "student" })));
  });
});
