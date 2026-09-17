#!/usr/bin/env bash
# Run-owned Apple signing credentials on a hosted macOS runner (bash 3.2 safe:
# no array builtins, no case-conversion expansions, no empty-array expansion).
#
#   signing-credentials.sh require       validate the six Apple secrets (names only are printed)
#   signing-credentials.sh keychain      create the isolated keychain, import the p12,
#                                        export IOS_SIGNING_KEYCHAIN / IOS_DIST_CERT_SHA1
#   signing-credentials.sh stage-asc-key write AuthKey_<KEY_ID>.p8 (0600, noclobber)
#   signing-credentials.sh cleanup       remove profile, p8, keychain; restore search list
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

require_credentials() {
  missing=0
  for name in IOS_DEVELOPMENT_TEAM IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD \
    APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_PRIVATE_KEY; do
    if [ -z "${!name:-}" ]; then
      echo "::error::Missing required ios-release secret ${name}." >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1
  printf '%s' "$IOS_DEVELOPMENT_TEAM" | grep -Eq '^[A-Z0-9]{10}$' ||
    fail "IOS_DEVELOPMENT_TEAM must be the 10-character Apple Team ID."
  printf '%s' "$APP_STORE_CONNECT_KEY_ID" | grep -Eq '^[A-Za-z0-9]{4,32}$' ||
    fail "APP_STORE_CONNECT_KEY_ID must be alphanumeric (4-32)."
  printf '%s' "$APP_STORE_CONNECT_ISSUER_ID" | grep -Eq '^[0-9a-fA-F-]{36}$' ||
    fail "APP_STORE_CONNECT_ISSUER_ID must be the App Store Connect issuer UUID."
  case "$APP_STORE_CONNECT_PRIVATE_KEY" in
    *'\n'*) fail "APP_STORE_CONNECT_PRIVATE_KEY must use real newlines, not literal \\n escapes (altool reads the .p8 as-is)." ;;
    "-----BEGIN PRIVATE"*) ;;
    *) fail "APP_STORE_CONNECT_PRIVATE_KEY must be the full .p8 PEM." ;;
  esac
  echo "All six Apple release credentials are present and well-formed."
}

prepare_keychain() {
  : "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${IOS_DEVELOPMENT_TEAM:?}"
  : "${IOS_DIST_CERT_P12_BASE64:?}" "${IOS_DIST_CERT_PASSWORD:?}"
  umask 077
  keychain="$RUNNER_TEMP/instafy-ios-signing.keychain-db"
  if [ -e "$keychain" ] || [ -L "$keychain" ]; then
    fail "The iOS signing keychain path already exists."
  fi
  state="$(mktemp -d "$RUNNER_TEMP/instafy-ios-signing.XXXXXX")"
  # Record cleanup ownership before any credential exists.
  {
    echo "IOS_SIGNING_STATE=$state"
    echo "IOS_SIGNING_KEYCHAIN=$keychain"
  } >> "$GITHUB_ENV"
  security list-keychains -d user > "$state/search-list.txt"
  python3 - "$state/search-list.txt" "$state/search-list.json" <<'PY'
import json, os, shlex, sys
original = shlex.split(open(sys.argv[1], encoding="utf-8").read())
if any(not os.path.isabs(value) or "\n" in value for value in original):
    raise SystemExit("invalid existing keychain search list")
with open(sys.argv[2], "x", encoding="utf-8") as target:
    json.dump(original, target)
PY
  keychain_password="$(openssl rand -base64 24)"
  echo "::add-mask::$keychain_password"
  certificate="$state/certificate.p12"
  printf '%s' "$IOS_DIST_CERT_P12_BASE64" | base64 -d > "$certificate"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$certificate" -k "$keychain" -P "$IOS_DIST_CERT_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  rm -f "$certificate"
  # Without the partition list the first codesign blocks on an invisible prompt.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$keychain_password" "$keychain" >/dev/null
  python3 - "$state/search-list.json" "$keychain" <<'PY'
import json, subprocess, sys
original = json.load(open(sys.argv[1], encoding="utf-8"))
subprocess.run(["security", "list-keychains", "-d", "user", "-s", sys.argv[2], *original], check=True)
PY
  # Capture first: piping into an early-exiting filter can SIGPIPE under pipefail.
  identities="$(security find-identity -v -p codesigning "$keychain")"
  count="$(printf '%s\n' "$identities" | awk '/"(Apple|iPhone) Distribution:/ { n++ } END { print n + 0 }')"
  [ "$count" -eq 1 ] || fail "The p12 must hold exactly one Apple Distribution identity (found $count)."
  identity_name="$(printf '%s\n' "$identities" | awk -F'"' '/"(Apple|iPhone) Distribution:/ { print $2; exit }')"
  identity_sha1="$(printf '%s\n' "$identities" | awk '/"(Apple|iPhone) Distribution:/ { print $2; exit }')"
  case "$identity_name" in
    *"($IOS_DEVELOPMENT_TEAM)") ;;
    *) fail "The Apple Distribution identity does not belong to IOS_DEVELOPMENT_TEAM." ;;
  esac
  printf '%s' "$identity_sha1" | grep -Eq '^[0-9A-Fa-f]{40}$' ||
    fail "The Apple Distribution identity has no exact SHA-1."
  identity_sha1="$(printf '%s' "$identity_sha1" | tr 'ABCDEF' 'abcdef')"
  echo "IOS_DIST_CERT_SHA1=$identity_sha1" >> "$GITHUB_ENV"
  echo "Prepared an isolated keychain with one Apple Distribution identity ($identity_sha1)."
}

