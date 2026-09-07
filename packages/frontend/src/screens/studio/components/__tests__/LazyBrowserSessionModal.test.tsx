// @vitest-environment jsdom

import { act, useLayoutEffect, type ComponentProps, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionModal } from "../BrowserSessionModal";
import { ChatBrowserDock } from "../ChatBrowserDock";
import { createLazyBrowserSessionModal } from "../LazyBrowserSessionModal";

const { moduleImported } = vi.hoisted(() => ({ moduleImported: vi.fn() }));

vi.mock("../BrowserSessionModal", () => {
  moduleImported();
  return {
    BrowserSessionModal: ({ projectId }: { projectId: string | null }) => (
      <div data-testid="imported-browser">{projectId}</div>
    ),
  };
});

type BrowserProps = ComponentProps<typeof BrowserSessionModal>;
type BrowserModule = { BrowserSessionModal: ComponentType<BrowserProps> };

function deferred() {
  let resolve!: (module: BrowserModule) => void;
  const promise = new Promise<BrowserModule>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function props(overrides: Partial<BrowserProps> = {}): BrowserProps {
  return {
    isOpen: true,
    onOpenChange: vi.fn(),
    projectId: "project-a",
    preferRuntimeId: "runtime-a",
    presentation: "docked",
    ...overrides,
  };
}

function button(scope: ParentNode, label: string) {
  const match = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => element.textContent === label);
  expect(match, `Expected the ${label} button`).toBeDefined();
  return match!;
}

