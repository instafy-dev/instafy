import {
  boundedCdpScreencastText,
  cdpScreencastModifiers,
  cdpScreencastMouseButton,
  type CdpScreencastViewport,
} from "./cdpScreencastProtocol";
import {
  normalizedRemoteBrowserPoint,
  type RemoteBrowserSurface,
} from "./remoteBrowserSurfaceGeometry";

export type RemoteBrowserInputMessage =
  | {
      type: "mouse";
      kind: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right" | "back" | "forward";
      buttons: number;
      modifiers: number;
      clickCount: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers: number;
    }
  | {
      type: "key";
      kind: "rawKeyDown" | "keyDown" | "keyUp";
      key: string;
      code: string;
      text: string;
      modifiers: number;
      autoRepeat: boolean;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
    }
  | { type: "text"; text: string };

export type RemoteBrowserVirtualInputMessage = Extract<
  RemoteBrowserInputMessage,
  { type: "key" | "text" }
>;

const REMOTE_BROWSER_VIRTUAL_INPUT_EVENT = "instafy:remote-browser-virtual-input";
const TOUCH_SCROLL_THRESHOLD_PX = 8;

export function remoteBrowserKeyDownText(key: string, modifiers = 0, altGraph = false): string {
  // CDP modifiers: Alt=1, Control=2, Meta=4, Shift=8. Shift changes the
  // character supplied by the keyboard; ordinary shortcuts must not type.
  const shortcutModifiers = modifiers & 7;
  if (key === "Enter") {
    // A raw Enter has no keypress/default action in Chromium. Both physical
    // and software keyboards need the carriage return for submit/newline.
    return shortcutModifiers === 0 ? "\r" : "";
  }
  return key.length === 1 && !(modifiers & 4) && (altGraph || shortcutModifiers === 0)
    ? key
    : "";
}

/**
 * Send text or an allowlisted virtual key through the same bounded input lane
 * used by physical keyboards. This lets a coarse-pointer client keep the
 * remote page focused while a local text field summons the software keyboard.
 */
export function dispatchRemoteBrowserVirtualInput(
  element: HTMLElement,
  message: RemoteBrowserVirtualInputMessage,
): boolean {
  return element.dispatchEvent(
    new CustomEvent<RemoteBrowserVirtualInputMessage>(
      REMOTE_BROWSER_VIRTUAL_INPUT_EVENT,
      {
        bubbles: false,
        cancelable: true,
        detail: message,
      },
    ),
  );
}

type RemoteBrowserMouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

export type RemoteBrowserInputBinding = {
  dispose: () => void;
};

type RemoteBrowserInputOptions = {
  enabled?: () => boolean;
  getViewport: () => CdpScreencastViewport | null;
  send: (message: RemoteBrowserInputMessage) => void;
};

type RemoteBrowserTouchGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

function boundedDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, -4096), 4096);
}

function keyCode(event: KeyboardEvent): number | undefined {
  const value = event.keyCode;
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : undefined;
}

/**
 * Bind the allowlisted browser input protocol to any remotely rendered surface.
 * Both CDP screencast and WebRTC viewers use this exact input lane, so switching
 * video transport cannot silently broaden the commands exposed to the browser.
 */
