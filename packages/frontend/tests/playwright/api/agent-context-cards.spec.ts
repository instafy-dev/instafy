import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolvePlaywrightControllerUrl } from "../utils/controllerUrl.js";
import {
  createControllerOrgAndProject,
  ensureRealDefaultCodexCredentialForAccessToken,
} from "../utils/harness.js";

// This API suite uses temporary bearer tokens and the Supabase service role.
// Keep both out of retain-on-failure Playwright trace archives.
test.use({ trace: "off" });

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const CLI_DIR = path.join(REPO_ROOT, "packages", "instafy-cli");
const CLI_ENTRY = path.join(CLI_DIR, "dist", "index.js");
const SKILL_PATH = path.join(
  REPO_ROOT,
  "packages",
  "runtime-agent",
  "assets",
  "instafy",
  ".agents",
  "skills",
  "instafy-agent-collaboration",
  "SKILL.md",
);

let cliBuildPromise: Promise<void> | null = null;

function controllerUrl(): string {
  return resolvePlaywrightControllerUrl(process.env);
}

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

async function createUserSession(request: APIRequestContext): Promise<{
  accessToken: string;
  userId: string;
}> {
  const baseUrl = supabaseUrl();
  const anonKey = supabaseAnonKey();
  const serviceRole = supabaseServiceRoleKey();
  if (!baseUrl || !anonKey || !serviceRole) {
    test.skip(true, "Supabase URL, anon key, and service-role key are required");
  }

  const email = `agent-context+${randomUUID()}@instafy.dev`;
  const password = `Context-${randomUUID()}!aA1`;
  const createResponse = await request.post(`${baseUrl}/auth/v1/admin/users`, {
    headers: {
      apikey: serviceRole,
      authorization: `Bearer ${serviceRole}`,
      "content-type": "application/json",
    },
    data: {
      email,
      password,
      email_confirm: true,
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();

  const tokenResponse = await request.post(`${baseUrl}/auth/v1/token?grant_type=password`, {
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
    },
    data: {
      email,
      password,
    },
  });
  expect(tokenResponse.ok(), await tokenResponse.text()).toBeTruthy();
  const payload = (await tokenResponse.json()) as {
    access_token?: string;
    user?: {
      id?: string;
    };
  };
  const accessToken = payload.access_token?.trim() ?? "";
  const userId = payload.user?.id?.trim() ?? "";
  expect(accessToken).toBeTruthy();
  expect(userId).toBeTruthy();
  return { accessToken, userId };
}

async function deleteUser(request: APIRequestContext, userId: string | null): Promise<void> {
  if (!userId) {
    return;
  }
  const serviceRole = supabaseServiceRoleKey();
  if (!serviceRole) {
    throw new Error("Supabase service role is unavailable for disposable-user cleanup.");
  }
  let response: APIResponse;
  try {
    response = await request.delete(
      `${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
      },
      },
    );
  } catch (error) {
    throw new Error(
      `Disposable-user cleanup request failed (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Disposable-user cleanup returned HTTP ${response.status()}.`);
  }
}

async function createAgent(
  request: APIRequestContext,
  input: {
    controller: string;
    accessToken: string;
    handle: string;
    displayName: string;
  },
): Promise<{ id: string; handle: string }> {
  const response = await request.post(`${input.controller}/me/agents`, {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    data: {
      handle: input.handle,
      displayName: input.displayName,
      provider: "assistant",
      model: "gpt-5.5",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as { id?: string; handle?: string };
  expect(payload.id).toBeTruthy();
  expect(payload.handle).toBe(input.handle);
  return { id: payload.id as string, handle: payload.handle as string };
}

async function runInstafyCliJson<T>(
  args: string[],
  env: Record<string, string>,
): Promise<T> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  cliBuildPromise ??= execFileAsync(command, ["-C", CLI_DIR, "build"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  }).then(() => undefined);
  await cliBuildPromise;

  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_ENTRY, ...args],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...env,
        NO_COLOR: "1",
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as T;
}

async function fetchConversationMessages(
  request: APIRequestContext,
  input: {
    controller: string;
    accessToken: string;
    conversationId: string;
  },
): Promise<Array<{ role?: string; content?: string }>> {
  const response = await request.get(
    `${input.controller}/conversations/${encodeURIComponent(input.conversationId)}/messages?limit=100`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
      },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  return payload.messages ?? [];
}

async function interruptConversationRuns(
  request: APIRequestContext,
  input: {
    controller: string;
    accessToken: string;
    conversationId: string;
  },
): Promise<{ canceledRunIds: string[]; canceledJobIds: string[] }> {
  const response = await request.post(
    `${input.controller}/conversations/${encodeURIComponent(input.conversationId)}/interrupt`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      data: {
        reason: "Playwright no-wait dispatch cleanup",
      },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    canceledRunIds?: string[];
    canceledJobIds?: string[];
  };
  return {
    canceledRunIds: payload.canceledRunIds ?? [],
    canceledJobIds: payload.canceledJobIds ?? [],
  };
}

async function fetchConversationRunStatus(
  request: APIRequestContext,
  input: {
    controller: string;
    accessToken: string;
    conversationId: string;
    runId: string;
  },
): Promise<string | null> {
  const response = await request.get(
    `${input.controller}/conversations/${encodeURIComponent(input.conversationId)}/runs?limit=100`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
      },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as Array<{ id?: string; status?: string }>;
  const run = payload.find((candidate) => candidate.id === input.runId);
  return run?.status?.trim().toLowerCase() ?? null;
}

test.describe("Agent context cards", () => {
  test("agents can discover scoped context cards through the Instafy CLI", async ({
    request,
  }) => {
    const controller = controllerUrl();
    if (!controller) {
      test.skip(true, "controller URL is required");
    }

    let projectId: string | null = null;
    let accessToken: string | null = null;
    let userId: string | null = null;

    try {
      const session = await createUserSession(request);
      accessToken = session.accessToken;
      userId = session.userId;

      const created = await createControllerOrgAndProject(request, {
        controllerUrl: controller,
        accessToken,
        orgName: "Playwright Agent Context Cards",
        projectType: "customer",
      });
      projectId = created.projectId;

      const atlas = await createAgent(request, {
        controller,
        accessToken,
        handle: "atlas",
        displayName: "Atlas",
      });
      await createAgent(request, {
        controller,
        accessToken,
        handle: "scribe",
        displayName: "Scribe",
      });

      const conversationId = `conv-${randomUUID()}`;
      const contextResponse = await request.post(
        `${controller}/projects/${encodeURIComponent(projectId)}/agent-contexts`,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          data: {
            agentId: atlas.id,
            scopeKind: "conversation",
            scopeId: conversationId,
            title: "Family memory",
            context: "The user said their uncle is named Tom.",
          },
        },
      );
      expect(contextResponse.ok(), await contextResponse.text()).toBeTruthy();

      const cards = await runInstafyCliJson<
        Array<{
          agent?: { handle?: string };
          scopeKind?: string;
          scopeId?: string;
          context?: string;
          title?: string | null;
        }>
      >(
        [
          "agents",
          "context",
          "list",
          "--space",
          projectId,
          "--agent",
          "@atlas",
          "--query",
          "uncle",
          "--json",
          "--server-url",
          controller,
        ],
        {
          INSTAFY_SPACE_ID: projectId,
          INSTAFY_SERVER_URL: controller,
          INSTAFY_ACCESS_TOKEN: accessToken,
        },
      );

      expect(cards).toHaveLength(1);
      expect(cards[0]?.agent?.handle).toBe("atlas");
      expect(cards[0]?.scopeKind).toBe("conversation");
      expect(cards[0]?.scopeId).toBe(conversationId);
      expect(cards[0]?.context).toContain("uncle is named Tom");

      const skillText = fs.readFileSync(SKILL_PATH, "utf8");
      expect(skillText).toContain("instafy agents context list --json --query");
      expect(skillText).toContain("instafy agents context put --agent");
      expect(skillText).toContain("newest 200 context cards");
      expect(skillText).toContain("scopeKind` + `scopeId");
      expect(skillText).toContain("project-specific host IO observations");
      expect(skillText).toContain("--scope-kind project");
    } finally {
      if (projectId && accessToken) {
        await request
          .delete(`${controller}/projects/${encodeURIComponent(projectId)}`, {
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
          })
          .catch(() => {});
      }
      await deleteUser(request, userId);
    }
  });
});

test.describe("Conversation-native agent coordination", () => {
  test("agents coordinate through linked threads and normal @agent messages", async ({
    request,
  }) => {
    const controller = controllerUrl();
    if (!controller) {
      test.skip(true, "controller URL is required");
    }

    let projectId: string | null = null;
    let accessToken: string | null = null;
    let userId: string | null = null;
    let dispatchedConversationId: string | null = null;
    let dispatchCanceled = false;

    try {
      const session = await createUserSession(request);
      accessToken = session.accessToken;
      userId = session.userId;

      const credential = await ensureRealDefaultCodexCredentialForAccessToken(
        controller,
        accessToken,
      );
      expect(credential.kind).toBe("codex_auth_json");
      expect(credential.isDefault).toBe(true);

      const created = await createControllerOrgAndProject(request, {
        controllerUrl: controller,
        accessToken,
        orgName: "Playwright Conversation Native Coordination",
        projectType: "customer",
      });
      projectId = created.projectId;

      await createAgent(request, {
        controller,
        accessToken,
        handle: "atlas",
        displayName: "Atlas",
      });

      const cliEnv = {
        INSTAFY_SPACE_ID: projectId,
        INSTAFY_SERVER_URL: controller,
        INSTAFY_ACCESS_TOKEN: accessToken,
      };

      const parent = await runInstafyCliJson<{
        conversationId?: string;
        title?: string | null;
      }>(
        [
          "conversation",
          "create",
          "--space",
          projectId,
          "--title",
          "Main coordination smoke",
          "--json",
          "--server-url",
          controller,
        ],
        cliEnv,
      );
      const parentConversationId = parent.conversationId?.trim() ?? "";
      expect(parentConversationId).toBeTruthy();

      const child = await runInstafyCliJson<{
        conversationId?: string;
        parentConversationId?: string | null;
        threadKind?: string | null;
        title?: string | null;
      }>(
        [
          "conversation",
          "create",
          "--space",
          projectId,
          "--parent",
          parentConversationId,
          "--thread-kind",
          "agent",
          "--title",
          "Atlas coordination smoke",
          "--json",
          "--server-url",
          controller,
        ],
        cliEnv,
      );
      const childConversationId = child.conversationId?.trim() ?? "";
      expect(childConversationId).toBeTruthy();
      dispatchedConversationId = childConversationId;
      expect(child.parentConversationId).toBe(parentConversationId);
      expect(child.threadKind).toBe("agent");
      expect(child.title).toBe("Atlas coordination smoke");

      const coordinationPrompt =
        "@atlas Please keep this coordination thread concise. Reply later with token conversation-native-smoke if needed.";
      const dispatch = await runInstafyCliJson<{
        conversationId?: string;
        runId?: string | null;
        status?: string | null;
      }>(
        [
          "chat",
          coordinationPrompt,
          "--conversation",
          childConversationId,
          "--no-wait",
          "--json",
          "--server-url",
          controller,
        ],
        {
          ...cliEnv,
          INSTAFY_CONVERSATION_ID: childConversationId,
        },
      );
      expect(dispatch.conversationId).toBe(childConversationId);
      expect(dispatch.runId).toBeTruthy();

      const parentBeforeReport = await fetchConversationMessages(request, {
        controller,
        accessToken,
        conversationId: parentConversationId,
      });
      expect(parentBeforeReport).toHaveLength(0);

      const childMessages = await fetchConversationMessages(request, {
        controller,
        accessToken,
        conversationId: childConversationId,
      });
      expect(childMessages.some((message) => message.content === coordinationPrompt)).toBe(true);

      const refMessage =
        `I asked Atlas in [[thread:${childConversationId}|Atlas coordination smoke]].`;
      const recordResponse = await request.post(
        `${controller}/conversations/${encodeURIComponent(parentConversationId)}/messages/record`,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          data: {
            role: "assistant",
            content: refMessage,
            metadata: {
              source: "conversation-native-coordination-smoke",
            },
          },
        },
      );
      expect(recordResponse.ok(), await recordResponse.text()).toBeTruthy();

      const parentAfterReport = await fetchConversationMessages(request, {
        controller,
        accessToken,
        conversationId: parentConversationId,
      });
      expect(parentAfterReport).toHaveLength(1);
      expect(parentAfterReport[0]?.content).toBe(refMessage);
      expect(parentAfterReport[0]?.content).not.toContain("conversation-native-smoke");

      const skillText = fs.readFileSync(SKILL_PATH, "utf8");
      expect(skillText).toContain("conversation-native lookup first");
      expect(skillText).toContain("instafy conversation create --parent");
      expect(skillText).toContain("instafy chat --conversation <threadId>");
      expect(skillText).toContain("optional bounded hints/cache");

      const cancellation = await interruptConversationRuns(request, {
        controller,
        accessToken,
        conversationId: childConversationId,
      });
      if (cancellation.canceledJobIds.length > 0) {
        expect(cancellation.canceledRunIds).toContain(dispatch.runId);
      }
      await expect
        .poll(
          () =>
            fetchConversationRunStatus(request, {
              controller,
              accessToken,
              conversationId: childConversationId,
              runId: dispatch.runId as string,
            }),
          { timeout: 15_000 },
        )
        .toMatch(/^(canceled|cancelled|completed|failed)$/);
      dispatchCanceled = true;
    } finally {
      if (!dispatchCanceled && dispatchedConversationId && accessToken) {
        await interruptConversationRuns(request, {
          controller,
          accessToken,
          conversationId: dispatchedConversationId,
        }).catch(() => {});
      }
      if (projectId && accessToken) {
        await request
          .delete(`${controller}/projects/${encodeURIComponent(projectId)}`, {
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
          })
          .catch(() => {});
      }
      await deleteUser(request, userId);
    }
  });
});
