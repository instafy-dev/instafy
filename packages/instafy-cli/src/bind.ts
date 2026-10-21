// `instafy bind ...` delegates to the bound-sites binder (packages/instafy-bind, bin `instafy-bind`), which the
// build copies into dist/bind. The binder is zero-dependency Node ESM. It runs as a child process with the same arguments, so
// `instafy bind serve site/` and `instafy-bind serve site/` behave the same.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
