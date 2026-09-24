// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachRemoteBrowserInput,
  dispatchRemoteBrowserVirtualInput,
} from "../remoteBrowserInput";
import { setRemoteBrowserSurfaceContentSize } from "../remoteBrowserSurfaceGeometry";

function touchPointerEvent(
  type: string,
  options: MouseEventInit & { pointerId: number },
): PointerEvent {
  const event = new MouseEvent(type, options);
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: options.pointerId },
    pointerType: { configurable: true, value: "touch" },
  });
  return event as unknown as PointerEvent;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("attachRemoteBrowserInput", () => {
  it("batches high-refresh touch scrolling without losing displacement or exceeding the input budget", () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 500 }) as DOMRect;
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({ width: 1, height: 1, dpr: 1, deviceWidth: 1, deviceHeight: 1 }),
      send,
    });
    element.dispatchEvent(touchPointerEvent("pointerdown", {
      pointerId: 1, clientX: 100, clientY: 300,
    }));
    for (let i = 1; i <= 240; i++) {
      element.dispatchEvent(touchPointerEvent("pointermove", {
        pointerId: 1, clientX: 100, clientY: 300 - i,
      }));
      vi.advanceTimersByTime(4);
    }
    element.dispatchEvent(touchPointerEvent("pointerup", {
      pointerId: 1, clientX: 100, clientY: 60,
    }));
    const messages = send.mock.calls.map(([message]) => message);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThanOrEqual(65);
    expect(messages.every(message => message.type === "wheel")).toBe(true);
    expect(messages.reduce((sum, message) => sum + message.deltaY, 0)).toBe(240);
    binding.dispose();
  });

  it("flushes accumulated wheel movement before a click and discards it after revocation or disposal", () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 500 }) as DOMRect;
    let active = true;
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      enabled: () => active,
      getViewport: () => ({ width: 1, height: 1, dpr: 1, deviceWidth: 1, deviceHeight: 1 }),
      send,
    });
    const wheel = () => element.dispatchEvent(new WheelEvent("wheel", {
      clientX: 100, clientY: 100, deltaY: 10,
    }));
    wheel();
    wheel();
    element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, button: 0 }));
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(["wheel", "mouse"]);
    expect(send.mock.calls[0][0].deltaY).toBe(20);
    wheel();
    active = false;
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);
    active = true;
    wheel();
    binding.dispose();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["insertText", "insertReplacementText"])(
    "forwards bounded %s without allowing insertion into a retained local editor selection",
    (inputType) => {
      const element = document.createElement("canvas");
      const send = vi.fn();
      const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
      const event = new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType, data: "— inert text",
      });

      element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(send).toHaveBeenCalledExactlyOnceWith({ type: "text", text: "— inert text" });
      binding.dispose();
    },
  );

  it("blocks local text insertion after input authority is lost without forwarding it", () => {
    const element = document.createElement("canvas");
    const send = vi.fn();
    let active = true;
    const binding = attachRemoteBrowserInput(element, {
      enabled: () => active, getViewport: () => null, send,
    });
    active = false;
    const event = new InputEvent("beforeinput", {
      cancelable: true, inputType: "insertText", data: "inert text",
    });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const paste = new Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "inert paste" },
    });
    element.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    binding.dispose();
  });

  it.each([
    { inputType: "insertFromPaste", data: "pasted text" },
    { inputType: "insertFromComposition", data: "語" },
    { inputType: "insertCompositionText", data: "語", isComposing: true },
    { inputType: "insertText", data: "語", isComposing: true },
    { inputType: "deleteContentBackward", data: null },
    { inputType: "insertText", data: "" },
    { inputType: "insertText", data: "a".repeat(8193) },
  ])("cancels but does not forward unsupported or unbounded beforeinput: $inputType", (init) => {
    const element = document.createElement("canvas");
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
    const event = new InputEvent("beforeinput", { ...init, cancelable: true });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    binding.dispose();
  });

  it("does not forward a noncancelable beforeinput or a nested local input event", () => {
    const element = document.createElement("div");
    const localInput = document.createElement("input");
    element.append(localInput);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
    element.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "inert text", cancelable: false,
    }));
    const nestedEvent = new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "local text",
    });
    localInput.dispatchEvent(nestedEvent);
    expect(nestedEvent.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    binding.dispose();
  });

  it.each(["keydown", "paste", "compositionend"] as const)(
    "does not duplicate a paired beforeinput after %s or suppress a later insertion",
    (kind) => {
      vi.useFakeTimers();
      const element = document.createElement("canvas");
      const send = vi.fn();
      const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
      const text = kind === "keydown" ? "a" : "語";
      if (kind === "keydown") {
        element.dispatchEvent(new KeyboardEvent("keydown", {
          key: text, code: "KeyA", cancelable: true,
        }));
      } else if (kind === "paste") {
        const event = new Event("paste", { cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: { getData: () => text },
        });
        element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      } else {
        element.dispatchEvent(new CompositionEvent("compositionstart"));
        element.dispatchEvent(new CompositionEvent("compositionend", { data: text }));
      }
      const event = new InputEvent("beforeinput", {
        cancelable: true, inputType: "insertText", data: text,
      });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      vi.runOnlyPendingTimers();
      element.dispatchEvent(new InputEvent("beforeinput", {
        cancelable: true, inputType: "insertText", data: text,
      }));
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({ type: "text", text });
      binding.dispose();
    },
  );

  it("expires an unpaired composition suppression and removes text listeners on disposal", () => {
    vi.useFakeTimers();
    const element = document.createElement("canvas");
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
    element.dispatchEvent(new CompositionEvent("compositionend", { data: "語" }));
    vi.runOnlyPendingTimers();
    element.dispatchEvent(new InputEvent("beforeinput", {
      cancelable: true, inputType: "insertText", data: "語",
    }));
    expect(send).toHaveBeenCalledTimes(2);
    binding.dispose();
    const event = new InputEvent("beforeinput", {
      cancelable: true, inputType: "insertText", data: "disposed",
    });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps pointer and keyboard events into the bounded shared input API", () => {
    const element = document.createElement("canvas");
    element.tabIndex = 0;
    element.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 200 }) as DOMRect;
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 1280,
        height: 720,
        dpr: 2,
        deviceWidth: 2560,
        deviceHeight: 1440,
      }),
      send,
    });

    element.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 210,
        clientY: 120,
        ctrlKey: true,
        detail: 1,
      }),
    );
    expect(send).toHaveBeenCalledWith({
      type: "mouse",
      kind: "mousePressed",
      x: 640,
      y: 360,
      button: "left",
      buttons: 1,
      modifiers: 2,
      clickCount: 1,
    });

    element.dispatchEvent(
      new MouseEvent("pointercancel", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: 210,
        clientY: 120,
      }),
    );
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "mouse",
        kind: "mouseReleased",
        button: "left",
        buttons: 0,
      }),
    );

    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: "a",
        code: "KeyA",
        shiftKey: true,
      }),
    );
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "key",
        kind: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
        modifiers: 8,
      }),
    );

    binding.dispose();
    const callCount = send.mock.calls.length;
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB" }));
    expect(send).toHaveBeenCalledTimes(callCount);
  });

  it("sends AltGr characters as printable text on international layouts", () => {
    const element = document.createElement("canvas");
    element.tabIndex = 0;
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 1280,
        height: 720,
        dpr: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
      }),
      send,
    });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      key: "@",
      code: "Digit2",
      ctrlKey: true,
      altKey: true,
    });
    Object.defineProperty(event, "getModifierState", {
      value: (modifier: string) => modifier === "AltGraph",
    });

    element.dispatchEvent(event);

    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "key",
        kind: "keyDown",
        key: "@",
        code: "Digit2",
        text: "@",
      }),
    );
    binding.dispose();
  });

  it.each<{ label: string; init: KeyboardEventInit; text: string; modifiers: number }>([
    { label: "Enter", init: { key: "Enter", code: "Enter" }, text: "\r", modifiers: 0 },
    { label: "Shift+Enter", init: { key: "Enter", code: "Enter", shiftKey: true }, text: "\r", modifiers: 8 },
    { label: "NumpadEnter", init: { key: "Enter", code: "NumpadEnter" }, text: "\r", modifiers: 0 },
    { label: "Shift+NumpadEnter", init: { key: "Enter", code: "NumpadEnter", shiftKey: true }, text: "\r", modifiers: 8 },
    { label: "Control+Enter", init: { key: "Enter", code: "Enter", ctrlKey: true }, text: "", modifiers: 2 },
    { label: "Alt+Enter", init: { key: "Enter", code: "Enter", altKey: true }, text: "", modifiers: 1 },
    { label: "Meta+Enter", init: { key: "Enter", code: "Enter", metaKey: true }, text: "", modifiers: 4 },
    { label: "Control+x", init: { key: "x", code: "KeyX", ctrlKey: true }, text: "", modifiers: 2 },
    { label: "Alt+x", init: { key: "x", code: "KeyX", altKey: true }, text: "", modifiers: 1 },
    { label: "Meta+x", init: { key: "x", code: "KeyX", metaKey: true }, text: "", modifiers: 4 },
  ])("preserves $label key text and keeps key-up nonprinting", ({ init, text, modifiers }) => {
    const element = document.createElement("canvas");
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, { getViewport: () => null, send });
    const keyCode = init.key === "Enter" ? 13 : 88;
    const down = new KeyboardEvent("keydown", { ...init, keyCode, cancelable: true });
    const up = new KeyboardEvent("keyup", { ...init, keyCode, cancelable: true });

    element.dispatchEvent(down);
    element.dispatchEvent(up);

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "key", kind: text ? "keyDown" : "rawKeyDown", key: init.key, code: init.code,
        text, modifiers, autoRepeat: false, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      },
      {
        type: "key", kind: "keyUp", key: init.key, code: init.code,
        text: "", modifiers, autoRepeat: false, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      },
    ]);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    binding.dispose();
  });

  it("keeps a mounted but inactive Shared surface from receiving input", () => {
    const element = document.createElement("canvas");
    element.tabIndex = 0;
    document.body.append(element);
    const send = vi.fn();
    let active = false;
    const binding = attachRemoteBrowserInput(element, {
      enabled: () => active,
      getViewport: () => ({
        width: 640,
        height: 360,
        dpr: 1,
        deviceWidth: 640,
        deviceHeight: 360,
      }),
      send,
    });

    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "x", code: "KeyX" }),
    );
    element.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 10,
        clientY: 10,
      }),
    );
    expect(send).not.toHaveBeenCalled();

    active = true;
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "x", code: "KeyX" }),
    );
    expect(send).toHaveBeenCalledOnce();
    binding.dispose();
  });

  it("turns a touch tap into one remote click without pressing during gesture detection", () => {
    const element = document.createElement("canvas");
    element.tabIndex = 0;
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200 }) as DOMRect;
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 800,
        height: 400,
        dpr: 1,
        deviceWidth: 800,
        deviceHeight: 400,
      }),
      send,
    });

    element.dispatchEvent(
      touchPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 100,
        clientY: 50,
        pointerId: 7,
      }),
    );
    expect(send).not.toHaveBeenCalled();

    element.dispatchEvent(
      touchPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: 100,
        clientY: 50,
        pointerId: 7,
      }),
    );

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({
        type: "mouse",
        kind: "mousePressed",
        x: 200,
        y: 100,
        button: "left",
        buttons: 1,
      }),
      expect.objectContaining({
        type: "mouse",
        kind: "mouseReleased",
        x: 200,
        y: 100,
        button: "left",
        buttons: 0,
      }),
    ]);
    binding.dispose();
  });

  it("turns a touch drag into remote wheel scrolling without clicking", () => {
    const element = document.createElement("canvas");
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200 }) as DOMRect;
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 800,
        height: 400,
        dpr: 1,
        deviceWidth: 800,
        deviceHeight: 400,
      }),
      send,
    });

    element.dispatchEvent(
      touchPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 200,
        clientY: 150,
        pointerId: 9,
      }),
    );
    element.dispatchEvent(
      touchPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 200,
        clientY: 100,
        pointerId: 9,
      }),
    );
    element.dispatchEvent(
      touchPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 9,
      }),
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: "wheel",
      x: 400,
      y: 200,
      deltaX: 0,
      deltaY: 50,
      modifiers: 0,
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse" }),
    );
    binding.dispose();
  });

  it("does not turn a drag through an aspect-fit gutter back into a tap", () => {
    const element = document.createElement("canvas");
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
    setRemoteBrowserSurfaceContentSize(element, 1280, 720);
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 1280,
        height: 720,
        dpr: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
      }),
      send,
    });

    element.dispatchEvent(
      touchPointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 200,
        clientY: 120,
        pointerId: 12,
      }),
    );
    const gutterMove = touchPointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 200,
      clientY: 40,
      pointerId: 12,
    });
    element.dispatchEvent(gutterMove);
    element.dispatchEvent(
      touchPointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        clientX: 200,
        clientY: 120,
        pointerId: 12,
      }),
    );

    expect(gutterMove.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    binding.dispose();
  });

  it("rejects mouse, wheel, and touch input in aspect-fit gutters", () => {
    const element = document.createElement("canvas");
    element.tabIndex = 0;
    element.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 400 }) as DOMRect;
    setRemoteBrowserSurfaceContentSize(element, 1280, 720);
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 1280,
        height: 720,
        dpr: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
      }),
      send,
    });

    const gutterPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 210,
      clientY: 60,
    });
    element.dispatchEvent(gutterPointer);
    const gutterWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 210,
      clientY: 60,
      deltaY: 40,
    });
    element.dispatchEvent(gutterWheel);
    const gutterTouch = touchPointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 210,
      clientY: 60,
      pointerId: 11,
    });
    element.dispatchEvent(gutterTouch);
    const gutterTouchUp = touchPointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      clientX: 210,
      clientY: 60,
      pointerId: 11,
    });
    element.dispatchEvent(gutterTouchUp);

    expect(send).not.toHaveBeenCalled();
    expect(gutterPointer.defaultPrevented).toBe(false);
    expect(gutterWheel.defaultPrevented).toBe(false);
    expect(gutterTouch.defaultPrevented).toBe(false);
    expect(gutterTouchUp.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(element);

    element.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 210,
        clientY: 220,
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mouse",
        kind: "mousePressed",
        x: 640,
        y: 360,
      }),
    );
    binding.dispose();
  });

  it("routes software-keyboard text and control keys through the active input binding", () => {
    const element = document.createElement("canvas");
    document.body.append(element);
    const send = vi.fn();
    const binding = attachRemoteBrowserInput(element, {
      getViewport: () => ({
        width: 640,
        height: 360,
        dpr: 1,
        deviceWidth: 640,
        deviceHeight: 360,
      }),
      send,
    });

    dispatchRemoteBrowserVirtualInput(element, {
      type: "text",
      text: "Hej från mobilen",
    });
    dispatchRemoteBrowserVirtualInput(element, {
      type: "key",
      kind: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      text: "",
      modifiers: 0,
      autoRepeat: false,
    });
    dispatchRemoteBrowserVirtualInput(element, {
      type: "key",
      kind: "keyUp",
      key: "Backspace",
      code: "Backspace",
      text: "",
      modifiers: 0,
      autoRepeat: false,
    });
    element.dispatchEvent(
      new CustomEvent("instafy:remote-browser-virtual-input", {
        detail: { type: "key", kind: "rawKeyDown" },
      }),
    );

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "text", text: "Hej från mobilen" },
      expect.objectContaining({
        type: "key",
        kind: "rawKeyDown",
        key: "Backspace",
      }),
      expect.objectContaining({
        type: "key",
        kind: "keyUp",
        key: "Backspace",
      }),
    ]);

    binding.dispose();
    dispatchRemoteBrowserVirtualInput(element, { type: "text", text: "ignored" });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
