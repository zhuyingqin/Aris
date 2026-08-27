// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteControlStatus, RemoteDevice, RemotePendingPairing } from "../types";
import RemoteControlPanel from "./RemoteControlPanel";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  remoteControlStatus: vi.fn(),
  remoteControlDevices: vi.fn(),
  remoteControlCreateInvitation: vi.fn(),
  remoteControlResetIdentity: vi.fn(),
  remoteControlDisable: vi.fn(),
  remoteControlSetDeviceName: vi.fn(),
  remoteControlPendingPairing: vi.fn(),
  remoteControlApprovePairing: vi.fn(),
  remoteControlDiscardPairing: vi.fn(),
  remoteControlRevokeDevice: vi.fn(),
  computeNodeConfigGet: vi.fn(),
  imageAssistRoster: vi.fn(),
  imageAssistPublish: vi.fn(),
  computeNodeConfigSet: vi.fn(),
  computeCapabilities: vi.fn(),
  computePeersList: vi.fn(),
  computePeerConnect: vi.fn(),
  computePairingClaim: vi.fn(),
  computePairingComplete: vi.fn(),
  computePeerRevoke: vi.fn(),
  onComputePeerEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
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
  kind: "mobile",
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
  kind: "mobile",
  label: "Trusted phone",
  fingerprint: "0b0c0d0e0f1011121314151617181920",
  requestedScopes: ["read_project_state", "send_chat_messages", "read_review_conclusions"],
  requestedAt: 1_700_000_002_000,
};

