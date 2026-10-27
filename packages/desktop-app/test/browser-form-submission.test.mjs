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
  // What markup alone cannot build, the page builds after it loads.
  if (entry.setup) window.eval(`(() => { ${placeholders(entry.setup, entry.name)} })()`);
  // jsdom does not navigate; the submit event shows whether the step
  // submitted. It does not leave a shadow tree, so each one is watched too.
  const submitted = [];
  const record = (event) => {
    submitted.push(event.submitter ?? null);
    event.preventDefault();
  };
  window.document.addEventListener("submit", record, true);
  for (const element of window.document.querySelectorAll("*")) {
    element.shadowRoot?.addEventListener("submit", record, true);
  }
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

// jsdom gives every input, label and link activation behavior, as the
// standard does. Chromium lets a click on a label, or on a plain button,
// reach the submit button around it, which then submits. The bridge's own
// click is checked against Chromium for these in the Electron smoke and the
// Shared Browser's fixture; here only what it reports.
const JSDOM_CLICK_STOPS_EARLIER = new Set([
  "click-a-label-inside-a-submit-button",
  "click-a-plain-button-inside-a-submit-button",
]);

test("the shared table is well formed and names every case once", () => {
  assert.equal(table.schema, "instafy.form-submission-cases@1");
  const names = table.cases.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const entry of table.cases) {
    assert.ok(["enter", "click"].includes(entry.step), entry.name);
    assert.ok(/id="step"|'step'/.test(`${entry.html}${entry.setup ?? ""}`), entry.name);
    assert.ok(entry.setup === undefined || typeof entry.setup === "string", entry.name);
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
    const nested = entry.submission.via === "nested";
    if (entry.submission.via === "" || (entry.submission.via === "implicit" && entry.step === "click")) {
      assert.equal(submission, null);
    } else {
      assert.deepEqual(submission, entry.submission.method === "dialog"
        ? { action: null, method: "dialog", newWindow: false, nested }
        : { action: expected.action, method: expected.method, newWindow: expected.newWindow, nested });
    }
    // A field inside a submit button is sent one way by a click and another
    // by Enter: both hosts refuse its steps before the bridge takes them.
    if (nested) return;

    const expectation = {
      identity: descriptor.identity,
      securityFingerprint: security.personalBrowserTargetSecurityFingerprint(descriptor),
    };
    const result = entry.step === "click"
      ? await bridge.clickPersonalBrowserTarget(page.webContents, { index: item.index }, expectation)
      : await bridge.pressPersonalBrowserTarget(page.webContents, { index: item.index }, "Enter", expectation);
    assert.equal(result.targetChanged, false);
    if (JSDOM_CLICK_STOPS_EARLIER.has(entry.name)) return;
    assert.equal(page.submitted.length, submission && entry.submission.submits ? 1 : 0, `${entry.name}: submitted ${page.submitted.length} time(s)`);
  });
}

test("a step's submission is judged by the control's tag and type when the page did not report it", () => {
  const owned = { formOwnerIdentity: "document:form", formActionUrl: "https://shop.test/search", formMethod: "get" };
  assert.deepEqual(
    formSubmission.stepSubmission({ ...owned, tag: "button", type: "submit" }, "click"),
    { action: "https://shop.test/search", method: "get", newWindow: false, nested: false },
  );
  assert.ok(formSubmission.stepSubmission({ ...owned, tag: "input", type: "search" }, "press", "Enter"));
  assert.equal(formSubmission.stepSubmission({ ...owned, tag: "input", type: "search" }, "click"), null);
  // A reported answer wins: a label that clicks a submit button submits.
  assert.ok(formSubmission.stepSubmission({ ...owned, tag: "label", formSubmission: "button" }, "click"));
  assert.equal(formSubmission.stepSubmission({ ...owned, tag: "button", type: "submit", formSubmission: "" }, "click"), null);
  // A field inside a submit button submits on a click, Enter and typing with
  // submit, and is marked so that both hosts refuse those steps.
  for (const [step, key] of [["click", ""], ["press", "Enter"], ["press", " "], ["submit", ""]]) {
    assert.equal(formSubmission.stepSubmission({ ...owned, tag: "input", type: "text", formSubmission: "nested" }, step, key)?.nested, true, `${step} ${key}`);
  }
  assert.equal(formSubmission.stepSubmission({ ...owned, tag: "input", type: "text", formSubmission: "nested" }, "press", "Tab"), null);
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

test("a keydown handler that moves where Enter sends the form stops the bridge's Enter, and nothing is submitted", async () => {
  for (const [name, move] of [
    // The page's keydown points the default button at another site.
    ["formaction", (document) => {
      const button = document.querySelector("button");
      button.setAttribute("formaction", `${OTHER}/collect`);
      button.setAttribute("formmethod", "post");
    }],
    // It puts a new default button in front of the one that was judged.
    ["new default button", (document) => {
      const hostile = document.createElement("button");
      hostile.setAttribute("formaction", `${OTHER}/collect`);
      hostile.setAttribute("formmethod", "post");
      document.querySelector("form").prepend(hostile);
    }],
    // It opens the results in another window.
    ["formtarget", (document) => document.querySelector("button").setAttribute("formtarget", "_blank")],
  ]) {
    const entry = table.cases.find((candidate) => candidate.name === "same-site-search");
    const page = loadCase(entry);
    const snapshot = await bridge.snapshotPersonalBrowserPage(page.webContents);
    const item = snapshot.interactive.find((candidate) => candidate.descriptor.id === "step");
    assert.equal(item.descriptor.formActionUrl, `${SHOP}/search`, name);
    page.window.document.getElementById("step").addEventListener("keydown", () => move(page.window.document));
    const result = await bridge.pressPersonalBrowserTarget(page.webContents, { index: item.index }, "Enter", {
      identity: item.descriptor.identity,
      securityFingerprint: security.personalBrowserTargetSecurityFingerprint(item.descriptor),
    });
    assert.equal(result.pressed, false, name);
    assert.equal(result.targetChanged, true, name);
    assert.equal(page.submitted.length, 0, `${name}: nothing was submitted`);
  }
  // A keydown that only enables the judged default button changes nothing
  // the step was judged by: Enter goes ahead.
  const blocked = table.cases.find((candidate) => candidate.name === "disabled-default-button-blocks");
  const page = loadCase(blocked);
  const snapshot = await bridge.snapshotPersonalBrowserPage(page.webContents);
  const item = snapshot.interactive.find((candidate) => candidate.descriptor.id === "step");
  page.window.document.getElementById("step").addEventListener("keydown", () => {
    page.window.document.querySelector("button[disabled]").disabled = false;
  });
  const result = await bridge.pressPersonalBrowserTarget(page.webContents, { index: item.index }, "Enter", {
    identity: item.descriptor.identity,
    securityFingerprint: security.personalBrowserTargetSecurityFingerprint(item.descriptor),
  });
  assert.equal(result.pressed, true);
  assert.equal(page.submitted.length, 1);
});
