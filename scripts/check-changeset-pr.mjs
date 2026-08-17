#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGES = new Map([
  ["@instafy/cli", "packages/instafy-cli"],
  ["@instafy/provider-contract", "packages/provider-contract"],
]);
const BUMP_RANK = new Map([
  ["patch", 1],
  ["minor", 2],
  ["major", 3],
]);
function fail(message) {
  throw new Error(`[changeset-policy] ${message}`);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function readAt(ref, file) {
  return git(["show", `${ref}:${file}`]);
}

function parseDiff(base, head) {
  const tokens = git(["diff", "--name-status", "-z", `${base}...${head}`]).split("\0");
  const changes = [];
  for (let index = 0; index < tokens.length && tokens[index]; ) {
    const status = tokens[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ status, oldPath: tokens[index++], path: tokens[index++] });
    } else {
      changes.push({ status, path: tokens[index++] });
    }
  }
  return changes;
}

function packageManifest(ref, directory) {
  return JSON.parse(readAt(ref, `${directory}/package.json`));
}

export function isReleaseRelevantPath(filePath) {
  for (const directory of PACKAGES.values()) {
    if (filePath === directory || filePath.startsWith(`${directory}/`)) {
      return !filePath.startsWith(`${directory}/test/`);
    }
  }
  return false;
}

function bumpVersion(version, bump) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) fail(`cannot bump non-stable version ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`unsupported bump ${JSON.stringify(bump)}`);
}

export function parseChangesetReleases(source) {
  const parts = source.split(/^---\s*$/mu);
  if (parts.length < 3) fail("changeset is missing YAML frontmatter delimiters");
  const releases = [];
  for (const line of parts[1].split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = /^"([^"]+)":\s*(patch|minor|major)\s*$/u.exec(line);
    if (!match) fail(`unsupported changeset frontmatter line ${JSON.stringify(line)}`);
    releases.push({ name: match[1], bump: match[2] });
  }
  if (parts.slice(2).join("---").trim().length === 0) fail("changeset summary must not be empty");
  return releases;
}

export function combineReleaseBumps(changesets) {
  const combined = new Map();
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (!PACKAGES.has(release.name)) fail(`changeset targets unapproved package ${release.name}`);
      const previous = combined.get(release.name);
      if (!previous || BUMP_RANK.get(release.bump) > BUMP_RANK.get(previous)) {
        combined.set(release.name, release.bump);
      }
    }
  }
  return combined;
}

function pendingChangesets(ref) {
  const files = git(["ls-tree", "-r", "--name-only", ref, ".changeset"])
    .split(/\r?\n/u)
    .filter((file) => /^\.changeset\/[^/]+\.md$/u.test(file) && file !== ".changeset/README.md");
  return files.map((file) => ({ file, releases: parseChangesetReleases(readAt(ref, file)) }));
}

function verifyGeneratedVersionPullRequest(base, head) {
  const changesets = pendingChangesets(base);
  if (changesets.length === 0) fail("version pull request base has no pending changesets");
  const bumps = combineReleaseBumps(changesets);
  if (bumps.size === 0) fail("version pull request has no package releases");

  const expected = new Map();
  for (const changeset of changesets) expected.set(changeset.file, "D");
  for (const [name] of bumps) {
    const directory = PACKAGES.get(name);
    expected.set(`${directory}/package.json`, "M");
    expected.set(`${directory}/CHANGELOG.md`, "A_OR_M");
  }

  const actual = parseDiff(base, head);
  if (actual.length !== expected.size) fail("version pull request contains unexpected generated paths");
  for (const change of actual) {
    if (change.oldPath) fail("version pull request must not rename or copy files");
    const expectedStatus = expected.get(change.path);
    if (!expectedStatus) fail(`version pull request changes non-generated path ${change.path}`);
    if (expectedStatus === "A_OR_M") {
      if (change.status !== "A" && change.status !== "M") fail(`${change.path} must be added or modified`);
    } else if (change.status !== expectedStatus) {
      fail(`${change.path} must have Git status ${expectedStatus}`);
    }
  }

  for (const [name, bump] of bumps) {
    const directory = PACKAGES.get(name);
    const baseManifest = packageManifest(base, directory);
    const headManifest = packageManifest(head, directory);
    const expectedVersion = bumpVersion(baseManifest.version, bump);
    if (headManifest.version !== expectedVersion) {
      fail(`${name} version must be generated as ${expectedVersion}, got ${headManifest.version}`);
    }
    const changelog = readAt(head, `${directory}/CHANGELOG.md`);
    if (!new RegExp(`^## ${expectedVersion.replaceAll(".", "\\.")}\\s*$`, "mu").test(changelog)) {
      fail(`${name} changelog is missing the generated ${expectedVersion} heading`);
    }
  }
}

function verifyOrdinaryPullRequest(base, head) {
  const changes = parseDiff(base, head);
  for (const [, directory] of PACKAGES) {
    const manifestPath = `${directory}/package.json`;
    const changelogPath = `${directory}/CHANGELOG.md`;
    if (changes.some((change) => change.path === changelogPath || change.oldPath === changelogPath)) {
      fail(`${changelogPath} may change only in the generated version pull request`);
    }
    if (changes.some((change) => change.path === manifestPath || change.oldPath === manifestPath)) {
      let baseManifest;
      let headManifest;
      try {
        baseManifest = packageManifest(base, directory);
        headManifest = packageManifest(head, directory);
      } catch {
        continue;
      }
      if (baseManifest.version !== headManifest.version) {
        fail(`${manifestPath} version may change only in the generated version pull request`);
      }
    }
  }

  const requiresReleaseIntent = changes.some(
    (change) =>
      isReleaseRelevantPath(change.path) ||
      (change.oldPath !== undefined && isReleaseRelevantPath(change.oldPath)),
  );
  if (!requiresReleaseIntent) return;

  const result = spawnSync(
    "pnpm",
    ["changeset", "status", `--since=${base}`],
    { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) fail("published package bytes or behavior changed without a matching changeset");
}

export function checkChangesetPullRequest({ base, head = "HEAD", versionPullRequest = false }) {
  if (!/^[0-9a-f]{40}$/u.test(base)) fail("base must be a full lowercase commit SHA");
  if (head !== "HEAD" && !/^[0-9a-f]{40}$/u.test(head)) fail("head must be HEAD or a full lowercase commit SHA");
  if (versionPullRequest) verifyGeneratedVersionPullRequest(base, head);
  else verifyOrdinaryPullRequest(base, head);
}

function parseArgs(argv) {
  const options = { head: "HEAD", versionPullRequest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base") options.base = argv[++index];
    else if (value === "--head") options.head = argv[++index];
    else if (value === "--version-pr") options.versionPullRequest = true;
    else fail(`unknown option ${value}`);
  }
  if (!options.base) fail("usage: check-changeset-pr.mjs --base SHA [--head SHA] [--version-pr]");
  return options;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    checkChangesetPullRequest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
