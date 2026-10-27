import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { personalBrowserFixtureEnvironment } from "../../../scripts/browser-ci.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));
const ENABLED = (process.env.PLAYWRIGHT_ELECTRON_PERSONAL_BROWSER ?? "").trim() === "1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROFILE_USER_ID = "33333333-3333-4333-8333-333333333333";

if (ENABLED && !fs.existsSync(DESKTOP_APP_DIST_MAIN)) {
  throw new Error(
    "Personal Browser was explicitly enabled but the Desktop build is missing. " +
      "Run pnpm --filter @instafy/desktop-app build before this Electron smoke.",
  );
}

type PersonalBrowserStatus = {
  enabled: boolean;
  state: "closed" | "opening" | "ready" | "error";
  visible: boolean;
  agentControlEnabled: boolean;
  ownerId?: string;
  projectId?: string;
  url: string;
  tabs?: Array<{ id: string; openedBy: "person" | "agent"; active: boolean; url: string }>;
  activeTabId?: string;
  maxAgentTabs?: number;
};

type PersonalBrowserBridge = {
  personalBrowserStatus: () => Promise<PersonalBrowserStatus>;
  personalBrowserOpen: (options: {
    projectId: string;
    controllerUrl: string;
    controllerAccessToken: string;
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
  personalBrowserClose: (options: { ownerId: string }) => Promise<PersonalBrowserStatus>;
  personalBrowserSelectTab: (options: { ownerId: string; tabId: string }) => Promise<PersonalBrowserStatus>;
  personalBrowserCloseTab: (options: { ownerId: string; tabId: string }) => Promise<PersonalBrowserStatus>;
  personalBrowserClearData: (options: { ownerId: string }) => Promise<PersonalBrowserStatus>;
};

type PersonalBrowserFixtureWindow = typeof window & {
  instafyDesktop: PersonalBrowserBridge;
  __INSTAFY_TEST_SESSION__: () => { access_token: string };
};

// Host names and paths the fixture server saw for the request guard's pages.
const guardRequestHosts: string[] = [];
const guardRequests: string[] = [];

// A WebSocket on the fixture server: it answers one text message.
function fixtureUpgrade(request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex) {
  if (request.url !== "/guard/socket") {
    socket.destroy();
    return;
  }
  const [hostName = ""] = String(request.headers.host ?? "").split(":");
  guardRequests.push(`${hostName}${request.url}`);
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const payload = Buffer.from("private socket data");
  socket.end(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}

function fixtureHandler(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  if (request.url?.startsWith("/guard/")) {
    const [hostName = "", port = ""] = String(request.headers.host ?? "").split(":");
    guardRequestHosts.push(hostName);
    guardRequests.push(`${hostName}${request.url}`);
    if (request.url === "/guard/data") {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("private data");
      return;
    }
    if (request.url === "/guard/to-link-only") {
      response.statusCode = 302;
      response.setHeader("Location", `http://www.booking.com:${port}/guard/page`);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Guarded fixture</title><p>guarded fixture page</p>");
    return;
  }
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
  if (request.url === "/cookie-login/a" || request.url === "/cookie-login/b") {
    const identity = request.url.endsWith("/a") ? "a" : "b";
    response.setHeader("Set-Cookie", [
      `personal-visible=fixture-${identity}; Max-Age=3600; Path=/; SameSite=Lax`,
      `personal-http-only=secret-${identity}; Max-Age=3600; Path=/; SameSite=Lax; HttpOnly`,
    ]);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url === "/cookie-echo") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ cookies: request.headers.cookie ?? "" }));
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
      <body><h1>Persistent personal page</h1><button id="continue">Continue</button>
      <form id="fixture-details" aria-label="Details">
        <button id="fixture-button" type="button">Show details</button>
        <button id="fixture-reset" type="reset">Start again</button>
        <button id="fixture-no-owner" form="fixture-missing">No associated form</button>
      </form>
      <button id="fixture-default" form="fixture-details">Continue</button>
      <button id="fixture-submit" type="submit" form="fixture-details">Continue</button>
      <button id="fixture-normalized" type="unknown" form="fixture-details">Continue</button>
      <input id="fixture-notes" form="fixture-details" aria-label="Notes">
      <form id="order-details">
        <button id="fixture-order">Place order</button>
        <input id="fixture-order-notes" aria-label="Delivery note">
      </form>
      </body></html>`);
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
        const sessions = new Map();
        const session = () => {
          if (sessions.has(userId)) return sessions.get(userId);
          const expiresAt = Math.floor(Date.now() / 1000) + 3600;
          const value = {
            access_token: encode({ alg: "HS256", typ: "JWT" }) + "." +
              encode({ sub: userId, exp: expiresAt }) + ".fixture-signature",
            expires_at: expiresAt,
            user: { id: userId },
          };
          sessions.set(userId, value);
          return value;
        };
        globalThis.__INSTAFY_TEST_SESSION__ = session;
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
  test.setTimeout(120_000);

  let fixtureServer: Server;
  let fixtureOrigin: string;
  let userDataDir: string;
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let currentTracePath: string | null = null;
  let tracePaths: string[] = [];

  const closeDesktop = async () => {
    const current = electronApp;
    if (!current) return;
    const tracePath = currentTracePath;
    currentTracePath = null;
    try {
      if (tracePath) await current.context().tracing.stop({ path: tracePath });
    } finally {
      await current.close();
      if (electronApp === current) electronApp = null;
    }
  };

  test.beforeAll(async () => {
    fixtureServer = createServer(fixtureHandler);
    fixtureServer.on("upgrade", fixtureUpgrade);
    fixtureOrigin = `http://127.0.0.1:${await listen(fixtureServer)}`;
  });

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-personal-browser-"));
    tracePaths = [];
  });

  test.afterEach(async ({}, testInfo) => {
    let cleanupFailed = false;
    try {
      await closeDesktop();
    } catch (error) {
      cleanupFailed = true;
      throw error;
    } finally {
      try {
        if (cleanupFailed || testInfo.status !== testInfo.expectedStatus) {
          for (const tracePath of tracePaths) {
            if (fs.existsSync(tracePath)) {
              await testInfo.attach(path.basename(tracePath), {
                path: tracePath,
                contentType: "application/zip",
              });
            }
          }
        }
      } finally {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  });

  const launchDesktop = async (featureEnabled?: boolean) => {
    // The fixture supplies its own inert identity and uses a disposable profile;
    // do not forward controller/model credentials or an operator's app settings.
    const env: Record<string, string> = {
      ...personalBrowserFixtureEnvironment(process.env),
      TMPDIR: os.tmpdir(),
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
    currentTracePath = path.join(userDataDir, `electron-trace-${tracePaths.length + 1}.zip`);
    tracePaths.push(currentTracePath);
    await electronApp.context().tracing.start({ screenshots: true, snapshots: true });
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

    await closeDesktop();
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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

    // Read corrected production descriptors from real native Chromium. This
    // checks native form association/default types without activating a form.
    const formSemantics = await electronApp!.evaluate(async ({ webContents }, options) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === options.url);
      if (!contents) throw new Error("Personal WebContentsView was not found.");
      const requireBundle = process.getBuiltinModule("node:module").createRequire(options.pageBridgePath);
      const pageBridge = requireBundle(options.pageBridgePath) as typeof import("../../../../desktop-app/src/personalBrowserPageBridge");
      const security = requireBundle(options.securityPath) as typeof import("../../../../desktop-app/src/personalBrowserSecurity");
      const snapshot = await pageBridge.snapshotPersonalBrowserPage(contents);
      return snapshot.interactive.filter(({ descriptor }) => descriptor.id?.startsWith("fixture-")).map(({ descriptor }) => ({
        id: descriptor.id,
        type: descriptor.type,
        formOwnerIdentity: descriptor.formOwnerIdentity,
        formActionText: descriptor.formActionText,
        activationNeedsConfirmation: security.personalBrowserActivationRequiresConfirmation(descriptor, "routine"),
        askActivationNeedsConfirmation: security.personalBrowserActivationRequiresConfirmation(descriptor, "ask"),
        enterNeedsConfirmation: security.personalBrowserKeyRequiresConfirmation("Enter", descriptor),
        routineEnterNeedsConfirmation: security.personalBrowserKeyRequiresConfirmation("Enter", descriptor, "routine"),
      }));
    }, {
      url: targetUrl,
      pageBridgePath: path.join(DESKTOP_APP_DIR, "dist", "personalBrowserPageBridge.js"),
      securityPath: path.join(DESKTOP_APP_DIR, "dist", "personalBrowserSecurity.js"),
    });
    expect(formSemantics).toHaveLength(9);
    const associatedOwner = formSemantics.find(row => row.id === "fixture-default")?.formOwnerIdentity;
    expect(associatedOwner).toBeTruthy();
    // Routine is the owner tier (approval policy version 2): every submit and
    // every other button asks in routine as well as in Ask mode.
    for (const id of ["fixture-default", "fixture-submit", "fixture-normalized"]) {
      expect(formSemantics.find(row => row.id === id)).toMatchObject({
        type: "submit", formOwnerIdentity: associatedOwner, formActionText: "Continue",
        activationNeedsConfirmation: true, askActivationNeedsConfirmation: true,
      });
    }
    for (const id of ["fixture-button", "fixture-reset"]) {
      expect(formSemantics.find(row => row.id === id)).toMatchObject({
        formOwnerIdentity: associatedOwner, activationNeedsConfirmation: true,
      });
    }
    expect(formSemantics.find(row => row.id === "fixture-no-owner")).toMatchObject({
      formOwnerIdentity: "", formActionText: "", activationNeedsConfirmation: true,
    });
    expect(formSemantics.find(row => row.id === "fixture-notes")).toMatchObject({
      formOwnerIdentity: associatedOwner, enterNeedsConfirmation: true, routineEnterNeedsConfirmation: true,
    });
    expect(formSemantics.find(row => row.id === "fixture-order")).toMatchObject({
      type: "submit", formActionText: "Place order", activationNeedsConfirmation: true,
      askActivationNeedsConfirmation: true, routineEnterNeedsConfirmation: true,
    });
    expect(formSemantics.find(row => row.id === "fixture-order-notes")).toMatchObject({
      formActionText: "Place order", enterNeedsConfirmation: true, routineEnterNeedsConfirmation: true,
    });

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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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

    await closeDesktop();
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

  test("keeps real login cookies per user across projects and restarts, then clears only that user", async () => {
    const targetUrl = `${fixtureOrigin}/target`;
    let ownerSequence = 0;
    const openProfile = async (profileUserId: string, projectId = PROJECT_ID) => {
      const page = electronApp ? await electronApp.firstWindow() : await launchDesktop(true);
      const ownerId = `cookie-owner-${ownerSequence += 1}`;
      const opened = await page.evaluate(async ({ profileUserId, projectId, ownerId, targetUrl }) => {
        const desktop = (window as PersonalBrowserFixtureWindow).instafyDesktop;
        (globalThis as { __INSTAFY_SET_TEST_SESSION_USER_ID__?: (userId: string) => void })
          .__INSTAFY_SET_TEST_SESSION_USER_ID__?.(profileUserId);
        return desktop.personalBrowserOpen({
          projectId,
          controllerUrl: window.location.origin,
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
          profileUserId,
          ownerId,
          url: targetUrl,
        });
      }, { profileUserId, projectId, ownerId, targetUrl });
      expect(opened.state).toBe("ready");
      expect(opened.projectId).toBe(projectId);
      expect(opened.agentControlEnabled).toBe(false);
      return page;
    };
    const readLogin = async () => electronApp!.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Personal cookie fixture was not found.");
      return contents.executeJavaScript(`(async () => ({
        serverCookies: (await (await fetch('/cookie-echo', { cache: 'no-store' })).json()).cookies,
        visibleCookies: document.cookie,
        localValue: localStorage.getItem('personal-login-fixture')
      }))()`);
    }, targetUrl);
    const seedLogin = async (identity: "a" | "b") => electronApp!.evaluate(async ({ webContents }, { url, identity }) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url);
      if (!contents) throw new Error("Personal cookie fixture was not found.");
      await contents.executeJavaScript(`(async () => {
        const response = await fetch('/cookie-login/' + ${JSON.stringify(identity)}, { cache: 'no-store' });
        if (!response.ok) throw new Error('Fixture login failed');
        localStorage.setItem('personal-login-fixture', 'local-' + ${JSON.stringify(identity)});
      })()`);
    }, { url: targetUrl, identity });
    const expectLogin = async (identity: "a" | "b") => {
      const state = await readLogin();
      expect(state.serverCookies.split("; ").sort()).toEqual([
        `personal-http-only=secret-${identity}`,
        `personal-visible=fixture-${identity}`,
      ]);
      expect(state.visibleCookies).toBe(`personal-visible=fixture-${identity}`);
      expect(state.localValue).toBe(`local-${identity}`);
    };
    const expectNoLogin = async () => {
      expect(await readLogin()).toEqual({ serverCookies: "", visibleCookies: "", localValue: null });
    };
    const closeProfile = async () => {
      const page = await electronApp!.firstWindow();
      const closed = await page.evaluate(async () => {
        const desktop = (window as PersonalBrowserFixtureWindow).instafyDesktop;
        const { ownerId } = await desktop.personalBrowserStatus();
        if (!ownerId) throw new Error("Personal Browser has no owner to close.");
        return desktop.personalBrowserClose({ ownerId });
      });
      expect(closed.state).toBe("closed");
    };

    const studio = await openProfile(PROFILE_USER_ID);
    await expectNoLogin();
    await seedLogin("a");
    await expectLogin("a");
    // Studio and Personal render the same localhost origin in separate sessions.
    expect(await studio.evaluate(async () => (await (await fetch("/cookie-echo")).json()).cookies)).toBe("");

    await closeProfile();
    await openProfile(PROFILE_USER_ID);
    await expectLogin("a");
    await openProfile(PROFILE_USER_ID, OTHER_PROJECT_ID);
    await expectLogin("a");

    await closeDesktop();
    await openProfile(PROFILE_USER_ID, OTHER_PROJECT_ID);
    await expectLogin("a");

    await openProfile(OTHER_PROFILE_USER_ID, OTHER_PROJECT_ID);
    await expectNoLogin();
    await seedLogin("b");
    await expectLogin("b");
    const firstUserPage = await openProfile(PROFILE_USER_ID);
    await expectLogin("a");
    const cleared = await firstUserPage.evaluate(async () => {
      const desktop = (window as PersonalBrowserFixtureWindow).instafyDesktop;
      const { ownerId } = await desktop.personalBrowserStatus();
      if (!ownerId) throw new Error("Personal Browser has no owner to clear.");
      return desktop.personalBrowserClearData({ ownerId });
    });
    expect(cleared.agentControlEnabled).toBe(false);
    expect(cleared.url).toBe("about:blank");
    await openProfile(PROFILE_USER_ID, OTHER_PROJECT_ID);
    await expectNoLogin();
    await closeDesktop();
    await openProfile(PROFILE_USER_ID);
    await expectNoLogin();
    await openProfile(OTHER_PROFILE_USER_ID);
    await expectLogin("b");
  });

  test("reports the person's tab and keeps tab changes the person's own while the agent has control", async () => {
    const targetUrl = `${fixtureOrigin}/target`;
    const ownerId = "tabs-owner";
    const page = await launchDesktop(true);
    const result = await page.evaluate(async ({ projectId, profileUserId, ownerId, targetUrl }) => {
      const desktop = (window as Window & { instafyDesktop?: PersonalBrowserBridge }).instafyDesktop!;
      const outcome = async (run: () => Promise<PersonalBrowserStatus>) => {
        try {
          return { status: await run() };
        } catch (caught) {
          return { error: caught instanceof Error ? caught.message : String(caught) };
        }
      };
      const opened = await desktop.personalBrowserOpen({
        projectId,
        controllerUrl: window.location.origin,
        controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
        profileUserId,
        ownerId,
        url: targetUrl,
      });
      await desktop.personalBrowserSetBounds({ x: 20, y: 80, width: 640, height: 420, visible: true, ownerId });
      const shownWhilePaused = await outcome(() => desktop.personalBrowserSelectTab({ ownerId, tabId: opened.activeTabId! }));
      const closeOwnTab = await outcome(() => desktop.personalBrowserCloseTab({ ownerId, tabId: opened.activeTabId! }));
      await desktop.personalBrowserSetAgentControlEnabled({ enabled: true, ownerId });
      const shownWhileResumed = await outcome(() => desktop.personalBrowserSelectTab({ ownerId, tabId: opened.activeTabId! }));
      await desktop.personalBrowserSetAgentControlEnabled({ enabled: false, ownerId });
      return { opened, shownWhilePaused, closeOwnTab, shownWhileResumed };
    }, { projectId: PROJECT_ID, profileUserId: PROFILE_USER_ID, ownerId, targetUrl });

    expect(result.opened.maxAgentTabs).toBe(3);
    expect(result.opened.tabs).toEqual([{ id: result.opened.activeTabId, openedBy: "person", active: true, url: targetUrl, title: "Personal Browser fixture" }]);
    expect(result.shownWhilePaused.status?.activeTabId).toBe(result.opened.activeTabId);
    expect(result.closeOwnTab.error).toContain("agent opened");
    expect(result.shownWhileResumed.error).toContain("Pause");
  });

  test("stops agent-driven page loads on a link-only site or a private address, also by the address actually connected to", async () => {
    // Desktop's own built request guard on the sessions of a minimal Electron
    // main process: real Chromium, loopback fixture servers only.
    const fixturePort = new URL(fixtureOrigin).port;
    const proxiedHosts: string[] = [];
    const proxyServer = createServer((request, response) => {
      const target = new URL(request.url ?? "/", "http://absolute-form.invalid");
      proxiedHosts.push(target.hostname);
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: Number(fixturePort),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: request.headers,
      }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      upstream.on("error", () => {
        response.statusCode = 502;
        response.end();
      });
      request.pipe(upstream);
    });
    const proxyOrigin = `http://127.0.0.1:${await listen(proxyServer)}`;
    guardRequestHosts.length = 0;
    guardRequests.length = 0;
    // A disposable profile, never the default Electron one.
    const guardUserData = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-request-guard-"));
    const guardApp = await electron.launch({
      executablePath: DESKTOP_APP_REQUIRE("electron"),
      args: [path.join(DESKTOP_APP_DIR, "test", "fixtures", "personal-browser-request-guard-app.cjs"), `--user-data-dir=${guardUserData}`],
      cwd: REPO_ROOT,
      env: { ...personalBrowserFixtureEnvironment(process.env), TMPDIR: os.tmpdir() },
    }).catch((error: unknown) => {
      fs.rmSync(guardUserData, { recursive: true, force: true });
      throw error;
    });
    try {
      type Outcome = { result: string; text: string };
      const results = await guardApp.evaluate(
        async (_electron, options) => (globalThis as unknown as {
          __instafyRequestGuardScenario: (value: typeof options) => Promise<Record<string, unknown>>;
        }).__instafyRequestGuardScenario(options),
        { origin: fixtureOrigin, proxy: proxyOrigin },
      ) as Record<"rebound" | "linkOnly" | "viaProxy" | "viaProxyToLinkOnly" | "person", Outcome> & {
        fetched: string;
        personFetched: string;
        fetchedLiteral: string;
        socket: string;
        personFetchedLiteral: string;
        personSocket: string;
        stopped: Array<{ resourceType: string; code: string }>;
      };
      // DNS rebinding: the name passed the check made before the request and
      // Chromium connected to 127.0.0.1. The response was discarded before
      // the page rendered; only the request reached the server.
      expect(results.rebound).toEqual({ result: "ERR_BLOCKED_BY_CLIENT", text: "" });
      // A link-only site is stopped before the request leaves the browser.
      expect(results.linkOnly).toEqual({ result: "ERR_BLOCKED_BY_CLIENT", text: "" });
      // Through a proxy the connection is the proxy's own, so the page loads,
      expect(results.viaProxy).toEqual({ result: "loaded", text: "guarded fixture page" });
      // and a redirect hop to a link-only site is still stopped before it is requested.
      expect(results.viaProxyToLinkOnly.result).toBe("ERR_BLOCKED_BY_CLIENT");
      // The person's own tab, in the same session, loads the same page.
      expect(results.person).toEqual({ result: "loaded", text: "guarded fixture page" });
      // A page already open in the agent's tab gets nothing back from a
      // private address when its script fetches the rebinding name again;
      // the person's tab gets the answer as before.
      expect(results.fetched).toBe("blocked");
      expect(results.personFetched).toBe("private data");
      // A request of that page to a private address literal, a WebSocket
      // included, never leaves the browser; the person's tab connects as before.
      expect(results.fetchedLiteral).toBe("blocked");
      expect(results.socket).toBe("error");
      expect(results.personFetchedLiteral).toBe("private data");
      expect(results.personSocket).toBe("got: private socket data");
      expect(results.stopped).toEqual([
        { resourceType: "mainFrame", code: "private_address_blocked" },
        { resourceType: "mainFrame", code: "link_only_site" },
        { resourceType: "mainFrame", code: "link_only_site" },
        { resourceType: "xhr", code: "private_address_blocked" },
        { resourceType: "xhr", code: "private_address_blocked" },
        { resourceType: "webSocket", code: "private_address_blocked" },
      ]);
      expect(guardRequestHosts).not.toContain("www.booking.com");
      expect(proxiedHosts).not.toContain("www.booking.com");
      expect(proxiedHosts).toEqual(["page.guard.test", "hop.guard.test"]);
      // Only the requests reached the server; the agent's tab got no response.
      expect(guardRequests.filter((entry) => entry.startsWith("rebound.guard.test"))).toEqual([
        "rebound.guard.test/guard/page",
        "rebound.guard.test/guard/page",
        "rebound.guard.test/guard/data",
        "rebound.guard.test/guard/data",
      ]);
      // Only the person's tab reached the literal address.
      expect(guardRequests.filter((entry) => entry.startsWith("127.0.0.1/guard/"))).toEqual([
        "127.0.0.1/guard/data",
        "127.0.0.1/guard/socket",
      ]);
    } finally {
      await guardApp.close();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      fs.rmSync(guardUserData, { recursive: true, force: true });
    }
  });

  test("judges and takes form steps by the submission the browser makes, the default button's formaction, formmethod and formtarget included", async () => {
    // The form-submission table both browsers run, through Desktop's own
    // built page bridge in a minimal Electron main process: real Chromium,
    // one loopback fixture server answering for two sites.
    type FormCase = {
      name: string;
      html: string;
      step: "enter" | "click";
      setup?: string;
      submission: Record<string, unknown> & { action: string; newWindow: boolean; submits: boolean; via: string };
      sends: string;
      enter?: "allow" | "ask";
    };
    const table = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, "packages", "browser-action-policy", "formSubmissionCases.json"),
      "utf8",
    )) as { cases: FormCase[] };
    const formRequests: string[] = [];
    let formPort = 0;
    const fill = (value: string, name: string) => value
      .replaceAll("{shop}", `http://shop.test:${formPort}`)
      .replaceAll("{other}", `http://other.test:${formPort}`)
      .replaceAll("{page}", `http://shop.test:${formPort}/case/${name}`);
    const formServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`);
      request.resume();
      if (url.pathname === "/favicon.ico") {
        response.writeHead(404).end();
        return;
      }
      formRequests.push(`${request.method} ${url.origin}${url.pathname}`);
      const name = url.pathname.startsWith("/case/") ? decodeURIComponent(url.pathname.slice("/case/".length)) : "";
      const entry = table.cases.find((candidate) => candidate.name === name);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${name || "Fixture"}</title></head>` +
        `<body>${entry ? fill(entry.html, entry.name) : "<p>sent</p>"}</body></html>`);
    });
    formPort = await listen(formServer);
    // A disposable profile, never the default Electron one.
    const formUserData = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-form-submission-"));
    const formApp = await electron.launch({
      executablePath: DESKTOP_APP_REQUIRE("electron"),
      args: [path.join(DESKTOP_APP_DIR, "test", "fixtures", "personal-browser-form-submission-app.cjs"), `--user-data-dir=${formUserData}`],
      cwd: REPO_ROOT,
      env: { ...personalBrowserFixtureEnvironment(process.env), TMPDIR: os.tmpdir() },
    }).catch((error: unknown) => {
      fs.rmSync(formUserData, { recursive: true, force: true });
      throw error;
    });
    type StepResult = {
      observed: boolean;
      facts: Record<string, unknown>;
      enterVerdict: string;
      enterAsksInRoutine: boolean;
      enterAsksInAsk: boolean;
      clickAsksInRoutine: boolean;
      submission: { action: string | null; method: string; newWindow: boolean; nested: boolean } | null;
      performed: boolean;
      targetChanged: boolean;
      deniedWindows: string[];
    };
    const takeStep = async (entry: FormCase) => {
      formRequests.length = 0;
      const result = await formApp.evaluate(
        async (_electron, options) => (globalThis as unknown as {
          __instafyFormSubmissionStep: (value: typeof options) => Promise<unknown>;
        }).__instafyFormSubmissionStep(options),
        {
          shop: `http://shop.test:${formPort}`,
          name: entry.name,
          step: entry.step,
          setup: entry.setup ? fill(entry.setup, entry.name) : undefined,
        },
      ) as StepResult;
      // The page load itself was the first request.
      return { result, sent: formRequests.slice(1) };
    };
    try {
      for (const entry of table.cases) {
        const { result, sent } = await takeStep(entry);
        expect(result.observed, entry.name).toBe(true);
        expect(result.facts, entry.name).toEqual({ ...entry.submission, action: fill(entry.submission.action, entry.name) });
        if (entry.enter) {
          expect(result.enterVerdict, entry.name).toBe(entry.enter);
          expect(result.enterAsksInRoutine, entry.name).toBe(entry.enter === "ask");
        }
        // A field inside a submit button, which a click and Enter send in
        // different ways, is marked so that the host refuses its steps. The
        // bridge here takes them anyway, to show what Chromium then sends.
        expect(result.submission?.nested ?? false, entry.name).toBe(entry.submission.via === "nested");
        expect(result.performed, entry.name).toBe(true);
        expect(result.targetChanged, entry.name).toBe(false);
        // The bridge's own step sends what Chromium sends, except that a
        // Personal Browser tab opens no other window: that one is denied.
        const opensWindow = entry.submission.newWindow && entry.submission.submits;
        expect(sent, entry.name).toEqual(entry.sends && !opensWindow ? [fill(entry.sends, entry.name)] : []);
        expect(result.deniedWindows.length, entry.name).toBe(opensWindow ? 1 : 0);
      }

      // A hostile default button: Enter in the search field asks in both
      // modes, and its submission names the other site, which the host
      // holds to the link-only, private-address and site rules before any
      // dialog. Allowed, Enter sends exactly that POST.
      const hostile = table.cases.find((entry) => entry.name === "hostile-default-button")!;
      const { result, sent } = await takeStep(hostile);
      expect(result.enterAsksInRoutine).toBe(true);
      expect(result.enterAsksInAsk).toBe(true);
      expect(result.submission).toEqual({ action: `http://other.test:${formPort}/collect`, method: "post", newWindow: false, nested: false });
      expect(sent).toEqual([`POST http://other.test:${formPort}/collect`]);
      // The page's keydown handler moves the judged default button to
      // another site: the bridge's Enter stops, and nothing is sent.
      const search = table.cases.find((entry) => entry.name === "same-site-search")!;
      const moved = await takeStep({
        ...search,
        setup: "document.getElementById('step').addEventListener('keydown', () => { const button = document.querySelector('button'); " +
          "button.formAction = '{other}/collect'; button.formMethod = 'post'; });",
      });
      expect(moved.result.facts.action).toBe(`http://shop.test:${formPort}/search`);
      expect(moved.result.performed).toBe(false);
      expect(moved.result.targetChanged).toBe(true);
      expect(moved.sent).toEqual([]);
      // A label that clicks a hidden submit button asks in routine too.
      const label = table.cases.find((entry) => entry.name === "click-label-of-a-hidden-submit-button")!;
      const labelled = await takeStep(label);
      expect(labelled.result.clickAsksInRoutine).toBe(true);
      expect(labelled.result.submission).toEqual({ action: `http://other.test:${formPort}/collect`, method: "post", newWindow: false, nested: false });
    } finally {
      await formApp.close();
      await new Promise<void>((resolve) => formServer.close(() => resolve()));
      fs.rmSync(formUserData, { recursive: true, force: true });
    }
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
          controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
            controllerAccessToken: (window as PersonalBrowserFixtureWindow).__INSTAFY_TEST_SESSION__().access_token,
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
