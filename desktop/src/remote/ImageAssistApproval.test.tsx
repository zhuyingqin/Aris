// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  imageAssistDecide: vi.fn(),
  imageAssistConsent: vi.fn(),
  imageAssistPublish: vi.fn(),
  imageAssistRoster: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../api/tauri", () => ({
  imageAssistDecide: mocks.imageAssistDecide,
  imageAssistConsent: mocks.imageAssistConsent,
  imageAssistPublish: mocks.imageAssistPublish,
  imageAssistRoster: mocks.imageAssistRoster,
}));

import { ImageAssistApproval } from "./ImageAssistApproval";
import {
  imageAssistActivitySnapshot,
  publishImageAssistActivity,
} from "./imageAssistActivity";

type Listener = (event: { payload: unknown }) => void;

const emitters = new Map<string, Listener>();
const emit: Listener = (event) => emitters.get("image-assist-approval")?.(event);
const emitConsent: Listener = (event) => emitters.get("image-assist-consent")?.(event);
const emitMatch: Listener = (event) => emitters.get("image-assist-match")?.(event);

const prompt = (overrides: Record<string, unknown> = {}) => ({
  matchId: "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
  peerFingerprint: "9f3a1c7e",
  prompt: "a wind turbine at dusk",
  aspectRatio: "16:9",
  remainingToday: 4,
  expiresAtUnixMs: Date.now() + 120_000,
  ...overrides,
});

beforeEach(() => {
  publishImageAssistActivity(null);
  mocks.imageAssistDecide.mockReset().mockResolvedValue(undefined);
  mocks.imageAssistConsent.mockReset().mockResolvedValue(undefined);
  mocks.imageAssistPublish.mockReset().mockResolvedValue(true);
  mocks.imageAssistRoster.mockReset().mockResolvedValue(undefined);
  emitters.clear();
  mocks.listen.mockReset().mockImplementation((event: string, handler: Listener) => {
    emitters.set(event, handler);
    return Promise.resolve(() => {});
  });
});

afterEach(cleanup);

describe("ImageAssistApproval", () => {
  it("shows nothing until a stranger actually asks", () => {
    render(<ImageAssistApproval />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the full prompt so approval is informed, not ceremonial", async () => {
    render(<ImageAssistApproval />);
    emit({ payload: prompt() });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("a wind turbine at dusk")).toBeTruthy();
    // The requester is identified only by a short fingerprint.
    expect(screen.getByText(/9f3a1c7e/)).toBeTruthy();
    // The cost to the helper is stated before they decide.
    expect(screen.getByText(/消耗你的额度/)).toBeTruthy();
  });

  it("sends the decision and closes", async () => {
    render(<ImageAssistApproval />);
    emit({ payload: prompt() });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByText("同意并生成"));

    await waitFor(() =>
      expect(mocks.imageAssistDecide).toHaveBeenCalledWith(
        "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("declines without generating anything", async () => {
    render(<ImageAssistApproval />);
    emit({ payload: prompt() });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByText("拒绝"));

    await waitFor(() =>
      expect(mocks.imageAssistDecide).toHaveBeenCalledWith(
        "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
        false,
      ),
    );
  });

  it("dismisses an expired request rather than leaving it clickable", async () => {
    render(<ImageAssistApproval />);
    emit({ payload: prompt({ expiresAtUnixMs: Date.now() - 1 }) });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.imageAssistDecide).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the decision fails", async () => {
    mocks.imageAssistDecide.mockRejectedValue(new Error("signal transport is unavailable"));
    render(<ImageAssistApproval />);
    emit({ payload: prompt() });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByText("同意并生成"));

    // A failed decision must not silently look like an approval.
    await waitFor(() => expect(screen.getByText(/signal transport is unavailable/)).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("brokered heartbeats and requester consent", () => {
  it("advertises and refreshes the roster on mount", async () => {
    render(<ImageAssistApproval />);
    // Without these the helper never appears in any roster and the requester
    // never learns anyone is available.
    await waitFor(() => expect(mocks.imageAssistPublish).toHaveBeenCalled());
    await waitFor(() => expect(mocks.imageAssistRoster).toHaveBeenCalled());
  });

  it("asks the requester before the prompt leaves the machine", async () => {
    render(<ImageAssistApproval />);
    emitConsent({
      payload: {
        consentId: "3f1c9a20-0000-4000-8000-000000000000",
        prompt: "a wind turbine at dusk",
        aspectRatio: "16:9",
      },
    });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("a wind turbine at dusk")).toBeTruthy();
    // The consequence is stated, and it is one encryption cannot remove.
    expect(screen.getByText(/端到端加密不能改变这一点/)).toBeTruthy();

    fireEvent.click(screen.getByText("发送并请求生成"));
    await waitFor(() =>
      expect(mocks.imageAssistConsent).toHaveBeenCalledWith(
        "3f1c9a20-0000-4000-8000-000000000000",
        true,
      ),
    );
  });

  it("cancels without sending", async () => {
    render(<ImageAssistApproval />);
    emitConsent({
      payload: { consentId: "c1", prompt: "something private", aspectRatio: null },
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(mocks.imageAssistConsent).toHaveBeenCalledWith("c1", false));
  });
});

describe("refused incoming requests", () => {
  it("says why a request produced no dialog instead of showing nothing", async () => {
    render(<ImageAssistApproval />);
    emitters.get("image-assist-error")?.({
      payload: "收到一个代出图请求，但本机拒绝了：「为其他用户生成图片」开关未打开",
    });

    // Silence here is indistinguishable from the request never arriving.
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByText(/开关未打开/)).toBeTruthy();
  });

  it("keeps the approval dialog on top of a notice", async () => {
    render(<ImageAssistApproval />);
    emitters.get("image-assist-error")?.({ payload: "earlier refusal" });
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());

    emit({ payload: prompt() });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("a wind turbine at dusk")).toBeTruthy();
  });
});

