import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearRuntimePreference,
  createControllerOrgAndProject,
  resetRuntimeUserState,
  type AuthSessionSnapshot,
} from "../utils/harness.js";
import { remoteSurfaceHasRenderedFrame } from "../utils/electronBrowserLiveHarness.js";
import { captureElectronBrowserWindow } from "../utils/electronBrowserScreenshots.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));
const ENABLED = (process.env.PLAYWRIGHT_ELECTRON_BROWSER_EXPERIENCE ?? "").trim() === "1";
const APP_BASE_URL = (
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ??
  "http://127.0.0.1:5199"
)
  .trim()
  .replace(/\/+$/g, "");
const ARTIFACT_DIR = path.resolve(
  process.env.BROWSER_EXPERIENCE_ARTIFACT_DIR ?? path.join(REPO_ROOT, "tmp", "browser-experience"),
);

if (ENABLED && !fs.existsSync(DESKTOP_APP_DIST_MAIN)) {
  throw new Error(
    "Electron browser experience requires a built desktop app. Run pnpm --filter @instafy/desktop-app build.",
  );
}

type BrowserSupabaseClient = {
  auth?: {
    setSession?: (session: {
      access_token: string;
      refresh_token: string;
    }) => Promise<unknown>;
  };
};

type ProvisionedStudio = {
  orgId: string;
  projectId: string;
  session: AuthSessionSnapshot;
  userId: string;
};

function requiredTestEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value.replace(/\/+$/g, "");
    }
  }
  throw new Error(`Electron browser experience requires ${keys.join(" or ")}.`);
}

async function provisionIsolatedStudio(page: Page): Promise<ProvisionedStudio> {
  const supabaseUrl = requiredTestEnv("VITE_SUPABASE_URL", "SUPABASE_URL");
  const anonKey = requiredTestEnv("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY");
  const serviceRole = requiredTestEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
  );
  const controllerUrl = requiredTestEnv("PLAYWRIGHT_CONTROLLER_URL", "VITE_CONTROLLER_URL");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const email = `electron-browser-${unique}@instafy.dev`;
  const password = `Browser-${unique}-Aa1!`;
  const adminHeaders = {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    "content-type": "application/json",
  };
  const createUserResponse = await page.context().request.post(
    `${supabaseUrl}/auth/v1/admin/users`,
    {
      headers: adminHeaders,
      data: {
        email,
        password,
        email_confirm: true,
        user_metadata: { e2e: "electron-browser-experience" },
      },
    },
  );
  if (!createUserResponse.ok()) {
    throw new Error(
      `Disposable Supabase user creation failed (${createUserResponse.status()}): ${await createUserResponse.text()}`,
    );
  }
  const userPayload = (await createUserResponse.json()) as { id?: string };
  if (!userPayload.id) {
    throw new Error("Disposable Supabase user creation did not return an id.");
  }

  let createdOrgId: string | null = null;
  try {
    const tokenResponse = await page.context().request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: { apikey: anonKey, "content-type": "application/json" },
      data: { email, password },
    },
  );
  if (!tokenResponse.ok()) {
    throw new Error(
      `Disposable Supabase login failed (${tokenResponse.status()}): ${await tokenResponse.text()}`,
    );
  }
  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
    throw new Error("Disposable Supabase login did not return a complete session.");
  }

    const created = await createControllerOrgAndProject(page.context().request, {
      accessToken: tokenPayload.access_token,
      controllerUrl,
      orgName: `Electron Browser ${unique}`,
      ownerUserId: userPayload.id,
      projectType: "customer",
    });
    createdOrgId = created.orgId;
    const session: AuthSessionSnapshot = {
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
    };

    await restoreSessionIntoPage(page, session, created.projectId);
    return {
      orgId: created.orgId,
      projectId: created.projectId,
      session,
      userId: userPayload.id,
    };
  } catch (error) {
    if (createdOrgId) {
      await page.context().request.delete(`${controllerUrl}/orgs/${createdOrgId}`, {
        headers: { authorization: `Bearer ${serviceRole}` },
      }).catch(() => undefined);
    }
    await page.context().request.delete(`${supabaseUrl}/auth/v1/admin/users/${userPayload.id}`, {
      headers: adminHeaders,
    }).catch(() => undefined);
    throw error;
  }
}

