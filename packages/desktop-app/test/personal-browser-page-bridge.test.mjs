import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const bridge = await import(path.join(packageRoot, "dist", "personalBrowserPageBridge.js"));
const security = await import(path.join(packageRoot, "dist", "personalBrowserSecurity.js"));

function createPageHarness() {
  let nextX = 10;
  let focused = null;

  class Element {
    constructor(tag, attributes = {}) {
      this.tagName = tag.toUpperCase();
      this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
      this.id = this.attributes.get("id") ?? "";
      this.innerText = this.attributes.get("text") ?? "";
      this.textContent = this.innerText;
      this.labels = [];
      this.disabled = false;
      this.isContentEditable = false;
      this.clickCount = 0;
      this.events = [];
      this.style = { outline: "", outlineOffset: "" };
      this.rect = { x: nextX, y: 10, width: 80, height: 30 };
      nextX += 100;
      this.onFocus = null;
      this.ancestorForm = null;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    getBoundingClientRect() {
      return {
        ...this.rect,
        top: this.rect.y,
        right: this.rect.x + this.rect.width,
        bottom: this.rect.y + this.rect.height,
        left: this.rect.x,
      };
    }

    matches(selector) {
      if (selector === "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']") return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName);
      if (selector === "iframe, frame, object, embed") return false;
      if (selector === "button, input[type='button'], input[type='submit']") {
        return this.tagName === "BUTTON" ||
          (this.tagName === "INPUT" && ["button", "submit"].includes(this.type));
      }
      return false;
    }

    closest(selector) {
      if (selector === "a[href]" && this instanceof HTMLAnchorElement) return this;
      if (selector === "form") return this.ancestorForm;
      // Role lists ("[role=listbox], [role=tree]"), up the elements a test
      // set as each one's `parent`.
      const roles = selector.split(",").map((part) => /^\s*\[role=(\w+)\]\s*$/.exec(part)?.[1]);
      if (roles.every(Boolean)) {
        for (let node = this; node; node = node.parent) {
          if (roles.includes(node.getAttribute("role"))) return node;
        }
      }
      return null;
    }

    contains(candidate) {
      return candidate === this;
    }

    focus() {
      focused = this;
      this.onFocus?.();
    }

    blur() {
      if (focused === this) focused = null;
    }

    click() {
      this.clickCount += 1;
    }

    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    }
  }

  class HTMLElement extends Element {}
  class HTMLButtonElement extends HTMLElement {
    constructor(attributes = {}) {
      super("button", attributes);
      const type = this.attributes.get("type")?.toLowerCase();
      this.type = ["button", "reset", "submit"].includes(type) ? type : "submit";
      this.form = null;
    }
  }
  class HTMLInputElement extends HTMLElement {
    constructor(attributes = {}) {
      super("input", attributes);
      this.type = this.attributes.get("type") ?? "text";
      this._value = "";
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.form = null;
    }

    get value() {
      return this._value;
    }

    set value(value) {
      this._value = String(value);
      this.selectionStart = this._value.length;
      this.selectionEnd = this._value.length;
    }

    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }
  class HTMLTextAreaElement extends HTMLElement {
    constructor(attributes = {}) {
      super("textarea", attributes);
      this._value = "";
      this.form = null;
    }

    get value() {
      return this._value;
    }

    set value(value) {
      this._value = String(value);
    }
  }
  class HTMLAnchorElement extends HTMLElement {
    constructor(attributes = {}) {
      super("a", attributes);
      this.href = this.attributes.get("href") ?? "";
    }
  }
  class HTMLFormElement extends HTMLElement {
    constructor(attributes = {}) {
      super("form", attributes);
      this.submissions = 0;
      this.elements = [];
    }

    querySelector() {
      return null;
    }

    requestSubmit() {
      this.submissions += 1;
    }
  }
  class InputEvent {
    constructor(type) {
      this.type = type;
    }
  }
  class DOMEvent {
    constructor(type) {
      this.type = type;
    }
  }
  class KeyboardEvent extends DOMEvent {}

  const document = {
    title: "Atomic target fixture",
    body: { innerText: "fixture" },
    elements: [],
    // Non-interactive elements are only visible to whole-page scans.
    passive: [],
    // Frames and canvases, which a reading names instead of reading.
    unread: [],
    querySelectorAll(selector) {
      for (const element of [...this.elements, ...this.unread]) element.ownerDocument = this;
      if (selector === "iframe, frame, object, embed, canvas") return this.unread;
      return selector === "*" ? [...this.elements, ...this.passive] : this.elements;
    },
    getElementById(id) {
      return this.elements.find((element) => element.id === id) ?? null;
    },
    elementFromPoint(x, y) {
      return this.elements.find((element) => {
        const rect = element.rect;
        return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
      }) ?? null;
    },
  };
  const context = vm.createContext({
    crypto: webcrypto,
    URL,
    document,
    location: { href: "https://example.test/form" },
    innerWidth: 1_200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    scrollBy() {},
    getComputedStyle: (element) => ({ visibility: "visible", display: "block", pointerEvents: "auto", ...element?.style?.computed }),
    Element,
    HTMLElement,
    HTMLButtonElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLAnchorElement,
    HTMLFormElement,
    InputEvent,
    Event: DOMEvent,
    KeyboardEvent,
  });
  const webContents = {
    async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
      return vm.runInContext(scripts[0].code, context);
    },
  };
  return {
    bridge,
    document,
    webContents,
    Element,
    HTMLElement,
    HTMLButtonElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLAnchorElement,
    HTMLFormElement,
  };
}

