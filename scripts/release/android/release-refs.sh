#!/usr/bin/env bash
# Re-proves the exact-source and one-shot invariants immediately before a
# mutable write (Google Play commit, GitHub Release creation).
#
# usage: release-refs.sh recheck <tag> <source-sha>
#   * the tag still resolves (peeled) to <source-sha>;
#   * protected main still contains <source-sha> (compare status identical|ahead);
#   * no GitHub Release exists for <tag> yet (the release is the one-shot marker),
#     including a draft left by an interrupted gh release create (drafts are
#     invisible to releases/tags/<tag>; only a contents: write token lists them).
# Requires GH_TOKEN. Prints no token and no response bodies.
set -euo pipefail

repository="instafy-dev/instafy"

fail() {
  # stderr: also readable by the runner, and never captured by $(peel_tag ...).
  echo "::error::$*" >&2
  exit 1
}

peel_tag() {
  local tag="$1" err_file resolved object_type object_sha
  err_file="$(mktemp)"
  if ! resolved="$(gh api "repos/${repository}/git/ref/tags/${tag}" --jq '.object.type + " " + .object.sha' 2>"$err_file")"; then
    if grep -q 'HTTP 404' "$err_file"; then
      echo absent
      return 0
    fi
    fail "Could not resolve tag ${tag}."
  fi
  object_type="${resolved%% *}"
  object_sha="${resolved#* }"
  if [[ "$object_type" == "tag" ]]; then
    resolved="$(gh api "repos/${repository}/git/tags/${object_sha}" --jq '.object.type + " " + .object.sha')" ||
      fail "Could not peel annotated tag ${tag}."
    object_type="${resolved%% *}"
    object_sha="${resolved#* }"
  fi
  [[ "$object_type" == "commit" && "$object_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail "Tag ${tag} does not peel to a commit."
  echo "$object_sha"
}

recheck() {
  local tag="$1" source_sha="$2" peeled status err_file
  [[ "$tag" =~ ^android-v([0-9A-Za-z][0-9A-Za-z._-]{0,63})-([1-9][0-9]{0,9})$ ]] || fail "Invalid Android release tag."
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid source sha."
  peeled="$(peel_tag "$tag")"
  [[ "$peeled" == "$source_sha" ]] || fail "Tag ${tag} no longer resolves to ${source_sha} (now: ${peeled})."
  status="$(gh api "repos/${repository}/compare/${source_sha}...main" --jq .status)" ||
    fail "Could not compare ${source_sha} with protected main."
  case "$status" in
    identical | ahead) ;;
    *) fail "Protected main no longer contains ${source_sha} (compare status: ${status})." ;;
  esac
  err_file="$(mktemp)"
  if gh api "repos/${repository}/releases/tags/${tag}" --jq .id >/dev/null 2>"$err_file"; then
    fail "A GitHub Release for ${tag} already exists; this tag was already published."
  fi
  grep -q 'HTTP 404' "$err_file" || fail "Could not prove that no GitHub Release exists for ${tag}."
  drafts="$(gh api "repos/${repository}/releases?per_page=100" --paginate --jq '.[] | select(.draft) | .tag_name')" ||
    fail "Could not list draft releases for ${tag}."
  if grep -Fxq -- "$tag" <<< "$drafts"; then
    fail "A draft GitHub Release for ${tag} exists (interrupted publication); delete the draft, then re-run."
  fi
  echo "[android-release] ${tag} -> ${source_sha} on main (${status}); no GitHub Release yet."
}

case "${1:-}" in
  recheck)
    [[ $# -eq 3 ]] || fail "usage: release-refs.sh recheck <tag> <source-sha>"
    recheck "$2" "$3"
    ;;
  peel)
    [[ $# -eq 2 ]] || fail "usage: release-refs.sh peel <tag>"
    peel_tag "$2"
    ;;
  *)
    fail "usage: release-refs.sh recheck <tag> <source-sha> | peel <tag>"
    ;;
esac
