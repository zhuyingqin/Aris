import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  remoteControlP2pAnswer,
  remoteControlP2pClosed,
  remoteControlP2pFailed,
  remoteControlP2pFrame,
  remoteControlP2pIceCandidate,
  remoteControlP2pIceComplete,
  remoteControlP2pOpened,
  remoteControlP2pOffer,
  remoteControlP2pPending,
} from "../api/tauri";
import type {
  RemoteP2pDataInput,
  RemoteP2pAnswerInput,
  RemoteP2pFailureReason,
  RemoteP2pIceCandidate,
  RemoteP2pOffer,
  RemoteP2pStart,
  RemoteP2pSessionInput,
} from "../types";

// Keep this synchronized with remote_protocol::WEBRTC_CONTROL_CHANNEL_LABEL.
// The DataChannel is merely a carrier: every frame inside it is still an
// end-to-end encrypted SecureEnvelope processed by the Rust remote boundary.
const CONTROL_CHANNEL_LABEL = "somniq-control-v1";
const MAX_ENCRYPTED_FRAME_BYTES = 262_144;
const MAX_REMOTE_ICE_CANDIDATES = 64;
const NEGOTIATION_TIMEOUT_MS = 20_000;

type ActiveP2pSession = RemoteP2pSessionInput & {
  peer: RTCPeerConnection;
  pendingCandidates: Array<RTCIceCandidateInit | null>;
  seenRemoteCandidates: Set<string>;
  channel?: RTCDataChannel;
  closed: boolean;
  // This component runs in the browser WebView; keep the timer handle
  // explicitly browser-typed after @types/node is loaded for test utilities.
  timeout?: number;
};

const sessionKey = ({ deviceId, sessionId }: RemoteP2pSessionInput) => `${deviceId}:${sessionId}`;
const sessionIdentity = ({ deviceId, sessionId }: RemoteP2pSessionInput): RemoteP2pSessionInput => ({
  deviceId,
  sessionId,
});

const candidateKey = (candidate: RTCIceCandidateInit | null) => {
  if (!candidate) return "ice-complete";
  return [
    candidate.candidate,
    candidate.sdpMid ?? "",
    candidate.sdpMLineIndex ?? "",
    candidate.usernameFragment ?? "",
  ].join("\u0000");
};

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid spreading an entire RTC frame into String.fromCharCode: legal P2
  // frames are much larger than most engines' argument limit.
  const chunks: string[] = [];
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    let chunk = "";
    const end = Math.min(offset + chunkSize, bytes.length);
    for (let index = offset; index < end; index += 1) {
      chunk += String.fromCharCode(bytes[index]!);
    }
    chunks.push(chunk);
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function configuredIceServers(urls: readonly string[]): RTCConfiguration {
  // The desktop settings surface accepts only explicit public STUN/STUNS
  // endpoints. TURN is intentionally excluded: a failed direct attempt must
  // use SomniQ's encrypted TCP/WSS fallback rather than an implicit third
  // transport with bundled credentials.
  return { iceServers: urls.map((urls) => ({ urls })) };
}

