import { test, expect } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import {
  getControllerUrl,
  getSupabaseUrl,
  prepareStudio,
  requireWorkspaceProjectId,
  createControllerOrgAndProject,
} from "../utils/harness.js";

function resolveControllerAdminToken(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

function resolveSupabaseServiceRoleKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

function resolveSupabaseAnonKey(): string {
  return (
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    ""
  );
}

async function resolveUserId(page: import("@playwright/test").Page): Promise<string> {
  const userId = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getUser) {
      return null;
    }
    const result = await client.auth.getUser();
    return result?.data?.user?.id ?? null;
  });
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Unable to resolve authenticated user id for org member test.");
  }
  return userId.trim();
}

async function loginWithEmailPassword(page: import("@playwright/test").Page, email: string, password: string) {
  const supabaseUrl = getSupabaseUrl();
  const anonKey = resolveSupabaseAnonKey();
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase anon key missing; cannot login.");
  }
  const response = await page.context().request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: {
        apikey: anonKey,
        "content-type": "application/json"
      },
      data: {
        email,
        password
      }
    }
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase login failed (${response.status()}): ${body}`);
  }
  const payload = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };

  await page.goto("/login", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate(
    async ({ access_token, refresh_token }) => {
      const client = (window as any).__INSTAFY_SUPABASE__;
      if (!client) {
        throw new Error("Supabase client unavailable on window");
      }
      await client.auth.setSession({ access_token, refresh_token });
    },
    {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token
    }
  );
  await page.goto("/studio", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 30_000 }).catch(() => {});
}

async function openOrgSettings(page: import("@playwright/test").Page) {
  await openTeamDirectory(page);
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-org-settings-button").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
}

async function revealOrgMembers(page: import("@playwright/test").Page) {
  const memberRow = page.locator('[data-testid^="org-member-row-"]').first();
  if (await memberRow.isVisible().catch(() => false)) {
    return;
  }

  const toggle = page.getByTestId("org-members-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  const label = (await toggle.textContent())?.trim().toLowerCase() ?? "";
  if (label !== "hide") {
    await toggle.click();
  }
}

async function activateProject(
  page: import("@playwright/test").Page,
  projectId: string,
  projectName: string,
  org?: { id?: string | null; name?: string | null }
) {
  await page.evaluate(
    (payload) => {
      const store = (window as any).__INSTAFY_STORE__;
      const state = store?.getState?.();
      if (typeof state?.createProject === "function") {
        state.createProject({
          projectId: payload.projectId,
          projectName: payload.projectName,
          orgId: payload.orgId ?? null,
          orgName: payload.orgName ?? null
        });
      }
      if (typeof state?.setProjectOrg === "function" && payload.orgId) {
        state.setProjectOrg(payload.projectId, {
          id: payload.orgId,
          name: payload.orgName ?? "Personal organization"
        });
      }
      if (typeof state?.switchProject === "function") {
        state.switchProject(payload.projectId);
      }
      (window as any).__INSTAFY_ACTIVE_PROJECT_ID__ = payload.projectId;
      (window as any).__INSTAFY_PROJECT_INITIALIZED__ = true;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("projectId", payload.projectId);
        window.history.replaceState(
          window.history.state,
          document.title,
          `${url.pathname}?${url.searchParams.toString()}${url.hash}`
        );
      } catch {
        // ignore
      }
    },
    { projectId, projectName, orgId: org?.id ?? null, orgName: org?.name ?? null }
  );
}

test.describe.serial("Org members", () => {
  test.setTimeout(200_000);

  test("owners can invite and viewers cannot manage members", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });

    const controllerUrl = getControllerUrl();
    const supabaseUrl = getSupabaseUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    const supabaseServiceRoleKey = resolveSupabaseServiceRoleKey();
    if (!controllerUrl || !supabaseUrl || !controllerAdminToken || !supabaseServiceRoleKey) {
      test.skip(true, "Controller and Supabase service role key are required.");
    }

    const ownerUserId = await resolveUserId(page);
    const orgSlug = `playwright-org-${Date.now()}`;
    const orgName = "Playwright Org Members";

    const { projectId, orgId } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId,
        orgSlug,
        orgName,
        projectType: "customer"
      }
    );

    await activateProject(page, projectId, "Org Members Project", { id: orgId, name: orgName });
    const activeProject = await requireWorkspaceProjectId(page).catch(() => null);
    expect(activeProject).toBe(projectId);

    const memberEmail = `viewer-${Date.now()}@instafy.dev`;
    const memberPassword = "Viewer123!";
    const createMember = await page.context().request.post(`${supabaseUrl}/auth/v1/admin/users`, {
      headers: {
        apikey: supabaseServiceRoleKey,
        authorization: `Bearer ${supabaseServiceRoleKey}`,
        "content-type": "application/json"
      },
      data: {
        email: memberEmail,
        password: memberPassword,
        email_confirm: true
      }
    });
    if (!createMember.ok()) {
      const body = await createMember.text().catch(() => "");
      throw new Error(`Supabase member create failed (${createMember.status()}): ${body}`);
    }
    const memberPayload = (await createMember.json()) as { user?: { id?: string }; id?: string };
    const memberUserId = memberPayload?.user?.id ?? memberPayload?.id ?? null;
    if (!memberUserId) {
      throw new Error(`Supabase member create missing id. body=${JSON.stringify(memberPayload)}`);
    }

    const addMember = await page.context().request.post(
      `${controllerUrl}/orgs/${orgId}/members`,
      {
        headers: {
          authorization: `Bearer ${controllerAdminToken}`,
          "content-type": "application/json"
        },
        data: { email: memberEmail, role: "viewer" }
      }
    );
    if (!addMember.ok()) {
      const body = await addMember.text().catch(() => "");
      throw new Error(`Add member failed (${addMember.status()}): ${body}`);
    }

    await openOrgSettings(page);
    await revealOrgMembers(page);
    await expect(page.getByTestId(`org-member-row-${memberUserId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("org-member-invite-email")).toBeVisible();
    await expect(page.getByTestId(`org-member-role-${memberUserId}`)).toBeEnabled();

    await page.evaluate(async () => {
      const client = (window as any).__INSTAFY_SUPABASE__;
      await client?.auth?.signOut?.();
    });
    await page.context().clearCookies();
    await loginWithEmailPassword(page, memberEmail, memberPassword);
    await activateProject(page, projectId, "Org Members Project", { id: orgId, name: orgName });

    await openOrgSettings(page);
    await revealOrgMembers(page);
    await expect(page.getByTestId(`org-member-row-${memberUserId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("org-member-invite-email")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId(`org-member-role-${memberUserId}`)).toBeDisabled();
  });
});
