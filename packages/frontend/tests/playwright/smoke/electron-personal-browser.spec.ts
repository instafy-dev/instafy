import { _electron as electron, expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));
const ENABLED = (process.env.PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER ?? "").trim() === "1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type PersonalBrowserStatus = {
  enabled: boolean;
  state: "closed" | "opening" | "ready" | "error";
  visible: boolean;
  agentControlEnabled: boolean;
  ownerId?: string;
  projectId?: string;
  url: string;
};

type PersonalBrowserBridge = {
  personalBrowserStatus: () => Promise<PersonalBrowserStatus>;
  personalBrowserOpen: (options: {
    projectId: string;
    controllerUrl: string;
    profileUserId: string;
    ownerId: string;
    url?: string;
  }) => Promise<PersonalBrowserStatus>;
  personalBrowserRelease: (options: {
    ownerId: string;
  }) => Promise<PersonalBrowserStatus>;
  personalBrowserSetBounds: (options: {
    x: number;
    y: number;
    width: number;
    height: number;
    visible?: boolean;
    ownerId: string;
  }) => Promise<PersonalBrowserStatus>;
  personalBrowserSetAgentControlEnabled: (options: {
    enabled: boolean;
    ownerId: string;
  }) => Promise<PersonalBrowserStatus>;
  personalBrowserNavigate: (options: {
    url: string;
    ownerId: string;
  }) => Promise<PersonalBrowserStatus>;
};

function fixtureHandler(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/me/session") {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    let userId = "";
    try {
      userId = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")).sub ?? "";
    } catch {
      // The response below intentionally fails closed for malformed fixture tokens.
    }
    response.statusCode = userId ? 200 : 401;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(userId ? { userId } : { error: "unauthorized" }));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/slow") {
    setTimeout(
      () => response.end("<!doctype html><title>Slow Personal page</title><p>ready</p>"),
      350,
    );
    return;
  }
  if (request.url === "/target") {
    response.end(`<!doctype html>
      <html><head><title>Personal Browser fixture</title></head>
      <body><h1>Persistent personal page</h1><button id="continue">Continue</button></body></html>`);
    return;
  }
  response.end(`<!doctype html>
    <html><head><title>Instafy desktop fixture</title>
    <script>
      (() => {
        let userId = "22222222-2222-4222-8222-222222222222";
        globalThis.__INSTAFY_SET_TEST_SESSION_USER_ID__ = (value) => { userId = value; };
        const encode = (value) => btoa(JSON.stringify(value))
          .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
        const session = () => {
          const expiresAt = Math.floor(Date.now() / 1000) + 3600;
          return {
            access_token: encode({ alg: "HS256", typ: "JWT" }) + "." +
              encode({ sub: userId, exp: expiresAt }) + ".fixture-signature",
            expires_at: expiresAt,
            user: { id: userId },
          };
        };
        globalThis.__INSTAFY_SUPABASE__ = { auth: {
          getSession: async () => ({ data: { session: session() } }),
          refreshSession: async () => ({ data: { session: session() } }),
        } };
      })();
    </script></head>
    <body><main><h1>Desktop host</h1></main></body></html>`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Personal Browser fixture did not receive a TCP port.");
  }
  return address.port;
}

