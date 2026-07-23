import { test, expect } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.use({ trace: "off" });

test.describe("AI Manager (agent model)", () => {
  test("updates @octo model selection", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page);

    await openSidebarSecondaryItem(page, "ai");
    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.getByTestId("bots-octo-edit").click();
    await expect(page.getByTestId("agent-profile-modal")).toBeVisible();

    const modelTrigger = page.getByTestId("agent-profile-model-select");
    const previousModelLabel = (await modelTrigger.innerText().catch(() => "")).trim();

    await modelTrigger.click();
    const modelMenu = page.getByTestId("agent-profile-model-menu");
    await expect(modelMenu).toBeVisible();

    await modelMenu.getByRole("menuitemradio", { name: "gpt-5.5-mini" }).click();

    const saveResponse = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "PATCH" &&
        /\/me\/agents\/[^/]+$/.test(response.url()),
      { timeout: 60_000 },
    );

    await page.getByTestId("agent-profile-save").click();
    const response = await saveResponse;
    const requestBody = response.request().postDataJSON() as Record<string, unknown>;
    expect(requestBody.model).toBe("gpt-5.5-mini");
    await expect(page.getByTestId("agent-profile-modal")).toBeHidden({ timeout: 30_000 });

    await page.getByTestId("bots-octo-edit").click();
    await expect(page.getByTestId("agent-profile-modal")).toBeVisible();
    await expect(page.getByTestId("agent-profile-model-select")).toContainText("gpt-5.5-mini");

    const cleanupResponse = page.waitForResponse(
      (res) =>
        res.ok() &&
        res.request().method() === "PATCH" &&
        /\/me\/agents\/[^/]+$/.test(res.url()),
      { timeout: 60_000 },
    );

    await page.getByTestId("agent-profile-model-select").click();
    await expect(page.getByTestId("agent-profile-model-menu")).toBeVisible();

    if (previousModelLabel.toLowerCase().startsWith("default")) {
      await page.getByTestId("agent-profile-model-menu").getByRole("menuitemradio", { name: /default/i }).click();
    } else if (previousModelLabel) {
      await page
        .getByTestId("agent-profile-model-menu")
        .getByRole("menuitemradio", { name: previousModelLabel, exact: true })
        .click();
    } else {
      await page.getByTestId("agent-profile-model-menu").getByRole("menuitemradio", { name: /default/i }).click();
    }

    await page.getByTestId("agent-profile-save").click();
    await cleanupResponse;
    await expect(page.getByTestId("agent-profile-modal")).toBeHidden({ timeout: 30_000 });
  });
});
