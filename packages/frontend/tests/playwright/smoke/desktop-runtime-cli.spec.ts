import { test, expect } from "@playwright/test";
import {
  ensureRealDefaultCodexCredentialWhenRequired,
  resolveAuthenticatedAccessToken,
  prepareStudio,
  requireWorkspaceProjectId,
  setRuntimePreference,
  resetRuntimeUserState,
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

test.describe.serial("Desktop runtime via CLI", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    process.env.PLAYWRIGHT_DESKTOP_RUNTIME_MODE = "cli";
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
  });

  test.afterEach(async ({ page }) => {
    await stopDesktopOriginServer().catch(() => {});
    await resetRuntimeUserState(page, { source: "desktop-runtime-cli:cleanup" }).catch(() => {});
  });

  test("starts desktop runtime via CLI and prefers it in Studio", async ({ page }) => {
    const controllerUrl = getControllerUrl();
    const serviceRoleKey = resolveServiceRoleKey();
    const ownerAccessToken = await resolveAuthenticatedAccessToken(page);
    const projectId = await requireWorkspaceProjectId(page);
    if (!controllerUrl || !serviceRoleKey || !ownerAccessToken) {
      throw new Error(
        "Controller URL, service role key, and authenticated owner are required for desktop runtime test",
      );
    }

    await ensureDesktopOriginServer({
      controllerUrl,
      serviceRoleKey,
      ownerAccessToken,
      projectId,
    });

    const { runtimeId } = getDesktopOriginContext();
    if (!runtimeId) {
      throw new Error("Desktop runtime ID was not recorded after CLI start.");
    }
    await setRuntimePreference(page, projectId, runtimeId, "desktop-runtime-cli");

    await page.reload();

    const runtimeButton = page.getByTestId("runtime-selector-button").first();
    await expect(runtimeButton).toBeVisible({ timeout: 60_000 });
    await expect(runtimeButton).toContainText("Instafy CLI Runtime", { timeout: 120_000 });

    const sendButton = page.getByTestId("chat-send-button");
    const promptText = `Desktop CLI runtime check ${Date.now()}`;
    await page.getByTestId("chat-input").fill(promptText);
    await expect(sendButton).toBeEnabled({ timeout: 180_000 });
    const requestPromise = page.waitForRequest((request) => {
      if (request.method() !== "POST") {
        return false;
      }
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return false;
      }
      // The ambient participation classifier also POSTs the draft content to
      // /conversations/:id/participation/resolve; only the /messages dispatch
      // carries the runtime pin this test asserts on.
      if (!url.pathname.includes("/conversations") || !url.pathname.endsWith("/messages")) {
        return false;
      }
      const body = request.postData();
      return typeof body === "string" && body.includes(promptText);
    });
    await sendButton.click();
    const conversationRequest = await requestPromise;
    let requestPayload: Record<string, unknown> | null = null;
    try {
      const rawBody = conversationRequest.postData();
      requestPayload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
    } catch {
      requestPayload = null;
    }
    expect(requestPayload?.runtimeId).toBe(runtimeId);
    const userBubble = page.getByTestId("chat-bubble-user").last();
    await expect(userBubble).toContainText(promptText, { timeout: 180_000 });

    const statusResponse = await page.context().request.get(
      `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
      {
        headers: { authorization: `Bearer ${serviceRoleKey}` },
      },
    );
    expect(statusResponse.ok()).toBeTruthy();
    const payload = (await statusResponse.json()) as {
      runtimes?: Array<Record<string, unknown>>;
    };
    const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
    const matching = runtimes.find((entry: Record<string, unknown>) => {
      const id =
        typeof entry.runtimeId === "string"
          ? entry.runtimeId
          : typeof entry.runtime_id === "string"
            ? entry.runtime_id
            : null;
      return runtimeId ? id === runtimeId : typeof id === "string";
    });
    expect(matching).toBeTruthy();
    const idleTtlSeconds =
      typeof matching?.["idleTtlSeconds"] === "number"
        ? (matching["idleTtlSeconds"] as number)
        : typeof matching?.["idle_ttl_seconds"] === "number"
          ? (matching["idle_ttl_seconds"] as number)
          : null;
    expect(typeof idleTtlSeconds === "number" && idleTtlSeconds >= 300).toBeTruthy();
    const origin = matching?.["origin"] ?? matching?.["origin_info"];
    const originEndpoint =
      origin && typeof origin === "object" ? (origin as Record<string, unknown>).endpoint : null;
    expect(typeof originEndpoint === "string" && originEndpoint.length > 0).toBeTruthy();
  });
});
