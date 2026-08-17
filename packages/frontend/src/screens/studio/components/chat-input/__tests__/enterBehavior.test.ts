import { describe, expect, it } from "vitest";
import { resolveComposerEnterAction } from "../enterBehavior";

function resolve(
  overrides: Partial<Parameters<typeof resolveComposerEnterAction>[0]> = {},
) {
  return resolveComposerEnterAction({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    hasOpenMenu: false,
    hasActiveMatchingAgent: false,
    ...overrides,
  });
}

describe("resolveComposerEnterAction", () => {
  it("sends with Enter while the matching agent is idle", () => {
    expect(resolve()).toBe("send");
  });

  it("steers with Enter while a matching agent is active", () => {
    expect(resolve({ hasActiveMatchingAgent: true })).toBe("steer");
  });

  it("queues explicitly with Command+Enter or Ctrl+Enter", () => {
    expect(resolve({ metaKey: true, hasActiveMatchingAgent: true })).toBe("queue");
    expect(resolve({ ctrlKey: true, hasActiveMatchingAgent: false })).toBe("queue");
  });

  it("stashes with Command/Ctrl+Shift+Enter", () => {
    expect(resolve({ metaKey: true, shiftKey: true })).toBe("stash");
    expect(resolve({ ctrlKey: true, shiftKey: true })).toBe("stash");
  });

  it("leaves Shift+Enter and Alt+Enter to the editor as newlines", () => {
    expect(resolve({ shiftKey: true })).toBe("newline");
    expect(resolve({ altKey: true })).toBe("newline");
  });

  it("preserves IME composition and open-menu selection behavior", () => {
    expect(resolve({ isComposing: true, hasActiveMatchingAgent: true })).toBe("ignore");
    expect(resolve({ hasOpenMenu: true, hasActiveMatchingAgent: true })).toBe("menu");
  });

  it("ignores non-Enter keys", () => {
    expect(resolve({ key: "Tab" })).toBe("ignore");
  });

  it("does not depend on whether a draft is single-line or multiline", () => {
    expect(resolve({ hasActiveMatchingAgent: true })).toBe("steer");
    expect(resolve({ hasActiveMatchingAgent: false })).toBe("send");
  });
});
