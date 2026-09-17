import { describe, expect, it } from "vitest";
import {
  AVAILABLE_FEATURED_CONNECTORS,
  CARD_CHIP_CONNECTORS,
  COMING_SOON_FEATURED_SKILLS,
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  FEATURED_CONNECTOR_LIMIT,
  FEATURED_CONNECTORS,
  PRODUCT_CONNECTORS,
  buildConnectorImportMessage,
  connectorCategoryLabel,
  filterConnectors,
  formatComingSoonLine,
  isConnectorAvailable,
  type SkillConnector,
} from "../connectors";
import { ONBOARDING_PATHS } from "../onboardingPlaybook";

const EM_DASH = "\u2014";

function ids(entries: readonly { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("CONNECTORS", () => {
  it("lists the products in order with GitHub after the skills and the paste link last", () => {
    expect(ids(CONNECTORS)).toEqual(["slack", "notion", "discord", "freefinance", "github", "other"]);
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
    expect(ids(FEATURED_CONNECTORS)).toEqual(["slack", "notion", "discord", "github"]);
    expect(ids(FEATURED_CONNECTORS)).not.toContain("freefinance");
  });

  it("marks the unpublished packs soon and Notion, GitHub and FreeFinance available today", () => {
    // Flip an entry to "available" once its pack lands in instafy-dev/skills;
    // until then it is listed in the sheet, greyed with a "Soon" Badge, and
    // named in the card's coming-soon line while no chip is available.
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

  it("keeps soon entries in the featured list but out of the card chips and the available rows", () => {
    // The featured list is the curated set; what the card and the composer
    // rows show is the part of it that can be selected today. The rest is
    // one coming-soon line while the card has no chip at all.
    expect(ids(FEATURED_CONNECTORS)).toEqual(expect.arrayContaining(["slack", "notion", "discord"]));
    expect(AVAILABLE_FEATURED_CONNECTORS).toEqual(FEATURED_CONNECTORS.filter(isConnectorAvailable));
    // Notion before GitHub: list order, so the Popular row reads the same way.
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).toEqual(["notion", "github"]);
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).not.toContain("slack");
    expect(ids(AVAILABLE_FEATURED_CONNECTORS)).not.toContain("discord");
    for (const entry of AVAILABLE_FEATURED_CONNECTORS) {
      expect(entry.featured).toBe(true);
      expect(entry.availability).toBe("available");
    }
    expect(CARD_CHIP_CONNECTORS).toEqual(
      AVAILABLE_FEATURED_CONNECTORS.filter((entry) => entry.kind === "skill"),
    );
    expect(ids(CARD_CHIP_CONNECTORS)).toEqual(["notion"]);
    expect(ids(COMING_SOON_FEATURED_SKILLS)).toEqual(["slack", "discord"]);
    for (const entry of COMING_SOON_FEATURED_SKILLS) {
      expect(entry.featured).toBe(true);
      expect(entry.kind).toBe("skill");
      expect(isConnectorAvailable(entry)).toBe(false);
    }
  });

  it("phrases the coming-soon line from the pending featured skills", () => {
    expect(formatComingSoonLine()).toBe("Slack and Discord are coming soon.");
    expect(formatComingSoonLine([{ name: "Slack" }])).toBe("Slack is coming soon.");
    expect(formatComingSoonLine([{ name: "Slack" }, { name: "Notion" }])).toBe(
      "Slack and Notion are coming soon.",
    );
    expect(formatComingSoonLine([])).toBeNull();
    expect(formatComingSoonLine()).not.toContain(EM_DASH);
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

  it("keeps GitHub and unfeatured tools out of the card chips", () => {
    // FreeFinance is available but not featured: "More tools" is its way in.
    expect(ids(CARD_CHIP_CONNECTORS)).not.toContain("github");
    expect(ids(CARD_CHIP_CONNECTORS)).not.toContain("freefinance");
    expect(ids(CARD_CHIP_CONNECTORS)).not.toContain("other");
    for (const entry of CARD_CHIP_CONNECTORS) {
      expect(entry.kind).toBe("skill");
      expect(entry.featured).toBe(true);
    }
  });

  it("marks FreeFinance as an Austrian, unfeatured finance tool", () => {
    const freefinance = CONNECTORS.find(
      (entry): entry is SkillConnector => entry.kind === "skill" && entry.id === "freefinance",
    );
    expect(freefinance).toBeDefined();
    expect(freefinance?.region).toBe("Austria");
    expect(freefinance?.category).toBe("finance");
    expect(freefinance?.featured).toBe(false);
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
    for (const path of ONBOARDING_PATHS) {
      expect(path.title).not.toContain(EM_DASH);
      expect(path.description).not.toContain(EM_DASH);
      expect(path.prompt).not.toContain(EM_DASH);
      for (const action of path.actions) {
        expect(action.title).not.toContain(EM_DASH);
        expect(action.description).not.toContain(EM_DASH);
        expect(action.prompt ?? "").not.toContain(EM_DASH);
        expect(action.placeholder ?? "").not.toContain(EM_DASH);
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
    expect(notion?.needs).toEqual(["a Notion internal integration token (NOTION_API_KEY)"]);
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
