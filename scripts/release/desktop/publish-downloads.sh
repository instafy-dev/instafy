#!/usr/bin/env bash
# Publishes one signed Desktop release to the downloads R2 bucket.
#
# Order (each mutable write is preceded by its immutable payload):
#   payloads (dmg, zip, blockmaps) -> latest-mac.yml -> latest.json
#   -> root latest.json -> candidate verification -> authority recheck
#   -> stable pointer -> publication verification (pointer rollback on failure)
#
# Required env: WRANGLER DOWNLOADS_BUCKET DOWNLOADS_BASE_URL
#   DESKTOP_DOWNLOADS_PREFIX TAG VERSION SOURCE_SHA RELEASE_PUBLISHED_AT
#   ARTIFACT_DIR WORK_DIR GITHUB_REPOSITORY GH_TOKEN CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID GITHUB_OUTPUT
# `publish-downloads.sh --recheck-only` runs only the authority recheck (needs
#   TAG SOURCE_SHA GITHUB_REPOSITORY GH_TOKEN WORK_DIR) before the GitHub Release.
# Optional env: PREVIOUS_STABLE_HINT (authorize job's live version, used only
#   when a re-run finds the pointer already naming this tag)
set -euo pipefail
set +x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LANE_DIR="$REPO_ROOT/scripts/release/desktop"
ABSENT_PATTERN='specified key does not exist|NoSuchKey|R2 object .+ does not exist'

RUN_MODE="${1:-publish}"
required_inputs="TAG SOURCE_SHA GITHUB_REPOSITORY GH_TOKEN WORK_DIR"
if [[ "$RUN_MODE" == "publish" ]]; then
  required_inputs="$required_inputs WRANGLER DOWNLOADS_BUCKET DOWNLOADS_BASE_URL DESKTOP_DOWNLOADS_PREFIX VERSION RELEASE_PUBLISHED_AT ARTIFACT_DIR CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GITHUB_OUTPUT"
elif [[ "$RUN_MODE" != "--recheck-only" ]]; then
  echo "::error::Usage: publish-downloads.sh [--recheck-only]"
  exit 1
fi
for name in $required_inputs; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Missing required publication input ${name}."
    exit 1
  fi
done
mkdir -p "$WORK_DIR"
CHANNEL="stable"

# Tag still peels to SOURCE_SHA, protected main still contains it, and the
# one-shot marker (the GitHub Release) is still absent.
recheck_authority() {
  local ref type sha status release_log
  ref="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${TAG}" --jq '.object.type + " " + .object.sha')"
  type="${ref%% *}"
  sha="${ref#* }"
  if [[ "$type" == "tag" ]]; then
    ref="$(gh api "repos/${GITHUB_REPOSITORY}/git/tags/${sha}" --jq '.object.type + " " + .object.sha')"
    type="${ref%% *}"
    sha="${ref#* }"
  fi
  if [[ "$type" != "commit" || "$sha" != "$SOURCE_SHA" ]]; then
    echo "::error::${TAG} no longer resolves to ${SOURCE_SHA}; nothing further was published."
    return 1
  fi
  status="$(gh api "repos/${GITHUB_REPOSITORY}/compare/${SOURCE_SHA}...main" --jq .status)"
  case "$status" in
    identical|ahead) ;;
    *)
      echo "::error::Protected main no longer contains ${SOURCE_SHA} (compare status: ${status}); nothing further was published."
      return 1
      ;;
  esac
  release_log="$WORK_DIR/release-probe.log"
  if gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${TAG}" >"$release_log" 2>&1; then
    echo "::error::A GitHub Release for ${TAG} already exists; this tag has already been published."
    return 1
  elif ! grep -q 'HTTP 404' "$release_log"; then
    echo "::error::Could not prove that no GitHub Release exists for ${TAG}."
    return 1
  fi
}

require_pointer_contract() {
  local body
  body="$(curl --proto '=https' --fail --silent --show-error --max-time 20 \
    "${DOWNLOADS_BASE_URL}/${DESKTOP_DOWNLOADS_PREFIX}/stable-pointer-contract.json?run=${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}")"
  CONTRACT_PAYLOAD="$body" node -e '
    const payload = JSON.parse(process.env.CONTRACT_PAYLOAD);
    if (JSON.stringify(payload) !== JSON.stringify({ schemaVersion: 1, stableAliases: "immutable-pointer" })) {
      throw new Error("downloads Worker does not advertise the immutable stable-pointer contract");
    }
  '
}

content_type_for() {
  case "$1" in
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.zip) echo "application/zip" ;;
    *.yml) echo "text/yaml" ;;
    *.json) echo "application/json" ;;
    *.blockmap) echo "application/octet-stream" ;;
    *) return 1 ;;
  esac
}

