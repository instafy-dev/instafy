import { test, expect } from "@playwright/test";
import {
  getControllerUrl,
  prepareStudio,
  requireWorkspaceProjectId,
} from "../utils/harness.js";

function requireServiceRoleToken(): string {
  const token =
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";
  if (!token) {
    throw new Error("Service role token is required to seed runtimes during tests.");
  }
  return token;
}

test.describe.serial("Runtime resources", () => {
  test.setTimeout(120_000);

  async function seedDockerRuntimeWithResources(page: any) {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });

    const controllerUrl = getControllerUrl();
    const serviceRole = requireServiceRoleToken();
    const projectId = await requireWorkspaceProjectId(page);

    const runtimeRegisterResponse = await page.context().request.post(
      `${controllerUrl}/runtime/register`,
      {
        headers: {
          authorization: `Bearer ${serviceRole}`,
          "content-type": "application/json",
        },
        data: {
          projectId,
          provider: "runtime",
          idleTtlSeconds: 900,
          displayName: "Docker Runtime",
        },
      },
    );
    expect(runtimeRegisterResponse.ok()).toBeTruthy();
    const runtimeRegisterPayload = (await runtimeRegisterResponse.json()) as {
      runtime_id?: string;
      runtimeId?: string;
      agent_token?: string;
      agentToken?: string;
      lease_url?: string;
      leaseUrl?: string;
      heartbeat_url?: string;
      heartbeatUrl?: string;
    };
    const runtimeId =
      runtimeRegisterPayload.runtimeId ??
      runtimeRegisterPayload.runtime_id ??
      "";
    const agentToken =
      runtimeRegisterPayload.agentToken ??
      runtimeRegisterPayload.agent_token ??
      "";
    const leaseUrlRaw =
      runtimeRegisterPayload.leaseUrl ??
      runtimeRegisterPayload.lease_url ??
      "";
    const heartbeatUrlRaw =
      runtimeRegisterPayload.heartbeatUrl ??
      runtimeRegisterPayload.heartbeat_url ??
      "";
    expect(runtimeId).toBeTruthy();
    expect(agentToken).toBeTruthy();
    expect(leaseUrlRaw).toBeTruthy();
    expect(heartbeatUrlRaw).toBeTruthy();

    const leaseUrl = new URL(leaseUrlRaw, controllerUrl).toString();

    const leaseResponse = await page.context().request.post(leaseUrl, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeId,
        max: 1,
        lease_seconds: 60,
        resources: {
          cpuPct: 12.5,
          memoryUsedBytes: 512 * 1024 * 1024,
          memoryLimitBytes: 2 * 1024 * 1024 * 1024,
          diskUsedBytes: 10 * 1024 * 1024 * 1024,
          diskLimitBytes: 50 * 1024 * 1024 * 1024,
        },
      },
    });
    expect(leaseResponse.ok()).toBeTruthy();

    await page
      .evaluate(() => (window as any)?.__INSTAFY_RUNTIME__?.refreshRuntimeStatuses?.())
      .catch(() => {});

    await expect
      .poll(
        async () =>
          page
            .evaluate(() => {
              const runtimeApi = (window as any)?.__INSTAFY_RUNTIME__;
              const snapshot = runtimeApi?.getSnapshot?.();
              const statuses = snapshot?.runtimeStatuses ?? [];
              const entry = statuses.find(
                (candidate: any) => candidate?.displayName === "Docker Runtime",
              );
              return entry?.resources?.cpuPct ?? null;
            })
            .catch(() => null),
        { timeout: 30_000 },
      )
      .toBe(12.5);
  }

  async function openVisibleRuntimeMenu(page: any) {
    const runtimeSelectorButton = page
      .locator('[data-testid="runtime-selector-button"]:visible')
      .first();
    await runtimeSelectorButton.click();

    const runtimeMenu = page
      .locator('[data-testid="runtime-selector-popover"]:visible')
      .first();
    await expect(runtimeMenu).toBeVisible();
    const runtimeOptionsToggle = runtimeMenu
      .getByRole("button", { name: /Show runtime options|Hide runtime options/i })
      .first();
    if (await runtimeOptionsToggle.isVisible().catch(() => false)) {
      const toggleLabel = ((await runtimeOptionsToggle.textContent().catch(() => "")) ?? "")
        .toLowerCase()
        .trim();
      if (toggleLabel.includes("show runtime options")) {
        await runtimeOptionsToggle.click();
        await expect(
          runtimeMenu.getByRole("button", { name: /Hide runtime options/i }).first(),
        ).toBeVisible({ timeout: 5_000 });
      }
    }
    return runtimeMenu;
  }

  test("shows resource usage summary and details", async ({ page }) => {
    await seedDockerRuntimeWithResources(page);

    const runtimeMenu = await openVisibleRuntimeMenu(page);

    const dockerRuntimeRow = runtimeMenu
      .getByRole("button", { name: /docker runtime/i })
      .first();
    await expect(dockerRuntimeRow).toBeVisible({ timeout: 15_000 });
    await expect(dockerRuntimeRow).toContainText("CPU 13%");
    await expect(dockerRuntimeRow).toContainText("RAM 512 MB / 2 GB");
    await expect(dockerRuntimeRow).toContainText("Disk 10 GB / 50 GB");

    await dockerRuntimeRow.getByRole("button", { name: "Runtime actions" }).click();

    await expect(runtimeMenu).toBeVisible();
    await expect(runtimeMenu.getByText("Resources:", { exact: false })).toBeVisible();
  });

  test("shows resource usage summary in mobile runtime menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedDockerRuntimeWithResources(page);

    const runtimeMenu = await openVisibleRuntimeMenu(page);
    const dockerRuntimeRow = runtimeMenu
      .getByRole("button", { name: /docker runtime/i })
      .first();
    await expect(dockerRuntimeRow).toBeVisible({ timeout: 15_000 });
    await expect(dockerRuntimeRow).toContainText("CPU 13%");
    await expect(dockerRuntimeRow).toContainText("RAM 512 MB / 2 GB");
    await expect(dockerRuntimeRow).toContainText("Disk 10 GB / 50 GB");
  });
});
