# SomniQ Remote Gateway (P0-P2)

This local-first P0-P2 service provides explicitly approved device pairing,
private signaling, and an encrypted TCP/WebSocket relay fallback for SomniQ
mobile remote control. It never stores project files, chat history, task
content, or relay payloads. The desktop remains the authority for remote
actions and local permissions.

There is no NewAPI, browser, or desktop account login in the pairing flow.
The desktop creates a signed QR invitation, the phone proves possession of its
own device key and the QR secret, and the desktop must visibly approve the
request before the phone receives its paired-device credential.

## Run locally

The service is a nested standalone Cargo workspace, so it does not change the
root SomniQ workspace or desktop build.

```powershell
$env:SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN = "replace-with-a-long-random-secret"
cargo run --manifest-path services/remote-gateway/Cargo.toml
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOMNIQ_GATEWAY_BIND` | `127.0.0.1:8787` | Listener address. Bind a private interface only during development. |
| `SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN` | required | Deployment secret that binds durable state and lets the first capability-only pairing register a desktop credential. It is never sent to a phone or bundled in the desktop app. |
| `SOMNIQ_GATEWAY_PAIRING_TTL_SECS` | `300` | Lifetime of a QR/pairing invitation, 30-3600 seconds. |
| `SOMNIQ_GATEWAY_ACTIVATION_COMPLETION_TTL_SECS` | `60` | Deadline from phone claim to final completion, 10-300 seconds and capped by invitation expiry. |
| `SOMNIQ_GATEWAY_BROWSER_WS_TICKET_TTL_SECS` | `60` | One-time browser WebSocket ticket lifetime, 10-300 seconds. |
| `SOMNIQ_GATEWAY_MAX_WS_BYTES` | `262144` | Maximum signaling/relay WebSocket frame size. |
| `SOMNIQ_GATEWAY_MAX_PENDING_PAIRINGS` | `64` | Maximum concurrent QR ceremonies, 1-1024. |
| `SOMNIQ_GATEWAY_MAX_UNPAIRED_DESKTOPS` | `128` | Maximum transient first-use desktop registrations, 1-1024. |
| `SOMNIQ_GATEWAY_STATE_DIR` | unset | Absolute directory for completed-device state. Docker deployments set `/var/lib/somniq` on a named volume. |
| `SOMNIQ_GATEWAY_IMAGE_ASSIST` | unset (off) | Set to `1`, `true`, or `on` to broker Image Assist matches. Off by default: a deployment must opt in to introducing users who have never paired. |
| `SOMNIQ_GATEWAY_IMAGE_ASSIST_STUN` | empty | Comma-separated public STUN/STUNS URLs handed to both sides of a brokered match, validated by the same rules as pairing. Strangers have no pairing to carry a list, so the deployment supplies one. |

`GET /healthz` is unauthenticated and returns `{"status":"ok"}`. In
production, terminate TLS at a reverse proxy and expose only HTTPS/WSS to
phones. Do not expose a raw TCP listener on a desktop. The local command stays
in-memory unless `SOMNIQ_GATEWAY_STATE_DIR` is set.

The gateway emits Image Assist lifecycle events through `tracing`. Set
`RUST_LOG=somniq_remote_gateway::image_assist=info` when starting the service,
or inspect the container with `docker compose logs -f gateway`. Events include
the request and match IDs, short device fingerprints, and the terminal reason;
they intentionally never include prompt plaintext, image bytes, bearer tokens,
or relay ciphertext. These records are process logs, not a durable audit
database, and in-flight matches still disappear on restart.

## Container deployment

`Dockerfile`, `compose.yml`, `.env.example`, and a Caddy TLS reverse proxy are
included for a **single-instance staging/pilot** deployment. Start with
[deploy/README.md](deploy/README.md). Port 8787 remains private; Caddy exposes
HTTPS/WSS on 80/443, and a STUN-only coturn instance exposes 3478/UDP and
3478/TCP. The state volume retains completed device credential hashes,
descriptors, granted scopes, and pairing relations.

After a normal gateway/container/host restart, an already completed phone
pairing can reconnect without scanning again. Incomplete QR ceremonies,
browser tickets, presence, and relay sessions are deliberately transient. Do
not scale this version horizontally or represent it as a durable production
service.

## Image Assist brokering

Off unless `SOMNIQ_GATEWAY_IMAGE_ASSIST` is set. When enabled, the gateway
introduces two desktops that have never paired so one can generate an image on
the other's ChatGPT account, and it becomes a **trusted introducer**: it tells
each side the other's key-agreement public key, so a compromised gateway could
substitute keys. That is a deliberate reduction from the pairing model and is
documented in `docs/development-logic/image-assist-network.md`.

