// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  imageAssistPublish: vi.fn(),
  imageAssistRoster: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../api/tauri", () => ({
  imageAssistPublish: mocks.imageAssistPublish,
  imageAssistRoster: mocks.imageAssistRoster,
}));

import { ImageAssistRoster } from "./ImageAssistRoster";

type Listener = (event: { payload: unknown }) => void;

const emitters = new Map<string, Listener>();

beforeEach(() => {
  vi.useRealTimers();
  emitters.clear();
  mocks.imageAssistRoster.mockReset().mockResolvedValue(undefined);
  mocks.imageAssistPublish.mockReset().mockResolvedValue(true);
  mocks.listen.mockReset().mockImplementation((event: string, handler: Listener) => {
    emitters.set(event, handler);
    return Promise.resolve(() => {});
  });
});

afterEach(cleanup);

describe("ImageAssistRoster", () => {
  it("reports why the roster is unavailable instead of loading forever", async () => {
    mocks.imageAssistRoster.mockRejectedValue(new Error("remote signal transport is unavailable"));
    render(<ImageAssistRoster />);

    // The usual cause is that remote control is off, which is fixable only if
    // the user can see it.
    await waitFor(() =>
      expect(screen.getByText(/remote signal transport is unavailable/)).toBeTruthy(),
    );
    expect(screen.queryByText("正在获取在线用户…")).toBeNull();
  });

  it("surfaces a gateway refusal rather than showing an empty list", async () => {
    render(<ImageAssistRoster />);
    emitters.get("image-assist-error")?.({
      payload: "this gateway does not broker image assistance",
    });

    await waitFor(() =>
      expect(screen.getByText(/does not broker image assistance/)).toBeTruthy(),
    );
  });

  it("distinguishes nobody online from not knowing", async () => {
    render(<ImageAssistRoster />);
    emitters.get("image-assist-roster")?.({ payload: [] });

    await waitFor(() =>
      expect(screen.getByText("当前没有用户在线提供出图帮助。")).toBeTruthy(),
    );
  });

  it("shows a name only for a helper who opted in", async () => {
    render(<ImageAssistRoster />);
    emitters.get("image-assist-roster")?.({
      payload: [
        { fingerprint: "9f3a1c7e", available: true },
        { fingerprint: "1a2b3c4d", displayName: "lab workstation", available: false },
      ],
    });

    await waitFor(() => expect(screen.getByText(/2 位在线/)).toBeTruthy());
    expect(screen.queryByText("匿名用户")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看在线互助用户详情" }));
    expect(screen.getByText("匿名用户")).toBeTruthy();
    expect(screen.getByText("lab workstation")).toBeTruthy();
    // A row never carries a full device id.
    expect(screen.queryByText(/-/)).toBeNull();
  });

  it("opens a scalable detail view with mapped approximate locations and search", async () => {
    render(<ImageAssistRoster />);
    emitters.get("image-assist-roster")?.({
      payload: [
        {
          fingerprint: "9f3a1c7e",
          displayName: "Mexico lab",
          available: true,
          location: { label: "Mexico City", latitude: 19.4, longitude: -99.1 },
        },
        { fingerprint: "1a2b3c4d", available: false },
      ],
    });

    await waitFor(() => expect(screen.getByText(/1 个地点/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "查看在线互助用户详情" }));

    expect(screen.getByRole("dialog", { name: "在线互助网络" })).toBeTruthy();
    expect(screen.getAllByText(/Mexico City/)).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("搜索名称、短指纹或地点"), {
      target: { value: "Mexico" },
    });
    expect(screen.getByText("Mexico lab")).toBeTruthy();
    expect(screen.queryByText("匿名用户")).toBeNull();
  });

  it("marks this computers published approximate location separately from the remote roster", async () => {
    window.localStorage.setItem(
      "somniq.image-assist.approximate-location.v1",
      JSON.stringify({ label: "Mexico City", latitude: 19.4, longitude: -99.1 }),
    );
    render(<ImageAssistRoster />);
    emitters.get("image-assist-roster")?.({ payload: [] });

    await waitFor(() => expect(mocks.imageAssistPublish).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "查看在线互助用户详情" }));
    expect(screen.getByText("我")).toBeTruthy();
    expect(screen.getByText("当前公开：Mexico City")).toBeTruthy();
  });

  it("recovers when a roster arrives after an error", async () => {
    render(<ImageAssistRoster />);
    emitters.get("image-assist-error")?.({ payload: "temporary gateway problem" });
    await waitFor(() => expect(screen.getByText(/temporary gateway problem/)).toBeTruthy());

    emitters.get("image-assist-roster")?.({
      payload: [{ fingerprint: "9f3a1c7e", available: true }],
    });
    await waitFor(() => expect(screen.getByText(/1 位在线/)).toBeTruthy());
  });
});
