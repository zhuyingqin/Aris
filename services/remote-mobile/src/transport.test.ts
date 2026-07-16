import { describe, expect, it, vi } from "vitest";

import {
  MAX_PENDING_ICE_SIGNALS_PER_SESSION,
  P2pFirstTransport,
  SIGNAL_HEARTBEAT_INTERVAL_MS,
  SIGNAL_HEARTBEAT_TIMEOUT_MS,
  type AuthorizedGatewaySocketFactory,
  type GatewaySocket,
  type GatewaySocketHandlers,
} from "./transport";
import type { EncryptedFrameCodec, PairedMobileSession } from "./types";

const SESSION: PairedMobileSession = {
  invitation: {
    gateway_url: "https://remote.example.test",
    desktop: {
      device_id: "11111111-1111-4111-8111-111111111111",
      kind: "desktop",
      display_name: "Desktop",
      signing_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      key_agreement_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  },
  mobile: {
    device_id: "22222222-2222-4222-8222-222222222222",
    kind: "mobile",
    display_name: "Phone",
    signing_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    key_agreement_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  credential: "a-credential-long-enough-to-be-private-123456",
  granted_scopes: ["read_project_state"],
  ice_servers: [],
};

class FakeSocket implements GatewaySocket {
  handlers: GatewaySocketHandlers | null = null;
  readonly sent: string[] = [];

  constructor(private readonly onText?: (text: string, socket: FakeSocket) => void) {}

  setHandlers(handlers: GatewaySocketHandlers): void {
    this.handlers = handlers;
  }

  sendText(text: string): void {
    this.sent.push(text);
    this.onText?.(text, this);
  }

  sendBinary(): void {}
  close(): void {}
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dataChannel: RTCDataChannel | null = null;

  constructor(
    private readonly beforeCreateOffer?: () => void,
    private readonly selectedPath: {
      localCandidateType: RTCIceCandidateType;
      remoteCandidateType: RTCIceCandidateType;
      protocol: string;
    } = {
      localCandidateType: "host",
      remoteCandidateType: "srflx",
      protocol: "udp",
    },
  ) {}

  createDataChannel(): RTCDataChannel {
    const dataChannel = {
      readyState: "connecting",
      binaryType: "arraybuffer",
      close: () => undefined,
      send: () => undefined,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    } as unknown as RTCDataChannel;
    this.dataChannel = dataChannel;
    return dataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.beforeCreateOffer?.();
    return { type: "offer", sdp: "v=0\r\n" };
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<RTCStatsReport> {
    const entries = [
      { id: "transport-1", type: "transport", timestamp: 1, selectedCandidatePairId: "pair-1" },
      {
        id: "pair-1",
        type: "candidate-pair",
        timestamp: 1,
        state: "succeeded",
        nominated: true,
        localCandidateId: "local-1",
        remoteCandidateId: "remote-1",
      },
      {
        id: "local-1",
        type: "local-candidate",
        timestamp: 1,
        candidateType: this.selectedPath.localCandidateType,
        protocol: this.selectedPath.protocol,
      },
      {
        id: "remote-1",
        type: "remote-candidate",
        timestamp: 1,
        candidateType: this.selectedPath.remoteCandidateType,
        protocol: this.selectedPath.protocol,
      },
    ] as unknown as RTCStats[];
    return new Map(entries.map((entry) => [entry.id, entry])) as unknown as RTCStatsReport;
  }
  close(): void {}

  emitLocalIce(candidate: RTCIceCandidate | null): void {
    this.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent);
  }
}

describe("P2pFirstTransport", () => {
  it("falls back from an active P2P data channel close using a fresh relay session", async () => {
    const signal = new FakeSocket();
    const relay = new FakeSocket((text, socket) => {
      const frame = JSON.parse(text) as { type?: unknown; session_id?: unknown };
      if (frame.type === "open" && typeof frame.session_id === "string") {
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "ready",
          session_id: frame.session_id,
        })));
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "peer_connected",
          device_id: SESSION.invitation.desktop.device_id,
          session_id: frame.session_id,
        })));
      }
    });
    const peer = new FakePeerConnection();
    const states: Array<{ kind: string; transport?: string }> = [];
    const errors: Error[] = [];
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: {
        openSignal: async () => signal,
        openRelay: async () => relay,
      },
      createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      onStateChange: (state) => states.push(state),
      onTransportError: (error) => errors.push(error),
    });

    const connected = transport.connect();
    await waitForCondition(() => peer.dataChannel !== null);
    peer.dataChannel!.onopen?.(new Event("open"));
    await expect(connected).resolves.toMatchObject({
      transport: "p2p",
      directPath: {
        localCandidateType: "host",
        remoteCandidateType: "srflx",
        protocol: "udp",
      },
    });

    peer.dataChannel!.onclose?.(new Event("close"));
    await waitForCondition(() => states.some((state) => state.kind === "connected" && state.transport === "tcp_relay"));

    const frames = transportSignalFrames(signal);
    const offer = frames.find((frame) => frame.payload.kind === "webrtc_offer");
    const failed = frames.find((frame) => frame.payload.kind === "p2p_failed");
    const relayOffers = frames.filter((frame) => frame.payload.kind === "relay_offer");
    expect(offer?.session_id).toBe(failed?.session_id);
    expect(relayOffers).toHaveLength(1);
    expect(relayOffers[0]?.session_id).not.toBe(offer?.session_id);
    expect(errors).toHaveLength(0);
    transport.close();
  });

  it("never labels a WebRTC relay candidate pair as P2P", async () => {
    const signal = new FakeSocket();
    const relay = new FakeSocket((text, socket) => {
      const frame = JSON.parse(text) as { type?: unknown; session_id?: unknown };
      if (frame.type === "open" && typeof frame.session_id === "string") {
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "ready",
          session_id: frame.session_id,
        })));
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "peer_connected",
          device_id: SESSION.invitation.desktop.device_id,
          session_id: frame.session_id,
        })));
      }
    });
    const peer = new FakePeerConnection(undefined, {
      localCandidateType: "relay",
      remoteCandidateType: "srflx",
      protocol: "udp",
    });
    const states: Array<{ kind: string; transport?: string }> = [];
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: {
        openSignal: async () => signal,
        openRelay: async () => relay,
      },
      createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      onStateChange: (state) => states.push(state),
    });

    const connected = transport.connect();
    await waitForCondition(() => peer.dataChannel !== null);
    peer.dataChannel!.onopen?.(new Event("open"));

    await expect(connected).resolves.toMatchObject({ transport: "tcp_relay" });
    expect(states).toContainEqual(expect.objectContaining({ kind: "verifying_p2p" }));
    expect(states).not.toContainEqual(expect.objectContaining({ kind: "connected", transport: "p2p" }));
    expect(states).toContainEqual(expect.objectContaining({ kind: "connected", transport: "tcp_relay" }));
    transport.close();
  });

  it("keeps an active TCP relay alive after the P2P signal lease stops", async () => {
    vi.useFakeTimers();
    try {
      const signal = new FakeSocket();
      const relay = new FakeSocket((text, socket) => {
        const frame = JSON.parse(text) as { type?: unknown; session_id?: unknown };
        if (frame.type === "open" && typeof frame.session_id === "string") {
          queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
            type: "ready",
            session_id: frame.session_id,
          })));
          queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
            type: "peer_connected",
            device_id: SESSION.invitation.desktop.device_id,
            session_id: frame.session_id,
          })));
        }
      });
      const errors: Error[] = [];
      const states: string[] = [];
      const transport = new P2pFirstTransport({
        session: SESSION,
        socketFactory: {
          openSignal: async () => signal,
          openRelay: async () => relay,
        },
        createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
        preference: "tcp_relay_only",
        onStateChange: (state) => states.push(state.kind),
        onTransportError: (error) => errors.push(error),
      });

      const connected = transport.connect();
      await expect(connected).resolves.toMatchObject({ transport: "tcp_relay" });
      const sentBeforeAdvance = signal.sent.length;
      expect(vi.getTimerCount()).toBe(0);

      // An old/missing pong, close, or error on the now-auxiliary signal
      // socket cannot revoke the independently authenticated relay path.
      signal.handlers?.onText(JSON.stringify({ type: "pong", nonce: "stale-nonce" }));
      signal.handlers?.onText(JSON.stringify({ type: "error", code: "stale_signal", message: "ignored by relay" }));
      signal.handlers?.onBinary(new Uint8Array([1]));
      signal.handlers?.onClose();
      signal.handlers?.onError();
      await vi.advanceTimersByTimeAsync(SIGNAL_HEARTBEAT_TIMEOUT_MS * 2);

      expect(errors).toHaveLength(0);
      expect(states.at(-1)).toBe("connected");
      expect(signal.sent).toHaveLength(sentBeforeAdvance);
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the encrypted relay when a P2P signal heartbeat expires", async () => {
    vi.useFakeTimers();
    try {
      const signal = new FakeSocket();
      const peer = new FakePeerConnection();
      const errors: Error[] = [];
      const states: string[] = [];
      const transport = new P2pFirstTransport({
        session: SESSION,
        socketFactory: {
          openSignal: async () => signal,
          openRelay: async () => new FakeSocket((text, socket) => {
            const frame = JSON.parse(text) as { type?: unknown; session_id?: unknown };
            if (frame.type === "open" && typeof frame.session_id === "string") {
              queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
                type: "ready",
                session_id: frame.session_id,
              })));
              queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
                type: "peer_connected",
                device_id: SESSION.invitation.desktop.device_id,
                session_id: frame.session_id,
              })));
            }
          }),
        },
        createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
        createPeerConnection: () => peer as unknown as RTCPeerConnection,
        p2pTimeoutMs: 60_000,
        onStateChange: (state) => states.push(state.kind),
        onTransportError: (error) => errors.push(error),
      });

      const connected = transport.connect();
      await waitForCondition(() => peer.dataChannel !== null);
      peer.dataChannel!.onopen?.(new Event("open"));
      await expect(connected).resolves.toMatchObject({ transport: "p2p" });

      const firstPing = lastSignalFrame(signal, "ping");
      expect(firstPing.nonce).toEqual(expect.any(String));
      signal.handlers?.onText(JSON.stringify({ type: "pong", nonce: firstPing.nonce }));

      await vi.advanceTimersByTimeAsync(SIGNAL_HEARTBEAT_INTERVAL_MS);
      const secondPing = lastSignalFrame(signal, "ping");
      expect(secondPing.nonce).not.toBe(firstPing.nonce);
      // A valid-shaped but stale pong must not extend the current lease.
      signal.handlers?.onText(JSON.stringify({ type: "pong", nonce: firstPing.nonce }));

      await vi.advanceTimersByTimeAsync(SIGNAL_HEARTBEAT_TIMEOUT_MS - 1);
      expect(errors).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      await waitForCondition(() => states.at(-1) === "connected" && states.includes("falling_back"));

      expect(errors).toHaveLength(0);
      expect(states).toContain("falling_back");
      expect(states.at(-1)).toBe("connected");
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears signal heartbeat timers on explicit close", async () => {
    vi.useFakeTimers();
    try {
      const signal = new FakeSocket();
      const transport = new P2pFirstTransport({
        session: SESSION,
        socketFactory: {
          openSignal: async () => signal,
          openRelay: async () => new FakeSocket(),
        },
        createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
        preference: "tcp_relay_only",
      });

      const connecting = transport.connect();
      await waitForCondition(() => signal.sent.some((text) => (JSON.parse(text) as { type?: unknown }).type === "ping"));
      transport.close();
      await expect(connecting).rejects.toThrow("closed before connecting");
      const sentBeforeAdvance = signal.sent.length;

      await vi.advanceTimersByTimeAsync(SIGNAL_HEARTBEAT_TIMEOUT_MS * 2);
      expect(signal.sent).toHaveLength(sentBeforeAdvance);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails P2P-only connection when remote pre-answer ICE exceeds its per-session limit", async () => {
    const signal = new FakeSocket();
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: {
        openSignal: async () => signal,
        openRelay: async () => new FakeSocket(),
      },
      createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
      createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
      preference: "p2p_only",
    });

    const connecting = transport.connect();
    await waitForCondition(() => signal.sent.some((text) => {
      const frame = JSON.parse(text) as { type?: unknown; payload?: { kind?: unknown } };
      return frame.type === "signal" && frame.payload?.kind === "webrtc_offer";
    }));
    const offer = signal.sent
      .map((text) => JSON.parse(text) as { type?: unknown; session_id?: unknown; payload?: { kind?: unknown } })
      .find((frame) => frame.type === "signal" && frame.payload?.kind === "webrtc_offer");
    const sessionId = typeof offer?.session_id === "string" ? offer.session_id : "";
    expect(sessionId).not.toBe("");
    for (let index = 0; index <= MAX_PENDING_ICE_SIGNALS_PER_SESSION; index += 1) {
      signal.handlers?.onText(JSON.stringify(remoteIceCandidate(sessionId, index)));
    }

    await expect(connecting).rejects.toThrow("Too many remote ICE signals");
  });

  it("fails P2P-only connection when local pre-offer ICE exceeds its per-session limit", async () => {
    let peer!: FakePeerConnection;
    peer = new FakePeerConnection(() => {
      for (let index = 0; index <= MAX_PENDING_ICE_SIGNALS_PER_SESSION; index += 1) {
        peer.emitLocalIce({
          candidate: `candidate:${index}`,
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        } as RTCIceCandidate);
      }
    });
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: {
        openSignal: async () => new FakeSocket(),
        openRelay: async () => new FakeSocket(),
      },
      createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      preference: "p2p_only",
    });

    await expect(transport.connect()).rejects.toThrow("Too many local ICE signals");
  });

  it("falls back to TCP relay when an active P2P signal lease closes", async () => {
    const signal = new FakeSocket();
    const peer = new FakePeerConnection();
    const errors: Error[] = [];
    const states: Array<{ kind: string; transport?: string }> = [];
    const relay = new FakeSocket((text, socket) => {
      const frame = JSON.parse(text) as { type?: unknown; session_id?: unknown };
      if (frame.type === "open" && typeof frame.session_id === "string") {
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "ready",
          session_id: frame.session_id,
        })));
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "peer_connected",
          device_id: SESSION.invitation.desktop.device_id,
          session_id: frame.session_id,
        })));
      }
    });
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: {
        openSignal: async () => signal,
        openRelay: async () => relay,
      },
      createFrameCodec: async () => ({ seal: async (value) => value, open: async (value) => value }),
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      onStateChange: (state) => states.push(state),
      onTransportError: (error) => errors.push(error),
    });

    const connected = transport.connect();
    await vi.waitFor(() => expect(peer.dataChannel).not.toBeNull());
    peer.dataChannel!.onopen?.(new Event("open"));
    await expect(connected).resolves.toMatchObject({ transport: "p2p" });

    signal.handlers?.onClose();

    await waitForCondition(() => states.some((state) => state.kind === "connected" && state.transport === "tcp_relay"));

    expect(errors).toHaveLength(0);
    expect(states.map((state) => state.kind)).toEqual([
      "connecting_signal",
      "negotiating_p2p",
      "verifying_p2p",
      "connected",
      "falling_back",
      "connected",
    ]);
    transport.close();
  });

  it("rejects relay-only connect when opening the TCP relay fails", async () => {
    const signal = new FakeSocket();
    const factory: AuthorizedGatewaySocketFactory = {
      openSignal: async () => signal,
      openRelay: async () => {
        throw new Error("relay unavailable");
      },
    };
    const codec: EncryptedFrameCodec = { seal: async (value) => value, open: async (value) => value };
    const states: string[] = [];
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: factory,
      createFrameCodec: async () => codec,
      preference: "tcp_relay_only",
      onStateChange: (state) => states.push(state.kind),
    });

    await expect(transport.connect()).rejects.toThrow("relay unavailable");
    expect(states).toEqual(["connecting_signal", "failed"]);
  });

  it("announces a failed direct attempt then uses a fresh relay session", async () => {
    vi.useFakeTimers();
    const signal = new FakeSocket();
    const relay = new FakeSocket((text, socket) => {
      const frame = JSON.parse(text) as { type: string; session_id?: string };
      if (frame.type === "open" && frame.session_id) {
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "ready",
          session_id: frame.session_id,
        })));
        queueMicrotask(() => socket.handlers?.onText(JSON.stringify({
          type: "peer_connected",
          device_id: SESSION.invitation.desktop.device_id,
          session_id: frame.session_id,
        })));
      }
    });
    const factory: AuthorizedGatewaySocketFactory = {
      openSignal: async () => signal,
      openRelay: async () => relay,
    };
    const codec: EncryptedFrameCodec = { seal: async (value) => value, open: async (value) => value };
    const transport = new P2pFirstTransport({
      session: SESSION,
      socketFactory: factory,
      createFrameCodec: async () => codec,
      createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
      p2pTimeoutMs: 1_000,
    });

    const connected = transport.connect();
    await vi.advanceTimersByTimeAsync(1_000);
    const active = await connected;

    const frames = transportSignalFrames(signal);
    const offer = frames.find((frame) => frame.payload.kind === "webrtc_offer");
    const failed = frames.find((frame) => frame.payload.kind === "p2p_failed");
    const relayOffer = frames.find((frame) => frame.payload.kind === "relay_offer");
    expect(active.transport).toBe("tcp_relay");
    expect(offer?.session_id).toBe(failed?.session_id);
    expect(relayOffer?.session_id).not.toBe(offer?.session_id);
    transport.close();
    vi.useRealTimers();
  });
});

function remoteIceCandidate(sessionId: string, index: number): Record<string, unknown> {
  return {
    type: "signal",
    from: SESSION.invitation.desktop.device_id,
    session_id: sessionId,
    payload: {
      kind: "webrtc_ice_candidate",
      protocol_version: 1,
      candidate: `candidate:${index}`,
      sdp_mid: "0",
      sdp_m_line_index: 0,
    },
  };
}

function lastSignalFrame(socket: FakeSocket, type: string): Record<string, unknown> {
  const frame = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((candidate) => candidate.type === type)
    .at(-1);
  if (!frame) {
    throw new Error(`expected a ${type} signal frame`);
  }
  return frame;
}

function transportSignalFrames(socket: FakeSocket): Array<{
  type: "signal";
  session_id: string;
  payload: { kind: string };
}> {
  return socket.sent
    .map((text) => JSON.parse(text) as { type?: unknown; session_id?: unknown; payload?: { kind?: unknown } })
    .filter((frame): frame is { type: "signal"; session_id: string; payload: { kind: string } } => (
      frame.type === "signal" && typeof frame.session_id === "string" && typeof frame.payload?.kind === "string"
    ));
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition did not become true after queued microtasks");
}
