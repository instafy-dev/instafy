import { test, expect } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import { resolvePlaywrightControllerUrl } from "../utils/controllerUrl.js";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe.serial("Space switcher", () => {
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-picker" }).catch(() => {});
  });

  test("searches spaces in the switcher and returns to chat after switching", async ({ page }) => {
    test.setTimeout(180_000);

    const initialProjectId = await page.evaluate(
      () => window["__INSTAFY_STORE__"]?.getState?.().activeProjectId ?? null,
    );
    if (!initialProjectId) {
      throw new Error("Unable to resolve initial project id from store.");
    }

    const initialProjectName = ((await page.getByTestId("topbar-project-name").textContent()) ?? "").trim();
    expect(initialProjectName.length).toBeGreaterThan(0);

    const activeOrgInfo = await page.evaluate(() => {
      const store = window["__INSTAFY_STORE__"];
      const state = store?.getState?.();
      const projectId = state?.activeProjectId;
      const org = projectId ? state?.projects?.[projectId]?.org ?? null : null;
      return { orgId: org?.id ?? null, orgName: org?.name ?? null };
    });
    if (!activeOrgInfo?.orgId) {
      throw new Error("Unable to resolve active org id from store.");
    }

    const accessToken = await page.evaluate(async () => {
      const supabase = window["__INSTAFY_SUPABASE__"];
      if (!supabase?.auth?.getSession) {
        return null;
      }
      const result = await supabase.auth.getSession();
      return result?.data?.session?.access_token ?? null;
    });
    if (!accessToken) {
      throw new Error("Unable to resolve Supabase access token for controller requests.");
    }

    const controllerUrl = resolvePlaywrightControllerUrl(process.env);
    const createResponse = await page.context().request.post(
      `${controllerUrl}/orgs/${encodeURIComponent(activeOrgInfo.orgId)}/projects`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: { projectType: "customer" },
      },
    );
    if (!createResponse.ok()) {
      const text = await createResponse.text().catch(() => "");
      throw new Error(`Controller project create failed (${createResponse.status()}): ${text}`);
    }

    const createBody = (await createResponse.json().catch(() => null)) as { projectId?: string | null } | null;
    const createdProjectId =
      typeof createBody?.projectId === "string" && createBody.projectId.trim().length > 0
        ? createBody.projectId.trim()
        : null;
    if (!createdProjectId) {
      throw new Error("Controller project create response missing projectId.");
    }

    const nextProjectUrl = new URL(page.url());
    nextProjectUrl.searchParams.set("projectId", createdProjectId);
    nextProjectUrl.searchParams.delete("conversationId");
    nextProjectUrl.searchParams.delete("conversationControllerId");
    nextProjectUrl.searchParams.delete("panel");
    await page.goto(nextProjectUrl.toString());

    await expect
      .poll(async () => {
        return await page.evaluate(
          () => window["__INSTAFY_STORE__"]?.getState?.().activeProjectId ?? null,
        );
      })
      .toBe(createdProjectId);
    await expect
      .poll(() => Promise.resolve(new URL(page.url()).searchParams.get("projectId")))
      .toBe(createdProjectId);

    await openTeamDirectory(page);
    const projectMenu = page.getByTestId("sidebar-project-switcher-menu");
    await expect(projectMenu).toBeVisible();

    await projectMenu.getByTestId("sidebar-project-search-toggle").click();
    const search = projectMenu.getByTestId("sidebar-project-search");
    await expect(search).toBeVisible();
    await search.fill(initialProjectName);

    const initialItem = projectMenu.getByTestId(`sidebar-project-switcher-item-${initialProjectId}`);
    const createdItem = projectMenu.getByTestId(`sidebar-project-switcher-item-${createdProjectId}`);
    await expect(initialItem).toBeVisible();
    await expect(createdItem).toHaveCount(0);

    await initialItem.click();

    await expect(projectMenu).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("topbar-project-name")).toHaveText(initialProjectName);
    await expect
      .poll(async () => {
        return await page.evaluate(
          () => window["__INSTAFY_STORE__"]?.getState?.().activeProjectId ?? null,
        );
      })
      .toBe(initialProjectId);
    await expect
      .poll(() => Promise.resolve(new URL(page.url()).searchParams.get("projectId")))
      .toBe(initialProjectId);
  });
});
