// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectChipStrip } from "../ConnectChipStrip";
import {
  CARD_CHIP_CONNECTORS,
  COMING_SOON_FEATURED_SKILLS,
  CONNECTORS,
  isConnectorAvailable,
  type SkillConnector,
} from "../connectors";

const EM_DASH = "\u2014";

// Notion's pack is published, so the shipped list renders its one chip and no
// coming-soon line; Slack and Discord are still "soon" (packs not published)
// and get no chip at all. The test seam covers the multi-chip path with the
// niche FreeFinance skill and a soon skill flipped to available, and the
// coming-soon line with an empty chip list.
const notionConnector = CARD_CHIP_CONNECTORS.find((entry) => entry.id === "notion")!;
const freefinance = CONNECTORS.find(
  (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "freefinance",
)!;
const slackAvailable: SkillConnector = {
  ...COMING_SOON_FEATURED_SKILLS.find((entry) => entry.id === "slack")!,
  availability: "available",
};

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

  it("renders the one published chip and no coming-soon line from the shipped list", async () => {
    await render();

    expect(CARD_CHIP_CONNECTORS.map((entry) => entry.id)).toEqual(["notion"]);
    expect(COMING_SOON_FEATURED_SKILLS.map((entry) => entry.id)).toEqual(["slack", "discord"]);
    const strip = container.querySelector('[data-testid="connect-chip-strip"]');
    expect(strip?.tagName).toBe("UL");
    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual(["connect-chip-notion"]);
    expect(container.querySelector('[data-testid^="connect-chip-"][data-testid$="-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("Soon");
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("coming soon");
    expect(container.querySelector("img")).toBeNull();

    // The trailing link is text only and last in the list, after the chip.
    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(more?.textContent).toBe("More tools");
    expect(more?.querySelector("svg")).toBeNull();
    expect(strip?.lastElementChild?.contains(more!)).toBe(true);
    expect(chipButtons()[0]!.compareDocumentPosition(more!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Paste a skill link");
    expect(container.textContent).not.toContain("please");
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("shows one coming-soon line and the More tools link while no featured skill is available", async () => {
    await render({ connectors: [], comingSoon: COMING_SOON_FEATURED_SKILLS });

    const strip = container.querySelector('[data-testid="connect-chip-strip"]');
    expect(strip?.tagName).toBe("UL");
    expect(chipButtons()).toEqual([]);
    expect(container.querySelector('[data-testid^="connect-chip-"][data-testid$="-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("Soon");
    const line = container.querySelector<HTMLElement>('[data-testid="connect-coming-soon"]');
    expect(line?.textContent).toBe("Slack and Discord are coming soon.");
    expect(line?.tagName).toBe("SPAN");
    expect(line?.className).not.toContain("uppercase");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();

    // The trailing link is text only, last in the list, after the line.
    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(more?.textContent).toBe("More tools");
    expect(more?.querySelector("svg")).toBeNull();
    expect(strip?.lastElementChild?.contains(more!)).toBe(true);
    expect(line!.compareDocumentPosition(more!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Paste a skill link");
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

  it("reports the pressed Notion chip and opens the browse sheet from More tools", async () => {
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

    // Soon skills have no chip to press.
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord"]')).toBeNull();

    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]')!;
    expect(more.disabled).toBe(false);
    await act(async () => more.click());
    expect(onMoreTools).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("names the Notion chip with the verb, or with its installed state instead", async () => {
    await render();
    const label = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="connect-chip-${id}"]`)?.getAttribute("aria-label");
    expect(label("notion")).toBe("Connect Notion");

    await render({ installedSkillNames: new Set(["slack", "notion"]) });
    expect(label("notion")).toBe("Notion, connected");
    for (const chip of chipButtons()) {
      expect(chip.getAttribute("aria-label")).not.toMatch(/^Connect /);
    }
  });

  it("gives a soon skill no chip and no check glyph, even with its skill folder installed", async () => {
    await render({ installedSkillNames: new Set(["slack", "other", "github"]) });

    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual(["connect-chip-notion"]);
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-soon"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid$="-soon"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("Soon");
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

  it("renders an available skill as a pressable chip with its mark, and drops the coming-soon line once nothing is pending", async () => {
    const onSelect = vi.fn();
    await render({ connectors: [slackAvailable, freefinance], comingSoon: [], onSelect });

    const chips = chipButtons();
    expect(chips.map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-slack",
      "connect-chip-freefinance",
    ]);
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
      expect(chip.getAttribute("aria-label")).toMatch(/^Connect /);
      expect(chip.querySelectorAll("svg")).toHaveLength(1);
      expect(chip.className).toContain("rounded-full");
    }
    expect(chips[0]?.textContent).toBe("Slack");
    expect(chips[0]?.getAttribute("aria-label")).toBe("Connect Slack");

    await act(async () => chips[0]?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(slackAvailable);
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("shows no coming-soon line once any chip is available, even while other featured skills are pending", async () => {
    await render({ connectors: [slackAvailable], comingSoon: COMING_SOON_FEATURED_SKILLS.slice(1) });

    // With a chip present the line is not shown: the chips are the strip and
    // the sheet names what is pending.
    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual(["connect-chip-slack"]);
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
  });

  it("marks an installed available skill with a check glyph and says so in its name", async () => {
    await render({
      connectors: [slackAvailable, freefinance],
      comingSoon: [],
      installedSkillNames: new Set(["freefinance", "other", "github"]),
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-freefinance"]')!;
    expect(chip.getAttribute("aria-label")).toBe("FreeFinance, connected");
    expect(chip.querySelector('[data-testid="connect-chip-freefinance-connected"]')).not.toBeNull();
    expect(chip.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="connect-chip-"][data-testid$="-soon"]')).toHaveLength(0);
  });

  it("phrases the coming-soon line for one, two and three names", async () => {
    const byId = (id: string) =>
      CONNECTORS.find((entry): entry is SkillConnector => entry.kind === "skill" && entry.id === id)!;
    const [slack, notion, discord] = [byId("slack"), byId("notion"), byId("discord")];
    const line = () => container.querySelector('[data-testid="connect-coming-soon"]')?.textContent;
    await render({ connectors: [], comingSoon: [slack] });
    expect(line()).toBe("Slack is coming soon.");
    await render({ connectors: [], comingSoon: [slack, notion] });
    expect(line()).toBe("Slack and Notion are coming soon.");
    await render({ connectors: [], comingSoon: [slack, notion, discord] });
    expect(line()).toBe("Slack, Notion and Discord are coming soon.");
    await render({ connectors: [], comingSoon: [] });
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-more-tools"]')).not.toBeNull();
  });

  it("only ever lists skills that can be selected today", () => {
    for (const entry of CARD_CHIP_CONNECTORS) {
      expect(isConnectorAvailable(entry)).toBe(true);
      expect(entry.featured).toBe(true);
    }
    for (const entry of COMING_SOON_FEATURED_SKILLS) {
      expect(isConnectorAvailable(entry)).toBe(false);
      expect(entry.featured).toBe(true);
    }
  });

  it("keeps the same DOM shape in the dark theme", async () => {
    await render({ connectors: [freefinance], comingSoon: [], installedSkillNames: new Set(["freefinance"]) });
    const lightShape = chipButtons().map((chip) => ({
      id: chip.dataset.testid,
      svg: chip.querySelectorAll("svg").length,
      text: chip.textContent,
    }));

    document.documentElement.classList.add("dark");
    await render({ connectors: [freefinance], comingSoon: [], installedSkillNames: new Set(["freefinance"]) });
    const darkShape = chipButtons().map((chip) => ({
      id: chip.dataset.testid,
      svg: chip.querySelectorAll("svg").length,
      text: chip.textContent,
    }));

    expect(darkShape).toEqual(lightShape);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-freefinance-connected"]')).not.toBeNull();
  });
});
