/**
 * Live scenario drive for multiplayer selective AI answering.
 *
 * Owner + invited member share one conversation with a REAL model behind the
 * agent. Drives, in order:
 *   1. baseline ambient factual answer in a fresh group conversation
 *   2. a three-turn human-to-human silent streak (agent declines each turn
 *      via the swallowed NO_RESPONSE — no record-only, no typing, no bubbles)
 *   3. resolver outage -> defer to the authoritative controller dispatch
 *   4. explicit @octo re-engagement after sustained silence
 *   5. incorrect arithmetic -> "correct" decision -> agent corrects
 *   6. human-answer coverage race against an in-flight Octo job
 *
 * Observational drive: deterministic controller behavior is hard-asserted;
 * model-phrasing/race outcomes are logged with loose assertions.
 *
 * Run: pnpm test:e2e tests/playwright/orgs/group-participation-drive.spec.ts
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
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

test.use({ trace: "off" });

type BrowserSupabaseClient = {
  auth?: {
    setSession?: (session: { access_token: string; refresh_token: string }) => Promise<void>;
  };
};

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

async function loginWithEmailPassword(page: Page, email: string, password: string) {
  const supabaseUrl = getSupabaseUrl();
  const anonKey = resolveSupabaseAnonKey();
  const response = await page.context().request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email, password },
    },
  );
  if (!response.ok()) {
    throw new Error(`Supabase login failed (${response.status()}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token: string; refresh_token: string };
  await page.goto("/login", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForFunction(
    () => {
      const client = (window as Window & { __INSTAFY_SUPABASE__?: BrowserSupabaseClient })
        .__INSTAFY_SUPABASE__;
      return !!client?.auth && typeof client.auth.setSession === "function";
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(async ({ access_token, refresh_token }) => {
    const client = (window as Window & { __INSTAFY_SUPABASE__?: BrowserSupabaseClient })
      .__INSTAFY_SUPABASE__;
    if (!client?.auth?.setSession) {
      throw new Error("Supabase client unavailable on window");
    }
    await client.auth.setSession({ access_token, refresh_token });
  }, payload);
  await page.goto("/studio", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page
    .waitForURL((url) => url.pathname.includes("/studio"), { timeout: 30_000 })
    .catch(() => {});
}

type ActivateProjectPayload = {
  projectId: string;
  projectName: string;
  orgId: string | null;
  orgName: string | null;
};

async function activateProject(
  page: Page,
  projectId: string,
  projectName: string,
  org?: { id?: string | null; name?: string | null },
) {
  await page.evaluate(
    (payload: ActivateProjectPayload) => {
      const instafyWindow = window as Window & {
        __INSTAFY_STORE__?: {
          getState?: () => {
            createProject?: (input: ActivateProjectPayload) => void;
            setProjectOrg?: (projectId: string, org: { id: string; name: string }) => void;
            switchProject?: (projectId: string) => void;
          };
        };
        __INSTAFY_ACTIVE_PROJECT_ID__?: string;
        __INSTAFY_PROJECT_INITIALIZED__?: boolean;
      };
      const state = instafyWindow.__INSTAFY_STORE__?.getState?.();
      state?.createProject?.(payload);
      if (payload.orgId) {
        state?.setProjectOrg?.(payload.projectId, {
          id: payload.orgId,
          name: payload.orgName ?? "Organization",
        });
      }
      state?.switchProject?.(payload.projectId);
      instafyWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = payload.projectId;
      instafyWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("projectId", payload.projectId);
        window.history.replaceState(
          window.history.state,
          document.title,
          `${url.pathname}?${url.searchParams.toString()}${url.hash}`,
        );
      } catch {
        // ignore
      }
    },
    { projectId, projectName, orgId: org?.id ?? null, orgName: org?.name ?? null },
  );
}

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });

  // A leftover hosted runtime record can be "ready" but unusable (send button
  // stuck on "Connecting to runtime…"); relaunch a fresh runtime in that case.
  const sendReady = async (timeout: number) => {
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
    // An empty composer legitimately disables send; probe with real text.
    await page.getByTestId("chat-input").fill("readiness probe");
    try {
      await expect
        .poll(
          async () => {
            const sendButton = page.getByTestId("chat-send-button");
            if (await sendButton.isVisible().catch(() => false)) {
              return await sendButton.isEnabled().catch(() => false);
            }
            return false;
          },
          { timeout },
        )
        .toBe(true);
    } finally {
      await page.getByTestId("chat-input").fill("").catch(() => {});
    }
  };
  try {
    await sendReady(60_000);
  } catch {
    await requestHostedRuntime(page, {
      projectId,
      source: "chat",
      existingRuntimeStrategy: "launch-new",
      timeoutMs: 180_000,
    }).catch(() => {});
    await sendReady(90_000);
  }
}

function assistantBubbles(page: Page) {
  return page.locator('[data-testid="chat-bubble-assistant"]');
}

type SilentProbeOutcome = {
  decision: string;
  reason: string;
  recordUsed: boolean;
  dispatchUsed: boolean;
};

/**
 * Send a message that must end with NO visible agent output. The turn
 * DISPATCHES an agent evaluation and the agent declines via a swallowed
 * NO_RESPONSE — no record-only, no typing, no bubble, no artifact.
 */
