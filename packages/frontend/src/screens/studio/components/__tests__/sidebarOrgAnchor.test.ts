import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The sidebar used to render teams as a chip strip that flipped from a
 * vertical column (collapsed) to a horizontal wrap (expanded). The strip's
 * height changed with the flip, so every nav row below it jumped on expand.
 * Rendered organization-navigation tests cover the permanent rail and mobile
 * header. This legacy guard prevents reintroducing the old axis flip.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const sidebar = fs.readFileSync(path.resolve(componentsDir, "StudioSidebar.tsx"), "utf8");

describe("sidebar org anchor", () => {
  it("no longer renders the reflowing team chip strip", () => {
    expect(sidebar).not.toContain('data-testid="sidebar-team-rail"');
    expect(sidebar).not.toContain("sidebar-team-rail-placeholder");
    // The axis flip itself: an org container whose direction depended on the
    // expanded state.
    expect(sidebar).not.toMatch(/showLabels\s*\?\s*"flex-row flex-wrap[^"]*"\s*:\s*"flex-col/);
  });
});
