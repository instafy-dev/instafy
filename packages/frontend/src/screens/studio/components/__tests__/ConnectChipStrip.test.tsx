// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectChipStrip } from "../ConnectChipStrip";
import {
  CARD_READ_ONLY_TOOL_CONNECTORS,
  CARD_TOOL_CONNECTORS,
  CONNECTORS,
  isConnectorAvailable,
  type ProductConnector,
  type SkillConnector,
} from "../connectors";

const EM_DASH = "\u2014";

// The shipped row is every featured tool that can be picked today: GitHub
// first (a device sign-in, nothing to paste) then Notion. Slack and Discord
// are still "soon" (packs not published) and get no chip at all. The test
// seam covers the longer row with the niche FreeFinance skill and a soon
// skill flipped to available.
const githubConnector = CARD_TOOL_CONNECTORS.find((entry) => entry.id === "github")!;
const notionConnector = CARD_TOOL_CONNECTORS.find((entry) => entry.id === "notion")!;
const freefinance = CONNECTORS.find(
  (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "freefinance",
)!;
const slackAvailable: SkillConnector = {
  ...CONNECTORS.find(
    (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "slack",
  )!,
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

  it("renders the shipped row of live tools, GitHub first, then the More tools link", async () => {
    await render();

    expect(CARD_TOOL_CONNECTORS.map((entry) => entry.id)).toEqual(["github", "notion"]);
    const strip = container.querySelector('[data-testid="connect-chip-strip"]');
    expect(strip?.tagName).toBe("UL");
    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-github",
      "connect-chip-notion",
    ]);
    // Nothing pending is named here, and nothing is disabled.
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    expect(container.textContent).not.toContain("coming soon");
    expect(container.textContent).not.toContain("Soon");
    for (const chip of chipButtons()) {
      expect(chip.disabled).toBe(false);
    }
    expect(container.querySelector("img")).toBeNull();

    // The trailing link is text only and last in the list, after the chips.
    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]');
    expect(more?.textContent).toBe("More tools");
    expect(more?.querySelector("svg")).toBeNull();
    expect(strip?.lastElementChild?.contains(more!)).toBe(true);
    expect(chipButtons()[0]!.compareDocumentPosition(more!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Paste a skill link");
    expect(container.textContent).not.toContain("please");
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("wraps instead of scrolling, with a coarse-pointer target on every chip", async () => {
    await render();
    const strip = container.querySelector('[data-testid="connect-chip-strip"]')!;
    expect(strip.className).toContain("flex-wrap");
    expect(strip.className).not.toContain("overflow-x");
    for (const chip of [...chipButtons(), container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]')!]) {
      expect(chip.className).toContain("pointer-coarse:min-h-11");
    }
  });

  it("names the GitHub chip with its verb, and never marks it connected", async () => {
    // A repo import installs no skill, and a device session inside one import
    // attempt is not durable knowledge, so absence is the honest rendering.
    await render({ installedSkillNames: new Set(["github", "notion"]) });
    const github = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-github"]')!;
    expect(github.getAttribute("aria-label")).toBe("Import from GitHub");
    // The accessible name contains the visible one (WCAG Label in Name).
    expect(github.getAttribute("aria-label")).toContain(github.textContent);
    expect(github.textContent).toBe("GitHub");
    expect(container.querySelector('[data-testid="connect-chip-github-connected"]')).toBeNull();
    expect(github.querySelectorAll("svg")).toHaveLength(1);
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

  it("reports the pressed chip and opens the browse sheet from More tools", async () => {
    const onSelect = vi.fn();
    const onMoreTools = vi.fn();
    await render({ onSelect, onMoreTools });

    // Each chip reports its connector once and sends nothing else. The host
    // decides where a GitHub press goes; the strip only reports it.
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    await act(async () => notion.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(notionConnector);
    expect(onSelect.mock.calls[0]?.[0]?.availability).toBe("available");

    const github = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-github"]')!;
    await act(async () => github.click());
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(githubConnector);
    expect(onMoreTools).not.toHaveBeenCalled();

    // Soon skills have no chip to press.
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-discord"]')).toBeNull();

    const more = container.querySelector<HTMLButtonElement>('[data-testid="connect-more-tools"]')!;
    expect(more.disabled).toBe(false);
    await act(async () => more.click());
    expect(onMoreTools).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("drops the More tools link, and only that, when the sheet is not offered", async () => {
    const onMoreTools = vi.fn();
    await render({ connectors: CARD_READ_ONLY_TOOL_CONNECTORS, showMoreTools: false, onMoreTools });

    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual(["connect-chip-github"]);
    expect(container.querySelector('[data-testid="connect-more-tools"]')).toBeNull();
    expect(container.textContent).not.toContain("More tools");
    expect(onMoreTools).not.toHaveBeenCalled();
  });

  it("names the Notion chip with the verb, or with its installed state instead", async () => {
    await render();
    const label = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="connect-chip-${id}"]`)?.getAttribute("aria-label");
    expect(label("notion")).toBe("Connect Notion");

    await render({ installedSkillNames: new Set(["slack", "notion"]) });
    expect(label("notion")).toBe("Notion, connected");
    expect(label("github")).toBe("Import from GitHub");
  });

  it("gives a soon skill no chip and no check glyph, even with its skill folder installed", async () => {
    await render({ installedSkillNames: new Set(["slack", "other"]) });

    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-github",
      "connect-chip-notion",
    ]);
    expect(container.querySelector('[data-testid="connect-chip-slack"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid$="-soon"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("Soon");
  });

  it("shows the check glyph for the available Notion chip once its skill folder is installed", async () => {
    await render({ installedSkillNames: new Set(["notion"]) });
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-notion"]')!;
    // Still pressable and in the same place: connecting changes a glyph and
    // a name, never the colour, the shape or the order.
    expect(notion.disabled).toBe(false);
    expect(notion.getAttribute("aria-label")).toBe("Notion, connected");
    expect(container.querySelector('[data-testid="connect-chip-notion-connected"]')).not.toBeNull();
    expect(chipButtons().map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-github",
      "connect-chip-notion",
    ]);
    // Name plus the check: the mark and the glyph are the two svgs.
    expect(notion.textContent).toBe("Notion");
    expect(notion.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(1);
  });

  it("renders a longer row of available skills as identical pressable chips", async () => {
    const onSelect = vi.fn();
    const connectors: readonly ProductConnector[] = [githubConnector, slackAvailable, freefinance];
    await render({ connectors, onSelect });

    const chips = chipButtons();
    expect(chips.map((chip) => chip.dataset.testid)).toEqual([
      "connect-chip-github",
      "connect-chip-slack",
      "connect-chip-freefinance",
    ]);
    expect(container.querySelector('[data-testid="connect-coming-soon"]')).toBeNull();
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
      expect(chip.querySelectorAll("svg")).toHaveLength(1);
      expect(chip.className).toContain("rounded-full");
    }
    expect(chips[1]?.textContent).toBe("Slack");
    expect(chips[1]?.getAttribute("aria-label")).toBe("Connect Slack");

    await act(async () => chips[1]?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(slackAvailable);
    expect(container.textContent).not.toContain(EM_DASH);
  });

  it("marks an installed available skill with a check glyph and says so in its name", async () => {
    await render({
      connectors: [slackAvailable, freefinance],
      installedSkillNames: new Set(["freefinance", "other", "github"]),
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="connect-chip-freefinance"]')!;
    expect(chip.getAttribute("aria-label")).toBe("FreeFinance, connected");
    expect(chip.querySelector('[data-testid="connect-chip-freefinance-connected"]')).not.toBeNull();
    expect(chip.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelector('[data-testid="connect-chip-slack-connected"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid$="-connected"]')).toHaveLength(1);
  });

  it("only ever lists tools that can be selected today", () => {
    for (const entry of CARD_TOOL_CONNECTORS) {
      expect(isConnectorAvailable(entry)).toBe(true);
      expect(entry.featured).toBe(true);
    }
  });

  it("keeps the same DOM shape in the dark theme", async () => {
    await render({ connectors: [freefinance], installedSkillNames: new Set(["freefinance"]) });
    const lightShape = chipButtons().map((chip) => ({
      id: chip.dataset.testid,
      svg: chip.querySelectorAll("svg").length,
      text: chip.textContent,
    }));

    document.documentElement.classList.add("dark");
    await render({ connectors: [freefinance], installedSkillNames: new Set(["freefinance"]) });
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
