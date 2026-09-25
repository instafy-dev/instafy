import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const { PersonalBrowserInputShield } = await import(
  path.join(packageRoot, "dist", "personalBrowserInputShield.js")
);

class FakeWebContents extends EventEmitter {
  destroyed = false;
  focusCount = 0;
  closeCount = 0;
  loadedUrl = "";
  scripts = [];

  async executeJavaScript(source) { this.scripts.push(source); }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  async loadURL(url) {
    this.loadedUrl = url;
  }

  isDestroyed() {
    return this.destroyed;
  }

  focus() {
    this.focusCount += 1;
  }

  close() {
    this.closeCount += 1;
    this.destroyed = true;
  }
}

class FakeView {
  webContents = new FakeWebContents();
  visible = false;
  bounds = null;
  backgroundColor = null;

  setBackgroundColor(value) {
    this.backgroundColor = value;
  }

  setVisible(value) {
    this.visible = value;
  }

  setBounds(value) {
    this.bounds = { ...value };
  }
}

class FakeOwner {
  children = [];

  addChildView(view) {
    this.children = this.children.filter((candidate) => candidate !== view);
    this.children.push(view);
  }

  removeChildView(view) {
    this.children = this.children.filter((candidate) => candidate !== view);
  }
}

function inputEvent(contents, input) {
  let prevented = false;
  contents.emit(
    "before-input-event",
    { preventDefault: () => { prevented = true; } },
    {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      ...input,
    },
  );
  return { get prevented() { return prevented; } };
}

test("native Personal Browser shield sits above the page and blocks human input until Escape", async () => {
  const owner = new FakeOwner();
  const protectedContents = new FakeWebContents();
  const protectedView = { name: "personal-page" };
  owner.addChildView(protectedView);
  let createdView = null;
  let escapeCount = 0;
  let shield;
  shield = new PersonalBrowserInputShield({
    createView: () => {
      createdView = new FakeView();
      return createdView;
    },
    onEmergencyEscape: () => {
      escapeCount += 1;
      shield.sync(false, true, { x: 10, y: 20, width: 600, height: 400 });
    },
  });

  shield.attach(owner, protectedContents);
  shield.sync(true, true, { x: 10, y: 20, width: 600, height: 400 });

  assert.ok(createdView);
  assert.equal(owner.children.at(-1), createdView, "the native shield must be topmost");
  assert.equal(createdView.visible, true);
  assert.deepEqual(createdView.bounds, { x: 10, y: 20, width: 600, height: 400 });
  assert.equal(createdView.backgroundColor, "#00000000");
  assert.match(createdView.webContents.loadedUrl, /^data:text\/html/);
  assert.equal(createdView.webContents.focusCount, 1);

  const protectedKey = inputEvent(protectedContents, {});
  assert.equal(protectedKey.prevented, true, "a focused underlying page must still be locked");

  const escape = inputEvent(createdView.webContents, { key: "Escape", code: "Escape" });
  assert.equal(escape.prevented, true);
  await Promise.resolve();
  assert.equal(escapeCount, 1);
  assert.equal(createdView.visible, false);
  assert.equal(protectedContents.focusCount, 1, "human focus returns only after revocation");

  const resumedHumanKey = inputEvent(protectedContents, {});
  assert.equal(resumedHumanKey.prevented, false);

  shield.destroy();
  assert.equal(createdView.webContents.closeCount, 1);
  assert.equal(owner.children.includes(createdView), false);
});

test("granting control under a menu defers native shield attachment without unlocking the page", () => {
  const owner = new FakeOwner();
  const contents = new FakeWebContents();
  let view;
  const shield = new PersonalBrowserInputShield({
    createView: () => (view = new FakeView()),
    onEmergencyEscape() {},
  });
  const bounds = { x: 10, y: 20, width: 600, height: 400 };
  shield.attach(owner, contents);
  shield.sync(true, false, bounds);
  assert.equal(view, undefined, "a menu must not lose focus to a new native view");
  assert.equal(inputEvent(contents, {}).prevented, true);
  shield.sync(true, true, bounds);
  assert.equal(view.visible, true);
  assert.equal(view.webContents.focusCount, 1);
  shield.sync(true, false, bounds);
  assert.equal(view.visible, false);
  assert.equal(view.webContents.focusCount, 1);
  assert.equal(contents.focusCount, 0);
  shield.destroy();
});

test("surface clicks request confirmation, animation does not steal focus, and hidden surfaces stay quiet", async () => {
  const owner = new FakeOwner();
  let view, requests = 0, escapes = 0;
  const shield = new PersonalBrowserInputShield({
    createView: () => (view = new FakeView()),
    onEmergencyEscape: () => escapes++,
    onTakeOverRequest: () => requests++,
  });
  const bounds = { x: 0, y: 0, width: 900, height: 600 };
  shield.attach(owner, new FakeWebContents());
  shield.sync(true, true, bounds, true);
  await Promise.resolve();
  assert.match(view.webContents.scripts.at(-1), /working = "true"/);
  assert.match(decodeURIComponent(view.webContents.loadedUrl), /prefers-reduced-motion/);
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  view.webContents.emit("before-mouse-event", event, { type: "mouseUp", button: "left" });
  assert.equal(prevented, true);
  assert.equal(requests, 1);
  assert.equal(escapes, 0, "a click requests a popup; it does not revoke control");
  assert.equal(view.visible, true);
  shield.sync(true, true, bounds, false);
  assert.match(view.webContents.scripts.at(-1), /working = "false"/);
  assert.equal(view.webContents.focusCount, 1, "decorative activity updates must not steal composer focus");
  shield.sync(true, true, bounds, false, "participant");
  assert.match(view.webContents.scripts.at(-1), /Another participant has control/);
  assert.doesNotMatch(view.webContents.scripts.at(-1), /AI/);
  assert.equal(view.webContents.focusCount, 1, "controller identity changes must not steal focus");
  shield.sync(false, true, bounds);
  shield.sync(true, true, bounds);
  assert.equal(view.webContents.focusCount, 2, "resuming control restores shield focus");
  inputEvent(view.webContents, { key: "Enter" });
  assert.equal(requests, 2, "keyboard activation also requests the popup");
  shield.sync(true, false, bounds, true);
  view.webContents.emit("before-mouse-event", event, { type: "mouseUp", button: "left" });
  assert.equal(requests, 2);
  shield.destroy();
});
