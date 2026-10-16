// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import ChatThread from "../ChatThread";
import type { ChatTurn } from "../../types";

const virtualizer = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  getVirtualItems: () => [],
  getTotalSize: () => 4_000,
  takeSnapshot: () => [],
  resizeItem: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: () => virtualizer }));
vi.mock("../ChatMessage", () => ({ default: () => null }));

const turns: ChatTurn[] = Array.from({ length: 20 }, (_, index) => ({
  id: `turn-${index}`,
  role: "assistant",
  blocks: [{ kind: "text", text: `Message ${index}` }],
}));
const props: ComponentProps<typeof ChatThread> = {
  sessionId: "landing-test",
  language: "en",
  turns,
  composerHeight: 100,
  starters: [],
  welcomeTitle: "Chat",
  welcomeDescription: "",
  onStarter: vi.fn(),
  onEdit: vi.fn(),
  onRetry: vi.fn(),
  onContinue: vi.fn(),
  onPermissionRespond: vi.fn(),
  onQuestionRespond: vi.fn(async () => undefined),
};

let layoutReady: boolean;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
let observers: Set<ResizeObserverCallback>;

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

describe("ChatThread opening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutReady = true;
    nextFrame = 0;
    frames = new Map();
    observers = new Set();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => layoutReady ? 600 : 0);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => layoutReady ? 820 : 0);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lands at the newest message when mounted and remounted", () => {
    const first = render(<ChatThread {...props} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(19, { align: "end", behavior: "auto" });
    first.unmount();
    virtualizer.scrollToIndex.mockClear();
    render(<ChatThread {...props} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(19, { align: "end", behavior: "auto" });
  });

  it("lands again when the kept-alive Chat page is reopened", () => {
    const view = render(<ChatThread {...props} />);
    flushFrames();
    virtualizer.scrollToIndex.mockClear();
    view.rerender(<ChatThread {...props} visible={false} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    view.rerender(<ChatThread {...props} visible />);
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("does not consume a landing when messages load behind a hidden page", () => {
    const view = render(<ChatThread {...props} turns={[]} loading visible={false} />);
    view.rerender(<ChatThread {...props} visible={false} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    view.rerender(<ChatThread {...props} visible />);
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(19, { align: "end", behavior: "auto" });
  });

  it("waits for history loading to finish even if earlier content is present", () => {
    const view = render(<ChatThread {...props} turns={turns.slice(0, 3)} loading />);
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    view.rerender(<ChatThread {...props} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(19, { align: "end", behavior: "auto" });
  });

  it("waits for a usable viewport and retries when its layout appears", () => {
    layoutReady = false;
    render(<ChatThread {...props} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    layoutReady = true;
    act(() => {
      observers.forEach((callback) => callback([], {} as ResizeObserver));
    });
    flushFrames();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("leaves reader navigation alone on ordinary message and layout updates", () => {
    const view = render(<ChatThread {...props} />);
    flushFrames();
    fireEvent.wheel(view.container.querySelector(".chat-scroll")!, { deltaY: -100 });
    virtualizer.scrollToIndex.mockClear();
    view.rerender(<ChatThread {...props} composerHeight={180} turns={[...turns, { ...turns[0], id: "new-message" }]} />);
    act(() => observers.forEach((callback) => callback([], {} as ResizeObserver)));
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });

  it("cancels a pending landing when the page is hidden or unmounted", () => {
    const view = render(<ChatThread {...props} />);
    view.rerender(<ChatThread {...props} visible={false} />);
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    view.rerender(<ChatThread {...props} visible />);
    view.unmount();
    flushFrames();
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });
});
