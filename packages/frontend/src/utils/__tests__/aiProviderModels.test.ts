import { describe, expect, it } from "vitest";

import { normalizeAiModelId } from "../aiProviderModels";

describe("aiProviderModels", () => {
  it("floors retired full-size OpenAI models to the managed default and keeps the mini tier", () => {
    expect(normalizeAiModelId("openai", "gpt-5.4")).toBe("gpt-5.6-sol");
    expect(normalizeAiModelId("openai", "gpt-5.4-mini")).toBe("gpt-5.5-mini");
  });
});
