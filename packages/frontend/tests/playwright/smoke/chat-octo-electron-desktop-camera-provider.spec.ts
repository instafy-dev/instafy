import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureAuthenticatedSession,
  prepareStudio,
  resetRuntimeUserState,
  type AuthSessionSnapshot,
} from "../utils/harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));
const ENABLED = (process.env.PLAYWRIGHT_ELECTRON_DESKTOP_CAMERA ?? "").trim() === "1";

type BrowserSupabaseClient = {
  auth?: {
    setSession?: (session: {
      access_token: string;
      refresh_token: string;
    }) => Promise<unknown>;
  };
};

async function submitChatInput(page: Page, value: string) {
  await page.getByTestId("chat-input").fill(value);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("chat-send-button").click();
}

async function openExtensions(page: Page, appBaseUrl?: string | null) {
  const projectId = new URL(page.url()).searchParams.get("projectId")?.trim() ?? "";
  if (appBaseUrl && projectId) {
    const target = new URL("/studio", appBaseUrl);
    target.searchParams.set("projectId", projectId);
    target.searchParams.set("panel", "extensions");
    await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  } else {
    const dismissIntro = page.getByRole("button", { name: "Not now" }).first();
    if (await dismissIntro.isVisible().catch(() => false)) {
      await dismissIntro.click().catch(() => {});
    }

    const directEntry = page.getByTestId("sidebar-more-item-extensions").first();
    if (await directEntry.isVisible().catch(() => false)) {
      await directEntry.click({ force: true });
    } else {
      await page.getByTestId("sidebar-nav-more").click({ force: true });
      await page.getByTestId("sidebar-more-item-extensions").first().click({ force: true });
    }
  }
  await expect(page.getByTestId("extensions-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("extensions-provider-access-section")).toBeVisible({
    timeout: 15_000,
  });
}

async function returnToChat(page: Page) {
  const chatInput = page.getByTestId("chat-input");
  if (await chatInput.isVisible().catch(() => false)) {
    return;
  }
  const conversationTab = page
    .getByTestId("workspace-tabs")
    .getByRole("button", { name: /Conversation/i })
    .first();
  if (await conversationTab.isVisible().catch(() => false)) {
    await conversationTab.click();
    if (await chatInput.isVisible().catch(() => false)) {
      return;
    }
  }
  const homeButton = page.getByTestId("sidebar-home-button").first();
  if (await homeButton.isVisible().catch(() => false)) {
    await homeButton.click();
  } else {
    await page.getByRole("button", { name: "Open home" }).first().click();
  }
  if (await conversationTab.isVisible().catch(() => false)) {
    await conversationTab.click();
  }
  await expect(chatInput).toBeVisible({ timeout: 30_000 });
}

function findCameraRow(page: Page) {
  return page.locator('[data-testid^="project-provider-row-camera"]').first();
}

function findAttachedCameraRow(page: Page) {
  return page
    .locator('[data-testid^="project-provider-row-camera"]')
    .filter({
      hasNot: page.locator('[data-testid^="project-provider-attach-camera"]'),
    })
    .first();
}

async function restoreSessionIntoElectronPage(
  page: Page,
  appBaseUrl: string,
  session: AuthSessionSnapshot,
  projectId: string,
) {
  const loginUrl = new URL("/login", appBaseUrl);
  await page.goto(loginUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const client = (window as typeof window & {
        __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
      }).__INSTAFY_SUPABASE__;
      return !!client?.auth && typeof client.auth.setSession === "function";
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(
    async ({ accessToken, refreshToken }) => {
      const client = (window as typeof window & {
        __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
      }).__INSTAFY_SUPABASE__;
      await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    },
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    },
  );

  const studioUrl = new URL("/studio", appBaseUrl);
  studioUrl.searchParams.set("projectId", projectId);
  await page.goto(studioUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(page.url()).searchParams.get("projectId")).toBe(projectId);
}

