// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { EntryLoadingScreen } from "../EntryLoadingScreen";

// The handoff between the landing and login (and the studio's startup) sits on
// the marketing paper in both themes, so it never flashes white between two
// paper pages.
it("paints the handoff on the marketing paper, never plain white", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EntryLoadingScreen />));
    const screen = container.querySelector('[data-testid="entry-loading-screen"]') as HTMLElement;
    expect(screen.classList.contains("bg-[var(--marketing-canvas)]")).toBe(true);
    expect(Array.from(screen.classList).filter((name) => /(^|:)bg-white$/.test(name))).toEqual([]);
    expect(screen.querySelector('[role="status"]')?.textContent).toBe("Getting things ready…");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
