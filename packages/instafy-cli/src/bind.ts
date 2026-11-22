// `instafy bind ...` delegates to the bound-sites binder (packages/instafy-bind, bin `instafy-bind`), which the
// build copies into dist/bind. The binder is zero-dependency Node ESM. It runs as a child process with the same arguments, so
// `instafy bind serve site/` and `instafy-bind serve site/` behave the same.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BIN_REL = path.join("bin", "instafy-bind.mjs");

/**
 * Find the binder's bin. In order:
 * 1. INSTAFY_BIND_BIN (a path to instafy-bind.mjs);
 * 2. the copy bundled into this CLI at build time (dist/bind, written by scripts/copy-bind.mjs);
 * 3. the monorepo sibling `packages/instafy-bind` (dist/cli.js and src/index.ts both sit two levels below `packages`).
 */
export function resolveBindBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.INSTAFY_BIND_BIN?.trim();
  if (fromEnv) return fs.existsSync(fromEnv) ? path.resolve(fromEnv) : null;

  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "bind", BIN_REL), path.resolve(here, "..", "..", "instafy-bind", BIN_REL)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The bundled binder's root (dist/bind, else the monorepo sibling), never one named by the environment. */
function bundledBindRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "bind"), path.resolve(here, "..", "..", "instafy-bind")]) {
    if (fs.existsSync(path.join(candidate, BIN_REL))) return candidate;
  }
  return null;
}

export type CredentialFreeEnv = (env: NodeJS.ProcessEnv, keep?: string[]) => Record<string, string>;

/**
 * The binder's `credentialFreeEnv` (src/detached-env.mjs): the one rule for the environment of a process that
 * outlives the command that started it, shared with `instafy bind serve --detach`. Throws when the bundled binder is
 * missing, so a caller fails closed instead of passing its own environment through.
 */
export async function loadCredentialFreeEnv(): Promise<CredentialFreeEnv> {
  const root = bundledBindRoot();
  const file = root ? path.join(root, "src", "detached-env.mjs") : null;
  if (!file || !fs.existsSync(file)) {
    throw new Error("the bundled binder (dist/bind) was not found, so a site cannot be started without credentials; rebuild the CLI");
  }
  const module = (await import(pathToFileURL(file).href)) as { credentialFreeEnv?: unknown };
  if (typeof module.credentialFreeEnv !== "function") {
    throw new Error(`${file} does not export credentialFreeEnv; rebuild the CLI`);
  }
  return module.credentialFreeEnv as CredentialFreeEnv;
}

/**
 * What makes the card of the page in `folder` wait, in the binder's own words: the lines its check prints for a page
 * that says "checked <date>" or "seen <date>" in typed words (src/check.mjs `cardWaits`), or null when the page types
 * none. `instafy preview open` asks before it serves a page with Instafy's page server, so the card's own command
 * answers as the page's check does; `summary`, the line it puts under the card's title, is read the same way. A
 * binder that is missing or older than this, or a folder it cannot read, holds no card back: the command then opens
 * what it was asked to, as before.
 */
export async function pageCardWaits(folder: string, summary?: string): Promise<string[] | null> {
  const root = bundledBindRoot();
  const file = root ? path.join(root, "src", "check.mjs") : null;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const module = (await import(pathToFileURL(file).href)) as { cardWaits?: unknown };
    if (typeof module.cardWaits !== "function") return null;
    const read = module.cardWaits as (dir: string, options: { summary: string | null }) => { lines?: unknown } | null;
    const waits = read(folder, { summary: summary ?? null });
    return waits && Array.isArray(waits.lines) ? waits.lines.map(String) : null;
  } catch {
    return null;
  }
}

/** Run `instafy-bind <args...>` and resolve with its exit code. Signals are forwarded so Ctrl-C stops the binder cleanly. */
export function runBind(args: string[]): Promise<number> {
  const bin = resolveBindBin();
  if (!bin) {
    process.stderr.write(
      "instafy bind: the bundled binder (dist/bind) was not found; rebuild the CLI, or set INSTAFY_BIND_BIN to " +
        "packages/instafy-bind/bin/instafy-bind.mjs, or run it directly: node packages/instafy-bind/bin/instafy-bind.mjs <command>\n",
    );
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit", env: process.env });
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (error) => {
      process.stderr.write(`instafy bind: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}
