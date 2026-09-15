import { test, expect } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import { loginAsGuest, prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

async function renameProject(
  page: import("@playwright/test").Page,
  projectId: string,
  nextName: string,
) {
  const renameResponse = page.waitForResponse((response) => {
    if (response.request().method() !== "PATCH") {
      return false;
    }
    if (!response.ok()) {
      return false;
    }
    return response.url().includes(`/projects/${projectId}`);
  });

  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("project-settings-name-input").fill(nextName);
  await page.getByTestId("project-settings-name-save").click();
  await renameResponse;
  await expect(page.getByTestId("topbar-project-name")).toHaveText(nextName);
}

async function openProjectSettings(page: import("@playwright/test").Page) {
  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function createProjectInviteLink(page: import("@playwright/test").Page): Promise<string> {
  await openProjectSettings(page);
  await page.getByTestId("org-invite-link-role").selectOption("builder");
  await page.getByTestId("org-invite-link-create").click();
  const inviteLinkInput = page.getByTestId("org-invite-link-url");
  await expect(inviteLinkInput).toBeVisible();
  const inviteLinkUrl = await inviteLinkInput.inputValue();
  if (!inviteLinkUrl) {
    throw new Error("Invite link URL missing.");
  }
  return inviteLinkUrl;
}

test.describe("Project invite link keeps project name", () => {
  test.setTimeout(240_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "org-invite-link-project-rename-chat:cleanup",
    }).catch(() => {});
  });

  test("guest lands on renamed project and chat syncs", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for invite link rename test.");
    }

    const projectName = `Project ${Date.now()}`;
    await renameProject(page, projectId, projectName);

    await page.getByTestId("sidebar-nav-chat").click();
    await disableAssistantIfPossible(page);

    const ownerMessage = `hello from owner ${Date.now()}`;
    const recordResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.ok() &&
        /\/conversations\/[^/]+\/messages(?:\/record)?$/.test(new URL(response.url()).pathname),
    );
    await page.getByTestId("chat-input").fill(ownerMessage);
    await page.getByTestId("chat-send-button").click();
    await recordResponse;
    await expect(
      page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: ownerMessage }).first(),
    ).toBeVisible();

    const inviteLinkUrl = await createProjectInviteLink(page);

    await page.getByTestId("sidebar-nav-chat").click();

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await loginAsGuest(guestPage);
    await guestPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
    await guestPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });

    await expect(guestPage.getByTestId("topbar-project-name")).toHaveText(projectName, {
      timeout: 60_000,
    });
    await expect(
      guestPage.locator('[data-testid="chat-bubble-user"]').filter({ hasText: ownerMessage }).first(),
    ).toBeVisible({ timeout: 60_000 });

    await disableAssistantIfPossible(guestPage);
    const guestMessage = `hello from guest ${Date.now()}`;
    const guestRecordResponse = guestPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.ok() &&
        /\/conversations\/[^/]+\/messages(?:\/record)?$/.test(new URL(response.url()).pathname),
    );
    await guestPage.getByTestId("chat-input").fill(guestMessage);
    await guestPage.getByTestId("chat-send-button").click();
    await guestRecordResponse;
    await expect(
      guestPage.locator('[data-testid="chat-bubble-user"]').filter({ hasText: guestMessage }).first(),
    ).toBeVisible();

    await expect(
      page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: guestMessage }).first(),
    ).toBeVisible({ timeout: 60_000 });

    await guestContext.close();
  });
});
