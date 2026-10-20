import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const policy = require(path.join(packageRoot, "dist/personalBrowserActionPolicy.js"));
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const table = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "test/fixtures/risky-steps/cases.json"), "utf8"),
);

for (const entry of table.cases) {
  test(`classifier case: ${entry.name}`, () => {
    const result = security.classifyPersonalBrowserStep(entry.op, entry.target, {
      pageUrl: table.pageUrl,
      ...(entry.ctx ?? {}),
    });
    assert.equal(result.verdict, entry.verdict, `${entry.name}: ${JSON.stringify(result)}`);
    assert.equal(result.category, entry.category, `${entry.name}: ${JSON.stringify(result)}`);
    if (entry.code) assert.equal(result.code, entry.code);
    if (result.verdict === "ask") {
      assert.ok(policy.categoryTitle(result.category), `ask category ${result.category} has a dialog title`);
    }
    if (result.verdict === "refuse") {
      assert.ok(policy.refusalFor(result.category)?.message);
    }
  });
}

test("the case table covers every ask category and every refusal in English and German", () => {
  const asked = new Set(table.cases.filter((entry) => entry.verdict === "ask").map((entry) => entry.category));
  for (const category of Object.keys(policy.CATEGORY_TITLES)) {
    assert.ok(asked.has(category), `missing ask category ${category}`);
    for (const language of ["EN", "DE"]) {
      if (category === "may_show_secret") continue;
      assert.ok(
        table.cases.some((entry) => entry.category === category && entry.name.startsWith(language)),
        `missing ${language} case for ${category}`,
      );
    }
  }
  const refused = new Set(table.cases.filter((entry) => entry.verdict === "refuse").map((entry) => entry.code));
  for (const code of ["step_refused_secret", "step_refused_sign_in", "step_refused_upload"]) {
    assert.ok(refused.has(code), `missing refusal ${code}`);
  }
});

test("sensitive fields are refused for typing and submitting in every mode", () => {
  for (const op of ["type", "submit"]) {
    const result = security.classifyPersonalBrowserStep(op, { tag: "input", type: "password" });
    assert.equal(result.verdict, "refuse");
    assert.equal(result.code, "sensitive_input_blocked");
  }
});

test("words only add risk: a hostile Search label on a plain button still asks", () => {
  const result = security.classifyPersonalBrowserStep("click", { tag: "button", type: "button", text: "Search" });
  assert.equal(result.verdict, "ask");
});

test("dialog labels show both names when the accessible name and visible text differ", () => {
  assert.deepEqual(
    { ...policy.stepLabels({ ariaLabel: "Delete workspace", text: "Open" }) },
    { accessible: "Delete workspace", visible: "Open", differ: true },
  );
  assert.equal(policy.stepLabels({ ariaLabel: "Save", text: "Save" }).differ, false);
  assert.equal(policy.stepLabels({ text: "Save" }).differ, false);
});

test("the fixture pages hold no key-shaped literal", () => {
  const folder = path.join(packageRoot, "test/fixtures/risky-steps");
  const redaction = require(path.join(packageRoot, "dist/personalBrowserRedaction.js"));
  for (const file of ["index.html", "ff/index.html", "ff/verbundene-apps.html", "ff/login.html", "cases.json"]) {
    const content = fs.readFileSync(path.join(folder, file), "utf8");
    assert.equal(redaction.matchesKnownFormat(content), false, file);
  }
});
