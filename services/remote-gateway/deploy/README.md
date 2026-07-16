# Deploying SomniQ Remote Gateway

This directory provides a **single-instance staging/pilot deployment**. The
Rust gateway stays on a private Docker network. Caddy terminates TLS, serves
the mobile PWA, and proxies HTTPS/WSS traffic. A separate coturn container is
limited to STUN discovery on 3478/UDP and 3478/TCP; it is not a TURN relay.

The gateway does not use NewAPI or any login endpoint. Phone pairing is a
desktop-approved QR ceremony. The only host secret is
`SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN`, which binds the durable device-state file and
is never entered into the desktop or phone.

> **Do not describe this release as a durable production service.** The stack
> persists only completed device credential hashes, public descriptors, granted
> scopes, and pairing relations in the private `gateway_state` volume. A
> gateway/container/host restart does not require an already paired phone to
> scan again, but incomplete QR ceremonies, browser tickets, presence, and
> active relay/P2P connections are transient and are recreated after restart.

## What is included

| Included | Not included yet |
| --- | --- |
| HTTPS/WSS, same-origin PWA hosting, automatic certificate renewal, private gateway network, STUN-only coturn, health checks, non-root gateway process, durable completed-device checkpoint | Durable database/audit storage, horizontal scaling, shared presence/session routing, managed backups, TURN allocation service, or a guaranteed direct route through every NAT |
| WebRTC DataChannel attempt with end-to-end encrypted WSS/TCP relay fallback | Any NewAPI/browser/desktop login requirement |

The relay sees metadata and ciphertext only; application encryption remains
mandatory. A reverse proxy is not a substitute for protocol authentication or
encryption.

The initial `POST /v1/pairings` registration intentionally has no password or
bearer credential so a new desktop can show a QR code immediately. The gateway
bounds concurrent pairing ceremonies and unpaired desktop records, while the
supplied Nginx templates rate-limit that one endpoint by client address. Keep
both protections enabled on every public deployment.

The supplied Caddy and Nginx configurations also send a restrictive Content
Security Policy because the installed PWA retains its paired-device credential
in IndexedDB. Do not weaken it with inline scripts or broad third-party source
allow-lists without a security review.

## Prerequisites

1. Use a supported Linux host with Docker Engine and Docker Compose v2.
2. Prefer a public DNS hostname such as `gateway.example.com` pointing at the
   host. Caddy obtains and renews the certificate for that hostname.
3. Allow inbound TCP ports **80** and **443** through the cloud security group
   and Ubuntu firewall. Caddy uses port 80 for HTTP-01 and serves HTTPS/WSS on
   443. UDP 443 is optional HTTP/3 support.
4. Allow inbound **UDP 3478** and preferably **TCP 3478** through the cloud
   security group and Ubuntu firewall. These are STUN discovery ports only.
   Do not open a TURN relay port range.
5. Do **not** publish port 8787. It is private to Caddy and the gateway
   network.
6. Do not enable plain HTTP/WSS for a phone. Browsers require trustworthy HTTPS
   for the PWA, camera QR scanning, and reliable secure WebSocket behavior.

For Ubuntu UFW, after allowing the equivalent ports in the cloud security
group:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw status numbered
```

## First deployment with a hostname

Build the mobile PWA first. It is served from the same origin as `/v1`, so no
broad CORS rule is necessary:

```bash
cd services/remote-mobile
npm ci
npm run build
cd ../remote-gateway
```

Create the environment file, set a hostname and an operations email, and
generate a unique deployment secret:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
# Put the output in SOMNIQ_GATEWAY_BOOTSTRAP_TOKEN in .env.

docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
curl --fail --silent --show-error \
  "https://$(grep '^SOMNIQ_GATEWAY_DOMAIN=' .env | cut -d= -f2)/healthz"
```

