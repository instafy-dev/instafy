// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeKeyboardAccessory } from "../nativeKeyboardAccessory";

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: vi.fn(), isPluginAvailable: vi.fn() },
}));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setAccessoryBarVisible: vi.fn() },
}));

describe("nativeKeyboardAccessory", () => {
  let dispose: () => void;
  let editor: HTMLDivElement;
  let background: HTMLDivElement;
  let field: HTMLInputElement;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(Capacitor.getPlatform).mockReturnValue("ios");
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true);
    vi.mocked(Keyboard.setAccessoryBarVisible).mockResolvedValue();
    document.body.innerHTML = `<div id="editor" contenteditable="true" tabindex="0"><span>Chat draft</span></div>
      <div role="dialog" tabindex="-1">
        <label for="name"><span>Display name</span></label><input id="name" value="Helper">
        <textarea aria-label="Bio">Helpful agent</textarea><input type="search" aria-label="Search">
        <div id="background">Profile description</div><button><span>Save</span></button>
        <a href="#help">Help</a><div role="switch" tabindex="0"><span>Enabled</span></div>
      </div>`;
    editor = document.querySelector("#editor")!;
    background = document.querySelector("#background")!;
    field = document.querySelector("#name")!;
    dispose = () => undefined;
  });

  afterEach(() => {
    dispose();
    document.body.innerHTML = "";
  });

  function tap(element: Element) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it.each(["web", "android"])("does not alter the %s keyboard or focus", (platform) => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue(platform);
    dispose = installNativeKeyboardAccessory();
    field.focus();
    tap(background);
    expect(document.activeElement).toBe(field);
    expect(Keyboard.setAccessoryBarVisible).not.toHaveBeenCalled();
  });

  it("leaves older iOS shells without the plugin alone", () => {
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(false);
    dispose = installNativeKeyboardAccessory();
    field.focus();
    tap(background);
    expect(document.activeElement).toBe(field);
    expect(Keyboard.setAccessoryBarVisible).not.toHaveBeenCalled();
  });

  it("hides the toolbar at startup and keeps it hidden across chat, forms and search", () => {
    dispose = installNativeKeyboardAccessory();
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledExactlyOnceWith({ isVisible: false });
    for (const control of [editor, field, document.querySelector("textarea")!, document.querySelector<HTMLInputElement>('[type="search"]')!, editor]) {
      control.focus();
      control.blur();
    }
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledExactlyOnceWith({ isVisible: false });
  });

  it.each(["#editor", "#name", "textarea", '[type="search"]'])("dismisses %s on a background tap without changing its value", (selector) => {
    dispose = installNativeKeyboardAccessory();
    const control = document.querySelector<HTMLElement>(selector)!;
    const before = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.value : control.textContent;
    control.focus();
    tap(background);
    expect(document.activeElement).not.toBe(control);
    expect(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.value : control.textContent).toBe(before);
  });

  it("also dismisses fields in dialogs mounted after installation", () => {
    dispose = installNativeKeyboardAccessory();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = '<input aria-label="Space name"><p>Space settings</p>';
    document.body.append(dialog);
    const input = dialog.querySelector("input")!;
    input.focus();
    tap(dialog.querySelector("p")!);
    expect(document.activeElement).not.toBe(input);
  });

  it("does not blur before field, label or action taps are handled", () => {
    dispose = installNativeKeyboardAccessory();
    field.focus();
    for (const selector of ["#editor span", "#name", "textarea", "label span", "button span", "a", '[role="switch"] span']) {
      tap(document.querySelector(selector)!);
      expect(document.activeElement).toBe(field);
    }
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledExactlyOnceWith({ isVisible: false });
  });

  it("preserves editing during scroll/drag gestures and leaves hardware keys alone", () => {
    dispose = installNativeKeyboardAccessory();
    field.focus();
    for (const type of ["pointerdown", "pointermove", "pointerup", "scroll"]) {
      background.dispatchEvent(new Event(type, { bubbles: true }));
    }
    for (const key of ["Tab", "Enter"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(field);
  });

  it("removes dismissal listeners without re-enabling the toolbar on disposal", () => {
    dispose = installNativeKeyboardAccessory();
    dispose();
    field.focus();
    tap(background);
    expect(document.activeElement).toBe(field);
    expect(Keyboard.setAccessoryBarVisible).toHaveBeenCalledExactlyOnceWith({ isVisible: false });
  });

  it("keeps fields usable if the native toolbar call fails", async () => {
    vi.mocked(Keyboard.setAccessoryBarVisible).mockRejectedValueOnce(new Error("Unavailable"));
    dispose = installNativeKeyboardAccessory();
    await Promise.resolve();
    field.focus();
    tap(background);
    expect(document.activeElement).not.toBe(field);
  });
});
