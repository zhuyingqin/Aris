# SomniQ independent account service

Independent accounts and Go/Plus/Pro membership administration, with a New API
compatibility harness and an opt-in Site account center. The default Site
build, PWA, Desktop login, remote gateway and production containers still use
their existing contracts. This service does not automatically migrate them.

Implemented:

- OIDC authorization code login with PKCE and validation through `openidconnect`.
- Persistent SomniQ UUIDs keyed by issuer and subject; email is not an identity key.
- HttpOnly server sessions, current-session logout, active-account checks, CSRF
  origin checks, expiring browser-bound one-time authorization flows.
- Explicit agreement acceptance with version, timestamp, content hash and exact
  server-side text snapshot. Onboarding does not grant compute access before consent.
- New API OIDC connection, identity comparison, a unique account mapping, and a
  per-user model key. Upstream sessions, refresh cookies and keys are encrypted
  with AES-256-GCM and bound to their record. The vault key is checked at startup.
- Serialized upstream refresh and key provisioning, account/usage projection,
  and streaming OpenAI chat proxy using the server-held model key.
- A separate `/account/` prototype page for testing the complete flow.
- Site `/dashboard.html` and `/account.html` behind `VITE_ACCOUNT_MODE=independent`
  reuse the original console header, sidebar, cards and light/dark theme.
  They use the independent UUID/cookie contract and never load legacy credentials.
- Go ¥29/month, Plus ¥49/month and Pro ¥99/month, with exact per-plan model lists,
  default Executor/Reviewer models, expiring administrator grants and audit history.
- An authenticated `/admin.html` interface inside that same console, accessible
  from its administrator sidebar item, for plan configuration, model discovery,
  member search, membership changes, reconciliation retries and audit records.
- The original landing page structure is preserved. Pricing uses its existing
  two-column offer layout and comparison table with the Go/Plus/Pro catalog.
- Model enforcement before forwarding, revisioned policy changes, persistent
  reconciliation jobs and verified New API token allowlists.

The first milestone uses SQLite/WAL and one service process. It does not support
multiple replicas. The fixed 24-hour web session requires a fresh OIDC login
after expiry; device authorization and desktop background renewal are not yet
implemented. The production agreement must be supplied explicitly as a text
snapshot; development and integration-test agreements are only fixtures.

## Local Keycloak environment

Requirements: Rust, Node.js 22, and a running Docker Linux engine. From the repo root:

```powershell
node site/account-server/scripts/dev.mjs init
node site/account-server/scripts/dev.mjs up
# Wait for Keycloak and New API to start.
node site/account-server/scripts/dev.mjs configure-newapi
node site/account-server/scripts/dev.mjs serve
```

Open `http://127.0.0.1:8800/account/`. The seeded local user is `alice`; its
generated password is the `testPassword` field in the ignored
`site/account-server/.local/development.json`. No default published password is
used. The local identity administrator is `localadmin`, with its separate
password in the same file.

This stack publishes only loopback ports, uses Keycloak 26.7.4 and the exact
New API image digest in `deploy/newapi/version.lock.json`, and creates isolated
development databases. `dev.mjs configure-newapi` targets only the fixed local
test port 18881. It never configures the production server and installs no paid
model channels. Registration email delivery needs a configured development SMTP
service; the seeded account already has a verified test email.

`node site/account-server/scripts/dev.mjs down` stops the development containers
while keeping database volumes. Keep `.local/development.json` together with
those volumes: replacing its keys will not update credentials already imported
into an existing Keycloak realm. Do not publish the local stack as production.

### Site preview

After `init` and `up`, set the public origin before configuring New API and
starting the account service. Keep this terminal running:

```powershell
$env:SOMNIQ_ACCOUNT_PUBLIC_URL = 'http://127.0.0.1:5180'
node site/account-server/scripts/dev.mjs configure-newapi
node site/account-server/scripts/dev.mjs serve
```

In another terminal:

```powershell
cd site
$env:VITE_ACCOUNT_MODE = 'independent'
npm run dev
```

Open `http://127.0.0.1:5180/dashboard.html` (`account.html` remains an alias).
The landing-page account buttons retain the original console entry point.
This mode shares the existing visual layout but keeps independent UUID profiles
separate from the numeric legacy user contract. The plan tab shows Go/Plus/Pro;
the remote tab links to the existing remote workspace until device migration.
Its development proxy
does not fall back to production APIs. Leave the build flag unset for the current
Site behavior. Production/static previews additionally need the same-origin
routes shown in `deploy/nginx.preview.conf.example`; do not use the Vite server
as a production proxy.

## Configuration

The process reads environment variables; it does not implicitly load `.env` files.

| Variable | Meaning |
| --- | --- |
| `SOMNIQ_ACCOUNT_BIND` | Default `127.0.0.1:8800`; internal listener behind TLS in deployments |
| `SOMNIQ_ACCOUNT_PUBLIC_URL` | Exact public origin, HTTPS except for loopback development |
| `SOMNIQ_ACCOUNT_HOME_PATH` | `/account/` for standalone UI, or `/account.html` for the Site center; no arbitrary redirects |
| `SOMNIQ_OIDC_ISSUER` | Exact identity provider issuer; production requires HTTPS |
| `SOMNIQ_OIDC_CLIENT_ID`, `SOMNIQ_OIDC_CLIENT_SECRET` | SomniQ confidential OIDC client, callback `/v2/account/callback` |
| `SOMNIQ_NEWAPI_URL` | Trusted fixed New API service origin |
| `SOMNIQ_NEWAPI_OIDC_CLIENT_ID` | New API's distinct OIDC client in the same identity realm |
| `SOMNIQ_NEWAPI_INSTANCE_ID` | Stable identifier for that New API database/tenant |
| `SOMNIQ_ACCOUNT_DATABASE` | SQLite path; default `data/accounts.sqlite3` |
| `SOMNIQ_ACCOUNT_ADMIN_SUBJECTS` | Comma-separated OIDC subjects authorized for SomniQ administration; empty authorizes nobody |
| `SOMNIQ_ACCOUNT_KEY` | Base64url without padding, encoding 32 random bytes; back up separately |
| `SOMNIQ_AGREEMENT_FILE` | UTF-8 snapshot displayed to the user and stored with acceptance |
| `SOMNIQ_AGREEMENT_VERSION` | Version identifying the supplied snapshot |

New API must use the same stable OIDC subject as the SomniQ client. Pairwise
subjects are not supported in this milestone. Its `ServerAddress` must match the
account origin, so the configured New API redirect URI is `/oauth/oidc`. Route
that callback to this service. Upstream OAuth state, cookies and tokens are never
forwarded to the browser. Keep the New API management and model ports private
when preparing a managed deployment.

If the upstream account has additional login factors, unsupported provider
policies, or an existing email requiring account linking, the connection fails
closed. It does not merge by email, bypass MFA, or rewrite an existing balance.
Old-account binding needs a separate migration implementation and acceptance run.

## API

| Route | Behavior |
| --- | --- |
| `GET /v2/account/login` | Start browser-bound OIDC + PKCE login |
| `GET /v2/account/callback` | Validate identity, create/reuse UUID, issue session cookie |
| `GET /v2/account/me` | Own user, consent requirement, compute connection state; works while New API is down |
| `POST /v2/account/logout` | Revoke current SomniQ session; requires exact Origin |
| `GET /v2/account/agreement` | Current version, text snapshot and content hash |
| `POST /v2/account/consent` | Explicit acceptance of that version and hash; session + Origin required |
| `POST /v2/account/compute/connect` | Start New API OIDC flow for the signed-in user |
| `GET /oauth/oidc` | Complete upstream connection; compare upstream `oidc_id` with the SomniQ subject |
| `GET /v2/account/compute` | Numeric compute quota and usage, explicitly in `newapi_quota` units |
| `GET /v2/catalog/plans` | Go/Plus/Pro offers and published model lists; checkout is unavailable |
| `GET /v2/account/entitlements` | Current membership, expiry, effective models and defaults |
| `GET /v1/models` | Intersection of current membership and upstream key's model list |
| `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages` | Membership-checked streaming proxies |
| `GET /v2/admin/plans`, `PUT /v2/admin/plans/{id}` | Read/edit three plans with an expected revision |
| `GET /v2/admin/models` | Read configured models using the administrator's own compute session |
| `GET /v2/admin/users` | Search members, 50 per page, using q and offset |
| `PUT /v2/admin/users/{id}/membership` | Grant/change/revoke a membership with expiry, reason and revision |
| `POST /v2/admin/users/{id}/sync` | Queue an upstream reconciliation retry |
| `GET /v2/admin/audit` | Latest 100 audited changes |