describe("temporary image-assist session", () => {
  it("publishes the task state for the project summary, including received images", async () => {
    render(<ImageAssistApproval />);

    emitMatch({
      payload: {
        stage: "matching",
        detail: "请求已提交，正在匹配在线互助用户",
        prompt: "a wind turbine at dusk",
        aspectRatio: "16:9",
      },
    });

    emitMatch({
      payload: {
        matchId: "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
        stage: "sent",
        detail: "已发送给 Lab PC（设备 9f3a1c7e），等待对方查看并接受",
      },
    });
    await waitFor(() => expect(imageAssistActivitySnapshot()?.stage).toBe("sent"));
    expect(imageAssistActivitySnapshot()?.detail).toContain("Lab PC");
    expect(imageAssistActivitySnapshot()?.matchId).toBe("6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f");
    expect(imageAssistActivitySnapshot()?.prompt).toBe("a wind turbine at dusk");
    expect(imageAssistActivitySnapshot()?.aspectRatio).toBe("16:9");

    emitMatch({
      payload: {
        matchId: "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
        stage: "generating",
        detail: "对方已接受，正在执行图片生成",
      },
    });
    await waitFor(() => expect(imageAssistActivitySnapshot()?.stage).toBe("generating"));

    emitMatch({
      payload: {
        matchId: "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
        stage: "completed",
        detail: "已接收 1 张图片",
        images: ["C:/project/.somniq/artifacts/image-assist/test.png"],
      },
    });
    await waitFor(() => expect(imageAssistActivitySnapshot()?.stage).toBe("completed"));
    expect(imageAssistActivitySnapshot()?.images).toEqual([
      "C:/project/.somniq/artifacts/image-assist/test.png",
    ]);
  });

  it("shows the helper that its accepted request is really executing", async () => {
    render(<ImageAssistApproval />);
    emitMatch({
      payload: {
        matchId: "helper-match",
        stage: "generating",
        detail: "临时会话已验证，正在使用本机 ChatGPT 生成图片",
      },
    });

    await waitFor(() => expect(imageAssistActivitySnapshot()?.stage).toBe("generating"));
    expect(imageAssistActivitySnapshot()?.detail).toMatch(/使用本机 ChatGPT/);
  });
});
