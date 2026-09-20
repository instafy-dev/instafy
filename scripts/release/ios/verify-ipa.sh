#!/usr/bin/env bash
# Locate the single exported IPA, rename it Instafy.ipa and prove it is the
# exact signed app: strict codesign on the archived and exported .app, the
# installed profile embedded byte-for-byte, the leaf certificate SHA-256, the
# committed bundle/version/build, no credential-bearing or private entries.
# bash 3.2 safe.
#
# env: IOS_ARCHIVE_PATH, IOS_EXPORT_DIR, IOS_RELEASE_DIR, IOS_APP_STORE_PROFILE_PATH,
#      IOS_DIST_CERT_SHA256, APP_BUNDLE_ID, EXPECTED_MARKETING, EXPECTED_BUILD, GITHUB_OUTPUT
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

: "${IOS_ARCHIVE_PATH:?}" "${IOS_EXPORT_DIR:?}" "${IOS_RELEASE_DIR:?}" "${IOS_APP_STORE_PROFILE_PATH:?}"
: "${IOS_DIST_CERT_SHA256:?}" "${APP_BUNDLE_ID:?}" "${EXPECTED_MARKETING:?}" "${EXPECTED_BUILD:?}" "${GITHUB_OUTPUT:?}"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/instafy-ios-verify.XXXXXX")"
trap 'rm -rf "$work"' EXIT

find "$IOS_EXPORT_DIR" -maxdepth 2 -type f -name '*.ipa' -print > "$work/ipas.txt"
[ "$(wc -l < "$work/ipas.txt" | tr -d ' ')" = "1" ] || fail "The export did not produce exactly one IPA."
ipa="$IOS_RELEASE_DIR/Instafy.ipa"
[ ! -e "$ipa" ] || fail "The final IPA path already exists."
mkdir -p "$IOS_RELEASE_DIR"
mv "$(sed -n '1p' "$work/ipas.txt")" "$ipa"
[ -f "$ipa" ] && [ ! -L "$ipa" ] || fail "The exported IPA is not a regular file."

verify_app() { # <label> <app-dir>
  label="$1"
  app="$2"
  codesign --verify --strict --verbose=2 "$app"
  profile="$app/embedded.mobileprovision"
  if [ ! -f "$profile" ] || [ -L "$profile" ] || ! cmp -s "$IOS_APP_STORE_PROFILE_PATH" "$profile"; then
    fail "The $label was not signed with the exact installed App Store profile."
  fi
  certs="$work/$label-certs"
  mkdir -m 700 "$certs"
  codesign -d --extract-certificates="$certs/cert-" "$app" >/dev/null 2>&1
  [ -f "$certs/cert-0" ] || fail "The $label has no leaf signing certificate."
  leaf="$(shasum -a 256 "$certs/cert-0" | awk '{print $1}')"
  [ "$leaf" = "$IOS_DIST_CERT_SHA256" ] || fail "The $label leaf certificate is not the imported Apple Distribution certificate."
  plist="$app/Info.plist"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = "$APP_BUNDLE_ID" ] ||
    fail "The $label bundle identifier differs."
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" = "$EXPECTED_MARKETING" ] ||
    fail "The $label marketing version differs from the tag."
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")" = "$EXPECTED_BUILD" ] ||
    fail "The $label build number differs from the tag."
}

find "$IOS_ARCHIVE_PATH/Products/Applications" -maxdepth 1 -type d -name '*.app' -print > "$work/archive-apps.txt"
[ "$(wc -l < "$work/archive-apps.txt" | tr -d ' ')" = "1" ] || fail "The archive does not hold exactly one app."
verify_app archive "$(sed -n '1p' "$work/archive-apps.txt")"

# Write listings to files: `producer | grep -q` can turn SIGPIPE into a pass.
unzip -Z1 "$ipa" > "$work/entries.txt"
[ -s "$work/entries.txt" ] || fail "The IPA is empty."
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$work/entries.txt"; then
  fail "The IPA contains an absolute or traversal path."
fi
if grep -Eq '(^|/)(\.env(\..+)?|auth\.json|[^/]+\.p12|[^/]+\.p8)$' "$work/entries.txt"; then
  grep -nE '(^|/)(\.env(\..+)?|auth\.json|[^/]+\.p12|[^/]+\.p8)$' "$work/entries.txt" >&2
  fail "A credential-bearing file was packaged into the IPA."
fi
# Private package markers, assembled so the source tree never contains them.
private_markers="kno""sh|operator""-console"
if grep -Eiq "$private_markers" "$work/entries.txt"; then
  fail "A private package marker was found in the IPA."
fi

mkdir -m 700 "$work/expanded"
unzip -qq "$ipa" -d "$work/expanded"
find "$work/expanded/Payload" -maxdepth 1 -type d -name '*.app' -print > "$work/ipa-apps.txt"
[ "$(wc -l < "$work/ipa-apps.txt" | tr -d ' ')" = "1" ] || fail "The IPA does not hold exactly one app."
verify_app ipa "$(sed -n '1p' "$work/ipa-apps.txt")"

sha256="$(shasum -a 256 "$ipa" | awk '{print $1}')"
md5="$(md5 -q "$ipa")"
size="$(stat -f '%z' "$ipa")"
printf '%s' "$sha256" | grep -Eq '^[0-9a-f]{64}$' || fail "IPA sha256 is invalid."
printf '%s' "$md5" | grep -Eq '^[0-9a-f]{32}$' || fail "IPA md5 is invalid."
printf '%s' "$size" | grep -Eq '^[1-9][0-9]*$' || fail "IPA size is invalid."
[ "$size" -le 10737418240 ] || fail "IPA exceeds 10 GiB."

{
  echo "ipa_sha256=$sha256"
  echo "ipa_md5=$md5"
  echo "ipa_size=$size"
} | tee -a "$GITHUB_OUTPUT" > "$IOS_RELEASE_DIR/digests.env"
echo "Verified Instafy.ipa sha256=$sha256 size=$size"
