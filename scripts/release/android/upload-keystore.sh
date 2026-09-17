#!/usr/bin/env bash
# Keeps the Play upload keystore on disk only while Gradle needs it.
#
# usage: upload-keystore.sh prove        decode, keytool-check the alias, delete (early fail-fast)
#        upload-keystore.sh materialize  decode + keytool-check again; append path=<file> to GITHUB_OUTPUT
#        upload-keystore.sh remove       delete the signing directory (idempotent)
# env:   RUNNER_TEMP, and for prove/materialize ANDROID_UPLOAD_KEYSTORE_B64,
#        ANDROID_UPLOAD_KEYSTORE_TYPE, ANDROID_UPLOAD_KEYSTORE_PASSWORD, ANDROID_UPLOAD_KEY_ALIAS.
#
# "prove" runs before pnpm install / cap:sync so a wrong alias or password fails
# before any build minute, but the file is gone again while third-party install
# and build scripts run; "materialize" writes it back immediately before Gradle.
# Never prints secret values.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: upload-keystore.sh prove|materialize|remove"
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" ]] || fail "RUNNER_TEMP is required."
signing_dir="$RUNNER_TEMP/instafy-android-signing"
keystore="$signing_dir/upload.keystore"

remove() {
  rm -rf "$signing_dir"
}

decode_and_prove() {
  local name
  for name in ANDROID_UPLOAD_KEYSTORE_B64 ANDROID_UPLOAD_KEYSTORE_TYPE ANDROID_UPLOAD_KEYSTORE_PASSWORD ANDROID_UPLOAD_KEY_ALIAS; do
    [[ -n "${!name:-}" ]] || fail "Missing android-release secret ${name}."
  done
  remove
  mkdir -m 700 "$signing_dir"
  (umask 077 && printf '%s' "$ANDROID_UPLOAD_KEYSTORE_B64" | base64 -d > "$keystore") ||
    { remove; fail "ANDROID_UPLOAD_KEYSTORE_B64 is not valid base64."; }
  chmod 600 "$keystore"
  [[ -s "$keystore" ]] || { remove; fail "ANDROID_UPLOAD_KEYSTORE_B64 decodes to an empty keystore."; }
  keytool -list -keystore "$keystore" -storetype "$ANDROID_UPLOAD_KEYSTORE_TYPE" \
    -storepass "$ANDROID_UPLOAD_KEYSTORE_PASSWORD" -alias "$ANDROID_UPLOAD_KEY_ALIAS" > /dev/null 2>&1 ||
    { remove; fail "The keystore has no ANDROID_UPLOAD_KEY_ALIAS entry, or its password/type is wrong."; }
}

case "$1" in
  prove)
    decode_and_prove
    remove
    echo "[android-release] Upload keystore proven and removed until the Gradle step." ;;
  materialize)
    [[ -n "${GITHUB_OUTPUT:-}" ]] || fail "GITHUB_OUTPUT is required."
    decode_and_prove
    echo "path=$keystore" >> "$GITHUB_OUTPUT" ;;
  remove)
    remove ;;
  *)
    fail "usage: upload-keystore.sh prove|materialize|remove" ;;
esac
