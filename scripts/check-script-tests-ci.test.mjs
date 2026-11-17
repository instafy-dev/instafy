import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

// Script tests that no workflow runs, each with the reason it stays a manual check.
// Anything else under scripts/ must be run by a workflow.
const MANUAL_SCRIPT_TESTS = {
  "scripts/release/android/upload-keystore.test.mjs":
    "needs a working Java keytool; macOS ships a /usr/bin/keytool stub that fails it, so it is unproven here",
};

const tracked = execFileSync("git", ["ls-files", "-z", "--", "scripts"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file.endsWith(".test.mjs"));

// The commands a workflow runs: each step's `run:` value, one line or a block,
// without shell comments. A name in a `paths:` filter or a YAML comment runs nothing.
function runCommands(workflow) {
  const lines = workflow.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(- )?run:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;
    const keyIndent = match[1].length + (match[2] ? 2 : 0);
    if (!/^[|>][+-]?\s*$/u.test(match[3])) {
      commands.push(match[3]);
      continue;
    }
    while (index + 1 < lines.length
      && (lines[index + 1].trim() === "" || lines[index + 1].search(/\S/u) > keyIndent)) {
      index += 1;
      if (!/^\s*#/u.test(lines[index])) commands.push(lines[index]);
    }
  }
  return commands;
}

// The package scripts a command runs through pnpm (`pnpm x`, `pnpm run x`,
// `pnpm --filter <package> [run] x`), and the scripts those run, a few levels deep.
const rootScripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
const packageScripts = new Map(fs.readdirSync(path.join(root, "packages"))
  .map((dir) => path.join(root, "packages", dir, "package.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
  .filter((pkg) => pkg.name)
  .map((pkg) => [pkg.name, pkg.scripts ?? {}]));
function scriptBodies(command, depth = 0) {
  if (depth > 3) return [];
  return [...command.matchAll(/\bpnpm(?:\s+(?:--filter|-F)\s+(\S+))?(?:\s+run)?\s+([\w:.-]+)/gu)]
    .map(([, filter, name]) => (filter ? packageScripts.get(filter) : rootScripts)?.[name])
    .filter(Boolean)
    .flatMap((body) => [body, ...scriptBodies(body, depth + 1)]);
}

// A workflow runs a test when a command, or a package script a command runs, names
// it or its folder with a glob such as scripts/release/web/*.test.mjs.
const workflowDir = path.join(root, ".github/workflows");
const commands = fs.readdirSync(workflowDir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .flatMap((file) => runCommands(fs.readFileSync(path.join(workflowDir, file), "utf8")));
const patterns = [...commands, ...commands.flatMap((command) => scriptBodies(command))]
  .flatMap((text) => text.match(/scripts\/[\w./*-]+\.test\.mjs/gu) ?? [])
  .map((name) => new RegExp(`^${name.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`, "u"));

// A test file a run test imports runs with it.
const run = new Set(tracked.filter((file) => patterns.some((pattern) => pattern.test(file))));
for (const file of run) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const [, imported] of source.matchAll(/^import (?:[^"']* from )?["'](\.{1,2}\/[^"']+\.test\.mjs)["']/gmu)) {
    run.add(path.posix.join(path.posix.dirname(file), imported));
  }
}

test("every tracked script test is run by a workflow or listed as manual with a reason", () => {
  const unrun = tracked.filter((file) => !run.has(file) && !Object.hasOwn(MANUAL_SCRIPT_TESTS, file));
  assert.deepEqual(unrun, [], "add each file to a workflow (see scripts/lib/buildContractTestsBaseline.mjs) or to MANUAL_SCRIPT_TESTS");
});

test("every manual entry exists, is still run nowhere and has a one-line reason", () => {
  for (const [file, reason] of Object.entries(MANUAL_SCRIPT_TESTS)) {
    assert.ok(tracked.includes(file), `${file} is no longer tracked`);
    assert.equal(run.has(file), false, `${file} is run by a workflow; drop it from MANUAL_SCRIPT_TESTS`);
    assert.match(reason, /^\S[^\n]{9,}$/u, file);
  }
});

test("the check sees direct names, folder globs, package scripts and imported test files", () => {
  assert.ok(run.has("scripts/check-script-tests-ci.test.mjs"));
  assert.ok(tracked.some((file) => file.startsWith("scripts/release/web/") && run.has(file)));
  assert.ok(run.has("scripts/check-manual-ci-routing.test.mjs"));
  assert.ok(run.has("scripts/auth-email-templates.test.mjs"), "through `pnpm test:auth:email`");
});

test("only commands count: a paths filter or a comment names a test without running it", () => {
  const sample = [
    "on:",
    "  push:",
    "    paths:",
    "      - scripts/filtered.test.mjs",
    "jobs:",
    "  lane:",
    "    steps:",
    "      - run: node --test scripts/direct.test.mjs",
    "      - name: Block",
    "        run: |",
    "          # node --test scripts/commented.test.mjs",
    "          pnpm check:app-icons",
    "      - uses: some/action@v1",
    "        with:",
    "          files: scripts/input.test.mjs",
  ].join("\n");
  const found = runCommands(sample);
  const text = [...found, ...found.flatMap((command) => scriptBodies(command))].join("\n");
  assert.match(text, /scripts\/direct\.test\.mjs/u);
  assert.match(text, /scripts\/lib\/app-icon-checker\.test\.mjs/u);
  assert.doesNotMatch(text, /scripts\/(?:filtered|commented|input)\.test\.mjs/u);
});
