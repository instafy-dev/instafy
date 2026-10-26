import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// @instafy/browser-action-policy/pageCapture.js, the reader the Shared
// Browser's origin evaluates in an isolated world of the page for Send page to
// Octo. Here it runs the same way: both plain scripts evaluated in a page,
// publishing their API on the page's global object.

const require = createRequire(import.meta.url);
const policyRoot = path.dirname(require.resolve("@instafy/browser-action-policy/redaction"));
const redactionSource = fs.readFileSync(path.join(policyRoot, "redaction.js"), "utf8");
const pageCaptureSource = fs.readFileSync(path.join(policyRoot, "pageCapture.js"), "utf8");
// Key-shaped samples are assembled at run time, so none is committed whole.
const join = (...parts) => parts.join("");
const KEY = join("sk", "-proj-", "AbCdEfGhIjKlMnOp", "QrStUvWxYz0123456789");
const RANDOM_VALUE = join("abc123DEF456", "ghi789JKL012mno345");

function capture(html, { url = "https://shop.example/orders/42", withhold = false } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  window.eval(`(function (module, require) {\n${redactionSource}\n})(undefined, undefined);`);
  window.eval(`(function (module, require) {\n${pageCaptureSource}\n})(undefined, undefined);`);
  // Out of the page's realm, the way CDP returns a value.
  return JSON.parse(window.eval(
    `JSON.stringify(globalThis.__instafyBrowserPageCapture.captureSentPage(globalThis.__instafyBrowserRedaction, { withhold: ${withhold} }))`,
  ));
}

test("a sent page keeps its text and masks keys in the text, title and address", () => {
  const page = capture(
    `<title>Order 42</title><main><h1>Your order</h1><p>Ships Monday.</p><p>Hook: ${KEY}</p></main>`,
    { url: `https://shop.example/orders/42?token=${KEY}` },
  );
  assert.equal(page.secretScreen, false);
  assert.equal(page.title, "Order 42");
  assert.match(page.text, /Your order/);
  assert.match(page.text, /Ships Monday\./);
  assert.match(page.text, /Hook: \[redacted secret\]/);
  assert.ok(!JSON.stringify(page).includes(KEY));
  assert.equal(page.url, "https://shop.example/orders/42?token=REDACTED");
});

test("a page that shows a credential sends no title or text", () => {
  for (const html of [
    // A read-only field holding a key.
    `<title>Settings</title><label>Deploy</label><input readonly value="${KEY}">`,
    // Masked text beside a reveal control.
    `<title>Account</title><div><span>••••••••••••</span><button>Reveal</button></div>`,
    // A credential heading over a key-like value.
    `<title>Console</title><h2>API keys</h2><p>${RANDOM_VALUE}</p>`,
  ]) {
    const page = capture(html);
    assert.equal(page.secretScreen, true, html);
    assert.equal(page.text, "", html);
    assert.equal(page.title, "", html);
  }
  // Withheld by the browser already (the agent's controller marked it).
  const withheld = capture("<title>Plain</title><p>Nothing secret.</p>", { withhold: true });
  assert.equal(withheld.secretScreen, true);
  assert.equal(withheld.text, "");
});

test("only http and https pages are read", () => {
  assert.deepEqual(capture("<p>Hi</p>", { url: "file:///etc/hosts" }), { unsupported: true });
});

test("the Shared Browser's agent snapshots and the sent page share one secret check", () => {
  const pageCapture = require("@instafy/browser-action-policy/pageCapture");
  const cli = fs.readFileSync(
    path.resolve(policyRoot, "../runtime-agent/assets/shared-browser-cli.js"),
    "utf8",
  );
  assert.equal(typeof pageCapture.pageSecretSignalsInPage, "function");
  assert.match(cli, /const pageSecretSignalsInPage = pageCapture\.pageSecretSignalsInPage;/);
  assert.doesNotMatch(cli, /function pageSecretSignalsInPage\(/);
});
