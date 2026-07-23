import { randomUUID } from "node:crypto";

import {
  test as base,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";

import { resolvePlaywrightControllerUrl } from "./controllerUrl.js";
import {
  createControllerOrgAndProject,
  ensureRealDefaultCodexCredentialForAccessToken,
} from "./harness.js";

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

export function hasPrivateRuntimeOwnerPrerequisites(): boolean {
  return Boolean(
    supabaseUrl() && supabaseAnonKey() && supabaseServiceRoleKey(),
  );
}

async function responseError(response: APIResponse): Promise<string> {
  const body = await response.text().catch(() => "");
  return `${response.status()} ${response.statusText()}${body ? `: ${body}` : ""}`;
}

async function createDisposableOwner(
  request: APIRequestContext,
  label: string,
): Promise<{
  accessToken: string;
  userId: string;
}> {
  const baseUrl = supabaseUrl();
  const anonKey = supabaseAnonKey();
  const serviceRole = supabaseServiceRoleKey();
  if (!baseUrl || !anonKey || !serviceRole) {
    throw new Error(
      "Disposable private-runtime owner requires local Supabase credentials.",
    );
  }

  const email = `private-runtime-${label}-${randomUUID()}@instafy.dev`;
  const password = `Private-${randomUUID()}!aA1`;
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
  if (!createResponse.ok()) {
    throw new Error(
      `Disposable owner creation failed (${await responseError(createResponse)}).`,
    );
  }

  const created = (await createResponse.json()) as {
    id?: unknown;
    user?: { id?: unknown };
  };
  const createdUserId =
    typeof (created.user?.id ?? created.id) === "string"
      ? ((created.user?.id ?? created.id) as string).trim()
      : "";

  const tokenResponse = await request.post(
    `${baseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
      },
      data: { email, password },
    },
  );
  if (!tokenResponse.ok()) {
    throw new Error(
      `Disposable owner login failed (${await responseError(tokenResponse)}).`,
    );
  }
  const session = (await tokenResponse.json()) as {
    access_token?: unknown;
    user?: { id?: unknown };
  };
  const accessToken =
    typeof session.access_token === "string" ? session.access_token.trim() : "";
  const sessionUserId =
    typeof session.user?.id === "string" ? session.user.id.trim() : "";
  const userId = sessionUserId || createdUserId;
  if (!accessToken || !userId) {
    throw new Error(
      "Disposable owner login did not return an access token and user id.",
    );
  }
  if (createdUserId && sessionUserId && createdUserId !== sessionUserId) {
    throw new Error(
      "Disposable owner login returned a different user identity.",
    );
  }
  return { accessToken, userId };
}

async function deleteDisposableOwner(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const serviceRole = supabaseServiceRoleKey();
  if (!serviceRole) {
    return;
  }
  const response = await request.delete(
    `${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
      },
    },
  );
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `Disposable owner cleanup failed (${await responseError(response)}).`,
    );
  }
}

export type PrivateRuntimeOwnerProject = {
  controllerUrl: string;
  accessToken: string;
  userId: string;
  orgId: string;
  projectId: string;
  connectCodex: () => Promise<void>;
};

async function provisionPrivateRuntimeOwnerProject(
  request: APIRequestContext,
  input: {
    controllerUrl: string;
    orgName: string;
    projectType?: string;
    label: string;
  },
): Promise<PrivateRuntimeOwnerProject> {
  const owner = await createDisposableOwner(request, input.label);
  try {
    const project = await createControllerOrgAndProject(request, {
      controllerUrl: input.controllerUrl,
      accessToken: owner.accessToken,
      orgName: input.orgName,
      projectType: input.projectType ?? "customer",
    });
    let codexConnection: Promise<void> | null = null;
    return {
      ...owner,
      controllerUrl: input.controllerUrl,
      orgId: project.orgId,
      projectId: project.projectId,
      connectCodex: () => {
        codexConnection ??= ensureRealDefaultCodexCredentialForAccessToken(
          input.controllerUrl,
          owner.accessToken,
        ).then((credential) => {
          if (credential.kind !== "codex_auth_json" || !credential.isDefault) {
            throw new Error(
              "Disposable runtime owner did not receive the local Codex subscription.",
            );
          }
        });
        return codexConnection;
      },
    };
  } catch (error) {
    await deleteDisposableOwner(request, owner.userId).catch(() => {});
    throw error;
  }
}

