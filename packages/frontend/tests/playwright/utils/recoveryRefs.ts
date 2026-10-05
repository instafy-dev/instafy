import type { Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getControllerUrl } from "./harness.js";

/**
 * Plant unsaved work the way a runtime keeps it: a commit on top of the
 * canonical `main`, pushed to `refs/instafy/recovery/<originId>/<name>` with
 * a git.write token and the trailers the recovery list reads.
 */

export type RecoveryKind = "conflict" | "unpublished" | "unsaved" | "stale";

export interface PlantedRecoveryRef {
  ref: string;
  rev: string;
  originId: string;
}

function resolveServiceRoleKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    ""
  );
}

function resolveGitRemoteBaseUrl(): string {
  const explicit = process.env.PLAYWRIGHT_GIT_REMOTE_BASE_URL || process.env.GIT_REMOTE_BASE_URL;
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, "");
  }
  const edgePort = Number(process.env.GIT_EDGE_PORT || 8080);
  return `http://127.0.0.1:${Number.isFinite(edgePort) && edgePort > 0 ? edgePort : 8080}`;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // Never echo the arguments: one of them carries the token header.
    const subcommand = args.find((arg) => /^[a-z][a-z-]*$/.test(arg)) ?? "";
    throw new Error(`[recoveryRefs] git ${subcommand} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function mintGitToken(page: Page, projectId: string): Promise<string> {
  const controllerUrl = getControllerUrl();
  const serviceRole = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRole) {
    throw new Error("[recoveryRefs] Controller URL and service role key are required.");
  }
  const response = await page.context().request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/git/access_token`,
    {
      headers: { authorization: `Bearer ${serviceRole}`, "content-type": "application/json" },
      data: { scopes: ["git.read", "git.write"], ttlSeconds: 600 },
    },
  );
  const payload = response.ok() ? ((await response.json().catch(() => null)) as { token?: string } | null) : null;
  const token = payload?.token?.trim();
  if (!token) {
    throw new Error(`[recoveryRefs] git token mint failed (${response.status()}).`);
  }
  return token;
}

export async function plantRecoveryRef(
  page: Page,
  options: {
    projectId: string;
    /** Path to content; `null` deletes the path in the kept work. */
    files: Record<string, string | null>;
    kind?: RecoveryKind;
    /** For `conflict` entries: the conflicted paths the list reports. */
    conflictPaths?: string[];
    originId?: string;
    name?: string;
  },
): Promise<PlantedRecoveryRef> {
  const kind = options.kind ?? "unpublished";
  const originId = options.originId ?? randomUUID();
  const name = options.name ?? `playwright-${Date.now()}-${kind}`;
  const ref = `refs/instafy/recovery/${originId}/${name}`;
  const token = await mintGitToken(page, options.projectId);
  const header = `http.extraHeader=Authorization: Bearer ${token}`;
  const remote = `${resolveGitRemoteBaseUrl()}/${options.projectId}.git`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-recovery-ref-"));
  try {
    git(["init", "-q"], dir);
    git(["remote", "add", "origin", remote], dir);
    git(["-c", header, "fetch", "-q", "--depth", "1", "origin", "main"], dir);
    git(["checkout", "-q", "-B", "kept", "FETCH_HEAD"], dir);
    git(["config", "user.name", "Instafy Playwright"], dir);
    git(["config", "user.email", "playwright@instafy.dev"], dir);
    const paths = Object.keys(options.files);
    for (const [file, content] of Object.entries(options.files)) {
      const absolute = path.join(dir, ...file.split("/"));
      if (content === null) {
        fs.rmSync(absolute, { force: true });
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content, "utf8");
      }
    }
    git(["add", "-A", "--", ...paths], dir);
    const trailers = [
      `Instafy-Recovery-Kind: ${kind}`,
      ...(kind === "conflict" ? (options.conflictPaths ?? paths).map((file) => `Instafy-Conflict: ${file}`) : []),
      ...paths.map((file) => `Instafy-Path: ${file}`),
    ];
    git(["commit", "-q", "--no-gpg-sign", "-m", `Kept work ${name}`, "-m", trailers.join("\n")], dir);
    const rev = git(["rev-parse", "HEAD"], dir);
    git(["-c", header, "push", "-q", "origin", `HEAD:${ref}`], dir);
    return { ref, rev, originId };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
