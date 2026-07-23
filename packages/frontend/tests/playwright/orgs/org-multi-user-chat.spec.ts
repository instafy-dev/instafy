import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  getControllerUrl,
  getSupabaseUrl,
  prepareStudio,
  requestHostedRuntime,
  purgeRealUserCredential,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";
import {
  closeRuntimeAiMenu,
  disableAssistantIfPossible,
  openRuntimeAiMenu,
} from "../utils/runtimeAi.js";

// A real local Codex credential is seeded for the invited member. Tracing is
// disabled so the credential and session token cannot be retained on failure.
test.use({ trace: "off" });

type BrowserSupabaseClient = {
  auth?: {
    setSession?: (session: { access_token: string; refresh_token: string }) => Promise<void>;
  };
};

type ActivateProjectPayload = {
  projectId: string;
  projectName: string;
  orgId: string | null;
  orgName: string | null;
};

type BrowserProjectStoreState = {
  createProject?: (payload: ActivateProjectPayload) => void;
  setProjectOrg?: (projectId: string, org: { id: string; name: string }) => void;
  switchProject?: (projectId: string) => void;
};

type BrowserProjectStore = {
  getState?: () => BrowserProjectStoreState;
};

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

async function deleteDisposableSupabaseUser(
  page: Page,
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string
): Promise<void> {
  const response = await page.context().request.delete(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Disposable multi-user account cleanup returned HTTP ${response.status()}.`);
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

  try {
    await page.goto("/login", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForFunction(
      () => {
        const client = (window as Window & {
          __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
        }).__INSTAFY_SUPABASE__;
        return !!client?.auth && typeof client.auth.setSession === "function";
      },
      undefined,
      { timeout: 15_000 }
    );
    await page.evaluate(
      async ({ access_token, refresh_token }) => {
        const client = (window as Window & {
          __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
        }).__INSTAFY_SUPABASE__;
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
    return;
  } catch {
    // Fall back to the login UI when the browser client is not ready in time.
  }

  await page.goto("/login", { waitUntil: "domcontentloaded" }).catch(() => {});
  const emailInput = page.locator("#email");
  const useAnotherAccountButton = page.getByRole("button", { name: /log in to another account/i });
  await expect
    .poll(
      async () => {
        if (await emailInput.isVisible().catch(() => false)) {
          return "email";
        }
        if (await useAnotherAccountButton.isVisible().catch(() => false)) {
          return "chooser";
        }
        return "pending";
      },
      { timeout: 15_000 }
    )
    .not.toBe("pending");
  if (!(await emailInput.isVisible().catch(() => false)) && (await useAnotherAccountButton.isVisible().catch(() => false))) {
    await useAnotherAccountButton.click();
  }

  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);
  await page.getByRole("button", { name: /^Continue$/ }).click();

  const passwordInput = page.locator("#password");
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await passwordInput.fill(password);
  await page.getByRole("button", { name: /^Continue$/ }).click();

  await page.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 30_000 }).catch(() => {});
}

async function activateProject(
  page: import("@playwright/test").Page,
  projectId: string,
  projectName: string,
  org?: { id?: string | null; name?: string | null }
) {
  await page.evaluate(
    (payload) => {
      const instafyWindow = window as Window & {
        __INSTAFY_STORE__?: BrowserProjectStore;
        __INSTAFY_ACTIVE_PROJECT_ID__?: string;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
      };
      const store = instafyWindow.__INSTAFY_STORE__;
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
      instafyWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = payload.projectId;
      instafyWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
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

async function ensureHostedRuntimeReady(page: import("@playwright/test").Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });

  // Some suites can leave behind a hosted runtime record that's not actually usable yet, which
  // manifests as the chat send button staying disabled with "Connecting to runtime…".
  try {
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const sendButton = page.getByTestId("chat-send-button");
          if (await sendButton.isVisible().catch(() => false)) {
            return await sendButton.isEnabled().catch(() => false);
          }
          const voiceButton = page.getByTestId("chat-voice-input-button");
          return await voiceButton.isVisible().catch(() => false);
        },
        { timeout: 60_000 }
      )
      .toBe(true);
  } catch {
    await requestHostedRuntime(page, {
      projectId,
      source: "chat",
      existingRuntimeStrategy: "launch-new",
      timeoutMs: 180_000
    }).catch(() => {});
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const sendButton = page.getByTestId("chat-send-button");
          if (await sendButton.isVisible().catch(() => false)) {
            return await sendButton.isEnabled().catch(() => false);
          }
          const voiceButton = page.getByTestId("chat-voice-input-button");
          return await voiceButton.isVisible().catch(() => false);
        },
        { timeout: 60_000 }
      )
      .toBe(true);
  }
}

function nonStatusAssistantBubbles(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="chat-bubble-assistant"]');
}

test.describe("Org multi-user conversation", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.setTimeout(360_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "org-multi-user-chat:cleanup" }).catch(() => {});
  });

  test("shared conversation stays consistent across org members", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for multi-user chat test.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    const controllerUrl = getControllerUrl();
    const supabaseUrl = getSupabaseUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    const supabaseServiceRoleKey = resolveSupabaseServiceRoleKey();
    if (!controllerUrl || !supabaseUrl || !controllerAdminToken || !supabaseServiceRoleKey) {
      test.skip(true, "Controller and Supabase service role key are required.");
    }

    await clearRuntimePreference(page, { projectId, source: "multi-user-chat" });
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const headers = {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`
    };
    const projectRowResponse = await page.context().request.get(
      `${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id,org_id`,
      { headers }
    );
    if (!projectRowResponse.ok()) {
      const body = await projectRowResponse.text().catch(() => "");
      throw new Error(`Unable to load project org (${projectRowResponse.status()}): ${body}`);
    }
    const projectRows = (await projectRowResponse.json().catch(() => null)) as Array<{
      org_id?: string | null;
    }> | null;
    const orgId = projectRows?.[0]?.org_id ?? null;
    if (!orgId) {
      throw new Error("Project org_id missing; cannot run multi-user org chat test.");
    }
    const orgRowResponse = await page.context().request.get(
      `${supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(orgId)}&select=id,name`,
      { headers }
    );
    if (!orgRowResponse.ok()) {
      const body = await orgRowResponse.text().catch(() => "");
      throw new Error(`Unable to load org name (${orgRowResponse.status()}): ${body}`);
    }
    const orgRows = (await orgRowResponse.json().catch(() => null)) as Array<{
      name?: string | null;
    }> | null;
    const orgName = orgRows?.[0]?.name ?? "Organization";

    const memberEmail = `multi-user-${Date.now()}@instafy.dev`;
    const memberPassword = "MultiUser123!";
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

    let memberContext: BrowserContext | null = null;
    let memberPage: Page | null = null;
    let memberCredentialId: string | null = null;
    let memberFlowError: unknown = null;
    let cleanupFailed = false;
    try {
      const addMember = await page.context().request.post(`${controllerUrl}/orgs/${orgId}/members`, {
        headers: {
          authorization: `Bearer ${controllerAdminToken}`,
          "content-type": "application/json"
        },
        data: { email: memberEmail, role: "builder" }
      });
      if (!addMember.ok()) {
        const body = await addMember.text().catch(() => "");
        throw new Error(`Add member failed (${addMember.status()}): ${body}`);
      }

      const firstPrompt = "What is 1+1? Reply with just the number.";
      const createConversationResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.ok() &&
          response.url().includes(`/projects/${projectId}/conversations`)
      );
      await page.getByTestId("chat-input").fill(firstPrompt);
      await page.getByTestId("chat-send-button").click();

      const createPayload = (await (await createConversationResponse).json().catch(() => null)) as {
        conversationId?: string | null;
      } | null;
      const conversationId = createPayload?.conversationId ?? null;
      if (!conversationId) {
        throw new Error(`Conversation create missing conversationId: ${JSON.stringify(createPayload)}`);
      }

      await expect(page.getByTestId("assistant-typing-indicator")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("assistant-setup-indicator")).toHaveCount(0, { timeout: 120_000 });
      await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 180_000 });
      const assistantResponses = nonStatusAssistantBubbles(page);
      await expect(assistantResponses.filter({ hasText: /\b2\b/ }).last()).toBeVisible({
        timeout: 120_000,
      });

      const createdMemberContext = await browser.newContext();
      memberContext = createdMemberContext;
      const createdMemberPage = await createdMemberContext.newPage();
      memberPage = createdMemberPage;
      await loginWithEmailPassword(createdMemberPage, memberEmail, memberPassword);
      const memberCredential = await ensureRealDefaultCodexCredentialWhenRequired(createdMemberPage);
      memberCredentialId = memberCredential?.created
        ? memberCredential.credentialId
        : null;
      await createdMemberPage.goto(
        `/studio?projectId=${encodeURIComponent(projectId)}`,
        { waitUntil: "domcontentloaded" }
      );
      await activateProject(createdMemberPage, projectId, "Multi User Chat Project", { id: orgId, name: orgName });
      await clearRuntimePreference(createdMemberPage, { projectId, source: "multi-user-chat:member" }).catch(() => {});
      await ensureHostedRuntimeReady(createdMemberPage, projectId);
      await ensureProjectCreditsReadyForChat(createdMemberPage, projectId);

      const memberUserBubble = createdMemberPage
        .locator('[data-testid="chat-bubble-user"]')
        .filter({ hasText: /what is 1\+1/i })
        .first();
      await expect(memberUserBubble).toBeVisible({ timeout: 60_000 });
      const memberUserRow = createdMemberPage
        .getByTestId("chat-message-row")
        .filter({ hasText: /what is 1\+1/i })
        .first();
      await expect(memberUserRow.getByTestId("chat-avatar-human")).toBeVisible();
      await expect(createdMemberPage.getByTestId("chat-avatar-assistant").first()).toBeVisible();

      const assistantCountBeforeDecision = await nonStatusAssistantBubbles(createdMemberPage).count();
      let decisionTurnDispatches = 0;
      const countDecisionDispatch = (request: Request) => {
        if (
          request.method() === "POST" &&
          /\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
        ) {
          decisionTurnDispatches += 1;
        }
      };
      createdMemberPage.on("request", countDecisionDispatch);
      const decisionPrompt = `Taylor, do you approve the release? ${Date.now()}`;
      const participationResponsePromise = createdMemberPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/conversations/${conversationId}/participation/resolve`),
      );
      const recordOnlyResponsePromise = createdMemberPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/conversations/${conversationId}/messages/record`),
      );
      await createdMemberPage.getByTestId("chat-input").fill(decisionPrompt);
      await createdMemberPage.getByTestId("chat-send-button").click();

      const participationResponse = await participationResponsePromise;
      expect(participationResponse.ok()).toBeTruthy();
      const participationPayload = (await participationResponse.json()) as {
        decision?: string;
        participantCount?: number;
      };
      expect(participationPayload).toMatchObject({ decision: "silent" });
      expect(participationPayload.participantCount ?? 0).toBeGreaterThanOrEqual(2);
      expect((await recordOnlyResponsePromise).ok()).toBeTruthy();
      await expect(
        page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: decisionPrompt }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(createdMemberPage.getByTestId("assistant-typing-indicator")).toHaveCount(0);
      await createdMemberPage.waitForTimeout(1_000);
      expect(decisionTurnDispatches).toBe(0);
      expect(await nonStatusAssistantBubbles(createdMemberPage).count()).toBe(
        assistantCountBeforeDecision,
      );
      createdMemberPage.off("request", countDecisionDispatch);

      const followUpPrompt = "Now add 3 to the result. Reply with just the number no other text.";
      await createdMemberPage.getByTestId("chat-input").fill(followUpPrompt);
      await expect(createdMemberPage.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
      await createdMemberPage.getByTestId("chat-send-button").click();
      await expect(createdMemberPage.getByTestId("assistant-typing-indicator")).toBeVisible({ timeout: 10_000 });
      await expect(
        nonStatusAssistantBubbles(createdMemberPage).filter({ hasText: /\b5\b/ }).last()
      ).toBeVisible({
        timeout: 180_000,
      });

      // "Chat without AI" is a sender preference, not shared conversation
      // state. The member can suppress their own factual turn while the owner
      // remains AI-enabled in the same chat.
      expect(await disableAssistantIfPossible(createdMemberPage)).toBeTruthy();
      const assistantCountBeforeHumanOnly = await nonStatusAssistantBubbles(
        createdMemberPage,
      ).count();
      let humanOnlyAssistantDispatches = 0;
      const countHumanOnlyAssistantDispatch = (request: Request) => {
        if (
          request.method() === "POST" &&
          /\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
        ) {
          humanOnlyAssistantDispatches += 1;
        }
      };
      createdMemberPage.on("request", countHumanOnlyAssistantDispatch);
      const memberHumanOnlyPrompt = `What is 7+8? Human-only check ${Date.now()}`;
      await createdMemberPage.getByTestId("chat-input").fill(memberHumanOnlyPrompt);
      await createdMemberPage.getByTestId("chat-send-button").click();
      await expect(
        page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: memberHumanOnlyPrompt }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(createdMemberPage.getByTestId("assistant-typing-indicator")).toHaveCount(0);
      await createdMemberPage.waitForTimeout(1_000);
      expect(humanOnlyAssistantDispatches).toBe(0);
      expect(await nonStatusAssistantBubbles(createdMemberPage).count()).toBe(
        assistantCountBeforeHumanOnly,
      );
      createdMemberPage.off("request", countHumanOnlyAssistantDispatch);

      await openRuntimeAiMenu(page);
      await expect(
        page.getByTestId("chat-assistant-toggle").locator('input[role="switch"]'),
      ).toBeChecked();
      await closeRuntimeAiMenu(page);

      const ownerPrompt = "What is 6+7? Reply with just the number.";
      await page.getByTestId("chat-input").fill(ownerPrompt);
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByTestId("assistant-typing-indicator")).toBeVisible({ timeout: 10_000 });
      await expect(
        nonStatusAssistantBubbles(page).filter({ hasText: /\b13\b/ }).last(),
      ).toBeVisible({ timeout: 180_000 });
      await expect(
        nonStatusAssistantBubbles(createdMemberPage).filter({ hasText: /\b13\b/ }).last(),
      ).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      memberFlowError = error;
    } finally {
      if (memberPage && memberCredentialId) {
        try {
          await purgeRealUserCredential(memberPage, memberCredentialId);
        } catch {
          cleanupFailed = true;
        }
      }
      if (memberContext) {
        await memberContext.close().catch(() => {
          cleanupFailed = true;
        });
      }
      try {
        await deleteDisposableSupabaseUser(page, supabaseUrl, supabaseServiceRoleKey, memberUserId);
      } catch {
        cleanupFailed = true;
      }
    }
    if (memberFlowError) {
      if (cleanupFailed) {
        throw new AggregateError(
          [memberFlowError, new Error("Disposable multi-user credential/account cleanup failed.")],
          "Multi-user flow and credential/account cleanup both failed."
        );
      }
      throw memberFlowError;
    }
    if (cleanupFailed) {
      throw new Error("Disposable multi-user credential/account cleanup failed.");
    }
  });
});
