import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreditsUsageRates, formatProviderLabel } from "../CreditsUsageRates";

const managedAiUsage = {
  reason: "managed_ai_prompt",
  enabled: true,
  label: "Instafy AI",
  creditsPerPrompt: 1,
  dailyPromptLimit: 20,
  modelLabel: "GPT-5.5",
  inputUsdMicrosPer1k: 250,
  cachedInputUsdMicrosPer1k: 25,
  outputUsdMicrosPer1k: 2000,
};

describe("CreditsUsageRates", () => {
  it("formats the managed provider without exposing a lowercase implementation id", () => {
    expect(formatProviderLabel(" openai ")).toBe("OpenAI");
    expect(formatProviderLabel("custom-provider")).toBe("custom-provider");
    expect(formatProviderLabel(" ")).toBeNull();
    expect(formatProviderLabel(undefined)).toBeNull();
  });

  it("renders provider attribution while accepting an older policy without it", () => {
    const attributed = renderToStaticMarkup(
      <CreditsUsageRates
        usageRateRows={[]}
        managedAiUsage={{ ...managedAiUsage, provider: "openai" }}
        unitLabel="credits"
        displayCurrency="USD"
      />,
    );
    const legacy = renderToStaticMarkup(
      <CreditsUsageRates
        usageRateRows={[]}
        managedAiUsage={managedAiUsage}
        unitLabel="credits"
        displayCurrency="USD"
      />,
    );

    expect(attributed).toContain("OpenAI · GPT-5.5");
    expect(legacy).toContain("GPT-5.5");
    expect(legacy).not.toContain("· GPT-5.5");
  });
});
