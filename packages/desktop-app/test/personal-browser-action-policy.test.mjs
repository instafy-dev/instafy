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
    // `commit` marks a button whose label commits a change, never a menu
    // item, tab, tree item, opener or navigation item.
    assert.equal(result.commit === true, entry.commit === true, `${entry.name} commit: ${JSON.stringify(result)}`);
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

// The Shared Browser's site search without a prompt (isFreeSiteSearch): a
// known GET of the page's own origin in the same tab, to a public address,
// through a search field, whose sent address and entries are ordinary.
const SEARCH_PAGE = "https://visit.example/places";
const siteSearch = (overrides = {}) => ({
  tag: "input",
  type: "search",
  ariaLabel: "Search places",
  name: "q",
  formOwnerIdentity: "form",
  formMethod: "get",
  formActionUrl: "https://visit.example/search",
  formSubmission: "implicit",
  formSubmits: true,
  formNewWindow: false,
  formActionText: "Search",
  formSubmitLabels: "Search",
  ...overrides,
});
const searchEntries = [["q", "Belém Tower"], ["lang", "en"]];
// Random-looking, assembled at run time so the source holds no key-shaped literal.
const keyLike = ["a8Fk2LmQ", "9zXw7Rt4", "Yb6Nc1Vd"].join("");

test("site search: a GET of the page's own origin that sends ordinary entries goes without a prompt", () => {
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, searchEntries), true);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["country_code", "PT"], ["postcode", "1100-148"]]), true);
});

test("site search: never to a loopback, private, link-local, shared or local address", () => {
  const hosts = [
    "127.0.0.1", "2130706433", "0x7f.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "[::1]", "[fd00::1]",
    "localhost", "app.localhost", "router.local", "intranet", "printer.lan", "box.internal", "nas.home.arpa",
  ];
  for (const host of hosts) {
    const origin = `http://${host}`;
    assert.equal(
      policy.isFreeSiteSearch(siteSearch({ formActionUrl: `${origin}/search` }), `${origin}/places`, searchEntries),
      false,
      host,
    );
  }
});

test("site search: only a known GET of the page's own origin in the same tab, through a search field", () => {
  const notFree = {
    "another subdomain": [siteSearch({ formActionUrl: "https://www.visit.example/search" }), SEARCH_PAGE],
    "another scheme": [siteSearch({ formActionUrl: "http://visit.example/search" }), SEARCH_PAGE],
    "another port": [siteSearch({ formActionUrl: "https://visit.example:8443/search" }), SEARCH_PAGE],
    "a user name in the address": [siteSearch({ formActionUrl: "https://someone@visit.example/search" }), SEARCH_PAGE],
    "a post": [siteSearch({ formMethod: "post" }), SEARCH_PAGE],
    "a dialog": [siteSearch({ formMethod: "dialog" }), SEARCH_PAGE],
    "a new window": [siteSearch({ formNewWindow: true }), SEARCH_PAGE],
    "a field inside a submit button": [siteSearch({ formSubmission: "nested" }), SEARCH_PAGE],
    "a submit button": [siteSearch({ formSubmission: "button" }), SEARCH_PAGE],
    "a blocked submission": [siteSearch({ formSubmits: false }), SEARCH_PAGE],
    "no form": [siteSearch({ formOwnerIdentity: "" }), SEARCH_PAGE],
    "a sign-out address": [siteSearch({ formActionUrl: "https://visit.example/account/logout" }), SEARCH_PAGE],
    "a risk word in the form": [siteSearch({ formSubmitLabels: "Delete", formActionText: "Delete" }), SEARCH_PAGE],
    "a field that is no search field": [siteSearch({ type: "text", ariaLabel: "Your name", name: "name" }), SEARCH_PAGE],
    "a page with no web address": [siteSearch(), "about:blank"],
  };
  for (const [name, [target, pageUrl]] of Object.entries(notFree)) {
    assert.equal(policy.isFreeSiteSearch(target, pageUrl, searchEntries), false, name);
  }
});

test("site search: the address the browser sends is judged, with the entries as its query", () => {
  // A GET form's entries replace the action's query, so a hidden file format
  // or export flag makes the search an export, as a navigation there would be.
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["format", "csv"]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["export", "1"]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["download", "true"]]), false);
});

test("site search: nothing it sends may look like a key or a one-time code", () => {
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [["q", keyLike]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["k", keyLike]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["code", "482910"]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [...searchEntries, ["otp", "123456"]]), false);
});

test("site search: at most 64 name-value entries of at most 4,096 characters", () => {
  const many = Array.from({ length: 65 }, (_, index) => [`f${index}`, "x"]);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, many.slice(0, 64)), true);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, many), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [["q", "x".repeat(4_097)]]), false);
  assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, [["q".repeat(4_097), "x"]]), false);
  for (const entries of [[["q", 5]], [["q"]], ["Belém Tower"], null]) {
    assert.equal(policy.isFreeSiteSearch(siteSearch(), SEARCH_PAGE, entries), false, JSON.stringify(entries));
  }
});