async function readFrame(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

/**
 * Browser-only half of the P2 adapter. This component has no visible UI and
 * is mounted once for the desktop lifetime. Rust validates and reserves every
 * session before emitting an offer, so an arbitrary renderer event cannot
 * manufacture a transport or use a gateway credential.
 */
export function RemoteP2pBridge() {
  const sessions = useRef(new Map<string, ActiveP2pSession>());

  useEffect(() => {
    let disposed = false;

    const forget = (session: ActiveP2pSession) => {
      if (session.timeout !== undefined) window.clearTimeout(session.timeout);
      sessions.current.delete(sessionKey(session));
    };

    const closeLocal = (session: ActiveP2pSession) => {
      if (session.closed) return;
      session.closed = true;
      forget(session);
      try {
        session.channel?.close();
      } catch {
        // Browser RTC close is best effort during shutdown.
      }
      try {
        session.peer.close();
      } catch {
        // Browser RTC close is best effort during shutdown.
      }
    };

    const finish = async (
      session: ActiveP2pSession,
      reason: RemoteP2pFailureReason | null,
      notifyPeer: boolean,
    ) => {
      if (session.closed) return;
      closeLocal(session);
      try {
        if (reason && notifyPeer) {
          await remoteControlP2pFailed({ ...sessionIdentity(session), reason });
        } else if (!reason) {
          await remoteControlP2pClosed(sessionIdentity(session));
        }
      } catch {
        // The Rust side may already have removed state after a peer failure or
        // a desktop disable. The local browser object is still safely closed.
      }
    };

    const sendEncryptedFrame = async (session: ActiveP2pSession, dataBase64: string) => {
      try {
        const responseBytes = base64ToBytes(dataBase64);
        const channel = session.channel;
        if (
          responseBytes.byteLength > MAX_ENCRYPTED_FRAME_BYTES
          || !channel
          || channel.readyState !== "open"
        ) {
          await finish(session, "data_channel_failed", true);
          return;
        }
        // Copy into a concrete ArrayBuffer. TypeScript's newer typed-array
        // definitions allow SharedArrayBuffer views, whereas RTCDataChannel
        // intentionally accepts only an ArrayBuffer-backed payload.
        const outbound = new Uint8Array(responseBytes.byteLength);
        outbound.set(responseBytes);
        channel.send(outbound.buffer);
      } catch {
        await finish(session, "data_channel_failed", true);
      }
    };

    const attachChannel = (session: ActiveP2pSession, channel: RTCDataChannel) => {
      if (channel.label !== CONTROL_CHANNEL_LABEL || session.channel) {
        channel.close();
        void finish(session, "data_channel_failed", true);
        return;
      }
      session.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        if (session.timeout !== undefined) {
          window.clearTimeout(session.timeout);
          session.timeout = undefined;
        }
        void remoteControlP2pOpened(sessionIdentity(session)).catch(() => {
          void finish(session, "data_channel_failed", true);
        });
      };
      channel.onmessage = (event) => {
        void (async () => {
          const frame = await readFrame(event.data);
          if (!frame || frame.byteLength > MAX_ENCRYPTED_FRAME_BYTES) {
            await finish(session, "data_channel_failed", true);
            return;
          }
          try {
            await remoteControlP2pFrame({
              ...sessionIdentity(session),
              dataBase64: bytesToBase64(frame),
            });
          } catch {
            // Synchronous frame-shape/bounds failures close the channel here.
            // Auth/replay failures discovered by the background Rust worker
            // arrive through `remote-p2p-failed` below.
            await finish(session, "data_channel_failed", true);
          }
        })();
      };
      channel.onerror = () => {
        void finish(session, "data_channel_failed", true);
      };
      channel.onclose = () => {
        void finish(session, null, false);
      };
    };

    const addCandidate = async (session: ActiveP2pSession, candidate: RTCIceCandidateInit | null) => {
      if (session.closed) return;
      const key = candidateKey(candidate);
      if (session.seenRemoteCandidates.has(key)) return;
      if (session.seenRemoteCandidates.size >= MAX_REMOTE_ICE_CANDIDATES) {
        await finish(session, "negotiation_failed", true);
        return;
      }
      session.seenRemoteCandidates.add(key);
      if (!session.peer.remoteDescription) {
        session.pendingCandidates.push(candidate);
        return;
      }
      try {
        await session.peer.addIceCandidate(candidate);
      } catch {
        await finish(session, "negotiation_failed", true);
      }
    };

    const acceptOffer = async (offer: RemoteP2pOffer) => {
      const identity: RemoteP2pSessionInput = {
        deviceId: offer.deviceId,
        sessionId: offer.sessionId,
      };
      const existing = sessions.current.get(sessionKey(identity));
      // Renderer recovery replays the retained offer after listeners are in
      // place. A duplicate must not tear down the in-flight PeerConnection.
      if (existing) return;

      const peer = new RTCPeerConnection(configuredIceServers(offer.iceServers));
      const session: ActiveP2pSession = {
        ...identity,
        peer,
        pendingCandidates: [],
        seenRemoteCandidates: new Set(),
        closed: false,
      };
      sessions.current.set(sessionKey(session), session);
      session.timeout = window.setTimeout(() => {
        void finish(session, "ice_timeout", true);
      }, NEGOTIATION_TIMEOUT_MS);

      // setLocalDescription can start candidate gathering immediately. Keep
      // candidates behind the answer so the mobile can apply SDP before it
      // receives a trickled candidate; signaling order is part of P2's wire
      // contract, not a timing assumption about a particular browser.
      let answerForwarded = false;
      const pendingLocalCandidates: Array<RTCIceCandidate | null> = [];
      let localCandidateChain = Promise.resolve();
      const forwardLocalCandidate = (candidate: RTCIceCandidate | null) => {
        localCandidateChain = localCandidateChain
          .then(async () => {
            if (session.closed) return;
            if (!candidate) {
              await remoteControlP2pIceComplete(sessionIdentity(session));
              return;
            }
            await remoteControlP2pIceCandidate({
              ...sessionIdentity(session),
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            });
          })
          .catch(() => {
            void finish(session, "ice_failed", true);
          });
      };
      peer.onicecandidate = (event) => {
        if (session.closed) return;
        if (!answerForwarded) {
          pendingLocalCandidates.push(event.candidate);
          return;
        }
        forwardLocalCandidate(event.candidate);
      };
      peer.ondatachannel = (event) => attachChannel(session, event.channel);
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          void finish(session, "ice_failed", true);
        }
      };

      try {
        await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        for (const candidate of session.pendingCandidates.splice(0)) {
          await peer.addIceCandidate(candidate);
        }
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("missing local WebRTC answer");
        await remoteControlP2pAnswer({ ...sessionIdentity(session), sdp });
        answerForwarded = true;
        for (const candidate of pendingLocalCandidates.splice(0)) {
          forwardLocalCandidate(candidate);
        }
      } catch {
        await finish(session, "negotiation_failed", true);
      }
    };

    const startOffer = async (start: RemoteP2pStart) => {
      const identity: RemoteP2pSessionInput = {
        deviceId: start.deviceId,
        sessionId: start.sessionId,
      };
      if (sessions.current.has(sessionKey(identity))) return;

      const peer = new RTCPeerConnection(configuredIceServers(start.iceServers));
      const session: ActiveP2pSession = {
        ...identity,
        peer,
        pendingCandidates: [],
        seenRemoteCandidates: new Set(),
        closed: false,
      };
      sessions.current.set(sessionKey(session), session);
      session.timeout = window.setTimeout(() => {
        void finish(session, "ice_timeout", true);
      }, NEGOTIATION_TIMEOUT_MS);

      let offerForwarded = false;
      const pendingLocalCandidates: Array<RTCIceCandidate | null> = [];
      let localCandidateChain = Promise.resolve();
      const forwardLocalCandidate = (candidate: RTCIceCandidate | null) => {
        localCandidateChain = localCandidateChain
          .then(async () => {
            if (session.closed) return;
            if (!candidate) {
              await remoteControlP2pIceComplete(sessionIdentity(session));
              return;
            }
            await remoteControlP2pIceCandidate({
              ...sessionIdentity(session),
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            });
          })
          .catch(() => {
            void finish(session, "ice_failed", true);
          });
      };
      peer.onicecandidate = (event) => {
        if (session.closed) return;
        if (!offerForwarded) {
          pendingLocalCandidates.push(event.candidate);
          return;
        }
        forwardLocalCandidate(event.candidate);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          void finish(session, "ice_failed", true);
        }
      };
      attachChannel(
        session,
        peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }),
      );

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("missing local WebRTC offer");
        await remoteControlP2pOffer({ ...sessionIdentity(session), sdp });
        offerForwarded = true;
        for (const candidate of pendingLocalCandidates.splice(0)) {
          forwardLocalCandidate(candidate);
        }
      } catch {
        await finish(session, "negotiation_failed", true);
      }
    };

    const acceptAnswer = async (answer: RemoteP2pAnswerInput) => {
      const session = sessions.current.get(sessionKey(answer));
      if (!session || session.closed || session.peer.remoteDescription) return;
      try {
        await session.peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        for (const candidate of session.pendingCandidates.splice(0)) {
          await session.peer.addIceCandidate(candidate);
        }
      } catch {
        await finish(session, "negotiation_failed", true);
      }
    };

    const unlistenPromises = [
      listen<RemoteP2pStart>("remote-p2p-start", (event) => {
        if (!disposed) void startOffer(event.payload);
      }),
      listen<RemoteP2pOffer>("remote-p2p-offer", (event) => {
        if (!disposed) void acceptOffer(event.payload);
      }),
      listen<RemoteP2pAnswerInput>("remote-p2p-answer", (event) => {
        if (!disposed) void acceptAnswer(event.payload);
      }),
      listen<RemoteP2pIceCandidate>("remote-p2p-ice-candidate", (event) => {
        const session = sessions.current.get(sessionKey(event.payload));
        if (session && !disposed) void addCandidate(session, event.payload);
      }),
      listen<RemoteP2pSessionInput>("remote-p2p-ice-complete", (event) => {
        const session = sessions.current.get(sessionKey(event.payload));
        if (session && !disposed) {
          void addCandidate(session, null);
        }
      }),
      listen<RemoteP2pSessionInput>("remote-p2p-failed", (event) => {
        const session = sessions.current.get(sessionKey(event.payload));
        if (session) closeLocal(session);
      }),
      listen<RemoteP2pDataInput>("remote-p2p-frame", (event) => {
        const session = sessions.current.get(sessionKey(event.payload));
        if (session && !disposed) {
          void sendEncryptedFrame(session, event.payload.dataBase64);
        }
      }),
    ];

    // Tauri event registration is asynchronous, and the signal runner can
    // receive an offer during desktop startup or a renderer reload. Rust
    // retains unresolved negotiation metadata; fetch it only after every
    // listener has been installed, then rely on the duplicate-safe handlers
    // above if a live event races this snapshot.
    void Promise.all(unlistenPromises).then(async () => {
      try {
        const pending = await remoteControlP2pPending();
        if (disposed) return;
        for (const start of pending.starts) void startOffer(start);
        for (const offer of pending.offers) void acceptOffer(offer);
        for (const answer of pending.answers) void acceptAnswer(answer);
        for (const candidate of pending.candidates) {
          const session = sessions.current.get(sessionKey(candidate));
          if (session) void addCandidate(session, candidate);
        }
        for (const complete of pending.iceCompletes) {
          const session = sessions.current.get(sessionKey(complete));
          if (session) void addCandidate(session, null);
        }
      } catch {
        // A failed recovery read only affects a still-pending direct attempt;
        // the mobile owns timeout and encrypted relay fallback.
      }
    });

    return () => {
      disposed = true;
      for (const session of sessions.current.values()) {
        // Renderer reloads destroy browser-owned PeerConnections while Rust
        // and the gateway signal lease stay alive. Explicitly release the
        // session so a compute peer can reconnect or fall back to relay.
        void remoteControlP2pClosed(sessionIdentity(session)).catch(() => undefined);
        closeLocal(session);
      }
      void Promise.all(unlistenPromises).then((unlisten) => {
        for (const removeListener of unlisten) removeListener();
      });
    };
  }, []);

  return null;
}