async function cleanupIsolatedStudio(page: Page, provisioned: ProvisionedStudio) {
  const supabaseUrl = requiredTestEnv("VITE_SUPABASE_URL", "SUPABASE_URL");
  const serviceRole = requiredTestEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
  );
  const controllerUrl = requiredTestEnv("PLAYWRIGHT_CONTROLLER_URL", "VITE_CONTROLLER_URL");
  const orgResponse = await page.context().request
    .delete(`${controllerUrl}/orgs/${provisioned.orgId}`, {
      headers: { authorization: `Bearer ${serviceRole}` },
    })
    .catch(() => null);
  if (orgResponse && !orgResponse.ok()) {
    console.warn(
      `[electron-browser-experience] organization cleanup returned ${orgResponse.status()}.`,
    );
  }
  const userResponse = await page.context().request.delete(
    `${supabaseUrl}/auth/v1/admin/users/${provisioned.userId}`,
    {
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
      },
    },
  ).catch(() => null);
  if (userResponse && !userResponse.ok()) {
    console.warn(`[electron-browser-experience] user cleanup returned ${userResponse.status()}.`);
  }
}

async function restoreSessionIntoPage(
  page: Page,
  session: AuthSessionSnapshot,
  projectId: string,
) {
  await page.goto(`${APP_BASE_URL}/login`, { waitUntil: "domcontentloaded" });
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
      if (!client?.auth?.setSession) {
        throw new Error("Supabase client is unavailable.");
      }
      await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    },
    session,
  );
  const studioUrl = new URL("/studio", APP_BASE_URL);
  studioUrl.searchParams.set("projectId", projectId);
  await page.goto(studioUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(page.url()).searchParams.get("projectId")).toBe(projectId);
}

async function restoreSessionIntoElectronPage(
  page: Page,
  session: AuthSessionSnapshot,
  projectId: string,
) {
  await restoreSessionIntoPage(page, session, projectId);
}

