import { describe, expect, it } from "vitest";
import {
  AVAILABLE_FEATURED_CONNECTORS,
  CARD_CHIP_LIMIT,
  CARD_READ_ONLY_TOOL_CONNECTORS,
  CARD_TOOL_CONNECTORS,
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  FEATURED_CONNECTOR_LIMIT,
  FEATURED_CONNECTORS,
  PRODUCT_CONNECTORS,
  buildConnectorImportMessage,
  connectorCategoryLabel,
  filterConnectors,
  isConnectorAvailable,
  type SkillConnector,
} from "../connectors";

const EM_DASH = "\u2014";

function ids(entries: readonly { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("CONNECTORS", () => {
  it("leads with the connection that needs no key pasted and keeps the paste link last", () => {
    // Ordering rule: no-paste connections first, then key-based ones. GitHub
    // signs in with a device code, so it sits above Notion, which asks for a
    // token; the card row and the sheet's Popular row both read that order.
    expect(ids(CONNECTORS)).toEqual(["slack", "github", "notion", "discord", "freefinance", "other"]);
    const last = CONNECTORS[CONNECTORS.length - 1]!;
    expect(last.kind).toBe("other");
    expect(last.name).toBe("Paste a skill link");
    const github = CONNECTORS.find((entry) => entry.id === "github");
    expect(github?.kind).toBe("github");
    expect(github?.name).toBe("GitHub");
  });

  it("gives every product connector a valid category, keywords, the featured flag and an availability", () => {
    const categoryIds = new Set(CONNECTOR_CATEGORIES.map((category) => category.id));
    expect(PRODUCT_CONNECTORS.length).toBeGreaterThan(0);
    for (const entry of PRODUCT_CONNECTORS) {
      expect(categoryIds.has(entry.category)).toBe(true);
      expect(typeof entry.featured).toBe("boolean");
      expect(["available", "soon"]).toContain(entry.availability);
      expect(entry.keywords.length).toBeGreaterThan(0);
      for (const keyword of entry.keywords) {
        expect(keyword).toBe(keyword.toLowerCase().trim());
        expect(keyword.length).toBeGreaterThan(0);
      }
    }
    expect(PRODUCT_CONNECTORS.some((entry) => (entry.id as string) === "other")).toBe(false);
  });

  it("keeps the category labels exact and in order", () => {
    expect(CONNECTOR_CATEGORIES.map((category) => [category.id, category.label])).toEqual([
      ["chat", "Chat and community"],
      ["docs", "Docs and notes"],
      ["code", "Code"],
      ["finance", "Finance and bookkeeping"],
      ["email", "Email and calendar"],
      ["files", "Files"],
    ]);
    expect(connectorCategoryLabel("finance")).toBe("Finance and bookkeeping");
  });

  it("caps the curated Popular row at eight and keeps it equal to the featured entries in list order", () => {
    expect(FEATURED_CONNECTOR_LIMIT).toBe(8);
    expect(FEATURED_CONNECTORS.length).toBeLessThanOrEqual(FEATURED_CONNECTOR_LIMIT);
    expect(FEATURED_CONNECTORS).toEqual(PRODUCT_CONNECTORS.filter((entry) => entry.featured));
    expect(ids(FEATURED_CONNECTORS)).toEqual([
      "slack",
      "github",
      "notion",
      "discord",
      "freefinance",
    ]);
  });

  it("marks the unpublished packs soon and Notion, GitHub and FreeFinance available today", () => {
    // Flip an entry to "available" once its pack lands in instafy-dev/skills;
    // until then it is listed in the sheet alone, greyed with a "Soon" Badge,
    // and never a chip on the card.
    const availability = Object.fromEntries(
      PRODUCT_CONNECTORS.map((entry) => [entry.id, entry.availability]),
    );
    expect(availability).toEqual({
      slack: "soon",
      notion: "available",
      discord: "soon",
      freefinance: "available",
      github: "available",
    });
    for (const entry of CONNECTORS) {
      expect(isConnectorAvailable(entry)).toBe(
        entry.kind === "other" ||
          entry.id === "notion" ||
          entry.id === "github" ||
          entry.id === "freefinance",
      );
    }
    // The paste link is always available: it has no pack to wait for.
    const other = CONNECTORS.find((entry) => entry.id === "other")!;
    expect(isConnectorAvailable(other)).toBe(true);
    expect("availability" in other).toBe(false);
  });

  it("keeps soon entries in the featured list but out of the card row and the available rows", () => {
    // The featured list is the curated set; what the card and the composer
    // rows show is the part of it that can be selected today. A pending pack
    // is named nowhere on the card: the sheet's Soon Badge is its only place.
    expect(ids(FEATURED_CONNECTORS)).toEqual(expect.arrayContaining(["slack", "notion", "discord"]));
    expect(AVAILABLE_FEATURED_CONNECTORS).toEqual(FEATURED_CONNECTORS.filter(isConnectorAvailable));
    // GitHub before Notion: list order, so the card row and the Popular row
    // both lead with the entry that needs no key pasted.
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).toEqual(["github", "notion", "freefinance"]);
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).not.toContain("slack");
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).not.toContain("discord");
    for (const entry of AVAILABLE_FEATURED_CONNECTORS) {
      expect(entry.featured).toBe(true);
      expect(entry.availability).toBe("available");
    }
  });

  it("builds the card row from the available featured tools and never exceeds its own cap", () => {
    // The cap is the card's, measured at 390 px, not the sheet's: five chips
    // plus the link hold two lines there, six take three.
    expect(CARD_CHIP_LIMIT).toBe(5);
    expect(CARD_TOOL_CONNECTORS).toEqual(AVAILABLE_FEATURED_CONNECTORS.slice(0, CARD_CHIP_LIMIT));
    expect(CARD_TOOL_CONNECTORS.length).toBeLessThanOrEqual(CARD_CHIP_LIMIT);
    expect(ids(CARD_TOOL_CONNECTORS)).toEqual(["github", "notion", "freefinance"]);
    // However large the catalogue grows, the row cannot: the cap is applied
    // to the list itself, so everything past it lives behind "More tools".
    const grown = [...AVAILABLE_FEATURED_CONNECTORS, ...FEATURED_CONNECTORS, ...PRODUCT_CONNECTORS];
    expect(grown.length).toBeGreaterThan(CARD_CHIP_LIMIT);
    expect(grown.slice(0, CARD_CHIP_LIMIT).length).toBe(CARD_CHIP_LIMIT);
    // Every entry on the card leads somewhere: no disabled chip, ever.
    for (const entry of CARD_TOOL_CONNECTORS) {
      expect(entry.featured).toBe(true);
      expect(isConnectorAvailable(entry)).toBe(true);
    }
  });

  it("leaves a read-only member only the tools whose press sends nothing", () => {
    // A repo import opens a form; a skill chip ends at the sheet's Connect
    // button, which sends the import line, so it is not offered here.
    expect(ids(CARD_READ_ONLY_TOOL_CONNECTORS)).toEqual(["github"]);
    for (const entry of CARD_READ_ONLY_TOOL_CONNECTORS) {
      expect(entry.kind).toBe("github");
      expect(CARD_TOOL_CONNECTORS).toContain(entry);
    }
  });

  it("keeps soon entries valid data so flipping them needs no other change", () => {
    const soon = PRODUCT_CONNECTORS.filter((entry) => entry.availability === "soon");
    expect(ids(soon)).toEqual(["slack", "discord"]);
    for (const entry of soon) {
      expect(entry.kind).toBe("skill");
      if (entry.kind === "skill") {
        expect(entry.source).toMatch(/^https:\/\/github\.com\//);
        expect(entry.source.split("/").pop()).toBe(entry.skillName);
        expect(entry.needs.length).toBeGreaterThan(0);
        expect(buildConnectorImportMessage(entry)).toContain(`--name ${entry.skillName} --start`);
      }
      // Search still lists them, greyed.
      expect(ids(filterConnectors(entry.name))).toContain(entry.id);
    }
  });

  it("keeps unpublished tools out of the card row", () => {
    // Slack and Discord have no pack at all, so they stay in the sheet with a
    // Soon Badge. The paste link is never a chip.
    expect(ids(CARD_TOOL_CONNECTORS)).not.toContain("slack");
    expect(ids(CARD_TOOL_CONNECTORS)).not.toContain("discord");
    expect(ids(CARD_TOOL_CONNECTORS)).not.toContain("other");
  });

  it("marks FreeFinance as an Austrian, featured finance tool", () => {
    // Austria-only, but it is one of only three tools that can be connected
    // today and the card row caps at five, so the owner of a bookkeeping
    // workspace reaches it without opening "More tools".
    const freefinance = CONNECTORS.find(
      (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "freefinance",
    );
    expect(freefinance).toBeDefined();
    expect(freefinance?.region).toBe("Austria");
    expect(freefinance?.category).toBe("finance");
    expect(freefinance?.featured).toBe(true);
    expect(freefinance?.availability).toBe("available");
    for (const entry of PRODUCT_CONNECTORS) {
      if (entry.id !== "freefinance") {
        expect(entry.region).toBeUndefined();
      }
    }
  });

  it("gives every skill connector a whitespace-free source whose last segment is the skill name", () => {
    const skillConnectors = CONNECTORS.filter(
      (entry): entry is SkillConnector => entry.kind === "skill",
    );
    expect(skillConnectors.length).toBeGreaterThan(0);
    for (const entry of skillConnectors) {
      expect(entry.source).not.toMatch(/\s/);
      expect(entry.source.split("/").pop()).toBe(entry.skillName);
      expect(entry.sourceLabel.trim().length).toBeGreaterThan(0);
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.needs.length).toBeGreaterThan(0);
    }
  });

  it("keeps the paste link and GitHub out of the skill connector shape", () => {
    const other = CONNECTORS.find((entry) => entry.id === "other");
    expect(other?.kind).toBe("other");
    expect("source" in other!).toBe(false);
    expect("skillName" in other!).toBe(false);
    expect("category" in other!).toBe(false);
    const github = CONNECTORS.find((entry) => entry.id === "github");
    expect("source" in github!).toBe(false);
    expect("skillName" in github!).toBe(false);
  });

  it("leaves the display-only app field unset on every shipped entry", () => {
    // The shared-display copy branch is reserved for connectors whose skill
    // opens a web app in the shared display; none ships that way today.
    for (const entry of CONNECTORS) {
      expect("app" in entry).toBe(false);
      if (entry.kind === "skill") {
        expect(entry.app).toBeUndefined();
      }
    }
  });

  it("contains no em-dash in any user-facing connector, category or onboarding string", () => {
    for (const category of CONNECTOR_CATEGORIES) {
      expect(category.label).not.toContain(EM_DASH);
    }
    for (const entry of CONNECTORS) {
      expect(entry.name).not.toContain(EM_DASH);
      if (entry.kind !== "other") {
        expect(entry.region ?? "").not.toContain(EM_DASH);
        for (const keyword of entry.keywords) {
          expect(keyword).not.toContain(EM_DASH);
        }
      }
      if (entry.kind === "skill") {
        expect(entry.sourceLabel).not.toContain(EM_DASH);
        for (const need of entry.needs) {
          expect(need).not.toContain(EM_DASH);
        }
      }
    }
  });

  it("points every team pack at the team pack folder of instafy-dev/skills", () => {
    // The packs live next to the bookkeeping pack in the one skills repo;
    // there is no separate team pack repo.
    for (const id of ["slack", "notion", "discord"]) {
      const entry = CONNECTORS.find(
        (item): item is SkillConnector => item.kind === "skill" && item.id === id,
      );
      expect(entry).toBeDefined();
      expect(entry!.source).toBe(
        `https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/${id}`,
      );
      expect(entry!.sourceLabel).toBe("instafy-dev/skills");
    }
    const notion = CONNECTORS.find(
      (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "notion",
    );
    expect(notion?.needs).toEqual(["a Notion connection Installation access token (NOTION_API_KEY)"]);
  });

  it("builds the exact one-liner for a product", () => {
    const notion = CONNECTORS.find(
      (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "notion",
    );
    expect(notion).toBeDefined();
    expect(buildConnectorImportMessage(notion!)).toBe(
      "/skills import https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion --name notion --start",
    );
  });
});

describe("filterConnectors", () => {
  it("returns every product connector for an empty or blank query", () => {
    expect(ids(filterConnectors(""))).toEqual(ids(PRODUCT_CONNECTORS));
    expect(ids(filterConnectors("   "))).toEqual(ids(PRODUCT_CONNECTORS));
    expect(ids(filterConnectors(""))).not.toContain("other");
  });

  it("matches the name case-insensitively and trimmed", () => {
    expect(ids(filterConnectors("slack"))).toEqual(["slack"]);
    expect(ids(filterConnectors("  SLA "))).toEqual(["slack"]);
    expect(ids(filterConnectors("Notion"))).toEqual(["notion"]);
  });

  it("matches a keyword such as buchhaltung", () => {
    expect(ids(filterConnectors("buchhaltung"))).toEqual(["freefinance"]);
    expect(ids(filterConnectors("buch"))).toEqual(["freefinance"]);
    expect(ids(filterConnectors("pull request"))).toEqual(["github"]);
  });

  it("matches a category label such as Code", () => {
    expect(ids(filterConnectors("Code"))).toEqual(["github"]);
    expect(ids(filterConnectors("bookkeeping"))).toEqual(["freefinance"]);
    expect(ids(filterConnectors("chat"))).toEqual(["slack", "discord"]);
  });

  it("matches a region", () => {
    expect(ids(filterConnectors("austria"))).toEqual(["freefinance"]);
  });

  it("returns nothing for an unknown query", () => {
    expect(filterConnectors("zzzz")).toEqual([]);
    expect(filterConnectors("paste a skill link")).toEqual([]);
  });

  it("is pure and never returns the list it filters", () => {
    const first = filterConnectors("");
    first.pop();
    expect(ids(filterConnectors(""))).toEqual(ids(PRODUCT_CONNECTORS));
  });
});
