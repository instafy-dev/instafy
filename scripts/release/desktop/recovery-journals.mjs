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

export function runTrustReason(run, artifact, { repositoryId }) {
  if (!run || run.id !== artifact.workflow_run.id) return "run lookup mismatch";
  if (run.path !== RELEASE_WORKFLOW_PATH) return "not the Desktop release workflow";
  if (!TRUSTED_EVENTS.has(run.event)) return "untrusted event";
  if (!sameId(run.repository?.id, repositoryId)) return "different repository";
  if (!sameId(run.head_repository?.id, repositoryId)) return "head repository is not this repository";
  if (run.head_branch !== artifact.workflow_run.head_branch || !isTrustedHeadBranch(run.head_branch)) {
    return "untrusted head branch";
  }
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

function ghJson(route) {
  return JSON.parse(execFileSync("gh", ["api", route], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== "select") throw new Error("Usage: recovery-journals.mjs select");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is required.");
  const listing = ghJson(`repos/${repository}/actions/artifacts?name=${JOURNAL_ARTIFACT_NAME}&per_page=100`);
  const id = selectTrustedJournalArtifact({
    artifacts: listing?.artifacts,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    fetchRun: (runId) => ghJson(`repos/${repository}/actions/runs/${runId}`),
    warn: (message) => console.error(`::warning::${message}`),
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
