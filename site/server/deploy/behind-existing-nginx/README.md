# SomniQ Remote Gateway Behind an Existing Nginx Edge

Use this variant when a containerized, already operated Nginx owns the TLS
listeners and certificate lifecycle. The Rust gateway stays off host ports; a
private Docker network connects Nginx to the inner Caddy service. A separate
coturn container publishes STUN on 3478/UDP and 3478/TCP.

```text
phone HTTPS/WSS
      |
existing Nginx (TLS, 80/443 or 8443) -- private Docker network --> Caddy (:8080)
                                                                     |
                                                                gateway (:8787)

phone WebRTC ICE -- UDP/TCP 3478 --> STUN-only coturn
```

The account token is verified only through the fixed same-origin
`/v1/user/self` upstream and is never forwarded to the desktop. Both QR and
same-account browser connections still require explicit approval on the
desktop. Do not route Nginx directly to port 8787 or publish inner Caddy.

## Before changing the server

1. Identify the existing Nginx container and Compose project. Do not stop or
   recreate it merely to deploy SomniQ.
2. Prefer a separate HTTPS hostname such as `somniq.example.com`. A separate
   vhost avoids collisions with other applications and keeps the PWA
   same-origin with `/v1`.
3. Ensure Nginx owns a publicly trusted certificate for the selected hostname
   or IP. Mobile pairing needs HTTPS/WSS; raw IP HTTP is not a replacement.
4. Build the unified site:

   ~~~bash
   cd site
   npm ci
   npm run build
   cd server
   ~~~

   This creates the homepage and dashboard in `site/dist/`, the remote PWA in
   `site/dist/remote/`, and the local release gateway binary.

5. Open TCP 80/443 (or the documented IP-only 8443), UDP 3478, and TCP 3478
   in the cloud security group and Ubuntu firewall. Do not open 8787 or a TURN
   relay port range.

## Create the private Docker network and certificate paths

Run once on the Docker host. The network is external to the SomniQ Compose
project so it survives a gateway restart.

```bash
docker network create --driver bridge --internal somniq-nginx-edge
sudo install -d -m 0755 /opt/somniq-remote/acme
sudo install -d -m 0750 /opt/somniq-remote/certificates
```

If the network already exists, inspect it rather than recreating it:

```bash
docker network inspect somniq-nginx-edge
```

The network must contain only the Nginx edge and SomniQ Caddy, plus deliberately
trusted operations containers.

## Persist the Nginx attachment and certificate paths

Do not use a one-off `docker network connect`: it disappears when the existing
Nginx Compose project recreates its container. Copy
`nginx.compose.override.yml.template` into that project, change the `nginx`
service key if necessary, and use it as an overlay. It retains the private
network, HTTP-01 webroot, and certificate path across Nginx updates.

```bash
cd <existing-nginx-compose-project>
cp <somniq-source>/nginx.compose.override.yml.template somniq-nginx.override.yml
export SOMNIQ_NGINX_EDGE_NETWORK=somniq-nginx-edge
docker compose -f compose.yml -f somniq-nginx.override.yml config --quiet
docker compose -f compose.yml -f somniq-nginx.override.yml up -d nginx
```

For a hostname, issue a normal HTTP-01 certificate after loading the port-80
challenge vhost:

```bash
docker run --rm \
  -v /opt/somniq-remote/acme:/opt/somniq-remote/acme \
  -v /opt/somniq-remote/certificates:/etc/letsencrypt \
  certbot/certbot certonly --webroot \
  --webroot-path /opt/somniq-remote/acme \
  --domain somniq.example.com \
  --email ops@example.com --agree-tos --non-interactive
```

For a new hostname, load the port-80 server block with
`/.well-known/acme-challenge/` before issuing the certificate, then switch to
the TLS server block. If the existing Nginx already has a global HTTP-to-HTTPS
redirect, add the challenge `location` to that vhost instead of adding a
competing port-80 server.

## Configure the existing Nginx vhost

The `nginx/` directory has a two-stage template:

1. `00-somniq-http-context.conf.template` goes in Nginx's `http {}` context.
   It defines the WebSocket upgrade map and the dynamic inner-Caddy upstream.