test.describe("Electron browser experience", () => {
  test.skip(!ENABLED, "Set PLAYWRIGHT_ELECTRON_BROWSER_EXPERIENCE=1 for the visual desktop flow.");
  test.setTimeout(420_000);

  test("keeps Shared and Personal Browser visually unified without remounting Shared", async ({
    page: browserPage,
  }) => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const provisioned = await provisionIsolatedStudio(browserPage);
    const { projectId, session } = provisioned;
    let userDataDir: string | null = null;
    let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;

    try {
      await clearRuntimePreference(browserPage, {
        projectId,
        source: "electron-browser-experience",
      });
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-browser-experience-"));
      const desktopStartUrl = new URL("/studio", APP_BASE_URL);
      desktopStartUrl.searchParams.set("projectId", projectId);
      electronApp = await electron.launch({
        executablePath: DESKTOP_APP_REQUIRE("electron"),
        args: [DESKTOP_APP_DIR],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          INSTAFY_APP_URL: desktopStartUrl.toString(),
          INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
          INSTAFY_DESKTOP_PERSONAL_BROWSER: "1",
          INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
        },
      });
      const page = await electronApp.firstWindow();

      const captureDesktop = async (name: string, includePersonal = false) => {
        const capture = await captureElectronBrowserWindow(electronApp, page, {
          includePersonal,
        });
        if (capture.personalViewportPng) {
          fs.writeFileSync(
            path.join(ARTIFACT_DIR, "electron-personal-browser-viewport.png"),
            capture.personalViewportPng,
          );
        }
        const screenshotPath = path.join(ARTIFACT_DIR, name);
        fs.writeFileSync(screenshotPath, capture.windowPng);
        return screenshotPath;
      };

      await page.waitForLoadState("domcontentloaded");
      await restoreSessionIntoElectronPage(page, session, projectId);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        window?.setSize(1440, 900);
        window?.center();
      });
      await captureDesktop("electron-studio-before-browser.png");

      const dismissIntro = page.getByRole("button", { name: "Not now" }).first();
      if (await dismissIntro.isVisible().catch(() => false)) {
        await dismissIntro.click();
      }
      const conversationTab = page
        .getByTestId("workspace-tabs")
        .getByRole("button", { name: /Conversation/i })
        .first();
      if (await conversationTab.isVisible().catch(() => false)) {
        await conversationTab.click();
      }
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("instafy:browser-open", { detail: {} }));
      });

      const sharedButton = page.getByTestId("browser-transport-shared");
      await expect(sharedButton).toBeVisible({ timeout: 30_000 });
      await sharedButton.click();

      const shared = page.getByTestId("browser-session-modal");
      await expect(shared).toBeVisible({ timeout: 60_000 });
      await expect(shared.getByTestId("browser-session-status")).toContainText("Ready", {
        timeout: 240_000,
      });
      await expect
        .poll(async () => await shared.locator("canvas:visible, video:visible").count(), {
          timeout: 60_000,
        })
        .toBe(1);

      const stage = shared.getByTestId("browser-session-stage");
      await expect(stage).toHaveAttribute("data-shared-browser-viewer", "webrtc", {
        timeout: 60_000,
      });
      const initialViewer = await stage.getAttribute("data-shared-browser-viewer");
      expect(initialViewer).toBe("webrtc");
      console.info(`[electron-browser-experience] Shared viewer: ${initialViewer ?? "unknown"}`);
      const sharedSurface = shared.locator("canvas:visible, video:visible");
      await sharedSurface.evaluate(element => {
        element.setAttribute("data-electron-browser-surface", "original");
      });

      const sharedChrome = shared.getByTestId("shared-browser-chrome");
      const sharedAddress = sharedChrome.getByTestId("shared-browser-address");
      await sharedAddress.fill("https://example.com");
      await sharedAddress.press("Enter");
      await expect(sharedAddress).toHaveValue("https://example.com/", { timeout: 45_000 });
      await expect(shared.getByTestId("browser-session-reconnecting")).toBeHidden({
        timeout: 45_000,
      });
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface), { timeout: 45_000 })
        .toBe(true);

      const sharedGeometry = await Promise.all([
        sharedChrome.boundingBox(),
        stage.boundingBox(),
        page.getByTestId("chat-composer-overlay").boundingBox(),
      ]);
      expect(sharedGeometry[0]?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(52);
      expect(sharedGeometry[2]?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
      expect(
        Math.abs(
          (sharedGeometry[2]?.y ?? 0) -
            ((sharedGeometry[1]?.y ?? 0) + (sharedGeometry[1]?.height ?? 0)),
        ),
      ).toBeLessThanOrEqual(2);
      await captureDesktop("electron-shared-browser.png");

      const personalButton = page.getByTestId("browser-transport-personal");
      await expect(personalButton).toBeEnabled({ timeout: 30_000 });
      await personalButton.click();

      const personal = page.getByTestId("personal-browser-surface");
      await expect(personal).toBeVisible({ timeout: 30_000 });
      await expect(
        shared.locator('[data-electron-browser-surface="original"]'),
      ).toHaveAttribute("data-active", "false");
      await expect(page.getByTestId("personal-browser-agent-status")).toBeVisible({
        timeout: 60_000,
      });
      const personalAddress = page.getByTestId("personal-browser-address");
      await personalAddress.fill("https://example.com");
      await personalAddress.press("Enter");
      await expect(personalAddress).toHaveValue("https://example.com/", { timeout: 45_000 });
      const personalNavigation = await electronApp.evaluate(
        async ({ BrowserWindow, webContents }, expectedUrl) => {
          const mainWindow = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
          const mainId = mainWindow?.webContents.id;
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline) {
            const personalContents = webContents
              .getAllWebContents()
              .find(candidate =>
                candidate.id !== mainId &&
                !candidate.isDestroyed() &&
                candidate.getURL().startsWith(expectedUrl),
              );
            if (personalContents && !personalContents.isLoading()) {
              return { loading: false, url: personalContents.getURL() };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return { loading: true, url: "" };
        },
        "https://example.com/",
      );
      expect(personalNavigation).toEqual({ loading: false, url: "https://example.com/" });
      await captureDesktop("electron-personal-browser.png", true);

      await sharedButton.click();
      await expect(shared).toBeVisible({ timeout: 30_000 });
      const originalSharedSurface = shared.locator(
        '[data-electron-browser-surface="original"]',
      );
      if ((await originalSharedSurface.count()) === 0) {
        const browserDebug = await page.evaluate(() => {
          const runtimeWindow = window as typeof window & {
            __INSTAFY_RUNTIME_DEBUG__?: Array<{ message?: unknown; data?: unknown }>;
          };
          return (runtimeWindow.__INSTAFY_RUNTIME_DEBUG__ ?? [])
            .filter(entry => String(entry.message ?? "").startsWith("browser-session:"))
            .slice(-30);
        });
        console.info(
          `[electron-browser-experience] Shared continuity debug: ${JSON.stringify(browserDebug)}`,
        );
      }
      await expect(originalSharedSurface).toBeVisible();
      await expect(originalSharedSurface).toHaveAttribute("data-active", "true");
      await expect(stage).toHaveAttribute("data-shared-browser-viewer", initialViewer ?? "rfb");
      await expect(shared.getByTestId("browser-session-reconnecting")).toBeHidden({
        timeout: 45_000,
      });
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface), { timeout: 45_000 })
        .toBe(true);

      // Exercise the common Studio split-pane case without shrinking the
      // BrowserWindow. Adaptive rendering and compact chrome must follow the
      // actual ChatPanel width, not a global media query.
      const chatPanelRoot = page.getByTestId("chat-panel-root");
      await chatPanelRoot.evaluate((element) => {
        element.style.width = "520px";
        element.style.maxWidth = "520px";
        element.style.flex = "0 0 520px";
        element.style.alignSelf = "flex-start";
      });
      await expect
        .poll(async () => (await chatPanelRoot.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
        .toBeLessThanOrEqual(520);
      await expect(stage).toHaveAttribute(
        "data-shared-browser-viewer",
        "cdp-screencast",
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("browser-transport-selector")).toHaveAttribute(
        "data-compact",
        "true",
      );
      const splitCdpSurface = shared.getByTestId("shared-browser-cdp-screencast");
      await expect(splitCdpSurface).toHaveAttribute("data-active", "true");
      await splitCdpSurface.evaluate((element) => {
        element.setAttribute("data-electron-browser-surface", "split-cdp-original");
      });

      await personalButton.click();
      await expect(personal).toBeVisible({ timeout: 30_000 });
      await expect(splitCdpSurface).toHaveAttribute("data-active", "false");
      await sharedButton.click();
      await expect(shared).toBeVisible({ timeout: 30_000 });
      const originalSplitCdpSurface = shared.locator(
        '[data-electron-browser-surface="split-cdp-original"]',
      );
      await expect(originalSplitCdpSurface).toBeVisible();
      await expect(originalSplitCdpSurface).toHaveAttribute("data-active", "true");
      await expect(shared.getByTestId("browser-session-reconnecting")).toBeHidden({
        timeout: 45_000,
      });

      await chatPanelRoot.evaluate((element) => {
        element.style.removeProperty("width");
        element.style.removeProperty("max-width");
        element.style.removeProperty("flex");
        element.style.removeProperty("align-self");
      });
      await expect
        .poll(async () => (await chatPanelRoot.boundingBox())?.width ?? 0)
        .toBeGreaterThan(640);
      await expect(stage).toHaveAttribute("data-shared-browser-viewer", "webrtc", {
        timeout: 45_000,
      });

      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        window?.setSize(480, 900);
      });
      await expect
        .poll(async () => await page.evaluate(() => window.innerWidth), { timeout: 15_000 })
        .toBeLessThanOrEqual(480);
      await expect(stage).toHaveAttribute(
        "data-shared-browser-viewer",
        "cdp-screencast",
        { timeout: 45_000 },
      );
      await expect
        .poll(async () => {
          return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        })
        .toBe(true);
      await expect(shared.getByTestId("browser-session-reconnecting")).toBeHidden({
        timeout: 45_000,
      });
      await expect
        .poll(() => remoteSurfaceHasRenderedFrame(sharedSurface), { timeout: 45_000 })
        .toBe(true);
      await expect(page.getByTestId("browser-transport-selector")).toHaveAttribute(
        "data-compact",
        "true",
      );
      await captureDesktop("electron-shared-browser-narrow.png");
    } finally {
      await electronApp?.close().catch(() => undefined);
      await resetRuntimeUserState(browserPage, {
        source: "electron-browser-experience:cleanup",
      }).catch(() => {});
      if (userDataDir) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
      await cleanupIsolatedStudio(browserPage, provisioned);
    }
  });
});
