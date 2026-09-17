// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectChipStrip } from "../ConnectChipStrip";
import { CARD_CHIP_CONNECTORS, isConnectorAvailable } from "../connectors";

const EXPECTED_CHIP_IDS = ["slack", "notion", "discord"];
const EM_DASH = "—";

// Notion's pack is published, so its chip is the pressable path; Slack and
// Discord are still "soon" (packs not published), which covers the disabled
// path and its precedence over the installed state.
const SOON_CHIP_IDS = CARD_CHIP_CONNECTORS.filter((entry) => !isConnectorAvailable(entry)).map(
  (entry) => entry.id,
);
const notionConnector = CARD_CHIP_CONNECTORS.find((entry) => entry.id === "notion")!;

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
      expect(chip.textContent).toBe(
        isConnectorAvailable(entry) ? entry.name : `${entry.name}Soon`,
      );
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

  it("renders a soon chip disabled with a Soon Badge after the name", async () => {
    await render();
    expect(SOON_CHIP_IDS).toEqual(["slack", "discord"]);

    for (const id of SOON_CHIP_IDS) {
      const chip = container.querySelector<HTMLButtonElement>(`[data-testid="connect-chip-${id}"]`)!;
      expect(chip.disabled).toBe(true);
      expect(chip.getAttribute("data-disabled")).toBe("true");
      // The state is a Badge next to the name (no uppercase tracked pill,
      // no wording beyond the one label), muted by the disabled tokens.
      const badge = chip.querySelector<HTMLElement>(`[data-testid="connect-chip-${id}-soon"]`);
      expect(badge?.tagName.toLowerCase()).toBe("span");
      expect(badge?.textContent).toBe("Soon");
      expect(badge?.className).toContain("rounded-full");
      expect(badge?.className).toContain("text-3xs");
      expect(badge?.className).not.toContain("uppercase");
      expect(badge?.className).toContain("text-slate-600");
      expect(chip.className).toContain("data-[disabled]:opacity-60");
      // Name, then the Badge; the mark stays the one svg.
      expect(chip.textContent).toBe(`${chip.querySelector("span")?.textContent}Soon`);
      expect(chip.querySelectorAll("svg")).toHaveLength(1);
      expect(chip.querySelector('[data-testid$="-connected"]')).toBeNull();
      // Hover reads "Coming soon" from the list item: the disabled Button has
      // pointer-events none, so the pointer lands on the item.
      expect(chip.parentElement?.getAttribute("title")).toBe("Coming soon");
    }
    expect(
      container.querySelector('[data-testid="connect-more-tools"]')?.parentElement?.getAttribute("title"),
    ).toBeNull();
    expect(container.textContent).not.toContain("please");
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("renders the available Notion chip enabled, with no Badge and the verb in its name", async () => {
    await render();
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    expect(notion.disabled).toBe(false);
    expect(notion.getAttribute("data-disabled")).toBeNull();
    expect(notion.getAttribute("aria-label")).toBe("Connect Notion");
    expect(notion.textContent).toBe("Notion");
    expect(notion.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector('[data-testid="connect-chip-notion-soon"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).toBeNull();
    expect(notion.parentElement?.getAttribute("title")).toBeNull();
  });

  it("reports the pressed available chip, nothing from a soon chip, and opens the browse sheet from More tools", async () => {
    const onSelect = vi.fn();
    const onMoreTools = vi.fn();
    await render({ onSelect, onMoreTools });

    // The available chip reports its connector once and sends nothing else.
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    expect(notion.disabled).toBe(false);
    await act(async () => notion.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(notionConnector);
    expect(onSelect.mock.calls[0]?.[0]?.availability).toBe("available");
    expect(onMoreTools).not.toHaveBeenCalled();

    const slack = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-slack"]')!;
    expect(slack.disabled).toBe(true);
    await act(async () => slack.click());
    await act(async () => {
      slack.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      slack.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      slack.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      slack.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onMoreTools).not.toHaveBeenCalled();

    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]')!;
    expect(more.disabled).toBe(false);
    await act(async () => more.click());
    expect(onMoreTools).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("names a soon chip as coming soon, ahead of the verb and the installed state", async () => {
    await render();
    const label = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="connect-chip-${id}"]`)?.getAttribute("aria-label");
    expect(label("slack")).toBe("Slack, coming soon");
    expect(label("discord")).toBe("Discord, coming soon");
    expect(label("notion")).toBe("Connect Notion");

    // An installed folder does not make an unpublished pack selectable: the
    // chip keeps the Soon state and its label. A published pack's installed
    // folder reads as connected.
    await render({ installedSkillNames: new Set(["slack", "notion"]) });
    expect(label("slack")).toBe("Slack, coming soon");
    expect(label("notion")).toBe("Notion, connected");
    for (const chip of chipButtons()) {
      expect(chip.getAttribute("aria-label")).not.toMatch(/^Connect /);
    }
    for (const id of SOON_CHIP_IDS) {
      expect(label(id)).not.toContain("connected");
    }
  });

  it("shows no check glyph for a soon chip, even with its skill folder installed", async () => {
    await render({ installedSkillNames: new Set(["slack", "other", "github"]) });

    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-soon"]')?.textContent).toBe("Soon");
    expect(container.querySelector('[data-testid="connect-chip-slack"]')?.textContent).toBe("SlackSoon");
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid$="-soon"]')).toHaveLength(SOON_CHIP_IDS.length);
  });

  it("shows the check glyph for the available Notion chip once its skill folder is installed", async () => {
    await render({ installedSkillNames: new Set(["notion"]) });
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    expect(notion.disabled).toBe(false);
    expect(notion.getAttribute("aria-label")).toBe("Notion, connected");
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-notion-soon"]')).toBeNull();
    // Name plus the check: the mark and the glyph are the two svgs.
    expect(notion.textContent).toBe("Notion");
    expect(notion.querySelectorAll("svg")).toHaveLength(2);
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
    expect(container.querySelector('[data-testid="connect-chip-discord-soon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord-connected"]')).toBeNull();
  });
});
