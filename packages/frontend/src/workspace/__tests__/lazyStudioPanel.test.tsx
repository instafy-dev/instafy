// @vitest-environment jsdom

import { act, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyStudioPanel } from "../lazyStudioPanel";

function deferred<Props extends object>() {
  let resolve!: (module: { default: ComponentType<Props> }) => void;
  const promise = new Promise<{ default: ComponentType<Props> }>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("lazy Studio panels", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  it("downloads only the selected panel and keeps the chat usable while it loads", async () => {
    const pending = deferred<{ path: string }>();
    const loadFiles = vi.fn(() => pending.promise);
    const loadSettings = vi.fn(async () => ({ default: () => <div>Settings</div> }));
    const Files = lazyStudioPanel("Files", loadFiles);
    lazyStudioPanel("Settings", loadSettings);
    const onChatAction = vi.fn();
    expect(loadFiles).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();

    await act(async () => root.render(<>
      <button onClick={onChatAction}>Chat action</button>
      <Files path="notes.md" />
    </>));
    expect(loadFiles).toHaveBeenCalledOnce();
    expect(loadSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading files");
    await act(async () => container.querySelector("button")?.click());
    expect(onChatAction).toHaveBeenCalledOnce();

    await act(async () => pending.resolve({ default: ({ path }) => <div data-testid="file">{path}</div> }));
    expect(container.querySelector('[data-testid="file"]')?.textContent).toBe("notes.md");
    expect(container.querySelector('[data-testid="studio-panel-loading"]')).toBeNull();

    await act(async () => root.render(null));
    await act(async () => root.render(<Files path="next.md" />));
    expect(loadFiles).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="file"]')?.textContent).toBe("next.md");
    expect(container.querySelector('[data-testid="studio-panel-loading"]')).toBeNull();
  });

  it("contains a failed download and retries it without reloading the workspace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recovered = deferred<{ space: string }>();
    const load = vi.fn<() => Promise<{ default: ComponentType<{ space: string }> }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockReturnValueOnce(recovered.promise);
    const Settings = lazyStudioPanel("Settings", load);
    await act(async () => root.render(<><div>Current chat</div><Settings space="space-a" /></>));

    expect(container.textContent).toContain("Current chat");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load settings");
    await act(async () => container.querySelector("button")?.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading settings");
    await act(async () => recovered.resolve({ default: ({ space }) => <div>Settings for {space}</div> }));
    expect(container.textContent).toContain("Settings for space-a");

    await act(async () => root.render(null));
    await act(async () => root.render(<Settings space="space-b" />));
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Settings for space-b");
  });

  it("shows loading and error recovery inside a portal drawer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const load = vi.fn<() => Promise<{ default: ComponentType<{ target: Element | null }> }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const Files = lazyStudioPanel("Files", load, (fallback, props) =>
      props.target ? createPortal(fallback, props.target) : null,
    );
    try {
      await act(async () => root.render(<Files target={target} />));
      expect(container.textContent).toBe("");
      expect(target.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load files");
      await act(async () => target.querySelector("button")?.click());
      expect(target.querySelector('[role="status"]')?.textContent).toContain("Loading files");
      expect(container.textContent).toBe("");
    } finally {
      await act(async () => root.render(null));
      target.remove();
    }
  });

  it("does not replace a newly selected chat when an obsolete panel finishes loading", async () => {
    const pending = deferred<Record<string, never>>();
    const Files = lazyStudioPanel("Files", () => pending.promise);
    await act(async () => root.render(<Files />));
    await act(async () => root.render(<div>Selected chat</div>));
    await act(async () => pending.resolve({ default: () => <div>Files</div> }));
    expect(container.textContent).toBe("Selected chat");
  });
});
