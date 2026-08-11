import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "..", "StudioSidebar.tsx"), "utf8");

/**
 * On macOS the shell uses `titleBarStyle: hiddenInset`, so the traffic lights
 * are drawn over the top-left of the web contents. The full-height rail owns
 * that corner -- not the workspace header -- so the rail is what has to absorb
 * the safe-area inset. Without it the collapse toggle renders directly beneath
 * the window buttons, which is what shipped through 0.2.5.
 *
 * Measured in the real shell: pre-fix the first rail control sat at y=0,
 * post-fix at y=38, the exact height of the traffic-light band.
 */
describe("studio sidebar safe-area inset", () => {
  const navClassName = source.slice(source.indexOf("<nav"), source.indexOf("<nav") + 900);

  it("pads the rail by the safe-area inset", () => {
    expect(navClassName).toContain("pt-[var(--instafy-safe-area-inset-top)]");
  });

  it("uses padding rather than margin so the rail paints behind the buttons", () => {
    expect(navClassName).not.toContain("mt-[var(--instafy-safe-area-inset-top)]");
  });
});
