// @vitest-environment jsdom
import { type ComponentProps, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppAccountMenu from "../AppAccountMenu";

function menu(overrides: Partial<ComponentProps<typeof AppAccountMenu>> = {}) {
  return <AppAccountMenu language="cn" name="研究工作区" initials="研究" avatar={null} plan={{ tier: "pro", label: "Pro", remaining: 2_000_000, remainingPercent: 20 }} open rootRef={undefined} triggerRef={undefined} onMenuKeyDown={vi.fn()} onToggle={vi.fn()} onSettings={vi.fn()} onLogout={vi.fn()} {...overrides} />;
}

afterEach(cleanup);

describe("AppAccountMenu", () => {
  it("shows the user and one allowance with only settings and sign-out actions", () => {
    render(menu());
    const popup = screen.getByRole("menu", { name: "用户菜单" });
    expect(within(popup).getByText("研究工作区")).toBeTruthy();
    expect(within(popup).getByText("Pro")).toBeTruthy();
    expect(within(popup).getByRole("group", { name: "套餐额度" })).toBeTruthy();
    expect(within(popup).getByText("$4.00")).toBeTruthy();
    expect(within(popup).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
    expect(within(popup).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["设置Ctrl+,", "退出登录"]);
    expect(popup.querySelectorAll("button")).toHaveLength(2);
  });

  it("keeps settings and logout connected to their existing handlers", async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();
    const onLogout = vi.fn();
    render(menu({ onSettings, onLogout }));
    await user.click(screen.getByRole("menuitem", { name: /设置/ }));
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("toggles from the avatar and retains the user's custom picture", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return menu({ open, avatar: "data:image/png;base64,cHJldmlldw==", onToggle: () => setOpen((current) => !current) });
    }
    const view = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelectorAll("img")).toHaveLength(2);
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not present missing allowance as zero or a full progress bar", () => {
    render(menu({ plan: { tier: "pro", label: "Pro", remaining: null, remainingPercent: null } }));
    expect(screen.getByText("额度信息暂不可用")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("localizes the compact menu and accurately shows an exhausted plan", () => {
    render(menu({ language: "en", plan: { tier: "free", label: "Free", remaining: 0, remainingPercent: 0 } }));
    expect(screen.getByRole("group", { name: "Plan allowance" })).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.getByText("0% remaining")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });
});
