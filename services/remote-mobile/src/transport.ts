import { gatewayEndpoint, RemoteProtocolError } from "./protocol";
import {
  CURRENT_PROTOCOL_VERSION,
  type EncryptedFrameCodec,
  type GatewayInboundSignal,
  type GatewayRelayControl,
  type GatewayRelayOpen,
  type GatewaySignalMessage,
  type P2pFailureReason,
  type PairedMobileSession,
  type TransportSignal,
} from "./types";

export const WEBRTC_CONTROL_CHANNEL_LABEL = "somniq-control-v1";
const MAX_WEBRTC_SDP_BYTES = 64 * 1024;
const MAX_WEBRTC_ICE_CANDIDATE_BYTES = 4 * 1024;
const MAX_WEBRTC_ICE_FIELD_BYTES = 256;
const MAX_ENCRYPTED_FRAME_BYTES = 256 * 1024;
/**
 * A normal WebRTC exchange needs only a small number of candidates. Bound
 * both queues per P2P attempt so an authenticated-but-malicious peer (or a
 * broken browser) cannot retain unbounded candidate objects while SDP setup
 * is still pending.
 */
export const MAX_PENDING_ICE_SIGNALS_PER_SESSION = 64;
/** The gateway signal socket is a direct-P2P authorization lease, not just SDP plumbing. */
export const SIGNAL_HEARTBEAT_INTERVAL_MS = 10_000;
export const SIGNAL_HEARTBEAT_TIMEOUT_MS = 30_000;
/**
 * A transient gateway WebSocket close must not turn a failed direct route
 * into a permanent mobile disconnect. The relay still needs a live signal
 * channel to ask the desktop to join, so retry that small control-plane
 * connection before giving up on the encrypted fallback.
 */
const SIGNAL_RECONNECT_ATTEMPTS = 3;
const SIGNAL_RECONNECT_DELAY_MS = 500;

export type TransportPreference = "prefer_p2p" | "p2p_only" | "tcp_relay_only";

export interface GatewaySocketHandlers {
  onText(text: string): void;
  onBinary(data: Uint8Array): void;
  onClose(): void;
  onError(): void;
}

/**
 * A WebSocket handle without a browser-specific authentication API. The
 * browser implementation belongs behind a one-time WS ticket / subprotocol;
 * native wrappers can instead set an Authorization header themselves.
 */
export interface GatewaySocket {
  setHandlers(handlers: GatewaySocketHandlers): void;
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}

export interface AuthorizedGatewaySocketFactory {
  openSignal(input: GatewaySocketOpenInput): Promise<GatewaySocket>;
  openRelay(input: GatewaySocketOpenInput): Promise<GatewaySocket>;
}

export interface GatewaySocketOpenInput {
  gatewayUrl: string;
  credential: string;
}

export interface P2pFirstTransportOptions {
  session: PairedMobileSession;
  socketFactory: AuthorizedGatewaySocketFactory;
  /**
   * Must return an XChaCha20-Poly1305 SecureEnvelope codec bound to the
   * supplied fresh session ID. This PWA transport never transmits plaintext.
   */
  createFrameCodec(sessionId: string): Promise<EncryptedFrameCodec>;
  preference?: TransportPreference;
  rtcConfiguration?: RTCConfiguration;
  p2pTimeoutMs?: number;
  relayPeerTimeoutMs?: number;
  createPeerConnection?: (configuration: RTCConfiguration | undefined) => RTCPeerConnection;
  onStateChange?: (state: TransportState) => void;
  onPlaintextFrame?: (plaintext: Uint8Array) => void;
  onTransportError?: (error: Error) => void;
}

export type TransportState =
  | { kind: "connecting_signal" }
  | { kind: "negotiating_p2p"; sessionId: string }
  | { kind: "verifying_p2p"; sessionId: string }
  | {
      kind: "connected";
      transport: "p2p" | "tcp_relay";
      sessionId: string;
      fallbackReason?: P2pFailureReason;
      directPath?: VerifiedDirectP2pPath;
    }
  | { kind: "falling_back"; reason: P2pFailureReason }
  | { kind: "closed" }
  | { kind: "failed" };

export type DirectIceCandidateType = "host" | "srflx" | "prflx";

/**
 * Non-address metadata from the browser's selected ICE candidate pair. This
 * is attached only after the data channel opened and getStats confirmed that
 * neither endpoint is a TURN/relay candidate.
 */
export interface VerifiedDirectP2pPath {
  localCandidateType: DirectIceCandidateType;
  remoteCandidateType: DirectIceCandidateType;
  protocol: string | null;
}

export interface ActiveTransport {
  transport: "p2p" | "tcp_relay";
  sessionId: string;
  fallbackReason?: P2pFailureReason;
  directPath?: VerifiedDirectP2pPath;
}

/**
 * Mobile-offerer WebRTC transport. It sends one direct P2P offer, waits for a
 * reliable data channel, and only then uses it. A direct failure first emits
 * `p2p_failed` on the failed session and opens a **fresh** relay session.
 */
