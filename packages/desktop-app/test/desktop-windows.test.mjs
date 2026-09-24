import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  getStudioWindow,
  getStudioWindows,
  registerStudioWindow,
} from "../dist/desktopWindows.js";
function window(focused = false) {
  return Object.assign(new EventEmitter(), {
    focused,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isFocused() {
      return this.focused;
    },
  });
}
test("only explicitly registered Studio windows receive shell actions, even if another window is focused", () => {
  const hiddenPage = window(true),
    first = window(),
    second = window(true);
  assert.equal(getStudioWindow(), null);
  registerStudioWindow(first);
  registerStudioWindow(second);
  assert.equal(getStudioWindow(), second);
  assert.equal(getStudioWindows().includes(hiddenPage), false);
  second.destroyed = true;
  assert.equal(getStudioWindow(), first);
  first.emit("closed");
  second.emit("closed");
  assert.equal(getStudioWindow(), null);
});