async function cleanupPrivateRuntimeOwnerProject(
  request: APIRequestContext,
  context: PrivateRuntimeOwnerProject,
): Promise<void> {
  const response = await request
    .delete(`${context.controllerUrl}/orgs/${encodeURIComponent(context.orgId)}`, {
      headers: { authorization: `Bearer ${context.accessToken}` },
    })
    .catch(() => null);
  if (response && !response.ok() && response.status() !== 404) {
    console.warn(
      `Private-runtime test org cleanup failed (${await responseError(response)}).`,
    );
  }
  await deleteDisposableOwner(request, context.userId);
}

export async function withPrivateRuntimeOwnerProject<T>(
  request: APIRequestContext,
  input: {
    controllerUrl: string;
    orgName: string;
    projectType?: string;
    label: string;
    connectCodex?: boolean;
  },
  run: (context: PrivateRuntimeOwnerProject) => Promise<T>,
): Promise<T> {
  const context = await provisionPrivateRuntimeOwnerProject(request, input);
  try {
    if (input.connectCodex) {
      await context.connectCodex();
    }
    return await run(context);
  } finally {
    await cleanupPrivateRuntimeOwnerProject(request, context);
  }
}

export const privateRuntimeTest = base.extend<{
  privateRuntimeOwnerProject: PrivateRuntimeOwnerProject;
}>({
  privateRuntimeOwnerProject: async ({ request }, use, testInfo) => {
    const controllerUrl = resolvePlaywrightControllerUrl(process.env);
    if (!controllerUrl || !hasPrivateRuntimeOwnerPrerequisites()) {
      testInfo.skip(
        true,
        "controller and disposable runtime-owner credentials are required",
      );
      return;
    }
    const label = testInfo.testId.replace(/[^a-z0-9]+/gi, "-").slice(0, 48);
    const context = await provisionPrivateRuntimeOwnerProject(request, {
      controllerUrl,
      orgName: `Playwright Private Runtime ${testInfo.title}`,
      label,
    });
    try {
      await use(context);
    } finally {
      await cleanupPrivateRuntimeOwnerProject(request, context);
    }
  },
});

export async function registerPrivateRuntime(
  request: APIRequestContext,
  input: {
    controllerUrl: string;
    accessToken: string;
    projectId: string;
    displayName: string;
    provider?: string;
    idleTtlSeconds?: number;
  },
): Promise<{ runtimeId: string; agentToken: string }> {
  const tokenResponse = await request.post(
    `${input.controllerUrl}/projects/${encodeURIComponent(input.projectId)}/runtime/token`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      data: {},
    },
  );
  if (!tokenResponse.ok()) {
    throw new Error(
      `Private runtime token mint failed (${await responseError(tokenResponse)}).`,
    );
  }
  const runtimeIdentity = (await tokenResponse.json()) as Record<
    string,
    unknown
  >;
  const runtimeToken =
    typeof runtimeIdentity.token === "string"
      ? runtimeIdentity.token.trim()
      : "";
  const assignedRuntimeId =
    typeof runtimeIdentity.runtimeId === "string"
      ? runtimeIdentity.runtimeId.trim()
      : "";
  if (!runtimeToken || !assignedRuntimeId) {
    throw new Error(
      "Private runtime token mint did not return its controller-assigned identity.",
    );
  }

  const response = await request.post(
    `${input.controllerUrl}/runtime/register`,
    {
      headers: {
        authorization: `Bearer ${runtimeToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId: input.projectId,
        provider: input.provider ?? "self-hosted",
        displayName: input.displayName,
        idleTtlSeconds: input.idleTtlSeconds ?? 300,
        capabilities: {
          agent: true,
          origin: true,
          conversations: {
            stateful: true,
          },
          supportsStatefulConversations: true,
        },
      },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Private runtime registration failed (${await responseError(response)}).`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const runtimeId =
    typeof payload.runtime_id === "string" ? payload.runtime_id.trim() : "";
  const agentToken =
    typeof payload.agent_token === "string" ? payload.agent_token.trim() : "";
  if (!runtimeId || !agentToken) {
    throw new Error(
      "Private runtime registration did not return runtime and agent identities.",
    );
  }
  if (runtimeId !== assignedRuntimeId) {
    throw new Error(
      "Private runtime registration changed its controller-assigned identity.",
    );
  }
  return { runtimeId, agentToken };
}
