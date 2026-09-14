// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectChipStrip } from "../ConnectChipStrip";
import { CARD_CHIP_CONNECTORS, CONNECTORS } from "../connectors";

const EXPECTED_CHIP_IDS = ["slack", "notion", "discord"];
const EM_DASH = "—";

describe("ConnectChipStrip", () => {
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
    document.documentElement.classList.remove("dark");
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: Partial<Parameters<typeof ConnectChipStrip>[0]> = {}) {
    await act(async () => {
      root.render(
        <ConnectChipStrip
          installedSkillNames={new Set()}
          onSelect={vi.fn()}
          onMoreTools={vi.fn()}
          {...props}
        />,
      );
    });
  }

  function chipButtons(): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid^="connect-chip-"]'),
    ).filter(
      (element) =>
        element instanceof HTMLButtonElement && !element.dataset.testid?.endsWith("-connected"),
    );
  }

  it("renders exactly the featured skill chips, in order, then the More tools link", async () => {
    await render();

    const strip = container.querySelector('[data-testid="connect-chip-strip"]');
    expect(strip?.tagName).toBe("UL");
    const chips = chipButtons();
    expect(chips.map((chip) => chip.dataset.testid)).toEqual(
      EXPECTED_CHIP_IDS.map((id) => `connect-chip-${id}`),
    );
    expect(chips.map((chip) => chip.dataset.testid)).toEqual(
      CARD_CHIP_CONNECTORS.map((entry) => `connect-chip-${entry.id}`),
    );
    expect(container.querySelector('[data-testid="connect-chip-github"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-freefinance"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-other"]')).toBeNull();
    for (const [index, chip] of chips.entries()) {
      const entry = CARD_CHIP_CONNECTORS[index]!;
      expect(chip.textContent).toBe(entry.name);
      expect(chip.querySelector("svg")).not.toBeNull();
    }
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid$="-connected"]')).toBeNull();

    // The trailing link is text only, last in the list, and no chip.
    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(more?.textContent).toBe("More tools");
    expect(more?.querySelector("svg")).toBeNull();
    expect(strip?.lastElementChild?.contains(more!)).toBe(true);
    expect(container.textContent).not.toContain("Paste a skill link");
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("reports the pressed skill and opens the browse sheet from More tools", async () => {
    const onSelect = vi.fn();
    const onMoreTools = vi.fn();
    await render({ onSelect, onMoreTools });

    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    await act(async () => notion.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(CONNECTORS.find((entry) => entry.id === "notion"));
    expect(onMoreTools).not.toHaveBeenCalled();

    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]')!;
    await act(async () => more.click());
    expect(onMoreTools).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("gives every chip an accessible name with the verb, and names connected ones", async () => {
    await render();
    const label = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="connect-chip-${id}"]`)?.getAttribute("aria-label");
    expect(label("slack")).toBe("Connect Slack");
    expect(label("discord")).toBe("Connect Discord");

    await render({ installedSkillNames: new Set(["slack"]) });
    expect(label("slack")).toBe("Slack, connected");
    expect(label("notion")).toBe("Connect Notion");
  });

  it("shows the check glyph only for installed skill folders", async () => {
    await render({ installedSkillNames: new Set(["slack", "other", "github"]) });

    const check = container.querySelector('[data-testid="connect-chip-slack-connected"]');
    expect(check).not.toBeNull();
    expect(check?.tagName.toLowerCase()).toBe("svg");
    // The state is a glyph after the name, not an uppercase pill.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-slack"]')?.textContent,
    ).toBe("Slack");
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(1);
  });

  it("keeps the same DOM shape in the dark theme", async () => {
    await render({ installedSkillNames: new Set(["discord"]) });
    const lightShape = chipButtons().map((chip) => ({
      id: chip.dataset.testid,
      svg: chip.querySelectorAll("svg").length,
      text: chip.textContent,
    }));

    document.documentElement.classList.add("dark");
    await render({ installedSkillNames: new Set(["discord"]) });
    const darkShape = chipButtons().map((chip) => ({
      id: chip.dataset.testid,
      svg: chip.querySelectorAll("svg").length,
      text: chip.textContent,
    }));

    expect(darkShape).toEqual(lightShape);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord-connected"]')).not.toBeNull();
  });
});
