import type { LocalTabInput } from "../../../services/runtimeController/localTabControl";
import type { RemoteBrowserInputMessage } from "./remoteBrowserInput";
const keys = new Set([
  "Backspace",
  "Delete",
  "Tab",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
/** Use the shared pointer/touch/IME binding with a bounded atomic local-tab lane. */
export function localTabInput(
  message: RemoteBrowserInputMessage,
): LocalTabInput | null {
  switch (message.type) {
    case "mouse":
      return message.kind === "mouseReleased" && message.button === "left"
        ? { type: "click", x: message.x, y: message.y }
        : null;
    case "wheel":
      return {
        type: "wheel",
        x: message.x,
        y: message.y,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
      };
    case "text":
      return { type: "text", text: message.text };
    case "key":
      if (message.kind === "keyUp") return null;
      if (message.key.toLowerCase() === "a" && message.modifiers & 6)
        return { type: "key", key: "SelectAll", shift: false };
      if (message.modifiers & 7) return null;
      if (keys.has(message.key))
        return {
          type: "key",
          key: message.key,
          shift: Boolean(message.modifiers & 8),
        };
      return message.text ? { type: "text", text: message.text } : null;
  }
}
