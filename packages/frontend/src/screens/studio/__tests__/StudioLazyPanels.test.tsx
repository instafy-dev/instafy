// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel, SourceControlDrawer } from "../StudioLazyPanels";

vi.mock("../components/FilesPanel", () => new Promise(() => undefined));
vi.mock("../components/SourceControlDrawer", () => new Promise(() => undefined));

describe("Studio lazy panel fallbacks", () => {
  let root: Root;
  let container: HTMLDivElement;
  let portal: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    portal = document.createElement("div");
    document.body.append(container, portal);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps workspace tabs available while the file editor downloads", async () => {
    const selectChat = vi.fn();
    await act(async () => root.render(<FilesPanel previewOwnerId="user"
      tabsSlot={<button onClick={selectChat}>Conversation tab</button>} />));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading files");
    await act(async () => container.querySelector("button")?.click());
    expect(selectChat).toHaveBeenCalledOnce();
  });

  it("keeps the file drawer's loading status and Close inside its portal", async () => {
    const close = vi.fn();
    await act(async () => root.render(<FilesPanel previewOwnerId="user" renderMode="portal"
      explorerPortalTarget={portal} onRequestCloseExplorer={close} />));

    expect(container.textContent).toBe("");
    expect(portal.querySelector('[role="status"]')?.textContent).toContain("Loading files");
    await act(async () => portal.querySelector<HTMLButtonElement>('[aria-label="Close files"]')?.click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("allows closing Changes while its panel downloads", async () => {
    const close = vi.fn();
    await act(async () => root.render(<SourceControlDrawer onRequestClose={close} />));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading changes");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close changes"]')?.click());
    expect(close).toHaveBeenCalledOnce();
  });
});
