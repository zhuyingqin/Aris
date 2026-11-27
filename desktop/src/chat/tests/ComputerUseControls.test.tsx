// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatElapsed, indicatorCopy } from "../../computerControl/indicatorCopy";
import {
  ComputerAccessCard,
  ComputerUseBanner,
  ComputerUsePill,
  type ComputerAccessRequest,
} from "../ComputerUseControls";

vi.mock("../../api/tauri", () => ({
  isTauri: () => false,
  chatComputerUseGet: vi.fn(),
  chatComputerUseSet: vi.fn(),
  computerControlStatus: vi.fn(),
  computerControlStop: vi.fn(),
  computerAccessPending: vi.fn(),
  computerAccessRespond: vi.fn(),
}));

afterEach(cleanup);

describe("computer-control indicator copy", () => {
  it("formats elapsed time as m:ss and h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(3_726_000)).toBe("1:02:06");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  it("names the window being read in every UI language", () => {
    expect(indicatorCopy("cn", 1, "draft.txt - 记事本").title).toBe("SomniQ 正在查看「draft.txt - 记事本」");
    expect(indicatorCopy("en", 1, "Notes").title).toBe("SomniQ is viewing “Notes”");
    expect(indicatorCopy("es", 1, "Notas").title).toBe("SomniQ está viendo «Notas»");
    expect(indicatorCopy("cn", 1).title).toBe("SomniQ 电脑操作模式运行中");
    expect(indicatorCopy("cn", 2).title).toContain("2 个对话");
    expect(indicatorCopy("es", 1).stop).toBe("Detener");
    // An unknown code from the backend falls back to Chinese, the app default.
    expect(indicatorCopy("xx", 1).stop).toBe("停止");
  });
});

describe("ComputerUsePill", () => {
  it("toggles and reports its state", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ComputerUsePill language="cn" enabled={false} disabled={false} onChange={onChange} />);
    const pill = screen.getByRole("button", { name: /电脑操作/ });
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pill);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<ComputerUsePill language="cn" enabled disabled={false} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /电脑操作/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /电脑操作/ }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("cannot be switched while disabled (a turn is running)", () => {
    const onChange = vi.fn();
    render(<ComputerUsePill language="en" enabled={false} disabled onChange={onChange} />);
    const pill = screen.getByRole("button", { name: /Computer use/ });
    expect((pill as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ComputerUseBanner", () => {
  it("explains the mode while idle, without a stop button", () => {
    render(<ComputerUseBanner language="cn" controlling={false} controlSinceMs={null} onStop={vi.fn()} />);
    expect(screen.getByText("电脑操作模式已开启")).toBeTruthy();
    expect(screen.getByText(/Shell、代码执行、MCP、插件和项目 hooks 已停用/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("names the window being read and stops the turn", () => {
    const onStop = vi.fn();
    render(
      <ComputerUseBanner
        language="cn"
        controlling
        controlSinceMs={Date.now() - 5_000}
        observingTitle="draft.txt - 记事本"
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/SomniQ 正在查看「draft.txt - 记事本」/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("ComputerAccessCard", () => {
  const request: ComputerAccessRequest = {
    sessionId: "s1",
    toolUseId: "toolu_1",
    reason: "确认草稿里的标题",
    model: "deepseek-v4 · https://gateway.example",
    hiddenByPolicy: 9,
    windows: [
      { hwnd: 11, pid: 1, exe: "notepad.exe", title: "draft.txt - 记事本", tier: "requires_grant", tierReason: "", minimized: false },
      { hwnd: 22, pid: 2, exe: "msedge.exe", title: "论文页面", tier: "read_only", tierReason: "", minimized: true },
    ],
  };

  it("shows the reason, the disclosure and every offered window", () => {
    render(<ComputerAccessCard language="cn" request={request} onRespond={vi.fn()} />);
    expect(screen.getByText("确认草稿里的标题")).toBeTruthy();
    expect(screen.getByText(/会发送给 deepseek-v4 · https:\/\/gateway.example/)).toBeTruthy();
    expect(screen.getByText("draft.txt - 记事本")).toBeTruthy();
    expect(screen.getByText("已最小化")).toBeTruthy();
    expect(screen.getByText(/另有 9 个窗口不能被查看/)).toBeTruthy();
  });

  it("allows only after a window is picked, and can refuse", () => {
    const onRespond = vi.fn();
    render(<ComputerAccessCard language="cn" request={request} onRespond={onRespond} />);
    const allow = screen.getByRole("button", { name: "允许查看所选窗口" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/draft.txt - 记事本/));
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(onRespond).toHaveBeenCalledWith("toolu_1", 11);

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onRespond).toHaveBeenLastCalledWith("toolu_1", null);
  });
});