function expectationFor(descriptor) {
  return {
    identity: descriptor.identity,
    securityFingerprint: security.personalBrowserTargetSecurityFingerprint(descriptor),
  };
}

test("native descriptors retain external form ownership and respect the submission approval mode", async () => {
  const harness = createPageHarness();
  const form = new harness.HTMLFormElement({ "aria-label": "Details" });
  const controls = [
    new harness.HTMLButtonElement({ text: "Continue" }),
    new harness.HTMLButtonElement({ type: "submit", text: "Continue" }),
    new harness.HTMLButtonElement({ type: "unknown", text: "Continue" }),
    new harness.HTMLInputElement({ type: "text", "aria-label": "Notes" }),
  ];
  form.elements = controls;
  for (const control of controls) control.form = form;
  harness.document.elements = controls;
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.interactive.length, controls.length);
  const formIdentity = snapshot.interactive[0].descriptor.formOwnerIdentity;
  assert.ok(formIdentity);
  for (const [index, item] of snapshot.interactive.entries()) {
    assert.equal(item.descriptor.formOwnerIdentity, formIdentity);
    assert.equal(item.descriptor.formActionText, "Continue");
    if (index < 3) {
      assert.equal(item.descriptor.type, "submit");
      assert.equal(security.personalBrowserActivationRequiresConfirmation(item.descriptor, "ask"), true);
      // Owner tier: every submit asks in routine too.
      assert.equal(security.personalBrowserActivationRequiresConfirmation(item.descriptor, "routine"), true);
    } else {
      assert.equal(security.personalBrowserKeyRequiresConfirmation("Enter", item.descriptor), true);
      assert.equal(security.personalBrowserKeyRequiresConfirmation("Enter", item.descriptor, "routine"), true);
    }
  }
});

test("non-submitting buttons ask in routine and native no-owner state does not inherit an ancestor form", async () => {
  const harness = createPageHarness();
  const form = new harness.HTMLFormElement({ "aria-label": "Details" });
  const ordinary = new harness.HTMLButtonElement({ type: "button", text: "Show details" });
  const reset = new harness.HTMLButtonElement({ type: "reset", text: "Start again" });
  ordinary.form = reset.form = form;
  form.elements = [ordinary, reset];
  const withoutOwner = new harness.HTMLButtonElement({ text: "Show details" });
  withoutOwner.ancestorForm = form;
  harness.document.elements = [ordinary, reset, withoutOwner];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.ok(snapshot.interactive[0].descriptor.formOwnerIdentity);
  assert.ok(snapshot.interactive[1].descriptor.formOwnerIdentity);
  assert.equal(snapshot.interactive[2].descriptor.formOwnerIdentity, "");
  assert.equal(snapshot.interactive[2].descriptor.formActionText, "");
  // Owner tier: a button that is not a menu, tab or dismissal asks.
  for (const { descriptor } of snapshot.interactive) {
    assert.equal(security.personalBrowserActivationRequiresConfirmation(descriptor, "routine"), true);
  }
});

