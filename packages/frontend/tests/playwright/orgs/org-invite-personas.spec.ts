import { test, expect, type Page, type Browser } from "@playwright/test";
import {
import { chooseOption } from "../utils/select.js";
  createControllerOrgAndProject,
  getControllerUrl,
  getSupabaseUrl,
  prepareStudio,
} from "../utils/harness.js";

/**
 * The three people an invite link can land on, driven through the real UI:
 *
 * 1. someone with NO account (the link must survive the login round-trip),
 * 2. an existing user signed in as the invited address,
 * 3. an existing user signed in as the WRONG address -- who must be able to
 *    see enough (masked) context to realize it, switch accounts, and recover.
 *
 * Plus the invite-role change: retargeting a pending invitation must not
 * invalidate the link the invitee already holds, and acceptance must grant
 * the role as it is at ACCEPT time, not send time.
 */

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

async function resolveUserId(page: Page): Promise<string> {
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
  throw new Error("Unable to resolve authenticated user id.");
}

async function createConfirmedUser(
  request: import("@playwright/test").APIRequestContext,
  options: { supabaseUrl: string; serviceRoleKey: string; email: string; password: string },
): Promise<string> {
  const response = await request.post(`${options.supabaseUrl}/auth/v1/admin/users`, {
    headers: {
      apikey: options.serviceRoleKey,
      authorization: `Bearer ${options.serviceRoleKey}`,
      "content-type": "application/json",
    },
    data: {
      email: options.email,
      password: options.password,
      email_confirm: true,
    },
  });
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase user create failed (${response.status()}): ${body}`);
  }
  const payload = (await response.json()) as { user?: { id?: string }; id?: string };
  const userId = payload?.user?.id ?? payload?.id ?? null;
  if (!userId) {
    throw new Error(`Supabase user create missing id: ${JSON.stringify(payload)}`);
  }
  return userId;
}

/** Establish a session in an already-open page without leaving the app. */
async function adoptSession(page: Page, email: string, password: string) {
  const supabaseUrl = getSupabaseUrl();
  const anonKey = resolveSupabaseAnonKey();
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase anon key missing; cannot login.");
  }
  const response = await page.context().request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email, password },
    },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase login failed (${response.status()}): ${body}`);
  }
  const payload = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };
  await page.waitForFunction(() => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    return !!client?.auth && typeof client.auth.setSession === "function";
  });
  const sessionError = await page.evaluate(async ({ access_token, refresh_token }) => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    const result = await client.auth.setSession({ access_token, refresh_token });
    return result?.error?.message ?? null;
  }, payload);
  if (sessionError) {
    throw new Error(`Supabase setSession failed: ${sessionError}`);
  }
}

async function fetchInvitationToken(
  request: import("@playwright/test").APIRequestContext,
  options: { supabaseUrl: string; serviceRoleKey: string; email: string },
): Promise<string | null> {
  const response = await request.get(
    `${options.supabaseUrl}/rest/v1/email_outbox?select=metadata,created_at,to_email&to_email=eq.${encodeURIComponent(
      options.email,
    )}&order=created_at.desc&limit=1`,
    {
      headers: {
        apikey: options.serviceRoleKey,
        authorization: `Bearer ${options.serviceRoleKey}`,
      },
    },
  );
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as Array<{
    metadata?: { token?: string };
  }> | null;
  const token = payload?.[0]?.metadata?.token;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

async function activateProject(
  page: Page,
  projectId: string,
  projectName: string,
  org?: { id?: string | null; name?: string | null },
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
          orgName: payload.orgName ?? null,
        });
      }
      if (typeof state?.setProjectOrg === "function" && payload.orgId) {
        state.setProjectOrg(payload.projectId, {
          id: payload.orgId,
          name: payload.orgName ?? "Personal organization",
        });
      }
      if (typeof state?.switchProject === "function") {
        state.switchProject(payload.projectId);
      }
      (window as any).__INSTAFY_ACTIVE_PROJECT_ID__ = payload.projectId;
      (window as any).__INSTAFY_PROJECT_INITIALIZED__ = true;
    },
    { projectId, projectName, orgId: org?.id ?? null, orgName: org?.name ?? null },
  );
}

