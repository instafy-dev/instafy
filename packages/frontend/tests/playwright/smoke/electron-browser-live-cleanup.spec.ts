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
  cleanupElectronBrowserStudio,
  ElectronBrowserCleanupError,
  type ElectronBrowserCleanupConfig,
  type ElectronBrowserCleanupTarget,
} from "../utils/electronBrowserLiveCleanup.js";
import {
  buildElectronStudioChildEnv,
  createElectronBrowserProvisioningIdentity,
  createElectronBrowserProvisioningRegistration,
  launchElectronStudio,
  provisionElectronBrowserStudio,
  type ElectronBrowserLiveConfig,
} from "../utils/electronBrowserLiveHarness.js";

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
  supabaseServiceRoleKey: "secret-service-marker",
};

const provisioned: ElectronBrowserCleanupTarget = {
  orgId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  session: {
    accessToken: "secret-session-marker",
  },
};

const credentialId = "44444444-4444-4444-8444-444444444444";
const runtimeId = "55555555-5555-4555-8555-555555555555";
const lateRuntimeId = "66666666-6666-4666-8666-666666666666";

const liveConfig: ElectronBrowserLiveConfig = {
  ...config,
  appBaseUrl: "https://app.example.test",
  defaultCodexAuthJsonPath: "/safe/test/auth.json",
  supabaseAnonKey: "safe-anon-marker",
};

let timedOutFixtureTeardownCompleted = false;
const timeoutFixtureTest = test.extend<{ timeoutCleanupProbe: true }>({
  timeoutCleanupProbe: [
    async ({ browserName }, use) => {
      void browserName;
      await use(true);
      await new Promise((resolve) => setTimeout(resolve, 75));
      timedOutFixtureTeardownCompleted = true;
    },
    { scope: "test", timeout: 1_000 },
  ],
});

