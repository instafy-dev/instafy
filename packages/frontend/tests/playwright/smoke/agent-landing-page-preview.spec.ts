import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudio,
  resolveAuthenticatedAccessToken,
  requireWorkspaceProjectId,
  setRuntimePreference,
  resetRuntimeUserState,
  getControllerUrl,
  readWorkspaceFileText,
  writeWorkspaceFile,
  fetchWorkspaceRawText,
  expectAssistantReplyOrSkipRateLimit,
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

function resolveTunnelSmokeEnabled(): boolean {
  return (
    (process.env.PLAYWRIGHT_TUNNEL_BROKER_SMOKE ??
      process.env.TUNNEL_BROKER_SMOKE ??
      "0").trim() === "1"
  );
}

function extractHttpUrls(text: string): string[] {
  const matches = String(text ?? "").match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  const urls: string[] = [];
  for (const match of matches) {
    const candidate = match.replace(/[)\],.]+$/g, "");
    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
      try {
        urls.push(new URL(candidate).toString());
      } catch {
        // ignore malformed URLs and keep scanning
      }
    }
  }
  return urls;
}

function isLocalHostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return true;
  }
}

async function ensurePreferredDesktopRuntime(page: Page): Promise<{
  controllerUrl: string;
  serviceRoleKey: string;
  projectId: string;
  runtimeId: string;
}> {
  const controllerUrl = getControllerUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  const ownerAccessToken = await resolveAuthenticatedAccessToken(page);
  const projectId = await requireWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRoleKey || !ownerAccessToken) {
    throw new Error(
      "Controller URL, service role key, and authenticated owner are required for landing page preview test.",
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

  await setRuntimePreference(page, projectId, runtimeId, "agent-landing-page-preview");
  await page.reload();

  const runtimeButton = page.getByTestId("runtime-selector-button").first();
  await expect(runtimeButton).toBeVisible({ timeout: 60_000 });
  await expect(runtimeButton).toContainText("Instafy CLI Runtime", { timeout: 120_000 });

  return {
    controllerUrl,
    serviceRoleKey,
    projectId,
    runtimeId,
  };
}

test.describe.serial("Agent landing page preview", () => {
  test.skip(
    (process.env.PLAYWRIGHT_LIVE_AGENT_PREVIEW ?? "").trim() !== "1",
    "Live assistant preview generation is model-dependent; opt in with PLAYWRIGHT_LIVE_AGENT_PREVIEW=1."
  );
  test.setTimeout(360_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    process.env.PLAYWRIGHT_DESKTOP_RUNTIME_MODE = "cli";
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await stopDesktopOriginServer().catch(() => {});
    await resetRuntimeUserState(page, { source: "agent-landing-page-preview:cleanup" }).catch(() => {});
  });

  test("creates index.html and serves it via origin raw URL", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
    );
    const { projectId, runtimeId } = await ensurePreferredDesktopRuntime(page);

    const firmName = "X";
    const email = "x@y.z";

    const prompt = [
      "Create a simple text-based landing page for my architecture firm.",
      `Firm name: ${firmName}`,
      `Contact email: ${email}`,
      "We do museums.",
      "",
      'Create a file named "index.html" in the workspace root.',
      "Use plain HTML only (no external assets).",
      "Include the firm name, a short tagline about museums, and the contact email.",
    ].join("\n");

    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();

    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    await expect(typingIndicator).toBeVisible({ timeout: 10_000 });
    const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
    await expect(assistantResponses.first()).toBeVisible({ timeout: 240_000 });
    await expect(typingIndicator).toHaveCount(0, { timeout: 240_000 });

    const changeSummary = page.getByTestId("chat-file-change-summary").last();
    await expect(changeSummary).toBeVisible({ timeout: 240_000 });
    await expect(changeSummary).toContainText("file");
    await expect(changeSummary).toContainText("index.html");

    await expect
      .poll(async () => await readWorkspaceFileText(page, "index.html", { projectId, preferRuntimeId: runtimeId }), {
        timeout: 120_000,
      })
      .toContain(firmName);

    const raw = await fetchWorkspaceRawText(page, "index.html", {
      projectId,
      preferRuntimeId: runtimeId,
    });
    if (!raw) {
      throw new Error("Failed to fetch raw HTML from origin.");
    }
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toContain(firmName);
    expect(raw.body.toLowerCase()).toMatch(/\bmuseum(s)?\b/);
    expect(raw.body).toContain(email);

    await changeSummary.getByTestId("chat-file-change-review").click();
    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("git-review-rolling-diff")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("git-review-mode-focused").click();
    await expect(page.getByTestId("git-review-diff-header-new")).toContainText("b/index.html", {
      timeout: 60_000,
    });

    await page.goBack();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    const applyingChangesBubble = page.locator('[data-testid="chat-bubble-assistant"]', {
      hasText: /Applying changes to workspace/i,
    });
    await expect
      .poll(async () => await applyingChangesBubble.count(), { timeout: 120_000 })
      .toBe(0);
  });

  test("provisions a public preview URL backed by a controller tunnel grant", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
    );
    test.skip(
      !resolveTunnelSmokeEnabled(),
      "Set PLAYWRIGHT_TUNNEL_BROKER_SMOKE=1 (or TUNNEL_BROKER_SMOKE=1) to enable tunnel-grant preview assertions."
    );

    process.env.PLAYWRIGHT_DESKTOP_ORIGIN_USE_TUNNEL = "1";
    const { controllerUrl, serviceRoleKey, projectId } =
      await ensurePreferredDesktopRuntime(page);

    const firmName = "Tunnel & Arch";
    const prompt = [
      "Create a very small one-page landing page for an architecture firm.",
      `Firm name: ${firmName}`,
      'Write it to "index.html" in the workspace root.',
      "Use plain HTML only.",
      "Do not use Python.",
      "Then provide a public preview URL I can open from another device.",
      "Reply with the URL explicitly in your answer.",
    ].join("\n");

    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();

    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    await expect(typingIndicator).toBeVisible({ timeout: 10_000 });

    const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
    await expect(assistantResponses.first()).toBeVisible({ timeout: 300_000 });

    let assistantPreviewUrl: string | null = null;
    let lastSeenUrl: string | null = null;
    const deadline = Date.now() + 120_000;
    while (!assistantPreviewUrl && Date.now() < deadline) {
      const latest = (await assistantResponses.last().innerText().catch(() => "")).trim();
      const texts = [latest, ...(await assistantResponses.allTextContents().catch(() => []))];
      for (let idx = 0; idx < texts.length; idx += 1) {
        const foundUrls = extractHttpUrls(String(texts[idx] ?? ""));
        if (foundUrls.length > 0) {
          lastSeenUrl = foundUrls[foundUrls.length - 1] ?? lastSeenUrl;
        }
        for (const found of foundUrls) {
          if (!isLocalHostUrl(found)) {
            assistantPreviewUrl = found;
            break;
          }
        }
        if (assistantPreviewUrl) {
          break;
        }
      }
      if (!assistantPreviewUrl) {
        await page.waitForTimeout(1500);
      }
    }

    const grantsResponse = await page.context().request.get(
      `${controllerUrl}/projects/${encodeURIComponent(projectId)}/tunnels`,
      {
        headers: {
          authorization: `Bearer ${serviceRoleKey}`,
          accept: "application/json",
        },
      }
    );
    if (!grantsResponse.ok()) {
      const body = await grantsResponse.text().catch(() => "");
      throw new Error(
        `Failed to read tunnel grants (${grantsResponse.status()} ${grantsResponse.statusText()}): ${body.slice(0, 300)}`
      );
    }

    const grantsBody = (await grantsResponse.json()) as {
      grants?: Array<Record<string, unknown>>;
    };
    const grants = Array.isArray(grantsBody.grants) ? grantsBody.grants : [];
    expect(grants.length).toBeGreaterThan(0);

    const firstPublicGrantUrl = grants
      .map((grant) => {
        if (typeof grant.url === "string" && grant.url.trim().length > 0) {
          return grant.url.trim();
        }
        if (typeof grant.hostname === "string" && grant.hostname.trim().length > 0) {
          return `https://${grant.hostname.trim()}`;
        }
        return null;
      })
      .find((value): value is string => Boolean(value));
    expect(firstPublicGrantUrl).toBeTruthy();
    if (firstPublicGrantUrl) {
      expect(isLocalHostUrl(firstPublicGrantUrl)).toBeFalsy();
    }

    const previewUrl = assistantPreviewUrl ?? firstPublicGrantUrl;
    if (!previewUrl) {
      const latestText = (await assistantResponses.last().innerText().catch(() => "")).trim();
      throw new Error(
        `Expected a non-local preview URL from assistant or tunnel grants. lastSeenUrl=${lastSeenUrl ?? "null"} latest=${latestText.slice(0, 300)}`
      );
    }
    const previewHost = new URL(previewUrl).hostname.toLowerCase();
    expect(previewHost).not.toBe("127.0.0.1");
    expect(previewHost).not.toBe("localhost");

  });

  test("does not fail when provisioning a preview without writing workspace files", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
    );

    const { projectId, runtimeId } = await ensurePreferredDesktopRuntime(page);

    await writeWorkspaceFile(
      page,
      "index.html",
      "<!doctype html><html><head><meta charset=\"utf-8\" /><title>Existing</title></head><body><h1>Existing landing page</h1></body></html>",
      { projectId }
    );

    await expect
      .poll(async () => await readWorkspaceFileText(page, "index.html", { projectId, preferRuntimeId: runtimeId }), {
        timeout: 60_000,
      })
      .toContain("Existing landing page");

    const prompt = [
      "We already have an index.html landing page in the workspace root.",
      "Do not create, edit, modify, update, or delete any files.",
      "Do not use apply_patch.",
      "Do not run any terminal commands.",
      "Return an empty `files` array.",
      "Just start a frontend preview and give me a preview URL I can open in a browser.",
      "Reply with the URL explicitly in your answer.",
    ].join("\n");

    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId("chat-send-button").click();

    await expectAssistantReplyOrSkipRateLimit(
      page,
      /(https?:\/\/|preview|unable|cannot|can't|could not)/i,
      { timeout: 300_000 }
    );

    await expect(page.getByText(/Codex did not apply any workspace changes/i)).toHaveCount(0);

    const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
    const latestText = (await assistantResponses.last().innerText().catch(() => "")).trim();
    const urls = extractHttpUrls(latestText);
    if (urls.length === 0) {
      expect(latestText.toLowerCase()).toMatch(/preview|unable|cannot|can't|could not/);
    }
  });
});
