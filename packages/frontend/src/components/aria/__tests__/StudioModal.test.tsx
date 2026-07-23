/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioDialogModal } from "../StudioModal";

describe("StudioDialogModal appearances", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the adaptive light appearance by default", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal isOpen dialogAriaLabel="Default dialog">
          Default content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const modal = dialog?.parentElement;
    const overlay = modal?.parentElement;

    expect(modal?.classList.contains("dark")).toBe(false);
    expect(modal?.className).toContain("bg-white");
    expect(modal?.className).toContain("dark:bg-[var(--color-studio-dark-panel)]");
    expect(overlay?.className).toContain("bg-black/40");
  });

  it("provides an always-dark root for dark dialog descendants", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal
          isOpen
          appearance="dark"
          dialogAriaLabel="Dark dialog"
          modalClassName="feature-modal"
        >
          Dark content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const modal = dialog?.parentElement;
    const overlay = modal?.parentElement;

    expect(modal?.classList.contains("dark")).toBe(true);
    expect(modal?.className).toContain("border-white/10");
    expect(modal?.className).toContain("bg-zinc-950");
    expect(modal?.className).toContain("feature-modal");
    expect(overlay?.className).toContain("bg-zinc-950/70");
    expect(overlay?.className).toContain("backdrop-blur-sm");
  });

  it("supports an opaque backdrop for immersive dark surfaces", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal
          isOpen
          appearance="dark"
          backdrop="opaque"
          dialogAriaLabel="Immersive dialog"
        >
          Immersive content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const overlay = dialog?.parentElement?.parentElement;

    expect(overlay?.className).toContain("bg-zinc-950");
    expect(overlay?.className).not.toContain("bg-zinc-950/70");
    expect(overlay?.className).not.toContain("backdrop-blur-sm");
  });
});