On Windows PowerShell, generate the secret with:

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$rng.Dispose()
[System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
```

Set the desktop gateway URL to `https://gateway.example.com`, not a raw
container address and not `wss://...`. The desktop derives authenticated WSS
endpoints from the HTTPS URL. Open the same URL on the phone to install/use the
SomniQ Remote PWA, then scan the QR displayed by the desktop and approve the
phone request locally.

## STUN and fallback behavior

The managed desktop uses `stun:106.53.28.124:3478`. For a self-hosted gateway,
configure its public STUN endpoint before pairing, for example
`stun:gateway.example.com:3478`. The desktop sends this public routing metadata
with the pairing invitation; the phone receives the same validated endpoint.

Coturn is started with `--stun-only --no-tls --no-dtls --no-cli`. It provides
the public mapped address needed by ICE candidate gathering but rejects all
TURN allocation requests. This keeps the only payload-carrying fallback in the
reviewed SomniQ WSS/TCP relay, where frames remain end-to-end encrypted. A
successful STUN response does not guarantee P2P: symmetric NATs, carrier NAT,
or restrictive firewalls can still prevent a direct DataChannel. In those
cases the clients automatically use the encrypted relay.

When a direct attempt loses its signal WebSocket during the handoff, the
mobile client reconnects that authenticated signal channel and re-sends the
fresh relay offer before opening the relay socket. This is a bounded retry;
it does not reuse the failed P2P session ID or send chat content through
signaling.

Verify the service after deployment:

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=100 stun
docker compose --env-file .env logs --tail=100 gateway
```

From a separate network, test TCP reachability with
`nc -vz <host> 3478`; test UDP 3478 with a STUN-aware client or a real mobile
WebRTC attempt. A TCP probe cannot prove that UDP STUN is reachable.

## Fixed public IPv4 without a domain

The base Caddy stack is hostname-oriented. Do **not** set
`SOMNIQ_GATEWAY_DOMAIN` to an IP and rely on an untrusted/internal certificate:
phones will reject it or lose secure-context features such as camera QR scan.

The existing managed deployment at `106.53.28.124` uses a separate Nginx path
on **HTTPS 8443** with a publicly trusted IP-address certificate. The desktop
default `https://106.53.28.124:8443` is therefore intentional and must route
through that Nginx edge, not the base Caddy 443 mapping. Its certificate is
short-lived, so renewal is an operational requirement.

For another fixed-IP deployment, use
[behind-existing-nginx/README.md](behind-existing-nginx/README.md#fixed-public-ipv4-without-a-domain).
It documents the HTTP-01 webroot, IP-address certificate, Nginx 8443 vhost,
and automated renewal. Open **TCP 8443**, **UDP 3478**, and **TCP 3478** in
both the cloud security group and Ubuntu firewall. Do not substitute raw HTTP
or `tls internal` for a publicly trusted certificate on phones.

## Operations and incident response

- Treat `.env` as a production secret. It is ignored by Git. Limit it to the
  Docker service account and never send it through chat, tickets, screenshots,
  shell history, or `docker compose config` output.
- Keep Caddy's `/data` and `/config` volumes. Deleting them causes certificate
  reissuance and can hit ACME limits.
- Keep `gateway_state`. It contains completed device credential hashes and
  pairing metadata, never raw bearer credentials, research content, relay
  payloads, QR secrets, or browser tickets. Do not run `docker compose down
  -v` unless intentionally removing every completed pairing.
- Do not enable verbose gateway logs, Caddy access logs, request-body logging,
  or a proxy feature that records `Authorization` or
  `Sec-WebSocket-Protocol`; the latter carries a one-time browser ticket.
- A gateway restart closes active transport sockets but does not reset a
  completed pairing. The desktop and phone reconnect with existing device
  credentials after the service is healthy. An unfinished QR ceremony needs a
  new scan and approval.
- To rotate a suspected bootstrap secret, plan a pairing reset: the state file
  is bound to the existing secret. Stop the stack, change `.env`, remove only
  `gateway_state`, then re-pair. Keep exactly one gateway replica.
- Image updates retain completed pairings when `gateway_state` is retained:
  `docker compose --env-file .env pull && docker compose --env-file .env up
  -d --build`.

## Future topology

Do not scale this Compose stack above one gateway. A durable production
topology needs a transactional device/pairing store, Redis (or equivalent) for
cross-instance presence and relay routing, rate limiting, redacted audit
events, alerts, and per-connection signed proof. TURN with short-lived
credentials is a separate future design; it must not share the gateway
bootstrap secret or silently replace the encrypted relay fallback.
