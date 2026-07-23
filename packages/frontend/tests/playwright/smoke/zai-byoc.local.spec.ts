import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    if (!key) continue;
    env[key] = value;
  }
  return env;
}

function readZaiApiKeyFromEnvFile(): string | null {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "../../../../..");
    const envPath = path.join(repoRoot, ".env.zai");
    const contents = fs.readFileSync(envPath, "utf-8");
    const parsed = parseEnvFile(contents);
    const key = String(parsed.ZAI_API_KEY || "").trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

test.describe("z.ai BYOC (local)", () => {
  let zaiApiKey: string | null = null;

  test.beforeAll(() => {
    zaiApiKey = (process.env.ZAI_API_KEY ?? "").trim() || readZaiApiKeyFromEnvFile();
  });

  test.beforeEach(() => {
    test.skip(
      (process.env.PLAYWRIGHT_ENABLE_ZAI_BYOC ?? "").trim() !== "1",
      "Set PLAYWRIGHT_ENABLE_ZAI_BYOC=1 to opt into z.ai e2e tests.",
    );
    test.skip(!zaiApiKey, "Missing ZAI_API_KEY (or .env.zai).");
  });

  test("connects & verifies API key via AI panel", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page);

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.getByTestId("credentials-add-connection").click();
    await expect(page.getByTestId("credentials-connect-modal")).toBeVisible();
    await page.getByTestId("credentials-connect-choice-zai").click();

    const zaiCard = page.getByTestId("credentials-zai-card");
    await zaiCard.scrollIntoViewIfNeeded();

    await zaiCard.getByTestId("credentials-zai-api-key-input").fill(zaiApiKey!);

    const testResponse = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        /\/me\/credentials\/[^/]+\/test$/.test(response.url()),
      { timeout: 90_000 },
    );
    await zaiCard.getByTestId("credentials-zai-connect").click();

    const response = await testResponse;
    const payload = (await response.json()) as { ok?: boolean };
    expect(payload.ok).toBe(true);
  });
});
