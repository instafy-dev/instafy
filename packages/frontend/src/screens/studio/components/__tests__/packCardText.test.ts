import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_CHARS,
  isValidSecretName,
  normalizeRefusedSecretClass,
  refusedSecretClass,
  sanitizeCardText,
  sanitizeSkillSlug,
  type CardTextField,
} from "../packCardText";
import { PRODUCT_CONNECTORS, type SkillConnector } from "../connectors";

// The frontend half of the pack-text gate. Its rules are the runtime's rules,
// and the fixture list below is the runtime's own file: a rule changed on one
// side and not the other fails here and in the Rust unit test at once.

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../../..");
const FIXTURES = resolve(repo, "packages/runtime-agent/src/jobs/card_text_fixtures.json");

type Fixture = {
  name: string;
  field: CardTextField;
  owner: string | null;
  skill?: string | null;
  input: string;
  expected: string | null;
};

type NameFixture = { name: string; refusedClass: string | null };
type IdentityFixture = { name: string; skillName: string; secretNames: string[] };

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
  cases: Fixture[];
  names: NameFixture[];
  identities: IdentityFixture[];
};

describe("sanitizeCardText", () => {
  it("reads the shared fixture list the runtime is pinned to", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      expect(
        sanitizeCardText(fixture.input, fixture.field, fixture.owner, fixture.skill ?? null),
      ).toBe(fixture.expected);
    },
  );

  it("takes nothing but a string", () => {
    expect(sanitizeCardText(null, "description")).toBeNull();
    expect(sanitizeCardText(12, "description")).toBeNull();
    expect(sanitizeCardText({ toString: () => "hi" }, "description")).toBeNull();
  });

  it("keeps a cut sentence inside its cap", () => {
    const long = `${"word ".repeat(80)}end`;
    const cut = sanitizeCardText(long, "description");
    expect(cut).not.toBeNull();
    expect([...cut!].length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(cut!.endsWith("\u2026")).toBe(true);
  });
});

describe("sanitizeSkillSlug", () => {
  it("keeps a folder name and reduces anything else to one", () => {
    expect(sanitizeSkillSlug("notion")).toBe("notion");
    expect(sanitizeSkillSlug("  Free/Finance  ")).toBe("freefinance");
    expect(sanitizeSkillSlug("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeSkillSlug("---")).toBeNull();
    expect(sanitizeSkillSlug("")).toBeNull();
    expect(sanitizeSkillSlug(null)).toBeNull();
  });
});

describe("refusedSecretClass", () => {
  // The same names the runtime refuses, refused again here: a message written
  // before the runtime carried that rule outlives the deploy, and this gate is
  // the last line before an input renders.
  it.each(fixtures.names.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      expect(refusedSecretClass(fixture.name)).toBe(fixture.refusedClass);
    },
  );

  it("takes nothing but a string", () => {
    expect(refusedSecretClass(null)).toBeNull();
    expect(refusedSecretClass(12)).toBeNull();
  });
});

describe("the shared identity table", () => {
  // card_text.rs carries a hand copy of this table, and its drift is silent: a
  // connector added here and forgotten there resolves to no owner, so the
  // pack's honest sentence naming its own product is dropped before any client
  // sees it. The Rust fixture test asserts the same array from the other side.
  it("is the catalogue's own skill entries", () => {
    const catalogue = PRODUCT_CONNECTORS.filter(
      (connector): connector is SkillConnector => connector.kind === "skill",
    ).map((connector) => ({
      name: connector.name,
      skillName: connector.skillName,
      secretNames: [...connector.secretNames],
    }));
    expect(catalogue).toEqual(fixtures.identities);
  });
});

describe("normalizeRefusedSecretClass", () => {
  it("accepts only a key from our own table", () => {
    expect(normalizeRefusedSecretClass("password")).toBe("password");
    expect(normalizeRefusedSecretClass("PIN")).toBe("PIN");
    expect(normalizeRefusedSecretClass("pin")).toBe("PIN");
    expect(normalizeRefusedSecretClass("your Notion login")).toBeNull();
    expect(normalizeRefusedSecretClass(null)).toBeNull();
  });
});

describe("isValidSecretName", () => {
  it("validates the destination and never cleans it", () => {
    expect(isValidSecretName("NOTION_API_KEY")).toBe(true);
    expect(isValidSecretName("_private")).toBe(true);
    expect(isValidSecretName("9LIVES")).toBe(false);
    expect(isValidSecretName("NOTION-API-KEY")).toBe(false);
    expect(isValidSecretName("NOTION API KEY")).toBe(false);
    expect(isValidSecretName("")).toBe(false);
    expect(isValidSecretName(null)).toBe(false);
  });
});