describe("lazy shared browser code", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps chat, toolbar, Back and Close usable during a delayed browser download", async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    const Browser = createLazyBrowserSessionModal(load);
    const onChat = vi.fn();
    const onToolbar = vi.fn();
    const onBackToChat = vi.fn();
    const onOpenChange = vi.fn();
    expect(load).not.toHaveBeenCalled();

    await act(async () => root.render(<>
      <button onClick={onChat}>Current chat</button>
      <Browser {...props({
        onBackToChat,
        onOpenChange,
        toolbarLeading: <button onClick={onToolbar}>Browser tabs</button>,
      })} />
    </>));

    expect(load).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading shared browser");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    for (const label of ["Current chat", "Browser tabs", "Back to chat", "Close"]) {
      await act(async () => button(container, label).click());
    }
    expect(onChat).toHaveBeenCalledOnce();
    expect(onToolbar).toHaveBeenCalledOnce();
    expect(onBackToChat).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps modal loading and Close inside the accessible dialog", async () => {
    const pending = deferred();
    const Browser = createLazyBrowserSessionModal(() => pending.promise);
    const onOpenChange = vi.fn();
    await act(async () => root.render(<Browser {...props({ presentation: "modal", onOpenChange })} />));

    const dialog = document.body.querySelector('[role="dialog"][aria-label="Shared browser"]');
    expect(dialog).not.toBeNull();
    expect(container.querySelector('[data-testid="browser-session-code-loading"]')).toBeNull();
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain("Loading shared browser");
    await act(async () => button(dialog!, "Close").click());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("recovers a failed chunk with Retry and never commits a fallback on a warm remount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recovered = deferred();
    const load = vi.fn<() => Promise<BrowserModule>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockReturnValueOnce(recovered.promise);
    const Browser = createLazyBrowserSessionModal(load);
    const onBackToChat = vi.fn();
    const onOpenChange = vi.fn();
    await act(async () => root.render(<>
      <div>Current chat</div>
      <Browser {...props({ onBackToChat, onOpenChange })} />
    </>));

    expect(container.textContent).toContain("Current chat");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load the shared browser");
    await act(async () => button(container, "Back to chat").click());
    await act(async () => button(container, "Close").click());
    expect(onBackToChat).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => button(container, "Retry").click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading shared browser");
    await act(async () => recovered.resolve({
      BrowserSessionModal: ({ projectId }) => <div data-testid="ready-browser">{projectId}</div>,
    }));
    expect(container.querySelector('[data-testid="ready-browser"]')?.textContent).toBe("project-a");

    await act(async () => root.render(null));
    const committedFallbacks: boolean[] = [];
    function WarmVisit() {
      useLayoutEffect(() => {
        committedFallbacks.push(Boolean(container.querySelector('[data-testid="browser-session-code-loading"]')));
      });
      return <Browser {...props({ projectId: "project-b" })} />;
    }
    await act(async () => root.render(<WarmVisit />));
    expect(committedFallbacks).toEqual([false]);
    expect(container.querySelector('[data-testid="ready-browser"]')?.textContent).toBe("project-b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hides pending UI while keeping the same resolved browser instance and current session props", async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    const Browser = createLazyBrowserSessionModal(load);
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const observed: BrowserProps[] = [];
    function Viewer(viewerProps: BrowserProps) {
      useLayoutEffect(() => { mounted(); return unmounted; }, []);
      useLayoutEffect(() => { observed.push(viewerProps); });
      return <div data-testid="retained-browser" hidden={!viewerProps.isOpen} />;
    }
    const initial = props({ browserSessionId: "session-a", transportActive: true, canControlBrowser: true });
    await act(async () => root.render(<Browser {...initial} />));
    const hidden = { ...initial, isOpen: false, transportActive: false, canControlBrowser: false };
    await act(async () => root.render(<Browser {...hidden} />));
    expect(container.querySelector('[data-testid="browser-session-code-loading"]')).toBeNull();
    await act(async () => pending.resolve({ BrowserSessionModal: Viewer }));

    const retained = container.querySelector('[data-testid="retained-browser"]');
    expect(retained?.hasAttribute("hidden")).toBe(true);
    expect(observed.at(-1)).toEqual(hidden);
    const reopened = { ...initial, expandRequestToken: 2, sharedBrowserViewerKind: "cdp-screencast" as const };
    await act(async () => root.render(<Browser {...reopened} />));
    expect(container.querySelector('[data-testid="retained-browser"]')).toBe(retained);
    expect(retained?.hasAttribute("hidden")).toBe(false);
    expect(observed.at(-1)).toEqual(reopened);
    await act(async () => root.render(<Browser {...hidden} />));
    expect(observed.at(-1)).toEqual(hidden);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not replace the selected chat when an obsolete browser download finishes", async () => {
    const pending = deferred();
    const Browser = createLazyBrowserSessionModal(() => pending.promise);
    const rendered = vi.fn(() => <div>Obsolete browser</div>);
    await act(async () => root.render(<Browser {...props()} />));
    await act(async () => root.render(<div>Selected chat</div>));
    await act(async () => pending.resolve({ BrowserSessionModal: rendered }));
    expect(container.textContent).toBe("Selected chat");
    expect(rendered).not.toHaveBeenCalled();
  });

  it("does not import browser code when the dock disables its modal", async () => {
    const dockProps: ComponentProps<typeof ChatBrowserDock> = {
      browserSessionOpen: true,
      onBrowserSessionOpenChange: vi.fn(),
      projectId: "project-a",
      preferredRuntimeId: "runtime-a",
      showBrowserSessionPageStrip: false,
      browserSessionExpandRequestToken: 0,
      onBrowserRuntimeIdResolved: vi.fn(),
      browserSessionPages: [],
      onSelectBrowserSessionPage: vi.fn(),
      onToggleBrowserSession: vi.fn(),
      onClearPendingNewBrowserSession: vi.fn(),
      hasHiddenBrowserSession: false,
      pendingBrowserLaunchMode: null,
      renderModal: false,
    };
    expect(moduleImported).not.toHaveBeenCalled();
    await act(async () => root.render(<ChatBrowserDock {...dockProps} />));
    expect(moduleImported).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="browser-session-code-loading"]')).toBeNull();

    await act(async () => root.render(<ChatBrowserDock {...dockProps} renderModal />));
    expect(moduleImported).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="imported-browser"]')?.textContent).toBe("project-a");
  });
});