export class P2pFirstTransport {
  private readonly preference: TransportPreference;
  private readonly p2pTimeoutMs: number;
  private readonly relayPeerTimeoutMs: number;
  private readonly createPeerConnection: (configuration: RTCConfiguration | undefined) => RTCPeerConnection;
  private signalSocket: GatewaySocket | null = null;
  private relaySocket: GatewaySocket | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private codec: EncryptedFrameCodec | null = null;
  private active: ActiveTransport | null = null;
  /** The gateway's relay `ready` frame must precede application ciphertext. */
  private relayReady = false;
  /** The desktop's relay endpoint has joined the same fresh session. */
  private relayPeerConnected = false;
  private p2pSessionId: string | null = null;
  private relaySessionId: string | null = null;
  private relayOfferSent = false;
  /** ICE emitted before the mobile SDP offer has reached the gateway. */
  private readonly pendingLocalIceSignals: Array<
    Extract<TransportSignal, { kind: "webrtc_ice_candidate" | "webrtc_ice_complete" }>
  > = [];
  /** Desktop ICE received before setRemoteDescription(answer) completes. */
  private readonly pendingRemoteIceSignals: Array<
    Extract<TransportSignal, { kind: "webrtc_ice_candidate" | "webrtc_ice_complete" }>
  > = [];
  private localOfferSentSessionId: string | null = null;
  private remoteAnswerAppliedSessionId: string | null = null;
  private p2pTimer: ReturnType<typeof setTimeout> | null = null;
  private relayTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private signalLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSignalPongNonce: string | null = null;
  private signalReconnectTask: Promise<void> | null = null;
  private relayOpening = false;
  private resolveConnection: ((transport: ActiveTransport) => void) | null = null;
  private rejectConnection: ((error: Error) => void) | null = null;
  private closed = false;
  private fallingBack = false;

  constructor(private readonly options: P2pFirstTransportOptions) {
    this.preference = options.preference ?? "prefer_p2p";
    this.p2pTimeoutMs = boundedTimeout(options.p2pTimeoutMs ?? 7_000, "P2P timeout");
    this.relayPeerTimeoutMs = boundedTimeout(options.relayPeerTimeoutMs ?? 10_000, "relay timeout");
    this.createPeerConnection = options.createPeerConnection ?? defaultPeerConnection;
  }

  async connect(): Promise<ActiveTransport> {
    if (this.resolveConnection || this.active || this.closed) {
      throw new RemoteProtocolError("This remote transport instance cannot be connected more than once.");
    }
    this.emitState({ kind: "connecting_signal" });
    const completion = new Promise<ActiveTransport>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    try {
      await this.openSignalSocket();
      if (this.preference === "tcp_relay_only") {
        // `connect()` owns the completion promise. Do not let a rejected
        // relay factory become an unobserved background rejection that leaves
        // callers waiting forever when the user explicitly chose relay only.
        void this.beginRelay(undefined).catch((error: unknown) => {
          this.failConnection(toRemoteError(error, "Cannot establish the encrypted relay connection."));
        });
      } else {
        void this.beginP2p();
      }
    } catch (error) {
      this.failConnection(toRemoteError(error, "Cannot open the gateway signal connection."));
    }
    return completion;
  }

