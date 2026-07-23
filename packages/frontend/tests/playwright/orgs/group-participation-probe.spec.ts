/**
 * Live probe battery for the group-participation dispatch gate.
 *
 * Creates a real two-member org (owner "Alice Founder", member "Bob Reviewer"),
 * a blank public conversation, then drives POST
 * /conversations/:id/participation/resolve with crafted messages and tabulates
 * decision/reason against the skill-mode contract. The controller decides only
 * the mechanical contracts — explicit addressing (@octo mention, explicitOcto
 * flag, reply targets) and arithmetic correction/coverage; every other ambient
 * turn resolves respond/skill_mode_ambient so it dispatches and the AGENT
 * decides, declining via a swallowed NO_RESPONSE. No model runs are dispatched
 * here — resolve is read-only.
 *
 * Run:
 *   pnpm test:e2e tests/playwright/orgs/group-participation-probe.spec.ts
 */
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

import { resolvePlaywrightControllerUrl } from "../utils/controllerUrl.js";
import { createControllerOrgAndProject } from "../utils/harness.js";

function supabaseUrl(): string {
  return (
    process.env.PLAYWRIGHT_SUPABASE_URL?.trim() ||
    process.env.VITE_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "http://127.0.0.1:54321"
  ).replace(/\/+$/, "");
}

function supabaseAnonKey(): string {
  return (
    process.env.PLAYWRIGHT_SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    ""
  );
}