Brokering frames ride the existing authenticated `/v1/signal` endpoint inside a
single `image_assist` wrapper; no new route is added. Consent precedes
connectivity: the requester seals its prompt to the helper's key and the
gateway relays opaque ciphertext, and **no transport session identifier is
minted until the helper's local user approves**. A match then authorizes at
most two session identifiers, one direct and one relay fallback, and the
authorization check binds the session identifier as well as the device pair.

Image Assist uses the gateway's existing authenticated device credential only;
it does not call, receive, validate, or store NewAPI login data. Request
budgets are keyed to that device credential. `POST /v1/image-assist/report`
records a minimal abuse report; three reports suspend the target device from
Image Assist for the lifetime of the gateway process.

All brokering state — helper leases, matches, sealed previews, and the roster —
is process-local and never enters the durable device state. A restart cancels
in-flight matches rather than resuming a consent decision made before it.

The roster is anonymous by default: it carries a short fingerprint and
availability, and a display name only for a helper that explicitly opted in.

## Pairing lifecycle

Protected calls use `Authorization: Bearer <credential>`. The desktop has no
preconfigured gateway credential: its first QR ceremony receives a unique
desktop credential in the response and stores it only in the operating-system
credential store. Later pairings use that credential. The deployment bootstrap
secret stays on the gateway host and is never shipped in an app bundle.

1. The desktop creates a signed `PairingInvitation` containing its public
   descriptor, a 256-bit QR secret, gateway URL, expiry, and pairing UUID. It
   posts the invitation and up to eight public STUN/STUNS URLs to
   `POST /v1/pairings`. The gateway keeps only the QR secret digest and, on
   first registration, returns a temporary desktop credential. It becomes
   durable only after a phone completes an explicitly approved pairing;
   abandoned first-use registrations expire without writing durable state.
2. The phone scans the QR code and posts a signed `PairingRequest` to
   `POST /v1/pairings/{pairing_id}/claims`. The gateway verifies the phone
   proof, pairing ID, and QR secret digest, then returns an inactive activation
   token and the validated STUN list.
3. The desktop reads the non-secret claim transcript, visibly reviews the
   requested scopes, and sends its signed approval. The gateway verifies the
   descriptor, invitation identity, and non-escalating scope grant.
4. The phone completes the claim before its short deadline. Its activation
   token becomes the paired-device credential. A missed completion deadline
   requires a fresh QR ceremony and desktop approval.

The gateway stores verified public descriptors, granted scopes, and approval
evidence, but no raw QR pairing secret, private signing key, project content,
or chat content.

## P2P and relay fallback

The desktop sends the pairing's validated STUN/STUNS list to the phone. Both
ends first attempt a WebRTC DataChannel. The Compose-provided coturn service is
strictly `--stun-only`: it provides NAT mapping discovery and rejects TURN
allocations, so it never becomes an unreviewed content relay.

When ICE/P2P cannot establish or an established DataChannel breaks, the phone
starts a fresh relay session. It sends `p2p_failed` as best-effort cleanup
metadata, then renews the authenticated signal channel if necessary before
sending the fresh `relay_offer`; a transient signal close must not strand the
phone on the failed direct route. The fallback is the gateway's existing
WSS/TCP relay; application payloads remain end-to-end encrypted
`SecureEnvelope` frames. Keep the authenticated signal WebSocket alive while
P2P is active: it is the revocation control lease, so the direct channel is
closed before the relay handoff begins.

The PWA obtains short-lived, single-use browser WebSocket tickets with its
paired mobile bearer credential. Use each ticket only as the second
`Sec-WebSocket-Protocol` value, never in a URL, query string, persistent
browser storage, log field, or analytics header. The reverse proxy must retain
WebSocket upgrades and must not log `Authorization` or
`Sec-WebSocket-Protocol`.

## Security and operating limits

- Pairing invitations use a 256-bit OS-random secret. The gateway retains only
  its SHA-256 digest.
- Mobile requests and desktop approvals are Ed25519-signed transcripts. The
  gateway validates both proofs, descriptor binding, invitation identity,
  single-use state, and scope subset rules before activation.
- Mobile activation credentials come from 256 bits of OS CSPRNG output and
  are stored only as SHA-256 hashes.
- `DELETE /v1/devices/{device_id}` revokes a paired mobile credential and
  closes its routes. A revoked phone returns only through a new QR ceremony.
- Do not add proxy access logs, request-body logs, or telemetry that records
  bearer credentials or browser WebSocket tickets.
- The anonymous first-use registration path must be protected by both the
  configured pairing/unpaired-desktop bounds and the supplied reverse-proxy
  rate limit. Do not expose it without equivalent admission control.
- P2P relies on public STUN routing metadata. A direct route is not guaranteed
  across symmetric NATs or restrictive networks; the encrypted WSS/TCP relay
  is the supported fallback.
- This is a single-instance pilot. Production needs durable audit storage,
  per-connection proof, shared presence/session routing, rate limits, backups,
  and monitoring.

Run focused checks with:

```powershell
cargo test --manifest-path services/remote-gateway/Cargo.toml
```
