import { spawnSync } from "node:child_process";
import {
  buildInstafyGitCredentialHelperValue,
  isInstafyGitCredentialHelper,
} from "./git-helper.js";

function runGit(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return result;
}

export function isGitAvailable(): boolean {
  try {
    const result = runGit(["--version"]);
    return result.status === 0;
  } catch {
    return false;
  }
}

export function installGitCredentialHelper(): { changed: boolean } {
  if (!isGitAvailable()) {
    return { changed: false };
  }

  const existing = runGit(["config", "--global", "--get-all", "credential.helper"]);
  const helpers = (existing.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const desiredHelper = buildInstafyGitCredentialHelperValue();

  if (helpers.includes(desiredHelper)) {
    return { changed: false };
  }

  const remaining = helpers.filter((helper) => !isInstafyGitCredentialHelper(helper));
  if (remaining.length !== helpers.length) {
    runGit(["config", "--global", "--unset-all", "credential.helper"]);
    for (const helper of remaining) {
      runGit(["config", "--global", "--add", "credential.helper", helper]);
    }
  }

  runGit(["config", "--global", "--add", "credential.helper", desiredHelper]);
  return { changed: true };
}

export function uninstallGitCredentialHelper(): { changed: boolean } {
  if (!isGitAvailable()) {
    return { changed: false };
  }

  const existing = runGit(["config", "--global", "--get-all", "credential.helper"]);
  const helpers = (existing.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!helpers.some(isInstafyGitCredentialHelper)) {
    return { changed: false };
  }

  const remaining = helpers.filter((helper) => !isInstafyGitCredentialHelper(helper));
  // Remove all helpers, then re-add the ones we didn't own.
  runGit(["config", "--global", "--unset-all", "credential.helper"]);
  for (const helper of remaining) {
    runGit(["config", "--global", "--add", "credential.helper", helper]);
  }

  return { changed: true };
}
