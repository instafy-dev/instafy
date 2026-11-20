import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
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

test("an unnamed control is named by the first words of its row or card, so the alike controls of a list read apart", () => {
  // A ticket page's reading listed its rows' buttons as "unnamed button",
  // none told apart: a row's "+" is "+ beside “Adult”", and a card's arrow
  // "button beside “Museum entrance”". Never another control's words, a
  // field's value, hidden words, or the words of a part as big as a page.
  const window = page(`
    <div><p><span>Adult</span> <span>22.50 euros</span></p><p><button id="adult-less">\u2212</button> <span>0</span> <button id="adult-more">+</button></p></div>
    <div><p><a href="/child">More about it</a> <span>Child</span></p><p><button id="child-more"></button></p></div>
    <article><h3>Museum entrance</h3><p>The permanent collection</p><div><button id="card"></button></div></article>
    <div><span hidden>Secret row</span><p><button id="hidden-row"></button></p></div>
    <section><div contenteditable="true">Draft words</div><div><button id="beside-editable"></button></div></section>
    <div><p>${"A part far too long to be a row or a card. ".repeat(12)}</p><p><button id="long-row"></button></p></div>
    <div><p>An admission ticket for the whole day, with the audio tour</p><p><button id="long-words"></button></p></div>
    <button id="alone"></button>`);
  const { rowTextOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  assert.equal(rowTextOf(byId("adult-less")), "Adult");
  assert.equal(rowTextOf(byId("adult-more")), "Adult");
  assert.equal(rowTextOf(byId("child-more")), "Child");
  assert.equal(rowTextOf(byId("card")), "Museum entrance");
  for (const id of ["hidden-row", "beside-editable", "long-row", "alone"]) {
    assert.equal(rowTextOf(byId(id)), "", id);
  }
  // Cut between words.
  assert.equal(rowTextOf(byId("long-words")), "An admission ticket for the whole day,");
  // A row's words name a control with no name, or one named only by marks,
  // which it shows: neither for one with a name of its own.
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "+", row: "Adult" }), "+ beside \u201cAdult\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "\u2212", row: "Adult", position: "middle" }), "\u2212 beside \u201cAdult\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", row: "Museum entrance", position: "middle" }), "button beside \u201cMuseum entrance\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", iconHint: "icon-plus", row: "Child" }), "add button beside \u201cChild\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", image: "Plus", row: "Child" }), "Plus button beside \u201cChild\u201d");
  // The text right beside it comes first, and a tooltip names it whole.
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "+", nearby: "Adult", row: "Tickets" }), "+ next to \u201cAdult\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", nearby: "Idioma", row: "Language" }), "button next to \u201cIdioma\u201d");
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "\u00d7", tooltip: "Close", row: "Your basket" }), "Close");
  // With no row, marks alone stay its name, and an unnamed control is placed
  // as before; a row's words that are an address are not used.
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "+" }), "+");
  assert.equal(policy.unnamedControlName({ tag: "button", row: "alex@example.test", position: "top right" }), "unnamed button in the top right");
  assert.equal(policy.unnamedControlName({ tag: "button", row: "www.example.test" }), "unnamed button");
  // A profile picture keeps its place.
  assert.equal(
    policy.unnamedControlName({ tag: "button", iconHint: "avatar", hasImage: true, row: "Welcome back", position: "top right" }),
    "profile picture button in the top right",
  );
  // Words and digits are a name, never marks: they keep it.
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "2", row: "Results" }), "button beside \u201cResults\u201d");
});

