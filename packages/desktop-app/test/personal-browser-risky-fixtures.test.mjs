import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

// Runs the real page-bridge scripts against the synthetic fixture pages in a
// DOM, then classifies what the bridge describes. This pins the descriptors
// the hand-written case table stands in for.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const bridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));
const redaction = require(path.join(packageRoot, "dist/personalBrowserRedaction.js"));
const fixtureRoot = path.join(packageRoot, "test/fixtures/risky-steps");
const PAGE_ORIGIN = "http://127.0.0.1:8765";
const CANARY = ["sk", "test", ["INSTAFY", "CANARY", "7Qm2Xr9Lp4Vb8Nc1"].join("")].join("_");

function loadPage(html, pagePath) {
  const dom = new JSDOM(html, { url: `${PAGE_ORIGIN}/${pagePath}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout: give every element a box and report the body as the
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
  const webContents = {
    async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
      return window.eval(scripts[0].code);
    },
  };
  return { window, webContents };
}

function loadFixture(file) {
  return loadPage(fs.readFileSync(path.join(fixtureRoot, file), "utf8"), file);
}

async function describePage(page) {
  const snapshot = await bridge.snapshotPersonalBrowserPage(page.webContents);
  const pageUrl = page.window.location.href;
  const byName = new Map();
  for (const entry of snapshot.interactive) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry.descriptor);
  }
  const classify = (name, op = "click", ctx = {}) => {
    const descriptor = byName.get(name);
    assert.ok(descriptor, `no target named ${name}: ${[...byName.keys()].join(", ")}`);
    return security.classifyPersonalBrowserStep(op, descriptor, { pageUrl, ...ctx });
  };
  return { snapshot, byName, classify };
}

function expectVerdict(result, verdict, category, label) {
  assert.equal(result.verdict, verdict, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.category, category, `${label}: ${JSON.stringify(result)}`);
}

test("FreeFinance-style connected apps page: refusals, asks and secret signals come from the real bridge", async () => {
  const page = loadFixture("ff/verbundene-apps.html");
  page.window.document.getElementById("key-field").value = CANARY;
  const { snapshot, byName, classify } = await describePage(page);
  assert.ok(!JSON.stringify(snapshot).includes(CANARY), "the page never returns the value it tested");
  assert.equal(snapshot.signals.credentialContext, true);
  assert.equal(snapshot.signals.secretField, true);
  assert.equal(snapshot.signals.maskedNearReveal, true);

  const reveal = byName.get("Anzeigen");
  assert.equal(reveal.credentialContext, true, "the nearest heading before the row names a credential");
  assert.match(reveal.contextLabel, /API-Schlüssel/);
  assert.equal(reveal.nearMaskedText, true);
  expectVerdict(classify("Anzeigen"), "refuse", "reveal_secret", "Anzeigen");
  expectVerdict(classify("Kopieren"), "refuse", "reveal_secret", "Kopieren");
  expectVerdict(classify("Löschen"), "ask", "destructive", "Löschen");
  expectVerdict(classify("Token erstellen"), "ask", "credential", "Token erstellen");
  expectVerdict(classify("Zurück zur Startseite"), "allow", "navigation", "back link before any heading");
  const row = [...byName.values()].find((descriptor) => descriptor.tag === "tr");
  assert.ok(row, "the clickable row is a target");
  expectVerdict(security.classifyPersonalBrowserStep("click", row, { pageUrl: page.window.location.href }), "ask", "may_show_secret", "API row");

  // The row's own column header, not only the heading, names the credential.
  const cellReveal = loadPage(`<!doctype html><body><h1>Apps</h1><table>
    <thead><tr><th>App</th><th>Zugangsschlüssel</th></tr></thead>
    <tbody><tr><td>Instafy</td><td>sk_…4f2a <button type="button">Anzeigen</button></td></tr></tbody>
  </table></body>`, "apps.html");
  const cell = await describePage(cellReveal);
  assert.equal(cell.byName.get("Anzeigen").credentialContext, true);
  expectVerdict(cell.classify("Anzeigen"), "refuse", "reveal_secret", "column header");
});

test("FreeFinance-style start page: menu entries are free and risky steps ask", async () => {
  const { snapshot, classify } = await describePage(loadFixture("ff/index.html"));
  assert.equal(snapshot.signals.credentialContext, false);
  assert.equal(snapshot.signals.maskedNearReveal, false);
  expectVerdict(classify("Mein Profil"), "allow", "navigation", "Mein Profil");
  expectVerdict(classify("Verbundene Apps"), "allow", "navigation", "Verbundene Apps");
  expectVerdict(classify("DATEV-Export"), "ask", "download", "DATEV-Export");
  expectVerdict(classify("Abmelden"), "ask", "destructive", "Abmelden");
  expectVerdict(classify("Neuen Mandant anlegen"), "ask", "change", "Neuen Mandant anlegen");
  expectVerdict(classify("Festschreiben"), "ask", "change", "Festschreiben");
  expectVerdict(classify("Alle ablehnen"), "allow", "dismiss", "Alle ablehnen");
  expectVerdict(classify("Alle akzeptieren"), "ask", "change", "Alle akzeptieren");
  expectVerdict(classify("Suche", "type"), "allow", "search", "search field");
});

test("sign-in page: identifier, password, submit and provider buttons are the user's", async () => {
  const { snapshot, byName, classify } = await describePage(loadFixture("ff/login.html"));
  const username = [...byName.values()].find((descriptor) => descriptor.autocomplete === "username");
  assert.equal(username.signInIdentifier, true);
  assert.equal(username.formPasswordCount, 1);
  const pageUrl = `${PAGE_ORIGIN}/ff/login.html`;
  expectVerdict(security.classifyPersonalBrowserStep("type", username, { pageUrl }), "refuse", "sign_in", "username");
  const password = [...byName.values()].find((descriptor) => descriptor.type === "password");
  expectVerdict(security.classifyPersonalBrowserStep("type", password, { pageUrl }), "refuse", "sensitive", "password");
  expectVerdict(classify("Anmelden"), "refuse", "sign_in", "Anmelden submit");
  expectVerdict(classify("Mit Google anmelden"), "refuse", "sign_in", "Mit Google anmelden");
  expectVerdict(classify("Passwort vergessen?"), "allow", "navigation", "forgot-password link");
  const observation = redaction.redactPageObservation({ ...snapshot, names: [], withhold: false });
  assert.equal(observation.secretScreen, false, "a sign-in page is not a secret screen");
});

test("sign-up form: only the account identifier is refused", async () => {
  const page = loadPage(`<!doctype html><body><h1>Konto erstellen</h1><form method="post" action="/signup">
    <label>Name <input name="name" /></label>
    <label>E-Mail <input name="login" /></label>
    <label>Passwort <input type="password" name="password" /></label>
    <button type="submit">Registrieren</button>
  </form></body>`, "signup.html");
  const { snapshot } = await describePage(page);
  const [name, login] = snapshot.interactive.map((entry) => entry.descriptor);
  const pageUrl = page.window.location.href;
  expectVerdict(security.classifyPersonalBrowserStep("type", name, { pageUrl }), "ask", "change", "name field");
  expectVerdict(security.classifyPersonalBrowserStep("type", login, { pageUrl }), "refuse", "sign_in", "identifier before the password");
});

test("billing page: masked card numbers and View links stay ordinary", async () => {
  const page = loadPage(`<!doctype html><body><main>
    <h1>Billing</h1>
    <section><h2>Payment method</h2><p>Visa •••• 4242</p><button type="button">View</button></section>
    <section><h2>Bank account</h2><p>DE89 •••• •••• 1234 <button type="button">Anzeigen</button></p></section>
    <section><h2>Invoices</h2><ul><li>Invoice 2026-10 · paid <a href="/invoices/123">View invoice</a></li></ul></section>
    <section><h2>Tokens</h2><p>Read how tokens work. <a href="/docs/tokens">View documentation</a></p></section>
  </main></body>`, "billing.html");
  const { snapshot, classify } = await describePage(page);
  assert.equal(snapshot.signals.maskedNearReveal, false);
  const observation = redaction.redactPageObservation({ ...snapshot, names: [] });
  assert.equal(observation.secretScreen, false);
  expectVerdict(classify("View"), "ask", "change", "View card");
  expectVerdict(classify("Anzeigen"), "ask", "change", "Anzeigen account");
  expectVerdict(classify("View invoice"), "allow", "navigation", "View invoice");
  expectVerdict(classify("View documentation"), "allow", "navigation", "View documentation");
});

test("ordinary header sign-in controls are not refused", async () => {
  const { classify } = await describePage(loadPage(`<!doctype html><body><header>
    <button type="button">Log in</button>
    <a role="button" class="btn" href="/login">Sign in</a>
    <a href="/login">Anmelden</a>
  </header><main><button type="button">Mit Import fortfahren</button></main></body>`, "landing.html"));
  expectVerdict(classify("Log in"), "ask", "change", "header button");
  expectVerdict(classify("Sign in"), "ask", "change", "link styled as a button");
  expectVerdict(classify("Anmelden"), "allow", "navigation", "plain link");
  expectVerdict(classify("Mit Import fortfahren"), "ask", "change", "Mit Import fortfahren");
});

test("a large list snapshot stays roughly linear", async () => {
  const rows = Array.from({ length: 600 }, (_, index) =>
    `<tr><td>Beleg ${index}</td><td>${(index * 37) % 1000},00 €</td><td><button type="button">Öffnen</button></td></tr>`).join("");
  const page = loadPage(`<!doctype html><body><h1>Belege</h1><table><thead><tr><th>Beleg</th><th>Betrag</th><th></th></tr></thead><tbody>${rows}</tbody></table></body>`, "belege.html");
  const started = performance.now();
  const snapshot = await bridge.snapshotPersonalBrowserPage(page.webContents);
  const elapsed = performance.now() - started;
  assert.equal(snapshot.interactive.length, 500);
  // Generous bound for slow CI machines; the quadratic walk took many seconds here.
  assert.ok(elapsed < 6_000, `snapshot took ${Math.round(elapsed)} ms`);
});
