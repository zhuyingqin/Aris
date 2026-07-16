// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteControlStatus, RemoteDevice, RemotePendingPairing } from "../types";
import RemoteControlPanel from "./RemoteControlPanel";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  remoteControlStatus: vi.fn(),
  remoteControlDevices: vi.fn(),
  remoteControlConnectPhone: vi.fn(),
  remoteControlDisable: vi.fn(),
  remoteControlPendingPairing: vi.fn(),
  remoteControlApprovePairing: vi.fn(),
  remoteControlDiscardPairing: vi.fn(),
  remoteControlRevokeDevice: vi.fn(),
}));

vi.mock("../api/tauri", () => apiMocks);

const STATUS: RemoteControlStatus = {
  enabled: true,
  gatewayUrl: "https://remote.example.test",
  deviceId: "desktop-a",
  deviceName: "Research desktop",
  iceServers: [],
  pairedDeviceCount: 1,
  activeDeviceCount: 1,
};

const DEVICE: RemoteDevice = {
  id: "phone-a",
  label: "Trusted phone",
  fingerprint: "0b0c0d0e0f1011121314151617181920",
  scopes: ["read_project_state", "send_chat_messages"],
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_001_000,
};

const PENDING_PAIRING: RemotePendingPairing = {
  pairingId: "pairing-a",
  claimId: "claim-a",
  deviceId: "phone-a",
  label: "Trusted phone",
  fingerprint: "0b0c0d0e0f1011121314151617181920",
  requestedScopes: ["read_project_state", "send_chat_messages", "read_review_conclusions"],
  requestedAt: 1_700_000_002_000,
};

beforeEach(() => {
  apiMocks.isTauri.mockReset();
  apiMocks.remoteControlStatus.mockReset();
  apiMocks.remoteControlDevices.mockReset();
  apiMocks.remoteControlConnectPhone.mockReset();
  apiMocks.remoteControlDisable.mockReset();
  apiMocks.remoteControlPendingPairing.mockReset();
  apiMocks.remoteControlApprovePairing.mockReset();
  apiMocks.remoteControlDiscardPairing.mockReset();
  apiMocks.remoteControlRevokeDevice.mockReset();
  apiMocks.isTauri.mockReturnValue(false);
  apiMocks.remoteControlStatus.mockResolvedValue(STATUS);
  apiMocks.remoteControlDevices.mockResolvedValue([DEVICE]);
  apiMocks.remoteControlConnectPhone.mockResolvedValue({
    status: STATUS,
    pairing: {
      pairingId: "pairing-a",
      expiresAt: 1_700_000_300_000,
      qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    },
  });
  apiMocks.remoteControlDisable.mockResolvedValue({ ...STATUS, enabled: false });
  apiMocks.remoteControlPendingPairing.mockResolvedValue(null);
  apiMocks.remoteControlApprovePairing.mockResolvedValue(DEVICE);
  apiMocks.remoteControlDiscardPairing.mockResolvedValue(undefined);
  apiMocks.remoteControlRevokeDevice.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("RemoteControlPanel", () => {
  it("connects a phone with the preset service and immediately shows a QR code", async () => {
    const user = userEvent.setup();
    const disabled = {
      ...STATUS,
      enabled: false,
      pairedDeviceCount: 0,
      activeDeviceCount: 0,
    };
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlStatus.mockResolvedValue(disabled);
    apiMocks.remoteControlDevices.mockResolvedValue([]);
    render(<RemoteControlPanel language="en" />);

    expect(screen.getByText("Pairing requires explicit desktop approval")).toBeTruthy();
    expect(screen.queryByLabelText("Gateway URL (HTTPS)")).toBeNull();
    expect(screen.queryByLabelText("STUN servers (optional)")).toBeNull();
    expect(screen.queryByText("Gateway enrollment token (first setup)")).toBeNull();

    const connect = await screen.findByRole("button", { name: "Connect phone" });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    await waitFor(() => expect(apiMocks.remoteControlConnectPhone).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("img", { name: "Connect phone" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh pairing QR code" }));
    await waitFor(() => expect(apiMocks.remoteControlConnectPhone).toHaveBeenCalledTimes(2));
  });

  it("removes a paired device after an explicit second confirmation", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlDevices
      .mockResolvedValueOnce([DEVICE])
      .mockResolvedValueOnce([]);
    render(<RemoteControlPanel language="en" />);

    await screen.findByText("Trusted phone");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("alert").textContent).toContain("immediately removes");

    await user.click(screen.getByRole("button", { name: "Confirm device revocation" }));
    await waitFor(() => expect(apiMocks.remoteControlRevokeDevice).toHaveBeenCalledWith("phone-a"));
    await waitFor(() => expect(screen.queryByText("Trusted phone")).toBeNull());
  });

  it("approves all supported requested scopes without a manual permission picker", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlPendingPairing.mockResolvedValue(PENDING_PAIRING);
    render(<RemoteControlPanel language="en" />);

    await screen.findByRole("button", { name: "Connect phone" });
    await user.click(screen.getByRole("button", { name: "Connect phone" }));
    await screen.findByRole("img", { name: "Connect phone" });

    await user.click(screen.getByRole("button", { name: "Check for phone request" }));
    await screen.findByRole("region", { name: "Phone awaiting approval" });

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Project status.*Desktop conversations and tasks.*Review conclusions/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Approve pairing" }));

    await waitFor(() => expect(apiMocks.remoteControlApprovePairing).toHaveBeenCalledWith({
      pairingId: "pairing-a",
    }));
  });
});
