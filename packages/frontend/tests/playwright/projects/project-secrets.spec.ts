import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { openSecretsPanel as openSecretsSidebarPanel } from "../utils/sidebar.js";

async function openSecretsPanel(page: import("@playwright/test").Page) {
  await openSecretsSidebarPanel(page);
  await expect(page.getByTestId("secrets-panel")).toBeVisible();
}

test.describe("Project secrets", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-secrets:cleanup" }).catch(() => {});
  });

  test("create + revoke a project secret", async ({ page }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for secrets test.");
    }

    await openSecretsPanel(page);

    const secretsCard = page.getByTestId("project-secrets-card");
    await expect(secretsCard).toBeVisible();

    await secretsCard.getByTestId("project-secret-create").click();
    await expect(page.getByTestId("project-secret-modal")).toBeVisible();

    await page.getByTestId("project-secret-name-input").fill("GITHUB_TOKEN");
    await page.getByTestId("project-secret-description-input").fill("Token used to create GitHub pull requests.");
    await page.getByTestId("project-secret-value-input").fill("test-gh-token");

    const firstAgentCheckbox = page.locator('[data-testid^="project-secret-agent-"]').first();
    if ((await firstAgentCheckbox.count()) > 0) {
      await firstAgentCheckbox.click();
    }

    await page.getByTestId("project-secret-save").click();

    await expect(secretsCard).toContainText("GITHUB_TOKEN");

    const secretRow = secretsCard.locator('[data-testid^="project-secret-row-"]').filter({ hasText: "GITHUB_TOKEN" }).first();
    await expect(secretRow).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await secretRow.getByRole("button", { name: "Revoke" }).click();

    await expect(secretsCard).not.toContainText("GITHUB_TOKEN");
  });
});