  /** Encrypts then sends a control frame over whichever route won selection. */
  async send(plaintext: Uint8Array): Promise<void> {
    const active = this.active;
    const codec = this.codec;
    if (!active || !codec) {
      throw new RemoteProtocolError("The remote transport is not connected.");
    }
    const ciphertext = await codec.seal(plaintext);
    // A P2P failure can asynchronously promote a fresh-ID relay while
    // WebCrypto is sealing. Never put ciphertext derived for the old session
    // on the new transport.
    if (this.closed || this.active !== active || this.codec !== codec) {
      throw new RemoteProtocolError("The remote transport changed while encrypting a control frame.");
    }
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_ENCRYPTED_FRAME_BYTES) {
      throw new RemoteProtocolError("The encrypted remote frame exceeds the transport limit.");
    }
    if (active.transport === "p2p") {
      if (!this.dataChannel || this.dataChannel.readyState !== "open") {
        throw new RemoteProtocolError("The P2P data channel is no longer open.");
      }
      this.dataChannel.send(toArrayBuffer(ciphertext));
      return;
    }
    if (!this.relaySocket) {
      throw new RemoteProtocolError("The relay connection is no longer open.");
    }
    this.relaySocket.sendBinary(ciphertext);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimers();
    this.clearSignalHeartbeatTimers();
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.relaySocket?.close();
    this.signalSocket?.close();
    this.signalSocket = null;
    this.relaySocket = null;
    this.emitState({ kind: "closed" });
    if (!this.active) {
      this.rejectConnection?.(new RemoteProtocolError("The remote transport was closed before connecting."));
    }
    this.resolveConnection = null;
    this.rejectConnection = null;
  }

  private async beginP2p(): Promise<void> {
    if (this.closed) {
      return;
    }
    let sessionId: string;
    try {
      sessionId = freshSessionId();
      this.p2pSessionId = sessionId;
      this.codec = await this.options.createFrameCodec(sessionId);
      const peerConnection = this.createPeerConnection(this.options.rtcConfiguration);
      this.peerConnection = peerConnection;
      this.emitState({ kind: "negotiating_p2p", sessionId });
      peerConnection.onicecandidate = (event) => {
        if (this.closed || this.p2pSessionId !== sessionId) {
          return;
        }
        if (!event.candidate) {
          this.sendOrBufferLocalIce(sessionId, { kind: "webrtc_ice_complete", protocol_version: CURRENT_PROTOCOL_VERSION });
          return;
        }
        const candidate: TransportSignal = {
          kind: "webrtc_ice_candidate",
          protocol_version: CURRENT_PROTOCOL_VERSION,
          candidate: event.candidate.candidate,
          sdp_mid: event.candidate.sdpMid,
          sdp_m_line_index: event.candidate.sdpMLineIndex,
          username_fragment: event.candidate.usernameFragment,
        };
        if (isValidTransportSignal(candidate)) {
          this.sendOrBufferLocalIce(sessionId, candidate);
        } else {
          void this.fallBackToRelay("negotiation_failed");
        }
      };
      peerConnection.onconnectionstatechange = () => {
        if (this.p2pSessionId !== sessionId) {
          return;
        }
        if (peerConnection.connectionState === "failed") {
          void this.fallBackToRelay(
            "ice_failed",
            new RemoteProtocolError("The P2P peer connection failed."),
          );
        } else if (peerConnection.connectionState === "closed") {
          void this.fallBackToRelay(
            "cancelled",
            new RemoteProtocolError("The P2P peer connection closed."),
          );
        }
      };
      const dataChannel = peerConnection.createDataChannel(WEBRTC_CONTROL_CHANNEL_LABEL, { ordered: true });
      this.dataChannel = dataChannel;
      dataChannel.binaryType = "arraybuffer";
      dataChannel.onopen = () => {
        if (this.closed || this.p2pSessionId !== sessionId || this.fallingBack) {
          return;
        }
        this.emitState({ kind: "verifying_p2p", sessionId });
        void this.activateVerifiedP2p(peerConnection, sessionId);
      };
      dataChannel.onclose = () => {
        if (this.p2pSessionId === sessionId) {
          void this.fallBackToRelay(
            "data_channel_failed",
            new RemoteProtocolError("The P2P data channel closed."),
          );
        }
      };
      dataChannel.onerror = () => void this.fallBackToRelay(
        "data_channel_failed",
        new RemoteProtocolError("The P2P data channel failed."),
      );
      dataChannel.onmessage = (event) => void this.handleCiphertext(event.data, "p2p", sessionId);

      const offer = await peerConnection.createOffer();
      if (this.closed || this.p2pSessionId !== sessionId) {
        return;
      }
      if (!offer.sdp || !isValidTransportSignal({ kind: "webrtc_offer", protocol_version: CURRENT_PROTOCOL_VERSION, sdp: offer.sdp })) {
        throw new RemoteProtocolError("The browser created an invalid WebRTC offer.");
      }
      await peerConnection.setLocalDescription(offer);
      if (this.closed || this.p2pSessionId !== sessionId) {
        return;
      }
      this.localOfferSentSessionId = sessionId;
      if (!this.trySendTransportSignal(sessionId, {
        kind: "webrtc_offer",
        protocol_version: CURRENT_PROTOCOL_VERSION,
        sdp: offer.sdp,
      })) {
        await this.fallBackToRelay(
          "negotiation_failed",
          new RemoteProtocolError("The gateway signal connection closed while starting P2P."),
        );
        return;
      }
      this.flushLocalIceSignals(sessionId);
      this.p2pTimer = setTimeout(() => void this.fallBackToRelay("ice_timeout"), this.p2pTimeoutMs);
    } catch (error) {
      await this.fallBackToRelay("negotiation_failed", toRemoteError(error, "Unable to start a direct P2P connection."));
    }
  }

  private handleSignalText(text: string): void {
    const frame = parseGatewayInboundSignal(text);
    if (!frame || this.closed) {
      return;
    }
    if (frame.type === "pong") {
      this.handleSignalPong(frame.nonce);
      return;
    }
    if (frame.type === "error") {
      if (!this.active || this.active.transport === "p2p") {
        void this.fallBackToRelay(
          "negotiation_failed",
          new RemoteProtocolError(`The remote gateway rejected signaling (${frame.code}).`),
        );
      }
      return;
    }
    if (frame.type === "revoked" && frame.device_id === this.options.session.mobile.device_id) {
      this.failConnection(new RemoteProtocolError("This mobile device was revoked by the desktop."));
      return;
    }
    if (frame.type !== "signal" || frame.from !== this.options.session.invitation.desktop.device_id) {
      return;
    }
    if (frame.session_id !== this.p2pSessionId || !this.peerConnection) {
      return;
    }
    void this.handleP2pSignal(frame.payload, frame.session_id);
  }

  private async handleP2pSignal(payload: TransportSignal, sessionId: string): Promise<void> {
    if (!this.peerConnection || this.closed || this.p2pSessionId !== sessionId || this.fallingBack) {
      return;
    }
    try {
      switch (payload.kind) {
        case "webrtc_answer":
          if (this.remoteAnswerAppliedSessionId === sessionId) {
            break;
          }
          await this.peerConnection.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          this.remoteAnswerAppliedSessionId = sessionId;
          await this.flushRemoteIceSignals(sessionId);
          break;
        case "webrtc_ice_candidate":
          if (this.remoteAnswerAppliedSessionId !== sessionId) {
            if (!this.enqueueRemoteIceSignal(payload)) {
              await this.fallBackToRelay(
                "negotiation_failed",
                new RemoteProtocolError("Too many remote ICE signals arrived before the WebRTC answer."),
              );
              return;
            }
          } else {
            await this.addRemoteIceSignal(payload);
          }
          break;
        case "webrtc_ice_complete":
          if (this.remoteAnswerAppliedSessionId !== sessionId) {
            if (!this.enqueueRemoteIceSignal(payload)) {
              await this.fallBackToRelay(
                "negotiation_failed",
                new RemoteProtocolError("Too many remote ICE signals arrived before the WebRTC answer."),
              );
              return;
            }
          } else {
            await this.addRemoteIceSignal(payload);
          }
          break;
        case "p2p_failed":
          await this.fallBackToRelay(payload.reason);
          break;
        case "webrtc_offer":
        case "relay_offer":
          // P2 has a single mobile offerer. Ignore unsupported glare/relay
          // control rather than accepting an unreviewed renegotiation path.
          break;
      }
    } catch (error) {
      await this.fallBackToRelay("negotiation_failed", toRemoteError(error, "WebRTC signaling failed."));
    }
  }

  private async fallBackToRelay(reason: P2pFailureReason, originalError?: Error): Promise<void> {
    if (
      this.closed ||
      this.fallingBack ||
      (this.active !== null && this.active.transport !== "p2p")
    ) {
      return;
    }
    this.fallingBack = true;
    this.clearP2pTimer();
    const failedSessionId = this.p2pSessionId;
    if (failedSessionId) {
      // This notification is useful cleanup metadata, but it is not required
      // for the fresh encrypted relay. A dropped direct signal must never
      // prevent the relay path from reconnecting its own signal lease.
      this.trySendTransportSignal(failedSessionId, {
        kind: "p2p_failed",
        protocol_version: CURRENT_PROTOCOL_VERSION,
        reason,
      });
    }
    if (this.closed) {
      return;
    }
    // Clear active state before opening a new transport, then detach P2P
    // handlers before closing browser objects. This makes an onclose fired by
    // our own cleanup inert instead of recursively starting another fallback.
    if (this.active?.transport === "p2p") {
      this.active = null;
    }
    this.disposeP2pAttempt();
    this.p2pSessionId = null;
    this.localOfferSentSessionId = null;
    this.remoteAnswerAppliedSessionId = null;
    this.pendingLocalIceSignals.length = 0;
    this.pendingRemoteIceSignals.length = 0;
    this.codec = null;
    if (this.preference === "p2p_only") {
      this.failConnection(originalError ?? new RemoteProtocolError("A direct P2P connection could not be established."));
      return;
    }
    this.emitState({ kind: "falling_back", reason });
    try {
      await this.beginRelay(reason);
    } catch (error) {
      this.failConnection(toRemoteError(error, "Cannot establish the encrypted relay fallback."));
    }
  }

  private async activateVerifiedP2p(
    peerConnection: RTCPeerConnection,
    sessionId: string,
  ): Promise<void> {
    try {
      const directPath = await verifyDirectP2pPath(peerConnection);
      if (
        this.closed
        || this.fallingBack
        || this.peerConnection !== peerConnection
        || this.p2pSessionId !== sessionId
      ) {
        return;
      }
      this.activate({ transport: "p2p", sessionId, directPath });
    } catch (error) {
      if (
        this.closed
        || this.fallingBack
        || this.peerConnection !== peerConnection
        || this.p2pSessionId !== sessionId
      ) {
        return;
      }
      await this.fallBackToRelay(
        "negotiation_failed",
        toRemoteError(error, "The selected WebRTC route could not be verified as direct P2P."),
      );
    }
  }

  private disposeP2pAttempt(): void {
    const dataChannel = this.dataChannel;
    const peerConnection = this.peerConnection;
    this.dataChannel = null;
    this.peerConnection = null;

    if (dataChannel) {
      dataChannel.onopen = null;
      dataChannel.onclose = null;
      dataChannel.onerror = null;
      dataChannel.onmessage = null;
      dataChannel.close();
    }
    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }
  }

  private async beginRelay(fallbackReason: P2pFailureReason | undefined): Promise<void> {
    if (this.closed || this.active || this.relaySocket || this.relayOpening) {
      return;
    }
    this.relayOpening = true;
    try {
      const sessionId = freshSessionId();
      this.relaySessionId = sessionId;
      this.relayOfferSent = false;
      this.relayReady = false;
      this.relayPeerConnected = false;
      this.codec = await this.options.createFrameCodec(sessionId);
      await this.sendFreshRelayOffer(sessionId);
      if (this.closed) {
        return;
      }
      const relaySocket = await this.options.socketFactory.openRelay({
        gatewayUrl: this.options.session.invitation.gateway_url,
        credential: this.options.session.credential,
      });
      if (this.closed || this.relaySessionId !== sessionId) {
        relaySocket.close();
        return;
      }
      this.relaySocket = relaySocket;
      relaySocket.setHandlers({
        onText: (text) => this.handleRelayText(text, fallbackReason),
        onBinary: (data) => void this.handleCiphertext(data, "tcp_relay", sessionId),
        onClose: () => {
          if (!this.active) {
            this.failConnection(new RemoteProtocolError("The relay closed before the desktop joined."));
          } else if (this.active.transport === "tcp_relay") {
            this.failConnection(new RemoteProtocolError("The relay connection closed."));
          }
        },
        onError: () => this.failConnection(new RemoteProtocolError("The relay connection failed.")),
      });
      const opening: GatewayRelayOpen = {
        type: "open",
        peer_id: this.options.session.invitation.desktop.device_id,
        session_id: sessionId,
      };
      relaySocket.sendText(JSON.stringify(opening));
      this.relayTimer = setTimeout(() => {
        this.failConnection(new RemoteProtocolError("The desktop did not join the relay before the timeout."));
      }, this.relayPeerTimeoutMs);
    } finally {
      this.relayOpening = false;
    }
  }

  private handleRelayText(text: string, fallbackReason: P2pFailureReason | undefined): void {
    const frame = parseRelayControl(text);
    if (!frame || this.closed) {
      return;
    }
    if (frame.type === "error") {
      this.failConnection(new RemoteProtocolError(`The remote relay rejected the session (${frame.code}).`));
      return;
    }
    if (frame.type === "pong") {
      return;
    }
    if (frame.session_id !== this.relaySessionId) {
      return;
    }
    if (frame.type === "ready") {
      this.relayReady = true;
    } else if (frame.type === "peer_connected") {
      this.relayPeerConnected = true;
    }
    if (this.relayReady && this.relayPeerConnected) {
      this.clearRelayTimer();
      this.activate({ transport: "tcp_relay", sessionId: frame.session_id, fallbackReason });
    }
  }

  private activate(active: ActiveTransport): void {
    if (this.closed || this.active) {
      return;
    }
    this.clearTimers();
    if (active.transport === "tcp_relay") {
      // The relay socket itself is the authenticated transport after
      // fallback. Keeping a P2P signal lease alive here would make a healthy
      // relay fail solely because the auxiliary signaling socket is idle.
      this.clearSignalHeartbeatTimers();
    }
    this.active = active;
    this.emitState({
      kind: "connected",
      transport: active.transport,
      sessionId: active.sessionId,
      ...(active.fallbackReason ? { fallbackReason: active.fallbackReason } : {}),
      ...(active.directPath ? { directPath: active.directPath } : {}),
    });
    this.resolveConnection?.(active);
    this.resolveConnection = null;
    this.rejectConnection = null;
  }

  private async handleCiphertext(
    value: unknown,
    source: "p2p" | "tcp_relay",
    sessionId: string,
  ): Promise<void> {
    const codec = this.codec;
    if (!codec || this.closed) {
      return;
    }
    if (source === "p2p") {
      // A delayed DataChannel callback from the discarded P2P attempt must
      // never be opened with the fresh relay codec.
      if (this.active?.transport !== "p2p" || this.active.sessionId !== sessionId) {
        return;
      }
    } else if (
      this.active?.transport !== "tcp_relay" ||
      this.active.sessionId !== sessionId ||
      !this.relayReady ||
      !this.relayPeerConnected
    ) {
      this.failConnection(new RemoteProtocolError("The relay sent encrypted data before the session was ready."));
      return;
    }
    try {
      const data = await binaryFrame(value);
      if (data.byteLength === 0 || data.byteLength > MAX_ENCRYPTED_FRAME_BYTES) {
        throw new RemoteProtocolError("The encrypted remote frame exceeds the transport limit.");
      }
      const plaintext = await codec.open(data);
      // A late callback from a closing P2P channel is not a relay frame. If
      // transport rollover happened while opening it, silently drop it rather
      // than authenticating it against the fresh relay key or failing that
      // newly established route.
      if (this.closed || this.codec !== codec) {
        return;
      }
      this.options.onPlaintextFrame?.(plaintext);
    } catch (error) {
      if (!this.closed && this.codec === codec) {
        this.failConnection(toRemoteError(error, "An encrypted remote frame could not be authenticated."));
      }
    }
  }

  private trySendTransportSignal(sessionId: string, payload: TransportSignal): boolean {
    const signalSocket = this.signalSocket;
    if (!signalSocket || this.closed || !isValidTransportSignal(payload)) {
      return false;
    }
    const frame: GatewaySignalMessage = {
      type: "signal",
      to: this.options.session.invitation.desktop.device_id,
      session_id: sessionId,
      payload,
    };
    try {
      signalSocket.sendText(JSON.stringify(frame));
      return true;
    } catch {
      this.handleSignalClosed(signalSocket);
      return false;
    }
  }

  private sendOrBufferLocalIce(
    sessionId: string,
    payload: Extract<TransportSignal, { kind: "webrtc_ice_candidate" | "webrtc_ice_complete" }>,
  ): void {
    if (this.localOfferSentSessionId !== sessionId) {
      if (this.pendingLocalIceSignals.length >= MAX_PENDING_ICE_SIGNALS_PER_SESSION) {
        void this.fallBackToRelay(
          "negotiation_failed",
          new RemoteProtocolError("Too many local ICE signals were emitted before the WebRTC offer."),
        );
        return;
      }
      this.pendingLocalIceSignals.push(payload);
      return;
    }
    if (!this.trySendTransportSignal(sessionId, payload)) {
      void this.fallBackToRelay(
        "negotiation_failed",
        new RemoteProtocolError("The gateway signal connection closed while sending ICE."),
      );
    }
  }

  private enqueueRemoteIceSignal(
    payload: Extract<TransportSignal, { kind: "webrtc_ice_candidate" | "webrtc_ice_complete" }>,
  ): boolean {
    if (this.pendingRemoteIceSignals.length >= MAX_PENDING_ICE_SIGNALS_PER_SESSION) {
      return false;
    }
    this.pendingRemoteIceSignals.push(payload);
    return true;
  }

  private flushLocalIceSignals(sessionId: string): void {
    if (this.localOfferSentSessionId !== sessionId) {
      return;
    }
    const pending = this.pendingLocalIceSignals.splice(0);
    for (const payload of pending) {
      if (!this.trySendTransportSignal(sessionId, payload)) {
        void this.fallBackToRelay(
          "negotiation_failed",
          new RemoteProtocolError("The gateway signal connection closed while sending ICE."),
        );
        return;
      }
    }
  }

  private async flushRemoteIceSignals(sessionId: string): Promise<void> {
    if (this.remoteAnswerAppliedSessionId !== sessionId) {
      return;
    }
    while (this.pendingRemoteIceSignals.length > 0) {
      const payload = this.pendingRemoteIceSignals.shift();
      if (!payload) {
        continue;
      }
      await this.addRemoteIceSignal(payload);
    }
  }

  private async addRemoteIceSignal(
    payload: Extract<TransportSignal, { kind: "webrtc_ice_candidate" | "webrtc_ice_complete" }>,
  ): Promise<void> {
    if (!this.peerConnection) {
      throw new RemoteProtocolError("The WebRTC peer connection is unavailable.");
    }
    if (payload.kind === "webrtc_ice_complete") {
      await this.peerConnection.addIceCandidate(null);
      return;
    }
    await this.peerConnection.addIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdp_mid ?? null,
      sdpMLineIndex: payload.sdp_m_line_index ?? null,
      usernameFragment: payload.username_fragment ?? null,
    });
  }

  private handleSignalClosed(closedSocket: GatewaySocket): void {
    // A close from a superseded socket must not erase a freshly reconnected
    // signal channel that is carrying the relay offer.
    if (this.signalSocket !== closedSocket) {
      return;
    }
    this.signalSocket = null;
    this.clearSignalHeartbeatTimers();
    // A direct P2P path still relies on the gateway signal connection as its
    // authorization lease. If it disappears, continuing to accept a data
    // channel would outlive the pairing/session authorization boundary. Close
    // it and use a fresh signal lease to ask the desktop to join TCP relay.
    if (!this.closed && this.active?.transport !== "tcp_relay" && !this.relayOpening) {
      void this.fallBackToRelay(
        "cancelled",
        new RemoteProtocolError("The gateway signal connection closed."),
      );
    }
  }

  private failConnection(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimers();
    this.clearSignalHeartbeatTimers();
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.relaySocket?.close();
    this.signalSocket?.close();
    this.signalSocket = null;
    this.relaySocket = null;
    this.relayReady = false;
    this.relayPeerConnected = false;
    this.emitState({ kind: "failed" });
    this.options.onTransportError?.(error);
    this.rejectConnection?.(error);
    this.resolveConnection = null;
    this.rejectConnection = null;
  }

  private clearTimers(): void {
    this.clearP2pTimer();
    this.clearRelayTimer();
  }

  private startSignalHeartbeat(): void {
    this.clearSignalHeartbeatTimers();
    this.signalHeartbeatTimer = setInterval(() => this.sendSignalHeartbeat(), SIGNAL_HEARTBEAT_INTERVAL_MS);
    this.sendSignalHeartbeat();
  }

  private sendSignalHeartbeat(): void {
    const signalSocket = this.signalSocket;
    if (this.closed || !signalSocket || this.pendingSignalPongNonce) {
      return;
    }
    let nonce: string;
    try {
      nonce = freshSessionId();
    } catch (error) {
      this.failConnection(toRemoteError(error, "Cannot create a gateway signal heartbeat nonce."));
      return;
    }
    this.pendingSignalPongNonce = nonce;
    this.signalLeaseTimer = setTimeout(() => {
      if (!this.closed && this.pendingSignalPongNonce === nonce) {
        this.handleSignalClosed(signalSocket);
      }
    }, SIGNAL_HEARTBEAT_TIMEOUT_MS);
    try {
      signalSocket.sendText(JSON.stringify({ type: "ping", nonce }));
    } catch {
      this.handleSignalClosed(signalSocket);
    }
  }

  private handleSignalPong(nonce: string | undefined): void {
    // Pongs without our fresh nonce, including stale pongs from an earlier
    // heartbeat, are not evidence that the current authorization lease is
    // still live.
    if (!nonce || nonce !== this.pendingSignalPongNonce) {
      return;
    }
    this.pendingSignalPongNonce = null;
    this.clearSignalLeaseTimer();
  }

  private clearSignalHeartbeatTimers(): void {
    if (this.signalHeartbeatTimer) {
      clearInterval(this.signalHeartbeatTimer);
      this.signalHeartbeatTimer = null;
    }
    this.clearSignalLeaseTimer();
    this.pendingSignalPongNonce = null;
  }

  private clearSignalLeaseTimer(): void {
    if (this.signalLeaseTimer) {
      clearTimeout(this.signalLeaseTimer);
      this.signalLeaseTimer = null;
    }
  }

  private clearP2pTimer(): void {
    if (this.p2pTimer) {
      clearTimeout(this.p2pTimer);
      this.p2pTimer = null;
    }
  }

  private clearRelayTimer(): void {
    if (this.relayTimer) {
      clearTimeout(this.relayTimer);
      this.relayTimer = null;
    }
  }

  private async openSignalSocket(): Promise<void> {
    const signalSocket = await this.options.socketFactory.openSignal({
      gatewayUrl: this.options.session.invitation.gateway_url,
      credential: this.options.session.credential,
    });
    if (this.closed) {
      signalSocket.close();
      throw new RemoteProtocolError("The remote transport was closed before the signal connection opened.");
    }
    this.installSignalSocket(signalSocket);
  }

  private installSignalSocket(signalSocket: GatewaySocket): void {
    const previous = this.signalSocket;
    this.signalSocket = signalSocket;
    previous?.close();
    signalSocket.setHandlers({
      onText: (text) => this.handleSignalText(text),
      onBinary: () => this.handleSignalClosed(signalSocket),
      onClose: () => this.handleSignalClosed(signalSocket),
      // An active relay owns an independent authenticated WebSocket. Signal
      // loss is ignored only after relay activation; beforehand it triggers a
      // fresh signal lease so the desktop can still join that relay.
      onError: () => this.handleSignalClosed(signalSocket),
    });
    this.startSignalHeartbeat();
  }

  private async sendFreshRelayOffer(sessionId: string): Promise<void> {
    if (this.relayOfferSent && this.relaySessionId === sessionId) {
      return;
    }
    for (let attempt = 0; attempt < SIGNAL_RECONNECT_ATTEMPTS; attempt += 1) {
      if (this.closed || this.relaySessionId !== sessionId) {
        return;
      }
      try {
        await this.ensureSignalForRelay();
      } catch (error) {
        if (attempt + 1 >= SIGNAL_RECONNECT_ATTEMPTS) {
          throw toRemoteError(error, "Cannot reconnect the gateway signal channel for TCP relay.");
        }
        await signalReconnectDelay();
        continue;
      }
      if (this.trySendTransportSignal(sessionId, {
        kind: "relay_offer",
        protocol_version: CURRENT_PROTOCOL_VERSION,
      })) {
        this.relayOfferSent = true;
        return;
      }
      if (attempt + 1 < SIGNAL_RECONNECT_ATTEMPTS) {
        await signalReconnectDelay();
      }
    }
    throw new RemoteProtocolError("Cannot send the relay offer through the gateway signal channel.");
  }

  private async ensureSignalForRelay(): Promise<void> {
    if (this.signalSocket) {
      return;
    }
    if (!this.signalReconnectTask) {
      this.signalReconnectTask = this.openSignalSocket().finally(() => {
        this.signalReconnectTask = null;
      });
    }
    await this.signalReconnectTask;
  }

  private emitState(state: TransportState): void {
    this.options.onStateChange?.(state);
  }
}

