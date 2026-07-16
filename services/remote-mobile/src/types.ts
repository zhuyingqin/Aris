/**
 * JSON-compatible P2 wire types. They deliberately mirror
 * `crates/remote-protocol` rather than importing desktop code into a mobile
 * web bundle. Keep additions in lockstep with the Rust protocol crate.
 */

export const CURRENT_PROTOCOL_VERSION = 1;

export type DeviceKind = "desktop" | "mobile";

export type DeviceScope =
  | "read_project_state"
  | "read_task_timeline"
  | "send_chat_messages"
  | "stop_runs"
  | "read_review_conclusions";

export interface DeviceDescriptor {
  device_id: string;
  kind: DeviceKind;
  display_name: string;
  signing_public_key: string;
  key_agreement_public_key: string;
}

/** The raw JSON encoded in a desktop-generated pairing QR code. */
export interface PairingInvitation {
  protocol_version: number;
  pairing_id: string;
  desktop: DeviceDescriptor;
  gateway_url: string;
  /** A 32-byte base64url secret. Never write this value to logs or storage. */
  pairing_secret: string;
  expires_at_unix_ms: number;
}

export interface PairingRequest {
  protocol_version: number;
  pairing_id: string;
  pairing_secret: string;
  mobile: DeviceDescriptor;
  requested_scopes: DeviceScope[];
  requested_at_unix_ms: number;
  /** 64-byte Ed25519 signature, unpadded base64url. */
  proof: string;
}

export interface ClaimPairingResponse {
  claim_id: string;
  /** Keep only in memory until completion. */
  activation_token: string;
  status: "pending" | "awaiting_approval" | "approved" | "completed" | "revoked" | "expired";
  completion_expires_at_unix_ms: number;
  expires_at_unix_ms: number;
  /** Public STUN/STUNS configuration selected by the paired desktop. */
  ice_servers: string[];
}

export interface DeviceSummary {
  id: string;
  name: string;
  role: DeviceKind;
  granted_scopes: DeviceScope[];
  active: boolean;
}

export interface CompletePairingResponse {
  status: "completed";
  device: DeviceSummary;
  /** The completed activation token is now the paired-device bearer credential. */
  credential_kind: "activation_token";
}

export interface MeResponse {
  device: DeviceSummary;
  paired_devices: DeviceSummary[];
}

export interface PairedMobileSession {
  invitation: Pick<PairingInvitation, "gateway_url" | "desktop">;
  mobile: DeviceDescriptor;
  credential: string;
  granted_scopes: DeviceScope[];
  /** Never user-entered on the phone; validated from the pairing claim. */
  ice_servers: string[];
}

export type P2pFailureReason =
  | "ice_timeout"
  | "ice_failed"
  | "negotiation_failed"
  | "data_channel_failed"
  | "cancelled";

/**
 * The payload inside the gateway's opaque `signal` message. The outer
 * `session_id` is the transport attempt ID; no payload type repeats it.
 */
export type TransportSignal =
  | {
      kind: "webrtc_offer";
      protocol_version: number;
      sdp: string;
    }
  | {
      kind: "webrtc_answer";
      protocol_version: number;
      sdp: string;
    }
  | {
      kind: "webrtc_ice_candidate";
      protocol_version: number;
      candidate: string;
      sdp_mid?: string | null;
      sdp_m_line_index?: number | null;
      username_fragment?: string | null;
    }
  | {
      kind: "webrtc_ice_complete";
      protocol_version: number;
    }
  | {
      kind: "p2p_failed";
      protocol_version: number;
      reason: P2pFailureReason;
    }
  | {
      kind: "relay_offer";
      protocol_version: number;
    };

export interface GatewaySignalMessage {
  type: "signal";
  to: string;
  session_id: string;
  payload: TransportSignal;
}

export type GatewayInboundSignal =
  | { type: "ready"; device_id: string }
  | { type: "presence"; device_id: string; online: boolean }
  | { type: "signal"; from: string; session_id: string; payload: TransportSignal }
  | { type: "pong"; nonce?: string }
  | { type: "error"; code: string; message: string }
  | { type: "revoked"; device_id: string };

export interface GatewayRelayOpen {
  type: "open";
  peer_id: string;
  session_id: string;
}

export type GatewayRelayControl =
  | { type: "ready"; session_id: string }
  | { type: "peer_connected"; device_id: string; session_id: string }
  | { type: "peer_disconnected"; device_id: string; session_id: string }
  | { type: "pong"; nonce?: string }
  | { type: "error"; code: string; message: string };

/** A native or WASM implementation supplies encrypted SecureEnvelope bytes. */
export interface EncryptedFrameCodec {
  seal(plaintext: Uint8Array): Promise<Uint8Array>;
  open(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** A paired mobile identity that can sign the canonical pairing transcript. */
export interface MobileSigningIdentity {
  readonly descriptor: DeviceDescriptor;
  signPairingTranscript(transcript: Uint8Array): Promise<Uint8Array>;
}