test("form ownership is part of the fresh target fingerprint independently of its display label", async () => {
  const harness = createPageHarness();
  const originalForm = new harness.HTMLFormElement({ "aria-label": "Details" });
  const otherForm = new harness.HTMLFormElement({ "aria-label": "Details" });
  const button = new harness.HTMLButtonElement({ type: "submit", text: "Continue" });
  button.form = originalForm;
  originalForm.elements = [button];
  harness.document.elements = [button];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  const original = snapshot.interactive[0].descriptor;
  button.form = otherForm;
  otherForm.elements = [button];
  const inspected = await bridge.inspectPersonalBrowserTarget(harness.webContents, { index: 0 });
  assert.equal(inspected.formActionText, original.formActionText);
  assert.notEqual(inspected.formOwnerIdentity, original.formOwnerIdentity);
  assert.notEqual(security.personalBrowserTargetSecurityFingerprint(inspected), security.personalBrowserTargetSecurityFingerprint(original));
});

test("manual guidance outlines fresh fields without reading or changing values and clears on resume", async () => {
  const harness = createPageHarness();
  const input = new harness.HTMLInputElement({ type: "password" });
  input.value = "private-user-entry";
  harness.document.elements = [input];
  const snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  const highlighted = await harness.bridge.highlightPersonalBrowserHumanInput(harness.webContents, [
    { index: 0, expectation: expectationFor(snapshot.interactive[0].descriptor) },
  ]);
  assert.equal(highlighted, true);
  assert.equal(input.value, "private-user-entry");
  assert.equal(input.style.outline, "3px solid #f59e0b");
  input.rect.x += 50;
  assert.equal(input.style.outline, "3px solid #f59e0b");
  await harness.bridge.clearPersonalBrowserHumanInput(harness.webContents);
  assert.equal(input.style.outline, "");
  assert.equal(input.style.outlineOffset, "");
  assert.equal(input.value, "private-user-entry");
});

test("manual guidance rejects a field replaced since the observed snapshot", async () => {
  const harness = createPageHarness();
  const input = new harness.HTMLInputElement({ type: "password" });
  harness.document.elements = [input];
  const snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  const replacement = new harness.HTMLInputElement({ type: "password" });
  harness.document.elements = [replacement];
  assert.equal(await harness.bridge.highlightPersonalBrowserHumanInput(harness.webContents, [
    { index: 0, expectation: expectationFor(snapshot.interactive[0].descriptor) },
  ]), false);
  assert.equal(replacement.style.outline, "");
});

test("isolated click rejects an adversarial index reorder before dispatching click", async () => {
  const harness = createPageHarness();
  const safe = new harness.HTMLElement("button", { text: "Continue" });
  const replacement = new harness.HTMLElement("button", { text: "Delete account" });
  harness.document.elements = [safe, replacement];
  const snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.interactive.length, 2, JSON.stringify(snapshot));

  harness.document.elements = [replacement, safe];
  const result = await harness.bridge.clickPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    expectationFor(snapshot.interactive[0].descriptor),
  );

  assert.equal(result.targetChanged, true);
  assert.equal(result.clicked, false);
  assert.equal(safe.clickCount, 0);
  assert.equal(replacement.clickCount, 0);
});

