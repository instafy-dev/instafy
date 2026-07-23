import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const DEFAULT_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const NEW_CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";

test.describe("Gemini credential onboarding", () => {
  test.setTimeout(120_000);

  test("connecting Gemini API key preserves existing default credential", async ({ page }) => {
    let defaultSetCalls = 0;
    let createCalls = 0;
    let testCalls = 0;

    const credentials = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "Primary",
        isDefault: true,
        metadata: {
          provider: "openai",
        },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    await page.route("**/me/credentials", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (!url.pathname.endsWith("/me/credentials")) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(credentials),
      });
    });

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    });

    await page.route("**/me/credentials/requirements", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requiresUserCredentials: true,
          proxyBackend: "codex",
          error: null,
        }),
      });
    });

    await page.route("**/me/credentials/codex", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      createCalls += 1;

      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.makeDefault).not.toBe(true);
      expect(body.provider).toBe("gemini");

      credentials.unshift({
        id: NEW_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "Gemini",
        isDefault: false,
        metadata: {
          provider: "gemini",
        },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentialId: NEW_CREDENTIAL_ID,
          kind: "openai_api_key",
          isDefault: false,
        }),
      });
    });

    await page.route("**/me/credentials/*/test", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      testCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          provider: "gemini",
          upstreamEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          model: "gemini-2.5-pro",
          output: "OK",
          elapsedMs: 10,
        }),
      });
    });

    await page.route("**/me/credentials/*/default", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      defaultSetCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.getByTestId("credentials-add-connection").click();
    await expect(page.getByTestId("credentials-connect-modal")).toBeVisible();
    await page.getByTestId("credentials-connect-choice-gemini").click();

    const geminiCard = page.getByTestId("credentials-gemini-card");
    await geminiCard.scrollIntoViewIfNeeded();
    await geminiCard.getByTestId("credentials-gemini-api-key-input").fill("gemini_test_key");
    await geminiCard.getByTestId("credentials-gemini-connect").click();

    await expect.poll(() => createCalls, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => testCalls, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(defaultSetCalls).toBe(0);

    await expect(page.getByTestId(`credentials-connection-row-${DEFAULT_CREDENTIAL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`credentials-connection-row-${NEW_CREDENTIAL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`credentials-connection-default-${DEFAULT_CREDENTIAL_ID}`)).toHaveCount(0);
    await expect(page.getByTestId(`credentials-connection-default-${NEW_CREDENTIAL_ID}`)).toBeVisible();
  });
});
