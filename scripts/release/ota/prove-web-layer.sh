#!/usr/bin/env bash
# prove-web-layer.sh <dist> <source-sha>
# Proves the built web layer is exact (carries the release commit), web-only
# (no symlinks, hidden paths, executables or native payloads) and free of
# Supabase secret keys, then prints a sha256 over its sorted file inventory so
# a later job can prove it signs exactly these files.
set -euo pipefail

dist="${1:?dist directory}"
source_sha="${2:?source sha}"
fail() { echo "::error::$1" >&2; exit 1; }

[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "The release commit must be a 40-hex sha."
[[ -d "$dist" && ! -L "$dist" && -s "$dist/index.html" ]] || fail "The OTA web layer has no index.html."
if [[ -n "$(find "$dist" -type l -print -quit)" ]]; then fail "The OTA web layer contains a symbolic link."; fi
if [[ -n "$(find "$dist" -mindepth 1 -name '.*' -print -quit)" ]]; then fail "The OTA web layer contains a hidden path."; fi
native="$(find "$dist" \( \( -type f -perm -u+x \) -o \( -type f -perm -g+x \) -o \( -type f -perm -o+x \) \
  -o \( -type f \( -name '*.dylib' -o -name '*.so' -o -name '*.a' -o -name '*.o' -o -name '*.apk' -o -name '*.aab' \
  -o -name '*.ipa' -o -name '*.aar' -o -name '*.jar' -o -name '*.dex' -o -name '*.exe' -o -name '*.dll' -o -name '*.node' \) \) \
  -o \( -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xcframework' \) \) \) -print -quit)"
if [[ -n "$native" ]]; then fail "A native or executable payload was found; OTA may ship web-layer changes only."; fi
grep -R -F -q -- "$source_sha" "$dist" || fail "The web layer does not carry the release commit."
if grep -R -F -q -- "sb_secret_" "$dist"; then fail "A Supabase secret key reached the OTA web layer."; fi

if command -v sha256sum >/dev/null 2>&1; then digest() { sha256sum; }; else digest() { shasum -a 256; }; fi
(cd "$dist" && find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
  printf '%s  %s\n' "$(digest < "$file" | cut -d' ' -f1)" "$file"
done) | digest | cut -d' ' -f1