The model routes currently accept the browser session, not an arbitrary bearer
token from a desktop or an OpenAI SDK. Requests are limited to 2 MiB and model
streams to five minutes. Responses do not expose upstream refresh cookies or
model keys. Current-session logout intentionally does not revoke another device.
Global session revocation, native device sessions, payment integration, automatic
renewal and monthly compute grants remain later milestones. Responses background
jobs, WebSocket and other unlisted model routes are not exposed.

## Membership administrator setup

1. Configure `SOMNIQ_ACCOUNT_ADMIN_SUBJECTS` on the account server with one or more
   comma-separated OIDC subjects from the configured Keycloak realm, then restart.
   A subject is the user's immutable Keycloak user ID (`sub`), not an email,
   username, SomniQ UUID or New API numeric ID. An empty setting authorizes nobody.
   The issuer is checked as well. New API roles do not grant SomniQ administration.
2. Build the Site with `VITE_ACCOUNT_MODE=independent`, configure the additional
   `/v2/admin/`, `/v2/catalog/` and model routes shown in the preview Nginx example,
   and visit `/account.html` to log in, consent and connect compute.
3. The administrator link appears in the homepage navigation and account center.
   Open `/admin.html`, read the New API model list, select exact models and defaults
   for each plan, then save and enable. Manual IDs are supported when the upstream
   catalog is incomplete; confirm those models and the users' routing groups in
   New API. Model discovery is configuration inventory, not a channel health test.
4. In the members tab, choose a user and plan, set an explicit future expiry and
   record the reason. This does not charge money or increase the compute balance.
   Two administrators editing the same revision receive a conflict rather than
   silently overwriting each other. Disabling a plan blocks its models immediately.

Fresh plans start disabled with empty model lists. New users and existing preview
accounts have no paid membership until explicitly granted; a balance or old group
does not create one. Prices are fixed server-side offers in CNY cents, billed
monthly (2900/4900/9900); no checkout, payment verification or automatic renewal is
implemented. API/model grants are independent of New API's wallet balance.

The model entry checks current membership for every request, rejects duplicate
model fields and unregistered names, and forwards only through fixed upstream
paths. Its service keys have model restrictions enabled even when the allowlist
is empty. Key IDs, owners and applied settings are verified. A finite token cap
manually applied to a dedicated service key must be reconciled by an operator;
the adapter will not read/overwrite a concurrently consumed finite budget.
New API's user wallet remains responsible for consumption.

The single-process server holds policy changes against requests awaiting upstream
headers; an already admitted bounded stream can finish. Further calls see the
new policy. A durable queue retries reconciliation and periodically rechecks keys.
When policy changes, a request must synchronize and verify the current allowlist
before forwarding. Missing/failed synchronization never grants a higher model.
The queue is scoped to the configured New API instance and survives restarts.

Keep New API model and ordinary-user management endpoints behind the trusted
gateway for migrated accounts. The legacy Desktop/PWA and old raw keys still
need their separate migration; this preview does not constrain those old paths.
Do not deploy the preview Nginx file over a shared production virtual host without
the planned migration. The official New API source and image are unchanged.