test("an unnamed control with no row's words is named by the heading of its card, across shadow roots too", () => {
  // A guided ticket page's reading listed its product cards' controls as
  // "unnamed button"s, never told apart, beside the basket's, as buttons
  // whose words sit across a shadow root from the cards' read, and the turn
  // pressed the basket's button for a card's. A card larger than a row has
  // no first words to use either. The
  // card is the nearest element around the control that holds one heading,
  // as the page draws it; none when it holds more, is the page's main part,
  // or is as big as a page part, and never the page's own title.
  const long = "Bezoek de vaste collectie met schilderijen uit vijf eeuwen. ".repeat(9);
  const window = page(`
    <nav class="products">
      <div class="product"><h3>Entree museum + wintertentoonstelling</h3><p>Bezoek de tentoonstelling</p><ticket-cta id="slotted-host">Tickets</ticket-cta></div>
      <ticket-card id="card-host" heading="Entree museum"><button id="slotted-button" type="button"></button></ticket-card>
      <div class="product"><h3>Entree tuinen</h3><p>${long}</p><div><button id="long" type="button"></button></div></div>
    </nav>
    <section><h2>Openingstijden</h2><h2>Prijzen</h2><div><button id="two-headings" type="button"></button></div></section>
    <div><h2 hidden>Verborgen</h2><div><button id="hidden-heading" type="button"></button></div></div>
    <div><h1>Het museum</h1><div><button id="title" type="button"></button></div></div>
    <main><div><h3>Inside the main part</h3></div><div><button id="main" type="button"></button></div></main>
    <div><h4>${"A heading far longer than any name should be, with many words ".repeat(2)}</h4><div><button id="long-heading" type="button"></button></div></div>`);
  window.customElements.define("ticket-cta", class extends window.HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = '<button type="button"><slot></slot></button>';
    }
  });
  window.customElements.define("ticket-card", class extends window.HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<h3>${this.getAttribute("heading")}</h3><p>Bezoek de vaste collectie</p><span>Tickets</span><slot></slot>`;
    }
  });
  const { cardHeadingOf, rowTextOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  const shadowButton = byId("slotted-host").shadowRoot.querySelector("button");
  // None has a row's words, which left each one unnamed.
  for (const element of [shadowButton, byId("slotted-button"), byId("long")]) {
    assert.equal(rowTextOf(element), "");
  }
  assert.equal(cardHeadingOf(shadowButton), "Entree museum + wintertentoonstelling");
  assert.equal(cardHeadingOf(byId("slotted-button")), "Entree museum");
  assert.equal(cardHeadingOf(byId("long")), "Entree tuinen");
  for (const id of ["two-headings", "hidden-heading", "title", "main"]) {
    assert.equal(cardHeadingOf(byId(id)), "", id);
  }
  // Cut between words.
  assert.equal(cardHeadingOf(byId("long-heading")), "A heading far longer than any name should be, with many");
  // Of an icon inside the heading, only what it draws: its metadata named a
  // card's button "image/svg+xml…".
  const iconed = page(`<div class="product"><h3>${INKSCAPE_ICON} Entree museum</h3><p>Bezoek de vaste collectie</p><div><button id="iconed" type="button"></button></div></div>`);
  assert.equal(rules(iconed).cardHeadingOf(iconed.document.getElementById("iconed")), "Entree museum");
  // The heading names it only with no words of its own, and after the
  // words beside it and its row's.
  assert.equal(policy.unnamedControlName({ tag: "button", card: "Entree museum", position: "top right" }), "button in “Entree museum”");
  assert.equal(policy.unnamedControlName({ tag: "button", marks: "+", card: "Entree museum" }), "+ in “Entree museum”");
  assert.equal(policy.unnamedControlName({ tag: "button", image: "Pijl", card: "Entree museum" }), "Pijl button in “Entree museum”");
  assert.equal(policy.unnamedControlName({ tag: "button", iconHint: "icon-plus", card: "Entree museum" }), "add button in “Entree museum”");
  assert.equal(policy.unnamedControlName({ tag: "button", row: "Adult", card: "Entree museum" }), "button beside “Adult”");
  assert.equal(policy.unnamedControlName({ tag: "button", nearby: "Tickets", card: "Entree museum" }), "button next to “Tickets”");
  assert.equal(policy.unnamedControlName({ tag: "button", tooltip: "Kies tickets", card: "Entree museum" }), "Kies tickets");
  // Never an address, a key or a heading longer than a name holds.
  assert.equal(policy.unnamedControlName({ tag: "button", card: "www.example.test", position: "middle" }), "unnamed button in the middle");
  assert.equal(policy.unnamedControlName({ tag: "button", card: "A heading far longer than any name should be, with many words in it" }), "unnamed button");
  const key = createHash("sha256").update("a card's key").digest("base64url");
  assert.equal(policy.unnamedControlName({ tag: "button", card: key }), "unnamed button");
});

test("the controls of one reading share what the parts of the page around them answer for a card's heading", () => {
  // A seat map's hundreds of unnamed seats, with no row's words, each walked
  // the same parts of the page for a heading, and its reading took twice as
  // long. Given one reading's shared pass, each part is worked out once, and
  // the names are the same.
  const seats = Array.from({ length: 60 }, (_, at) => `<div role="button" tabindex="0" id="seat-${at}"></div>`).join("");
  const window = page(`
    <div class="product"><h3>Entree museum</h3><p>Bezoek de vaste collectie</p><div><button id="first" type="button"></button> <button id="second" type="button"></button></div></div>
    <div class="product"><h3>Entree tuinen</h3><div><button id="inner" type="button"><h4></h4></button></div></div>
    <section>${"<div>".repeat(4)}${seats}${"</div>".repeat(4)}</section>`);
  const { cardHeadingOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  let styles = 0;
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (...args) => {
    styles += 1;
    return computed(...args);
  };
  const named = (pass) => {
    styles = 0;
    const names = Array.from({ length: 60 }, (_, at) => cardHeadingOf(byId(`seat-${at}`), 60, pass));
    return { names, styles };
  };
  const alone = named(null);
  const shared = named(new window.Map());
  assert.deepEqual(shared.names, alone.names);
  assert.ok(alone.names.every((name) => name === ""), "a seat map is no card");
  assert.ok(shared.styles > 0 && shared.styles * 20 < alone.styles, `shared ${shared.styles}, each alone ${alone.styles}`);
  // The same names with a shared pass as without: two controls of one card,
  // and a control that holds a heading of its own, which is never its card's.
  const pass = new window.Map();
  for (const id of ["first", "second", "inner"]) {
    assert.equal(cardHeadingOf(byId(id), 60, pass), cardHeadingOf(byId(id)), id);
  }
  assert.equal(cardHeadingOf(byId("first"), 60, pass), "Entree museum");
  assert.equal(cardHeadingOf(byId("inner"), 60, pass), "Entree tuinen");
});

test("a row's words and the text beside a control name it whole, never cut, and never as a value the redaction rules mask", () => {
  // A key the page's text masked ("[redacted secret]") named the icon button
  // beside it by its first 40 characters: a key cut short is no value the
  // redaction rules know, and a name quoting a whole one lacks the words
  // around it ("Deploy key") that mask it in the page's text. Key-shaped
  // values are made here, so the source holds none.
  const digest = (seed, encoding) => createHash("sha256").update(seed).digest(encoding);
  const longKey = digest("a deploy key", "base64url");
  const hexKey = digest("a signing key", "hex");
  const shortKey = digest("an access key", "base64url").slice(0, 32);
  const window = page(`
    <div><p><code>${longKey}</code></p><p><button id="long-key"></button></p></div>
    <div><p><code>${hexKey}</code> rotated today</p><p><button id="hex-key"></button></p></div>
    <div><p>Deploy key ${longKey}</p><p><button id="after-words"></button></p></div>`);
  const { rowTextOf } = rules(window);
  const byId = (id) => window.document.getElementById(id);
  assert.equal(rowTextOf(byId("long-key")), "");
  assert.equal(rowTextOf(byId("hex-key")), "");
  assert.equal(rowTextOf(byId("after-words")), "Deploy key");
  for (const key of [shortKey, digest("an access key", "hex").slice(0, 40), `Key ${shortKey}`]) {
    assert.equal(policy.unnamedControlName({ tag: "button", row: key, position: "middle" }), "unnamed button in the middle");
    assert.equal(policy.unnamedControlName({ tag: "button", nearby: key }), "unnamed button");
    assert.equal(policy.unnamedControlName({ tag: "button", marks: "+", row: key }), "+");
    assert.equal(policy.unnamedControlName({ tag: "button", iconHint: "icon-pencil", row: key }), "edit button");
  }
  // Words longer than a name holds are left out whole, never cut into one.
  assert.equal(
    policy.unnamedControlName({ tag: "button", row: "An admission ticket for the whole day, with the audio tour" }),
    "unnamed button",
  );
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

test("the Personal Browser names a list by its own label or the option it holds, never by its options", async () => {
  const window = page(`
    <label>Start <select name="start"><option>24 Agosto</option><option selected>Aliados</option><option>São Bento</option></select></label>
    <select name="line"><option>All lines</option><option>Line A</option></select>`);
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 10, y: 10, width: 80, height: 30, top: 10, left: 10, right: 90, bottom: 40 };
  };
  window.document.elementFromPoint = () => window.document.body;
  // Chromium's rendered text of a select lists every option, one per line.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
  });
  if (typeof window.crypto?.getRandomValues !== "function") {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
  const webContents = {
    async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
      return window.eval(scripts[0].code);
    },
  };
  const snapshot = await bridge.snapshotPersonalBrowserPage(webContents);
  const [start, line] = snapshot.interactive.map((entry) => entry.descriptor);
  // A label that holds the list is read without the list's options.
  assert.equal(start.ariaLabel, "Start");
  assert.equal(start.shownText, "Aliados");
  assert.equal(policy.stepLabels(start).accessible, "Start");
  // A list with no label of its own is named by the option it holds.
  assert.equal(line.ariaLabel, "");
  assert.equal(line.shownText, "All lines");
  assert.equal(policy.stepLabels(line).accessible, "All lines");
  // Risk words still read every text inside a list.
  assert.match(start.text, /São Bento/u);
});