test.describe("Electron Personal Browser", () => {
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER=1 to run the native Personal Browser smoke.",
  );
  test.skip(
    !fs.existsSync(DESKTOP_APP_DIST_MAIN),
    "Run pnpm --filter @instafy/desktop-app build before this Electron smoke.",
  );
  test.setTimeout(120_000);

  let fixtureServer: Server;
  let fixtureOrigin: string;
  let userDataDir: string;
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;

  test.beforeAll(async () => {
    fixtureServer = createServer(fixtureHandler);
    fixtureOrigin = `http://127.0.0.1:${await listen(fixtureServer)}`;
  });

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-personal-browser-"));
  });

  test.afterEach(async () => {
    await electronApp?.close().catch(() => undefined);
    electronApp = null;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  });

  const launchDesktop = async (featureEnabled?: boolean) => {
    const env = {
      ...process.env,
      INSTAFY_APP_URL: `${fixtureOrigin}/studio`,
      INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
      INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
    };
    if (featureEnabled === undefined) {
      delete env.INSTAFY_DESKTOP_PERSONAL_BROWSER;
    } else {
      env.INSTAFY_DESKTOP_PERSONAL_BROWSER = featureEnabled ? "1" : "0";
    }
    electronApp = await electron.launch({
      executablePath: DESKTOP_APP_REQUIRE("electron"),
      args: [DESKTOP_APP_DIR],
      cwd: REPO_ROOT,
      env,
    });
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    return page;
  };

  test("is enabled by default and rejects opening behind the explicit kill switch", async () => {
    let page = await launchDesktop();
    const defaultStatus = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop;
      if (!desktop) throw new Error("Desktop preload bridge is unavailable.");
      return desktop.personalBrowserStatus();
    });
    expect(defaultStatus.enabled).toBe(true);

    await electronApp.close();
    electronApp = null;
    page = await launchDesktop(false);
    const disabledStatus = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop;
      if (!desktop) throw new Error("Desktop preload bridge is unavailable.");
      return desktop.personalBrowserStatus();
    });
    expect(disabledStatus.enabled).toBe(false);

    const error = await page.evaluate(async ({ projectId, targetUrl }) => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      try {
        await desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId: "22222222-2222-4222-8222-222222222222",
          ownerId: "disabled-owner",
          url: targetUrl,
        });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    }, { projectId: PROJECT_ID, targetUrl: `${fixtureOrigin}/target` });
    expect(error).toContain("disabled");
  });

  test("persists one local profile across restarts and isolates another profile", async () => {
    const targetUrl = `${fixtureOrigin}/target`;
    let ownerSequence = 0;
    const openProfile = async (profileUserId: string) => {
      const page = electronApp ? await electronApp.firstWindow() : await launchDesktop(true);
      const ownerId = `e2e-owner-${ownerSequence += 1}`;
      const opened = await page.evaluate(async ({ projectId, profileUserId, ownerId, targetUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        (globalThis as { __INSTAFY_SET_TEST_SESSION_USER_ID__?: (userId: string) => void })
          .__INSTAFY_SET_TEST_SESSION_USER_ID__?.(profileUserId);
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
          url: targetUrl,
        });
      }, { projectId: PROJECT_ID, profileUserId, ownerId, targetUrl });
      // Opening or rebinding a local identity is never itself consent for the
      // agent. In particular, an account switch must require a fresh Resume.
      expect(opened.agentControlEnabled).toBe(false);
      const status = await page.evaluate(async (ownerId) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        await desktop.personalBrowserSetBounds({
          x: 20,
          y: 80,
          width: 640,
          height: 420,
          visible: true,
          ownerId,
        });
        return desktop.personalBrowserSetAgentControlEnabled({ enabled: true, ownerId });
      }, ownerId);
      expect(status.state).toBe("ready");
      expect(status.visible).toBe(true);
      expect(status.agentControlEnabled).toBe(true);
      expect(status.ownerId).toBe(ownerId);
      expect(status.projectId).toBe(PROJECT_ID);
      return page;
    };

    await launchDesktop(true);
    const firstPage = await openProfile("22222222-2222-4222-8222-222222222222");
    const beforeSameDocumentNavigation = await firstPage.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      const before = await desktop.personalBrowserStatus();
      window.history.pushState({}, "", "/studio#same-document-personal-browser-check");
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      return { before, after: await desktop.personalBrowserStatus() };
    });
    expect(beforeSameDocumentNavigation.after.ownerId).toBe(
      beforeSameDocumentNavigation.before.ownerId,
    );
    expect(beforeSameDocumentNavigation.after.agentControlEnabled).toBe(true);
    expect(beforeSameDocumentNavigation.after.visible).toBe(true);

    const firstView = await electronApp!.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Personal WebContentsView was not found.");
      await contents.executeJavaScript(
        "localStorage.setItem('personal-login-fixture', 'kept-on-device')",
      );
      contents.session.flushStorageData();
      return { id: contents.id, storagePath: contents.session.storagePath };
    }, targetUrl);
    expect(firstView.storagePath).toBeTruthy();
    expect(firstView.storagePath).not.toContain("22222222-2222-4222-8222-222222222222");

    const forgedClaimOwnerId = `e2e-owner-${ownerSequence += 1}`;
    const forgedClaim = await firstPage.evaluate(
      async ({ projectId, profileUserId, ownerId }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        // Deliberately do not switch the visible fixture session. A renderer
        // claim for another UUID must not select that UUID's native partition.
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
        });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "33333333-3333-4333-8333-333333333333",
        ownerId: forgedClaimOwnerId,
      },
    );
    expect(forgedClaim.ownerId).toBe(forgedClaimOwnerId);
    const afterForgedClaim = await electronApp!.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Personal WebContentsView was not found after forged claim.");
      return {
        id: contents.id,
        storagePath: contents.session.storagePath,
        value: await contents.executeJavaScript("localStorage.getItem('personal-login-fixture')"),
      };
    }, targetUrl);
    expect(afterForgedClaim.id).toBe(firstView.id);
    expect(afterForgedClaim.storagePath).toBe(firstView.storagePath);
    expect(afterForgedClaim.value).toBe("kept-on-device");

    const hidden = await firstPage.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      const status = await desktop.personalBrowserStatus();
      if (!status.ownerId) throw new Error("Personal Browser owner is unavailable.");
      return desktop.personalBrowserSetBounds({
        x: 20,
        y: 80,
        width: 640,
        height: 420,
        visible: false,
        ownerId: status.ownerId,
      });
    });
    expect(hidden.visible).toBe(false);
    const hiddenViewId = await electronApp!.evaluate(({ webContents }, url) => {
      return webContents.getAllWebContents().find(candidate => candidate.getURL() === url)?.id ?? null;
    }, targetUrl);
    expect(hiddenViewId).toBe(firstView.id);

    const releasedOwner = await firstPage.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      const before = await desktop.personalBrowserStatus();
      if (!before.ownerId) throw new Error("Personal Browser owner is unavailable.");
      const released = await desktop.personalBrowserRelease({ ownerId: before.ownerId });
      return { ownerId: before.ownerId, released };
    });
    expect(releasedOwner.released.state).toBe("ready");
    expect(releasedOwner.released.visible).toBe(false);
    expect(releasedOwner.released.agentControlEnabled).toBe(false);
    expect(releasedOwner.released.ownerId).toBeUndefined();
    expect(releasedOwner.released.url).toBe(targetUrl);

    const staleOwnerResult = await firstPage.evaluate(
      async ({ ownerId, url }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserNavigate({ ownerId, url });
      },
      { ownerId: releasedOwner.ownerId, url: `${fixtureOrigin}/slow` },
    );
    expect(staleOwnerResult.ownerId).toBeUndefined();
    expect(staleOwnerResult.url).toBe(targetUrl);

    const reclaimedOwnerId = `e2e-owner-${ownerSequence += 1}`;
    const reclaimed = await firstPage.evaluate(
      async ({ projectId, profileUserId, ownerId }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
        });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        ownerId: reclaimedOwnerId,
      },
    );
    expect(reclaimed.ownerId).toBe(reclaimedOwnerId);
    expect(reclaimed.agentControlEnabled).toBe(false);
    expect(reclaimed.url).toBe(targetUrl);
    const reclaimedViewId = await electronApp!.evaluate(({ webContents }, url) => {
      return webContents.getAllWebContents().find(candidate => candidate.getURL() === url)?.id ?? null;
    }, targetUrl);
    expect(reclaimedViewId).toBe(firstView.id);
    await firstPage.evaluate(async (ownerId) => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      await desktop.personalBrowserSetAgentControlEnabled({ enabled: true, ownerId });
    }, reclaimedOwnerId);
    // Cross the original lease deadline with enough margin for a busy Electron
    // main loop; the stale expiry must not close a successfully reclaimed view.
    await firstPage.waitForTimeout(12_000);
    const afterStaleExpiry = await firstPage.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      return desktop.personalBrowserStatus();
    });
    expect(afterStaleExpiry.state).toBe("ready");
    expect(afterStaleExpiry.ownerId).toBe(reclaimedOwnerId);
    expect(afterStaleExpiry.agentControlEnabled).toBe(true);

    const controlStayedEnabledDuringPause = await firstPage.evaluate(async (slowUrl) => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      const before = await desktop.personalBrowserStatus();
      if (!before.ownerId) throw new Error("Personal Browser owner is unavailable.");
      const navigation = desktop.personalBrowserNavigate({
        url: slowUrl,
        ownerId: before.ownerId,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      const pause = desktop.personalBrowserSetAgentControlEnabled({
        enabled: false,
        ownerId: before.ownerId,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      const revoked = await desktop.personalBrowserStatus();
      await Promise.allSettled([navigation, pause]);
      return revoked.agentControlEnabled;
    }, `${fixtureOrigin}/slow`);
    expect(controlStayedEnabledDuringPause).toBe(false);

    const reboundOwnerId = `e2e-owner-${ownerSequence += 1}`;
    const rebound = await firstPage.evaluate(
      async ({ projectId, profileUserId, ownerId, targetUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
          url: targetUrl,
        });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        ownerId: reboundOwnerId,
        targetUrl,
      },
    );
    expect(rebound.ownerId).toBe(reboundOwnerId);
    expect(rebound.agentControlEnabled).toBe(false);

    await electronApp!.close();
    electronApp = null;
    await launchDesktop(true);
    await openProfile("22222222-2222-4222-8222-222222222222");
    const restored = await electronApp!.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Restored Personal WebContentsView was not found.");
      return {
        storagePath: contents.session.storagePath,
        value: await contents.executeJavaScript("localStorage.getItem('personal-login-fixture')"),
      };
    }, targetUrl);
    expect(restored.storagePath).toBe(firstView.storagePath);
    expect(restored.value).toBe("kept-on-device");

    await openProfile("33333333-3333-4333-8333-333333333333");
    const isolated = await electronApp!.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Isolated Personal WebContentsView was not found.");
      return {
        storagePath: contents.session.storagePath,
        value: await contents.executeJavaScript("localStorage.getItem('personal-login-fixture')"),
      };
    }, targetUrl);
    expect(isolated.storagePath).not.toBe(firstView.storagePath);
    expect(isolated.value).toBeNull();
  });

  test("revokes ownership and control when the Studio renderer reloads", async () => {
    const targetUrl = `${fixtureOrigin}/target`;
    const ownerId = "reload-owner";
    const page = await launchDesktop(true);

    const staleOpen = page.evaluate(
      async ({ projectId, profileUserId, ownerId, slowUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
          url: slowUrl,
        });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        ownerId: "in-flight-reload-owner",
        slowUrl: `${fixtureOrigin}/slow`,
      },
    ).catch(() => null);
    await page.waitForTimeout(50);
    await page.reload({ waitUntil: "domcontentloaded" });
    await staleOpen;
    await page.waitForTimeout(400);
    const afterInFlightReload = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      return desktop.personalBrowserStatus();
    });
    expect(afterInFlightReload.ownerId).toBeUndefined();
    expect(afterInFlightReload.agentControlEnabled).toBe(false);
    expect(afterInFlightReload.visible).toBe(false);

    const queuedSeedOwner = "queued-reload-seed-owner";
    await page.evaluate(
      async ({ projectId, profileUserId, ownerId, targetUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
          url: targetUrl,
        });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        ownerId: queuedSeedOwner,
        targetUrl,
      },
    );
    const queuedOldRendererOpen = page.evaluate(
      async ({ projectId, profileUserId, seedOwnerId, queuedOwnerId, slowUrl, targetUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        const navigation = desktop.personalBrowserNavigate({ ownerId: seedOwnerId, url: slowUrl });
        await new Promise((resolve) => window.setTimeout(resolve, 10));
        const queuedOpen = desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId: queuedOwnerId,
          url: targetUrl,
        });
        return Promise.allSettled([navigation, queuedOpen]);
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        seedOwnerId: queuedSeedOwner,
        queuedOwnerId: "queued-old-renderer-owner",
        slowUrl: `${fixtureOrigin}/slow`,
        targetUrl,
      },
    ).catch(() => null);
    await page.waitForTimeout(75);
    await page.reload({ waitUntil: "domcontentloaded" });
    await queuedOldRendererOpen;
    await page.waitForTimeout(400);
    const afterQueuedOpenReload = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      return desktop.personalBrowserStatus();
    });
    expect(afterQueuedOpenReload.ownerId).toBeUndefined();
    expect(afterQueuedOpenReload.agentControlEnabled).toBe(false);
    expect(afterQueuedOpenReload.visible).toBe(false);

    const ready = await page.evaluate(
      async ({ projectId, profileUserId, ownerId, targetUrl }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        await desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          profileUserId,
          ownerId,
          url: targetUrl,
        });
        await desktop.personalBrowserSetBounds({
          x: 20,
          y: 80,
          width: 640,
          height: 420,
          visible: true,
          ownerId,
        });
        return desktop.personalBrowserSetAgentControlEnabled({ enabled: true, ownerId });
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
        ownerId,
        targetUrl,
      },
    );
    expect(ready.agentControlEnabled).toBe(true);
    expect(ready.visible).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    const released = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      return desktop.personalBrowserStatus();
    });
    expect(released.state).toBe("ready");
    expect(released.agentControlEnabled).toBe(false);
    expect(released.visible).toBe(false);
    expect(released.ownerId).toBeUndefined();
    expect(released.url).toBe(targetUrl);

    const staleOwnerResult = await page.evaluate(
      async ({ ownerId, url }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return desktop.personalBrowserNavigate({ ownerId, url });
      },
      { ownerId, url: `${fixtureOrigin}/slow` },
    );
    expect(staleOwnerResult.ownerId).toBeUndefined();
    expect(staleOwnerResult.url).toBe(targetUrl);

    const invalidReclaimError = await page.evaluate(
      async ({ projectId, profileUserId }) => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        try {
          await desktop.personalBrowserOpen({
            projectId,
            controllerUrl: window.location.origin,
            profileUserId,
            ownerId: "invalid-reclaim-owner",
            url: "javascript:alert(1)",
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      {
        projectId: PROJECT_ID,
        profileUserId: "22222222-2222-4222-8222-222222222222",
      },
    );
    expect(invalidReclaimError).toContain("only supports http, https, and about:blank URLs");

    await expect.poll(
      async () => page.evaluate(async () => {
        const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
        return (await desktop.personalBrowserStatus()).state;
      }),
      { timeout: 15_000 },
    ).toBe("closed");
    const expired = await page.evaluate(async () => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      return desktop.personalBrowserStatus();
    });
    expect(expired.state).toBe("closed");
    expect(expired.ownerId).toBeUndefined();
    expect(expired.projectId).toBeUndefined();
    expect(expired.url).toBe("about:blank");
  });
});
