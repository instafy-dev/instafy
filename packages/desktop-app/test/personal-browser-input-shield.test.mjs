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
