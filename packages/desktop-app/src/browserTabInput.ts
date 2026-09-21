import type { WebContents } from "electron";

/** Atomic tab actions; no arbitrary commands, host shortcuts or held input. */
export type BrowserTabInput =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; shift: boolean };
const keys: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  SelectAll: 65,
};
export function parseBrowserTabInput(value: unknown): BrowserTabInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid tab input.");
  const v = value as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    click: ["type", "x", "y"],
    wheel: ["type", "x", "y", "deltaX", "deltaY"],
    text: ["type", "text"],
    key: ["type", "key", "shift"],
  };
  if (
    typeof v.type !== "string" ||
    !allowed[v.type] ||
    Object.keys(v).some((k) => !allowed[v.type as string].includes(k))
  )
    throw new Error("Invalid tab input.");
  const number = (n: unknown, limit: number) =>
    typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;
  if (v.type === "click" || v.type === "wheel") {
    if (
      !number(v.x, 1) ||
      !number(v.y, 1) ||
      (v.x as number) < 0 ||
      (v.y as number) < 0
    )
      throw new Error("Invalid tab position.");
    if (
      v.type === "wheel" &&
      (!number(v.deltaX, 4096) || !number(v.deltaY, 4096))
    )
      throw new Error("Invalid tab scroll.");
  } else if (v.type === "text") {
    if (
      typeof v.text !== "string" ||
      !v.text ||
      Buffer.byteLength(v.text) > 8192 ||
      v.text.includes("\0")
    )
      throw new Error("Invalid tab text.");
  } else if (
    typeof v.key !== "string" ||
    !Object.hasOwn(keys, v.key) ||
    typeof v.shift !== "boolean"
  )
    throw new Error("Invalid tab key.");
  return value as BrowserTabInput;
}

export async function dispatchBrowserTabInput(
  contents: WebContents,
  bounds: { width: number; height: number },
  input: BrowserTabInput,
  current: () => boolean,
) {
  if (!current()) throw new Error("Tab control ended.");
  // CDP addresses this exact WebContents and works while another app has focus.
  // The renderer never receives this debugger or a generic command endpoint.
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const zoom = contents.getZoomFactor();
  const point =
    "x" in input
      ? {
          x: Math.min(bounds.width - 1, input.x * bounds.width) / zoom,
          y: Math.min(bounds.height - 1, input.y * bounds.height) / zoom,
        }
      : {};
  const send = (method: string, params: Record<string, unknown>) =>
    contents.debugger.sendCommand(method, params);
  if (!current()) throw new Error("Tab control ended.");
  switch (input.type) {
    case "click":
      // Queue the complete press/release together: revocation never leaves a held button.
      await Promise.all([
        send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          clickCount: 1,
        }),
        send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          clickCount: 1,
        }),
      ]);
      break;
    case "wheel":
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      });
      break;
    case "text":
      await send("Input.insertText", { text: input.text });
      break;
    case "key": {
      const selectAll = input.key === "SelectAll";
      const key = selectAll ? "a" : input.key;
      const modifiers = selectAll
        ? process.platform === "darwin"
          ? 4
          : 2
        : input.shift
          ? 8
          : 0;
      const event = {
        key,
        windowsVirtualKeyCode: keys[input.key],
        modifiers,
        ...(input.key === "Enter" ? { text: "\r" } : {}),
      };
      // CDP does not run macOS menu accelerators. Request the bounded editor
      // command explicitly so Select All works while the owner window is blurred.
      await Promise.all([
        send("Input.dispatchKeyEvent", {
          type: "keyDown",
          ...event,
          ...(selectAll ? { commands: ["selectAll"] } : {}),
        }),
        send("Input.dispatchKeyEvent", { type: "keyUp", ...event, text: "" }),
      ]);
      break;
    }
  }
}