Fresh `dev.mjs init` configurations seed an immutable test subject and authorize
that development user. Existing local realms keep their old ID: set
`SOMNIQ_ACCOUNT_ADMIN_SUBJECTS` explicitly from that realm instead of replacing
its data or reusing a subject from a different installation.

## Verification

```powershell
cargo fmt --manifest-path site/account-server/Cargo.toml --check
cargo test --locked --manifest-path site/account-server/Cargo.toml
cargo clippy --locked --manifest-path site/account-server/Cargo.toml --all-targets -- -D warnings
cargo build --locked --manifest-path site/account-server/Cargo.toml
node --test deploy/newapi/check-updates.test.mjs
node site/account-server/scripts/live-compat.mjs
$env:NEWAPI_TEST_TAG = 'v1.0.0-rc.40'
node site/account-server/scripts/live-compat.mjs
```

The live harness downloads the official x64 Windows/Linux release, checks its
published SHA-256, starts it with a fresh local SQLite database, and runs the
real account/key/model endpoints. Its OIDC provider signs actual RSA ID tokens;
the identity provider and paid model channel are local fixtures. This verifies
the upstream adapter, **not** an actual Keycloak deployment or migration of an
existing production database. Each run leaves a safe `validation.json` plus
private local logs/databases in an ignored `.tmp-account-compat-*` directory.
Do not upload the raw logs, databases or test credentials as CI artifacts.

The real Keycloak + Site browser test requires the official Keycloak 26.7.4 ZIP
distribution extracted into an ignored local directory, a supported JDK on PATH,
and Site dependencies (`npm ci` in `site/` and `site/remote/`). Verify the ZIP's
published checksum before executing it. The GitHub workflow performs that check.

```powershell
$env:SOMNIQ_KEYCLOAK_HOME = (Resolve-Path '.codex/identity-tools/keycloak-26.7.4').Path
node site/account-server/scripts/live-compat.mjs
```

This mode copies a **clean distribution** into a disposable directory, imports
the same development realm, and verifies real browser login, explicit consent,
New API connection, the administrator editor, user grants, monthly prices,
three-tier allowlists, downgrade/revocation/expiry, streaming, logout/re-login,
responsive layout and outage isolation. Model channels are local fixtures.
Never point it at a production Keycloak installation or data directory.
Registration and recovery links are checked, but SMTP delivery, email verification
and password recovery are not covered by the seeded-user browser test.

## Upstream updates

`deploy/newapi/version.lock.json` records the inspected production baseline;
`candidate.json` records a proposed release without promoting it.

```powershell
node deploy/newapi/check-updates.mjs --write
```

The policy checks both GitHub release metadata and the version string. RC tags
remain RC even when GitHub sets `prerelease=false`. The current baseline is on
the explicitly selected RC channel; the stable channel never silently downgrades
an RC deployment to an older stable release.

`.github/workflows/newapi-compat.yml` tests the baseline and candidate, uploads
only validation reports, and can propose a draft PR after successful scheduled
or manual checks. Scheduled runs become active only when the workflow is on the
repository's default branch. Creating draft PRs also requires the repository
setting permitting Actions to create pull requests and the repository Actions
variable `NEWAPI_UPDATE_DRAFT_PRS=true`. Draft proposals default to off; release
discovery, compatibility checks and artifacts do not depend on that switch.
There is no automatic
production deployment. Existing database migration and rollback review must
precede changing the production lock or service.

## Remaining rollout gates

1. Real Keycloak deployment, branded registration, email delivery and recovery.
2. Old-account binding, MFA/Passkey cases and a before/after ledger comparison.
3. Full Site dashboard/PWA migration, native desktop sessions and remote identity migration.
4. Product lifecycle and device revocation, abuse limits, operational backups and restore drill.
5. Production schema-migration rehearsal and an explicit reviewed cutover.

The existing remote gateway's independent local pairing approval remains part
of the product boundary; logging into this service does not authorize device control.
