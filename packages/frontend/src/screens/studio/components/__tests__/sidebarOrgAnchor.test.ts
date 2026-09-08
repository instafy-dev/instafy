import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The sidebar used to render teams as a chip strip that flipped from a
 * vertical column (collapsed) to a horizontal wrap (expanded). The strip's
 * height changed with the flip, so every nav row below it jumped on expand.
 * The permanent rail now has its own rendered regression suite. These
 * legacy guards cover the remaining mobile deck and prevent axis flips.
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

  it("retains one mobile deck alongside the dedicated desktop rail", () => {
    const deckRenders = sidebar.match(/<SidebarOrgDeck\b/g) ?? [];
    // The mobile drawer keeps its deck; desktop renders the permanent rail.
    expect(deckRenders.length).toBe(1);
    expect(sidebar).toContain("<StudioOrganizationRail");
    expect(sidebar).not.toContain("sidebar-team-chip-");
  });

  it("gives the deck the same fixed icon shell in both rail states", () => {
    // The shell size class is the one the collapsed/expanded rows already
    // share for every nav icon; the deck fills it (h-full w-full) so the row
    // keeps its height when the rail expands.
    const shellUses = sidebar.match(/\$\{sidebarIconShellSizeClass\} shrink-0 items-center justify-center rounded-lg/g) ?? [];
    expect(shellUses.length).toBe(1);
  });
});
