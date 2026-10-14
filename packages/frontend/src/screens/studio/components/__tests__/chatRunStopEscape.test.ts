// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRunStopEscapeBlocked } from "../chatRunStopEscape";

describe("chat run Stop Escape ownership", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
  const escape = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "Escape", ...init });
  it.each([
    { key: "Enter" }, { repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
  ])("ignores a non-plain Escape %j", (init) => {
    expect(chatRunStopEscapeBlocked(escape(init), { active: true })).toBe(true);
  });
  it("ignores inactive chats and explicit composer/browser blockers", () => {
    expect(chatRunStopEscapeBlocked(escape(), { active: false })).toBe(true);
    expect(chatRunStopEscapeBlocked(escape(), { active: true, blocked: true })).toBe(true);
  });
  it("ignores a hidden document", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
  });
  it.each([
    '<div role="dialog"></div>', '<div role="menu"></div>', '<div role="tooltip"></div>',
    '<div data-testid="chat-composer-overlay" data-expanded="true"></div>',
    '<div data-testid="assistant-mention-menu"></div>', '<div data-testid="chat-slash-command-menu"></div>',
    '<div data-testid="chat-saved-message-popover"></div>',
  ])("yields to existing surface %s", (html) => {
    document.body.innerHTML = html;
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
  });
  it("ignores a hidden old popup while allowing the normal composer", () => {
    document.body.innerHTML = '<div role="menu" hidden></div><div data-testid="chat-composer-overlay" data-browser-session-safe-zone="true"><textarea></textarea></div>';
    document.querySelector("textarea")!.focus();
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(false);
  });
  it("ignores Lexical's dormant typeahead anchors but yields when suggestions render", () => {
    document.body.innerHTML = '<div aria-label="Typeahead menu" role="listbox" style="display:block;position:absolute;"></div><div aria-label="Typeahead menu" role="listbox" style="display:block;position:absolute;"></div>';
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(false);
    const menu = document.querySelector('[role="listbox"]')!;
    menu.innerHTML = '<div role="option">Mention Octo</div>';
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
    menu.replaceChildren();
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(false);
  });
  it("keeps other listboxes and real menu/dialog surfaces as Escape owners even while empty", () => {
    for (const html of ['<div role="listbox"></div>', '<div role="menu"></div>', '<div role="dialog"></div>']) {
      document.body.innerHTML = html;
      expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
    }
  });
  it("ignores popup owners inside a display:none ancestor", () => {
    document.body.innerHTML = '<div style="display:none"><div><div role="menu"></div></div></div>';
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(false);
    document.body.firstElementChild!.removeAttribute("style");
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
  });
  it("preserves browser and editor Escape behavior", () => {
    document.body.innerHTML = '<div data-testid="personal-browser-surface"><button>Browser</button></div>';
    document.querySelector("button")!.focus();
    expect(chatRunStopEscapeBlocked(escape(), { active: true })).toBe(true);
  });
});
