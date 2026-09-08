// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerActionMenu } from "../ComposerActionMenu";
import { ChatImageLightboxOverlay } from "../ChatPanelOverlays";
import { useNativeBackButtonAction } from "../../../../native/useNativeBackButtonAction";

const native = vi.hoisted(() => ({ back: null as (() => void) | null, remove: vi.fn() }));
vi.mock("@capacitor/core", async (original) => ({
  ...await original<typeof import("@capacitor/core")>(),
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async (_name: string, callback: () => void) => {
  native.back = callback;
  return { remove: native.remove };
}) } }));

function Harness({ onUnderlyingBack }: { onUnderlyingBack: () => void }) {
  const [imageOpen, setImageOpen] = useState(false);
  useNativeBackButtonAction(true, onUnderlyingBack);
  return <>
    <ComposerActionMenu pendingNewBrowser={false} onOpenBrowser={() => undefined}
      onOpenNewBrowser={() => undefined} onOpenInvite={() => undefined}
      onImportGithubRepo={() => undefined} onInsertCommand={() => undefined}
      onQueueMessage={() => undefined} onStashDraft={() => undefined}
      triggerIconClassName="h-4 w-4" touchLikeInput />
    <button data-testid="open-image" onClick={() => setImageOpen(true)}>Image</button>
    <ChatImageLightboxOverlay imageLightbox={imageOpen ? { src: "data:image/png;base64,AA==", alt: "Fixture" } : null}
      onClose={() => setImageOpen(false)} />
  </>;
}

describe("composer native Back layers", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.back = null;
    native.remove.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function click(selector: string) {
    await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());
  }
  async function back() { await act(async () => native.back?.()); }

  it("uses Back for the commands submenu, then the menu, before underlying navigation", async () => {
    const underlying = vi.fn();
    await act(async () => root.render(<Harness onUnderlyingBack={underlying} />));
    await click('[data-testid="composer-action-menu-trigger"]');
    expect(document.querySelector('[data-testid="composer-action-menu-enter-hint"]')?.textContent).toContain("Enter adds a line");
    const commands = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Commands"));
    expect(commands).toBeDefined();
    await act(async () => commands!.click());
    expect(document.querySelector('[data-testid="composer-action-menu-enter-hint"]')).toBeNull();
    await back();
    expect(document.querySelector('[data-testid="composer-action-menu-enter-hint"]')).not.toBeNull();
    expect(underlying).not.toHaveBeenCalled();
    await back();
    expect(document.querySelector('[data-testid="composer-action-menu"]')).toBeNull();
    expect(underlying).not.toHaveBeenCalled();
    await back();
    expect(underlying).toHaveBeenCalledOnce();
  });

  it("dismisses the latest image preview only, keeping the composer menu beneath it", async () => {
    const underlying = vi.fn();
    await act(async () => root.render(<Harness onUnderlyingBack={underlying} />));
    await click('[data-testid="composer-action-menu-trigger"]');
    // Dispatching this button directly models opening another controlled layer
    // while the menu remains open; native Back still has a single top owner.
    await click('[data-testid="open-image"]');
    expect(document.querySelector('[data-testid="chat-image-lightbox"]')).not.toBeNull();
    await back();
    expect(document.querySelector('[data-testid="chat-image-lightbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="composer-action-menu"]')).not.toBeNull();
    expect(underlying).not.toHaveBeenCalled();
    await back();
    expect(document.querySelector('[data-testid="composer-action-menu"]')).toBeNull();
    expect(underlying).not.toHaveBeenCalled();
  });
});
