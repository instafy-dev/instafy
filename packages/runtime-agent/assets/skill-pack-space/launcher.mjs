#!/usr/bin/env node
// instafy:managed-launcher
// Written by the Instafy runtime. This skill pack is installed once with the runtime, not copied
// into every space; this launcher runs the pack's own command with the same arguments.
// `--pack-dir` prints the folder the pack is installed in (for its other files).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PACK = {{name}};
const ENTRY = {{entry}};
const roots = [process.env.INSTAFY_SKILL_PACKS_DIR, "/opt/instafy/skill-packs"].filter(Boolean);
const packDir = roots
  .map((root) => path.join(root, PACK))
  .find((dir) => fs.existsSync(path.join(dir, ...ENTRY.split("/"))));

if (!packDir) {
  process.stderr.write(
    `${PACK}: this skill pack is not installed in this runtime (looked in ${roots.join(", ")}). ` +
      "Tell the user this feature is unavailable here.\n",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--pack-dir") {
  process.stdout.write(`${packDir}\n`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [path.join(packDir, ...ENTRY.split("/")), ...args], {
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${PACK}: could not start the skill pack: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
