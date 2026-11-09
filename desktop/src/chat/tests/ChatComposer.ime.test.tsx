// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer from "../ChatComposer";
import { useStore } from "../../store";
import type { DesktopCommandSpec, SkillMeta } from "../../types";

vi.mock("../../api/tauri", async (original) => ({
  ...await original<typeof import("../../api/tauri")>(),
  isTauri: () => false,
  fileSearch: vi.fn(async () => []),
}));

function Composer({
  onSubmit,
  initialInput = "请用 DeepSeek 处理",
  commands = [],
  skills = [],
}: {
  onSubmit: () => void;
  initialInput?: string;
  commands?: DesktopCommandSpec[];
  skills?: SkillMeta[];
}) {
  const [input, setInput] = useState(initialInput);
  return <ChatComposer input={input} commands={commands} skills={skills}
    attachments={[]} busy={false} ready editing={false} onInputChange={setInput}
    onAttachmentsChange={() => {}} onSubmit={onSubmit} onStop={() => {}}
    onCancelEdit={() => {}} onHeightChange={() => {}} />;
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ language: "en" });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("macOS IME confirmation in the chat composer", () => {
  it("leaves an unflagged confirming Enter to the active input method", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.compositionStart(input, { data: "DeepSeek" });
    // Some WebKit keydowns already have isComposing=false at confirmation.
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false })).toBe(true);
    fireEvent.change(input, { target: { value: "请用 DeepSeek 处理这个问题" } });
    expect(input.value).toBe("请用 DeepSeek 处理这个问题");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "DeepSeek" });
    fireEvent.keyUp(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("honors a native IME keydown without a compositionstart: %j", (nativeFlags) => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    expect(fireEvent.keyDown(input, { key: "Enter", ...nativeFlags })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyUp(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("handles compositionend before Enter and suppresses repeats until key release", () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input, { data: "Agent" });
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false })).toBe(true);
    vi.runOnlyPendingTimers();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, repeat: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyUp(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not swallow a fresh Enter if the input method omitted the confirming keyup", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, repeat: false });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("allows Enter after composition committed using another key or the mouse", () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input, { data: "模型" });
    vi.runOnlyPendingTimers();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("clears unfinished composition on blur and keeps the Send button usable", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.blur(input);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not execute an exact slash command on an IME confirming Enter", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} initialInput="" commands={[{ name: "model", description: "Choose model" }]} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/model" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.compositionEnd(input);
    fireEvent.keyUp(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("leaves picker navigation and selection to the IME until text is committed", () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} initialInput="" skills={[{ name: "paper-plan", path: "paper-plan/SKILL.md" }]} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/ppln" } });
    fireEvent.compositionStart(input);
    for (const key of ["ArrowDown", "ArrowUp", "Escape", "Enter"]) {
      expect(fireEvent.keyDown(input, { key, isComposing: true })).toBe(true);
    }
    expect(input.value).toBe("/ppln");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyUp(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/paper-plan ");
  });

  it.each(["MacIntel", "Win32"])("preserves plain Enter and Shift+Enter on %s", (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not enable the macOS composition boundary or repeat guard on Windows", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