async function openOrgSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-org-settings-button").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
}

async function revealPendingInvitations(page: Page) {
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

async function revealOrgMembers(page: Page) {
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

type InviteFixture = {
  orgId: string;
  projectId: string;
  orgName: string;
};

async function sendOrgInvite(
  page: Page,
  email: string,
  role: "viewer" | "builder" | "admin",
): Promise<string> {
  await chooseOption(page.getByTestId("org-member-invite-role"), role);
  const input = page.getByTestId("org-member-invite-email");
  await input.fill(email);
  await page.getByTestId("org-member-invite-submit").click();
  await expect(input).toHaveValue("", { timeout: 30_000 });

  await revealPendingInvitations(page);
  const row = page
    .locator('[data-testid^="org-invite-row-"]')
    .filter({ hasText: email })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const rowTestId = await row.getAttribute("data-testid");
  const invitationId = rowTestId?.replace("org-invite-row-", "") ?? "";
  expect(invitationId).not.toBe("");
  return invitationId;
}

test.describe.serial("Org invite personas", () => {
  test.setTimeout(240_000);

  let fixture: InviteFixture | null = null;
  let supabaseUrl = "";
  let serviceRoleKey = "";

  async function prepareInviter(page: Page): Promise<InviteFixture> {
    await prepareStudio(page, { waitForHostedRuntime: false });
    const controllerUrl = getControllerUrl();
    supabaseUrl = getSupabaseUrl() ?? "";
    const controllerAdminToken = resolveControllerAdminToken();
    serviceRoleKey = resolveSupabaseServiceRoleKey();
    if (!controllerUrl || !supabaseUrl || !controllerAdminToken || !serviceRoleKey) {
      test.skip(true, "Controller and Supabase service role key are required.");
    }
    const ownerUserId = await resolveUserId(page);
    const orgName = "Playwright Invite Personas";
    const { projectId, orgId } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId,
        orgSlug: `playwright-personas-${Date.now()}`,
        orgName,
        projectType: "customer",
      },
    );
    await activateProject(page, projectId, "Invite Personas Project", {
      id: orgId,
      name: orgName,
    });
    await openOrgSettings(page);
    fixture = { orgId, projectId, orgName };
    return fixture;
  }

  async function inviteeContext(browser: Browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    return { context, page };
  }

  test("a brand-new user survives the login round-trip and lands on the consent card", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    const { orgName } = await prepareInviter(page);

    const inviteeEmail = `persona-new-${Date.now()}@instafy.dev`;
    const inviteePassword = "PersonaNew123!";
    await sendOrgInvite(page, inviteeEmail, "viewer");
    let token: string | null = null;
    await expect
      .poll(
        async () => {
          token = await fetchInvitationToken(page.context().request, {
            supabaseUrl,
            serviceRoleKey,
            email: inviteeEmail,
          });
          return token;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // The invitee has NO account yet and opens the link cold.
    const { context, page: invitee } = await inviteeContext(browser);
    await invitee.goto(`/invite?token=${encodeURIComponent(token!)}`, {
      waitUntil: "domcontentloaded",
    });

    // RequireAuth must bounce to login and preserve the full invite target.
    await invitee.waitForURL((url) => url.pathname.includes("/login"), {
      timeout: 30_000,
    });
    const loginUrl = new URL(invitee.url());
    const redirect = loginUrl.searchParams.get("redirect") ?? "";
    expect(redirect).toContain("/invite");
    expect(redirect).toContain(token!);

    // Account creation happens while the redirect is parked in the URL.
    await createConfirmedUser(invitee.context().request, {
      supabaseUrl,
      serviceRoleKey,
      email: inviteeEmail,
      password: inviteePassword,
    });
    await adoptSession(invitee, inviteeEmail, inviteePassword);

    // Follow the parked redirect exactly as the login page would.
    await invitee.goto(redirect, { waitUntil: "domcontentloaded" });

    // Consent card: nothing was accepted during the auth detour, and the
    // preview names the inviter's org and the granted access.
    await expect(invitee.getByTestId("invite-accept-join")).toBeVisible({
      timeout: 30_000,
    });
    await expect(invitee.getByTestId("invite-accept-page")).toContainText(orgName, {
      timeout: 30_000,
    });
    await expect(invitee.getByTestId("invite-accept-page")).toContainText("Read access");

    await invitee.getByTestId("invite-accept-join").click();
    await invitee.waitForURL((url) => url.pathname.includes("/studio"), {
      timeout: 30_000,
    });

    await context.close();
  });

  test("the wrong account sees masked context, switches accounts, and recovers", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    await prepareInviter(page);

    const invitedEmail = `persona-invited-${Date.now()}@instafy.dev`;
    const invitedPassword = "PersonaInvited123!";
    const bystanderEmail = `persona-bystander-${Date.now()}@instafy.dev`;
    const bystanderPassword = "PersonaBystander123!";
    await createConfirmedUser(page.context().request, {
      supabaseUrl,
      serviceRoleKey,
      email: bystanderEmail,
      password: bystanderPassword,
    });

    await sendOrgInvite(page, invitedEmail, "builder");
    let token: string | null = null;
    await expect
      .poll(
        async () => {
          token = await fetchInvitationToken(page.context().request, {
            supabaseUrl,
            serviceRoleKey,
            email: invitedEmail,
          });
          return token;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // The WRONG user opens the link while signed in.
    const { context, page: invitee } = await inviteeContext(browser);
    await invitee.goto("/login", { waitUntil: "domcontentloaded" });
    await adoptSession(invitee, bystanderEmail, bystanderPassword);
    await invitee.goto(`/invite?token=${encodeURIComponent(token!)}`, {
      waitUntil: "domcontentloaded",
    });

    // Preview must show WHO invited and (masked) to WHOM, so the mismatch is
    // discoverable BEFORE consent -- but never the full invited address.
    const card = invitee.getByTestId("invite-accept-page");
    await expect(invitee.getByTestId("invite-accept-join")).toBeVisible({
      timeout: 30_000,
    });
    await expect(card).toContainText("Invite sent to", { timeout: 30_000 });
    await expect(card).toContainText("p…@instafy.dev");
    await expect(card).not.toContainText(invitedEmail);

    // Joining anyway is refused, and the error path offers the way out.
    await invitee.getByTestId("invite-accept-join").click();
    await expect(invitee.getByTestId("invite-accept-switch-account")).toBeVisible({
      timeout: 30_000,
    });

    // Switch accounts: sign out, land on login with the invite parked.
    await invitee.getByTestId("invite-accept-switch-account").click();
    await invitee.waitForURL((url) => url.pathname.includes("/login"), {
      timeout: 30_000,
    });
    const redirect = new URL(invitee.url()).searchParams.get("redirect") ?? "";
    expect(redirect).toContain(token!);

    // The RIGHT user signs in and the same link now works end-to-end.
    await createConfirmedUser(invitee.context().request, {
      supabaseUrl,
      serviceRoleKey,
      email: invitedEmail,
      password: invitedPassword,
    });
    await adoptSession(invitee, invitedEmail, invitedPassword);
    await invitee.goto(redirect, { waitUntil: "domcontentloaded" });
    await expect(invitee.getByTestId("invite-accept-join")).toBeVisible({
      timeout: 30_000,
    });
    await invitee.getByTestId("invite-accept-join").click();
    await invitee.waitForURL((url) => url.pathname.includes("/studio"), {
      timeout: 30_000,
    });

    await context.close();
  });

  test("re-inviting with a different role offers the in-place update instead of a dead end", async ({
    page,
  }) => {
    page.setDefaultTimeout(60_000);
    await prepareInviter(page);

    const inviteeEmail = `persona-conflict-${Date.now()}@instafy.dev`;
    await sendOrgInvite(page, inviteeEmail, "viewer");
    let firstToken: string | null = null;
    await expect
      .poll(
        async () => {
          firstToken = await fetchInvitationToken(page.context().request, {
            supabaseUrl,
            serviceRoleKey,
            email: inviteeEmail,
          });
          return firstToken;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // Same email, different role: the form must surface the conflict card
    // with an in-place update, not a bare error.
    await chooseOption(page.getByTestId("org-member-invite-role"), "admin");
    await page.getByTestId("org-member-invite-email").fill(inviteeEmail);
    await page.getByTestId("org-member-invite-submit").click();

    const conflictCard = page.getByTestId("org-invite-role-conflict");
    await expect(conflictCard).toBeVisible({ timeout: 30_000 });
    await expect(conflictCard).toContainText("already has a pending viewer invite");

    await page.getByTestId("org-invite-role-conflict-apply").click();
    await expect(conflictCard).toHaveCount(0, { timeout: 30_000 });

    // The retarget re-surfaces a prepared invite exactly like a fresh
    // prepare would (token preservation itself is proven by the
    // retarget-at-accept scenario below).
    const notice = page.getByTestId("org-email-invite-prepared");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText(`Invite prepared for ${inviteeEmail}`);
    await revealPendingInvitations(page);
    const row = page
      .locator('[data-testid^="org-invite-row-"]')
      .filter({ hasText: inviteeEmail })
      .first();
    const rowTestId = await row.getAttribute("data-testid");
    const invitationId = rowTestId?.replace("org-invite-row-", "") ?? "";
    await expect(page.getByTestId(`org-invite-role-${invitationId}`)).toHaveValue(
      "admin",
      { timeout: 30_000 },
    );
  });

  test("a pending invite's role can be retargeted and the same link grants the NEW role", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    await prepareInviter(page);

    const inviteeEmail = `persona-retarget-${Date.now()}@instafy.dev`;
    const inviteePassword = "PersonaRetarget123!";
    const inviteeUserId = await createConfirmedUser(page.context().request, {
      supabaseUrl,
      serviceRoleKey,
      email: inviteeEmail,
      password: inviteePassword,
    });

    const invitationId = await sendOrgInvite(page, inviteeEmail, "viewer");
    let token: string | null = null;
    await expect
      .poll(
        async () => {
          token = await fetchInvitationToken(page.context().request, {
            supabaseUrl,
            serviceRoleKey,
            email: inviteeEmail,
          });
          return token;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // Retarget the pending invitation viewer -> admin through the row select.
    const roleSelect = page.getByTestId(`org-invite-role-${invitationId}`);
    await expect(roleSelect).toBeVisible({ timeout: 30_000 });
    await expect(roleSelect).toHaveValue("viewer");
    await chooseOption(roleSelect, "admin");
    await expect(roleSelect).toHaveValue("admin", { timeout: 30_000 });
    // The row survives a refetch with the new role (server state, not just
    // optimistic cache).
    await page.reload({ waitUntil: "domcontentloaded" });
    await activateProject(page, fixture!.projectId, "Invite Personas Project", {
      id: fixture!.orgId,
      name: fixture!.orgName,
    });
    await openOrgSettings(page);
    await revealPendingInvitations(page);
    await expect(page.getByTestId(`org-invite-role-${invitationId}`)).toHaveValue(
      "admin",
      { timeout: 30_000 },
    );

    // The ORIGINAL link (sent while the invite still said viewer) accepts
    // with the NEW role: role resolves at accept time.
    const { context, page: invitee } = await inviteeContext(browser);
    await invitee.goto("/login", { waitUntil: "domcontentloaded" });
    await adoptSession(invitee, inviteeEmail, inviteePassword);
    await invitee.goto(`/invite?token=${encodeURIComponent(token!)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(invitee.getByTestId("invite-accept-page")).toContainText(
      "Role: admin",
      { timeout: 30_000 },
    );
    await invitee.getByTestId("invite-accept-join").click();
    await invitee.waitForURL((url) => url.pathname.includes("/studio"), {
      timeout: 30_000,
    });
    await context.close();

    // The inviter's member list shows the invitee at admin.
    await page.reload({ waitUntil: "domcontentloaded" });
    await activateProject(page, fixture!.projectId, "Invite Personas Project", {
      id: fixture!.orgId,
      name: fixture!.orgName,
    });
    await openOrgSettings(page);
    await revealOrgMembers(page);
    const memberRole = page.getByTestId(`org-member-role-${inviteeUserId}`);
    await expect(memberRole).toBeVisible({ timeout: 60_000 });
    await expect(memberRole).toHaveValue("admin");
  });
});
