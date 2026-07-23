import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudio,
  resolveAuthenticatedAccessToken,
  requireWorkspaceProjectId,
  getControllerUrl,
} from "../utils/harness.js";
import {
  ensureDesktopOriginServer,
  getDesktopOriginContext,
  stopDesktopOriginServer,
} from "../utils/desktopRuntimeHarness.js";

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

async function waitForTunnelReady(page: Page, tunnelUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const url = new URL(tunnelUrl);
      url.pathname = "/healthz";
      const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      if (response?.ok()) {
        const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
        if (bodyText.trim() === "ok") return;
      }
    } catch {
      // ignore transient failures; we expect the tunnel to be eventually consistent
    }
    const backoff = Math.min(2000, 200 + attempt * 200);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(`Timed out waiting for tunnel to become routable: ${tunnelUrl}`);
}

test.describe.serial("Desktop origin via tunnel", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_DESKTOP_ORIGIN_TUNNEL_SMOKE ?? "").trim() !== "1",
      "Set PLAYWRIGHT_DESKTOP_ORIGIN_TUNNEL_SMOKE=1 to enable this smoke.",
    );

    process.env.PLAYWRIGHT_DESKTOP_RUNTIME_MODE = "cli";
    process.env.PLAYWRIGHT_DESKTOP_ORIGIN_USE_TUNNEL = "1";
    process.env.ORIGIN_TUNNEL_ENABLED = "1";

    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async () => {
    await stopDesktopOriginServer().catch(() => {});
  });

  test("serves origin healthz over tunnel URL", async ({ page }) => {
    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKey();
    const ownerAccessToken = await resolveAuthenticatedAccessToken(page);
    const projectId = await requireWorkspaceProjectId(page);
    if (!controllerUrl || !serviceRoleKey || !ownerAccessToken) {
      throw new Error(
        "Controller URL, service role key, and authenticated owner are required for tunnel smoke.",
      );
    }

    await ensureDesktopOriginServer({
      controllerUrl,
      serviceRoleKey,
      ownerAccessToken,
      projectId,
    });

    const { tunnelUrl } = getDesktopOriginContext();
    test.skip(!tunnelUrl, "Controller returned no tunnel URL (tunnel broker likely not configured).");
    expect(typeof tunnelUrl).toBe("string");
    expect(tunnelUrl).toContain("rt.test");

    await waitForTunnelReady(page, tunnelUrl as string);
  });
});
