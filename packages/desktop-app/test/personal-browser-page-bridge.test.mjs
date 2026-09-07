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
    querySelectorAll() {
      for (const element of this.elements) element.ownerDocument = this;
      return this.elements;
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
    document,
    location: { href: "https://example.test/form" },
    innerWidth: 1_200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    scrollBy() {},
    getComputedStyle: () => ({ visibility: "visible", display: "block", pointerEvents: "auto" }),
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
    HTMLFormElement,
  };
}

function expectationFor(descriptor) {
  return {
    identity: descriptor.identity,
    securityFingerprint: security.personalBrowserTargetSecurityFingerprint(descriptor),
  };
}

test("native descriptors retain actual external form ownership and confirm associated submission controls", async () => {
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
      assert.equal(security.personalBrowserActivationRequiresConfirmation(item.descriptor, "routine"), true);
    } else {
      assert.equal(security.personalBrowserKeyRequiresConfirmation("Enter", item.descriptor), true);
    }
  }
});

test("non-submitting buttons remain routine and native no-owner state does not inherit an ancestor form", async () => {
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
  for (const { descriptor } of snapshot.interactive) {
    assert.equal(security.personalBrowserActivationRequiresConfirmation(descriptor, "routine"), false);
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
