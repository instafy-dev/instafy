import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const OCTO_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const SECONDARY_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";

test.describe("AI Manager (@octo credential)", () => {
  test("persists @octo credential selection", async ({ page }) => {
    const now = new Date().toISOString();
    const credentials = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "Primary",
        isDefault: true,
        metadata: { provider: "openai" },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: SECONDARY_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "Secondary",
        isDefault: false,
        metadata: { provider: "openai" },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

    let octoAgent = {
      id: OCTO_AGENT_ID,
      handle: "octo",
      displayName: "Octo",
      description: null,
      avatarSeed: "octo",
      provider: "assistant",
      model: null,
      credentialId: DEFAULT_CREDENTIAL_ID,
      runtimeId: null,
      createdAt: now,
      updatedAt: now,
    };

    let lastPatchBody: Record<string, unknown> | null = null;

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

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([octoAgent]),
      });
    });

    await page.route(`**/me/agents/${OCTO_AGENT_ID}`, async (route, request) => {
      const method = request.method().toUpperCase();
      if (method !== "PATCH") {
        await route.continue();
        return;
      }

      const body = request.postDataJSON() as Record<string, unknown>;
      lastPatchBody = body;
      const credentialId = typeof body.credentialId === "string" ? body.credentialId : null;
      const model = typeof body.model === "string" ? body.model : null;
      octoAgent = {
        ...octoAgent,
        credentialId: credentialId ?? octoAgent.credentialId,
        provider: credentialId ? "openai" : octoAgent.provider,
        model,
        updatedAt: new Date().toISOString(),
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(octoAgent),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.getByTestId("bots-octo-edit").click();
    await expect(page.getByTestId("agent-profile-modal")).toBeVisible();
    await expect(page.getByTestId("agent-profile-credential-select")).toBeVisible();

    await page.getByTestId("agent-profile-credential-select").click();
    await expect(page.getByTestId("agent-profile-credential-menu")).toBeVisible();
    await page
      .getByTestId("agent-profile-credential-menu")
      .getByRole("menuitemradio", { name: /Secondary · OpenAI API key/i })
      .click();

    const saveResponse = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "PATCH" &&
        response.url().includes(`/me/agents/${OCTO_AGENT_ID}`),
      { timeout: 30_000 },
    );

    await page.getByTestId("agent-profile-save").click();
    await saveResponse;
    await expect(page.getByTestId("agent-profile-modal")).toBeHidden({ timeout: 30_000 });

    expect(lastPatchBody).not.toBeNull();
    expect(lastPatchBody?.credentialId).toBe(SECONDARY_CREDENTIAL_ID);
  });

  test("prefills @octo with the default credential when none is explicitly saved", async ({ page }) => {
    const now = new Date().toISOString();
    const credentials = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        kind: "openai_api_key",
        label: "Primary",
        isDefault: true,
        metadata: { provider: "openai" },
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const octoAgent = {
      id: OCTO_AGENT_ID,
      handle: "octo",
      displayName: "Octo",
      description: null,
      avatarSeed: "octo",
      provider: "assistant",
      model: null,
      credentialId: null,
      runtimeId: null,
      createdAt: now,
      updatedAt: now,
    };

    await page.route("**/me/credentials", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(credentials),
      });
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

    await page.route("**/me/agents", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([octoAgent]),
      });
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.getByTestId("bots-octo-edit").click();
    await expect(page.getByTestId("agent-profile-modal")).toBeVisible();
    await expect(page.getByTestId("agent-profile-credential-select")).toContainText("Primary");
  });
});
