import { describe, expect, it } from "vitest";
import {
  buildSkillImportMessage,
  buildSkillStartMessage,
  deriveSkillNameHintFromImportSource,
  deriveSkillSourceLabel,
  humanizeSkillName,
  normalizeSkillName,
  parseSkillImportMessage,
} from "../skillCommands";

describe("buildSkillImportMessage", () => {
  it("builds the bare repo line with --start", () => {
    expect(
      buildSkillImportMessage({ source: "https://github.com/acme/skills-pack", start: true }),
    ).toBe("/skills import https://github.com/acme/skills-pack --start");
  });

  it("builds the .agents/skills tree line with --start", () => {
    expect(
      buildSkillImportMessage({
        source: "https://github.com/acme/skills-pack/tree/main/.agents/skills",
        start: true,
      }),
    ).toBe("/skills import https://github.com/acme/skills-pack/tree/main/.agents/skills --start");
  });

  it("places --name before --start", () => {
    expect(
      buildSkillImportMessage({
        source: "https://github.com/owner/repo/tree/main/skills/playwright-review",
        skillName: "playwright-review",
        start: true,
      }),
    ).toBe(
      "/skills import https://github.com/owner/repo/tree/main/skills/playwright-review --name playwright-review --start",
    );
  });

  it("keeps the fixed order name, overwrite, start", () => {
    expect(
      buildSkillImportMessage({
        source: "playwright/skill-import-fixture",
        skillName: "Playwright Review!",
        overwrite: true,
        start: true,
      }),
    ).toBe("/skills import playwright/skill-import-fixture --name playwright-review --overwrite --start");
  });

  it("omits every flag that is not set", () => {
    expect(buildSkillImportMessage({ source: " playwright/skill-import-fixture " })).toBe(
      "/skills import playwright/skill-import-fixture",
    );
    expect(buildSkillImportMessage({ source: "a/b", skillName: "  ", overwrite: false })).toBe(
      "/skills import a/b",
    );
  });

  it("throws when the source contains whitespace", () => {
    expect(() => buildSkillImportMessage({ source: "https://github.com/a/b c", start: true })).toThrow(
      "Skill source cannot contain spaces.",
    );
    expect(() => buildSkillImportMessage({ source: "path/with\ttab" })).toThrow(
      "Skill source cannot contain spaces.",
    );
  });

  it("throws when the source is empty", () => {
    expect(() => buildSkillImportMessage({ source: "   " })).toThrow();
  });
});

describe("parseSkillImportMessage", () => {
  it("reads back every line buildSkillImportMessage writes", () => {
    const source = "https://github.com/owner/repo/tree/main/skills/playwright-review";
    expect(parseSkillImportMessage(buildSkillImportMessage({ source, skillName: "Playwright Review", overwrite: true, start: true })))
      .toEqual({ source, skillName: "playwright-review" });
    expect(parseSkillImportMessage(buildSkillImportMessage({ source, start: true }))).toEqual({ source, skillName: null });
  });

  it("accepts typed lines with flags in any order and rejects other commands", () => {
    expect(parseSkillImportMessage("  /Skills IMPORT ./skills/acme --start --name acme_reports ")).toEqual({
      source: "./skills/acme",
      skillName: "acme-reports",
    });
    expect(parseSkillImportMessage("/skills import --start")).toBeNull();
    expect(parseSkillImportMessage("/skills import")).toBeNull();
    expect(parseSkillImportMessage("/skills start acme")).toBeNull();
    expect(parseSkillImportMessage("please /skills import ./skills/acme")).toBeNull();
  });
});

describe("buildSkillStartMessage", () => {
  it("produces /skills start <slug>", () => {
    expect(buildSkillStartMessage("alpha")).toBe("/skills start alpha");
    expect(buildSkillStartMessage(" slack ")).toBe("/skills start slack");
  });
});

describe("normalizeSkillName", () => {
  it("lowercases, replaces non-alphanumerics and trims dashes", () => {
    expect(normalizeSkillName("  Playwright Review ")).toBe("playwright-review");
    expect(normalizeSkillName("--Foo__Bar!!")).toBe("foo-bar");
    expect(normalizeSkillName("")).toBe("");
  });
});

describe("humanizeSkillName", () => {
  it("title-cases dashed and underscored names", () => {
    expect(humanizeSkillName("playwright-review")).toBe("Playwright Review");
    expect(humanizeSkillName("books_at")).toBe("Books At");
    expect(humanizeSkillName("  ")).toBe("Unnamed skill");
  });
});

describe("deriveSkillNameHintFromImportSource", () => {
  it("reads the skill folder from GitHub tree and blob URLs", () => {
    expect(
      deriveSkillNameHintFromImportSource(
        "https://github.com/owner/repo/tree/main/skills/playwright-review",
      ),
    ).toBe("playwright-review");
    expect(
      deriveSkillNameHintFromImportSource(
        "https://github.com/owner/repo/blob/main/skills/playwright-review/SKILL.md",
      ),
    ).toBe("playwright-review");
  });

  it("reads the last segment of a workspace path", () => {
    expect(deriveSkillNameHintFromImportSource("playwright/skill-import-fixture")).toBe(
      "skill-import-fixture",
    );
    expect(deriveSkillNameHintFromImportSource("playwright/skill-import-fixture/SKILL.md")).toBe(
      "skill-import-fixture",
    );
    expect(deriveSkillNameHintFromImportSource("")).toBeNull();
  });
});

describe("deriveSkillSourceLabel", () => {
  it("uses the repo name for a bare repo", () => {
    expect(deriveSkillSourceLabel("https://github.com/acme/skills-pack")).toBe("skills-pack");
    expect(deriveSkillSourceLabel("https://github.com/acme/skills-pack.git")).toBe(
      "skills-pack",
    );
  });

  it("uses the repo name for a tree root", () => {
    expect(deriveSkillSourceLabel("https://github.com/acme/skills-pack/tree/main")).toBe(
      "skills-pack",
    );
  });

  it("uses the repo name for a .agents/skills folder", () => {
    expect(
      deriveSkillSourceLabel("https://github.com/acme/skills-pack/tree/main/.agents/skills"),
    ).toBe("skills-pack");
  });

  it("uses the folder name for a single skill folder", () => {
    expect(
      deriveSkillSourceLabel(
        "https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/slack",
      ),
    ).toBe("slack");
  });

  it("uses the parent folder for a SKILL.md link", () => {
    expect(
      deriveSkillSourceLabel(
        "https://github.com/openclaw/skills/tree/main/whatsapp-concierge/SKILL.md",
      ),
    ).toBe("whatsapp-concierge");
    expect(deriveSkillSourceLabel("https://example.com/packs/my-skill/SKILL.md")).toBe("my-skill");
  });

  it("uses the last path segment for a workspace path", () => {
    expect(deriveSkillSourceLabel("playwright/skill-import-fixture")).toBe("skill-import-fixture");
    expect(deriveSkillSourceLabel("playwright/skill-import-fixture/SKILL.md")).toBe(
      "skill-import-fixture",
    );
  });

  it("falls back to the trimmed source", () => {
    expect(deriveSkillSourceLabel("  https://github.com/  ")).toBe("https://github.com/");
    expect(deriveSkillSourceLabel("SKILL.md")).toBe("SKILL.md");
  });
});