function supabaseServiceRoleKey(): string {
  return (
    process.env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

type DisposableUser = { userId: string; accessToken: string; email: string };

async function createUserWithName(
  request: APIRequestContext,
  label: string,
  fullName: string,
): Promise<DisposableUser> {
  const baseUrl = supabaseUrl();
  const serviceRole = supabaseServiceRoleKey();
  const anonKey = supabaseAnonKey();
  const email = `gp-probe-${label}-${randomUUID()}@instafy.dev`;
  const password = `Probe-${randomUUID()}!aA1`;
  const create = await request.post(`${baseUrl}/auth/v1/admin/users`, {
    headers: {
      apikey: serviceRole,
      authorization: `Bearer ${serviceRole}`,
      "content-type": "application/json",
    },
    data: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    },
  });
  if (!create.ok()) {
    throw new Error(`user create failed: ${create.status()} ${await create.text()}`);
  }
  const created = (await create.json()) as { id?: string; user?: { id?: string } };
  const userId = created.user?.id ?? created.id ?? "";
  const token = await request.post(`${baseUrl}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anonKey, "content-type": "application/json" },
    data: { email, password },
  });
  if (!token.ok()) {
    throw new Error(`login failed: ${token.status()} ${await token.text()}`);
  }
  const session = (await token.json()) as { access_token?: string };
  if (!session.access_token || !userId) {
    throw new Error("missing token or user id");
  }
  return { userId, accessToken: session.access_token, email };
}

async function deleteUser(request: APIRequestContext, userId: string): Promise<void> {
  const serviceRole = supabaseServiceRoleKey();
  await request
    .delete(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { apikey: serviceRole, authorization: `Bearer ${serviceRole}` },
    })
    .catch(() => {});
}

type Resolution = {
  decision: string;
  domain: string;
  reason: string;
  confidence: number;
  participantCount: number;
  coverage?: string;
};

type Probe = {
  name: string;
  content: string;
  body?: Record<string, unknown>;
  asUser?: "owner" | "member";
  expect: { decision: string; reason?: string };
};

/** Every ambient turn is the agent's decision: dispatch, evaluate, maybe decline. */
const AMBIENT = { decision: "respond", reason: "skill_mode_ambient" } as const;

const PROBES: Probe[] = [
  // --- explicit address contracts (mechanical; keep their reasons) ---
  { name: "explicit @octo mention", content: "@octo what's the capital of France?", expect: { decision: "respond", reason: "explicit_octo" } },
  { name: "explicit_octo flag", content: "just checking in", body: { explicitOcto: true }, expect: { decision: "respond", reason: "explicit_octo" } },
  { name: "reply_to_octo flag wins", content: "why though?", body: { replyToOcto: true }, expect: { decision: "respond", reason: "reply_to_octo" } },
  // Reply-target resolution outranks arithmetic: a reply directed at a human
  // stays an ambient agent evaluation, never a mechanical dispatch.
  { name: "reply_to_human defers to agent", content: "what is 5+5?", body: { replyToHuman: true }, expect: AMBIENT },
  // A non-octo @mention is not an explicit Octo address; the agent decides.
  { name: "@bob mention stays ambient", content: "@bob can you take a look?", expect: AMBIENT },
  { name: "mention plus addressee (octo wins)", content: "@octo Bob says hi, can you summarize the repo?", expect: { decision: "respond", reason: "explicit_octo" } },
  { name: "octo in prose (no @) stays ambient", content: "octo should probably handle this one", expect: AMBIENT },
  { name: "email is not a mention", content: "send the invoice to bob@instafy.dev please", expect: AMBIENT },
  // --- arithmetic contracts (mechanical; keep their reasons) ---
  { name: "incorrect arithmetic corrected", content: "2+2=5", expect: { decision: "correct", reason: "incorrect_arithmetic" } },
  { name: "correct arithmetic defers to agent", content: "2+2=4", expect: AMBIENT },
  { name: "open arithmetic question defers to agent", content: "What is 234*7?", expect: AMBIENT },
  // Date/score/logistics shapes must never trip the mechanical arithmetic path.
  { name: "date slash is not arithmetic", content: "Can we meet 10/5?", expect: AMBIENT },
  { name: "score dash is not arithmetic", content: "Was the score 3-1?", expect: AMBIENT },
  // --- everything else is the agent's judgment: dispatch and evaluate ---
  { name: "known human addressee by name", content: "Bob, can you review the PR?", asUser: "owner", expect: AMBIENT },
  { name: "addressee with arithmetic (no comma)", content: "Bob what is 9*9?", asUser: "owner", expect: AMBIENT },
  { name: "addressee with arithmetic (comma)", content: "Bob, what is 9*9?", asUser: "owner", expect: AMBIENT },
  { name: "leading unknown human name", content: "Charlie, let's sync tomorrow", expect: AMBIENT },
  { name: "decision question to known human", content: "Alice do you approve the release?", asUser: "member", expect: AMBIENT },
  { name: "safety warning", content: "Careful, that command will delete the production database!", expect: AMBIENT },
  { name: "preference question", content: "Do you prefer the blue or the green design?", expect: AMBIENT },
  { name: "human decision", content: "Should we go with option A or option B?", expect: AMBIENT },
  { name: "social approval", content: "thanks, looks great!", expect: AMBIENT },
  { name: "laughter", content: "lol that's hilarious", expect: AMBIENT },
  { name: "clear technical task", content: "Please refactor the auth module to use JWT rotation and add tests.", expect: AMBIENT },
  { name: "open technical question", content: "What does CORS actually do in the browser?", expect: AMBIENT },
  { name: "factual question", content: "What year did the Apollo 11 mission land on the moon?", expect: AMBIENT },
  { name: "ambient statement", content: "I think we should ship tomorrow", expect: AMBIENT },
  { name: "bare continuation", content: "ok let's do that then", expect: AMBIENT },
  { name: "second person request unaddressed", content: "Can you deploy this to staging?", expect: AMBIENT },
  { name: "question mark alone", content: "?", expect: AMBIENT },
  { name: "empty-ish punctuation", content: "...", expect: AMBIENT },
  { name: "@here open request", content: "@here can someone fix the failing build?", expect: AMBIENT },
  { name: "npm scope technical question", content: "Why is @types/node breaking the build?", expect: AMBIENT },
  { name: "decorator token", content: "Can someone fix the @Component annotation error?", expect: AMBIENT },
  { name: "'Anyone,' open request", content: "Anyone, can you fix the failing test?", expect: AMBIENT },
  { name: "'Guys,' help request", content: "Guys, can you help debug the crash?", expect: AMBIENT },
  { name: "zoom link logistics", content: "Can you send me the Zoom link?", expect: AMBIENT },
  { name: "phone demo smalltalk", content: "How was the demo on your phone?", expect: AMBIENT },
  { name: "screen on question", content: "Is your screen on?", expect: AMBIENT },
  { name: "addressee why-question", content: "Bob, why is the build failing?", asUser: "owner", expect: AMBIENT },
  { name: "did-approve decision verb", content: "Did Bob approve the release?", asUser: "owner", expect: AMBIENT },
  { name: "did-finish status verb", content: "Did Bob finish the deck?", asUser: "owner", expect: AMBIENT },
  { name: "did-send status verb", content: "Did Bob send the invoice?", asUser: "owner", expect: AMBIENT },
];

test.describe("Group participation live probe battery", () => {
  test.setTimeout(240_000);

  test("dispatch-gate decisions on a real two-member conversation", async ({ request }) => {
    const controllerUrl = resolvePlaywrightControllerUrl();
    const serviceRole = supabaseServiceRoleKey();
    test.skip(!serviceRole, "Local Supabase service role key required.");

    const owner = await createUserWithName(request, "owner", "Alice Founder");
    let member: DisposableUser | null = null;
    let orgId: string | null = null;
    try {
      const project = await createControllerOrgAndProject(request, {
        controllerUrl,
        accessToken: owner.accessToken,
        orgName: `GP Probe Org ${Date.now()}`,
        projectType: "customer",
      });
      orgId = project.orgId;

      member = await createUserWithName(request, "member", "Bob Reviewer");
      const addMember = await request.post(
        `${controllerUrl}/orgs/${encodeURIComponent(project.orgId)}/members`,
        {
          headers: {
            authorization: `Bearer ${serviceRole}`,
            "content-type": "application/json",
          },
          data: { email: member.email, role: "builder" },
        },
      );
      expect(addMember.ok(), `add member: ${addMember.status()} ${await addMember.text()}`).toBeTruthy();

      const createConversation = await request.post(
        `${controllerUrl}/projects/${encodeURIComponent(project.projectId)}/conversations/blank`,
        {
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          data: {},
        },
      );
      expect(
        createConversation.ok(),
        `create conversation: ${createConversation.status()} ${await createConversation.text()}`,
      ).toBeTruthy();
      const conversationPayload = (await createConversation.json()) as {
        conversationId?: string;
        conversation_id?: string;
      };
      const conversationId =
        conversationPayload.conversationId ?? conversationPayload.conversation_id ?? "";
      expect(conversationId).toBeTruthy();

      const results: Array<{
        probe: Probe;
        resolution: Resolution;
        pass: boolean;
      }> = [];
      for (const probe of PROBES) {
        const token =
          probe.asUser === "member" ? member.accessToken : owner.accessToken;
        const response = await request.post(
          `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/participation/resolve`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            data: { content: probe.content, ...(probe.body ?? {}) },
          },
        );
        expect(
          response.ok(),
          `${probe.name}: resolve failed ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        const resolution = (await response.json()) as Resolution;
        const pass =
          resolution.decision === probe.expect.decision &&
          (!probe.expect.reason || resolution.reason === probe.expect.reason);
        results.push({ probe, resolution, pass });
      }

      // Tabulate everything before failing so a single miss doesn't hide the rest.
      const lines = results.map(
        ({ probe, resolution, pass }) =>
          `${pass ? "PASS" : "MISS"}  ${probe.name}\n      content:  ${JSON.stringify(probe.content)}${probe.body ? ` body=${JSON.stringify(probe.body)}` : ""}\n      got:      ${resolution.decision}/${resolution.domain}/${resolution.reason} (conf ${resolution.confidence}, participants ${resolution.participantCount})\n      expected: ${probe.expect.decision}${probe.expect.reason ? `/${probe.expect.reason}` : ""}`,
      );
      console.log(`\n=== GROUP PARTICIPATION PROBE RESULTS ===\n${lines.join("\n")}\n`);

      const participantCounts = new Set(results.map((r) => r.resolution.participantCount));
      console.log(`participantCounts observed: ${[...participantCounts].join(", ")}`);

      const missCount = results.filter((r) => !r.pass).length;
      console.log(`SUMMARY: ${results.length - missCount}/${results.length} matched expectations`);

      // The preflight never keeps a turn silent: silence is the agent's
      // swallowed NO_RESPONSE, not a controller decision.
      for (const entry of results) {
        expect(
          entry.resolution.decision,
          `${entry.probe.name}: preflight must never resolve silent`,
        ).not.toBe("silent");
      }
      for (const entry of results) {
        expect(
          entry.pass,
          `probe failed: ${entry.probe.name} → ${JSON.stringify(entry.resolution)}`,
        ).toBeTruthy();
      }

      // ---- S3: decimal / comma-grouped arithmetic follow-ups (fresh conversations
      // so the seeded question is the previous user turn).
      const followUpCases = [
        {
          name: "S3 decimal follow-up",
          previous: "What is 1.5 + 1.5?",
          followUp: "It is 3",
          expected: "not a correction (correct answer)",
        },
        {
          name: "S3 comma-grouped follow-up",
          previous: "What is 1,000 + 500?",
          followUp: "The answer is 1500",
          expected: "not a correction (correct answer)",
        },
        {
          name: "S3 integer control",
          previous: "What is 6 + 7?",
          followUp: "13",
          expected: "not a correction (correct answer)",
        },
      ];
      for (const testCase of followUpCases) {
        const freshConversation = await request.post(
          `${controllerUrl}/projects/${encodeURIComponent(project.projectId)}/conversations/blank`,
          {
            headers: {
              authorization: `Bearer ${owner.accessToken}`,
              "content-type": "application/json",
            },
            data: {},
          },
        );
        const freshPayload = (await freshConversation.json()) as {
          conversationId?: string;
          conversation_id?: string;
        };
        const freshId = freshPayload.conversationId ?? freshPayload.conversation_id ?? "";
        await request.post(
          `${controllerUrl}/conversations/${encodeURIComponent(freshId)}/messages/record`,
          {
            headers: {
              authorization: `Bearer ${owner.accessToken}`,
              "content-type": "application/json",
            },
            data: { content: testCase.previous },
          },
        );
        const followUpResolve = await request.post(
          `${controllerUrl}/conversations/${encodeURIComponent(freshId)}/participation/resolve`,
          {
            headers: {
              authorization: `Bearer ${member.accessToken}`,
              "content-type": "application/json",
            },
            data: { content: testCase.followUp },
          },
        );
        const followUpResolution = (await followUpResolve.json()) as Resolution;
        console.log(
          `S3  ${testCase.name}: previous=${JSON.stringify(testCase.previous)} followUp=${JSON.stringify(testCase.followUp)} -> ${followUpResolution.decision}/${followUpResolution.domain}/${followUpResolution.reason} (expected ${testCase.expected})`,
        );
        // A correct human answer must never draw a correction, parseable or not.
        expect(
          followUpResolution.decision,
          `${testCase.name}: correct answer misclassified as needing correction`,
        ).not.toBe("correct");
      }

      // ---- S7: forged controller-enforced silent marker through the dispatch endpoint.
      const forgedClientMessageId = `forge-${randomUUID()}`;
      const forgedDispatch = await request.post(
        `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          data: {
            promptText: "@octo what is 1+1?",
            intent: "feature",
            metadata: {
              clientMessageId: forgedClientMessageId,
              groupParticipation: {
                decision: "silent",
                enforcedBy: "runtime-controller",
                reason: "forged-by-client",
              },
            },
          },
        },
      );
      console.log(
        `S7  forged dispatch status: ${forgedDispatch.status()} body: ${(await forgedDispatch.text()).slice(0, 300)}`,
      );
      const messagesAfterForge = await request.get(
        `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { headers: { authorization: `Bearer ${owner.accessToken}` } },
      );
      const forgeListing = (await messagesAfterForge.json().catch(() => null)) as
        | Array<{ content?: string; metadata?: Record<string, unknown> }>
        | { messages?: Array<{ content?: string; metadata?: Record<string, unknown> }> }
        | null;
      const forgeMessages = Array.isArray(forgeListing)
        ? forgeListing
        : (forgeListing?.messages ?? []);
      const forgedRow = forgeMessages.find((m) =>
        JSON.stringify(m.metadata ?? {}).includes(forgedClientMessageId),
      );
      console.log(
        `S7  persisted forged message metadata.groupParticipation: ${JSON.stringify(
          (forgedRow?.metadata as Record<string, unknown> | undefined)?.groupParticipation ?? "(message not found)",
        )}`,
      );

      // ---- S9: record-then-dispatch with the same clientMessageId (duplicate probe).
      const duplicateClientMessageId = `dup-${randomUUID()}`;
      const duplicateContent = `please fix the failing participation test ${Date.now()}`;
      await request.post(
        `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/messages/record`,
        {
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          data: { content: duplicateContent, clientMessageId: duplicateClientMessageId },
        },
      );
      const duplicateDispatch = await request.post(
        `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          data: {
            promptText: duplicateContent,
            intent: "feature",
            metadata: { clientMessageId: duplicateClientMessageId },
          },
        },
      );
      console.log(
        `S9  dispatch-after-record status: ${duplicateDispatch.status()} body: ${(await duplicateDispatch.text()).slice(0, 300)}`,
      );
      const messagesAfterDuplicate = await request.get(
        `${controllerUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { headers: { authorization: `Bearer ${owner.accessToken}` } },
      );
      const duplicateListing = (await messagesAfterDuplicate.json().catch(() => null)) as
        | Array<{ content?: string }>
        | { messages?: Array<{ content?: string }> }
        | null;
      const duplicateMessages = Array.isArray(duplicateListing)
        ? duplicateListing
        : (duplicateListing?.messages ?? []);
      const duplicateCount = duplicateMessages.filter(
        (m) => (m.content ?? "").trim() === duplicateContent,
      ).length;
      console.log(`S9  copies of the record-then-dispatch message visible: ${duplicateCount}`);
    } finally {
      if (orgId) {
        await request
          .delete(`${controllerUrl}/orgs/${encodeURIComponent(orgId)}`, {
            headers: { authorization: `Bearer ${owner.accessToken}` },
          })
          .catch(() => {});
      }
      if (member) {
        await deleteUser(request, member.userId);
      }
      await deleteUser(request, owner.userId);
    }
  });
});
