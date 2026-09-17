#!/usr/bin/env bash
# Scan the exact final IPA bytes (as a .zip alias so Gitleaks opens the
# container) with pinned Gitleaks darwin_arm64 and the public boundary config.
# env: RUNNER_TEMP, IOS_RELEASE_DIR, IPA, GITLEAKS_VERSION, GITLEAKS_DARWIN_ARM64_SHA256
set -euo pipefail
: "${RUNNER_TEMP:?}" "${IOS_RELEASE_DIR:?}" "${IPA:?}" "${GITLEAKS_VERSION:?}" "${GITLEAKS_DARWIN_ARM64_SHA256:?}"
root="$(mktemp -d "$RUNNER_TEMP/instafy-ios-gitleaks.XXXXXX")"
archive="$root/gitleaks.tar.gz"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz" \
  --output "$archive"
if [ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$GITLEAKS_DARWIN_ARM64_SHA256" ]; then
  echo "::error::Pinned Gitleaks archive checksum mismatch." >&2
  exit 1
fi
mkdir -m 700 "$root/bin" "$root/scan"
tar -xzf "$archive" -C "$root/bin" gitleaks
cp "$IOS_RELEASE_DIR/$IPA" "$root/scan/instafy-release.ipa.zip"
node scripts/release/ios/gitleaks-release-artifact.mjs --root "$root/scan" \
  --config scripts/public-boundary-gitleaks.toml --executable "$root/bin/gitleaks"
rm -rf "$root"