# r2_get <key> <file>: 0 = present, 2 = proven absent, anything else fails.
r2_get() {
  local log="$WORK_DIR/r2-get.log"
  if "$WRANGLER" r2 object get --remote "${DOWNLOADS_BUCKET}/$1" --file "$2" >"$log" 2>&1; then
    return 0
  fi
  if grep -Eqi "$ABSENT_PATTERN" "$log"; then
    rm -f "$2"
    return 2
  fi
  echo "::error::Unable to read or prove absence of ${1}."
  sed -n '1,40p' "$log"
  return 1
}

put_immutable() {
  local file="$1" key="$2" content_type="$3" existing="$WORK_DIR/immutable-readback" status=0
  r2_get "$key" "$existing" || status=$?
  if [[ "$status" == 0 ]]; then
    if ! cmp -s "$existing" "$file"; then
      echo "::error::Refusing to overwrite immutable ${key} with different bytes."
      return 1
    fi
    echo "[desktop-release] Reusing byte-identical ${key}"
  elif [[ "$status" == 2 ]]; then
    "$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${key}" --file "$file" \
      --content-type "$content_type" --cache-control "public, max-age=31536000, immutable"
    echo "[desktop-release] Uploaded ${key}"
  else
    return 1
  fi
  rm -f "$existing"
}

upload_file() {
  local file="$1" name content_type
  name="$(basename "$file")"
  content_type="$(content_type_for "$name")" || { echo "::error::Unsupported Desktop artifact ${name}."; return 1; }
  put_immutable "$file" "${PREFIX}/${name}" "$content_type"
  "$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${CHANNEL_PREFIX}/${name}" --file "$file" \
    --content-type "$content_type" --cache-control "public, max-age=120"
  echo "[desktop-release] Uploaded ${CHANNEL_PREFIX}/${name}"
}

verify_phase() {
  DOWNLOADS_BASE_URL="$DOWNLOADS_BASE_URL" \
  DESKTOP_DOWNLOADS_PREFIX="$DESKTOP_DOWNLOADS_PREFIX" \
  DESKTOP_PUBLICATION_CHANNEL="$CHANNEL" \
  DESKTOP_PUBLICATION_VERSION="$VERSION" \
  DESKTOP_PUBLICATION_TAG="$TAG" \
  DESKTOP_PUBLICATION_SOURCE_SHA="$SOURCE_SHA" \
  DESKTOP_PUBLICATION_PHASE="$1" \
    node "$REPO_ROOT/scripts/verify-desktop-publication.mjs"
}

recheck_authority
if [[ "$RUN_MODE" == "--recheck-only" ]]; then
  echo "[desktop-release] ${TAG} still resolves to ${SOURCE_SHA} on protected main and has no GitHub Release."
  exit 0
fi
[[ "$TAG" == "desktop-app-v${VERSION}" ]] || { echo "::error::TAG and VERSION disagree."; exit 1; }
DOWNLOADS_BASE_URL="${DOWNLOADS_BASE_URL%/}"
PREFIX="${DESKTOP_DOWNLOADS_PREFIX}/${TAG}"
CHANNEL_PREFIX="${DESKTOP_DOWNLOADS_PREFIX}/${CHANNEL}"
POINTER_KEY="${DESKTOP_DOWNLOADS_PREFIX}/stable-release.json"
ROOT_LATEST_KEY="${DESKTOP_DOWNLOADS_PREFIX}/latest.json"
require_pointer_contract

release_files="$WORK_DIR/release-files.txt"
node "$LANE_DIR/release-artifacts.mjs" release-set --root "$ARTIFACT_DIR" --version "$VERSION" --no-symlinks > "$release_files"
MAC_DMG_NAME="instafy-${VERSION}-mac-arm64.dmg"
MAC_ZIP_NAME="instafy-${VERSION}-mac-arm64.zip"

current_pointer="$WORK_DIR/current-stable-release.json"
latest="$WORK_DIR/latest.json"
pointer="$WORK_DIR/stable-release.json"
rm -f "$latest" "$pointer"
pointer_status=0
r2_get "$POINTER_KEY" "$current_pointer" || pointer_status=$?
current_pointer_path=""
pointer_already_selected=false
previous_stable_version=""
if [[ "$pointer_status" == 0 ]]; then
  current_tag="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tag' "$current_pointer")"
  if [[ "$current_tag" == "$TAG" ]]; then
    pointer_already_selected=true
    previous_stable_version="${PREVIOUS_STABLE_HINT:-}"
    echo "[desktop-release] ${POINTER_KEY} already selects ${TAG}; resuming at publication verification."
  else
    current_pointer_path="$current_pointer"
    previous_stable_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$current_pointer")"
  fi
