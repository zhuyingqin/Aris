// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  remoteControlP2pAnswer: vi.fn(),
  remoteControlP2pClosed: vi.fn(),
  remoteControlP2pFailed: vi.fn(),
  remoteControlP2pFrame: vi.fn(),
  remoteControlP2pIceCandidate: vi.fn(),
  remoteControlP2pIceComplete: vi.fn(),
  remoteControlP2pOpened: vi.fn(),
  remoteControlP2pOffer: vi.fn(),
  remoteControlP2pPending: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../api/tauri", () => ({
  remoteControlP2pAnswer: mocks.remoteControlP2pAnswer,
  remoteControlP2pClosed: mocks.remoteControlP2pClosed,
  remoteControlP2pFailed: mocks.remoteControlP2pFailed,
  remoteControlP2pFrame: mocks.remoteControlP2pFrame,
  remoteControlP2pIceCandidate: mocks.remoteControlP2pIceCandidate,
  remoteControlP2pIceComplete: mocks.remoteControlP2pIceComplete,
  remoteControlP2pOpened: mocks.remoteControlP2pOpened,
  remoteControlP2pOffer: mocks.remoteControlP2pOffer,
  remoteControlP2pPending: mocks.remoteControlP2pPending,
}));

import { RemoteP2pBridge } from "./RemoteP2pBridge";

class FakeDataChannel {
  readonly label: string;
  binaryType = "blob";
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: ArrayBuffer[] = [];

  constructor(label: string) {
    this.label = label;
  }

  send(data: ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  readonly configuration: RTCConfiguration;
  readonly channel = new FakeDataChannel("somniq-control-v1");
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "compute-offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer" as const, sdp: "compute-answer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate() {}

  close() {
    this.connectionState = "closed";
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  FakePeerConnection.instances = [];
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  mocks.listen.mockResolvedValue(() => undefined);
  for (const mock of [
    mocks.remoteControlP2pAnswer,
    mocks.remoteControlP2pClosed,
    mocks.remoteControlP2pFailed,
    mocks.remoteControlP2pFrame,
    mocks.remoteControlP2pIceCandidate,
    mocks.remoteControlP2pIceComplete,
    mocks.remoteControlP2pOpened,
    mocks.remoteControlP2pOffer,
  ]) {
    mock.mockResolvedValue(undefined);
  }
  mocks.remoteControlP2pPending.mockResolvedValue({
    starts: [{
      deviceId: "compute-node-b",
      sessionId: "session-p2p",
      iceServers: ["stun:stun.example.test:3478"],
    }],
    offers: [],
    answers: [{
      deviceId: "compute-node-b",
      sessionId: "session-p2p",
      sdp: "compute-answer-sdp",
    }],
    candidates: [],
    iceCompletes: [],
  });
});

afterEach(cleanup);

describe("RemoteP2pBridge computer sessions", () => {
  it("creates a WebRTC offer, accepts the answer, and reports DataChannel failure for relay fallback", async () => {
    render(<RemoteP2pBridge />);

    await waitFor(() => expect(mocks.remoteControlP2pOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "compute-node-b",
        sessionId: "session-p2p",
        sdp: "compute-offer-sdp",
      }),
    ));
    const peer = FakePeerConnection.instances[0]!;
    expect(peer.configuration).toEqual({
      iceServers: [{ urls: "stun:stun.example.test:3478" }],
    });
    await waitFor(() => expect(peer.remoteDescription?.sdp).toBe("compute-answer-sdp"));

    peer.channel.readyState = "open";
    peer.channel.onopen?.();
    await waitFor(() => expect(mocks.remoteControlP2pOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "compute-node-b",
        sessionId: "session-p2p",
      }),
    ));

    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();
    await waitFor(() => expect(mocks.remoteControlP2pFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "compute-node-b",
        sessionId: "session-p2p",
        reason: "ice_failed",
      }),
    ));
  });
});