export function attachRemoteBrowserInput(
  element: HTMLElement,
  options: RemoteBrowserInputOptions,
): RemoteBrowserInputBinding {
  let disposed = false;
  let pointerMoveFrame: number | null = null;
  let pendingPointerMove: PointerEvent | null = null;
  let pressedPointerId: number | null = null;
  let pressedButton: RemoteBrowserMouseButton = "none";
  let lastRemotePoint: { x: number; y: number } | null = null;
  let touchGesture: RemoteBrowserTouchGesture | null = null;
  const enabled = () => !disposed && (options.enabled?.() ?? true);

  const remotePoint = (event: Pick<PointerEvent | WheelEvent, "clientX" | "clientY">) => {
    const viewport = options.getViewport();
    if (!viewport) {
      return null;
    }
    const normalized = normalizedRemoteBrowserPoint(
      element as RemoteBrowserSurface,
      event.clientX,
      event.clientY,
    );
    return normalized
      ? {
          x: normalized.x * viewport.width,
          y: normalized.y * viewport.height,
        }
      : null;
  };

  const sendPointer = (
    event: PointerEvent,
    kind: "mousePressed" | "mouseReleased" | "mouseMoved",
    buttonOverride?: typeof pressedButton,
    buttonsOverride?: number,
  ): boolean => {
    if (!enabled()) {
      return false;
    }
    const point = remotePoint(event);
    if (!point) {
      return false;
    }
    lastRemotePoint = point;
    options.send({
      type: "mouse",
      kind,
      ...point,
      button: buttonOverride ?? cdpScreencastMouseButton(event.button),
      buttons: Math.min(Math.max(buttonsOverride ?? event.buttons, 0), 31),
      modifiers: cdpScreencastModifiers(event),
      clickCount: Math.min(Math.max(event.detail || 1, 1), 3),
    });
    return true;
  };

  const releaseAtLastRemotePoint = (event: PointerEvent): boolean => {
    if (!enabled() || pressedPointerId === null || !lastRemotePoint) {
      return false;
    }
    options.send({
      type: "mouse",
      kind: "mouseReleased",
      ...lastRemotePoint,
      button: pressedButton,
      buttons: 0,
      modifiers: cdpScreencastModifiers(event),
      clickCount: Math.min(Math.max(event.detail || 1, 1), 3),
    });
    return true;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!enabled()) {
      return;
    }
    if (event.pointerType === "touch") {
      if (touchGesture !== null) {
        touchGesture.moved = true;
        event.preventDefault();
        return;
      }
      if (!remotePoint(event)) {
        return;
      }
      touchGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      element.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (!sendPointer(event, "mousePressed")) {
      return;
    }
    pressedPointerId = event.pointerId;
    pressedButton = cdpScreencastMouseButton(event.button);
    element.focus({ preventScroll: true });
    element.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      const gesture = touchGesture;
      if (!gesture) {
        return;
      }
      if (gesture.pointerId !== event.pointerId) {
        event.preventDefault();
        return;
      }
      touchGesture = null;
      if (enabled() && !gesture.moved) {
        if (sendPointer(event, "mousePressed", "left", 1)) {
          sendPointer(event, "mouseReleased", "left", 0);
          element.focus({ preventScroll: true });
        }
      }
      if (element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      return;
    }
    let handled = false;
    if (enabled()) {
      handled = sendPointer(event, "mouseReleased", pressedButton);
      if (!handled) {
        // A drag may end over a neutral gutter. Never map the gutter onto an
        // edge pixel, but release the prior in-page press at its last valid
        // coordinate so Chromium cannot retain a stuck mouse button.
        handled = releaseAtLastRemotePoint(event);
      }
    }
    pressedPointerId = null;
    pressedButton = "none";
    lastRemotePoint = null;
    if (element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture?.(event.pointerId);
    }
    if (handled) {
      event.preventDefault();
    }
  };
  const onPointerCancelled = (event: PointerEvent) => {
    if (touchGesture && touchGesture.pointerId === event.pointerId) {
      touchGesture = null;
      return;
    }
    if (pressedPointerId !== null && event.pointerId === pressedPointerId) {
      if (!sendPointer(event, "mouseReleased", pressedButton)) {
        releaseAtLastRemotePoint(event);
      }
      pressedPointerId = null;
      pressedButton = "none";
      lastRemotePoint = null;
    }
  };
  const flushPointerMove = () => {
    pointerMoveFrame = null;
    const event = pendingPointerMove;
    pendingPointerMove = null;
    if (event && enabled()) {
      sendPointer(event, "mouseMoved");
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!enabled()) {
      return;
    }
    if (event.pointerType === "touch") {
      const gesture = touchGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }
      const totalX = event.clientX - gesture.startX;
      const totalY = event.clientY - gesture.startY;
      if (
        !gesture.moved &&
        Math.hypot(totalX, totalY) < TOUCH_SCROLL_THRESHOLD_PX
      ) {
        event.preventDefault();
        return;
      }
      // Crossing the gesture threshold always cancels the eventual tap, even
      // when this particular sample lands in an aspect-fit gutter.
      gesture.moved = true;
      const point = remotePoint(event);
      if (!point) {
        event.preventDefault();
        return;
      }
      const deltaX = gesture.lastX - event.clientX;
      const deltaY = gesture.lastY - event.clientY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      options.send({
        type: "wheel",
        ...point,
        deltaX: boundedDelta(deltaX),
        deltaY: boundedDelta(deltaY),
        modifiers: cdpScreencastModifiers(event),
      });
      event.preventDefault();
      return;
    }
    pendingPointerMove = event;
    if (pointerMoveFrame === null) {
      pointerMoveFrame = window.requestAnimationFrame(flushPointerMove);
    }
  };
  const onWheel = (event: WheelEvent) => {
    if (!enabled()) {
      return;
    }
    const point = remotePoint(event);
    if (!point) {
      return;
    }
    options.send({
      type: "wheel",
      ...point,
      deltaX: boundedDelta(event.deltaX),
      deltaY: boundedDelta(event.deltaY),
      modifiers: cdpScreencastModifiers(event),
    });
    event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled() || event.isComposing || event.key === "Process") {
      return;
    }
    const modifiers = cdpScreencastModifiers(event);
    const text = remoteBrowserKeyDownText(event.key, modifiers, event.getModifierState("AltGraph"));
    options.send({
      type: "key",
      kind: text ? "keyDown" : "rawKeyDown",
      key: event.key.slice(0, 128),
      code: event.code.slice(0, 128),
      text,
      modifiers,
      autoRepeat: event.repeat,
      ...(keyCode(event) === undefined
        ? {}
        : {
            windowsVirtualKeyCode: keyCode(event),
            nativeVirtualKeyCode: keyCode(event),
          }),
    });
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!enabled() || event.isComposing || event.key === "Process") {
      return;
    }
    options.send({
      type: "key",
      kind: "keyUp",
      key: event.key.slice(0, 128),
      code: event.code.slice(0, 128),
      text: "",
      modifiers: cdpScreencastModifiers(event),
      autoRepeat: false,
      ...(keyCode(event) === undefined
        ? {}
        : {
            windowsVirtualKeyCode: keyCode(event),
            nativeVirtualKeyCode: keyCode(event),
          }),
    });
    event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!enabled()) {
      return;
    }
    const text = boundedCdpScreencastText(event.clipboardData?.getData("text/plain") ?? "");
    if (!text) {
      return;
    }
    options.send({ type: "text", text });
    event.preventDefault();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (!enabled()) {
      return;
    }
    const text = boundedCdpScreencastText(event.data);
    if (text) {
      options.send({ type: "text", text });
    }
  };
  const onVirtualInput = (event: Event) => {
    if (!enabled() || !(event instanceof CustomEvent)) {
      return;
    }
    const message =
      event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? (event.detail as Record<string, unknown>)
        : null;
    if (message?.type === "text") {
      if (typeof message.text !== "string") {
        return;
      }
      const text = boundedCdpScreencastText(message.text);
      if (text) {
        options.send({ type: "text", text });
        event.preventDefault();
      }
      return;
    }
    if (
      message?.type !== "key" ||
      (message.kind !== "rawKeyDown" &&
        message.kind !== "keyDown" &&
        message.kind !== "keyUp") ||
      typeof message.key !== "string" ||
      typeof message.code !== "string" ||
      typeof message.text !== "string"
    ) {
      return;
    }
    const modifiers =
      typeof message.modifiers === "number" && Number.isFinite(message.modifiers)
        ? Math.min(Math.max(Math.trunc(message.modifiers), 0), 15)
        : 0;
    const boundedVirtualKeyCode = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), 0), 65_535)
        : undefined;
    const windowsVirtualKeyCode = boundedVirtualKeyCode(
      message.windowsVirtualKeyCode,
    );
    const nativeVirtualKeyCode = boundedVirtualKeyCode(message.nativeVirtualKeyCode);
    options.send({
      type: "key",
      kind: message.kind,
      key: message.key.slice(0, 128),
      code: message.code.slice(0, 128),
      text: boundedCdpScreencastText(message.text) ?? "",
      modifiers,
      autoRepeat: Boolean(message.autoRepeat),
      ...(windowsVirtualKeyCode === undefined
        ? {}
        : {
            windowsVirtualKeyCode,
          }),
      ...(nativeVirtualKeyCode === undefined
        ? {}
        : {
            nativeVirtualKeyCode,
          }),
    });
    event.preventDefault();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (enabled()) {
      event.preventDefault();
    }
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancelled);
  element.addEventListener("lostpointercapture", onPointerCancelled);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("keyup", onKeyUp);
  element.addEventListener("paste", onPaste);
  element.addEventListener("compositionend", onCompositionEnd);
  element.addEventListener(REMOTE_BROWSER_VIRTUAL_INPUT_EVENT, onVirtualInput);
  element.addEventListener("contextmenu", onContextMenu);

  return {
    dispose: () => {
      disposed = true;
      if (pointerMoveFrame !== null) {
        window.cancelAnimationFrame(pointerMoveFrame);
      }
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancelled);
      element.removeEventListener("lostpointercapture", onPointerCancelled);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("keyup", onKeyUp);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.removeEventListener(REMOTE_BROWSER_VIRTUAL_INPUT_EVENT, onVirtualInput);
      element.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
