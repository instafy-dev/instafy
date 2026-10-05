// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesExplorerToolbar } from "../FilesExplorerToolbar";

describe("Files explorer controls", () => {
  let container: HTMLDivElement;
  let header: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("min-width: 900px") && window.innerWidth >= 900,
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    header = document.createElement("div");
    document.body.append(container, header);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); header.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function Harness({ initialQuery = "", rootPath = "", onFocus = vi.fn() }) {
    const [query, setQuery] = useState(initialQuery);
    return <FilesExplorerToolbar rootPath={rootPath} onFocusDirectory={onFocus}
      searchTerm={query} onSearchTermChange={setQuery}
      headerPortalTarget={header} renderMobileHeader={page => createPortal(page.actions, header)}
      actions={<button>New file</button>} />;
  }
  const toggle = () => header.querySelector<HTMLButtonElement>('[data-testid="files-explorer-search-toggle"]')!;

  it.each([390, 1280])("opens the file filter on demand and restores focus with Escape at %ipx", async width => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    await act(async () => root.render(<Harness />));
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector('[aria-label="File location"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle().click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-label")).toBe("Filter loaded files");
    expect(container.textContent).toContain("Only loaded folders are included.");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("keeps a retained query visible and clears it when closing the filter", async () => {
    await act(async () => root.render(<Harness initialQuery="readme" />));
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("readme");
    await act(async () => toggle().click());
    expect(container.querySelector("input")).toBeNull();
    await act(async () => toggle().click());
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("");
  });

  it("shows parent navigation only below the workspace root", async () => {
    const onFocus = vi.fn();
    await act(async () => root.render(<Harness rootPath="src/components" onFocus={onFocus} />));
    expect(container.querySelector('[aria-current="location"]')?.textContent).toBe("components");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Focus root folder"]')?.click());
    expect(onFocus).toHaveBeenCalledWith("");
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="src"]')?.click());
    expect(onFocus).toHaveBeenCalledWith("src");
  });
});
