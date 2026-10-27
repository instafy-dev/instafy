import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";

// The form-submission table both browsers run
// (@instafy/browser-action-policy/formSubmissionCases.json), through the real
// Personal Browser page bridge in a DOM: the descriptor reports the
// submission the table expects, the step classifier judges Enter by it, and
// the bridge's own step submits exactly when the table says the browser does.
// The same table runs in real Chromium for the Shared Browser
// (scripts/shared-browser-form-submission-e2e.mjs) and, through this bridge,
// in the Electron smoke, where the requests themselves are checked.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const bridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const formSubmission = require("@instafy/browser-action-policy/formSubmission");
const table = JSON.parse(fs.readFileSync(
  path.join(path.dirname(require.resolve("@instafy/browser-action-policy/formSubmission")), "formSubmissionCases.json"),
  "utf8",
));

const SHOP = "http://shop.test:8123";
const OTHER = "http://other.test:8123";

function placeholders(value, name) {
  return value
    .replaceAll("{shop}", SHOP)
    .replaceAll("{other}", OTHER)
    .replaceAll("{page}", `${SHOP}/case/${name}`);
}

function loadCase(entry) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    `<!doctype html><html><head><meta charset="utf-8"><title>${entry.name}</title></head><body>${placeholders(entry.html, entry.name)}</body></html>`,
    { url: `${SHOP}/case/${entry.name}`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole },
  );
  const { window } = dom;
  // jsdom has no layout: every element gets a box, and the body is the
  // element at any point, which the bridge accepts as an ancestor hit.
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 10, y: 10, width: 80, height: 30, top: 10, left: 10, right: 90, bottom: 40 };
  };
  window.document.elementFromPoint = () => window.document.body;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; },
  });
  if (typeof window.crypto?.getRandomValues !== "function") {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
  // jsdom does not navigate; the submit event shows whether the step submitted.
  const submitted = [];
  window.document.addEventListener("submit", (event) => {
    submitted.push(event.submitter ?? null);
    event.preventDefault();
  }, true);
  const webContents = {
    async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
      return window.eval(scripts[0].code);
    },
  };
  return { window, webContents, submitted };
}

function reported(descriptor) {
  return {
    via: descriptor.formSubmission,
    submits: descriptor.formSubmits,
    action: descriptor.formActionUrl,
    method: descriptor.formMethod,
    enctype: descriptor.formEnctype,
    target: descriptor.formTarget,
    newWindow: descriptor.formNewWindow,
  };
}

test("the shared table is well formed and names every case once", () => {
  assert.equal(table.schema, "instafy.form-submission-cases@1");
  const names = table.cases.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const entry of table.cases) {
    assert.ok(["enter", "click"].includes(entry.step), entry.name);
    assert.ok(/id="step"/.test(entry.html), entry.name);
    assert.deepEqual(Object.keys(entry.submission).sort(), ["action", "enctype", "method", "newWindow", "submits", "target", "via"], entry.name);
  }
});

for (const entry of table.cases) {
  test(`form step "${entry.name}": the page bridge reports and performs the browser's submission`, async () => {
    const page = loadCase(entry);
    const pageUrl = page.window.location.href;
    const snapshot = await bridge.snapshotPersonalBrowserPage(page.webContents);
    const item = snapshot.interactive.find((candidate) => candidate.descriptor.id === "step");
    assert.ok(item, `${entry.name}: the step's element is observed`);
    const descriptor = item.descriptor;
    const expected = { ...entry.submission, action: placeholders(entry.submission.action, entry.name) };
    assert.deepEqual(reported(descriptor), expected);
    if (entry.enter) {
      assert.equal(security.classifyPersonalBrowserStep("press", descriptor, { key: "Enter", pageUrl }).verdict, entry.enter);
      assert.equal(
        security.personalBrowserKeyRequiresConfirmation("Enter", descriptor, "routine", { pageUrl }),
        entry.enter === "ask",
      );
    }
    // The step's submission, as the hosts' destination and window checks see it.
    const submission = security.personalBrowserStepFormSubmission(descriptor, entry.step === "click" ? "click" : "press", "Enter");
    if (entry.submission.via === "") {
      assert.equal(submission, null);
    } else {
      assert.deepEqual(submission, entry.submission.method === "dialog"
        ? { action: null, method: "dialog", newWindow: false }
        : { action: expected.action, method: expected.method, newWindow: expected.newWindow });
    }

    const expectation = {
      identity: descriptor.identity,
      securityFingerprint: security.personalBrowserTargetSecurityFingerprint(descriptor),
    };
    const result = entry.step === "click"
      ? await bridge.clickPersonalBrowserTarget(page.webContents, { index: item.index }, expectation)
      : await bridge.pressPersonalBrowserTarget(page.webContents, { index: item.index }, "Enter", expectation);
    assert.equal(result.targetChanged, false);
    assert.equal(page.submitted.length, entry.submission.submits ? 1 : 0, `${entry.name}: submitted ${page.submitted.length} time(s)`);
  });
}

test("a step's submission is judged by the control's tag and type when the page did not report it", () => {
  const owned = { formOwnerIdentity: "document:form", formActionUrl: "https://shop.test/search", formMethod: "get" };
  assert.deepEqual(
    formSubmission.stepSubmission({ ...owned, tag: "button", type: "submit" }, "click"),
    { action: "https://shop.test/search", method: "get", newWindow: false },
  );
  assert.ok(formSubmission.stepSubmission({ ...owned, tag: "input", type: "search" }, "press", "Enter"));
  assert.equal(formSubmission.stepSubmission({ ...owned, tag: "input", type: "search" }, "click"), null);
  // A reported answer wins: a label that clicks a submit button submits.
  assert.ok(formSubmission.stepSubmission({ ...owned, tag: "label", formSubmission: "button" }, "click"));
  assert.equal(formSubmission.stepSubmission({ ...owned, tag: "button", type: "submit", formSubmission: "" }, "click"), null);
  // Typing with submit counts for any field of a form; nothing without one.
  assert.ok(formSubmission.stepSubmission({ ...owned, tag: "textarea", formSubmission: "" }, "submit"));
  assert.equal(formSubmission.stepSubmission({ tag: "input", type: "search", formActionUrl: "https://shop.test/" }, "submit"), null);
});

test("the in-page rules read form attributes through the DOM prototypes, so named controls cannot stand in for them", () => {
  const dom = new JSDOM(
    `<!doctype html><form id="f" action="/search" method="get" target="_self"><input name="action" value="https://other.test/x"><input name="method" value="post"><input name="target" value="_blank"><input id="step" type="search" aria-label="Search"><button>Search</button></form>`,
    { url: `${SHOP}/clobber`, runScripts: "outside-only" },
  );
  const form = dom.window.document.getElementById("f");
  // Named controls shadow form properties in browsers; jsdom does not, so
  // shadow them the same way here.
  for (const name of ["action", "method", "target", "getAttribute", "hasAttribute"]) {
    Object.defineProperty(form, name, { configurable: true, value: form.elements.namedItem(name) || "clobbered" });
  }
  const rules = dom.window.eval(`(${formSubmission.formSubmissionRulesInPage})()`);
  const result = rules.submissionOf(dom.window.document.getElementById("step"), null);
  assert.equal(result.action, `${SHOP}/search`);
  assert.equal(result.method, "get");
  assert.equal(result.target, "_self");
  assert.equal(result.newWindow, false);
});
