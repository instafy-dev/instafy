#!/usr/bin/env node
// Chooses the Personal Browser recovery-journal artifact the canary may restore.
//
// Artifact names are not trusted in a public repository: any workflow run,
// including an approved fork pull_request run or a branch workflow, can upload
// an artifact called personal-browser-recovery-journals. The canary acts on
// restored journals with the production service-role key, so only journals
// exported by this workflow, from this repository, on main or a release tag are
// eligible. Anything else is ignored; if nothing qualifies, nothing is restored.
//
// Candidates are enumerated from this workflow's own push and dispatch runs
// (which only writers can start), newest first, and then each run's artifacts.
// The repository-wide artifact listing by name is never used: untrusted uploads
// could flood it and push the trusted journals off the listed page.
//
// Usage (in the canary job):
//   node recovery-journals.mjs select
// env: GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GH_TOKEN. Prints the artifact id
// or nothing.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const JOURNAL_ARTIFACT_NAME = "personal-browser-recovery-journals";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/desktop-release.yml";
const TRUSTED_EVENTS = new Set(["push", "workflow_dispatch"]);
const RELEASE_TAG = /^desktop-app-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function isTrustedHeadBranch(branch) {
  return branch === "main" || RELEASE_TAG.test(branch ?? "");
}

function sameId(value, repositoryId) {
  return value !== undefined && value !== null && String(value) === String(repositoryId);
}

export function artifactCandidateReason(artifact, { repositoryId }) {
  if (artifact?.name !== JOURNAL_ARTIFACT_NAME) return "wrong artifact name";
  if (artifact.expired !== false) return "expired";
  const run = artifact.workflow_run;
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0) return "no workflow run";
  if (!sameId(run.repository_id, repositoryId)) return "different repository";
  if (!sameId(run.head_repository_id, repositoryId)) return "head repository is not this repository";
  if (!isTrustedHeadBranch(run.head_branch)) return "untrusted head branch";
  return null;
}

export function workflowRunTrustReason(run, { repositoryId }) {
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0) return "no workflow run";
  if (run.path !== RELEASE_WORKFLOW_PATH) return "not the Desktop release workflow";
  if (!TRUSTED_EVENTS.has(run.event)) return "untrusted event";
  if (!sameId(run.repository?.id, repositoryId)) return "different repository";
  if (!sameId(run.head_repository?.id, repositoryId)) return "head repository is not this repository";
  if (!isTrustedHeadBranch(run.head_branch)) return "untrusted head branch";
  return null;
}

export function runTrustReason(run, artifact, { repositoryId }) {
  if (!run || run.id !== artifact.workflow_run.id) return "run lookup mismatch";
  const reason = workflowRunTrustReason(run, { repositoryId });
  if (reason) return reason;
  if (run.head_branch !== artifact.workflow_run.head_branch) return "untrusted head branch";
  if (run.head_sha !== artifact.workflow_run.head_sha) return "head commit mismatch";
  return null;
}

export function selectTrustedJournalArtifact({ artifacts, repositoryId, fetchRun, warn = () => {} }) {
  if (!Array.isArray(artifacts)) throw new Error("The artifact listing is malformed.");
  if (!/^[1-9]\d*$/u.test(String(repositoryId ?? ""))) throw new Error("A repository id is required.");
  const ordered = [...artifacts].sort((left, right) =>
    String(right?.created_at ?? "").localeCompare(String(left?.created_at ?? "")),
  );
  for (const artifact of ordered) {
    const candidateReason = artifactCandidateReason(artifact, { repositoryId });
    if (candidateReason) {
      if (candidateReason !== "expired") warn(`Ignoring journal artifact ${artifact?.id}: ${candidateReason}.`);
      continue;
    }
    const runReason = runTrustReason(fetchRun(artifact.workflow_run.id), artifact, { repositoryId });
    if (runReason) {
      warn(`Ignoring journal artifact ${artifact.id}: ${runReason}.`);
      continue;
    }
    return artifact.id;
  }
  return null;
}

// Walks trusted runs newest first and returns the newest trusted journal
// artifact id, or null. listRuns() returns this workflow's candidate runs;
// listRunArtifacts(runId) returns that run's artifacts.
export function findTrustedJournalArtifact({ listRuns, listRunArtifacts, repositoryId, warn = () => {} }) {
  const runs = listRuns();
  if (!Array.isArray(runs)) throw new Error("The workflow run listing is malformed.");
  const ordered = [...runs].sort((left, right) =>
    String(right?.created_at ?? "").localeCompare(String(left?.created_at ?? "")),
  );
  for (const run of ordered) {
    const reason = workflowRunTrustReason(run, { repositoryId });
    if (reason) {
      warn(`Ignoring workflow run ${run?.id}: ${reason}.`);
      continue;
    }
    const id = selectTrustedJournalArtifact({
      artifacts: listRunArtifacts(run.id),
      repositoryId,
      fetchRun: (runId) => (runId === run.id ? run : null),
      warn,
    });
    if (id !== null) return id;
  }
  return null;
}

// Journal artifacts are retained 30 days; one extra day absorbs clock skew.
export const JOURNAL_LOOKBACK_DAYS = 31;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function workflowRunsRoute(repository, event, page, now = new Date()) {
  const since = new Date(now.getTime() - JOURNAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const workflow = RELEASE_WORKFLOW_PATH.split("/").at(-1);
  return `repos/${repository}/actions/workflows/${workflow}/runs?event=${event}&created=%3E%3D${since}&per_page=${PAGE_SIZE}&page=${page}`;
}

function ghJson(route) {
  return JSON.parse(execFileSync("gh", ["api", route], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== "select") throw new Error("Usage: recovery-journals.mjs select");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is required.");
  const warn = (message) => console.error(`::warning::${message}`);
  const listRuns = () => {
    const runs = [];
    for (const event of TRUSTED_EVENTS) {
      for (let page = 1; ; page += 1) {
        const batch = ghJson(workflowRunsRoute(repository, event, page))?.workflow_runs;
        if (!Array.isArray(batch)) throw new Error("The workflow run listing is malformed.");
        runs.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) {
          warn(`Stopped listing ${event} runs after ${MAX_PAGES} pages.`);
          break;
        }
      }
    }
    return runs;
  };
  const id = findTrustedJournalArtifact({
    listRuns,
    listRunArtifacts: (runId) =>
      ghJson(`repos/${repository}/actions/runs/${runId}/artifacts?name=${JOURNAL_ARTIFACT_NAME}&per_page=${PAGE_SIZE}`)?.artifacts,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    warn,
  });
  if (id !== null) process.stdout.write(`${id}\n`);
}

function isEntryPoint(argvPath) {
  try {
    return Boolean(argvPath) && realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "Journal selection failed"}`);
    process.exitCode = 1;
  }
}
