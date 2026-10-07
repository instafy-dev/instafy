import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A space's machine starts only when someone asks for it. StudioLayout used
 * to lift the idle pause on any pointerdown or keydown in the window, so a
 * click on the space switcher or the Machines rail started the machine of the
 * space being left. useComposerIntentWake.test.tsx covers what counts as
 * intent; StudioLayout is wired to too many providers to mount here, so these
 * assertions read its source to keep that hook the only wake it has.
 */
const screensDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const studioLayout = fs.readFileSync(path.resolve(screensDir, "StudioLayout.tsx"), "utf8");

describe("StudioLayout machine wake", () => {
  it("wakes the active space only through the composer", () => {
    expect(studioLayout).toContain("useComposerIntentWake(activeProjectId);");
    // The holds are lifted by the hook, Send or Start, never by the layout's
    // own listeners.
    expect(studioLayout).not.toMatch(/\bclearIdlePaused\b/);
    expect(studioLayout).not.toMatch(/\bclearRestoredAwaitingIntent\b/);
  });
});
