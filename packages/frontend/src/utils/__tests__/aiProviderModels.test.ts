import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_AI_MODEL, OWN_AI_SMALL_MODEL_ID } from "../../ai/modelDefaults";
import { modelOptionsForProvider, normalizeAiModelId, ownAiModelFloor } from "../aiProviderModels";

// The own-AI default and floor cases are runtime-contracts' fixture: the same
// file the contracts floor test and the proxy's default test read, so Studio's
// copy of the default and of the floor cannot drift from what runs.
type FloorCase = { model: string; runs: "default" | "keep" };
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const fixtures = JSON.parse(readFileSync(
  resolve(repo, "packages/runtime-contracts/src/own_ai_model_fixtures.json"), "utf8",
)) as {
  defaultModelId: string;
  smallModelId: string;
  tiers: string[];
  floor: FloorCase[];
  floorForDefault: (FloorCase & { default: string })[];
};

describe("aiProviderModels", () => {
  it("keeps Studio's own-AI default equal to the shared fixture", () => {
    expect(DEFAULT_PROJECT_AI_MODEL).toBe(fixtures.defaultModelId);
  });

  it("runs the cheaper pick as picked, and only that exact id", () => {
    expect(OWN_AI_SMALL_MODEL_ID).toBe(fixtures.smallModelId);
    expect(OWN_AI_SMALL_MODEL_ID).not.toBe(DEFAULT_PROJECT_AI_MODEL);
    expect(ownAiModelFloor(OWN_AI_SMALL_MODEL_ID)).toBeNull();
    expect(normalizeAiModelId("openai", ` ${OWN_AI_SMALL_MODEL_ID.toUpperCase()} `))
      .toBe(OWN_AI_SMALL_MODEL_ID.toUpperCase());
    // Under any later default too; a variant of it is raised like any older id.
    expect(ownAiModelFloor(OWN_AI_SMALL_MODEL_ID, "gpt-99-sol")).toBeNull();
    expect(ownAiModelFloor(`${OWN_AI_SMALL_MODEL_ID}-mini`, "gpt-99-sol")).toBe("gpt-99-sol");
  });

  it("raises OpenAI picks older than the default the way the controller does", () => {
    expect(fixtures.floor.length).toBeGreaterThan(0);
    for (const { model, runs } of fixtures.floor) {
      const expected = runs === "default" ? DEFAULT_PROJECT_AI_MODEL : null;
      expect(ownAiModelFloor(model), model).toBe(expected);
      expect(normalizeAiModelId("openai", model), model).toBe(expected ?? model.trim());
    }
    expect(ownAiModelFloor(DEFAULT_PROJECT_AI_MODEL)).toBeNull();
  });

  it("follows a later default to ids saved as an earlier one", () => {
    expect(fixtures.floorForDefault.length).toBeGreaterThan(0);
    for (const { default: defaultModel, model, runs } of fixtures.floorForDefault) {
      expect(ownAiModelFloor(model, defaultModel), `${model} with default ${defaultModel}`)
        .toBe(runs === "default" ? defaultModel : null);
    }
  });

  it("keeps an older pick of a higher tier than the default's as picked", () => {
    // The controller's OPENAI_TIERS, cheapest first.
    const { tiers } = fixtures;
    expect(tiers.length).toBeGreaterThan(1);
    tiers.forEach((lower, low) => {
      tiers.slice(low + 1).forEach((higher) => {
        expect(ownAiModelFloor(`gpt-5.9-${higher}`, `gpt-7-${lower}`)).toBeNull();
        expect(ownAiModelFloor(`gpt-5.9-${lower}`, `gpt-7-${higher}`)).toBe(`gpt-7-${higher}`);
      });
    });
    expect(normalizeAiModelId("openai", "gpt-6-astra")).toBe("gpt-6-astra");
  });

  it("offers only models that run as picked, the default first", () => {
    const options = modelOptionsForProvider("openai").map((option) => option.id);
    expect(options).toEqual([DEFAULT_PROJECT_AI_MODEL, OWN_AI_SMALL_MODEL_ID]);
    for (const id of options) {
      expect(ownAiModelFloor(id), id).toBeNull();
    }
  });

  it("leaves other providers' ids alone", () => {
    expect(normalizeAiModelId("deepseek", " deepseek-chat ")).toBe("deepseek-chat");
    expect(normalizeAiModelId("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(normalizeAiModelId("openai", "  ")).toBeNull();
  });
});
