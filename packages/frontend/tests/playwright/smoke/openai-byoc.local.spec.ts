import { expect, test, type APIRequestContext, type Response } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

type CreatedCredentialCleanup = {
  authorization: string;
  credentialId: string;
  url: string;
};

async function resolveCreatedCredentialCleanup(
  response: Response,
): Promise<CreatedCredentialCleanup> {
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { credentialId?: unknown };
  const credentialId =
    typeof payload.credentialId === "string" ? payload.credentialId.trim() : "";
  expect(credentialId).not.toBe("");

  const authorization = (await response.request().allHeaders()).authorization?.trim() ?? "";
  expect(authorization).not.toBe("");

  const url = response
    .url()
    .replace(
      /\/me\/credentials\/codex(?:\?.*)?$/,
      `/me/credentials/${encodeURIComponent(credentialId)}`,
    );
  expect(url).not.toBe(response.url());

  return { authorization, credentialId, url };
}

async function revokeCreatedCredential(
  request: APIRequestContext,
  cleanup: CreatedCredentialCleanup,
): Promise<void> {
  const response = await request.delete(cleanup.url, {
    headers: {
      authorization: cleanup.authorization,
      accept: "application/json",
    },
  });
  expect(
    response.ok() || response.status() === 404,
    `Failed to remove OpenAI BYOK test credential ${cleanup.credentialId}.`,
  ).toBe(true);
}

test.describe("OpenAI BYOK (local)", () => {
  const openaiApiKey = (process.env.OPENAI_API_KEY ?? "").trim();

  test.beforeEach(() => {
    test.skip(
      (process.env.PLAYWRIGHT_ENABLE_OPENAI_BYOC ?? "").trim() !== "1",
      "Set PLAYWRIGHT_ENABLE_OPENAI_BYOC=1 to opt into OpenAI BYOK e2e tests.",
    );
    test.skip(!openaiApiKey, "Missing OPENAI_API_KEY.");
  });

  test("connects, verifies, and removes an API key via AI settings", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    let cleanup: CreatedCredentialCleanup | null = null;
    try {
      await prepareStudio(page);

      await openSidebarSecondaryItem(page, "ai");
      await expect(page.getByTestId("ai-panel")).toBeVisible();

      await page.getByTestId("credentials-add-connection").click();
      await expect(page.getByTestId("credentials-connect-modal")).toBeVisible();
      await page.getByTestId("credentials-connect-choice-openai").click();

      const openaiCard = page.getByTestId("credentials-openai-card");
      await openaiCard.scrollIntoViewIfNeeded();

      const connectionLabel = `OpenAI Playwright BYOK ${Date.now()}`;
      await openaiCard.getByTestId("credentials-openai-label-input").fill(connectionLabel);
      await openaiCard.getByTestId("credentials-openai-api-key-input").fill(openaiApiKey);

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/me\/credentials\/codex(?:\?.*)?$/.test(response.url()),
        { timeout: 90_000 },
      );
      const testResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/me\/credentials\/[^/]+\/test(?:\?.*)?$/.test(response.url()),
        { timeout: 90_000 },
      );
      await openaiCard.getByTestId("credentials-openai-connect").click();

      cleanup = await resolveCreatedCredentialCleanup(await createResponsePromise);
      const testResponse = await testResponsePromise;
      expect(testResponse.ok()).toBe(true);
      expect(testResponse.url()).toContain(
        `/me/credentials/${encodeURIComponent(cleanup.credentialId)}/test`,
      );
      const testPayload = (await testResponse.json()) as { ok?: boolean };
      expect(testPayload.ok).toBe(true);

      await expect(page.getByTestId("credentials-connect-modal")).toBeHidden();
      const connectionRow = page.getByTestId(
        `credentials-connection-row-${cleanup.credentialId}`,
      );
      await expect(connectionRow).toContainText(connectionLabel);
      await expect(connectionRow).toContainText("OpenAI API key");
    } finally {
      if (cleanup) {
        await revokeCreatedCredential(request, cleanup);
      }
    }
  });
});
