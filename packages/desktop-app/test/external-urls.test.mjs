import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { externalBrowserUrl } = await import(path.join(packageRoot, "dist", "externalUrls.js"));

test("web URLs open in the browser", () => {
  assert.equal(externalBrowserUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(externalBrowserUrl("  http://example.com "), "http://example.com/");
});

test("other schemes never reach the operating system", () => {
  for (const url of [
    "smb://attacker.invalid/share",
    "vscode://file/tmp/x",
    "x-apple.systempreferences:com.apple.preference.security",
    "ms-msdt:/id PCWDiagnostic",
    "search-ms:query=x",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "zoommtg://zoom.us/join",
    "not a url",
    "",
    null,
    42,
  ]) {
    assert.equal(externalBrowserUrl(url), null, String(url));
  }
});

test("every shell.openExternal in main.ts takes a URL that passed the guard", () => {
  const source = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");
  const calls = [...source.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 3, "expected the window-open, will-navigate and IPC paths");
  for (const arg of calls) assert.equal(arg, "external", `shell.openExternal(${arg}) skips externalBrowserUrl`);
});