async function attachElectronDesktopCameraProvider(page: Page, appBaseUrl: string) {
  await openExtensions(page, appBaseUrl);
  const providerRow = findCameraRow(page);
  await expect(providerRow).toBeVisible({ timeout: 30_000 });
  await expect(providerRow).toContainText("Ready", { timeout: 30_000 });

  const attachButton = providerRow.locator('[data-testid^="project-provider-attach-camera"]').first();
  if (await attachButton.isVisible().catch(() => false)) {
    await attachButton.click();
  }
  await expect(providerRow.locator('[data-testid^="project-provider-attach-camera"]')).toHaveCount(0, {
    timeout: 20_000,
  });
}

test.describe("Chat @octo Electron Desktop camera provider", () => {
  test.skip(!ENABLED, "Set PLAYWRIGHT_ELECTRON_DESKTOP_CAMERA=1 to run the Electron Desktop camera provider smoke.");
  test.skip(!fs.existsSync(DESKTOP_APP_DIST_MAIN), "Run pnpm -C packages/desktop-app build before this Electron smoke.");
  test.setTimeout(240_000);

  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let electronUserDataDir: string | null = null;

  test.afterEach(async ({ page }) => {
    await electronApp?.close().catch(() => {});
    electronApp = null;
    if (electronUserDataDir) {
      fs.rmSync(electronUserDataDir, { recursive: true, force: true });
      electronUserDataDir = null;
    }
    await resetRuntimeUserState(page, {
      source: "chat-octo-electron-desktop-camera-provider:cleanup",
    }).catch(() => {});
  });

  test("routes a camera capture from the Electron Desktop app to a browser Studio consumer", async ({
    page,
  }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    expect(projectId).toBeTruthy();
    const session = await captureAuthenticatedSession(page);
    expect(session?.accessToken).toBeTruthy();
    expect(session?.refreshToken).toBeTruthy();
    const appBaseUrl = new URL(page.url()).origin;
    const desktopStartUrl = new URL("/studio", appBaseUrl);
    desktopStartUrl.searchParams.set("projectId", projectId!);
    desktopStartUrl.searchParams.set("panel", "extensions");

    electronUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-electron-camera-"));
    electronApp = await electron.launch({
      executablePath: DESKTOP_APP_REQUIRE("electron"),
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        DESKTOP_APP_DIR,
      ],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        INSTAFY_APP_URL: desktopStartUrl.toString(),
        INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
        INSTAFY_DESKTOP_USER_DATA_DIR: electronUserDataDir,
      },
    });

    const desktopPage = await electronApp.firstWindow();
    await desktopPage.waitForLoadState("domcontentloaded");
    await restoreSessionIntoElectronPage(desktopPage, appBaseUrl, session!, projectId!);
    await attachElectronDesktopCameraProvider(desktopPage, appBaseUrl);

    await openExtensions(page);
    const consumerRow = findAttachedCameraRow(page);
    await expect(consumerRow).toBeVisible({ timeout: 30_000 });
    await consumerRow.locator('[data-testid^="project-provider-details-toggle-camera"]').first().click();
    const remoteDevicePanel = page.locator('[data-testid^="project-provider-camera-remote-device-camera"]').first();
    await expect(remoteDevicePanel).toContainText(/Desktop webcam|Fake Video Device/i, {
      timeout: 30_000,
    });
    await expect(remoteDevicePanel).toContainText("Online", { timeout: 30_000 });

    await returnToChat(page);
    await submitChatInput(page, "@octo take a photo");

    const assistantBubble = page
      .locator('[data-testid="chat-bubble-assistant"][data-message-type="local_capability_result"]')
      .last();
    await expect(assistantBubble).toContainText("captured a rear photo", { timeout: 45_000 });
    await expect(assistantBubble).toContainText(/Desktop webcam|Fake Video Device/i, {
      timeout: 45_000,
    });
    await expect(assistantBubble).not.toContainText(/is capturing|Waiting on/i);
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 2_000 });
  });
});