2. For a new hostname, use `10-somniq-acme-only.server.conf.template` for
   HTTP-01 first; after issuance replace it with a pair of server files. Place
   the generated files under `/etc/nginx/somniq/http/`. Place
   `proxy-headers.conf.template` under
   `/etc/nginx/somniq/snippets/proxy-headers.conf`, replace placeholders, and
   include that file from each SomniQ proxy location.

   Two server layouts are provided:

   - `10-somniq-domain-http.server.conf.template` +
     `20-somniq-domain-tls.server.conf.template` — **what production runs.**
     Nginx serves the static site and maps each website API path itself, onto
     the account backend (`somniq_newapi_upstream`) or the gateway
     (`somniq_remote_edge`). Use this when the account backend is another
     container on the same host.
   - `20-somniq-remote.server.conf.template` — hands the whole origin to the
     inner Caddy, which owns the routing instead. Simpler, but the account API
     must already be reachable through Caddy's own upstream.

   With the first layout the Nginx container has to share a Docker network
   with the account backend. Declare that attachment where the container is
   defined; one recreated without it resolves nothing and answers 502 on every
   account route until it is reattached.

The main Nginx config must include the fragment directory once from `http {}`:

```nginx
include /etc/nginx/somniq/http/*.conf;
```

The TLS vhost uses Docker's resolver at `127.0.0.11`; define that resolver
exactly once in the owning `http {}` configuration. After Caddy starts,
validate and reload only Nginx:

```bash
docker exec <existing-nginx-container> nginx -t
docker exec <existing-nginx-container> nginx -s reload
```

The templates disable access logging. Do not introduce a custom log format
that records `Authorization`, `Cookie`, request bodies, or
`Sec-WebSocket-Protocol`; browser WebSocket tickets are carried in the latter.

The unified same-account flow requires a dedicated hostname so that the
homepage, dashboard, `/remote/`, and `/v1/` share one origin. The legacy
`30-shared-host-path.server.conf.template` is retained only for older
capability-only pilots; do not use it for account-connected deployments.

## Start and verify SomniQ

Create `site/server/.env` from `.env.example`, set the unique
bootstrap secret, and set `SOMNIQ_NGINX_EDGE_NETWORK`. The Caddy domain/email
values in `.env.example` are unused by this variant because the outer Nginx
owns TLS.

```bash
cd site/server
docker compose -f deploy/behind-existing-nginx/compose.yml --env-file .env config --quiet
docker compose -f deploy/behind-existing-nginx/compose.yml --env-file .env up -d --build
docker compose -f deploy/behind-existing-nginx/compose.yml --env-file .env ps
curl --fail --silent --show-error https://somniq.example.com/healthz
```

Validate from a phone before pairing:

- the public `/healthz` returns success;
- `/` loads the SomniQ homepage and `/dashboard.html` can sign in;
- `/remote/` loads the SomniQ phone/browser PWA;
- WSS upgrades work through Nginx; and
- UDP/TCP 3478 reaches the STUN-only coturn service.

## Fixed public IPv4 without a domain

Let's Encrypt supports public IP-address certificates. They are intentionally
short-lived (about six days), require HTTP-01 or TLS-ALPN-01 validation, and
must be renewed automatically. Use this only with a stable public IP and an
exact Nginx edge; DNS-01 cannot validate an IP.

Use the dedicated IP-only HTTPS port **8443** so an existing application's
443 default vhost is not changed. Configure the desktop gateway URL as
`https://<public-ip>:8443`.

1. Build the unified site:

   ~~~bash
   cd site
   npm run build
   ~~~

2. Install `11-somniq-ip-acme.server.conf.template` with `<public-ip>`
   replaced and load it. It exposes only the ACME webroot on port 80.
3. Issue the IP certificate with Certbot 5.4 or newer (use staging first):

   ```bash
   docker run --rm \
     -v /opt/somniq-remote/acme:/var/www/certbot \
     -v /opt/somniq-remote/certificates:/etc/letsencrypt \
     certbot/certbot certonly --webroot \
     --webroot-path /var/www/certbot \
     --preferred-profile shortlived \
     --ip-address <public-ip> \
     --cert-name somniq-ipv4 \
     --agree-tos --register-unsafely-without-email --non-interactive
   ```

4. Replace the ACME-only file with an instantiated
   `21-somniq-ip-remote.server.conf.template`, using the issued certificate.
   Copy `nginx.ipv4-port.compose.override.yml.template` into the Nginx Compose
   project so only Nginx publishes TCP 8443.
5. Open TCP 8443, UDP 3478, and TCP 3478 in the cloud security group and host
   firewall. Do not expose Caddy, the gateway, or TURN relay ports.
6. Install the two `systemd/` templates after replacing their placeholders,
   then enable the timer. It runs `certbot renew` every six hours and reloads
   only the existing Nginx container after a successful renewal check:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now somniq-ip-cert-renew.timer
   systemctl list-timers somniq-ip-cert-renew.timer
   ```

This remains a single-instance pilot. `gateway_state` keeps completed device
credential hashes and pairing relations across normal restarts; unfinished QR
ceremonies and live transport sessions remain transient.
