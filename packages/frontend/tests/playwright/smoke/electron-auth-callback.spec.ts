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
const ENABLED = (process.env.PLAYWRIGHT_ELECTRON_AUTH_CALLBACK ?? "").trim() === "1";

// Deliberately not a real token: nothing here exchanges it. These assertions
// are about the shell's transport contract -- does the callback survive the
// trip from argv into the renderer's reach -- not about Supabase.
const AUTH_DEEP_LINK =
  "instafy://auth#access_token=FIXTUREACCESS&refresh_token=FIXTUREREFRESH&token_type=bearer";
const NON_AUTH_DEEP_LINK = "instafy://studio?projectId=11111111-1111-4111-8111-111111111111";

type AuthBridge = {
  consumePendingAuthCallback?: () => Promise<string | null>;
  onAuthCallback?: (listener: (url: string) => void) => () => void;
  windowChrome?: string;
  titleBarFree?: boolean;
};

/** A page that does nothing: the assertions run against the preload bridge. */
function fixtureHandler(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>auth callback fixture</title><main>fixture</main>");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Auth callback fixture did not receive a TCP port.");
  }
  return address.port;
}

/**
 * The shell half of desktop OAuth.
 *
 * Sign-in leaves the app for the system browser and returns through an
 * `instafy://auth` deep link. The shell parks that callback and hands it to
 * the renderer; the login page drains it. In 0.2.5 the shell did its half
 * perfectly and the renderer never collected -- sign-in hung on "Finish
 * signing in with GitHub in your browser..." forever -- so the frontend's
 * drain is pinned by source invariants in
 * `src/screens/login/__tests__/desktopAuthCallbackWiring.test.ts`.
 *
 * This spec pins the other half: that a callback arriving before any window
 * exists is still reachable, that draining is genuinely a consume rather than
 * a peek, and that the bridge exposes what the frontend gates on. Hermetic on
 * purpose -- no Supabase, no network -- because the transport is what breaks,
 * not the token exchange.
 */
test.describe("Electron auth callback transport", () => {
  test.skip(
    !ENABLED,
    "Set PLAYWRIGHT_ELECTRON_AUTH_CALLBACK=1 to run the desktop auth callback smoke.",
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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-auth-callback-"));
  });

  test.afterEach(async () => {
    await electronApp?.close().catch(() => undefined);
    electronApp = null;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  });

  /** Cold start with `deepLink` in argv, exactly as macOS launches the app. */
  const launchWithDeepLink = async (deepLink?: string) => {
    electronApp = await electron.launch({
      executablePath: DESKTOP_APP_REQUIRE("electron"),
      args: deepLink ? [DESKTOP_APP_DIR, deepLink] : [DESKTOP_APP_DIR],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        INSTAFY_APP_URL: fixtureOrigin,
        INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
        INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    return page;
  };

  test("exposes the bridge the login page gates its drain on", async () => {
    // The frontend only wires its desktop transport when BOTH of these are
    // functions (desktopCanReceiveAuthCallback). If the preload ever stops
    // exporting one, the login page silently falls back to the web flow and
    // desktop sign-in hangs with no error anywhere.
    const page = await launchWithDeepLink();
    const bridge = await page.evaluate(() => {
      const d = (window as Window & { instafyDesktop?: AuthBridge }).instafyDesktop;
      return {
        present: Boolean(d),
        consume: typeof d?.consumePendingAuthCallback,
        subscribe: typeof d?.onAuthCallback,
      };
    });

    expect(bridge.present).toBe(true);
    expect(bridge.consume).toBe("function");
    expect(bridge.subscribe).toBe("function");
  });

  test("parks a cold-start callback and hands it over exactly once", async () => {
    const page = await launchWithDeepLink(AUTH_DEEP_LINK);

    // First drain returns the callback: a link that arrived before any window
    // existed is still reachable once the renderer is up.
    const first = await page.evaluate(async () => {
      const d = (window as Window & { instafyDesktop?: AuthBridge }).instafyDesktop;
      return (await d?.consumePendingAuthCallback?.()) ?? null;
    });
    expect(first).toBe(AUTH_DEEP_LINK);

    // Second drain returns null. "Consume" has to mean consume: the shell
    // parks AND sends every callback, so a value left behind here would be
    // replayed on the next mount of the login page -- reporting a failure
    // over a sign-in that already succeeded.
    const second = await page.evaluate(async () => {
      const d = (window as Window & { instafyDesktop?: AuthBridge }).instafyDesktop;
      return (await d?.consumePendingAuthCallback?.()) ?? null;
    });
    expect(second).toBeNull();
  });

  test("does not park deep links that are not auth callbacks", async () => {
    // instafy://studio is ordinary navigation. Parking it in the auth slot
    // would feed a non-callback URL to the login page's handler on next mount.
    const page = await launchWithDeepLink(NON_AUTH_DEEP_LINK);
    const pending = await page.evaluate(async () => {
      const d = (window as Window & { instafyDesktop?: AuthBridge }).instafyDesktop;
      return (await d?.consumePendingAuthCallback?.()) ?? null;
    });
    expect(pending).toBeNull();
  });

  test("reports the window chrome the integrated title bar depends on", async () => {
    const page = await launchWithDeepLink();
    const chrome = await page.evaluate(() => {
      const d = (window as Window & { instafyDesktop?: AuthBridge }).instafyDesktop;
      return { windowChrome: d?.windowChrome, titleBarFree: d?.titleBarFree };
    });

    if (process.platform === "darwin") {
      // hiddenInset puts the traffic lights over the web contents; titleBarFree
      // tells the frontend this shell narrowed its drag region, so the tab strip
      // may occupy row zero. Getting this wrong makes every tab click drag the
      // window instead.
      expect(chrome.windowChrome).toBe("hiddenInset");
      expect(chrome.titleBarFree).toBe(true);
    } else {
      expect(chrome.windowChrome).toBe("system");
      expect(chrome.titleBarFree).toBeFalsy();
    }
  });
});