/**
 * Validates the browser-facing mirror of Rust `TransportSignal` before any
 * payload reaches RTCPeerConnection or is emitted toward the gateway.
 */
export function isValidTransportSignal(value: unknown): value is TransportSignal {
  if (!isRecord(value) || value.protocol_version !== CURRENT_PROTOCOL_VERSION || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "webrtc_offer":
    case "webrtc_answer":
      return hasOnlyKeys(value, ["kind", "protocol_version", "sdp"]) && isValidSdp(value.sdp);
    case "webrtc_ice_candidate": {
      if (
        !hasOnlyKeys(value, ["kind", "protocol_version", "candidate", "sdp_mid", "sdp_m_line_index", "username_fragment"]) ||
        !isValidCandidate(value.candidate)
      ) {
        return false;
      }
      const hasMid = value.sdp_mid !== undefined && value.sdp_mid !== null;
      const hasLineIndex = value.sdp_m_line_index !== undefined && value.sdp_m_line_index !== null;
      return (
        (hasMid || hasLineIndex) &&
        (value.sdp_mid === undefined || value.sdp_mid === null || isValidVisibleAscii(value.sdp_mid, MAX_WEBRTC_ICE_FIELD_BYTES)) &&
        (value.sdp_m_line_index === undefined ||
          value.sdp_m_line_index === null ||
          (typeof value.sdp_m_line_index === "number" &&
            Number.isInteger(value.sdp_m_line_index) &&
            value.sdp_m_line_index >= 0 &&
            value.sdp_m_line_index <= 0xffff)) &&
        (value.username_fragment === undefined ||
          value.username_fragment === null ||
          isValidVisibleAscii(value.username_fragment, MAX_WEBRTC_ICE_FIELD_BYTES))
      );
    }
    case "webrtc_ice_complete":
    case "relay_offer":
      return hasOnlyKeys(value, ["kind", "protocol_version"]);
    case "p2p_failed":
      return (
        hasOnlyKeys(value, ["kind", "protocol_version", "reason"]) &&
        typeof value.reason === "string" &&
        isP2pFailureReason(value.reason)
      );
    default:
      return false;
  }
}

