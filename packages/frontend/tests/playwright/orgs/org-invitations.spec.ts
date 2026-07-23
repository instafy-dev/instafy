import { test, expect } from "@playwright/test";
import {
  createControllerOrgAndProject,
  getControllerUrl,
  getSupabaseUrl,
  prepareStudio,
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const userId = await page
      .evaluate(async () => {
        const client = (window as any).__INSTAFY_SUPABASE__;
        if (!client?.auth?.getUser) {
          return null;
        }
        const result = await client.auth.getUser();
        return result?.data?.user?.id ?? null;
      })
      .catch(() => null);
    if (typeof userId === "string" && userId.trim().length > 0) {
      return userId.trim();
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Unable to resolve authenticated user id for org invitation test.");
}

async function revealPendingInvitations(page: import("@playwright/test").Page) {
  const inviteRow = page.locator('[data-testid^="org-invite-row-"]').first();
  if (await inviteRow.isVisible().catch(() => false)) {
    return;
  }

  const toggle = page.getByTestId("org-invitations-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  const label = (await toggle.textContent())?.trim().toLowerCase() ?? "";
  if (label !== "hide") {
    await toggle.click();
  }
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

async function loginWithEmailPassword(
  page: import("@playwright/test").Page,
  email: string,
  password: string
) {
  const supabaseUrl = getSupabaseUrl();
  const anonKey = resolveSupabaseAnonKey();
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase anon key missing; cannot login.");
  }
  await page.context().clearCookies().catch(() => {});
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
  await page
    .waitForFunction(() => {
      const client = (window as any).__INSTAFY_SUPABASE__;
      return !!client?.auth && typeof client.auth.setSession === "function";
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Supabase client unavailable in browser context: ${message}`);
    });

  await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (client?.auth?.signOut) {
      try {
        await client.auth.signOut();
      } catch {
        // ignore
      }
    }

    const shouldClearKey = (key: string | null): key is string => {
      if (!key) {
        return false;
      }
      const normalized = key.toLowerCase();
      return normalized.startsWith("sb-") || normalized.includes("instafy");
    };

    try {
      const localKeys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (shouldClearKey(key)) {
          localKeys.push(key);
        }
      }
      localKeys.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      // ignore
    }

    try {
      const sessionKeys: string[] = [];
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (shouldClearKey(key)) {
          sessionKeys.push(key);
        }
      }
      sessionKeys.forEach((key) => window.sessionStorage.removeItem(key));
    } catch {
      // ignore
    }
  });

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

  const sessionError = await page.evaluate(async ({ access_token, refresh_token }) => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.setSession) {
      return "Supabase client unavailable on window";
    }
    const result = await client.auth.setSession({ access_token, refresh_token });
    if (result?.error?.message) {
      return result.error.message;
    }
    const userResult = await client.auth.getUser().catch(() => null);
    const userEmail =
      userResult?.data?.user?.email && typeof userResult.data.user.email === "string"
        ? userResult.data.user.email
        : null;
    if (!userEmail) {
      return "Supabase session missing user email after setSession";
    }
    return null;
  }, {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token
  });
  if (sessionError) {
    throw new Error(`Supabase setSession failed: ${sessionError}`);
  }

  await page.goto("/studio", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page
    .waitForURL((url) => url.pathname.includes("/studio"), { timeout: 30_000 })
    .catch(() => {
      throw new Error("Email/password login did not navigate to /studio");
    });

  const resolvedEmail = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getUser) {
      return null;
    }
    const result = await client.auth.getUser().catch(() => null);
    const userEmail = result?.data?.user?.email;
    return typeof userEmail === "string" ? userEmail : null;
  });
  if (resolvedEmail?.toLowerCase() !== email.toLowerCase()) {
    throw new Error(
      `Expected to be logged in as ${email}, but session is ${resolvedEmail ?? "<missing email>"}.`
    );
  }
}

async function openOrgSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-org-settings-button").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
}

async function openProjectSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
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

async function fetchLatestInvitationEmail(
  request: import("@playwright/test").APIRequestContext,
  options: { supabaseUrl: string; serviceRoleKey: string; email: string }
): Promise<{ token: string; acceptPath: string | null } | null> {
  const { supabaseUrl, serviceRoleKey, email } = options;
  const response = await request.get(
    `${supabaseUrl}/rest/v1/email_outbox?select=metadata,created_at,to_email&to_email=eq.${encodeURIComponent(
      email
    )}&order=created_at.desc&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as Array<{
    metadata?: unknown;
  }> | null;
  const metadata =
    payload?.[0]?.metadata && typeof payload?.[0]?.metadata === "object" ? (payload[0].metadata as any) : null;
  const token = metadata?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    return null;
  }
  const acceptPath = typeof metadata?.acceptPath === "string" ? metadata.acceptPath : null;
  return { token: token.trim(), acceptPath };
}

test.describe.serial("Org invitations", () => {
  test.setTimeout(200_000);

  test("managers can send and cancel invitations", async ({ page }) => {
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
    const orgName = "Playwright Org Invitations";
    const orgSlug = `playwright-invites-${Date.now()}`;
    const { projectId, orgId } = await createControllerOrgAndProject(page.context().request, {
      controllerUrl,
      accessToken: controllerAdminToken,
      ownerUserId,
      orgSlug,
      orgName,
      projectType: "customer"
    });

    await activateProject(page, projectId, "Org Invitations Project", { id: orgId, name: orgName });
    await openOrgSettings(page);

    const inviteEmail = `invite-${Date.now()}@instafy.dev`;
    const inviteEmailInput = page.getByTestId("org-member-invite-email");
    await inviteEmailInput.fill(inviteEmail);
    await page.getByTestId("org-member-invite-submit").click();
    await expect(inviteEmailInput).toHaveValue("", { timeout: 30_000 });

    await revealPendingInvitations(page);
    const inviteRow = page
      .locator('[data-testid^="org-invite-row-"]')
      .filter({ hasText: inviteEmail })
      .first();
    await expect(inviteRow).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () =>
          await fetchLatestInvitationEmail(page.context().request, {
            supabaseUrl,
            serviceRoleKey: supabaseServiceRoleKey,
            email: inviteEmail
          }),
        {
          timeout: 10_000,
          message: "Invitation email should be written to email_outbox"
        }
      )
      .not.toBeNull();

    const rowTestId = await inviteRow.getAttribute("data-testid");
    const invitationId = rowTestId?.replace("org-invite-row-", "") ?? null;
    if (!invitationId) {
      throw new Error("Unable to resolve invitation id from pending invitation row.");
    }

    page.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await page.getByTestId(`org-invite-cancel-${invitationId}`).click();
    await expect(page.getByTestId(`org-invite-row-${invitationId}`)).toHaveCount(0);
  });

  test("invited users can accept invites and become members", async ({ page, browser }) => {
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
    const orgName = "Playwright Org Invite Accept";
    const orgSlug = `playwright-invite-accept-${Date.now()}`;
    const { projectId, orgId } = await createControllerOrgAndProject(page.context().request, {
      controllerUrl,
      accessToken: controllerAdminToken,
      ownerUserId,
      orgSlug,
      orgName,
      projectType: "customer"
    });

    await activateProject(page, projectId, "Org Invite Accept Project", { id: orgId, name: orgName });
    await openOrgSettings(page);

    const memberEmail = `invitee-${Date.now()}@instafy.dev`;
    const memberPassword = "Invitee123!";
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

    await page.getByTestId("org-member-invite-role").selectOption("viewer");
    const memberInviteEmailInput = page.getByTestId("org-member-invite-email");
    await memberInviteEmailInput.fill(memberEmail);
    await page.getByTestId("org-member-invite-submit").click();
    await expect(memberInviteEmailInput).toHaveValue("", { timeout: 30_000 });

    await revealPendingInvitations(page);
    const inviteRow = page
      .locator('[data-testid^="org-invite-row-"]')
      .filter({ hasText: memberEmail })
      .first();
    await expect(inviteRow).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () =>
          await fetchLatestInvitationEmail(page.context().request, {
            supabaseUrl,
            serviceRoleKey: supabaseServiceRoleKey,
            email: memberEmail
          }),
        { timeout: 10_000 }
      )
      .not.toBeNull();
    const emailDetails = await fetchLatestInvitationEmail(page.context().request, {
      supabaseUrl,
      serviceRoleKey: supabaseServiceRoleKey,
      email: memberEmail
    });
    if (!emailDetails) {
      throw new Error("Unable to locate invitation email for acceptance.");
    }

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await loginWithEmailPassword(memberPage, memberEmail, memberPassword);
    await memberPage.goto(`/invite?token=${encodeURIComponent(emailDetails.token)}`, { waitUntil: "domcontentloaded" });
    await memberPage
      .waitForURL((url) => url.pathname.includes("/studio"), { timeout: 30_000 })
      .catch(() => {});

    await activateProject(memberPage, projectId, "Org Invite Accept Project", { id: orgId, name: orgName });
    await openOrgSettings(memberPage);
    await revealOrgMembers(memberPage);
    await expect(memberPage.getByTestId(`org-member-row-${memberUserId}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(memberPage.getByTestId("org-member-invite-email")).toBeHidden();

    await memberContext.close();
  });

  test("space settings can send project-scoped email invitations", async ({ page }) => {
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
    const orgName = "Playwright Project Invitations";
    const orgSlug = `playwright-project-invite-${Date.now()}`;
    const { projectId, orgId } = await createControllerOrgAndProject(page.context().request, {
      controllerUrl,
      accessToken: controllerAdminToken,
      ownerUserId,
      orgSlug,
      orgName,
      projectType: "customer",
    });

    await activateProject(page, projectId, "Project Invite Space", { id: orgId, name: orgName });
    await openProjectSettings(page);
    await page.getByTestId("settings-category-project-access").click();

    const inviteEmail = `project-guest-${Date.now()}@instafy.dev`;
    const projectInviteEmailInput = page.getByTestId("project-member-invite-email");
    await projectInviteEmailInput.fill(inviteEmail);
    await page.getByTestId("project-member-invite-role").selectOption("viewer");
    await page.getByTestId("project-member-invite-submit").click();
    await expect(projectInviteEmailInput).toHaveValue("", { timeout: 30_000 });

    const inviteRow = page
      .locator('[data-testid^="project-invite-row-"]')
      .filter({ hasText: inviteEmail })
      .first();
    await expect(inviteRow).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () =>
          await fetchLatestInvitationEmail(page.context().request, {
            supabaseUrl,
            serviceRoleKey: supabaseServiceRoleKey,
            email: inviteEmail,
          }),
        {
          timeout: 10_000,
          message: "Project invitation email should be written to email_outbox",
        },
      )
      .not.toBeNull();

    const latestEmail = await fetchLatestInvitationEmail(page.context().request, {
      supabaseUrl,
      serviceRoleKey: supabaseServiceRoleKey,
      email: inviteEmail,
    });
    expect(latestEmail?.acceptPath).toContain(`projectId=${projectId}`);
  });
});
