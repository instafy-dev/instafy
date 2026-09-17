import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  JOURNAL_ARTIFACT_NAME,
  RELEASE_WORKFLOW_PATH,
  findTrustedJournalArtifact,
  isTrustedHeadBranch,
  selectTrustedJournalArtifact,
  workflowRunsRoute,
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

test("a flood of name-matched uploads cannot push the trusted journals out of view", () => {
  // Candidates come from this workflow's own runs, so untrusted uploads never
  // enter the listing, however many there are.
  const trustedArtifact = artifact(1, { created: "2026-09-01T00:00:00Z" });
  const trustedRun = run(trustedArtifact, { created_at: "2026-09-01T00:00:00Z", event: "push", head_branch: "main" });
  const untrustedRuns = Array.from({ length: 150 }, (_, index) =>
    run(artifact(100 + index, { created: "2026-09-10T00:00:00Z" }), {
      created_at: `2026-09-10T00:${String(index % 60).padStart(2, "0")}:00Z`,
      event: "pull_request",
    }),
  );
  const listed = [];
  const warnings = [];
  const id = findTrustedJournalArtifact({
    listRuns: () => [...untrustedRuns, trustedRun],
    listRunArtifacts: (runId) => {
      listed.push(runId);
      return runId === trustedRun.id ? [trustedArtifact] : [];
    },
    repositoryId: String(REPO_ID),
    warn: (message) => warnings.push(message),
  });
  assert.equal(id, 1);
  assert.deepEqual(listed, [trustedRun.id]);
  assert.equal(warnings.length, 150);
});

test("the newest trusted run with a journal wins, and runs without one are skipped", () => {
  const older = artifact(1, { created: "2026-09-01T00:00:00Z" });
  const newerWithout = artifact(2, { created: "2026-09-05T00:00:00Z", branch: "desktop-app-v0.2.14" });
  const runs = [
    run(older, { created_at: "2026-09-01T00:00:00Z" }),
    run(newerWithout, { created_at: "2026-09-05T00:00:00Z" }),
  ];
  const id = findTrustedJournalArtifact({
    listRuns: () => runs,
    listRunArtifacts: (runId) => (runId === older.workflow_run.id ? [older] : []),
    repositoryId: String(REPO_ID),
  });
  assert.equal(id, 1);
  assert.equal(
    findTrustedJournalArtifact({ listRuns: () => [], listRunArtifacts: () => [], repositoryId: String(REPO_ID) }),
    null,
  );
  assert.throws(
    () => findTrustedJournalArtifact({ listRuns: () => undefined, listRunArtifacts: () => [], repositoryId: String(REPO_ID) }),
    /malformed/u,
  );
});

test("the CLI lists this workflow's runs, never the repository-wide artifact listing", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "recovery-journals.mjs"), "utf8");
  assert.doesNotMatch(source, /actions\/artifacts\?name=/u);
  assert.equal(
    workflowRunsRoute("owner/repo", "push", 2, new Date("2026-09-17T12:00:00Z")),
    "repos/owner/repo/actions/workflows/desktop-release.yml/runs?event=push&created=%3E%3D2026-08-17&per_page=100&page=2",
  );
});
