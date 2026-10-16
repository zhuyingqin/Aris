// @vitest-environment jsdom
import { useCallback, useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppProjectSwitcher, { type AppProjectSwitcherCopy } from "../AppProjectSwitcher";
import type { DesktopProject } from "../types";

const copy: AppProjectSwitcherCopy = {
  currentProject: "当前项目", noProject: "无项目", projects: "本地项目", dragToReorder: "拖动排序",
  addProject: "添加本地项目…", openWorkspace: "在文件管理器中打开工作目录",
  openProjectFolder: "打开项目文件夹", projectEmptyHint: "选择文件夹以添加项目",
};
const projects: DesktopProject[] = [
  { id: "one", name: "毕业材料", path: "F:/毕业材料", addedAt: 0, lastOpenedAt: 0 },
  { id: "two", name: "文献与实验", path: "F:/文献与实验", addedAt: 0, lastOpenedAt: 0 },
];
type Props = ComponentProps<typeof AppProjectSwitcher>;
function Harness({ overrides = {} }: { overrides?: Partial<Props> }) {
  const [open, setOpen] = useState(overrides.open ?? false);
  const onChange = overrides.onOpenChange;
  const onOpenChange = useCallback((next: boolean) => { setOpen(next); onChange?.(next); }, [onChange]);
  return <>
    <AppProjectSwitcher copy={copy} projects={projects} currentProject={projects[0]} busy={false}
      onSelect={vi.fn()} onAdd={vi.fn()} onReveal={vi.fn()} {...overrides} open={open} onOpenChange={onOpenChange} />
    <button>其它入口</button>
  </>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AppProjectSwitcher", () => {
  it("uses one named entry and keeps project selection separate from labeled actions", async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ currentProject: projects[1] }} />);
    const trigger = screen.getByRole("button", { name: copy.currentProject });
    expect(trigger.textContent).toBe(projects[1].name);
    expect(trigger.title).toBe(`${projects[1].name}\n${projects[1].path}`);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.querySelector('[data-icon="folder"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.addProject })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.openProjectFolder })).toBeNull();
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: copy.projects });
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    const list = within(dialog).getByRole("listbox", { name: copy.projects });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    expect(within(list).queryByRole("button")).toBeNull();
    expect(document.activeElement?.getAttribute("data-project-id")).toBe("two");
    expect(within(dialog).getByRole("button", { name: copy.addProject })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: copy.openProjectFolder }).title).toContain(projects[1].path);
  });

  it("selects a project and closes the panel without invoking the other actions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(), onAdd = vi.fn(), onReveal = vi.fn();
    render(<Harness overrides={{ onSelect, onAdd, onReveal }} />);
    await user.click(screen.getByRole("button", { name: copy.currentProject }));
    await user.click(screen.getAllByRole("option")[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("two");
    expect(onAdd).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["add", "reveal"] as const)("routes the %s action and closes its panel", async action => {
    const user = userEvent.setup();
    const onAdd = vi.fn(), onReveal = vi.fn();
    render(<Harness overrides={{ onAdd, onReveal }} />);
    await user.click(screen.getByRole("button", { name: copy.currentProject }));
    await user.click(screen.getByRole("button", { name: action === "add" ? copy.addProject : copy.openProjectFolder }));
    expect(action === "add" ? onAdd : onReveal).toHaveBeenCalledTimes(1);
    expect(action === "add" ? onReveal : onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("allows adding the first project through the same entry", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<Harness overrides={{ projects: [], currentProject: null, onAdd }} />);
    await user.click(screen.getByRole("button", { name: copy.currentProject }));
    expect(screen.getByText(copy.projectEmptyHint)).toBeTruthy();
    expect((screen.getByRole("button", { name: copy.openProjectFolder }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: copy.addProject }));
    await user.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports keyboard navigation and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness overrides={{ onSelect }} />);
    const trigger = screen.getByRole("button", { name: copy.currentProject });
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(document.activeElement?.getAttribute("data-project-id")).toBe("two");
    await user.keyboard("{Home}");
    expect(document.activeElement?.getAttribute("data-project-id")).toBe("one");
    await user.keyboard("{End}{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("two");
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on outside click and on tabbing past the actions", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: copy.currentProject });
    const outside = screen.getByRole("button", { name: "其它入口" });
    await user.click(trigger);
    await user.click(outside);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(outside);
    await user.click(trigger);
    await user.tab(); await user.tab(); await user.tab(); await user.tab();
    expect(document.activeElement).toBe(outside);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prevents actions while the project is busy", () => {
    const onSelect = vi.fn(), onAdd = vi.fn(), onReveal = vi.fn();
    render(<Harness overrides={{ busy: true, open: true, onSelect, onAdd, onReveal }} />);
    for (const name of [copy.currentProject, copy.addProject, copy.openProjectFolder]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    fireEvent.click(screen.getAllByRole("option")[0]);
    fireEvent.keyDown(screen.getAllByRole("option")[0], { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("preserves drag callbacks and suppresses selection after dragging", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const drag = { id: "one", suppressClick: { current: true }, onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn() };
    render(<Harness overrides={{ onSelect, drag }} />);
    await user.click(screen.getByRole("button", { name: copy.currentProject }));
    const row = screen.getAllByRole("option")[0];
    fireEvent.pointerDown(row); fireEvent.pointerMove(row); fireEvent.pointerUp(row); fireEvent.pointerCancel(row);
    expect(drag.onStart).toHaveBeenCalledWith(expect.anything(), "one");
    expect(drag.onMove).toHaveBeenCalledTimes(1);
    expect(drag.onEnd).toHaveBeenCalledTimes(1);
    expect(drag.onCancel).toHaveBeenCalledTimes(1);
    await user.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    drag.suppressClick.current = false;
    await user.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it("limits popup height to the available space after resizing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: copy.currentProject });
    const root = trigger.parentElement!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: 100, bottom: window.innerHeight - 80 } as DOMRect);
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(parseFloat(dialog.style.maxHeight)).toBeGreaterThan(0);
    expect(parseFloat(dialog.style.maxHeight)).toBeLessThan(80);
    vi.mocked(root.getBoundingClientRect).mockReturnValue({ left: 100, bottom: window.innerHeight - 40 } as DOMRect);
    fireEvent(window, new Event("resize"));
    expect(parseFloat(dialog.style.maxHeight)).toBeLessThan(40);
  });

  it("keeps a project panel inside the viewport when its entry is at the right edge", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: copy.currentProject });
    const origin = window.innerWidth - 140;
    vi.spyOn(trigger.parentElement!, "getBoundingClientRect").mockReturnValue({ left: origin, bottom: 100 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function(this: HTMLElement) {
      return this.classList.contains("project-menu") ? 340 : 0;
    });
    await user.click(trigger);
    const left = origin + parseFloat(screen.getByRole("dialog").style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 340).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});
