import { test, expect } from "@playwright/test";
import {
  prepareStudio,
  requireWorkspaceProjectId,
  getControllerUrl,
  issueTunnelGrant,
  revokeTunnelGrant,
} from "../utils/harness.js";

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

test.describe.serial("Self-hosted tunnel grants", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("issues a self-hosted tunnel grant via controller", async ({ page }) => {
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
    const projectId = await requireWorkspaceProjectId(page);
    if (!controllerUrl || !serviceRoleKey) {
      throw new Error("Controller URL and service role key are required for tunnel smoke.");
    }

    const runtimeRes = await page.context().request.post(
      `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/request`,
      {
        headers: {
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        data: { provider: "self-hosted" },
      },
    );
    expect(runtimeRes.ok()).toBeTruthy();
    const runtimeBody = (await runtimeRes.json()) as Record<string, unknown>;
    const runtimeRecord = (runtimeBody["runtime"] ??
      runtimeBody["runtime_info"] ??
      runtimeBody) as Record<string, unknown>;
    const runtimeId =
      (typeof runtimeRecord["runtimeId"] === "string" && runtimeRecord["runtimeId"]) ||
      (typeof runtimeRecord["runtime_id"] === "string" && runtimeRecord["runtime_id"]) ||
      "";
    const leaseId =
      (typeof runtimeRecord["leaseId"] === "string" && runtimeRecord["leaseId"]) ||
      (typeof runtimeRecord["lease_id"] === "string" && runtimeRecord["lease_id"]) ||
      "";
    if (!runtimeId || !leaseId) {
      throw new Error(`Runtime request did not return IDs. body=${JSON.stringify(runtimeBody)}`);
    }

    const grant = await issueTunnelGrant(page, runtimeId, { runtimeLeaseId: leaseId });
    expect(grant.provider).toBe("self_hosted");
    expect(typeof grant.hostname).toBe("string");
    expect(grant.hostname).toContain(".");
    expect(typeof grant.url).toBe("string");
    expect(grant.url).toContain(grant.hostname ?? "");

    const creds = grant.credentials as Record<string, unknown> | undefined;
    expect(creds).toBeTruthy();
    expect(creds?.provider).toBe("self_hosted");
    expect(typeof creds?.server).toBe("string");
    expect(typeof creds?.token).toBe("string");
    expect(typeof creds?.hostname).toBe("string");
    expect(
      typeof creds?.service === "string" || typeof creds?.serviceName === "string",
    ).toBeTruthy();
    expect(typeof creds?.remotePort === "number").toBeTruthy();

    if (grant.tunnelId) {
      await revokeTunnelGrant(page, grant.tunnelId);
    }
  });
});