test("matching isolated targets still click, type, and apply editable key defaults", async () => {
  const harness = createPageHarness();
  const button = new harness.HTMLElement("button", { text: "Continue" });
  harness.document.elements = [button];
  let snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  const clicked = await harness.bridge.clickPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    expectationFor(snapshot.interactive[0].descriptor),
  );
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.targetChanged, false);
  assert.equal(button.clickCount, 1);

  const input = new harness.HTMLInputElement({ id: "query", text: "Search" });
  harness.document.elements = [input];
  snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  const typed = await harness.bridge.typeIntoPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    "hello",
    expectationFor(snapshot.interactive[0].descriptor),
  );
  assert.equal(typed.typed, true);
  assert.equal(typed.targetChanged, false);
  assert.equal(input.value, "hello");

  snapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  const pressed = await harness.bridge.pressPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    "Backspace",
    expectationFor(snapshot.interactive[0].descriptor),
  );
  assert.equal(pressed.pressed, true);
  assert.equal(pressed.targetChanged, false);
  assert.equal(input.value, "hell");
});

test("isolated type and press recheck identity after hostile focus-time DOM replacement", async () => {
  const harness = createPageHarness();
  const safeInput = new harness.HTMLInputElement({ id: "query", text: "Search" });
  const secretInput = new harness.HTMLInputElement({
    id: "password",
    type: "password",
    text: "Password",
  });
  harness.document.elements = [safeInput];
  const typeSnapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(typeSnapshot.interactive.length, 1, JSON.stringify(typeSnapshot));
  safeInput.onFocus = () => {
    harness.document.elements = [secretInput];
  };

  const typed = await harness.bridge.typeIntoPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    "must-not-land",
    expectationFor(typeSnapshot.interactive[0].descriptor),
  );
  assert.equal(typed.targetChanged, true);
  assert.equal(typed.typed, false);
  assert.equal(safeInput.value, "");
  assert.equal(secretInput.value, "");

  const safeButton = new harness.HTMLElement("button", { text: "Continue" });
  const deleteButton = new harness.HTMLElement("button", { text: "Delete account" });
  harness.document.elements = [safeButton];
  const pressSnapshot = await harness.bridge.snapshotPersonalBrowserPage(harness.webContents);
  safeButton.onFocus = () => {
    harness.document.elements = [deleteButton];
  };
  const pressed = await harness.bridge.pressPersonalBrowserTarget(
    harness.webContents,
    { index: 0 },
    "Enter",
    expectationFor(pressSnapshot.interactive[0].descriptor),
  );
  assert.equal(pressed.targetChanged, true);
  assert.equal(pressed.pressed, false);
  assert.equal(safeButton.clickCount, 0);
  assert.equal(deleteButton.clickCount, 0);
});

const CANARY = ["sk", "test", ["INSTAFY", "CANARY", "7Qm2Xr9Lp4Vb8Nc1"].join("")].join("_");

test("page secret signals answer yes or no and never return the value", async () => {
  const harness = createPageHarness();
  const field = new harness.HTMLInputElement({ type: "text", readonly: "", "aria-label": "Client Secret" });
  field.value = CANARY;
  harness.document.elements = [field];
  let snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual({ ...snapshot.signals }, {
    credentialContext: false,
    secretField: true,
    secretCode: false,
    maskedNearReveal: false,
  });
  assert.ok(!JSON.stringify(snapshot).includes(CANARY));

  field.value = "Ada Lovelace";
  snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.signals.secretField, false, "an ordinary read-only value is not a secret");
});

test("page secret signals find code blocks, credential headings and masked values next to reveal controls", async () => {
  const harness = createPageHarness();
  const heading = new harness.Element("h2", { text: "API-Schlüssel" });
  const code = new harness.Element("code", { text: CANARY });
  const row = new harness.Element("div", { text: "Instafy Bot •••••••• Anzeigen" });
  const reveal = new harness.HTMLButtonElement({ type: "button", text: "Anzeigen" });
  reveal.parentElement = row;
  harness.document.passive = [heading, code, row];
  harness.document.elements = [reveal];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual({ ...snapshot.signals }, {
    credentialContext: true,
    secretField: false,
    secretCode: true,
    maskedNearReveal: true,
  });
  assert.ok(!JSON.stringify(snapshot).includes(CANARY));
});

