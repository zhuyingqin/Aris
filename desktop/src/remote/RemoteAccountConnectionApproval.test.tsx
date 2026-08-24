// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  pending: vi.fn(),
  approve: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../api/tauri", () => ({
  remoteControlPendingPairing: mocks.pending,
  remoteControlApprovePairing: mocks.approve,
  remoteControlDiscardPairing: mocks.discard,
}));

import { RemoteAccountConnectionApproval } from "./RemoteAccountConnectionApproval";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

beforeEach(() => {
  listeners.clear();
  mocks.listen.mockReset().mockImplementation((event: string, handler: Listener) => {
    listeners.set(event, handler);
    return Promise.resolve(() => undefined);
  });
  mocks.pending.mockReset().mockResolvedValue({
    pairingId: "pairing-1",
    claimId: "claim-1",
    deviceId: "browser-1",
    label: "Chrome on phone",
    fingerprint: "A1:B2:C3:D4",
    requestedScopes: ["projects_read", "chat_write"],
    requestedAt: Date.now(),
  });
  mocks.approve.mockReset().mockResolvedValue(undefined);
  mocks.discard.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("RemoteAccountConnectionApproval", () => {
  it("requires a visible local approval before accepting a same-account browser", async () => {
    render(<RemoteAccountConnectionApproval />);
    expect(screen.queryByRole("dialog")).toBeNull();

    listeners.get("remote-account-pairing-started")?.({
      payload: {
        requestId: "request-1",
        clientLabel: "SomniQ Web · Chrome",
        pairingId: "pairing-1",
        expiresAt: Date.now() + 60_000,
      },
    });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Chrome on phone")).toBeTruthy());
    expect(screen.getByText("A1:B2:C3:D4")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "允许连接" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith({ pairingId: "pairing-1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("discards the one-time invitation when the desktop user refuses", async () => {
    render(<RemoteAccountConnectionApproval />);
    listeners.get("remote-account-pairing-started")?.({
      payload: {
        requestId: "request-2",
        clientLabel: "SomniQ Web",
        pairingId: "pairing-2",
        expiresAt: Date.now() + 60_000,
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith("pairing-2"));
  });
});
