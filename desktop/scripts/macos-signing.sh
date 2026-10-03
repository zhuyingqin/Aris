#!/usr/bin/env bash
# Stable macOS code-signing identity for SomniQ Studio releases.
#
# macOS privacy permissions (Documents/Desktop/Downloads, removable volumes,
# screen recording) and Keychain "Always Allow" are stored against the app's
# designated requirement. An unsigned bundle has none that TCC can keep, so
# the same folder prompts return on every launch. An ad-hoc bundle (the
# `signingIdentity: "-"` default in tauri.macos.conf.json) is pinned to its
# cdhash, so grants survive restarts but reset with every update. A
# long-lived self-signed certificate yields `certificate root = H"<sha1>"`,
# which stays the same across releases.
#
# Gatekeeper is unaffected either way: without an Apple Developer ID the app
# still needs Privacy & Security -> Open Anyway on first launch.
#
#   create <out-dir>                  one-time: generate the certificate + p12
#   import                            CI: load MACOS_SIGNING_P12[_PASSWORD]
#   verify <app> <bundle-identifier>  CI: check the seal and the requirement
#
# The secrets are deliberately not named APPLE_CERTIFICATE*: Tauri would try to
# import them itself and only accepts Apple-issued (trusted) identities.
set -euo pipefail

CERT_NAME="SomniQ Studio Release Signing"

die() {
  echo "macos-signing: $*" >&2
  exit 1
}

create() {
  local out="${1:-}"
  [[ -n "$out" ]] || die "usage: $0 create <out-dir>"
  [[ ! -e "$out/identity.p12" ]] || die "$out/identity.p12 already exists; reuse it, never rotate casually"
  mkdir -p "$out"
  umask 077
  # A config file instead of -subj: Git Bash rewrites "/CN=..." as a path.
  cat > "$out/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CERT_NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
  # Twenty years: a replacement certificate is a new requirement, which makes
  # every user grant the folder permissions once more.
  openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
    -config "$out/openssl.cnf" -keyout "$out/key.pem" -out "$out/cert.pem"
  local password
  password="$(openssl rand -hex 24)"
  # 3DES/SHA-1 PKCS#12: `security import` and the runner's LibreSSL cannot
  # read OpenSSL 3's default AES/PBKDF2 container on every macOS release.
  P12_PASSWORD="$password" openssl pkcs12 -export \
    -inkey "$out/key.pem" -in "$out/cert.pem" -name "$CERT_NAME" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout env:P12_PASSWORD -out "$out/identity.p12"
  base64 < "$out/identity.p12" | tr -d '\r\n' > "$out/identity.p12.base64"
  printf '%s' "$password" > "$out/identity.p12.password"
  rm -f "$out/key.pem" "$out/openssl.cnf"
  local fingerprint
  fingerprint="$(openssl x509 -in "$out/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
  cat <<EOF
Created "$CERT_NAME" (SHA-1 $fingerprint) in $out.
Back up identity.p12 and identity.p12.password outside the repository.
Losing them means one more round of permission prompts for every user.

Install as GitHub Actions secrets:
  gh secret set MACOS_SIGNING_P12 < "$out/identity.p12.base64"
  gh secret set MACOS_SIGNING_P12_PASSWORD < "$out/identity.p12.password"
EOF
}

import_identity() {
  [[ -n "${GITHUB_ENV:-}" ]] || die "import runs inside GitHub Actions only"
  if [[ -z "${MACOS_SIGNING_P12:-}" && -z "${MACOS_SIGNING_P12_PASSWORD:-}" ]]; then
    echo "::warning title=macOS signing::MACOS_SIGNING_P12 is not configured; this build is ad-hoc signed and users re-grant folder permissions after the update."
    return 0
  fi
  [[ -n "${MACOS_SIGNING_P12:-}" && -n "${MACOS_SIGNING_P12_PASSWORD:-}" ]] \
    || die "MACOS_SIGNING_P12 and MACOS_SIGNING_P12_PASSWORD must be set together"

  local work="${RUNNER_TEMP:?}/somniq-macos-signing"
  local keychain="$RUNNER_TEMP/somniq-signing.keychain-db"
  local keychain_password
  keychain_password="$(openssl rand -hex 24)"
  mkdir -p "$work"
  printf '%s' "$MACOS_SIGNING_P12" | base64 --decode > "$work/identity.p12"

  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$work/identity.p12" -k "$keychain" \
    -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign
  rm -f "$work/identity.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "$keychain_password" "$keychain" > /dev/null
  # shellcheck disable=SC2046 # the existing search list is whitespace-separated paths
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

  # codesign refuses an untrusted identity; trust it on this ephemeral runner.
  security find-certificate -p "$keychain" > "$work/identity.pem"
  sudo security add-trusted-cert -d -r trustRoot -p codeSign \
    -k /Library/Keychains/System.keychain "$work/identity.pem"

  local identities sha1
  identities="$(security find-identity -v -p codesigning "$keychain")"
  sha1="$(awk '$2 ~ /^[0-9A-F]{40}$/ { print $2; exit }' <<< "$identities")"
  [[ -n "$sha1" ]] || die "the imported certificate is not a valid code-signing identity"
  # Tauri prefers APPLE_SIGNING_IDENTITY over the config's "-". The SHA-1
  # cannot match a second identity on the runner, unlike the common name.
  echo "APPLE_SIGNING_IDENTITY=$sha1" >> "$GITHUB_ENV"
  echo "MACOS_SIGNING_SHA1=$sha1" >> "$GITHUB_ENV"
  echo "Imported macOS signing identity $sha1"
}

verify() {
  local app="${1:-}" identifier="${2:-}"
  [[ -d "$app" && -n "$identifier" ]] || die "usage: $0 verify <app> <bundle-identifier>"
  # An unsealed bundle (no signature, or only the linker's) fails here.
  codesign --verify --verbose=2 "$app"
  # Captured before matching: under pipefail an early-exiting `grep -q` can
  # SIGPIPE codesign and fail a check that actually matched.
  local details requirement
  details="$(codesign -dv "$app" 2>&1)"
  grep -Fqx "Identifier=$identifier" <<< "$details" \
    || die "$(basename "$app") is not signed as $identifier"
  requirement="$(codesign -d -r - "$app" 2>&1)"
  echo "$requirement"
  if [[ -z "${MACOS_SIGNING_SHA1:-}" ]]; then
    echo "::warning title=macOS signing::$(basename "$app") is ad-hoc signed; permissions persist across launches but not across updates."
    return 0
  fi
  if grep -q 'cdhash' <<< "$requirement"; then
    die "designated requirement is ad-hoc (cdhash); permissions would reset on update"
  fi
  grep -Fq "identifier \"$identifier\"" <<< "$requirement" \
    || die "designated requirement does not name $identifier"
  grep -Fqi "$MACOS_SIGNING_SHA1" <<< "$requirement" \
    || die "designated requirement does not name certificate $MACOS_SIGNING_SHA1"
}

case "${1:-}" in
  create) shift; create "$@" ;;
  import) shift; import_identity "$@" ;;
  verify) shift; verify "$@" ;;
  *) die "usage: $0 {create <out-dir>|import|verify <app> <bundle-identifier>}" ;;
esac