async function sendExpectingSilence(
  page: Page,
  conversationId: string,
  content: string,
): Promise<SilentProbeOutcome> {
  let dispatchUsed = false;
  let recordUsed = false;
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.method() !== "POST") {
      return;
    }
    const pathname = new URL(request.url()).pathname;
    if (/\/conversations\/[^/]+\/messages$/.test(pathname)) {
      dispatchUsed = true;
    }
    if (/\/conversations\/[^/]+\/messages\/record$/.test(pathname)) {
      recordUsed = true;
    }
  };
  page.on("request", onRequest);
  const participationPromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/conversations/${conversationId}/participation/resolve`),
      { timeout: 20_000 },
    )
    .catch(() => null);

  await page.getByTestId("chat-input").fill(content);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("chat-send-button").click();

  const participationResponse = await participationPromise;
  let decision = "(no resolve call)";
  let reason = "(no resolve call)";
  if (participationResponse) {
    const payload = (await participationResponse.json().catch(() => null)) as {
      decision?: string;
      reason?: string;
    } | null;
    decision = payload?.decision ?? "(unparseable)";
    reason = payload?.reason ?? "(unparseable)";
  }
  await page.waitForTimeout(1_500);
  page.off("request", onRequest);
  return { decision, reason, recordUsed, dispatchUsed };
}

test.describe("Group participation live drive", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Real model required (Codex auth missing/rate limited).",
  );
  test.setTimeout(600_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "group-participation-drive:cleanup" }).catch(
      () => {},
    );
  });

  test("selective answering across silent streaks, outages, corrections, and races", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    const controllerUrl = getControllerUrl();
    const supabaseUrl = getSupabaseUrl();
    const serviceRoleKey = resolveSupabaseServiceRoleKey();
    test.skip(!controllerUrl || !supabaseUrl || !serviceRoleKey, "Local stack required.");

    await clearRuntimePreference(page, { projectId, source: "gp-drive" });
    await ensureHostedRuntimeReady(page, projectId);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const adminHeaders = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    };
    const projectRow = (await (
      await page.context().request.get(
        `${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id,org_id`,
        { headers: adminHeaders },
      )
    ).json()) as Array<{ org_id?: string | null }>;
    const orgId = projectRow?.[0]?.org_id ?? null;
    if (!orgId) {
      throw new Error("Project org_id missing.");
    }

    // ---- Scenario 1: baseline — ambient factual question gets a real answer.
    const firstPrompt = "What is 3+4? Reply with just the number.";
    const createConversationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.ok() &&
        response.url().includes(`/projects/${projectId}/conversations`),
    );
    await page.getByTestId("chat-input").fill(firstPrompt);
    await page.getByTestId("chat-send-button").click();
    const createPayload = (await (await createConversationResponse).json().catch(() => null)) as {
      conversationId?: string | null;
    } | null;
    const conversationId = createPayload?.conversationId ?? null;
    if (!conversationId) {
      throw new Error("conversationId missing from conversation create.");
    }
    await expect(assistantBubbles(page).filter({ hasText: /\b7\b/ }).last()).toBeVisible({
      timeout: 180_000,
    });
    console.log("[drive] scenario 1 OK: ambient factual answered (7)");

    // ---- Member setup (real second human with a display name).
    const memberEmail = `gp-drive-${Date.now()}@instafy.dev`;
    const memberPassword = "GpDrive123!";
    const createMember = await page.context().request.post(`${supabaseUrl}/auth/v1/admin/users`, {
      headers: adminHeaders,
      data: {
        email: memberEmail,
        password: memberPassword,
        email_confirm: true,
        user_metadata: { full_name: "Bob Reviewer" },
      },
    });
    if (!createMember.ok()) {
      throw new Error(`member create failed: ${await createMember.text()}`);
    }
    const memberPayload = (await createMember.json()) as { user?: { id?: string }; id?: string };
    const memberUserId = memberPayload.user?.id ?? memberPayload.id ?? null;

    let memberContext: BrowserContext | null = null;
    let memberCredentialId: string | null = null;
    try {
      const addMember = await page
        .context()
        .request.post(`${controllerUrl}/orgs/${orgId}/members`, {
          headers: {
            authorization: `Bearer ${serviceRoleKey}`,
            "content-type": "application/json",
          },
          data: { email: memberEmail, role: "builder" },
        });
      if (!addMember.ok()) {
        throw new Error(`add member failed: ${await addMember.text()}`);
      }

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await loginWithEmailPassword(memberPage, memberEmail, memberPassword);
      const memberCredential = await ensureRealDefaultCodexCredentialWhenRequired(memberPage);
      memberCredentialId = memberCredential?.created ? memberCredential.credentialId : null;
      await memberPage.goto(`/studio?projectId=${encodeURIComponent(projectId)}`, {
        waitUntil: "domcontentloaded",
      });
      await activateProject(memberPage, projectId, "GP Drive Project", { id: orgId });
      // Let the shared conversation become the active one BEFORE any composer
      // interaction: typing into a not-yet-settled studio can fork a local
      // draft conversation and strand the member outside the shared thread.
      try {
        await expect(
          memberPage.locator('[data-testid="chat-bubble-user"]').filter({ hasText: /3\+4/ }).first(),
        ).toBeVisible({ timeout: 60_000 });
      } catch (error) {
        const url = memberPage.url();
        const userBubbles = await memberPage.locator('[data-testid="chat-bubble-user"]').count();
        const scrollText = await memberPage
          .getByTestId("chat-message-scroll")
          .innerText()
          .catch(() => "(no chat-message-scroll)");
        const tabs = await memberPage
          .locator('[data-testid*="conversation-tab"]')
          .allInnerTexts()
          .catch(() => []);
        console.log(
          `[drive] member history DIAGNOSTIC url=${url} userBubbles=${userBubbles} tabs=${JSON.stringify(tabs)} scroll=${scrollText.slice(0, 500)}`,
        );
        throw error;
      }
      await ensureHostedRuntimeReady(memberPage, projectId);
      await ensureProjectCreditsReadyForChat(memberPage, projectId);
      console.log("[drive] member joined and sees history");

      // ---- Scenario 2: three-turn human-to-human silent streak.
      const ownerAssistantCountBefore = await assistantBubbles(page).count();

      const turn1 = await sendExpectingSilence(
        memberPage,
        conversationId,
        `Taylor, do you approve the release notes? ${Date.now()}`,
      );
      const turn2 = await sendExpectingSilence(
        page,
        conversationId,
        `Bob, I'll review your PR after lunch. ${Date.now()}`,
      );
      const turn3 = await sendExpectingSilence(
        memberPage,
        conversationId,
        `sounds good, ship it then ${Date.now()}`,
      );
      console.log("[drive] silent streak outcomes:", { turn1, turn2, turn3 });
      for (const [label, outcome] of [
        ["turn1", turn1],
        ["turn2", turn2],
        ["turn3", turn3],
      ] as const) {
        // The turn dispatches an agent evaluation and the AGENT declines
        // (swallowed NO_RESPONSE) — silence, never record-only.
        expect(outcome.dispatchUsed, `${label} dispatches an evaluation`).toBe(true);
        expect(outcome.recordUsed, `${label} must not use record-only`).toBe(false);
      }
      // No typing indicator may appear for ambient turns, and the declines
      // must settle with zero new assistant bubbles. Give the agent time to
      // evaluate+decline all three turns on the warm runtime.
      await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0);
      await expect(memberPage.getByTestId("assistant-typing-indicator")).toHaveCount(0);
      // Sample for 75s while the agent evaluates and declines all three
      // turns: typing must never show, bubbles must never grow.
      for (let sample = 0; sample < 15; sample += 1) {
        await memberPage.waitForTimeout(5_000);
        expect(
          await memberPage.getByTestId("assistant-typing-indicator").count(),
          "typing must stay hidden during evaluations",
        ).toBe(0);
        expect(
          await assistantBubbles(page).count(),
          "no assistant bubble may appear for declined turns",
        ).toBe(ownerAssistantCountBefore);
      }
      expect(await assistantBubbles(page).count()).toBe(ownerAssistantCountBefore);
      expect(await assistantBubbles(memberPage).count()).toBe(ownerAssistantCountBefore);
      // Cross-visibility: owner sees the members' human turns.
      await expect(
        page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: /ship it then/ }).last(),
      ).toBeVisible({ timeout: 30_000 });
      console.log(
        "[drive] scenario 2 OK: 3-turn silent streak (agent-declined), no typing, cross-visible",
      );

      // ---- Scenario 3: resolver outage — the turn defers to the authoritative
      // controller gate via the normal dispatch endpoint (doc: "the normal
      // message endpoint remains the authoritative backstop"). Verified live:
      // recordUsed=false, dispatchUsed=true on aborted resolver.
      await memberPage.route("**/participation/resolve", (route) => route.abort());
      const outage = await sendExpectingSilence(
        memberPage,
        conversationId,
        `What is the tallest mountain in the world? ${Date.now()}`,
      );
      await memberPage.unroute("**/participation/resolve");
      console.log("[drive] resolver-outage outcome:", outage);
      expect(outage.dispatchUsed, "outage turn defers to dispatch").toBe(true);
      expect(outage.recordUsed, "outage turn must not use record-only").toBe(false);
      // The controller classifies server-side; settle whichever way it went
      // (respond -> run finishes; silent -> nothing) before the next scenario.
      await memberPage.waitForTimeout(3_000);
      await expect(memberPage.getByTestId("assistant-typing-indicator")).toHaveCount(0, {
        timeout: 180_000,
      });
      const outageAssistantText = (await assistantBubbles(memberPage).count())
        ? await assistantBubbles(memberPage).last().innerText()
        : "(none)";
      console.log(
        `[drive] scenario 3 OK: resolver outage deferred to controller dispatch; last assistant: ${outageAssistantText.slice(0, 120)}`,
      );

      // ---- Scenario 4: explicit @octo re-engages after sustained silence.
      const beforeMention = await assistantBubbles(memberPage).count();
      await memberPage.getByTestId("chat-input").fill("@octo what is 5+6? Reply with just the number.");
      await expect(memberPage.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
      await memberPage.getByTestId("chat-send-button").click();
      await expect(assistantBubbles(memberPage).filter({ hasText: /\b11\b/ }).last()).toBeVisible({
        timeout: 180_000,
      });
      await expect(assistantBubbles(page).filter({ hasText: /\b11\b/ }).last()).toBeVisible({
        timeout: 60_000,
      });
      console.log(
        `[drive] scenario 4 OK: @octo re-engaged after silence (bubbles ${beforeMention} -> ${await assistantBubbles(memberPage).count()})`,
      );

      // ---- Scenario 5: incorrect arithmetic draws a correction.
      let correctionDecision = "(none)";
      const correctionResolve = memberPage
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes(`/conversations/${conversationId}/participation/resolve`),
          { timeout: 20_000 },
        )
        .catch(() => null);
      const correctionBubblesBefore = await assistantBubbles(memberPage).count();
      await memberPage.getByTestId("chat-input").fill("3+3=7");
      await expect(memberPage.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
      await memberPage.getByTestId("chat-send-button").click();
      const correctionResponse = await correctionResolve;
      if (correctionResponse) {
        const payload = (await correctionResponse.json().catch(() => null)) as {
          decision?: string;
          reason?: string;
        } | null;
        correctionDecision = `${payload?.decision}/${payload?.reason}`;
      }
      console.log(`[drive] correction resolve: ${correctionDecision}`);
      expect(correctionDecision.startsWith("correct/"), "correction decision").toBe(true);
      await expect
        .poll(async () => assistantBubbles(memberPage).count(), { timeout: 180_000 })
        .toBeGreaterThan(correctionBubblesBefore);
      const correctionText = await assistantBubbles(memberPage).last().innerText();
      console.log(
        `[drive] scenario 5 OK: agent responded to wrong arithmetic. Reply: ${correctionText.slice(0, 200)}`,
      );

      // ---- Scenario 6: human-answer coverage race against in-flight Octo job.
      const raceBubblesBefore = await assistantBubbles(page).count();
      await page.getByTestId("chat-input").fill("What is 123*45? Reply with just the number.");
      await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId("chat-send-button").click();
      // Ambient questions are silent evaluations now — no typing indicator to
      // wait on. Give the dispatch a moment to create the Octo run, then race
      // the human answer in while that job is still queued/working.
      await page.waitForTimeout(4_000);
      const raceResolve = memberPage
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes(`/conversations/${conversationId}/participation/resolve`),
          { timeout: 20_000 },
        )
        .catch(() => null);
      await memberPage.getByTestId("chat-input").fill("5535");
      await expect(memberPage.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
      await memberPage.getByTestId("chat-send-button").click();
      const raceResponse = await raceResolve;
      let raceResolution: Record<string, unknown> | null = null;
      if (raceResponse) {
        raceResolution = (await raceResponse.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
      }
      console.log("[drive] race resolve payload:", JSON.stringify(raceResolution));
      // Observe the settle: either Octo was cancelled (no new bubble) or Octo
      // finished first (bubble with 5535 and coverage reused). Both are valid;
      // a bare duplicate/confused answer is not.
      await page.waitForTimeout(20_000);
      await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, {
        timeout: 120_000,
      });
      const raceBubblesAfter = await assistantBubbles(page).count();
      const lastAssistantText =
        raceBubblesAfter > 0 ? await assistantBubbles(page).last().innerText() : "(none)";
      console.log(
        `[drive] scenario 6 settle: bubbles ${raceBubblesBefore} -> ${raceBubblesAfter}; last assistant: ${lastAssistantText.slice(0, 200)}`,
      );

      console.log("[drive] ALL SCENARIOS COMPLETE");
    } finally {
      if (memberContext) {
        if (memberCredentialId) {
          const memberPages = memberContext.pages();
          if (memberPages[0]) {
            await purgeRealUserCredential(memberPages[0], memberCredentialId).catch(() => {});
          }
        }
        await memberContext.close().catch(() => {});
      }
      if (memberUserId) {
        await page
          .context()
          .request.delete(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(memberUserId)}`, {
            headers: adminHeaders,
          })
          .catch(() => {});
      }
    }
  });
});
