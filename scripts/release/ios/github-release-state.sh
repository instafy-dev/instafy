#!/usr/bin/env bash
# Snapshot the GitHub state that authorizes (or blocks) an iOS publication:
# the tag ref (+ annotated tag object), compare <commit>...<refs/heads/main sha>, and whether a
# GitHub Release already exists. Read-only; bash 3.2 compatible.
#
# usage: github-release-state.sh <tag> <commit-to-compare> <out-dir>
# env:   GH_TOKEN, GITHUB_REPOSITORY
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: github-release-state.sh <tag> <commit> <out-dir>" >&2
  exit 2
fi
tag="$1"
commit="$2"
out="$3"
repo="${GITHUB_REPOSITORY:?}"

case "$tag" in
  ios-v*) ;;
  *) echo "::error::Unexpected release tag." >&2; exit 1 ;;
esac
if ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "::error::Compare commit must be a full lowercase SHA." >&2
  exit 1
fi

mkdir -p "$out"
rm -f "$out/tag-ref.json" "$out/tag-object.json" "$out/compare-status.txt" "$out/release-state.txt"

# api_get <path> <file>: prints present|absent; any non-404 failure is fatal.
api_get() {
  if gh api "$1" > "$2" 2> "$2.err"; then
    rm -f "$2.err"
    echo present
    return 0
  fi
  if grep -q 'HTTP 404' "$2.err"; then
    rm -f "$2" "$2.err"
    echo absent
    return 0
  fi
  echo "::error::GitHub API read failed for $1" >&2
  cat "$2.err" >&2
  rm -f "$2" "$2.err"
  return 1
}

ref_state="$(api_get "repos/$repo/git/ref/tags/$tag" "$out/tag-ref.json")"
if [ "$ref_state" = "present" ]; then
  object_type="$(jq -r '.object.type' "$out/tag-ref.json")"
  if [ "$object_type" = "tag" ]; then
    object_sha="$(jq -r '.object.sha' "$out/tag-ref.json")"
    if ! printf '%s' "$object_sha" | grep -Eq '^[0-9a-f]{40}$'; then
      echo "::error::Annotated tag object id is invalid." >&2
      exit 1
    fi
    gh api "repos/$repo/git/tags/$object_sha" > "$out/tag-object.json"
  fi
fi

# Compare against the resolved refs/heads/main commit, never the bare name "main" (a tag could shadow it).
main_sha="$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)"
if ! printf '%s' "$main_sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "::error::Protected main does not resolve." >&2
  exit 1
fi
gh api "repos/$repo/compare/${commit}...${main_sha}" --jq .status > "$out/compare-status.txt"
api_get "repos/$repo/releases/tags/$tag" "$out/release.json" > "$out/release-state.txt"
rm -f "$out/release.json"
echo "tag=$ref_state compare=$(cat "$out/compare-status.txt") release=$(cat "$out/release-state.txt")"
