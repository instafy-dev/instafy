// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteBrowserMobileKeyboard } from "../RemoteBrowserMobileKeyboard";

describe("RemoteBrowserMobileKeyboard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("focuses in the opening tap and deduplicates paired control-key events", async () => {
    const onMessage = vi.fn();
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame");
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });

    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-mobile-keyboard-open"]',
    );
    expect(open).not.toBeNull();
    await act(async () => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="shared-browser-mobile-keyboard-input"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(input?.getAttribute("autocapitalize")).toBe("none");
    expect(input?.getAttribute("autocorrect")).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");

    await act(async () => {
      input?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "Hej",
          inputType: "insertText",
        }),
      );
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Backspace",
          code: "Backspace",
        }),
      );
      input?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        }),
      );
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
        }),
      );
      input?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertLineBreak",
        }),
      );
    });

    expect(onMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "text", text: "Hej" },
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
      expect.objectContaining({
        type: "key",
        kind: "keyDown",
        key: "Enter",
        text: "\r",
      }),
      expect.objectContaining({
        type: "key",
        kind: "keyUp",
        key: "Enter",
        text: "",
      }),
    ]);
  });

  it.each(["insertLineBreak", "insertParagraph"])("forwards software %s as one Enter action", async inputType => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="shared-browser-mobile-keyboard-open"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-testid="shared-browser-mobile-keyboard-input"]')
        ?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "key", kind: "keyDown", key: "Enter", code: "Enter", text: "\r", modifiers: 0,
        autoRepeat: false, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      },
      {
        type: "key", kind: "keyUp", key: "Enter", code: "Enter", text: "", modifiers: 0,
        autoRepeat: false, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      },
    ]);
  });

  it.each<{ label: string; init: KeyboardEventInit; text: string; modifiers: number }>([
    { label: "Shift+Enter", init: { key: "Enter", code: "Enter", shiftKey: true }, text: "\r", modifiers: 8 },
    { label: "NumpadEnter", init: { key: "Enter", code: "NumpadEnter" }, text: "\r", modifiers: 0 },
    { label: "Control+Enter", init: { key: "Enter", code: "Enter", ctrlKey: true }, text: "", modifiers: 2 },
    { label: "Alt+Enter", init: { key: "Enter", code: "Enter", altKey: true }, text: "", modifiers: 1 },
    { label: "Meta+Enter", init: { key: "Enter", code: "Enter", metaKey: true }, text: "", modifiers: 4 },
  ])("preserves $label in a mobile field with a hardware keyboard", async ({ init, text, modifiers }) => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="shared-browser-mobile-keyboard-open"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-testid="shared-browser-mobile-keyboard-input"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
    });

    expect(onMessage.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ type: "key", kind: text ? "keyDown" : "rawKeyDown", code: init.code, text, modifiers }),
      expect.objectContaining({ type: "key", kind: "keyUp", code: init.code, text: "", modifiers }),
    ]);
  });

  it("waits for IME composition to finish before forwarding text", async () => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="shared-browser-mobile-keyboard-open"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="shared-browser-mobile-keyboard-input"]',
    );

    await act(async () => {
      input?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "に",
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
      input?.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "日本語",
        }),
      );
      if (input) {
        input.value = "日本語";
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "日本語",
            inputType: "insertFromComposition",
          }),
        );
      }
    });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ type: "text", text: "日本語" });
  });

  it("does not suppress later text after a cancelled IME composition", async () => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="shared-browser-mobile-keyboard-open"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="shared-browser-mobile-keyboard-input"]',
    );

    await act(async () => {
      input?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input?.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "" }),
      );
      if (input) {
        input.value = "a";
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "a",
            inputType: "insertText",
          }),
        );
      }
    });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ type: "text", text: "a" });
  });

  it("uses the input event once when beforeinput cannot be cancelled", async () => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="shared-browser-mobile-keyboard-open"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="shared-browser-mobile-keyboard-input"]',
    );

    await act(async () => {
      input?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: false,
          data: "Hej",
          inputType: "insertText",
        }),
      );
      if (input) {
        input.value = "Hej";
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "Hej",
            inputType: "insertText",
          }),
        );
      }
    });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ type: "text", text: "Hej" });
  });

  it("disappears immediately when remote input authority is revoked", async () => {
    const onMessage = vi.fn();
    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled onMessage={onMessage} />);
    });
    expect(
      host.querySelector('[data-testid="shared-browser-mobile-keyboard"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(<RemoteBrowserMobileKeyboard enabled={false} onMessage={onMessage} />);
    });

    expect(
      host.querySelector('[data-testid="shared-browser-mobile-keyboard"]'),
    ).toBeNull();
  });
});
