#!/usr/bin/env bash
# Fetch the sandboxed rusty_v8 build that codex-code-mode-host links.
#
# The host enables the v8 crate's `v8_enable_sandbox` feature. denoland/rusty_v8
# publishes no prebuilt archive for it, so the v8 build script cannot download
# one on its own. Codex publishes one per target on its own GitHub release and
# pins the checksum manifests in its repository; this script uses the same
# release files and checks every byte against those pinned checksums.
#
# Usage: scripts/fetch-rusty-v8.sh <rust-target-triple> <output-dir>
#
# Writes <output-dir>/rusty_v8_archive and <output-dir>/src_binding.rs, then
# prints the two variables the v8 build script reads:
#   RUSTY_V8_ARCHIVE=<output-dir>/rusty_v8_archive
#   RUSTY_V8_SRC_BINDING_PATH=<output-dir>/src_binding.rs
#
# The v8 version comes from packages/runtime-agent/Cargo.lock and the pinned
# manifest from the codex checkout; RUSTY_V8_LOCKFILE and CODEX_DIR override them.
set -euo pipefail

fail() {
  echo "fetch-rusty-v8: $*" >&2
  exit 1
}

[[ $# -eq 2 ]] || {
  echo "usage: $0 <rust-target-triple> <output-dir>" >&2
  exit 2
}
target=$1
output_dir=$2
[[ $target =~ ^[a-z0-9_]+(-[a-z0-9_]+){2,3}$ ]] || fail "invalid Rust target triple: $target"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lockfile=${RUSTY_V8_LOCKFILE:-$repo_root/packages/runtime-agent/Cargo.lock}
codex_dir=${CODEX_DIR:-$repo_root/codex}

version=$(awk '$0 == "name = \"v8\"" { getline; if ($1 == "version") { gsub(/"/, "", $3); print $3 } }' "$lockfile" | sort -u)
[[ -n $version ]] || fail "no v8 package in $lockfile"
[[ $version != *$'\n'* ]] || fail "more than one v8 version in $lockfile: ${version//$'\n'/, }"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "unexpected v8 version: $version"

manifest=$codex_dir/third_party/v8/rusty_v8_${version//./_}_release_manifests.sha256
[[ -f $manifest ]] || fail "missing pinned checksum manifest $manifest"

profile=ptrcomp_sandbox_release
case $target in
  *-pc-windows-msvc) archive_name=rusty_v8_${profile}_${target}.lib.gz ;;
  *) archive_name=librusty_v8_${profile}_${target}.a.gz ;;
esac
binding_name=src_binding_${profile}_${target}.rs
checksums_name=rusty_v8_${profile}_${target}.sha256
base_url=https://github.com/openai/codex/releases/download/rusty-v8-v${version}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Prints the checksum listed for file name $1 in checksum file $2 (CRLF tolerated).
listed_checksum() {
  awk -v name="$1" '{ sub(/\r$/, "") } $2 == name || $2 == "*" name { print $1 }' "$2"
}

# Resolve the pinned checksum before downloading anything, so an unsupported target fails fast.
pinned=$(listed_checksum "$checksums_name" "$manifest")
[[ -n $pinned ]] || fail "$manifest pins no checksum for $checksums_name"

mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
work_dir=$(mktemp -d "$output_dir/.fetch.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT

download() {
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 \
    "$base_url/$1" --output "$work_dir/$1"
}

download "$checksums_name"
actual=$(sha256_of "$work_dir/$checksums_name")
[[ $actual == "$pinned" ]] || fail "checksum mismatch for $checksums_name: expected $pinned, got $actual"
[[ $(grep -c . "$work_dir/$checksums_name") -eq 2 ]] || fail "$checksums_name must list exactly two files"

for name in "$archive_name" "$binding_name"; do
  download "$name"
  expected=$(listed_checksum "$name" "$work_dir/$checksums_name")
  [[ -n $expected ]] || fail "$checksums_name lists no checksum for $name"
  actual=$(sha256_of "$work_dir/$name")
  [[ $actual == "$expected" ]] || fail "checksum mismatch for $name: expected $expected, got $actual"
done

mv -f -- "$work_dir/$archive_name" "$output_dir/rusty_v8_archive"
mv -f -- "$work_dir/$binding_name" "$output_dir/src_binding.rs"
printf 'RUSTY_V8_ARCHIVE=%s\n' "$output_dir/rusty_v8_archive"
printf 'RUSTY_V8_SRC_BINDING_PATH=%s\n' "$output_dir/src_binding.rs"
