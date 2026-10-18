#!/bin/sh
# Makes cargo's mtime-based freshness check content-based for the path crates
# built in docker/runtime/Dockerfile.
#
# The builders compile into a target/ cache mount that outlives any one build
# and is shared by every checkout that builds this Dockerfile on the same
# daemon. Cargo decides whether a path crate is fresh by comparing source
# mtimes with its last build, and BuildKit's COPY keeps the checkout's mtimes,
# so on its own a shared target/ goes wrong both ways: a fresh worktree with
# identical sources (all files newer) recompiles everything, and switching to
# a checkout whose changed files are older than the last build would reuse
# artifacts compiled from other sources.
#
#   cargo-source-stamps prepare <target-dir> <source-dir>...
#     Sets every source file to one fixed old mtime, then gives each file whose
#     content differs from what target/ was last built from (every file if
#     that is unknown) an mtime newer than anything cargo recorded in target/,
#     so cargo rebuilds exactly those.
#   cargo-source-stamps commit <target-dir>
#     Records the prepared sources as what target/ now holds and sets the
#     files prepare touched back to the old mtime. Run it only after
#     cargo succeeded: until then each prepared state stays pending and its
#     files keep counting as changed, so a failed build cannot leave artifacts
#     that a later build of other content mistakes for fresh.
set -eu

command=${1:?usage: cargo-source-stamps prepare|commit <target-dir> [source-dir...]}
target=${2:?missing target dir}
shift 2
state="$target/.instafy-source-stamps"
# 2000-01-01T00:00:00Z: older than any build, and constant so unchanged files
# are never newer than the artifacts compiled from them.
epoch=946684800

case "$command" in
prepare)
  [ "$#" -gt 0 ] || { echo "cargo-source-stamps: no source dirs" >&2; exit 2; }
  mkdir -p "$state/pending"
  rm -f "$state/current"
  # Only files not already at the epoch are touched, so a layer that already
  # holds normalized sources is not copied up again.
  find "$@" -path "$target" -prune -o -type f -newermt "@$epoch" -exec touch -m -d "@$epoch" {} +
  find "$@" -path "$target" -prune -o -type f -print0 | sort -z | xargs -0 -r sha256sum > "$state/current.new"
  # sha256sum escapes a name holding a backslash or newline and starts its
  # line with "\\", which the path extraction below would get wrong and so
  # miss the change. No source has such a name; refuse rather than guess.
  if grep -q '^\\' "$state/current.new"; then
    echo "cargo-source-stamps: unsupported source file names (backslash or newline):" >&2
    grep '^\\' "$state/current.new" >&2
    rm -f "$state/current.new"
    exit 1
  fi
  if [ -f "$state/committed" ]; then
    manifests=$(find "$state/committed" "$state/pending" -maxdepth 1 -type f | wc -l)
    # A file is unchanged only if its exact "hash  path" line is in the
    # committed manifest and in every pending one.
    find "$state/committed" "$state/pending" -maxdepth 1 -type f -exec cat {} + \
      | sort | uniq -c \
      | awk -v n="$manifests" '$1 == n { sub(/^ *[0-9]+ /, ""); print }' > "$state/unchanged"
    sort "$state/current.new" > "$state/current.sorted"
    comm -23 "$state/current.sorted" "$state/unchanged" > "$state/changed"
    rm -f "$state/current.sorted" "$state/unchanged"
  else
    cp "$state/current.new" "$state/changed"
  fi
  # sha256sum prints "<64 hex>  <path>".
  cut -c67- "$state/changed" > "$state/touched"
  # Changed files must be newer than the fingerprints cargo compares them
  # with. The current time usually is, but not if the clock stepped back
  # since the last build (a VM resyncing after sleep), so take one second past
  # the newest fingerprint whenever that is later.
  stamp=$(date +%s)
  newest=$(find "$target" -maxdepth 5 -path '*/.fingerprint/*' -printf '%T@\n' 2>/dev/null | sort -n | tail -n 1)
  newest=${newest%%.*}
  if [ -n "$newest" ] && [ "$newest" -ge "$stamp" ]; then stamp=$((newest + 1)); fi
  tr '\n' '\0' < "$state/touched" | xargs -0 -r touch -c -m -d "@$stamp" --
  echo "cargo-source-stamps: $(wc -l < "$state/changed") of $(wc -l < "$state/current.new") source files changed since target/ was built"
  cp "$state/current.new" "$state/pending/$(date +%s%N)"
  mv "$state/current.new" "$state/current"
  rm -f "$state/changed"
  ;;
commit)
  [ -f "$state/current" ] || { echo "cargo-source-stamps: nothing prepared" >&2; exit 2; }
  mv "$state/current" "$state/committed"
  rm -rf "$state/pending"
  # The rebuilt files are fresh now; back to the epoch with them, so the next
  # stage's prepare finds nothing to normalize and copies no file up again.
  if [ -f "$state/touched" ]; then
    tr '\n' '\0' < "$state/touched" | xargs -0 -r touch -c -m -d "@$epoch" --
    rm -f "$state/touched"
  fi
  ;;
*)
  echo "cargo-source-stamps: unknown command $command" >&2
  exit 2
  ;;
esac
