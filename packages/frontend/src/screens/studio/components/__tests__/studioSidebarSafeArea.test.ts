import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DESKTOP_TITLE_BAR_HEIGHT_PX } from "../../../../lib/desktopShell";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "..", "StudioSidebar.tsx"), "utf8");

/**
 * On macOS the shell uses `titleBarStyle: hiddenInset`, so the traffic lights
 * are drawn over the top-left of the web contents. The full-height rail owns
 * that corner -- not the workspace header -- so the rail is what has to clear
 * them. Without that the collapse toggle renders directly beneath the window
 * buttons, which is what shipped through 0.2.5.
 *
 * There are two shapes, because the frontend outruns the shell: it publishes
 * to the web and reaches installed apps at once, so it must still do the
 * right thing inside a shell that predates the integrated title bar.
 */
describe("studio sidebar clears the macOS window buttons", () => {
  const nav = source.slice(source.indexOf("<nav"), source.indexOf("</nav>"));

  it("pads by the safe-area inset on shells that still own the title bar", () => {
    // Non-overlay rails own their safe-area padding, including older macOS shells.
    expect(nav).toContain("pt-[var(--instafy-safe-area-inset-top)]");
  });

  it("leaves the mobile overlay in charge of its surface and safe-area padding", () => {
    expect(nav).toMatch(/mobileOverlay\s*\? "overflow-hidden"\s*: titleBarFree/);
    expect(source).toContain("const titleBarFree = !mobileOverlay && desktopTitleBarFree()");
    const layout = fs.readFileSync(path.join(__dirname, "..", "..", "..", "StudioLayout.tsx"), "utf8");
    expect(layout).toMatch(/<StudioMobileSidebarOverlay[^>]*>[\s\S]*?<StudioSidebar\s+mobileOverlay/);
  });

  it("starts the rail surface on the tab baseline when the title bar is free", () => {
    expect(nav).toContain("DESKTOP_TITLE_BAR_HEIGHT_PX");
    expect(nav).toContain("titleBarFree");
    expect(DESKTOP_TITLE_BAR_HEIGHT_PX).toBe(48);
  });

  it("moves the background to a layer rather than padding the nav", () => {
    // Padding alone keeps painting the rail's background up to y=0, so the
    // buttons would still sit on the rail instead of on the title bar.
    expect(nav).toContain("data-rail-surface");
  });

  it("keeps rail content above that surface layer", () => {
    // The surface is absolutely positioned, so anything not lifted above it
    // renders behind the background and disappears. Scoped to all children so
    // a control added later cannot silently vanish.
    expect(nav).toContain("[&>*:not([data-rail-surface])]:z-[1]");
  });
});