test("page secret signals look inside open shadow roots", async () => {
  const harness = createPageHarness();
  const host = new harness.Element("app-key-view", {});
  const hidden = new harness.HTMLInputElement({ type: "text", readonly: "" });
  hidden.value = CANARY;
  host.shadowRoot = { querySelectorAll: () => [hidden] };
  harness.document.passive = [host];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.signals.secretField, true);
  assert.ok(!JSON.stringify(snapshot).includes(CANARY));
});

test("opening a menu keeps the target fingerprint; only the opener's presence is bound", async () => {
  const harness = createPageHarness();
  const opener = new harness.HTMLButtonElement({ type: "button", text: "More actions", "aria-haspopup": "menu", "aria-expanded": "false" });
  harness.document.elements = [opener];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  const before = snapshot.interactive[0].descriptor;
  assert.equal(before.menuOpener, true);
  opener.attributes.set("aria-expanded", "true");
  const after = await bridge.inspectPersonalBrowserTarget(harness.webContents, { index: 0 });
  assert.equal(after.menuOpener, true);
  assert.equal(
    security.personalBrowserTargetSecurityFingerprint(after),
    security.personalBrowserTargetSecurityFingerprint(before),
  );
});

test("a toggle naming the region it controls, or a Bootstrap toggle, is an opener; a dangling reference is not", async () => {
  const harness = createPageHarness();
  const sidebar = new harness.Element("div", { id: "sidebar", role: "button", text: "Seitenleiste" });
  const toggle = new harness.HTMLButtonElement({ type: "button", title: "Menü ein-/ausklappen", "aria-controls": "sidebar" });
  const collapse = new harness.HTMLButtonElement({ type: "button", text: "Filter", "data-bs-toggle": "collapse" });
  const dangling = new harness.HTMLButtonElement({ type: "button", text: "Filter", "aria-controls": "missing" });
  harness.document.elements = [toggle, collapse, dangling, sidebar];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual(Array.from(snapshot.interactive.slice(0, 3), (item) => item.descriptor.menuOpener), [true, true, false]);
  assert.equal(security.classifyPersonalBrowserStep("click", snapshot.interactive[0].descriptor).category, "disclosure");
});

test("descriptors carry form, link and page-area structure for the step classifier", async () => {
  const harness = createPageHarness();
  const form = new harness.HTMLFormElement({ method: "POST" });
  const email = new harness.HTMLInputElement({ type: "email", autocomplete: "username" });
  const password = new harness.HTMLInputElement({ type: "password" });
  const submit = new harness.HTMLButtonElement({ type: "submit", text: "Sign in" });
  const other = new harness.HTMLButtonElement({ type: "submit", text: "Create account" });
  form.elements = [email, password, submit, other];
  for (const control of form.elements) control.form = form;
  const link = new harness.HTMLAnchorElement({ href: "https://example.test/report.csv", text: "Report", download: "" });
  const nav = new harness.Element("nav", {});
  const row = new harness.Element("tr", { text: "API-Schlüssel •••••••• Anzeigen" });
  const reveal = new harness.HTMLButtonElement({ type: "button", text: "Anzeigen" });
  reveal.parentElement = row;
  row.parentElement = nav;
  harness.document.elements = [submit, link, reveal];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  const [signIn, report, revealDescriptor] = snapshot.interactive.map((entry) => entry.descriptor);
  assert.equal(signIn.formMethod, "post");
  assert.equal(signIn.formHasPassword, true);
  assert.equal(signIn.formFieldCount, 2);
  assert.equal(signIn.formSubmitLabels, "Sign in | Create account");
  assert.equal(report.linkSelf, true);
  assert.equal(report.download, true);
  assert.equal(revealDescriptor.row, true);
  assert.equal(revealDescriptor.areas, "nav");
  assert.equal(revealDescriptor.credentialContext, true);
  assert.equal(revealDescriptor.nearMaskedText, true);
  assert.equal(security.classifyPersonalBrowserStep("click", signIn).code, "step_refused_sign_in");
  assert.equal(security.classifyPersonalBrowserStep("click", revealDescriptor).code, "step_refused_secret");
  assert.equal(security.classifyPersonalBrowserStep("click", report).category, "download");
});

