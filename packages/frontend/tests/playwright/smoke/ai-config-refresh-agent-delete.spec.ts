import { expect, test, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

const DEFAULT_CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const OCTO_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SLOTH_AGENT_ID = "44444444-4444-4444-8444-444444444444";

async function openRuntimeAiMenu(page: Page) {
  const runtimeButton = page.locator('[data-testid="runtime-selector-button"]:visible').first();
  await runtimeButton.scrollIntoViewIfNeeded().catch(() => {});
  await runtimeButton.click();
  await expect(page.getByTestId("runtime-selector-popover")).toBeVisible();
}

test.describe("AI config refresh (agent delete)", () => {
  test("removing a bot clears stale runtime routing state", async ({ page }) => {
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

    let agents = [
      {
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
      },
      {
        id: SLOTH_AGENT_ID,
        handle: "sloth",
        displayName: "Sloth",
        description: null,
        avatarSeed: "sloth",
        provider: "openai",
        model: "gpt-4.5",
        credentialId: DEFAULT_CREDENTIAL_ID,
        runtimeId: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

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

    await page.route("**/me/agents**", async (route, request) => {
      const method = request.method().toUpperCase();
      const url = new URL(request.url());

      if (method === "GET" && url.pathname.endsWith("/me/agents")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(agents),
        });
        return;
      }

      if (method === "DELETE" && url.pathname.endsWith(`/me/agents/${SLOTH_AGENT_ID}`)) {
        agents = agents.filter((agent) => agent.id !== SLOTH_AGENT_ID);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }

      await route.continue();
    });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();
    await openRuntimeAiMenu(page);
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: /@sloth/i }).first().click();

    const popover = page.getByTestId("runtime-selector-popover");
    await expect(popover.getByText(/@sloth/i).first()).toBeVisible();

    await page.getByRole("button", { name: /close agent menu/i }).click();

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/me/agents/${SLOTH_AGENT_ID}`),
      { timeout: 30_000 },
    );
    await page.getByTestId(`bots-delete-${SLOTH_AGENT_ID}`).click();
    await deleteResponse;
    await expect(page.getByTestId(`bots-delete-${SLOTH_AGENT_ID}`)).toHaveCount(0);

    await page.getByTestId("sidebar-nav-chat").click();
    await openRuntimeAiMenu(page);
    await expect(popover.getByText(/@sloth/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Agents" }).click();
    await expect(popover.getByText(/@sloth/i)).toHaveCount(0);
  });
});
