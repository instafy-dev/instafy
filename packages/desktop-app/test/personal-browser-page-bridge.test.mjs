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
      this.rect = { x: nextX, y: 10, width: 80, height: 30 };
      nextX += 100;
      this.onFocus = null;
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
      if (selector === "iframe, frame, object, embed") return false;
      if (selector === "button, input[type='button'], input[type='submit']") {
        return this.tagName === "BUTTON" ||
          (this.tagName === "INPUT" && ["button", "submit"].includes(this.type));
      }
      return false;
    }

    closest(selector) {
      if (selector === "a[href]" && this instanceof HTMLAnchorElement) return this;
      if (selector === "form") return this.form ?? null;
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
    HTMLInputElement,
  };
}

function expectationFor(descriptor) {
  return {
    identity: descriptor.identity,
    securityFingerprint: security.personalBrowserTargetSecurityFingerprint(descriptor),
  };
}

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