test("a link that sends a request or runs a declared script is not a plain link", async () => {
  const harness = createPageHarness();
  const plain = new harness.HTMLAnchorElement({ href: "https://example.test/items/5", text: "Item 5" });
  const railsDelete = new harness.HTMLAnchorElement({ href: "https://example.test/items/5", text: "Remove item", "data-method": "delete" });
  const turbo = new harness.HTMLAnchorElement({ href: "https://example.test/items/5", text: "Item", "data-turbo-method": "post" });
  const scripted = new harness.HTMLAnchorElement({ href: "https://example.test/items/5", text: "Item", onclick: "go()" });
  harness.document.elements = [plain, railsDelete, turbo, scripted];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  const [plainDescriptor, railsDescriptor, turboDescriptor, scriptedDescriptor] =
    snapshot.interactive.map((entry) => entry.descriptor);
  assert.equal(plainDescriptor.linkSelf, true);
  assert.equal(security.classifyPersonalBrowserStep("click", plainDescriptor).verdict, "allow");
  for (const descriptor of [railsDescriptor, turboDescriptor, scriptedDescriptor]) {
    assert.equal(descriptor.linkSelf, false);
    assert.equal(security.classifyPersonalBrowserStep("click", descriptor).verdict, "ask");
  }
  assert.equal(security.classifyPersonalBrowserStep("click", railsDescriptor).category, "destructive");
});

test("a reading names the frames and pictures it cannot read, keeps its lines, and says where its text is cut", async () => {
  const harness = createPageHarness();
  const booking = new harness.Element("iframe", {});
  booking.src = "https://booking.example/rooms";
  // A tracking frame and an icon are nothing a person sees.
  const pixel = new harness.Element("iframe", {});
  pixel.src = "https://tracker.example/pixel";
  pixel.rect = { x: 0, y: 0, width: 1, height: 1 };
  const map = new harness.Element("canvas", { "aria-label": "Map of the route" });
  map.rect = { x: 10, y: 60, width: 400, height: 200 };
  const icon = new harness.Element("canvas", {});
  icon.rect = { x: 10, y: 300, width: 20, height: 20 };
  harness.document.unread = [booking, pixel, map, icon];
  harness.document.body = { innerText: "Book your stay\n\nPrice\t120 euros\n" };
  let snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  // A canvas's label is page text; a frame's site is an address, kept apart
  // until the text is masked and judged.
  assert.equal(snapshot.text, "Book your stay\nPrice\t120 euros\n[picture with no text: Map of the route]");
  assert.deepEqual(Array.from(snapshot.frames), ["[frame not read: booking.example]"]);

  harness.document.unread = [];
  harness.document.body = { innerText: "x".repeat(61_234) };
  snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.text, "x".repeat(60_000));
  assert.equal(snapshot.textCut, 1_234);
  assert.equal(snapshot.frames, undefined);
});

test("a reading says which controls are open, chosen or selected, and counts those outside the view", async () => {
  const harness = createPageHarness();
  const medium = new harness.HTMLInputElement({ type: "radio", "aria-label": "Medium" });
  medium.checked = true;
  const large = new harness.HTMLInputElement({ type: "radio", "aria-label": "Large" });
  const memory = new harness.HTMLButtonElement({ type: "button", text: "Memory options", "aria-expanded": "false" });
  const overview = new harness.HTMLButtonElement({ type: "button", role: "tab", text: "Overview", "aria-selected": "true" });
  const edition = new harness.HTMLAnchorElement({ href: "https://example.test/diy", role: "radio", text: "DIY Edition", "aria-checked": "true" });
  // Below the view until the page is scrolled to it.
  const next = new harness.HTMLAnchorElement({ href: "https://example.test/next", text: "Next page" });
  next.rect = { x: 10, y: 900, width: 80, height: 30 };
  harness.document.elements = [medium, large, memory, overview, edition, next];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual(
    Array.from(snapshot.interactive, ({ name, expanded, checked, selected }) => ({ name, expanded, checked, selected })),
    [
      { name: "Medium", expanded: undefined, checked: true, selected: undefined },
      { name: "Large", expanded: undefined, checked: undefined, selected: undefined },
      { name: "Memory options", expanded: false, checked: undefined, selected: undefined },
      { name: "Overview", expanded: undefined, checked: undefined, selected: true },
      { name: "DIY Edition", expanded: undefined, checked: true, selected: undefined },
    ],
  );
  assert.equal(snapshot.omittedControls, 1);
  // The states are no part of a target's fingerprint: a click that checks a
  // box leaves its approval as it was.
  const before = security.personalBrowserTargetSecurityFingerprint(snapshot.interactive[1].descriptor);
  large.checked = true;
  const after = await bridge.inspectPersonalBrowserTarget(harness.webContents, { index: 1 });
  assert.equal(security.personalBrowserTargetSecurityFingerprint(after), before);
});

