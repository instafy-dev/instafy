import assert from "node:assert/strict";
import test from "node:test";

import {
  JOURNAL_ARTIFACT_NAME,
  RELEASE_WORKFLOW_PATH,
  isTrustedHeadBranch,
  selectTrustedJournalArtifact,
} from "./recovery-journals.mjs";

const REPO_ID = 1000;
const FORK_ID = 2000;

function artifact(id, { created, branch = "main", repo = REPO_ID, head = REPO_ID, runId = id * 10, sha = "a".repeat(40), expired = false, name = JOURNAL_ARTIFACT_NAME } = {}) {
  return {
    id,
    name,
    expired,
    created_at: created,
    workflow_run: { id: runId, repository_id: repo, head_repository_id: head, head_branch: branch, head_sha: sha },
  };
}

function run(item, overrides = {}) {
  return {
    id: item.workflow_run.id,
    path: RELEASE_WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_branch: item.workflow_run.head_branch,
    head_sha: item.workflow_run.head_sha,
    repository: { id: REPO_ID },
    head_repository: { id: REPO_ID },
    ...overrides,
  };
}

function select(artifacts, runOverrides = {}) {
  const warnings = [];
  const fetched = [];
  const id = selectTrustedJournalArtifact({
    artifacts,
    repositoryId: String(REPO_ID),
    fetchRun: (runId) => {
      fetched.push(runId);
      const item = artifacts.find((candidate) => candidate.workflow_run?.id === runId);
      return run(item, runOverrides[item.id] ?? {});
    },
    warn: (message) => warnings.push(message),
  });
  return { id, warnings, fetched };
}

test("trusted head branches are main and exact release tags only", () => {
  assert.equal(isTrustedHeadBranch("main"), true);
  assert.equal(isTrustedHeadBranch("desktop-app-v0.2.13"), true);
  for (const branch of ["desktop-app-v0.2", "desktop-app-v01.2.3", "feature", "main2", "refs/heads/main", "", null, undefined]) {
    assert.equal(isTrustedHeadBranch(branch), false, String(branch));
  }
});

test("the newest trusted journal wins", () => {
  const artifacts = [
    artifact(1, { created: "2026-09-01T00:00:00Z" }),
    artifact(2, { created: "2026-09-03T00:00:00Z", branch: "desktop-app-v0.2.14" }),
  ];
  assert.equal(select(artifacts).id, 2);
});

test("a newer fork, branch or other-workflow upload cannot shadow the real journals", () => {
  const trusted = artifact(1, { created: "2026-09-01T00:00:00Z" });
  const fork = artifact(2, { created: "2026-09-05T00:00:00Z", head: FORK_ID });
  const branch = artifact(3, { created: "2026-09-06T00:00:00Z", branch: "attacker-branch" });
  const otherWorkflow = artifact(4, { created: "2026-09-07T00:00:00Z" });
  const pullRequest = artifact(5, { created: "2026-09-08T00:00:00Z" });
  const forkRun = artifact(6, { created: "2026-09-09T00:00:00Z" });
  const shaMismatch = artifact(7, { created: "2026-09-10T00:00:00Z" });
  const expired = artifact(8, { created: "2026-09-11T00:00:00Z", expired: true });
  const result = select([trusted, fork, branch, otherWorkflow, pullRequest, forkRun, shaMismatch, expired], {
    4: { path: ".github/workflows/build.yml" },
    5: { event: "pull_request" },
    6: { head_repository: { id: FORK_ID } },
    7: { head_sha: "b".repeat(40) },
  });
  assert.equal(result.id, 1);
  assert.deepEqual(result.fetched, [70, 60, 50, 40, 10]);
  assert.equal(result.warnings.length, 6);
});

test("nothing is restored when no journal is trusted", () => {
  const artifacts = [
    artifact(1, { created: "2026-09-01T00:00:00Z", repo: FORK_ID, head: FORK_ID }),
    artifact(2, { created: "2026-09-02T00:00:00Z", name: "other" }),
  ];
  assert.equal(select(artifacts).id, null);
  assert.equal(select([]).id, null);
});

test("malformed input fails closed", () => {
  assert.throws(() => selectTrustedJournalArtifact({ artifacts: undefined, repositoryId: "1", fetchRun: () => null }), /malformed/u);
  assert.throws(() => selectTrustedJournalArtifact({ artifacts: [], repositoryId: "", fetchRun: () => null }), /repository id/u);
  const item = artifact(1, { created: "2026-09-01T00:00:00Z" });
  assert.equal(
    selectTrustedJournalArtifact({ artifacts: [item], repositoryId: String(REPO_ID), fetchRun: () => ({ id: 999 }) }),
    null,
  );
});