function parseGatewayInboundSignal(text: string): GatewayInboundSignal | null {
  if (new TextEncoder().encode(text).byteLength > MAX_ENCRYPTED_FRAME_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "ready":
      return typeof value.device_id === "string" && hasOnlyKeys(value, ["type", "device_id"])
        ? { type: "ready", device_id: value.device_id }
        : null;
    case "presence":
      return typeof value.device_id === "string" && typeof value.online === "boolean" && hasOnlyKeys(value, ["type", "device_id", "online"])
        ? { type: "presence", device_id: value.device_id, online: value.online }
        : null;
    case "signal":
      return (
        typeof value.from === "string" &&
        typeof value.session_id === "string" &&
        isValidTransportSignal(value.payload) &&
        hasOnlyKeys(value, ["type", "from", "session_id", "payload"])
      )
        ? { type: "signal", from: value.from, session_id: value.session_id, payload: value.payload }
        : null;
    case "pong":
      return (value.nonce === undefined || typeof value.nonce === "string") && hasOnlyKeys(value, ["type", "nonce"])
        ? { type: "pong", ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}) }
        : null;
    case "error":
      return typeof value.code === "string" && typeof value.message === "string" && hasOnlyKeys(value, ["type", "code", "message"])
        ? { type: "error", code: value.code, message: value.message }
        : null;
    case "revoked":
      return typeof value.device_id === "string" && hasOnlyKeys(value, ["type", "device_id"])
        ? { type: "revoked", device_id: value.device_id }
        : null;
    default:
      return null;
  }
}

