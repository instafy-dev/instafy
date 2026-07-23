import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const DEFAULT_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const NEW_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const AI_CONNECT_WIZARD_STORAGE_PREFIX = "instafy.chat.aiConnectWizard.v1";

test.describe("Credential onboarding", () => {
  test.setTimeout(120_000);

  test("does not reopen AI connect onboarding when a default credential already exists", async ({ page }) => {
    const credentials = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "API key",
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

    await prepareStudio(page, { waitForHostedRuntime: false });

    const storageKey = await page.evaluate((prefix) => {
      const store = (window as typeof window & {
        __INSTAFY_STORE__?: { getState?: () => { activeProjectId?: string | null } };
        __INSTAFY_SUPABASE__?: {
          auth?: { getUser?: () => Promise<{ data?: { user?: { id?: string | null } | null } }> };
        };
      }).__INSTAFY_STORE__;
      const activeProjectId = store?.getState?.().activeProjectId ?? null;
      if (!activeProjectId) {
        return null;
      }
      return (window as typeof window & {
        __INSTAFY_SUPABASE__?: {
          auth?: { getUser?: () => Promise<{ data?: { user?: { id?: string | null } | null } }> };
        };
      }).__INSTAFY_SUPABASE__?.auth?.getUser?.().then((result) => {
        const userId = result?.data?.user?.id ?? null;
        if (!userId) {
          return null;
        }
        return `${prefix}:${userId}:${activeProjectId}`;
      });
    }, AI_CONNECT_WIZARD_STORAGE_PREFIX);

    expect(storageKey).toBeTruthy();

    await page.evaluate((key) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          open: true,
          provider: "openai",
          step: "provider",
          deviceAuthSession: null,
          deviceAuthError: null,
          updatedAt: Date.now(),
        }),
      );
    }, storageKey as string);

    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("credentials-status-indicator")).toHaveCount(0);
  });

  test("connecting a new API key does not override an existing default credential", async ({ page }) => {
    let defaultSetCalls = 0;
    let createCalls = 0;
    let testCalls = 0;

    // Start with a single default OpenAI API key.
    const credentials = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "API key",
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
      // Critical regression check: connecting a new credential should not implicitly override default.
      expect(body.makeDefault).not.toBe(true);
      expect(body.provider).toBe("zai");

      credentials.unshift({
        id: NEW_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "z.ai",
        isDefault: false,
        metadata: {
          provider: "zai",
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
          provider: "zai",
          upstreamEndpoint: "https://api.z.ai/api/coding/paas/v4/chat/completions",
          model: "glm-5",
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
    await page.getByTestId("credentials-connect-choice-zai").click();

    const zaiCard = page.getByTestId("credentials-zai-card");
    await zaiCard.scrollIntoViewIfNeeded();
    await zaiCard.getByTestId("credentials-zai-api-key-input").fill("zai_test_key");

    await zaiCard.getByTestId("credentials-zai-connect").click();

    // Connection should create + test exactly once, without calling the default endpoint.
    await expect.poll(() => createCalls, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => testCalls, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(defaultSetCalls).toBe(0);

    await expect(page.getByTestId(`credentials-connection-row-${DEFAULT_CREDENTIAL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`credentials-connection-row-${NEW_CREDENTIAL_ID}`)).toBeVisible();

    // Default should remain on the original credential (no "Make default" button).
    await expect(page.getByTestId(`credentials-connection-default-${DEFAULT_CREDENTIAL_ID}`)).toHaveCount(0);
    // Newly added credential should not be default (it should offer "Make default").
    await expect(page.getByTestId(`credentials-connection-default-${NEW_CREDENTIAL_ID}`)).toBeVisible();
  });
});