beforeEach(() => {
  apiMocks.isTauri.mockReset();
  apiMocks.remoteControlStatus.mockReset();
  apiMocks.remoteControlDevices.mockReset();
  apiMocks.remoteControlCreateInvitation.mockReset();
  apiMocks.remoteControlResetIdentity.mockReset();
  apiMocks.remoteControlSetDeviceName.mockReset();
  apiMocks.remoteControlDisable.mockReset();
  apiMocks.remoteControlPendingPairing.mockReset();
  apiMocks.remoteControlApprovePairing.mockReset();
  apiMocks.remoteControlDiscardPairing.mockReset();
  apiMocks.remoteControlRevokeDevice.mockReset();
  apiMocks.computeNodeConfigGet.mockReset();
  apiMocks.imageAssistRoster.mockReset().mockResolvedValue(undefined);
  apiMocks.imageAssistPublish.mockReset().mockResolvedValue(undefined);
  apiMocks.computeNodeConfigSet.mockReset();
  apiMocks.computeCapabilities.mockReset();
  apiMocks.computePeersList.mockReset();
  apiMocks.computePeerConnect.mockReset();
  apiMocks.computePairingClaim.mockReset();
  apiMocks.computePairingComplete.mockReset();
  apiMocks.computePeerRevoke.mockReset();
  apiMocks.onComputePeerEvent.mockReset();
  apiMocks.isTauri.mockReturnValue(false);
  apiMocks.remoteControlStatus.mockResolvedValue(STATUS);
  apiMocks.remoteControlDevices.mockResolvedValue([DEVICE]);
  apiMocks.remoteControlCreateInvitation.mockResolvedValue({
    status: STATUS,
    pairing: {
      pairingId: "pairing-a",
      // Must be genuinely in the future: the shared ceremony now polls and
      // retires an invitation the moment it expires.
      expiresAt: Date.now() + 5 * 60 * 1000,
      qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    },
  });
  apiMocks.remoteControlDisable.mockResolvedValue({ ...STATUS, enabled: false });
  apiMocks.remoteControlPendingPairing.mockResolvedValue(null);
  apiMocks.remoteControlApprovePairing.mockResolvedValue(DEVICE);
  apiMocks.remoteControlDiscardPairing.mockResolvedValue(undefined);
  apiMocks.remoteControlRevokeDevice.mockResolvedValue(undefined);
  apiMocks.computeNodeConfigGet.mockResolvedValue({
    acceptRemoteJobs: false,
    acceptRemoteAgentChats: false,
    maxParallelJobs: 2,
    acceptImageHelp: false,
    imageHelpDailyLimit: 10,
    preferImageHelp: false,
  });
  apiMocks.computeNodeConfigSet.mockImplementation(async (
    acceptRemoteJobs: boolean,
    acceptRemoteAgentChats: boolean,
    maxParallelJobs: number,
    acceptImageHelp: boolean,
    imageHelpDailyLimit: number,
    preferImageHelp: boolean,
  ) => ({
    acceptRemoteJobs,
    acceptRemoteAgentChats,
    maxParallelJobs,
    acceptImageHelp,
    imageHelpDailyLimit,
    preferImageHelp,
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

    expect(screen.getByText("Pairing requires explicit approval on this device")).toBeTruthy();
    expect(screen.queryByLabelText("Gateway URL (HTTPS)")).toBeNull();
    expect(screen.queryByLabelText("STUN servers (optional)")).toBeNull();
    expect(screen.queryByText("Gateway enrollment token (first setup)")).toBeNull();

    const connect = await screen.findByRole("button", { name: "Add device" });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    await waitFor(() => expect(apiMocks.remoteControlCreateInvitation).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("img", { name: "Add device" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh pairing QR code" }));
    await waitFor(() => expect(apiMocks.remoteControlCreateInvitation).toHaveBeenCalledTimes(2));
  });

  it("can reset identity after a refused first enrollment was rolled back", async () => {
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
    apiMocks.remoteControlCreateInvitation.mockRejectedValue(
      "remote identity was refused by the gateway: this desktop's credential no longer matches its registration",
    );
    apiMocks.remoteControlResetIdentity.mockResolvedValue({
      status: { ...disabled, enabled: true },
      pairing: {
        pairingId: "reset-pairing",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "The gateway no longer recognises this device",
    });
    expect(dialog.textContent).toContain("0 device(s) paired today");

    await user.click(within(dialog).getByRole("button", { name: "Reset identity and re-pair" }));
    await waitFor(() => expect(apiMocks.remoteControlResetIdentity).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("img", { name: "Add device" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("A new remote identity was issued");
  });

  it("offers the pairing QR as a copyable code for browsers with no camera", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlStatus.mockResolvedValue({
      ...STATUS,
      enabled: false,
      pairedDeviceCount: 0,
      activeDeviceCount: 0,
    });
    apiMocks.remoteControlDevices.mockResolvedValue([]);
    apiMocks.remoteControlCreateInvitation.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));

    // The QR stays: this is an added path, not a replacement.
    expect(await screen.findByRole("img", { name: "Add device" })).toBeTruthy();

    const code = await screen.findByLabelText("One-time connection code");
    expect((code as HTMLTextAreaElement).readOnly).toBe(true);
    expect((code as HTMLTextAreaElement).value).toBe(
      "https://remote.example.test/pair#p=one-time-code",
    );

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "https://remote.example.test/pair#p=one-time-code",
    ));
    expect(screen.getByRole("status").textContent).toContain("approval on this computer");
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

    await screen.findByRole("button", { name: "Add device" });
    await user.click(screen.getByRole("button", { name: "Add device" }));
    await screen.findByRole("img", { name: "Add device" });

    // The claim arrives on its own through the shared add-device flow.
    await screen.findByRole("region", { name: "Device awaiting approval" });
    expect(screen.queryByRole("button", { name: "Check for phone request" })).toBeNull();

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Project status.*Desktop conversations and tasks.*Review conclusions/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Approve pairing" }));

    await waitFor(() => expect(apiMocks.remoteControlApprovePairing).toHaveBeenCalledWith({
      pairingId: "pairing-a",
    }));
  });

  it("lets the owner rename this computer instead of leaving the detected name", async () => {
    // Every install previously showed the same placeholder in the account's
    // web list, with no way to correct it.
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlStatus.mockResolvedValue({ ...STATUS, deviceName: "SomniQ Desktop" });
    apiMocks.remoteControlSetDeviceName.mockResolvedValue({ ...STATUS, deviceName: "书房台式机" });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("This device");
    await user.clear(field);
    await user.type(field, "书房台式机");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.remoteControlSetDeviceName).toHaveBeenCalledWith("书房台式机"));
    await waitFor(() => expect(screen.getByText("书房台式机")).toBeTruthy());
  });

  it("retires the previous code when the user regenerates one", async () => {
    // Pending pairings are capped and expire only on their own TTL, so leaking
    // a slot per click would lock the user out after a few regenerations.
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));
    await screen.findByRole("img", { name: "Add device" });
    expect(apiMocks.remoteControlDiscardPairing).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Refresh pairing QR code" }));
    await waitFor(() => expect(apiMocks.remoteControlDiscardPairing).toHaveBeenCalledWith("pairing-a"));
    await waitFor(() => expect(apiMocks.remoteControlCreateInvitation).toHaveBeenCalledTimes(2));
  });

  it("names both ends of the pairing so the approval is not ambiguous", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    const named = { ...STATUS, deviceName: "LAPTOP-FSQQJ9B8" };
    apiMocks.remoteControlStatus.mockResolvedValue(named);
    apiMocks.remoteControlCreateInvitation.mockResolvedValue({
      status: named,
      pairing: {
        pairingId: "pairing-a",
        expiresAt: Date.now() + 5 * 60 * 1000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    });
    apiMocks.remoteControlPendingPairing.mockResolvedValue(PENDING_PAIRING);
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));
    const approval = await screen.findByRole("region", { name: "Device awaiting approval" });

    // Who is connecting, and which computer they are connecting to. Owning two
    // machines makes the second half of that impossible to infer.
    expect(approval.textContent).toContain(PENDING_PAIRING.label);
    expect(approval.textContent).toContain("LAPTOP-FSQQJ9B8");
  });

  it("provides tabs to switch between remote control and local capabilities", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    const remoteTab = await screen.findByRole("tab", { name: "Remote control" });
    const capabilitiesTab = screen.getByRole("tab", { name: "This device capabilities" });

    expect(remoteTab.getAttribute("aria-selected")).toBe("true");
    expect(capabilitiesTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("button", { name: "Add device" })).toBeTruthy();
    expect(screen.queryByLabelText("Maximum parallel jobs")).toBeNull();

    // Switch to local capabilities tab
    await user.click(capabilitiesTab);
    expect(capabilitiesTab.getAttribute("aria-selected")).toBe("true");
    expect(remoteTab.getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByLabelText("Maximum parallel jobs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();

    // Switch back to remote control tab
    await user.click(remoteTab);
    expect(remoteTab.getAttribute("aria-selected")).toBe("true");
    expect(capabilitiesTab.getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByRole("button", { name: "Add device" })).toBeTruthy();
  });

  it("keeps phone and computer pairing in one trusted-device surface", async () => {
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    expect(await screen.findByRole("button", { name: "Add device" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect device" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Remote control" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "This device capabilities" })).toBeTruthy();
    expect(screen.getByText("Pairing requires explicit approval on this device")).toBeTruthy();
    expect(screen.queryByText("Computer capabilities")).toBeNull();
    expect(screen.queryByText("Pair computers")).toBeNull();
  });

  it("shows phones and computers in the same connected-device inventory", async () => {
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlDevices.mockResolvedValue([{ ...DEVICE, kind: "mobile" }]);
    apiMocks.computePeersList.mockResolvedValue([{
      endpointId: "endpoint-mac",
      nodeId: "route-mac",
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
    }]);
    render(<RemoteControlPanel language="en" />);

    expect(await screen.findByText("Trusted phone")).toBeTruthy();
    expect(await screen.findByText("Mac")).toBeTruthy();
    expect(screen.getByText("endpoint-mac")).toBeTruthy();
  });

  it("keeps capability switches under this device without a second computer setting", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    const capabilitiesTab = await screen.findByRole("tab", { name: "This device capabilities" });
    await user.click(capabilitiesTab);

    await screen.findByLabelText("Maximum parallel jobs");
    expect(screen.queryByText("Computer capabilities")).toBeNull();
    expect(screen.queryByRole("button", { name: /save worker settings/i })).toBeNull();
    expect(screen.queryByLabelText("Node name")).toBeNull();

    // Assert the switches that must be present rather than a bare count, so
    // adding an unrelated policy toggle does not fail this test for the wrong
    // reason. All three are independent grants and all start off.
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(3);
    for (const toggle of switches) {
      expect((toggle as HTMLInputElement).checked).toBe(false);
    }

    await user.click(switches[0]);

    await waitFor(() => expect(apiMocks.computeNodeConfigSet).toHaveBeenCalledWith(
      true,
      false,
      2,
      false,
      10,
      false,
    ));
  });

  it("uses one invitation as both QR and copyable code for every endpoint", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlCreateInvitation.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "compute-pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));

    const code = await screen.findByDisplayValue("https://remote.example.test/pair#p=one-time-code");
    expect(code.tagName).toBe("TEXTAREA");
    expect((code as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByRole("img", { name: "Add device" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Paste connection code here")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "https://remote.example.test/pair#p=one-time-code",
    ));
  });

  it("revokes a computer from the unified inventory after confirmation", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlDevices.mockResolvedValue([]);
    apiMocks.computePeersList
      .mockResolvedValueOnce([{
        endpointId: "endpoint-mac",
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
    render(<RemoteControlPanel language="en" />);

    await screen.findByText("Mac");
    expect(apiMocks.computePeerRevoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm device revocation" }));

    await waitFor(() => expect(apiMocks.computePeerRevoke).toHaveBeenCalledWith("peer-mac"));
    await waitFor(() => expect(screen.queryByText("Mac")).toBeNull());
  });

  it("connects an offline claimed computer only after the user requests it", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlDevices.mockResolvedValue([]);
    apiMocks.computePeersList.mockResolvedValue([{
      endpointId: "endpoint-mac",
      nodeId: "peer-mac",
      displayName: "Mac",
      gatewayUrl: "https://remote.example.test",
      connected: false,
      transport: null,
      platform: null,
      architecture: null,
      logicalCpus: null,
      pairedAtUnixMs: 1_700_000_000_000,
      lastSeenAtUnixMs: null,
      direction: "claimed",
      agentChatAuthorized: true,
    }]);
    apiMocks.computePeerConnect.mockResolvedValue(undefined);
    render(<RemoteControlPanel language="en" />);

    expect(apiMocks.computePeerConnect).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(apiMocks.computePeerConnect).toHaveBeenCalledWith("peer-mac"));
  });

  it("automatically detects a submitted computer claim in the shared approval region", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlCreateInvitation.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "compute-pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    apiMocks.remoteControlPendingPairing.mockResolvedValue({
      ...PENDING_PAIRING,
      deviceId: "computer-a",
      kind: "compute_node",
      label: "Lab computer",
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));

    const approval = await screen.findByRole("region", {
      name: "Device awaiting approval",
    });
    expect(approval.textContent).toContain(PENDING_PAIRING.fingerprint);
    expect(approval.textContent).toContain("Lab computer");
    expect(approval.textContent).toContain("Computer");
    expect(screen.queryByRole("button", { name: "Check computer claim" })).toBeNull();

    await user.click(within(approval).getByRole("button", { name: "Approve pairing" }));
    await waitFor(() => expect(apiMocks.remoteControlApprovePairing).toHaveBeenCalledWith({
      pairingId: PENDING_PAIRING.pairingId,
    }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Device awaiting approval" })).toBeNull());
  });

  it("lets the inviter decline the automatically detected computer claim", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.remoteControlCreateInvitation.mockResolvedValue({
      status: STATUS,
      pairing: {
        pairingId: "pairing-a",
        expiresAt: Date.now() + 300_000,
        qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        pairingLink: "https://remote.example.test/pair#p=one-time-code",
      },
    });
    apiMocks.remoteControlPendingPairing.mockResolvedValue({
      ...PENDING_PAIRING,
      deviceId: "computer-a",
      kind: "compute_node",
      label: "Lab computer",
    });
    render(<RemoteControlPanel language="en" />);

    await user.click(await screen.findByRole("button", { name: "Add device" }));
    const approval = await screen.findByRole("region", { name: "Device awaiting approval" });
    await user.click(within(approval).getByRole("button", { name: "Discard QR code" }));

    await waitFor(() => expect(apiMocks.remoteControlDiscardPairing).toHaveBeenCalledWith("pairing-a"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Device awaiting approval" })).toBeNull());
  });

  it("automatically completes the joining computer after the inviter approves", async () => {
    const user = userEvent.setup();
    apiMocks.isTauri.mockReturnValue(true);
    render(<RemoteControlPanel language="en" />);

    await user.type(
      await screen.findByPlaceholderText("Paste connection code here"),
      "https://remote.example.test/pair#p=one-time-code",
    );
    await user.click(screen.getByRole("button", { name: "Connect device" }));

    await waitFor(() => expect(apiMocks.computePairingClaim).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMocks.computePairingComplete).toHaveBeenCalledWith("pairing-a"));
    await screen.findByText("Device connected. Establishing a secure connection.");
    expect(screen.queryByRole("button", { name: "Complete pairing" })).toBeNull();
  });
});