function parseRelayControl(text: string): GatewayRelayControl | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "ready":
      return typeof value.session_id === "string" && hasOnlyKeys(value, ["type", "session_id"])
        ? { type: "ready", session_id: value.session_id }
        : null;
    case "peer_connected":
    case "peer_disconnected":
      return typeof value.device_id === "string" && typeof value.session_id === "string" && hasOnlyKeys(value, ["type", "device_id", "session_id"])
        ? { type: value.type, device_id: value.device_id, session_id: value.session_id }
        : null;
    case "pong":
      return (value.nonce === undefined || typeof value.nonce === "string") && hasOnlyKeys(value, ["type", "nonce"])
        ? { type: "pong", ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}) }
        : null;
    case "error":
      return typeof value.code === "string" && typeof value.message === "string" && hasOnlyKeys(value, ["type", "code", "message"])
        ? { type: "error", code: value.code, message: value.message }
        : null;
    default:
      return null;
  }
}

function isValidSdp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && byteLength(value) <= MAX_WEBRTC_SDP_BYTES && /^[\t\r\n -~]+$/.test(value);
}

function isValidCandidate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("candidate:") &&
    byteLength(value) <= MAX_WEBRTC_ICE_CANDIDATE_BYTES &&
    /^[ -~]+$/.test(value)
  );
}