test.describe("Electron Shared Browser cleanup", () => {
  function successfulRequest(
    calls: RequestCall[],
    options: {
      organizationDeleteResponse?: APIResponse;
      organizationRows?: unknown;
      projectDeleteResponse?: APIResponse;
      providerResponse?: (attempt: number) => APIResponse;
      runtimeResponse?: (read: number) => APIResponse;
      runtimeRows?: (read: number) => unknown;
    } = {},
  ): { request: APIRequestContext; providerAttempts: () => number } {
    let providerAttempts = 0;
    let runtimeReads = 0;
    const releasedRuntimeIds = new Set<string>();
    return {
      providerAttempts: () => providerAttempts,
      request: requestContext(calls, ({ method, options: callOptions, url }) => {
        if (method === "DELETE" && url.endsWith(`/projects/${provisioned.projectId}`)) {
          return options.projectDeleteResponse ?? response(204);
        }
        if (method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`)) {
          return options.organizationDeleteResponse ?? response(204);
        }
        if (method === "GET" && url.includes("/rest/v1/organizations?")) {
          return response(200, options.organizationRows ?? []);
        }
        if (method === "GET" && url.endsWith("/runtime/status")) {
          return response(200, { runtimes: [{ runtimeId, status: "online" }] });
        }
        if (method === "GET" && url.includes("/rest/v1/runtimes?")) {
          runtimeReads += 1;
          if (options.runtimeResponse) {
            return options.runtimeResponse(runtimeReads);
          }
          if (options.runtimeRows) {
            return response(200, options.runtimeRows(runtimeReads));
          }
          return response(200, [
            {
              id: runtimeId,
              status: releasedRuntimeIds.has(runtimeId) ? "stopped" : "online",
            },
          ]);
        }
        if (method === "GET" && url.includes("/auth/v1/admin/users/")) {
          return response(404);
        }
        if (method === "GET" && url.includes("/rest/v1/")) {
          return response(200, []);
        }
        if (method === "POST" && url.endsWith("/runtime/stop")) {
          providerAttempts += 1;
          const providerResponse = options.providerResponse?.(providerAttempts);
          if (providerResponse) {
            if (providerResponse.ok()) {
              const stoppedRuntimeId = (
                callOptions as { data?: { runtime_id?: string } } | undefined
              )?.data?.runtime_id;
              if (stoppedRuntimeId) {
                releasedRuntimeIds.add(stoppedRuntimeId);
              }
            }
            return providerResponse;
          }
          const stoppedRuntimeId = (
            callOptions as { data?: { runtime_id?: string } } | undefined
          )?.data?.runtime_id;
          if (stoppedRuntimeId) {
            releasedRuntimeIds.add(stoppedRuntimeId);
          }
          return response(200, { provider_release_succeeded: true });
        }
        return response(204);
      }),
    };
  }

  test("tombstones after quiescence, then uses service authority to release runtimes", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls);

    await expect(
      cleanupElectronBrowserStudio(request, config, provisioned, credentialId),
    ).resolves.toBeUndefined();

    const indexOf = (predicate: (call: RequestCall) => boolean) => calls.findIndex(predicate);
    const tombstoneIndex = indexOf(
      ({ method, url }) =>
        method === "DELETE" && url.endsWith(`/projects/${provisioned.projectId}`),
    );
    const credentialIndex = indexOf(
      ({ method, url }) =>
        method === "DELETE" && url.endsWith(`/me/credentials/${credentialId}`),
    );
    const jobCancelIndex = indexOf(
      ({ method, url }) => method === "PATCH" && url.includes("/rest/v1/agent_jobs?"),
    );
    const runtimeDiscoveryIndex = indexOf(
      ({ method, url }) => method === "GET" && url.endsWith("/runtime/status"),
    );
    const providerReleaseIndex = indexOf(
      ({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"),
    );
    const detachedRunDeleteIndex = indexOf(
      ({ method, url }) =>
        method === "DELETE" &&
        url.includes("/rest/v1/runs?") &&
        !url.includes("status="),
    );
    const organizationDeleteIndex = indexOf(
      ({ method, url }) =>
        method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
    );

    expect(credentialIndex).toBe(0);
    expect(jobCancelIndex).toBeGreaterThan(credentialIndex);
    expect(tombstoneIndex).toBeGreaterThan(jobCancelIndex);
    expect(runtimeDiscoveryIndex).toBeGreaterThan(tombstoneIndex);
    expect(providerReleaseIndex).toBeGreaterThan(runtimeDiscoveryIndex);
    expect(detachedRunDeleteIndex).toBeGreaterThan(providerReleaseIndex);
    expect(organizationDeleteIndex).toBeGreaterThan(detachedRunDeleteIndex);

    for (const index of [tombstoneIndex, organizationDeleteIndex]) {
      expect(calls[index]?.options).toMatchObject({
        headers: {
          authorization: `Bearer ${provisioned.session?.accessToken}`,
        },
      });
    }
    for (const index of [runtimeDiscoveryIndex, providerReleaseIndex]) {
      expect(calls[index]?.options).toMatchObject({
        headers: {
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
      });
    }
    expect(calls[jobCancelIndex]?.options).toMatchObject({
      headers: {
        authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      },
    });

    expect(calls[jobCancelIndex]?.options).toMatchObject({
      data: {
        outcome: "canceled",
        status: "canceled",
        summary: "electron-shared-browser-agent-turn:cleanup",
      },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "PATCH",
          url: expect.stringContaining("status=in.(queued,failed,dispatched)"),
        }),
        expect.objectContaining({
          method: "DELETE",
          url: `${config.supabaseUrl}/auth/v1/admin/users/${provisioned.userId}`,
        }),
      ]),
    );
  });

  test("preserves the user ownership evidence when organization deletion fails", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls, {
      organizationDeleteResponse: response(503),
      organizationRows: [{ id: provisioned.orgId }],
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ step: "organization delete" }),
        expect.objectContaining({ step: "organization absence verification" }),
      ]),
    });
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" &&
          url.endsWith(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "GET" &&
          url.endsWith(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
  });

  test("preserves the user when the final runtime verification contains an invalid row", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls, {
      runtimeRows: (read) =>
        read < 4
          ? [{ id: runtimeId, status: read === 1 ? "online" : "stopped" }]
          : [{ status: "stopped" }],
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({
          step: "runtime terminal-state verification",
          detail: "response contained an invalid runtime row",
        }),
      ]),
    });
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" &&
          url.endsWith(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
  });

  test("preserves the user when the final runtime verification request fails", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls, {
      runtimeResponse: (read) =>
        read < 4
          ? response(200, [
              { id: runtimeId, status: read === 1 ? "online" : "stopped" },
            ])
          : response(503),
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({
          step: "runtime terminal-state verification",
          detail: "request returned HTTP 503",
        }),
      ]),
    });
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" &&
          url.endsWith(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
  });

  test("releases a runtime that appears after the first provider release", async () => {
    const calls: RequestCall[] = [];
    const released = new Set<string>();
    let runtimeReads = 0;
    const request = requestContext(calls, ({ method, options, url }) => {
      if (method === "GET" && url.endsWith("/runtime/status")) {
        return response(200, { runtimes: [{ runtimeId, status: "online" }] });
      }
      if (method === "GET" && url.includes("/rest/v1/runtimes?")) {
        runtimeReads += 1;
        if (runtimeReads === 1) {
          return response(200, [{ id: runtimeId, status: "online" }]);
        }
        return response(200, [
          { id: runtimeId, status: released.has(runtimeId) ? "stopped" : "online" },
          {
            id: lateRuntimeId,
            status: released.has(lateRuntimeId) ? "stopped" : "online",
          },
        ]);
      }
      if (method === "POST" && url.endsWith("/runtime/stop")) {
        const releasedId = (options as { data?: { runtime_id?: string } } | undefined)?.data
          ?.runtime_id;
        if (releasedId) {
          released.add(releasedId);
        }
        return response(200, { provider_release_succeeded: true });
      }
      if (method === "GET" && url.includes("/auth/v1/admin/users/")) {
        return response(404);
      }
      if (method === "GET" && url.includes("/rest/v1/")) {
        return response(200, []);
      }
      return response(204);
    });

    await expect(
      cleanupElectronBrowserStudio(request, config, provisioned, credentialId),
    ).resolves.toBeUndefined();

    expect(
      calls
        .filter(({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"))
        .map(
          ({ options }) =>
            (options as { data?: { runtime_id?: string } } | undefined)?.data?.runtime_id,
        ),
    ).toEqual([runtimeId, lateRuntimeId]);
    expect(runtimeReads).toBeGreaterThanOrEqual(4);
  });

  test("releases and verifies a removed runtime that commits after project tombstone", async () => {
    const calls: RequestCall[] = [];
    let projectTombstoned = false;
    let lateRuntimeReleased = false;
    let runtimeReads = 0;
    const request = requestContext(calls, ({ method, options, url }) => {
      if (
        method === "DELETE" &&
        url.endsWith(`/projects/${provisioned.projectId}`)
      ) {
        projectTombstoned = true;
        return response(204);
      }
      if (method === "GET" && url.endsWith("/runtime/status")) {
        return response(404);
      }
      if (method === "GET" && url.includes("/rest/v1/runtimes?")) {
        runtimeReads += 1;
        return response(
          200,
          projectTombstoned
            ? [
                {
                  id: lateRuntimeId,
                  status: lateRuntimeReleased ? "removed" : "online",
                },
              ]
            : [],
        );
      }
      if (method === "POST" && url.endsWith("/runtime/stop")) {
        expect(projectTombstoned).toBe(true);
        const payload = (options as { data?: Record<string, unknown> } | undefined)?.data;
        expect(payload).toMatchObject({
          expected_project_id: provisioned.projectId,
          require_provider_release: true,
          runtime_id: lateRuntimeId,
        });
        lateRuntimeReleased = true;
        return response(200, { provider_release_succeeded: true });
      }
      if (method === "GET" && url.includes("/auth/v1/admin/users/")) {
        return response(404);
      }
      if (method === "GET" && url.includes("/rest/v1/")) {
        return response(200, []);
      }
      return response(204);
    });

    await expect(
      cleanupElectronBrowserStudio(request, config, provisioned, credentialId),
    ).resolves.toBeUndefined();

    const tombstoneIndex = calls.findIndex(
      ({ method, url }) =>
        method === "DELETE" && url.endsWith(`/projects/${provisioned.projectId}`),
    );
    const firstRuntimeReadIndex = calls.findIndex(
      ({ method, url }) => method === "GET" && url.includes("/rest/v1/runtimes?"),
    );
    const providerReleaseIndex = calls.findIndex(
      ({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"),
    );
    const detachedRunDeleteIndex = calls.findIndex(
      ({ method, url }) =>
        method === "DELETE" &&
        url.includes("/rest/v1/runs?") &&
        !url.includes("status="),
    );

    expect(tombstoneIndex).toBeGreaterThanOrEqual(0);
    expect(firstRuntimeReadIndex).toBeGreaterThan(tombstoneIndex);
    expect(providerReleaseIndex).toBeGreaterThan(firstRuntimeReadIndex);
    expect(detachedRunDeleteIndex).toBeGreaterThan(providerReleaseIndex);
    expect(runtimeReads).toBeGreaterThanOrEqual(3);
    expect(calls[providerReleaseIndex]?.options).toMatchObject({
      headers: {
        authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      },
    });
  });

  test("preserves every recovery id when an active job never quiesces", async () => {
    const calls: RequestCall[] = [];
    const activeJobId = "77777777-7777-4777-8777-777777777777";
    const request = requestContext(calls, ({ method, url }) => {
      if (method === "GET" && url.includes("/rest/v1/agent_jobs?")) {
        return response(200, [{ id: activeJobId, status: "leased" }]);
      }
      if (method === "GET" && url.includes("/rest/v1/user_credentials?")) {
        return response(200, []);
      }
      if (method === "GET" && url.includes("/rest/v1/")) {
        return response(200, []);
      }
      return response(204);
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ step: "project work stable-empty verification" }),
      ]),
    });
    expect(String(error)).toContain(`${activeJobId}=leased`);
    expect(String(error)).not.toMatch(/secret-(?:service|session)-marker/);
    expect(calls.some(({ url }) => url.endsWith("/runtime/status"))).toBe(false);
    expect(calls.some(({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"))).toBe(
      false,
    );
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.includes(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
  });

  test("quiesces work but retains the identity when the project tombstone fails", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls, {
      projectDeleteResponse: response(503),
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([expect.objectContaining({ step: "project tombstone" })]),
    });
    expect(String(error)).not.toMatch(/secret-(?:service|session)-marker/);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.includes("/rest/v1/user_credentials?"),
      ),
    ).toBe(true);
    expect(calls.some(({ method }) => method === "PATCH")).toBe(true);
    expect(calls.some(({ url }) => url.endsWith("/runtime/status"))).toBe(false);
    expect(
      calls.some(
        ({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
      ),
    ).toBe(false);
  });

  test("preserves the disposable identity when strict provider release never succeeds", async () => {
    const calls: RequestCall[] = [];
    const { request, providerAttempts } = successfulRequest(calls, {
      providerResponse: () => response(502, { provider_release_succeeded: false }),
      runtimeRows: () => [{ id: runtimeId, status: "stopped" }],
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ step: `runtime provider release (${runtimeId})` }),
      ]),
    });
    expect(providerAttempts()).toBe(3);
    expect(String(error)).not.toMatch(/secret-(?:service|session)-marker/);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/projects/${provisioned.projectId}`),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.includes("/rest/v1/build_runs?"),
      ),
    ).toBe(false);
  });

  test("preserves the identity when authoritative runtime discovery contains an invalid row", async () => {
    const calls: RequestCall[] = [];
    const { request } = successfulRequest(calls, {
      runtimeRows: () => [{ status: "online" }],
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({
          step: "runtime database discovery",
          detail: "response contained an invalid runtime row",
        }),
      ]),
    });
    expect(calls.some(({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"))).toBe(
      false,
    );
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
      ),
    ).toBe(false);
  });

  test("retries strict provider release and requires the controller acknowledgement", async () => {
    const calls: RequestCall[] = [];
    const { request, providerAttempts } = successfulRequest(calls, {
      providerResponse: (attempt) =>
        attempt === 1
          ? response(502)
          : response(200, { provider_release_succeeded: true }),
    });

    await expect(
      cleanupElectronBrowserStudio(request, config, provisioned, credentialId),
    ).resolves.toBeUndefined();

    expect(providerAttempts()).toBe(2);
    const releaseCalls = calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/runtime/stop"),
    );
    expect(releaseCalls).toHaveLength(2);
    expect(releaseCalls[0]?.options).toMatchObject({
      data: {
        expected_project_id: provisioned.projectId,
        require_provider_release: true,
        runtime_id: runtimeId,
      },
    });
  });

  test("preserves recovery ids when detached build-run deletion cannot be verified", async () => {
    const calls: RequestCall[] = [];
    let runtimeReleased = false;
    const request = requestContext(calls, ({ method, options, url }) => {
      if (method === "GET" && url.endsWith("/runtime/status")) {
        return response(200, { runtimes: [{ runtimeId, status: "online" }] });
      }
      if (method === "GET" && url.includes("/rest/v1/runtimes?")) {
        return response(200, [
          { id: runtimeId, status: runtimeReleased ? "stopped" : "online" },
        ]);
      }
      if (method === "POST" && url.endsWith("/runtime/stop")) {
        runtimeReleased = Boolean(
          (options as { data?: { runtime_id?: string } } | undefined)?.data?.runtime_id,
        );
        return response(200, { provider_release_succeeded: true });
      }
      if (method === "DELETE" && url.includes("/rest/v1/build_runs?")) {
        return response(503);
      }
      if (method === "GET" && url.includes("/rest/v1/")) {
        return response(200, []);
      }
      return response(204);
    });

    const error = await cleanupElectronBrowserStudio(
      request,
      config,
      provisioned,
      credentialId,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElectronBrowserCleanupError);
    expect(error).toMatchObject({
      failures: expect.arrayContaining([expect.objectContaining({ step: "build-run row delete" })]),
    });
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.endsWith(`/orgs/${provisioned.orgId}`),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ method, url }) =>
          method === "DELETE" && url.includes(`/auth/v1/admin/users/${provisioned.userId}`),
      ),
    ).toBe(false);
  });
});

