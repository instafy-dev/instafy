import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findPublicBoundaryViolations } from "./check-public-boundary.mjs";

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "instafy-public-boundary-"));
  try {
    for (const [filePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, filePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    return run(root, Object.keys(files));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts neutral public files and provider-contract product references", () => {
  const productMarker = ["kno", "sh"].join("");
  withFixture(
    {
      "README.md": "Public core documentation.\n",
      "packages/provider-contract/fixture.ts": `export const family = '${productMarker}';\n`,
      ".env.local.example": "TOKEN=replace-me\n",
    },
    (root, paths) => {
      assert.deepEqual(findPublicBoundaryViolations({ root, paths }), []);
    },
  );
});

test("rejects private paths, live environments, auth material, and product markers", () => {
  const productMarker = ["kno", "sh"].join("");
  withFixture(
    {
      "internal/notes.md": "not public\n",
      "packages/frontend/.env.production": "TOKEN=secret\n",
      "fixtures/.codex/auth.json": "{}\n",
      "packages/frontend/src/product.ts": `export const family = '${productMarker}';\n`,
    },
    (root, paths) => {
      const rules = findPublicBoundaryViolations({ root, paths }).map(
        ({ rule }) => rule,
      );
      assert.ok(rules.includes("private-directory"));
      assert.ok(rules.includes("live-environment-file"));
      assert.ok(rules.includes("live-auth-file"));
      assert.ok(rules.includes("private-product"));
    },
  );
});

test("rejects high-risk content markers without publishing their literal values here", () => {
  const tokenPrefix = ["gh", "p_"].join("");
  const host = ["internal", "instafy", "dev"].join(".");
  const browserServiceRole = ["VITE", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
  withFixture(
    {
      "fixture.txt": [
        `${tokenPrefix}example`,
        `https://${host}`,
        `/${["Users", "example", "repo"].join("/")}`,
        `${browserServiceRole}=value`,
      ].join("\n"),
    },
    (root, paths) => {
      const rules = new Set(
        findPublicBoundaryViolations({ root, paths }).map(({ rule }) => rule),
      );
      assert.ok(rules.has("github-token-prefix"));
      assert.ok(rules.has("private-host"));
      assert.ok(rules.has("absolute-personal-path"));
      assert.ok(rules.has("browser-exposed-service-role"));
    },
  );
});
