// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearIdlePaused,
  clearRestoredAwaitingIntent,
  isIdlePaused,
  isRestoredAwaitingIntent,
  markIdlePaused,
  markRestoredAwaitingIntent,
} from "../../idlePauseRegistry";
import { useComposerIntentWake } from "../useComposerIntentWake";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function Studio({ projectId }: { projectId: string | null }) {
  useComposerIntentWake(projectId);
  return (
    <>
      <nav>
        <button type="button" data-testid="space-switcher">Other space</button>
        <button type="button" data-testid="machines-rail">Machines</button>
      </nav>
      <div id="studio-chat-input" contentEditable suppressContentEditableWarning tabIndex={0}>
        <p>
          <span data-testid="composer-text">draft</span>
        </p>
      </div>
    </>
  );
}

describe("useComposerIntentWake", () => {
  let container: HTMLDivElement;
  let root: Root;

  const element = (selector: string) => {
    const found = container.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`missing ${selector}`);
    return found;
  };
  const composer = () => element("#studio-chat-input");
  const fire = (target: HTMLElement, event: Event) => {
    act(() => {
      target.dispatchEvent(event);
    });
  };
  const pointerDown = () => new Event("pointerdown", { bubbles: true });
  const keyDown = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key, bubbles: true, ...init });

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Studio projectId={PROJECT_ID} />);
    });
    markIdlePaused(PROJECT_ID);
    markRestoredAwaitingIntent(PROJECT_ID);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearIdlePaused(PROJECT_ID);
    clearRestoredAwaitingIntent(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not wake on clicks and keys outside the composer", () => {
    // Choosing another space or opening Machines must not start the machine
    // of the space being left.
    fire(element('[data-testid="space-switcher"]'), pointerDown());
    fire(element('[data-testid="machines-rail"]'), pointerDown());
    fire(element('[data-testid="machines-rail"]'), keyDown("a"));
    fire(document.body, keyDown("Enter"));

    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(true);
  });

  it("does not wake when focus reaches the composer on its own", () => {
    // A dialog handing focus back, or focus kept across a space switch.
    act(() => {
      composer().focus();
    });
    fire(composer(), new FocusEvent("focusin", { bubbles: true }));

    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(true);
  });

  it("does not wake on shortcuts and navigation keys pressed in the composer", () => {
    // Cmd+K opens search, which can switch spaces.
    fire(composer(), keyDown("k", { metaKey: true }));
    fire(composer(), keyDown("k", { ctrlKey: true }));
    fire(composer(), keyDown("Escape"));
    fire(composer(), keyDown("Tab"));
    fire(composer(), keyDown("ArrowUp"));

    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(true);
  });

  it("ignores keydown events that carry no key, in the composer and outside it", () => {
    // Chrome autofill dispatches these; reading their key must not throw.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      fire(document.body, new Event("keydown", { bubbles: true }));
      fire(composer(), new Event("keydown", { bubbles: true }));
    } finally {
      window.removeEventListener("error", onError);
    }

    expect(errors).toEqual([]);
    expect(isIdlePaused(PROJECT_ID)).toBe(true);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(true);
  });

  it.each([
    ["clicking into it", () => fire(element('[data-testid="composer-text"]'), pointerDown())],
    ["typing a letter", () => fire(composer(), keyDown("a"))],
    ["deleting", () => fire(composer(), keyDown("Backspace"))],
    ["text arriving without a plain key", () =>
      fire(composer(), new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "é" }))],
    ["an edit", () => fire(composer(), new InputEvent("input", { bubbles: true, inputType: "insertText", data: "a" }))],
  ])("wakes on %s in the composer", (_label, trigger) => {
    trigger();

    expect(isIdlePaused(PROJECT_ID)).toBe(false);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(false);
  });

  it("wakes the space it is mounted for, not the one left", async () => {
    const otherProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    markRestoredAwaitingIntent(otherProjectId);
    await act(async () => {
      root.render(<Studio projectId={otherProjectId} />);
    });

    fire(composer(), keyDown("a"));

    expect(isRestoredAwaitingIntent(otherProjectId)).toBe(false);
    expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(true);
    clearRestoredAwaitingIntent(otherProjectId);
  });
});
