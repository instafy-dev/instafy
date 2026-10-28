import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";

// What a control draws and the text beside it, as both browsers read them
// (@instafy/browser-action-policy's controlNameRulesInPage, which the Shared
// Browser joins into its page describer and the Personal Browser's page bridge
// runs in an isolated world). The live test of 2026-10-27 read a search
// button as "Pesquisa (shown as "image/svg+xml")": the text of the Inkscape
// svg inside it, which nothing draws.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const policy = require("@instafy/browser-action-policy/actionPolicy");
const bridge = require(path.join(packageRoot, "dist/personalBrowserPageBridge.js"));

const INKSCAPE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" viewBox="0 0 24 24">
  <defs><style>.a{fill:#000}</style></defs>
  <metadata><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format>
  <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/></cc:Work></rdf:RDF></metadata>
  <title>Lupa</title><desc>A magnifying glass</desc><path class="a" d="M1 1h2v2H1z"/></svg>`;

function page(body) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    url: "https://shop.test/case",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  return dom.window;
}

function rules(window) {
  return window.eval(`(${policy.controlNameRulesInPage.toString()})()`);
}

test("a control's shown text leaves out what never draws", () => {
  const window = page(`
    <button id="icon">${INKSCAPE_ICON}</button>
    <button id="drawn"><svg xmlns="http://www.w3.org/2000/svg"><text>Go</text><title>tooltip</title></svg></button>
    <button id="hidden"><span hidden>Secret</span>Save<script>var x = "script text"</script><style>.b{}</style><noscript>Enable JS</noscript></button>
    <button id="display"><span style="display:none">Hidden part</span> Open <b>now</b></button>
    <button id="foreign" aria-label="Cancel"><svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml">Delete account</div></foreignObject></svg></button>
    <style>.shown { display: inline }</style>
    <button id="unhidden" aria-label="Cancel"><span hidden class="shown">Delete account</span></button>`);
  const { shownTextOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  assert.equal(shownTextOf(byId("icon")), "");
  assert.match(byId("icon").textContent, /image\/svg\+xml/, "the raw text still holds the metadata");
  assert.equal(shownTextOf(byId("drawn")), "Go");
  assert.equal(shownTextOf(byId("hidden")), "Save");
  assert.equal(shownTextOf(byId("display")), "Open now");
  // An svg draws the HTML inside its foreignObject, and a `hidden` part the
  // page's own CSS shows is drawn too: a page cannot draw words outside the
  // shown text and so hide them from the "(shown as …)" a prompt adds when a
  // control's name and its drawn words differ.
  for (const id of ["foreign", "unhidden"]) {
    assert.equal(shownTextOf(byId(id)), "Delete account", id);
    assert.deepEqual(
      { ...policy.stepLabels({ ariaLabel: "Cancel", text: byId(id).textContent, shownText: shownTextOf(byId(id)) }) },
      { accessible: "Cancel", visible: "Delete account", differ: true },
      id,
    );
  }
});

test("the text beside an unnamed control is short plain text, never another control", () => {
  const window = page(`
    <div><span>Idioma</span><button id="language">${INKSCAPE_ICON}</button></div>
    <div><a href="/help">Help</a><button id="after-link"></button><span>Sair</span></div>
    <div>Menu <button id="parent-text"></button></div>
    <div><span>${"A long sentence that is far too long to name a control. ".repeat(2)}</span><button id="long"></button></div>
    <div><span hidden>Secret</span><button id="hidden-sibling"></button></div>
    <div><span>42</span><button id="digits"></button></div>`);
  const { nearbyTextOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  assert.equal(nearbyTextOf(byId("language")), "Idioma");
  assert.equal(nearbyTextOf(byId("after-link")), "Sair");
  assert.equal(nearbyTextOf(byId("parent-text")), "Menu");
  assert.equal(nearbyTextOf(byId("long")), "");
  assert.equal(nearbyTextOf(byId("hidden-sibling")), "");
  assert.equal(nearbyTextOf(byId("digits")), "");
});

test("names come from what a control draws, never from text that names nothing", () => {
  assert.equal(policy.isPlaceholderName("image/svg+xml"), true);
  assert.equal(policy.isPlaceholderName(" image/PNG "), true);
  assert.equal(policy.isPlaceholderName("application/pdf; charset=binary"), true);
  assert.equal(policy.isPlaceholderName("Pesquisa"), false);
  assert.equal(policy.isPlaceholderName("TCP/IP"), false);
  // Software writes a media type in lower case; a person's label that joins
  // two words with a slash names something.
  for (const label of ["Audio/Video", "Model/Year", "Text/SMS", "Image/Video"]) {
    assert.equal(policy.isPlaceholderName(label), false, label);
  }
  // The visible text is what the control draws, when the host reads it.
  assert.deepEqual(
    { ...policy.stepLabels({ ariaLabel: "Pesquisa", text: "image/svg+xml", shownText: "" }) },
    { accessible: "Pesquisa", visible: "", differ: false },
  );
  // A host that reads no shown text: a bare media type is still no name.
  assert.equal(policy.stepLabels({ ariaLabel: "Pesquisa", text: "image/svg+xml" }).differ, false);
  assert.deepEqual(
    { ...policy.stepLabels({ ariaLabel: "Delete workspace", text: "image/svg+xml Open", shownText: "Open" }) },
    { accessible: "Delete workspace", visible: "Open", differ: true },
  );
  assert.equal(
    policy.unnamedControlName({ tag: "button", nearby: "Idioma", position: "top right" }),
    "button next to “Idioma” in the top right",
  );
  assert.equal(policy.unnamedControlName({ tag: "button", image: "image/png", position: "top right" }), "unnamed button in the top right");
  // Its own icon names it before the text beside it does, and text beside it
  // that is an address or an email address is not used.
  assert.equal(
    policy.unnamedControlName({ tag: "button", nearby: "Idioma", iconHint: "icon-search", position: "top right" }),
    "search button in the top right",
  );
  assert.equal(policy.unnamedControlName({ tag: "a", nearby: "www.example.test" }), "unnamed link");
});

test("the Personal Browser reads an icon-only control's shown text without its svg metadata", async () => {
  const window = page(`<button type="button" aria-label="Pesquisa">${INKSCAPE_ICON}</button>`);
  // Chromium draws nothing as text for an icon-only button; jsdom has no
  // layout, so every element reads as drawn with no rendered text.
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 10, y: 10, width: 80, height: 30, top: 10, left: 10, right: 90, bottom: 40 };
  };
  window.document.elementFromPoint = () => window.document.body;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { configurable: true, get: () => "" });
  if (typeof window.crypto?.getRandomValues !== "function") {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
  const webContents = {
    async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
      return window.eval(scripts[0].code);
    },
  };
  const snapshot = await bridge.snapshotPersonalBrowserPage(webContents);
  const descriptor = snapshot.interactive[0].descriptor;
  assert.equal(descriptor.shownText, "");
  // Risk words still read every text inside the control.
  assert.match(descriptor.text, /image\/svg\+xml/);
  assert.equal(policy.stepLabels(descriptor).differ, false);
  assert.equal(policy.stepLabels(descriptor).accessible, "Pesquisa");
});
