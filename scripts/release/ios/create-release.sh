#!/usr/bin/env bash
# Last publication step: re-prove the tag still peels to the authorized commit
# on protected main and that no Release exists, then create the GitHub Release
# with release-receipt.json (+ the IPA when it was built in this run).
#
# usage: create-release.sh <state-dir> <release-dir> [<ipa>]
# env:   GH_TOKEN, GITHUB_REPOSITORY, TAG, SOURCE_SHA, MARKETING, BUILD, APP_BUNDLE_ID
set -euo pipefail
: "${TAG:?}" "${SOURCE_SHA:?}" "${MARKETING:?}" "${BUILD:?}" "${APP_BUNDLE_ID:?}"
state="$1"
release_dir="$2"
ipa="${3:-}"
bash scripts/release/ios/github-release-state.sh "$TAG" "$SOURCE_SHA" "$state"
RELEASE_STATE_DIR="$state" RELEASE_TAG="$TAG" node scripts/release/ios/verify-release-tag.mjs recheck
receipt="$release_dir/release-receipt.json"
[ -f "$receipt" ] || { echo "::error::release-receipt.json is missing." >&2; exit 1; }
notes="TestFlight internal build of $APP_BUNDLE_ID from source $SOURCE_SHA"
if [ -n "$ipa" ]; then
  gh release create "$TAG" --verify-tag --latest=false --title "Instafy iOS $MARKETING ($BUILD)" \
    --notes "$notes" "$receipt" "$ipa"
else
  gh release create "$TAG" --verify-tag --latest=false --title "Instafy iOS $MARKETING ($BUILD)" \
    --notes "$notes (reconciled)" "$receipt"
fi
echo "Published https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/release-receipt.json"