elif [[ "$pointer_status" == 2 ]]; then
  echo "[desktop-release] No stable pointer exists; this is the first pointer-backed stable release."
else
  exit 1
fi

LATEST_PATH="$latest" \
POINTER_PATH="$pointer" \
CURRENT_POINTER_PATH="$current_pointer_path" \
RELEASE_TAG="$TAG" \
RELEASE_VERSION="$VERSION" \
RELEASE_CHANNEL="$CHANNEL" \
RELEASE_SOURCE_SHA="$SOURCE_SHA" \
RELEASE_PUBLISHED_AT="$RELEASE_PUBLISHED_AT" \
RELEASE_FEED_URL="${DOWNLOADS_BASE_URL}/${CHANNEL_PREFIX}" \
MAC_DMG_NAME="$MAC_DMG_NAME" \
MAC_ZIP_NAME="$MAC_ZIP_NAME" \
  node "$REPO_ROOT/scripts/create-desktop-release-metadata.mjs"
if [[ ! -s "$latest" || ! -s "$pointer" ]]; then
  echo "::error::Release metadata was not produced."
  exit 1
fi
if [[ "$pointer_already_selected" == true ]] && ! cmp -s "$current_pointer" "$pointer"; then
  echo "::error::${POINTER_KEY} names ${TAG} with different bytes than this run would publish."
  exit 1
fi

# Payloads first, then the updater feed, then latest.json.
payloads=()
while IFS= read -r name; do
  case "$name" in
    *.dmg|*.zip|*.blockmap) payloads+=("$ARTIFACT_DIR/$name") ;;
  esac
done < "$release_files"
for file in "${payloads[@]}"; do
  upload_file "$file"
done
upload_file "$ARTIFACT_DIR/latest-mac.yml"
upload_file "$latest"
"$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${ROOT_LATEST_KEY}" --file "$latest" \
  --content-type "application/json" --cache-control "public, max-age=120"
echo "[desktop-release] Uploaded ${ROOT_LATEST_KEY}"

verify_phase candidate

if [[ "$pointer_already_selected" != true ]]; then
  recheck_authority
  readback="$WORK_DIR/pointer-recheck.json"
  recheck_status=0
  r2_get "$POINTER_KEY" "$readback" || recheck_status=$?
  if [[ "$recheck_status" == 0 ]]; then
    if [[ -z "$current_pointer_path" ]] || ! cmp -s "$readback" "$current_pointer"; then
      echo "::error::${POINTER_KEY} changed during publication; stable was not selected."
      exit 1
    fi
  elif [[ "$recheck_status" == 2 ]]; then
    if [[ -n "$current_pointer_path" ]]; then
      echo "::error::${POINTER_KEY} disappeared during publication; stable was not selected."
      exit 1
    fi
  else
    exit 1
  fi
  "$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${POINTER_KEY}" --file "$pointer" \
    --content-type "application/json" --cache-control "no-store"
  echo "[desktop-release] Selected ${TAG} via ${POINTER_KEY}."
fi

if ! verify_phase publication; then
  if [[ "$pointer_already_selected" == true ]]; then
    echo "::error::Publication verification failed for a pointer selected by an earlier attempt; no prior pointer is known to restore."
    exit 1
  fi
  rollback="$WORK_DIR/rollback-readback.json"
  if [[ -n "$current_pointer_path" ]]; then
    "$WRANGLER" r2 object put --remote "${DOWNLOADS_BUCKET}/${POINTER_KEY}" --file "$current_pointer" \
      --content-type "application/json" --cache-control "no-store"
    "$WRANGLER" r2 object get --remote "${DOWNLOADS_BUCKET}/${POINTER_KEY}" --file "$rollback" >/dev/null 2>&1 || true
    if ! cmp -s "$current_pointer" "$rollback"; then
      echo "::error::Publication verification failed and the prior pointer was not restored byte-for-byte."
      exit 1
    fi
    echo "[desktop-release] Restored the exact prior stable pointer."
  else
    "$WRANGLER" r2 object delete --remote "${DOWNLOADS_BUCKET}/${POINTER_KEY}"
    rollback_status=0
    r2_get "$POINTER_KEY" "$rollback" || rollback_status=$?
    if [[ "$rollback_status" != 2 ]]; then
      echo "::error::Publication verification failed and deletion of the first pointer could not be proven."
      exit 1
    fi
    echo "[desktop-release] Deleted the first stable pointer after failed verification."
  fi
  echo "::error::Live stable publication verification failed; the stable pointer was rolled back."
  exit 1
fi

{
  echo "previous_stable_version=${previous_stable_version}"
  echo "latest_json=${latest}"
} >> "$GITHUB_OUTPUT"
echo "[desktop-release] Published ${TAG} (${SOURCE_SHA})."
