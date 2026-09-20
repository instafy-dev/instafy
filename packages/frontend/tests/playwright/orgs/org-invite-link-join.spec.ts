import { test, expect } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import { getActiveOrgName, getControllerUrl, loginAsGuest, prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

type BrowserSupabaseClient = {
  auth?: {
    getSession?: () => Promise<{ data?: { session?: { access_token?: string | null } | null } | null }>;
    getUser?: () => Promise<{ data?: { user?: { id?: string | null } | null } | null }>;
  };
};

type BrowserProjectStore = {
  getState?: () => {
    activeProjectId?: string | null;
    projects?: Record<string, { org?: { id?: string | null } | null } | undefined> | null;
  };
};

type InstafyBrowserWindow = Window & {
  __INSTAFY_STORE__?: BrowserProjectStore;
  __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
};

async function openProjectSettings(page: import("@playwright/test").Page) {
  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function getSupabaseAccessToken(page: import("@playwright/test").Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const client = (window as InstafyBrowserWindow).__INSTAFY_SUPABASE__;
    const result = await client?.auth?.getSession?.();
    return result?.data?.session?.access_token ?? null;
  });
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Unable to resolve Supabase access token.");
  }
  return token.trim();
}

async function getSupabaseUserId(page: import("@playwright/test").Page): Promise<string> {
  const userId = await page.evaluate(async () => {
    const client = (window as InstafyBrowserWindow).__INSTAFY_SUPABASE__;
    const result = await client?.auth?.getUser?.();
    return result?.data?.user?.id ?? null;
  });
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Unable to resolve Supabase user id.");
  }
  return userId.trim();
}

async function getActiveOrgId(page: import("@playwright/test").Page): Promise<string> {
  const orgId = await page.evaluate(() => {
    const store = (window as InstafyBrowserWindow).__INSTAFY_STORE__;
    const state = store?.getState?.();
    const activeProjectId = state?.activeProjectId;
    const projects = state?.projects;
    const org = activeProjectId ? projects?.[activeProjectId]?.org : null;
    return org?.id ?? null;
  });
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("Unable to resolve active org id.");
  }
  return orgId.trim();
}

async function removeExistingOrgMembership(params: {
  controllerUrl: string;
  orgId: string;
  userId: string;
  ownerAccessToken: string;
  request: import("@playwright/test").APIRequestContext;
}) {
  const response = await params.request.delete(
    `${params.controllerUrl}/orgs/${encodeURIComponent(params.orgId)}/members/${encodeURIComponent(params.userId)}`,
    {
      headers: {
        authorization: `Bearer ${params.ownerAccessToken}`,
      },
    },
  );
  if (response.status() === 204 || response.status() === 404) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(`Unable to clear existing org membership (${response.status()}): ${body}`);
}

test.describe("Org invite link join", () => {
  test.setTimeout(240_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "org-invite-link-join:cleanup" }).catch(() => {});
  });

  test("joining via invite link updates the org dropdown", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
    const orgName = await getActiveOrgName(page);
    const controllerUrl = getControllerUrl();
    const ownerAccessToken = await getSupabaseAccessToken(page);
    const orgId = await getActiveOrgId(page);

    const secondProjectResponse = await page.context().request.post(
      `${controllerUrl}/orgs/${encodeURIComponent(orgId)}/projects`,
      {
        headers: {
          authorization: `Bearer ${ownerAccessToken}`,
          "content-type": "application/json"
        },
        data: {
          projectType: "customer"
        }
      }
    );
    if (!secondProjectResponse.ok()) {
      const body = await secondProjectResponse.text().catch(() => "");
      throw new Error(
        `Unable to create second org project (${secondProjectResponse.status()}): ${body}`
      );
    }
    const secondProjectPayload = (await secondProjectResponse.json().catch(() => null)) as {
      projectId?: string | null;
    } | null;
    const secondProjectId = secondProjectPayload?.projectId ?? null;
    if (!secondProjectId) {
      throw new Error(`Second project create missing projectId: ${JSON.stringify(secondProjectPayload)}`);
    }

    await openProjectSettings(page);
    await page.getByTestId("org-invite-link-create").click();
    const inviteLinkInput = page.getByTestId("org-invite-link-url");
    await expect(inviteLinkInput).toBeVisible();
    const inviteLinkUrl = await inviteLinkInput.inputValue();
    if (!inviteLinkUrl) {
      throw new Error("Invite link URL missing.");
    }

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await loginAsGuest(memberPage);
    const memberUserId = await getSupabaseUserId(memberPage);
    await removeExistingOrgMembership({
      controllerUrl,
      orgId,
      userId: memberUserId,
      ownerAccessToken,
      request: memberPage.context().request,
    });

    await memberPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
    await memberPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });

    await expect
      .poll(async () => await getActiveOrgName(memberPage).catch(() => null), {
        timeout: 60_000,
        message: "Invite link should hydrate active org name in the studio store",
      })
      .toBe(orgName);

    await openTeamDirectory(memberPage);
    await expect(memberPage.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
    await expect(memberPage.getByTestId("sidebar-org-selector")).toContainText(orgName, { timeout: 60_000 });

    const memberAccessToken = await getSupabaseAccessToken(memberPage);
    const forbiddenProjectResponse = await memberPage.context().request.get(
      `${controllerUrl}/projects/${encodeURIComponent(secondProjectId)}`,
      {
        headers: {
          authorization: `Bearer ${memberAccessToken}`
        }
      }
    );
    expect(
      forbiddenProjectResponse.status(),
      "Invite link should not grant access to other org projects"
    ).toBe(403);

    await expect(page.getByTestId(`project-member-row-${memberUserId}`)).toBeVisible({
      timeout: 60_000,
    });

    await memberContext.close();
  });
});
