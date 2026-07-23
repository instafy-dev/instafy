import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ElectronBrowserCleanupConfig } from "../utils/electronBrowserLiveCleanup.js";
import {
  createElectronBrowserProvisioningRegistration,
  provisionElectronBrowserStudio,
  type ElectronBrowserLiveConfig,
  type ElectronBrowserProvisioningIdentity,
} from "../utils/electronBrowserLiveHarness.js";
import {
  electronBrowserRecoveryOrgName,
  electronBrowserRecoveryOrgSlug,
  electronBrowserRecoveryProjectName,
  recoverElectronBrowserStudioFromJournalOrTarget,
  recoverElectronBrowserStudiosBeforeProvisioning,
  resolveElectronBrowserRecoveryJournalPath,
  writeElectronBrowserRecoveryJournal,
} from "../utils/electronBrowserLiveRecovery.js";

type RequestCall = {
  method: "DELETE" | "GET" | "PATCH" | "POST";
  options?: unknown;
  url: string;
};

function response(status: number, payload: unknown = null): APIResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => payload,
  } as unknown as APIResponse;
}

function responseWithLostBody(): APIResponse {
  return {
    ok: () => true,
    status: () => 200,
    json: async () => {
      throw new Error("response body was lost after commit");
    },
  } as unknown as APIResponse;
}

function requestContext(
  calls: RequestCall[],
  handler: (call: RequestCall) => APIResponse,
): APIRequestContext {
  const invoke = async (
    method: RequestCall["method"],
    url: string,
    options?: unknown,
  ): Promise<APIResponse> => {
    const call = { method, options, url };
    calls.push(call);
    return handler(call);
  };
  return {
    delete: (url: string, options?: unknown) => invoke("DELETE", url, options),
    get: (url: string, options?: unknown) => invoke("GET", url, options),
    patch: (url: string, options?: unknown) => invoke("PATCH", url, options),
    post: (url: string, options?: unknown) => invoke("POST", url, options),
  } as unknown as APIRequestContext;
}

const config: ElectronBrowserCleanupConfig = {
  controllerUrl: "https://controller.example.test",
  supabaseUrl: "https://supabase.example.test",
  supabaseServiceRoleKey: "secret-service-role-marker",
};

const liveConfig: ElectronBrowserLiveConfig = {
  ...config,
  appBaseUrl: "https://app.example.test",
  defaultCodexAuthJsonPath: "/secret/auth-json-path-marker",
  supabaseAnonKey: "secret-anon-marker",
};

const identity: ElectronBrowserProvisioningIdentity = {
  disposableEmail:
    "electron-shared-browser-11111111-1111-4111-8111-111111111111@instafy.dev",
  recoveryMarker: "11111111-1111-4111-8111-111111111111",
  password: "secret-password-marker",
};

const userId = "33333333-3333-4333-8333-333333333333";
const wrongUserId = "44444444-4444-4444-8444-444444444444";
const orgId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const secondProjectId = "77777777-7777-4777-8777-777777777777";
const runtimeId = "88888888-8888-4888-8888-888888888888";

const temporaryRoots = new Set<string>();

function recoveryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-resource-recovery-"));
  temporaryRoots.add(root);
  return path.join(root, "journals");
}

function adminUserSnapshot(id = userId): Record<string, unknown> {
  return {
    id,
    email: identity.disposableEmail,
    user_metadata: {
      electronSharedBrowserRecoveryMarker: identity.recoveryMarker,
    },
  };
}

function successfulCleanupResponse(
  call: RequestCall,
  knownUserExists = false,
): APIResponse {
  if (call.method === "GET" && call.url.includes("/auth/v1/admin/users/")) {
    return knownUserExists ? response(200, adminUserSnapshot()) : response(404);
  }
  if (call.method === "GET" && call.url.includes("/auth/v1/admin/users?")) {
    return response(200, { users: [] });
  }
  if (call.method === "GET" && call.url.endsWith("/runtime/status")) {
    return response(200, { runtimes: [] });
  }
  if (call.method === "GET" && call.url.includes("/rest/v1/")) {
    return response(200, []);
  }
  if (call.method === "POST" && call.url.endsWith("/runtime/stop")) {
    return response(200, { provider_release_succeeded: true });
  }
  return response(204);
}

function organizationSnapshot(): Record<string, string> {
  return {
    id: orgId,
    name: electronBrowserRecoveryOrgName(identity.recoveryMarker),
    slug: electronBrowserRecoveryOrgSlug(identity.recoveryMarker),
  };
}

