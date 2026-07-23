import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createElectronBrowserProvisioningRegistration,
  type ElectronBrowserProvisioningIdentity,
  type ElectronBrowserStudioConfig,
} from "../utils/electronBrowserLiveHarness.js";
import {
  readElectronBrowserRecoveryJournal,
  resolveElectronBrowserRecoveryJournalPath,
  writeElectronBrowserRecoveryJournal,
} from "../utils/electronBrowserLiveRecovery.js";
import {
  assertSharedBrowserProjectSafetyUnchanged,
  captureSharedBrowserProjectSafetyBaseline,
  discoverSharedBrowserInviteLink,
  provisionSharedBrowserCollaborator,
  revokeAndVerifySharedBrowserInviteLink,
  type SharedBrowserProductionOwnerActor,
} from "../utils/sharedBrowserProductionResources.js";

type RequestCall = {
  method: "DELETE" | "GET" | "POST";
  options?: unknown;
  url: string;
};

function response(status: number, payload: unknown = null): APIResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => payload,
  } as APIResponse;
}

function requestContext(
  calls: RequestCall[],
  handler: (call: RequestCall) => APIResponse,
): APIRequestContext {
  const invoke = async (
    method: RequestCall["method"],
    url: string,
    options?: unknown,
  ) => {
    const call = { method, options, url };
    calls.push(call);
    return handler(call);
  };
  return {
    delete: (url: string, options?: unknown) => invoke("DELETE", url, options),
    get: (url: string, options?: unknown) => invoke("GET", url, options),
    post: (url: string, options?: unknown) => invoke("POST", url, options),
  } as unknown as APIRequestContext;
}

const config: ElectronBrowserStudioConfig = {
  appBaseUrl: "https://app.example.test",
  controllerUrl: "https://controller.example.test",
  supabaseAnonKey: "secret-anon-marker",
  supabaseServiceRoleKey: "secret-service-marker",
  supabaseUrl: "https://supabase.example.test",
};
const identity: ElectronBrowserProvisioningIdentity = {
  disposableEmail:
    "electron-shared-browser-11111111-1111-4111-8111-111111111111@instafy.dev",
  recoveryMarker: "11111111-1111-4111-8111-111111111111",
  password: "secret-password-marker",
};
const userId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const inviteId = "55555555-5555-4555-8555-555555555555";
const inviteToken = "66666666-6666-4666-8666-666666666666";
const ledgerId = "77777777-7777-4777-8777-777777777777";
const newLedgerId = "88888888-8888-4888-8888-888888888888";

test("checkpoints a user-only collaborator before password login", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shared-browser-resources-"));
  try {
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    const registration = createElectronBrowserProvisioningRegistration();
    writeElectronBrowserRecoveryJournal(journalPath, config, identity, registration, false);
    const calls: RequestCall[] = [];
    const request = requestContext(calls, ({ method, url }) => {
      if (method === "POST" && url.endsWith("/auth/v1/admin/users")) {
        return response(200, { id: userId });
      }
      if (method === "POST" && url.includes("grant_type=password")) {
        expect(readElectronBrowserRecoveryJournal(journalPath)?.userId).toBe(userId);
        return response(200, {
          access_token: "secret-access-marker",
          refresh_token: "secret-refresh-marker",
        });
      }
      throw new Error(`Unexpected ${method} request`);
    });

    const actor = await provisionSharedBrowserCollaborator(
      request,
      config,
      identity,
      registration,
      journalPath,
      () =>
        writeElectronBrowserRecoveryJournal(
          journalPath,
          config,
          identity,
          registration,
          false,
        ),
    );

    expect(actor).toMatchObject({ kind: "collaborator", userId, orgId: null, projectId: null });
    expect(calls.filter((call) => call.url.includes("/auth/v1/token?"))).toHaveLength(1);
    expect(fs.readFileSync(journalPath, "utf8")).not.toMatch(/secret-(?:password|access|refresh)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("detects a managed-AI ledger change while collaboration creates no jobs", async () => {
  let finalRead = false;
  const calls: RequestCall[] = [];
  const request = requestContext(calls, ({ method, url }) => {
    expect(method).toBe("GET");
    if (url.includes("/org_credit_ledger?")) {
      return response(200, finalRead ? [{ id: ledgerId }, { id: newLedgerId }] : [{ id: ledgerId }]);
    }
    if (url.includes("/agent_jobs?") || url.includes("/runs?")) {
      return response(200, []);
    }
    throw new Error("Unexpected safety query");
  });
  const baseline = await captureSharedBrowserProjectSafetyBaseline(
    request,
    config,
    projectId,
  );
  finalRead = true;
  await expect(
    assertSharedBrowserProjectSafetyUnchanged(request, config, baseline),
  ).rejects.toThrow(/managed_ai_prompt credit ledger/i);
});

test("discovers, revokes, and verifies the exact invite audit row", async () => {
  const owner: SharedBrowserProductionOwnerActor = {
    kind: "owner",
    identity,
    recoveryJournalPath: "/tmp/not-written.json",
    registration: {
      orgId,
      projectId,
      userId,
      session: {
        accessToken: "secret-access-marker",
        refreshToken: "secret-refresh-marker",
        userId,
      },
    },
    session: {
      accessToken: "secret-access-marker",
      refreshToken: "secret-refresh-marker",
      userId,
    },
    userId,
    orgId,
    projectId,
    provisioned: {
      orgId,
      projectId,
      userId,
      session: {
        accessToken: "secret-access-marker",
        refreshToken: "secret-refresh-marker",
        userId,
      },
    },
  };
  const calls: RequestCall[] = [];
  const request = requestContext(calls, ({ method, url }) => {
    if (method === "GET" && url.startsWith(`${config.controllerUrl}/orgs/`)) {
      return response(200, { inviteLinks: [{ id: inviteId, token: inviteToken }] });
    }
    if (method === "DELETE") return response(204);
    if (method === "GET" && url.includes("/rest/v1/org_invite_links?")) {
      return response(200, [
        { id: inviteId, status: "revoked", revoked_at: "2026-07-19T10:00:00Z" },
      ]);
    }
    throw new Error(`Unexpected ${method} request`);
  });

  const tracked = await discoverSharedBrowserInviteLink(request, config, {
    owner,
    projectId,
    inviteUrl: `${config.appBaseUrl}/invite?token=${inviteToken}`,
  });
  await revokeAndVerifySharedBrowserInviteLink(request, config, tracked);

  expect(tracked).toMatchObject({ inviteLinkId: inviteId, orgId, projectId });
  expect(calls.map(({ method }) => method)).toEqual(["GET", "DELETE", "GET"]);
});
