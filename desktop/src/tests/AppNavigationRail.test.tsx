// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppNavigationRail, { type AppNavigationItem } from "../AppNavigationRail";

const items: AppNavigationItem[] = [
  { id: "chat", label: "对话", icon: <span /> },
  { id: "lab", label: "Code", icon: <span /> },
  { id: "typeset", label: "TeX", icon: <span /> },
  { id: "literature", label: "文献库", icon: <span /> },
];
const moreItems: AppNavigationItem[] = [
  { id: "scheduled", label: "定时任务", icon: <span /> },
  { id: "tasks", label: "待办任务", icon: <span /> },
  { id: "workflows", label: "研究流程", icon: <span /> },
  { id: "mail", label: "邮箱", icon: <span /> },
  { id: "settings", label: "设置", icon: <span /> },
];

function rail(overrides: Partial<React.ComponentProps<typeof AppNavigationRail>> = {}) {
  return <AppNavigationRail label="SomniQ 功能" moreLabel="更多功能" items={items} moreItems={moreItems} activeTab="chat" account={<button>用户菜单</button>} onSelect={vi.fn()} onPreload={vi.fn()} {...overrides} />;
}

afterEach(cleanup);

describe("AppNavigationRail", () => {
  it("switches all four workspaces directly and keeps the account in the same rail", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(rail({ onSelect }));
    const navigation = screen.getByRole("navigation", { name: "SomniQ 功能" });
    expect(within(navigation).getByRole("button", { name: "用户菜单" })).toBeTruthy();
    for (const item of items) {
      await user.click(screen.getByRole("button", { name: item.label }));
      expect(onSelect).toHaveBeenLastCalledWith(item.id);
    }
    expect(screen.getByRole("button", { name: "对话" }).getAttribute("aria-current")).toBe("page");
  });

  it("preloads a workspace on hover and keyboard focus", async () => {
    const user = userEvent.setup();
    const onPreload = vi.fn();
    render(rail({ onPreload }));
    await user.hover(screen.getByRole("button", { name: "Code" }));
    expect(onPreload).toHaveBeenCalledWith("lab");
    screen.getByRole("button", { name: "TeX" }).focus();
    expect(onPreload).toHaveBeenLastCalledWith("typeset");
  });

  it("opens optional modules with arrow keys and restores focus when dismissed", async () => {
    const user = userEvent.setup();
    render(rail({ activeTab: "mail" }));
    const trigger = screen.getByRole("button", { name: "更多功能" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "邮箱" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "设置" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "定时任务" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "设置" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each(moreItems)("selects $label through More and closes the menu", async (item) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(rail({ onSelect, activeTab: item.id }));
    expect(screen.getByRole("button", { name: "更多功能" }).classList.contains("active")).toBe(true);
    await user.click(screen.getByRole("button", { name: "更多功能" }));
    const destination = screen.getByRole("menuitemradio", { name: item.label });
    expect(destination.getAttribute("aria-checked")).toBe("true");
    await user.click(destination);
    expect(onSelect).toHaveBeenCalledWith(item.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dismisses the menu when the user clicks outside or switches views elsewhere", async () => {
    const user = userEvent.setup();
    const view = render(rail());
    await user.click(screen.getByRole("button", { name: "更多功能" }));
    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "更多功能" }));
    view.rerender(rail({ activeTab: "lab" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("only exposes the optional modules supplied by the visibility preferences", async () => {
    const user = userEvent.setup();
    const view = render(rail({ moreItems: moreItems.filter((item) => item.id === "settings") }));
    await user.click(screen.getByRole("button", { name: "更多功能" }));
    expect(screen.queryByRole("menuitemradio", { name: "邮箱" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "研究流程" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "设置" })).toBeTruthy();
    view.rerender(rail({ moreItems: [] }));
    expect(screen.queryByRole("button", { name: "更多功能" })).toBeNull();
  });
});
