#!/usr/bin/env bash
# put_immutable <file> <key> <content-type>
# Writes one immutable R2 object through wrangler. An existing object is
# reused only when it is byte-identical (a re-run of the same signed bytes);
# different bytes, or a lookup failure that does not prove absence, fail closed.
# env: WRANGLER (pinned binary), DOWNLOADS_BUCKET, Cloudflare credentials.
set -euo pipefail

put_immutable() {
  local file="$1" key="$2" content_type="$3" existing get_log status
  existing="$(mktemp)"
  get_log="$(mktemp)"
  if "$WRANGLER" r2 object get --remote "${DOWNLOADS_BUCKET}/${key}" --file "$existing" >"$get_log" 2>&1; then
    if ! cmp -s "$existing" "$file"; then
      rm -f "$existing" "$get_log"
      echo "::error::Refusing to overwrite immutable ${key} with different bytes."
      return 1
    fi
    echo "[mobile-ota-release] Reusing byte-identical ${key}"
  else
    status="$?"
    if ! grep -Eqi 'specified key does not exist|NoSuchKey|R2 object .+ does not exist' "$get_log"; then
      cat "$get_log"
      rm -f "$existing" "$get_log"
      echo "::error::Unable to prove ${key} is absent (wrangler exit ${status})."
      return 1
    fi
    "$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${key}" --file "$file" \
      --content-type "$content_type" --cache-control "public, max-age=31536000, immutable"
    echo "[mobile-ota-release] Uploaded ${key}"
  fi
  rm -f "$existing" "$get_log"
}

if [[ $# -ne 3 || -z "${WRANGLER:-}" || -z "${DOWNLOADS_BUCKET:-}" ]]; then
  echo "::error::Usage: WRANGLER=... DOWNLOADS_BUCKET=... put-immutable.sh <file> <key> <content-type>"
  exit 2
fi
case "$3" in
  application/zip | application/json) ;;
  *) echo "::error::Unsupported OTA content type $3"; exit 2 ;;
esac
test -f "$1"
put_immutable "$1" "$2" "$3"
