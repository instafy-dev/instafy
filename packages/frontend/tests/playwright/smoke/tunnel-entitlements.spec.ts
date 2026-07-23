import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prepareStudio, getControllerUrl, createControllerOrgAndProject } from "../utils/harness.js";

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

async function resolveUserId(page: import("@playwright/test").Page): Promise<string> {
  const userId = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getUser) {
      return null;
    }
    const result = await client.auth.getUser();
    return result?.data?.user?.id ?? null;
  });
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Unable to resolve authenticated user id for tunnel entitlement smoke.");
  }
  return userId.trim();
}

async function requestTunnelGrant(
  request: import("@playwright/test").APIRequestContext,
  controllerUrl: string,
  serviceRoleKey: string,
  projectId: string,
  runtimeId: string,
  runtimeLeaseId: string,
) {
  return request.post(
    `${controllerUrl}/projects/${encodeURIComponent(projectId)}/tunnels/request`,
    {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      data: {
        runtimeId,
        runtimeLeaseId,
      },
    },
  );
}

test.describe.serial("Tunnel entitlements", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("starter org is capped at 1 active tunnel (but can renew same lease)", async ({ page }) => {
    // To enable this smoke in CI/local:
    // - Start the controller with `TUNNEL_BROKER_BASE_URL`, `TUNNEL_BROKER_TOKEN`,
    //   and `TUNNEL_BROKER_HOOK_SECRET` pointing at your broker.
    // - Optionally set `PLAYWRIGHT_TUNNEL_BROKER_SMOKE=1` to auto-start the local broker ingress fixture.
    test.skip(
      !(process.env.TUNNEL_BROKER_BASE_URL || process.env.VITE_TUNNEL_BROKER_BASE_URL),
      "self-hosted tunnel broker not configured for controller",
    );

    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKey();
    if (!controllerUrl || !serviceRoleKey) {
      throw new Error("Controller URL and service role key are required for tunnel entitlement smoke.");
    }

    const userId = await resolveUserId(page);
    const orgSlug = `playwright-tunnel-entitlements-${Date.now()}`;
    const created = await createControllerOrgAndProject(page.context().request, {
      controllerUrl,
      accessToken: serviceRoleKey,
      ownerUserId: userId,
      orgSlug,
      orgName: "Playwright Tunnel Entitlements",
    });

    const runtimeIdA = randomUUID();
    const leaseIdA = randomUUID();
    const firstGrantRes = await requestTunnelGrant(
      page.context().request,
      controllerUrl,
      serviceRoleKey,
      created.projectId,
      runtimeIdA,
      leaseIdA,
    );
    expect(firstGrantRes.ok()).toBeTruthy();
    const firstGrant = (await firstGrantRes.json()) as Record<string, unknown>;
    const tunnelIdA =
      (typeof firstGrant["tunnelId"] === "string" && firstGrant["tunnelId"]) ||
      (typeof firstGrant["tunnel_id"] === "string" && firstGrant["tunnel_id"]) ||
      "";
    expect(tunnelIdA).toBeTruthy();

    const renewRes = await requestTunnelGrant(
      page.context().request,
      controllerUrl,
      serviceRoleKey,
      created.projectId,
      runtimeIdA,
      leaseIdA,
    );
    expect(renewRes.ok()).toBeTruthy();

    const runtimeIdB = randomUUID();
    const leaseIdB = randomUUID();
    const secondGrantRes = await requestTunnelGrant(
      page.context().request,
      controllerUrl,
      serviceRoleKey,
      created.projectId,
      runtimeIdB,
      leaseIdB,
    );
    expect(secondGrantRes.status()).toBe(402);
    const errorBody = (await secondGrantRes.json().catch(() => null)) as
      | { message?: unknown }
      | null;
    expect(String(errorBody?.message ?? "")).toContain("Tunnel limit reached");

    if (tunnelIdA) {
      await page.context().request
        .post(
          `${controllerUrl}/projects/${encodeURIComponent(created.projectId)}/tunnels/${encodeURIComponent(tunnelIdA)}/revoke`,
          {
            headers: {
              authorization: `Bearer ${serviceRoleKey}`,
              "content-type": "application/json",
            },
            data: {},
          },
        )
        .catch(() => {});
    }
  });
});
