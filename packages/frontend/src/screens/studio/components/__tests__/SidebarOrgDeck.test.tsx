// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarOrgDeck } from "../SidebarOrgDeck";

describe("SidebarOrgDeck", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const edges = () => container.querySelectorAll('[data-testid="sidebar-org-deck-edge"]');
  const card = () => container.querySelector('[data-testid="sidebar-org-deck-card"]');
  const badge = () => container.querySelector('[data-testid="sidebar-org-deck-attention"]');

  it("renders a single team as a plain card — no deck edges, no badge", async () => {
    await act(async () => {
      root.render(
        <SidebarOrgDeck
          team={{ key: "personal", name: "Personal", avatarUrl: null }}
          teamCount={1}
          otherAttentionCount={0}
        />,
      );
    });

    expect(card()?.textContent).toBe("P");
    expect(edges().length).toBe(0);
    expect(container.querySelector('[data-testid="sidebar-org-deck"]')?.getAttribute("data-stacked")).toBeNull();
    // AttentionBadge renders nothing at zero.
    expect(badge()).toBeNull();
  });

  it("stacks into a deck above one team and rolls up the other teams' attention", async () => {
    await act(async () => {
      root.render(
        <SidebarOrgDeck
          team={{ key: "acme", name: "Acme Co", avatarUrl: null }}
          teamCount={3}
          otherAttentionCount={4}
        />,
      );
    });

    expect(card()?.textContent).toBe("AC");
    expect(edges().length).toBe(2);
    expect(container.querySelector('[data-testid="sidebar-org-deck"]')?.getAttribute("data-stacked")).toBe("true");
    expect(badge()?.textContent).toBe("4");
  });

  it("prefers the team avatar over initials and flags an in-flight switch", async () => {
    await act(async () => {
      root.render(
        <SidebarOrgDeck
          team={{ key: "fp", name: "Fairplanen", avatarUrl: "https://example.test/fp.png" }}
          teamCount={2}
          otherAttentionCount={0}
          pending
        />,
      );
    });

    const image = card()?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.test/fp.png");
    expect(card()?.textContent).toBe("");
    expect(container.querySelector('[data-testid="sidebar-org-deck"]')?.getAttribute("aria-busy")).toBe("true");
    expect(card()?.className).toContain("animate-pulse");
  });

  it("keeps a fixed footprint regardless of team count — the anchor never reflows", async () => {
    const classesFor = async (teamCount: number) => {
      await act(async () => {
        root.render(
          <SidebarOrgDeck
            team={{ key: "personal", name: "Personal", avatarUrl: null }}
            teamCount={teamCount}
            otherAttentionCount={0}
          />,
        );
      });
      return container.querySelector('[data-testid="sidebar-org-deck"]')?.className ?? "";
    };

    const single = await classesFor(1);
    const stacked = await classesFor(5);
    // Same box in both cases: the deck edges are absolutely positioned inside it.
    expect(single).toContain("h-full w-full");
    expect(stacked).toBe(single);
  });
});
