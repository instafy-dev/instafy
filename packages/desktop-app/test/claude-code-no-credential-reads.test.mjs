import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Instafy never reads, stores or forwards a Claude sign-in (docs/Local-Engine-Turns.md,
// section 6). Desktop, its runtime launcher and runtime-agent only find and
// run the person's own `claude`; none of their sources may name where
// Claude Code keeps its sign-in, or the command that reads it from the
// macOS keychain.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_TREES = [
  "packages/desktop-app/src",
  "packages/desktop-runtime-agent/src",
  "packages/runtime-agent/src",
];
const FORBIDDEN = [
  { label: "Claude Code's credentials file", pattern: /\.credentials\.json/i },
  { label: "Claude Code's OAuth credential key", pattern: /claudeAiOauth|claude_ai_oauth/i },
  { label: "Claude Code's keychain service name", pattern: /Claude Code-credentials/i },
  // Also the split argv form, `security` beside `find-generic-password`.
  { label: "the keychain read command", pattern: /find-generic-password/i },
];
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

test("Desktop, desktop-runtime-agent and runtime-agent sources never name Claude credentials", () => {
  let scanned = 0;
  const findings = [];
  for (const tree of SOURCE_TREES) {
    const root = path.join(repoRoot, tree);
    assert.ok(fs.statSync(root).isDirectory(), `${tree} exists`);
    for (const file of listFiles(root)) {
      const contents = fs.readFileSync(file);
      if (contents.length > MAX_SCANNED_BYTES || contents.includes(0)) {
        continue;
      }
      scanned += 1;
      const text = contents.toString("utf8");
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) {
          findings.push(`${path.relative(repoRoot, file)}: ${label}`);
        }
      }
    }
  }
  assert.ok(scanned > 100, `scanned ${scanned} source files`);
  assert.deepEqual(findings, []);
});

test("the scan would catch each marker", () => {
  for (const sample of [
    'path.join(home, ".claude", ".credentials.json")',
    "const key = parsed.claudeAiOauth;",
    'Command::new("security").args(["find-generic-password", "-s", "Claude Code-credentials"])',
    "security find-generic-password -w",
  ]) {
    assert.ok(
      FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
      `nothing caught: ${sample}`,
    );
  }
});
