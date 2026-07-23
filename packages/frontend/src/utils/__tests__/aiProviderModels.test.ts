import { describe, expect, it } from "vitest";

import { normalizeAiModelId } from "../aiProviderModels";

describe("aiProviderModels", () => {
  it("normalizes retired OpenAI 5.4 models to current 5.5 ids", () => {
    expect(normalizeAiModelId("openai", "gpt-5.4")).toBe("gpt-5.5");
    expect(normalizeAiModelId("openai", "gpt-5.4-mini")).toBe("gpt-5.5-mini");
  });
});