test("a text area is never named by what it holds", async () => {
  const harness = createPageHarness();
  const codes = new harness.HTMLTextAreaElement({ text: "4821 7730 9912 0045" });
  const note = new harness.HTMLTextAreaElement({ text: "Draft: meet at noon", "aria-label": "Note" });
  harness.document.elements = [codes, note];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual(Array.from(snapshot.interactive, ({ name }) => name), ["textarea", "Note"]);
  for (const entry of snapshot.interactive) {
    assert.equal(entry.descriptor.text, "");
    assert.equal(entry.descriptor.shownText, "");
  }
  assert.ok(!JSON.stringify(snapshot).includes("4821"), "A text area's text reached the reading");
});

test("a suggestion the keys reach in a field's list is not marked selected; a list of its own's is", async () => {
  const harness = createPageHarness();
  const field = new harness.HTMLInputElement({ role: "combobox", "aria-controls": "stations", "aria-label": "To" });
  const suggestions = new harness.Element("ul", { role: "listbox", id: "stations" });
  const highlighted = new harness.HTMLButtonElement({ type: "button", role: "option", text: "Bolhao", "aria-selected": "true" });
  highlighted.parent = suggestions;
  const lines = new harness.Element("ul", { role: "listbox", id: "lines" });
  const chosen = new harness.HTMLButtonElement({ type: "button", role: "option", text: "Blue line", "aria-selected": "true" });
  chosen.parent = lines;
  harness.document.elements = [field, highlighted, chosen];
  const snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual(
    Array.from(snapshot.interactive, ({ name, selected }) => ({ name, selected })),
    [{ name: "To", selected: undefined }, { name: "Bolhao", selected: undefined }, { name: "Blue line", selected: true }],
  );
});

test("a control in view that no click reaches is not counted as outside the view", async () => {
  const harness = createPageHarness();
  const from = new harness.HTMLInputElement({ "aria-label": "From" });
  // Turned off the way style sheets draw it: in view, and no click reaches it.
  const plan = new harness.HTMLButtonElement({ text: "Plan Your Journey" });
  plan.disabled = true;
  plan.style.computed = { pointerEvents: "none" };
  const swap = new harness.HTMLButtonElement({ type: "button", text: "Swap" });
  // Off to the side, where scrolling never brings it (a closed drawer).
  const drawer = new harness.HTMLAnchorElement({ href: "https://example.test/menu", text: "Menu" });
  drawer.rect = { x: -400, y: 10, width: 300, height: 30 };
  harness.document.elements = [from, plan, swap, drawer];
  let snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.deepEqual(Array.from(snapshot.interactive, ({ name }) => name), ["From", "Swap"]);
  assert.equal(snapshot.omittedControls, undefined);
  // Below the view, which scrolling reaches, it counts.
  const next = new harness.HTMLAnchorElement({ href: "https://example.test/next", text: "Next page" });
  next.rect = { x: 10, y: 900, width: 80, height: 30 };
  harness.document.elements = [from, plan, swap, drawer, next];
  snapshot = await bridge.snapshotPersonalBrowserPage(harness.webContents);
  assert.equal(snapshot.omittedControls, 1);
});
