import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE,
  CREDENTIAL_LABEL_INVALID_MESSAGE,
  checkCredentialLabel,
  clampCredentialLabel,
  holdsEmailAddress,
  savableCredentialLabel,
} from "../credentialLabelRules";

// Studio's copy of the controller's name rules. The lists are the
// controller's own file, so a rule changed on one side and not the other
// fails here and in credential_labels.rs at once.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const FIXTURES = JSON.parse(
  readFileSync(resolve(repo, "packages/runtime-controller/src/credential_label_fixtures.json"), "utf8"),
) as { valid: string[]; trimmed: [string, string][]; invalid: string[]; hasEmail: string[] };

describe("credential label rules", () => {
  it("saves the names the controller saves, as it saves them", () => {
    expect(FIXTURES.valid.length).toBeGreaterThan(0);
    for (const name of FIXTURES.valid) {
      expect(checkCredentialLabel(name), JSON.stringify(name)).toEqual({ ok: true, label: name });
    }
    for (const [raw, saved] of FIXTURES.trimmed) {
      expect(checkCredentialLabel(raw), JSON.stringify(raw)).toEqual({ ok: true, label: saved });
    }
  });

  it("refuses the names the controller refuses, with its sentence", () => {
    for (const name of FIXTURES.invalid) {
      expect(checkCredentialLabel(name), JSON.stringify(name)).toEqual({
        ok: false,
        code: "credential_label_invalid",
        message: CREDENTIAL_LABEL_INVALID_MESSAGE,
      });
    }
    for (const name of FIXTURES.hasEmail) {
      expect(holdsEmailAddress(name), JSON.stringify(name)).toBe(true);
      expect(checkCredentialLabel(name), JSON.stringify(name)).toEqual({
        ok: false,
        code: "credential_label_has_email",
        message: CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE,
      });
    }
  });

  it("counts code points, so sixty emoji fit and a lone surrogate never passes", () => {
    expect(checkCredentialLabel("😀".repeat(60)).ok).toBe(true);
    expect(checkCredentialLabel("😀".repeat(61)).ok).toBe(false);
    expect(checkCredentialLabel("Chat\uD800GPT").ok).toBe(false);
    expect(clampCredentialLabel("😀".repeat(61))).toBe("😀".repeat(60));
    expect(clampCredentialLabel("Work plan")).toBe("Work plan");
  });

  it("gives a saved name back only when it would be saved again", () => {
    expect(savableCredentialLabel("  Work plan ")).toBe("Work plan");
    expect(savableCredentialLabel("ann@example.com")).toBeNull();
    expect(savableCredentialLabel("x".repeat(61))).toBeNull();
    expect(savableCredentialLabel("")).toBeNull();
    expect(savableCredentialLabel(null)).toBeNull();
    expect(savableCredentialLabel(undefined)).toBeNull();
  });
});
