import assert from "node:assert/strict";

// Test-only inverse of the merge-queue change; not runtime authority. That
// change added a merge_group (checks_requested) trigger to the three workflows
// that report main's required checks, keyed npm-release concurrency on the
// queued group, and ran the Changeset policy on the queued group's own diff
// with the queued pull request's identity from a separate lookup step. A later
// change gave Controller DB Tests the same trigger and replaced its pull
// request paths filter with a relevance job, so its check reports everywhere.
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
const npmCheckout = "      - name: Checkout the exact pull request commit\n";
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
  // Anchored to the checkout that follows it, so moving the lookup also fails.
  [npmLookupStep + npmCheckout, npmCheckout],
  [npmIdentityComment, ""],
  npmIdentity("HEAD_REF", "head_ref", "github.event.pull_request.head.ref"),
  npmIdentity("HEAD_REPOSITORY", "head_repository", "github.event.pull_request.head.repo.full_name"),
  npmIdentity("PULL_REQUEST_AUTHOR", "author", "github.event.pull_request.user.login"),
];

// Controller DB Tests reports on every pull request and merge group: the
// workflow-level paths filter became a hosted relevance job that the database
// job needs. These are the paths that filter listed, in its order.
export const CONTROLLER_DB_PATHS = [
  "packages/runtime-controller/**",
  "supabase/**",
  "scripts/test-controller.mjs",
  "scripts/check-database-ci-routing.test.mjs",
  "scripts/supabase-stack.mjs",
  "scripts/lib/localSupabaseEnv.mjs",
  "scripts/lib/supabaseStartMode.mjs",
  "scripts/lib/supabaseSerialPull.mjs",
  "scripts/lib/supabaseImageMirror.mjs",
  "scripts/lib/supabaseEmailTemplateMounts.mjs",
  ".github/workflows/controller-db-tests.yml",
];
const controllerEventSha = (field, payload) =>
  `\${{ github.event_name == 'merge_group' && github.event.merge_group.${field} || github.event.pull_request.${payload} }}`;
const controllerRelevanceJob = `  changes:
    # Every pull request and merge group runs this workflow, so the required
    # check below always reports. This hosted job only compares commits. It
    # gets no secrets, runs no checked-out code and keeps the workflow's
    # read-only contents permission.
    name: Controller database relevance
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      relevant: \${{ steps.decide.outputs.relevant }}

    steps:
      - name: Fetch history for the comparison
        if: github.event_name == 'pull_request' || github.event_name == 'merge_group'
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0
          filter: blob:none
          sparse-checkout: .github
          submodules: false
          persist-credentials: false
          ref: ${controllerEventSha("head_sha", "head.sha")}

      - name: Decide whether the database tests apply
        id: decide
        shell: bash
        env:
          BASE_SHA: ${controllerEventSha("base_sha", "base.sha")}
          HEAD_SHA: ${controllerEventSha("head_sha", "head.sha")}
        run: |
          set -euo pipefail
          # The paths the pull_request trigger filtered on before this job
          # existed. A pull request or merge group that changes none of them
          # skips the database tests; push and manual runs always run them.
          patterns=(
${CONTROLLER_DB_PATHS.map((pattern) => `            "${pattern}"\n`).join("")}          )
          if [[ "$GITHUB_EVENT_NAME" != pull_request && "$GITHUB_EVENT_NAME" != merge_group ]]; then
            echo "A \${GITHUB_EVENT_NAME} run always runs the database tests."
            echo "relevant=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          for commit in "$BASE_SHA" "$HEAD_SHA"; do
            if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]] || ! git cat-file -e "\${commit}^{commit}"; then
              echo "::error::Compared commit '\${commit}' is not available."
              exit 1
            fi
          done
          pathspecs=()
          for pattern in "\${patterns[@]}"; do
            pathspecs+=(":(glob)\${pattern}")
          done
          # Three dots compare the head with its merge base, as the paths
          # filter did for pull requests; a merge group's base is its parent.
          # Without rename detection both sides of a move are listed and no
          # file contents are needed.
          changed="$(git diff --name-only --no-renames "\${BASE_SHA}...\${HEAD_SHA}" -- "\${pathspecs[@]}")"
          if [[ -n "$changed" ]]; then
            printf 'The database tests apply. Changed paths:\\n%s\\n' "$changed"
            echo "relevant=true" >> "$GITHUB_OUTPUT"
          else
            echo "No listed path changed; the database tests are skipped."
            echo "relevant=false" >> "$GITHUB_OUTPUT"
          fi

`;
export const CONTROLLER_DB_GATE = "\${{ !(needs.changes.result == 'success' && needs.changes.outputs.relevant == 'false')"
  + " && (!cancelled() || needs.changes.result != 'success') }}";
const controllerDbNeeds = `    needs: changes
    # Skipped only after a successful decision that no listed path changed;
    # GitHub reports a job skipped by its if: as a passing required check.
    # A failed, cancelled or skipped decision still starts this job, and its
    # first step fails it. Cancelling the workflow still cancels a database
    # run that has started.
    if: ${CONTROLLER_DB_GATE}
`;
const controllerDbGuardStep = `      - name: Require a completed relevance decision
        if: always()
        shell: bash
        env:
          DECISION: \${{ needs.changes.result }}
          RELEVANT: \${{ needs.changes.outputs.relevant }}
        run: |
          if [[ "$DECISION" != success || "$RELEVANT" != true ]]; then
            echo "::error::The relevance decision ended with '\${DECISION}' (relevant: '\${RELEVANT}'); rerun the workflow."
            exit 1
          fi

`;
const controllerDbJob = "  controller-db-tests:\n    name: Controller database tests\n";
const controllerDbPreflight = "    steps:\n      - name: Qualify isolated database CI runner\n";
const controllerDb = [
  ["on:\n  pull_request:\n  push:\n    branches:\n      - main\n" + MERGE_GROUP_TRIGGER + "  workflow_dispatch:\n",
    "on:\n  pull_request:\n    paths:\n" + CONTROLLER_DB_PATHS.map((pattern) => `      - "${pattern}"\n`).join("")
      + "  push:\n    branches:\n      - main\n  workflow_dispatch:\n"],
  ["jobs:\n" + controllerRelevanceJob + controllerDbJob + controllerDbNeeds, "jobs:\n" + controllerDbJob],
  ["    steps:\n" + controllerDbGuardStep + controllerDbPreflight.slice("    steps:\n".length), controllerDbPreflight],
];
const inverses = {
  "build.yml": [["      - main\n" + MERGE_GROUP_TRIGGER + "  workflow_dispatch:\n", "      - main\n  workflow_dispatch:\n"]],
  "npm-release.yml": npm,
  "controller-db-tests.yml": controllerDb,
};

export function withoutMergeQueue(file, source) {
  for (const [added, previous] of inverses[file] ?? []) {
    assert.equal(source.split(added).length - 1, 1, `${file}: merge-queue span must occur exactly once: ${added.slice(0, 60)}`);
    source = source.replace(added, () => previous);
  }
  if (inverses[file]) assert.ok(!source.includes("merge_group"), `${file}: unreviewed merge_group reference`);
  return source;
}
