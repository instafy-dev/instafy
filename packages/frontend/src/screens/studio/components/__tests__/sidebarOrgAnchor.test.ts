import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The sidebar used to render teams as a chip strip that flipped from a
 * vertical column (collapsed) to a horizontal wrap (expanded). The strip's
 * height changed with the flip, so every nav row below it jumped on expand.
 * StudioSidebar is too provider-heavy to mount in jsdom, so — like the
 * safe-area and roster placement guards — these assertions read the source.
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

  it("shows teams exactly once, as the deck inside the team & spaces row", () => {
    const deckRenders = sidebar.match(/<SidebarOrgDeck\b/g) ?? [];
    // Desktop and mobile share one trigger; only the panel presentation changes.
    expect(deckRenders.length).toBe(1);
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