test.describe("Electron Shared Browser live harness safety", () => {
  test("passes only allowlisted desktop environment values and explicit overrides", () => {
    const childEnv = buildElectronStudioChildEnv(
      {
        HOME: "/home/test",
        HTTPS_PROXY: "https://secret-proxy-marker@example.test",
        INSTAFY_DESKTOP_FAKE_MEDIA: "1",
        INSTAFY_DESKTOP_LAN_AUTH_TOKEN: "secret-lan-marker",
        OPENAI_API_KEY: "secret-openai-marker",
        PATH: "/safe/bin",
        SERVICE_ROLE_KEY: "secret-service-marker",
        SUPABASE_JWT_SECRET: "secret-jwt-marker",
        SUPABASE_SERVICE_ROLE_KEY: "secret-supabase-marker",
      },
      {
        INSTAFY_APP_URL: "https://app.example.test/studio",
        INSTAFY_DESKTOP_USER_DATA_DIR: "/tmp/safe-profile",
      },
    );

    expect(childEnv).toMatchObject({
      HOME: "/home/test",
      INSTAFY_APP_URL: "https://app.example.test/studio",
      INSTAFY_DESKTOP_USER_DATA_DIR: "/tmp/safe-profile",
      PATH: "/safe/bin",
    });
    expect(Object.values(childEnv).join("\n")).not.toMatch(
      /secret-(?:lan|openai|proxy|service|jwt|supabase)-marker/,
    );
    expect(childEnv).not.toHaveProperty("INSTAFY_DESKTOP_FAKE_MEDIA");
  });

  test("registers and verifies partial provisioning cleanup without exposing secrets", async () => {
    const calls: RequestCall[] = [];
    const registration = createElectronBrowserProvisioningRegistration();
    const identity = createElectronBrowserProvisioningIdentity();
    let userExists = false;
    const request = requestContext(calls, ({ method, url }) => {
      if (method === "POST" && url.endsWith("/auth/v1/admin/users")) {
        userExists = true;
        return response(200, { id: provisioned.userId });
      }
      if (method === "POST" && url.includes("/auth/v1/token?")) {
        return response(200, {
          access_token: "secret-session-marker",
          refresh_token: "secret-refresh-marker",
        });
      }
      if (method === "POST" && url === `${config.controllerUrl}/orgs`) {
        return response(200, { orgId: provisioned.orgId });
      }
      if (method === "POST" && url.endsWith(`/orgs/${provisioned.orgId}/projects`)) {
        return response(503);
      }
      if (method === "GET" && url.includes("/auth/v1/admin/users/")) {
        return userExists
          ? response(200, {
              id: provisioned.userId,
              email: identity.disposableEmail,
              user_metadata: {
                electronSharedBrowserRecoveryMarker: identity.recoveryMarker,
              },
            })
          : response(404);
      }
      if (
        method === "DELETE" &&
        url.endsWith(`/auth/v1/admin/users/${provisioned.userId}`)
      ) {
        userExists = false;
        return response(204);
      }
      if (method === "GET" && url.includes("/rest/v1/")) {
        return response(200, []);
      }
      return response(204);
    });

    const error = await provisionElectronBrowserStudio(
      request,
      liveConfig,
      registration,
      undefined,
      identity,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Controller project creation returned HTTP 503");
    expect(String(error)).not.toMatch(/secret-(?:service|session|refresh)-marker/);
    expect(registration).toMatchObject({
      orgId: provisioned.orgId,
      projectId: null,
      userId: provisioned.userId,
    });
    expect(registration.session?.accessToken).toBe("secret-session-marker");
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "DELETE",
          url: `${config.controllerUrl}/orgs/${provisioned.orgId}`,
        }),
        expect.objectContaining({
          method: "DELETE",
          url: `${config.supabaseUrl}/auth/v1/admin/users/${provisioned.userId}`,
        }),
      ]),
    );

    // The test-scoped fixture repeats this verification after a provisioning
    // failure; all operations remain idempotent after the helper's rollback.
    await expect(
      cleanupElectronBrowserStudio(request, liveConfig, registration),
    ).resolves.toBeUndefined();
  });

  test("closes a launched Electron app when first-window setup fails", async () => {
    let appClosed = false;
    let profilePath = "";
    const fakeApp = {
      close: async () => {
        appClosed = true;
      },
      firstWindow: async () => {
        throw new Error("secret-first-window-marker");
      },
      process: () => ({
        exitCode: 0,
        signalCode: null,
      }),
    };

    const error = await launchElectronStudio(liveConfig, provisioned.projectId, {
      desktopAppBuildExists: () => true,
      launch: (async (options: { env?: NodeJS.ProcessEnv }) => {
        profilePath = options.env?.INSTAFY_DESKTOP_USER_DATA_DIR ?? "";
        return fakeApp;
      }) as never,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret-first-window-marker");
    expect(appClosed).toBe(true);
    expect(profilePath).not.toBe("");
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  test("force-kills a launched Electron app when graceful close stalls", async () => {
    let forcedKillSignal: string | null = null;
    const fakeApp = {
      close: async () => await new Promise<never>(() => undefined),
      firstWindow: async () => {
        throw new Error("window failed");
      },
      process: () => ({
        exitCode: null,
        kill: (signal: string) => {
          forcedKillSignal = signal;
          return true;
        },
        signalCode: null,
      }),
    };

    await launchElectronStudio(liveConfig, provisioned.projectId, {
      closeTimeoutMs: 5,
      desktopAppBuildExists: () => true,
      launch: (async () => fakeApp) as never,
    }).catch(() => undefined);

    expect(forcedKillSignal).toBe("SIGKILL");
  });

  test("rejects launch clearly when the desktop app has not been built", async () => {
    let launchCalled = false;

    await expect(
      launchElectronStudio(liveConfig, provisioned.projectId, {
        desktopAppBuildExists: () => false,
        launch: (async () => {
          launchCalled = true;
          throw new Error("launch should not be called");
        }) as never,
      }),
    ).rejects.toThrow(/requires a built desktop app/i);
    expect(launchCalled).toBe(false);
  });

  test("launches a packaged executable without source argv and isolates its workspace", async () => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-packaged-launch-"));
    const executablePath = path.join(packageDir, "Instafy Studio");
    fs.writeFileSync(executablePath, "packaged fixture", { mode: 0o700 });
    let launchOptions: {
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      executablePath?: string;
    } | null = null;
    const fakeApp = {
      firstWindow: async () => ({}),
    };

    let profilePath = "";
    try {
      const launched = await launchElectronStudio(liveConfig, provisioned.projectId, {
        executablePath,
        launch: (async (options: typeof launchOptions) => {
          launchOptions = options;
          profilePath = options?.env?.INSTAFY_DESKTOP_USER_DATA_DIR ?? "";
          return fakeApp;
        }) as never,
        launchEnv: {
          INSTAFY_RUNTIME_AGENT_BIN: "/must-not-be-used",
        },
      });

      expect(launched.app).toBe(fakeApp);
      expect(launchOptions).toMatchObject({
        args: [],
        cwd: packageDir,
        executablePath,
        env: {
          INSTAFY_RUNTIME_AGENT_BIN: "/must-not-be-used",
        },
      });
      expect(profilePath).not.toBe("");
      const desktopConfig = JSON.parse(
        fs.readFileSync(path.join(profilePath, "desktop-config.json"), "utf8"),
      ) as { workspaceDir?: unknown };
      expect(desktopConfig.workspaceDir).toBe(path.join(profilePath, "workspace"));
      expect(fs.statSync(path.join(profilePath, "workspace")).isDirectory()).toBe(true);
    } finally {
      if (profilePath) {
        fs.rmSync(profilePath, { force: true, recursive: true });
      }
      fs.rmSync(packageDir, { force: true, recursive: true });
    }
  });
});

timeoutFixtureTest.describe("Playwright cleanup timeout isolation", () => {
  timeoutFixtureTest.describe.configure({ mode: "serial", retries: 0 });

  timeoutFixtureTest("runs fixture teardown after an expected body timeout", async ({
    timeoutCleanupProbe,
  }, testInfo) => {
    expect(timeoutCleanupProbe).toBe(true);
    testInfo.expectedStatus = "timedOut";
    testInfo.setTimeout(40);
    await new Promise<never>(() => undefined);
  });

  timeoutFixtureTest("completed teardown using the fixture-specific budget", async () => {
    expect(timedOutFixtureTeardownCompleted).toBe(true);
  });
});
