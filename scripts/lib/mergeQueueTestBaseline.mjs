import assert from "node:assert/strict";

// Test-only inverse of the merge-queue change; not runtime authority. That
// change added a merge_group (checks_requested) trigger to the three workflows
// that report main's required checks, keyed npm-release concurrency on the
// queued group, and ran the Changeset policy on the queued group's own diff
// with the queued pull request's identity from a separate lookup step.
// Whole-workflow baselines reviewed before the change are still checked through
// this inverse; every rewritten span must occur exactly once.
export const MERGE_GROUP_TRIGGER = "  merge_group:\n    types:\n      - checks_requested\n";

// The queued pull request's identity lookup is its own step, before the
// checkout, and the only one with the token; the policy step reads its outputs.
const npmLookupStep = `      - name: Read the queued pull request identity
        id: queued
        if: \${{ github.event_name == 'merge_group' }}
        shell: bash
        env:
          # The only step whose env carries the token. It runs before the
          # checkout and calls only the runner image's gh, so no checked-out
          # code runs with it.
          GH_TOKEN: \${{ github.token }}
          MERGE_GROUP_BASE_REF: \${{ github.event.merge_group.base_ref }}
          MERGE_GROUP_HEAD_REF: \${{ github.event.merge_group.head_ref }}
        run: |
          set -euo pipefail
          # A queued group is checked as its own diff over the group's parent
          # (main plus any earlier queued group), with the identity of the pull
          # request the queue names in the group ref. Any ref suffix is
          # accepted; only the pr-<number> component this lookup needs is
          # required.
          if [[ "$MERGE_GROUP_BASE_REF" != "refs/heads/main" ]]; then
            echo "::error::Merge group base \${MERGE_GROUP_BASE_REF} is not refs/heads/main."
            exit 1
          fi
          if [[ ! "$MERGE_GROUP_HEAD_REF" =~ ^refs/heads/gh-readonly-queue/main/pr-([1-9][0-9]*)(-[A-Za-z0-9._/-]*)?$ ]]; then
            echo "::error::Merge group ref \${MERGE_GROUP_HEAD_REF} names no queued pull request."
            exit 1
          fi
          pull_request="\${BASH_REMATCH[1]}"
          identity="$(
            gh api "repos/\${GITHUB_REPOSITORY}/pulls/\${pull_request}" \\
              --jq '[.head.ref, (.head.repo.full_name // ""), .user.login] | join("\\u001f")'
          )"
          IFS=$'\\x1f' read -r head_ref head_repository author <<< "$identity"
          {
            printf 'head_ref=%s\\n' "$head_ref"
            printf 'head_repository=%s\\n' "$head_repository"
            printf 'author=%s\\n' "$author"
          } >> "$GITHUB_OUTPUT"

`;
const npmIdentityComment = [
  "          # A merge group takes the queued pull request's identity from the\n",
  "          # lookup step's outputs; this step and the checked-out code it runs\n",
  "          # get no token variable.\n",
].join("");
const npmIdentity = (name, output, payload) => [
  `          ${name}: \${{ github.event_name == 'merge_group' && steps.queued.outputs.${output} || ${payload} }}\n`,
  `          ${name}: \${{ ${payload} }}\n`,
];
const npm = [
  ["  - main\n" + MERGE_GROUP_TRIGGER + "  workflow_dispatch:\n", "  - main\n  workflow_dispatch:\n"],
  ["github.event.pull_request.number || github.event_name == 'merge_group' && github.event.merge_group.head_ref || 'main' }}",
    "github.event.pull_request.number || 'main' }}"],
  ["    if: ${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}\n", "    if: ${{ github.event_name == 'pull_request' }}\n"],
  ["      contents: read\n      pull-requests: read\n\n    steps:\n      - name: Qualify isolated expanded CI runner\n",
    "      contents: read\n\n    steps:\n      - name: Qualify isolated expanded CI runner\n"],
  ["          ref: ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}\n",
    "          ref: ${{ github.event.pull_request.head.sha }}\n"],
  ["          BASE_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}\n",
    "          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n"],
  ["          HEAD_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}\n",
    "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n"],
  [npmLookupStep, ""],
  [npmIdentityComment, ""],
  npmIdentity("HEAD_REF", "head_ref", "github.event.pull_request.head.ref"),
  npmIdentity("HEAD_REPOSITORY", "head_repository", "github.event.pull_request.head.repo.full_name"),
  npmIdentity("PULL_REQUEST_AUTHOR", "author", "github.event.pull_request.user.login"),
];
const inverses = {
  "build.yml": [["      - main\n" + MERGE_GROUP_TRIGGER + "  workflow_dispatch:\n", "      - main\n  workflow_dispatch:\n"]],
  "npm-release.yml": npm,
};

export function withoutMergeQueue(file, source) {
  for (const [added, previous] of inverses[file] ?? []) {
    assert.equal(source.split(added).length - 1, 1, `${file}: merge-queue span must occur exactly once: ${added.slice(0, 60)}`);
    source = source.replace(added, () => previous);
  }
  if (inverses[file]) assert.ok(!source.includes("merge_group"), `${file}: unreviewed merge_group reference`);
  return source;
}
