#!/usr/bin/env bash
# Verifies the single Gradle release bundle and stages it with its evidence.
#
# usage: verify-aab.sh <bundle-dir> <out-dir>
# env:   TAG SOURCE_SHA VERSION_NAME VERSION_CODE TRUST_KEY_SHA256 ANDROID_APPLICATION_ID
#        BUNDLETOOL_VERSION BUNDLETOOL_SHA256 GITLEAKS_VERSION GITLEAKS_LINUX_X64_SHA256
# Writes <out-dir>/app-release.aab, ota.json and digests.env. Proves, in order:
# exactly one AAB; bundletool (checksum-pinned) manifest package/versionCode/
# versionName; jarsigner "jar verified."; inspect-aab.py (zip hygiene, OTA
# channel + trust key, source commit); Gitleaks (checksum-pinned) over the bytes.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail "usage: verify-aab.sh <bundle-dir> <out-dir>"
bundle_dir="$1"
out="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$here/../../.." && pwd)"
[[ "$TRUST_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Missing OTA trust key fingerprint."
[[ -d "$out" && ! -e "$out/app-release.aab" ]] || fail "The staging directory is missing or already used."

shopt -s nullglob
bundles=("$bundle_dir"/*.aab)
[[ ${#bundles[@]} -eq 1 && -f "${bundles[0]}" && ! -L "${bundles[0]}" ]] || fail "Expected exactly one release AAB."
cp "${bundles[0]}" "$out/app-release.aab"
aab="$out/app-release.aab"

work="$(mktemp -d)"
bundletool="$work/bundletool-all-${BUNDLETOOL_VERSION}.jar"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 2 --output "$bundletool" \
  "https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/bundletool-all-${BUNDLETOOL_VERSION}.jar"
printf '%s  %s\n' "$BUNDLETOOL_SHA256" "$bundletool" | sha256sum --check --status || fail "bundletool checksum mismatch."
manifest() { java -jar "$bundletool" dump manifest --bundle="$aab" --xpath="$1"; }
[[ "$(manifest /manifest/@package)" == "$ANDROID_APPLICATION_ID" ]] || fail "AAB package differs from $ANDROID_APPLICATION_ID."
[[ "$(manifest /manifest/@android:versionCode)" == "$VERSION_CODE" ]] || fail "AAB versionCode differs from the tag."
[[ "$(manifest /manifest/@android:versionName)" == "$VERSION_NAME" ]] || fail "AAB versionName differs from the tag."

# jarsigner, not apksigner (an .aab carries a JAR signature); no -strict,
# because the self-signed upload certificate is expected.
verify_output="$(jarsigner -verify "$aab" 2>&1)" || fail "jarsigner could not verify the AAB."
[[ "$verify_output" == *"jar verified."* ]] || fail "The AAB is not signed by the upload key."

python3 "$here/inspect-aab.py" "$aab" "$TRUST_KEY_SHA256" "$VERSION_NAME" "$VERSION_CODE" "$SOURCE_SHA" > "$out/ota.json"

mkdir -m 700 "$work/scan"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --output "$work/gitleaks.tar.gz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
printf '%s  %s\n' "$GITLEAKS_LINUX_X64_SHA256" "$work/gitleaks.tar.gz" | sha256sum --check --status || fail "Gitleaks checksum mismatch."
tar -xzf "$work/gitleaks.tar.gz" -C "$work" gitleaks
# Gitleaks inspects ZIP containers by extension; scan the exact bytes as .zip.
cp "$aab" "$work/scan/instafy-release.aab.zip"
node "$here/gitleaks-release-artifact.mjs" --root "$work/scan" \
  --config "$repository_root/scripts/public-boundary-gitleaks.toml" --executable "$work/gitleaks"

{
  echo "TAG=$TAG"
  echo "SOURCE_SHA=$SOURCE_SHA"
  echo "VERSION_NAME=$VERSION_NAME"
  echo "VERSION_CODE=$VERSION_CODE"
  echo "AAB_SHA256=$(sha256sum "$aab" | cut -d' ' -f1)"
  echo "AAB_SIZE_BYTES=$(wc -c < "$aab" | tr -d '[:space:]')"
  echo "TRUST_KEY_SHA256=$TRUST_KEY_SHA256"
} > "$out/digests.env"
rm -rf "$work"
echo "[android-release] Verified app-release.aab for ${TAG}."
