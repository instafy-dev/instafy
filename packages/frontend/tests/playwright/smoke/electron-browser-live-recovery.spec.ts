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
  readElectronBrowserRecoveryJournal,
  recoverElectronBrowserStudioFromJournalOrTarget,
  recoverElectronBrowserStudiosBeforeProvisioning,
  removeElectronBrowserRecoveryJournal,
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

const identityOne: ElectronBrowserProvisioningIdentity = {
  disposableEmail:
    "electron-shared-browser-11111111-1111-4111-8111-111111111111@instafy.dev",
  recoveryMarker: "11111111-1111-4111-8111-111111111111",
  password: "secret-password-marker",
};

const identityTwo: ElectronBrowserProvisioningIdentity = {
  disposableEmail:
    "electron-shared-browser-22222222-2222-4222-8222-222222222222@instafy.dev",
  recoveryMarker: "22222222-2222-4222-8222-222222222222",
  password: "another-secret-password-marker",
};

const userOne = "33333333-3333-4333-8333-333333333333";
const userTwo = "44444444-4444-4444-8444-444444444444";
const orgId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";

const temporaryRoots = new Set<string>();

function recoveryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-recovery-test-"));
  temporaryRoots.add(root);
  return path.join(root, "journals");
}

function successfulRecoveryResponse(call: RequestCall): APIResponse {
  if (call.method === "GET" && call.url.includes("/auth/v1/admin/users/")) {
    return response(404);
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

test.afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

test.describe("Electron Shared Browser recovery journal", () => {
  test("writes atomically with private modes and serializes no credentials", () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    const richTarget = {
      orgId,
      projectId,
      userId: userOne,
      session: {
        accessToken: "secret-access-token-marker",
        refreshToken: "secret-refresh-token-marker",
      },
      password: "secret-target-password-marker",
    };

    writeElectronBrowserRecoveryJournal(
      journalPath,
      liveConfig,
      identityOne,
      richTarget,
      true,
    );

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
    const contents = fs.readFileSync(journalPath, "utf8");
    expect(contents).toContain(identityOne.disposableEmail);
    expect(contents).toContain(projectId);
    expect(contents).toContain('"credentialUploadStarted": true');
    expect(contents).not.toMatch(
      /secret-(?:access|refresh|service|anon|auth|password|target)/,
    );
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(readElectronBrowserRecoveryJournal(journalPath)).toMatchObject({
      orgId,
      projectId,
      userId: userOne,
      credentialUploadStarted: true,
    });

    removeElectronBrowserRecoveryJournal(journalPath);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  test("checkpoints the recovery handle before user creation and after every returned id", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    const registration = createElectronBrowserProvisioningRegistration();
    writeElectronBrowserRecoveryJournal(
      journalPath,
      liveConfig,
      identityOne,
      registration,
      false,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, ({ method, url }) => {
      if (method === "POST" && url.endsWith("/auth/v1/admin/users")) {
        expect(readElectronBrowserRecoveryJournal(journalPath)).toMatchObject({
          userId: null,
          orgId: null,
          projectId: null,
        });
        expect(fs.readFileSync(journalPath, "utf8")).not.toContain(
          identityOne.password,
        );
        return response(200, { id: userOne });
      }
      if (method === "POST" && url.includes("/auth/v1/token?")) {
        expect(readElectronBrowserRecoveryJournal(journalPath)?.userId).toBe(userOne);
        return response(200, {
          access_token: "secret-access-token-marker",
          refresh_token: "secret-refresh-token-marker",
        });
      }
      if (method === "POST" && url === `${config.controllerUrl}/orgs`) {
        expect(readElectronBrowserRecoveryJournal(journalPath)).toMatchObject({
          userId: userOne,
          orgId: null,
        });
        return response(200, { orgId });
      }
      if (method === "POST" && url.endsWith(`/orgs/${orgId}/projects`)) {
        expect(readElectronBrowserRecoveryJournal(journalPath)?.orgId).toBe(orgId);
        return response(200, { projectId });
      }
      return response(503);
    });

    const provisioned = await provisionElectronBrowserStudio(
      request,
      liveConfig,
      registration,
      (checkpoint) => {
        writeElectronBrowserRecoveryJournal(
          journalPath,
          liveConfig,
          identityOne,
          checkpoint,
          false,
        );
      },
      identityOne,
    );

    expect(provisioned).toMatchObject({ userId: userOne, orgId, projectId });
    expect(readElectronBrowserRecoveryJournal(journalPath)).toMatchObject({
      userId: userOne,
      orgId,
      projectId,
    });
    expect(fs.readFileSync(journalPath, "utf8")).not.toMatch(
      /secret-(?:access|refresh|service|anon|auth|password)/,
    );
  });

  test("paginates user reconciliation, recovers every retained run, and purges by service role", async () => {
    const directory = recoveryDirectory();
    const journalOne = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    const journalTwo = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityTwo.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalOne,
      config,
      identityOne,
      { userId: userOne },
      true,
    );
    writeElectronBrowserRecoveryJournal(
      journalTwo,
      config,
      identityTwo,
      {},
      true,
    );

    const calls: RequestCall[] = [];
    const decoys = Array.from({ length: 100 }, (_, index) => ({
      id: `decoy-${index}`,
      email: `decoy-${index}@example.test`,
      user_metadata: {},
    }));
    let userOneExists = true;
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userOne}`)
      ) {
        return userOneExists
          ? response(200, {
              id: userOne,
              email: identityOne.disposableEmail,
              user_metadata: {
                electronSharedBrowserRecoveryMarker: identityOne.recoveryMarker,
              },
            })
          : response(404);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userOne}`)
      ) {
        userOneExists = false;
        return response(204);
      }
      if (
        call.method === "GET" &&
        call.url.includes("/auth/v1/admin/users?page=1")
      ) {
        return response(200, { users: decoys });
      }
      if (
        call.method === "GET" &&
        call.url.includes("/auth/v1/admin/users?page=2")
      ) {
        return response(200, {
          users: [
            {
              id: userTwo,
              email: identityTwo.disposableEmail,
              user_metadata: {
                electronSharedBrowserRecoveryMarker: identityTwo.recoveryMarker,
              },
            },
          ],
        });
      }
      return successfulRecoveryResponse(call);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).resolves.toBe(2);

    expect(fs.existsSync(journalOne)).toBe(false);
    expect(fs.existsSync(journalTwo)).toBe(false);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" && call.url.includes("/auth/v1/admin/users?page="),
      ),
    ).toHaveLength(2);
    const purgeCall = calls.find(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes(`/rest/v1/user_credentials?user_id=eq.${userTwo}`),
    );
    expect(purgeCall).toMatchObject({
      options: {
        headers: {
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
      },
    });
    expect(
      calls.some((call) => call.url.includes("/me/credentials/")),
    ).toBe(false);
  });

  test("recovers a user-only collaborator before its owner Studio regardless of journal filename order", async () => {
    const directory = recoveryDirectory();
    const ownerJournal = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    const memberJournal = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityTwo.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      ownerJournal,
      config,
      identityOne,
      { orgId, projectId, userId: userOne },
      false,
    );
    writeElectronBrowserRecoveryJournal(
      memberJournal,
      config,
      identityTwo,
      { userId: userTwo },
      false,
    );

    let ownerExists = true;
    let memberExists = true;
    let organizationExists = true;
    let projectExists = true;
    const calls: RequestCall[] = [];
    const request = requestContext(calls, (call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userOne}`)
      ) {
        return ownerExists
          ? response(200, {
              id: userOne,
              email: identityOne.disposableEmail,
              user_metadata: {
                electronSharedBrowserRecoveryMarker: identityOne.recoveryMarker,
              },
            })
          : response(404);
      }
      if (
        call.method === "GET" &&
        call.url.endsWith(`/auth/v1/admin/users/${userTwo}`)
      ) {
        return memberExists
          ? response(200, {
              id: userTwo,
              email: identityTwo.disposableEmail,
              user_metadata: {
                electronSharedBrowserRecoveryMarker: identityTwo.recoveryMarker,
              },
            })
          : response(404);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userTwo}`)
      ) {
        memberExists = false;
        return response(204);
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userOne}`)
      ) {
        ownerExists = false;
        return response(204);
      }
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/organizations?slug=eq.")
      ) {
        if (
          !call.url.includes(
            encodeURIComponent(
              electronBrowserRecoveryOrgSlug(identityOne.recoveryMarker),
            ),
          )
        ) {
          return response(200, []);
        }
        return response(
          200,
          organizationExists
            ? [
                {
                  id: orgId,
                  name: electronBrowserRecoveryOrgName(identityOne.recoveryMarker),
                  slug: electronBrowserRecoveryOrgSlug(identityOne.recoveryMarker),
                },
              ]
            : [],
        );
      }
      if (
        call.method === "GET" &&
        call.url.includes("/rest/v1/org_memberships?")
      ) {
        return response(200, [
          { invited_by: null, role: "owner", user_id: userOne },
          ...(memberExists
            ? [{ invited_by: userOne, role: "builder", user_id: userTwo }]
            : []),
        ]);
      }
      if (
        call.method === "GET" &&
        call.url.includes(`/rest/v1/projects?org_id=eq.${orgId}`)
      ) {
        return response(
          200,
          projectExists
            ? [
                {
                  id: projectId,
                  name: electronBrowserRecoveryProjectName(
                    identityOne.recoveryMarker,
                  ),
                  org_id: orgId,
                  owner_user_id: userOne,
                  project_type: "customer",
                },
              ]
            : [],
        );
      }
      if (call.method === "DELETE" && call.url.endsWith(`/projects/${projectId}`)) {
        projectExists = false;
        return response(204);
      }
      if (call.method === "DELETE" && call.url.endsWith(`/orgs/${orgId}`)) {
        organizationExists = false;
        return response(204);
      }
      return successfulRecoveryResponse(call);
    });

    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(request, config, directory),
    ).resolves.toBe(2);

    expect(fs.existsSync(ownerJournal)).toBe(false);
    expect(fs.existsSync(memberJournal)).toBe(false);
    const memberDeleteIndex = calls.findIndex(
      (call) =>
        call.method === "DELETE" &&
        call.url.endsWith(`/auth/v1/admin/users/${userTwo}`),
    );
    const ownerMembershipCheckIndex = calls.findIndex(
      (call) =>
        call.method === "GET" &&
        call.url.includes("/rest/v1/org_memberships?"),
    );
    expect(memberDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(ownerMembershipCheckIndex).toBeGreaterThan(memberDeleteIndex);
  });

  test("keeps the journal and aborts preflight until strict cleanup succeeds", async () => {
    const directory = recoveryDirectory();
    const journalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    writeElectronBrowserRecoveryJournal(
      journalPath,
      config,
      identityOne,
      { userId: userOne },
      true,
    );
    const failedCalls: RequestCall[] = [];
    const failedRequest = requestContext(failedCalls, () => response(503));

    const error = await recoverElectronBrowserStudiosBeforeProvisioning(
      failedRequest,
      config,
      directory,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(config.supabaseServiceRoleKey);
    expect(fs.existsSync(journalPath)).toBe(true);

    const retryCalls: RequestCall[] = [];
    const retryRequest = requestContext(retryCalls, successfulRecoveryResponse);
    await expect(
      recoverElectronBrowserStudiosBeforeProvisioning(
        retryRequest,
        config,
        directory,
      ),
    ).resolves.toBe(1);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  test("falls back to strict in-memory cleanup when the expected journal vanished", async () => {
    const directory = recoveryDirectory();
    const missingJournalPath = resolveElectronBrowserRecoveryJournalPath(
      directory,
      identityOne.recoveryMarker,
    );
    const calls: RequestCall[] = [];
    const request = requestContext(calls, successfulRecoveryResponse);

    await expect(
      recoverElectronBrowserStudioFromJournalOrTarget(
        request,
        config,
        missingJournalPath,
        { userId: userOne },
      ),
    ).resolves.toBe("target");

    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.endsWith(`/auth/v1/admin/users/${userOne}`),
      ),
    ).toBe(true);
  });
});
