// @vitest-environment jsdom

import { type ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppProductSwitcher from "../AppProductSwitcher";
import type { AppNavigationItem } from "../AppNavigationRail";

const items: AppNavigationItem[] = [
  { id: "chat", label: "对话", icon: <span /> },
  { id: "lab", label: "Code", icon: <span /> },
  { id: "typeset", label: "LaTeX", icon: <span /> },
  { id: "literature", label: "文献库", icon: <span /> },
];
const utilityItems: AppNavigationItem[] = [{ id: "settings", label: "设置", icon: <span /> }];

function switcher(overrides: Partial<ComponentProps<typeof AppProductSwitcher>> = {}) {
  return <AppProductSwitcher label="SomniQ 功能" triggerLabel="切换 LaTeX" moduleName="LaTeX" activeTab="typeset" items={items} utilityItems={utilityItems} onOpen={vi.fn()} onSelect={vi.fn()} onPreload={vi.fn()} {...overrides} />;
}

afterEach(cleanup);

describe("AppProductSwitcher", () => {
  it("opens the original SomniQ module-name control and focuses the active workspace", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(switcher({ onOpen }));
    const trigger = screen.getByRole("button", { name: "切换 LaTeX" });
    expect(trigger.textContent).toBe("SomniQLaTeX");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger);
    expect(onOpen).toHaveBeenCalledOnce();
    const selected = screen.getByRole("menuitemradio", { name: "LaTeX" });
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(selected);
  });

  it("switches to another workspace, including Chat, and closes the popup", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(switcher({ onSelect }));
    for (const item of [...items, ...utilityItems]) {
      await user.click(screen.getByRole("button", { name: "切换 LaTeX" }));
      await user.click(screen.getByRole("menuitemradio", { name: item.label }));
      expect(onSelect).toHaveBeenLastCalledWith(item.id);
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("supports arrow navigation, Home, End, and Escape with focus restoration", async () => {
    const user = userEvent.setup();
    render(switcher());
    const trigger = screen.getByRole("button", { name: "切换 LaTeX" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "LaTeX" }));
    await user.keyboard("{Home}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "设置" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "对话" }));
    await user.keyboard("{End}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "文献库" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside click or an external workspace change", async () => {
    const user = userEvent.setup();
    const view = render(<><button>账户</button>{switcher()}</>);
    await user.click(screen.getByRole("button", { name: "切换 LaTeX" }));
    await user.click(screen.getByRole("button", { name: "账户" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "切换 LaTeX" }));
    view.rerender(switcher({ activeTab: "chat", moduleName: "Chat" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("preloads workspaces on focus and hover", async () => {
    const user = userEvent.setup();
    const onPreload = vi.fn();
    render(switcher({ onPreload }));
    await user.click(screen.getByRole("button", { name: "切换 LaTeX" }));
    expect(onPreload).toHaveBeenCalledWith("typeset");
    await user.hover(screen.getByRole("menuitemradio", { name: "Code" }));
    expect(onPreload).toHaveBeenCalledWith("lab");
  });

  it("keeps only the optional modules permitted by the supplied preferences", async () => {
    const user = userEvent.setup();
    render(switcher());
    await user.click(screen.getByRole("button", { name: "切换 LaTeX" }));
    const menu = screen.getByRole("menu", { name: "SomniQ 功能" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
    expect(within(menu).queryByRole("menuitemradio", { name: "邮箱" })).toBeNull();
    expect(within(menu).queryByRole("menuitemradio", { name: "研究流程" })).toBeNull();
  });
});