stage_asc_key() {
  : "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${APP_STORE_CONNECT_KEY_ID:?}" "${APP_STORE_CONNECT_PRIVATE_KEY:?}"
  printf '%s' "$APP_STORE_CONNECT_KEY_ID" | grep -Eq '^[A-Za-z0-9]{4,32}$' ||
    fail "APP_STORE_CONNECT_KEY_ID is invalid."
  umask 077
  directory="$(mktemp -d "$RUNNER_TEMP/instafy-ios-asc.XXXXXX")"
  key_path="$directory/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
  {
    echo "ASC_PRIVATE_KEYS_DIR=$directory"
    echo "ASC_KEY_PATH=$key_path"
    echo "API_PRIVATE_KEYS_DIR=$directory"
  } >> "$GITHUB_ENV"
  (set -o noclobber; printf '%s\n' "$APP_STORE_CONNECT_PRIVATE_KEY" > "$key_path")
  chmod 600 "$key_path"
  echo "Staged the App Store Connect API key for this run."
}

cleanup() {
  status=0
  store="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  if [ -n "${IOS_APP_STORE_PROFILE_PATH:-}" ]; then
    case "$(basename "$IOS_APP_STORE_PROFILE_PATH")" in
      *.mobileprovision)
        if [ "$(dirname "$IOS_APP_STORE_PROFILE_PATH")" = "$store" ]; then
          rm -f "$IOS_APP_STORE_PROFILE_PATH" || status=1
        else
          echo "::error::Refusing to remove an unexpected profile path." >&2
          status=1
        fi
        ;;
      *) status=1 ;;
    esac
  fi
  if [ -n "${ASC_PRIVATE_KEYS_DIR:-}" ]; then
    case "$ASC_PRIVATE_KEYS_DIR" in
      "$RUNNER_TEMP"/instafy-ios-asc.*)
        rm -f "$ASC_PRIVATE_KEYS_DIR"/AuthKey_*.p8 && rmdir "$ASC_PRIVATE_KEYS_DIR" || status=1
        ;;
      *) echo "::error::Unexpected App Store Connect key directory." >&2; status=1 ;;
    esac
  fi
  if [ -n "${IOS_SIGNING_STATE:-}" ]; then
    case "$IOS_SIGNING_STATE" in
      "$RUNNER_TEMP"/instafy-ios-signing.*) ;;
      *) echo "::error::Unexpected signing state directory." >&2; exit 1 ;;
    esac
    rm -f "$IOS_SIGNING_STATE/certificate.p12" || status=1
    if [ -f "$IOS_SIGNING_STATE/search-list.json" ]; then
      python3 - "$IOS_SIGNING_STATE/search-list.json" <<'PY' || status=1
import json, subprocess, sys
original = json.load(open(sys.argv[1], encoding="utf-8"))
subprocess.run(["security", "list-keychains", "-d", "user", "-s", *original], check=True)
PY
    fi
    keychain="$RUNNER_TEMP/instafy-ios-signing.keychain-db"
    if [ "${IOS_SIGNING_KEYCHAIN:-}" = "$keychain" ] && [ -e "$keychain" ]; then
      security delete-keychain "$keychain" || status=1
    fi
    rm -rf "$IOS_SIGNING_STATE" || status=1
  fi
  if [ "$status" -ne 0 ]; then
    echo "::error::Signing credential cleanup was incomplete." >&2
  else
    echo "Signing credentials removed."
  fi
  return "$status"
}

case "${1:-}" in
  require) require_credentials ;;
  keychain) prepare_keychain ;;
  stage-asc-key) stage_asc_key ;;
  cleanup) cleanup ;;
  *) echo "usage: signing-credentials.sh require|keychain|stage-asc-key|cleanup" >&2; exit 2 ;;
esac
