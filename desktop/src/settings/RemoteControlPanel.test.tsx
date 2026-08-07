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
  computeNodeConfigGet: vi.fn(),
  computeNodeConfigSet: vi.fn(),
  computeCapabilities: vi.fn(),
  computePeersList: vi.fn(),
  computePairingClaim: vi.fn(),
  computePairingComplete: vi.fn(),
  computePeerRevoke: vi.fn(),
  onComputePeerEvent: vi.fn(),
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
  apiMocks.computeNodeConfigGet.mockReset();
  apiMocks.computeNodeConfigSet.mockReset();
  apiMocks.computeCapabilities.mockReset();
  apiMocks.computePeersList.mockReset();
  apiMocks.computePairingClaim.mockReset();
  apiMocks.computePairingComplete.mockReset();
  apiMocks.computePeerRevoke.mockReset();
  apiMocks.onComputePeerEvent.mockReset();
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
  apiMocks.computeNodeConfigGet.mockResolvedValue({
    nodeId: "compute-a",
    displayName: "Research desktop",
    acceptRemoteJobs: false,
    acceptRemoteAgentChats: false,
    maxParallelJobs: 2,
  });
  apiMocks.computeNodeConfigSet.mockImplementation(async (
    displayName: string,
    acceptRemoteJobs: boolean,
    acceptRemoteAgentChats: boolean,
    maxParallelJobs: number,
  ) => ({
    nodeId: "compute-a",
    displayName,
    acceptRemoteJobs,
    acceptRemoteAgentChats,
    maxParallelJobs,
  }));
  apiMocks.computeCapabilities.mockResolvedValue({
    nodeId: "compute-a",
    displayName: "Research desktop",
    platform: "windows",
    architecture: "x86_64",
    logicalCpus: 8,
    supportsCommand: true,
    supportsPython: true,
    supportsNotebook: true,
    maxParallelJobs: 2,
    workerVersion: "0.4.34",
  });
  apiMocks.computePeersList.mockResolvedValue([]);
  apiMocks.computePairingClaim.mockResolvedValue({
    pairingId: "pairing-a",
    desktopName: "Research desktop",
    status: "awaiting_approval",
    completionExpiresAtUnixMs: 1_700_000_300_000,
  });
  apiMocks.computePairingComplete.mockResolvedValue({
    pairingId: "pairing-a",
    desktopName: "Research desktop",
    status: "completed",
    completionExpiresAtUnixMs: 1_700_000_300_000,
  });
  apiMocks.computePeerRevoke.mockResolvedValue(undefined);
  apiMocks.onComputePeerEvent.mockResolvedValue(() => undefined);
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

  it("keeps phone and computer pairing on separate sub-tabs", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    await screen.findByRole("button", { name: "Connect phone" });
    expect(screen.queryByRole("button", { name: "Create connection code" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: /Computers/ }));
    expect(await screen.findByRole("button", { name: "Create connection code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
    expect(screen.queryByText("Pairing requires explicit desktop approval")).toBeNull();
  });

  it("does not show paired compute nodes in the phone device inventory", async () => {
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlDevices.mockResolvedValue([
      { ...DEVICE, kind: "mobile" },
      {
        ...DEVICE,
        id: "compute-mac",
        kind: "compute_node",
        label: "Mac",
        scopes: ["read_project_state", "send_chat_messages", "compute_jobs"],
      },
    ]);
    render(<RemoteControlPanel language="en" />);

    expect(await screen.findByText("Trusted phone")).toBeTruthy();
    expect(screen.queryByText("Mac")).toBeNull();
  });

  it("opens the standalone computer surface without a save button and persists switches immediately", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" initialTab="computers" />);

    await screen.findByText("Computer compute node");
    expect(screen.queryByRole("button", { name: /save worker settings/i })).toBeNull();

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    await user.click(switches[0]);

    await waitFor(() => expect(apiMocks.computeNodeConfigSet).toHaveBeenCalledWith(
      "Research desktop",
      true,
      false,
      2,
    ));
  });

  it("pairs computers with a copied connection code and no QR surface", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlConnectPhone.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "compute-pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("tab", { name: /Computers/ }));
    const createCode = await screen.findByRole("button", { name: "Create connection code" });
    expect(screen.getByText(/computer pairing does not use QR codes/i)).toBeTruthy();
    await user.click(createCode);

    const code = await screen.findByDisplayValue("https://remote.example.test/pair#p=one-time-code");
    expect(code.tagName).toBe("TEXTAREA");
    expect((code as HTMLTextAreaElement).readOnly).toBe(true);
    expect((code as HTMLTextAreaElement).style.height).toBe("64px");
    expect(screen.queryByRole("img", { name: /computer/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "https://remote.example.test/pair#p=one-time-code",
    ));
  });

  it("keeps destructive peer actions inside a neutral overflow menu", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.computePeersList
      .mockResolvedValueOnce([{
        nodeId: "peer-mac",
        displayName: "Mac",
        gatewayUrl: "https://remote.example.test",
        connected: true,
        transport: "p2p_webrtc",
        platform: "macos",
        architecture: "aarch64",
        logicalCpus: 10,
        pairedAtUnixMs: 1_700_000_000_000,
        lastSeenAtUnixMs: 1_700_000_001_000,
        direction: "claimed",
        agentChatAuthorized: true,
      }])
      .mockResolvedValueOnce([]);
    render(<RemoteControlPanel language="en" initialTab="computers" />);

    const menuButton = await screen.findByRole("button", { name: "More actions for Mac" });
    expect(apiMocks.computePeerRevoke).not.toHaveBeenCalled();

    await user.click(menuButton);
    await user.click(screen.getByRole("menuitem", { name: /Revoke pairing/ }));

    await waitFor(() => expect(apiMocks.computePeerRevoke).toHaveBeenCalledWith("peer-mac"));
    await waitFor(() => expect(screen.queryByText("Mac")).toBeNull());
  });

  it("automatically detects a submitted computer claim and opens one approval dialog", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlConnectPhone.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "compute-pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    apiMocks.remoteControlPendingPairing.mockResolvedValue(PENDING_PAIRING);
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("tab", { name: /Computers/ }));
    await user.click(await screen.findByRole("button", { name: "Create connection code" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Allow this computer to connect?",
    });
    expect(dialog.textContent).toContain(PENDING_PAIRING.fingerprint);
    expect(screen.queryByRole("button", { name: "Check computer claim" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Allow connection" }));
    await waitFor(() => expect(apiMocks.remoteControlApprovePairing).toHaveBeenCalledWith({
      pairingId: PENDING_PAIRING.pairingId,
    }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("lets the inviter decline the automatically detected computer claim", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlConnectPhone.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    apiMocks.remoteControlPendingPairing.mockResolvedValue(PENDING_PAIRING);
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("tab", { name: /Computers/ }));
    await user.click(await screen.findByRole("button", { name: "Create connection code" }));
    await screen.findByRole("alertdialog", { name: "Allow this computer to connect?" });
    await user.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(apiMocks.remoteControlDiscardPairing).toHaveBeenCalledWith("pairing-a"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Connection declined");
  });

  it("automatically completes the joining computer after the inviter approves", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("tab", { name: /Computers/ }));
    await user.type(
      screen.getByPlaceholderText("Paste connection code here"),
      "https://remote.example.test/pair#p=one-time-code",
    );
    await user.click(screen.getByRole("button", { name: "Claim invitation" }));

    await waitFor(() => expect(apiMocks.computePairingClaim).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMocks.computePairingComplete).toHaveBeenCalledWith("pairing-a"));
    await screen.findByText("Computer pairing completed. Establishing a secure connection.");
    expect(screen.queryByRole("button", { name: "Complete pairing" })).toBeNull();
  });
});
