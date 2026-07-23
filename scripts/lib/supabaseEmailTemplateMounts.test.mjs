import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureSupabaseEmailTemplateMounts,
  SUPABASE_EMAIL_TEMPLATE_NAMES,
} from "./supabaseEmailTemplateMounts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const container = "supabase_kong_supabase";
const containerRoot = "/home/kong/templates/email";

function createProjectDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-supabase-templates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.toml"), 'project_id = "supabase"\n');
  const contents = new Map();
  for (const name of SUPABASE_EMAIL_TEMPLATE_NAMES) {
    const content = `<html>${name}</html>\n`;
    contents.set(name, content);
    fs.writeFileSync(path.join(root, "templates", `${name}.html`), content);
  }
  return { root, contents };
}

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function failed(stderr = "not a file") {
  return { status: 1, stdout: "", stderr };
}

test("leaves healthy Supabase template file mounts untouched", (t) => {
  const { root, contents } = createProjectDir(t);
  const calls = [];
  const warnings = [];
  const executeDocker = (args) => {
    calls.push(args);
    if (args[0] === "ps") return ok(`${container}\n`);
    if (args[0] === "exec" && args[2] === "cat") {
      const name = path.basename(args[3], ".html");
      return ok(contents.get(name));
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  };

  const result = ensureSupabaseEmailTemplateMounts({
    projectDir: root,
    executeDocker,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result, { container, repaired: [] });
  assert.equal(calls.filter(([command]) => command === "cp").length, 0);
  assert.equal(warnings.length, 0);
});

test("repairs every template when Colima turns file mounts into directories", (t) => {
  const { root, contents } = createProjectDir(t);
  const repaired = new Set();
  const copyCalls = [];
  const warnings = [];
  const executeDocker = (args) => {
    if (args[0] === "ps") return ok(`${container}\n`);
    if (args[0] === "exec" && args[2] === "cat") {
      const target = args[3];
      const match = target.match(/\/([^/]+)\.html(?:\/index\.html)?$/);
      const name = match?.[1];
      if (target.endsWith("/index.html") && repaired.has(name)) {
        return ok(contents.get(name));
      }
      return failed();
    }
    if (args[0] === "exec" && args[2] === "test" && args[3] === "-d") {
      return ok();
    }
    if (args[0] === "cp") {
      copyCalls.push(args);
      const match = args[2].match(/\/([^/]+)\.html\/index\.html$/);
      repaired.add(match?.[1]);
      return ok();
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  };

  const result = ensureSupabaseEmailTemplateMounts({
    projectDir: root,
    executeDocker,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result.repaired, [...SUPABASE_EMAIL_TEMPLATE_NAMES]);
  assert.equal(copyCalls.length, SUPABASE_EMAIL_TEMPLATE_NAMES.length);
  for (const name of SUPABASE_EMAIL_TEMPLATE_NAMES) {
    assert.deepEqual(copyCalls.find((args) => args[1].endsWith(`/${name}.html`)), [
      "cp",
      path.join(root, "templates", `${name}.html`),
      `${container}:${containerRoot}/${name}.html/index.html`,
    ]);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invite, magic_link, confirmation, recovery, email_change/);
});

test("both local Supabase startup paths validate existing and newly started stacks", () => {
  for (const relativePath of ["scripts/supabase-stack.mjs", "scripts/run-e2e-dev.mjs"]) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    const calls = source.match(
      /ensureSupabaseEmailTemplateMounts\(\{ projectDir: supabaseProjectDir \}\)/g,
    );
    assert.equal(calls?.length, 2, `${relativePath} should validate both startup branches`);
  }
});