function projectSnapshot(id = projectId): Record<string, string> {
  return {
    id,
    name: electronBrowserRecoveryProjectName(identity.recoveryMarker),
    org_id: orgId,
    owner_user_id: userId,
    project_type: "customer",
  };
}

test.afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

test.describe("Electron Shared Browser resource recovery", () => {
  test("reconciles a committed project whose create response was lost before rollback", async () => {
    const registration = createElectronBrowserProvisioningRegistration();
    const calls: RequestCall[] = [];
    let userExists = false;
    let orgExists = false;
    let projectExists = false;
    const request = requestContext(calls, (call) => {
      if (call.method === "POST" && call.url.endsWith("/auth/v1/admin/users")) {
        userExists = true;
        return response(200, { id: userId });
      }
      if (call.method === "POST" && call.url.includes("/auth/v1/token?")) {
        return response(200, {
          access_token: "secret-access-token-marker",
          refresh_token: "secret-refresh-token-marker",
        });
      }
      if (call.method === "POST" && call.url === `${config.controllerUrl}/orgs`) {
        orgExists = true;
        return response(200, { orgId });
      }
      if (call.method === "POST" && call.url.endsWith(`/orgs/${orgId}/projects`)) {
        projectExists = true;
        return responseWithLostBody();
      }
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        return response(200, orgExists ? [organizationSnapshot()] : []);
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/org_memberships?")) {
        return response(
          200,
          orgExists
            ? [{ invited_by: null, role: "owner", user_id: userId }]
            : [],
        );
      }
      if (
        call.method === "GET" &&
        call.url.includes(`/rest/v1/projects?org_id=eq.${orgId}`)
      ) {
        return response(200, projectExists ? [projectSnapshot()] : []);
      }
      if (call.method === "DELETE" && call.url.endsWith(`/orgs/${orgId}`)) {
        orgExists = false;
        projectExists = false;
        return response(204);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        userExists = false;
        return response(204);
      }
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        return userExists ? response(200, adminUserSnapshot()) : response(404);
      }
      return successfulCleanupResponse(call);
    });

    const error = await provisionElectronBrowserStudio(
      request,
      liveConfig,
      registration,
      undefined,
      identity,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Partial cleanup was verified");
    expect(String(error)).not.toMatch(/secret-(?:access|refresh|service)/);
    expect(registration).toMatchObject({ orgId, projectId, userId });
    expect({ orgExists, projectExists, userExists }).toEqual({
      orgExists: false,
      projectExists: false,
      userExists: false,
    });
  });

  test("recovers uncheckpointed deterministic org and project before removing a journal", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { userId },
      false,
    );
    const calls: RequestCall[] = [];
    let userExists = true;
    let orgExists = true;
    let projectExists = true;
    let runtimeReleased = false;
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        return response(200, orgExists ? [organizationSnapshot()] : []);
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/org_memberships?")) {
        return response(200, [
          { invited_by: null, role: "owner", user_id: userId },
        ]);
      }
      if (
        call.method === "GET" &&
        call.url.includes(`/rest/v1/projects?org_id=eq.${orgId}`)
      ) {
        return response(200, projectExists ? [projectSnapshot()] : []);
      }
      if (call.method === "GET" && call.url.endsWith("/runtime/status")) {
        return response(200, { runtimes: [{ runtimeId, status: "online" }] });
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/runtimes?")) {
        return response(200, [
          { id: runtimeId, status: runtimeReleased ? "stopped" : "online" },
        ]);
      }
      if (call.method === "POST" && call.url.endsWith("/runtime/stop")) {
        runtimeReleased = true;
        return response(200, { provider_release_succeeded: true });
      }
      if (call.method === "DELETE" && call.url.endsWith(`/orgs/${orgId}`)) {
        orgExists = false;
        projectExists = false;
        return response(204);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        userExists = false;
        return response(204);
      }
      return successfulCleanupResponse(call, userExists);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).resolves.toBe(1);

    expect(fs.existsSync(journalPath)).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" && call.url.endsWith(`/projects/${projectId}`),
      ),
    ).toBe(true);
    const controllerCleanupCalls = calls.filter(
      (call) =>
        call.url.startsWith(config.controllerUrl) &&
        (call.url.endsWith("/runtime/status") ||
          call.url.endsWith("/runtime/stop") ||
          call.url.endsWith(`/projects/${projectId}`) ||
          call.url.endsWith(`/orgs/${orgId}`)),
    );
    expect(controllerCleanupCalls).not.toHaveLength(0);
    for (const call of controllerCleanupCalls) {
      expect(call.options).toMatchObject({
        headers: {
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
      });
    }
  });

  test("keeps the live disposable session through same-run journal reconciliation", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { orgId, projectId, userId },
      true,
    );
    const calls: RequestCall[] = [];
    let userExists = true;
    let orgExists = true;
    let projectExists = true;
    const sessionAccessToken = "secret-disposable-session-marker";
    const journalContents = fs.readFileSync(journalPath, "utf8");
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        return userExists ? response(200, adminUserSnapshot()) : response(404);
      }
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        return response(200, orgExists ? [organizationSnapshot()] : []);
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/org_memberships?")) {
        return response(200, [
          { invited_by: null, role: "owner", user_id: userId },
        ]);
      }
      if (
        call.method === "GET" &&
        call.url.includes(`/rest/v1/projects?org_id=eq.${orgId}`)
      ) {
        return response(200, projectExists ? [projectSnapshot()] : []);
      }
      if (call.method === "DELETE" && call.url.endsWith(`/orgs/${orgId}`)) {
        orgExists = false;
        projectExists = false;
        return response(204);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        userExists = false;
        return response(204);
      }
      return successfulCleanupResponse(call, userExists);
    });

    await expect(
      recoverElectronBrowserStudioFromJournalOrTarget(
        request,
        config,
        journalPath,
        {
          orgId,
          projectId,
          userId,
          session: { accessToken: sessionAccessToken },
        },
      ),
    ).resolves.toBe("journal");

    expect(fs.existsSync(journalPath)).toBe(false);
    const ownershipCleanupCalls = calls.filter(
      (call) =>
        call.url.startsWith(config.controllerUrl) &&
        (call.url.endsWith(`/projects/${projectId}`) || call.url.endsWith(`/orgs/${orgId}`)),
    );
    expect(ownershipCleanupCalls).not.toHaveLength(0);
    for (const call of ownershipCleanupCalls) {
      expect(call.options).toMatchObject({
        headers: {
          authorization: `Bearer ${sessionAccessToken}`,
        },
      });
    }
    const postTombstoneRuntimeCalls = calls.filter(
      (call) =>
        call.url.startsWith(config.controllerUrl) &&
        (call.url.endsWith("/runtime/status") || call.url.endsWith("/runtime/stop")),
    );
    expect(postTombstoneRuntimeCalls).not.toHaveLength(0);
    for (const call of postTombstoneRuntimeCalls) {
      expect(call.options).toMatchObject({
        headers: {
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
      });
    }
    expect(journalContents).not.toContain(sessionAccessToken);
  });

  test("retains the journal without deleting an org owned by another user", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { userId },
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        return response(200, [organizationSnapshot()]);
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/org_memberships?")) {
        return response(200, [
          { invited_by: null, role: "owner", user_id: wrongUserId },
        ]);
      }
      return successfulCleanupResponse(call, true);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).rejects.toThrow(/could not be reconciled/);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("rejects a retained user id whose live identity does not match the journal", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { userId },
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        return response(200, {
          id: userId,
          email: "unrelated-production-user@example.test",
          user_metadata: {},
        });
      }
      return successfulCleanupResponse(call);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).rejects.toThrow(/could not be reconciled/);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "GET" && call.url.includes("/auth/v1/admin/users?"),
      ),
    ).toBe(false);
  });

  test("rejects an absent retained id when the disposable identity belongs to another id", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { userId },
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userId}`)
      ) {
        return response(404);
      }
      if (call.method === "GET" && call.url.includes("/auth/v1/admin/users?")) {
        return response(200, { users: [adminUserSnapshot(wrongUserId)] });
      }
      return successfulCleanupResponse(call);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).rejects.toThrow(/could not be reconciled/);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("fails closed on a malformed admin user list", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      {},
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (call.method === "GET" && call.url.includes("/auth/v1/admin/users?")) {
        return response(200, { users: [null] });
      }
      return successfulCleanupResponse(call);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).rejects.toThrow(/could not be reconciled/);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("retains the journal when deterministic project recovery is ambiguous", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identity.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identity,
      { userId },
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        return response(200, [organizationSnapshot()]);
      }
      if (call.method === "GET" && call.url.includes("/rest/v1/org_memberships?")) {
        return response(200, [
          { invited_by: null, role: "owner", user_id: userId },
        ]);
      }
      if (
        call.method === "GET" &&
        call.url.includes(`/rest/v1/projects?org_id=eq.${orgId}`)
      ) {
        return response(200, [
          projectSnapshot(),
          projectSnapshot(secondProjectId),
        ]);
      }
      return successfulCleanupResponse(call, true);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).rejects.toThrow(/could not be reconciled/);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});