function isValidVisibleAscii(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= maximum && /^[ -~]+$/.test(value);
}

function isP2pFailureReason(value: string): value is P2pFailureReason {
  return ["ice_timeout", "ice_failed", "negotiation_failed", "data_channel_failed", "cancelled"].includes(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function binaryFrame(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new RemoteProtocolError("The remote transport sent a non-binary encrypted frame.");
}

function freshSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new RemoteProtocolError("This browser cannot generate a secure remote session ID.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultPeerConnection(configuration: RTCConfiguration | undefined): RTCPeerConnection {
  if (typeof globalThis.RTCPeerConnection !== "function") {
    throw new RemoteProtocolError("This mobile platform does not provide WebRTC.");
  }
  return new RTCPeerConnection(configuration);
}

const DIRECT_ICE_CANDIDATE_TYPES = new Set<DirectIceCandidateType>(["host", "srflx", "prflx"]);

/**
 * Proves that the open DataChannel selected a direct ICE candidate pair.
 * Signaling and STUN may still use the configured server, but application data
 * is never called P2P when either selected candidate is a TURN `relay` route
 * or when the browser cannot identify the selected pair.
 */
export async function verifyDirectP2pPath(
  peerConnection: RTCPeerConnection,
): Promise<VerifiedDirectP2pPath> {
  if (typeof peerConnection.getStats !== "function") {
    throw new RemoteProtocolError("The browser cannot verify the selected WebRTC route.");
  }
  const report = await peerConnection.getStats();
  const stats = new Map<string, RTCStats>();
  report.forEach((entry) => stats.set(entry.id, entry));

  const transports = [...stats.values()].filter((entry) => entry.type === "transport");
  const selectedPairId = transports
    .map((entry) => stringStat(entry, "selectedCandidatePairId"))
    .find((value): value is string => value !== null);
  const candidatePairs = [...stats.values()].filter((entry) => entry.type === "candidate-pair");
  const selectedPair = (selectedPairId ? stats.get(selectedPairId) : undefined)
    ?? candidatePairs.find((entry) => booleanStat(entry, "selected") === true)
    ?? candidatePairs.find((entry) => (
      stringStat(entry, "state") === "succeeded" && booleanStat(entry, "nominated") === true
    ));
  if (!selectedPair || selectedPair.type !== "candidate-pair") {
    throw new RemoteProtocolError("The browser did not report a selected ICE candidate pair.");
  }

  const localCandidateId = stringStat(selectedPair, "localCandidateId");
  const remoteCandidateId = stringStat(selectedPair, "remoteCandidateId");
  const localCandidate = localCandidateId ? stats.get(localCandidateId) : undefined;
  const remoteCandidate = remoteCandidateId ? stats.get(remoteCandidateId) : undefined;
  const localCandidateType = directCandidateType(localCandidate);
  const remoteCandidateType = directCandidateType(remoteCandidate);
  if (!localCandidateType || !remoteCandidateType) {
    throw new RemoteProtocolError("The selected WebRTC route is relayed or cannot be proven direct.");
  }

  const protocol = normalizeProtocol(
    stringStat(localCandidate, "protocol")
      ?? stringStat(selectedPair, "protocol")
      ?? stringStat(remoteCandidate, "protocol"),
  );
  return { localCandidateType, remoteCandidateType, protocol };
}

function directCandidateType(entry: RTCStats | undefined): DirectIceCandidateType | null {
  if (!entry || (entry.type !== "local-candidate" && entry.type !== "remote-candidate")) {
    return null;
  }
  const candidateType = stringStat(entry, "candidateType");
  return candidateType && DIRECT_ICE_CANDIDATE_TYPES.has(candidateType as DirectIceCandidateType)
    ? candidateType as DirectIceCandidateType
    : null;
}

function stringStat(entry: RTCStats | undefined, key: string): string | null {
  if (!entry) return null;
  const value = (entry as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanStat(entry: RTCStats, key: string): boolean | null {
  const value = (entry as unknown as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeProtocol(value: string | null): string | null {
  if (!value) return null;
  const protocol = value.trim().toLowerCase();
  return /^[a-z0-9+-]{1,16}$/.test(protocol) ? protocol : null;
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1_000 || value > 60_000) {
    throw new RemoteProtocolError(`${label} must be between 1 and 60 seconds.`);
  }
  return value;
}

function signalReconnectDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SIGNAL_RECONNECT_DELAY_MS));
}

function toRemoteError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new RemoteProtocolError(fallback);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Endpoint helper for factories that authenticate through a server-issued WS ticket. */
export function gatewayWebSocketEndpoint(gatewayUrl: string, path: "/v1/signal" | "/v1/relay"): string {
  return gatewayEndpoint(gatewayUrl, path, true);
}
