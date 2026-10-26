import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_AI_MODEL, OWN_AI_SMALL_MODEL_ID } from "../../ai/modelDefaults";
import { modelOptionsForProvider, normalizeAiModelId, ownAiModelFloor } from "../aiProviderModels";

// The own-AI ids and floor cases are runtime-contracts' fixture: the same file
// the controller's floor test and the proxy's default test read, so Studio's
// copy of the default and of the floor cannot drift from what runs.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const fixtures = JSON.parse(readFileSync(
  resolve(repo, "packages/runtime-contracts/src/own_ai_model_fixtures.json"), "utf8",
)) as {
  defaultModelId: string;
  smallModelId: string;
  floor: { model: string; runs: "default" | "small" | "keep" }[];
};

function floorTarget(runs: "default" | "small" | "keep"): string | null {
  switch (runs) {
    case "default":
      return fixtures.defaultModelId;
    case "small":
      return fixtures.smallModelId;
    case "keep":
      return null;
  }
}

describe("aiProviderModels", () => {
  it("keeps Studio's own-AI ids equal to the shared fixture", () => {
    expect(DEFAULT_PROJECT_AI_MODEL).toBe(fixtures.defaultModelId);
    expect(OWN_AI_SMALL_MODEL_ID).toBe(fixtures.smallModelId);
  });

  it("raises OpenAI picks below GPT-6 the way the controller does", () => {
    expect(fixtures.floor.length).toBeGreaterThan(0);
    for (const { model, runs } of fixtures.floor) {
      const expected = floorTarget(runs);
      expect(ownAiModelFloor(model), model).toBe(expected);
      expect(normalizeAiModelId("openai", model), model).toBe(expected ?? model.trim());
    }
  });

  it("offers only models that run as picked, the default first", () => {
    const options = modelOptionsForProvider("openai").map((option) => option.id);
    expect(options[0]).toBe(DEFAULT_PROJECT_AI_MODEL);
    expect(options).toContain(OWN_AI_SMALL_MODEL_ID);
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
