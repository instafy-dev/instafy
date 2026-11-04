import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  createHeldDesktopAuthCallback,
  DESKTOP_AUTH_CALLBACK_TTL_MS,
  isDesktopAuthCallbackDeepLink,
  resolveDesktopDeepLinkTargetUrl,
} = await import(path.join(packageRoot, "dist", "deepLinks.js"));
const START = "https://prod.instafy.dev/studio";

test("an OAuth return is recognised as a callback, not a navigation", () => {
  // The bug: signing in with GitHub from the app completed in the browser and
  // the app never saw it. The callback must reach the renderer as data, which
  // decides whether it belongs to a sign-in it started. Desktop sign-ins
  // return a PKCE code; a fragment token pair is routed the same way, and the
  // renderer drops it.
  for (const url of ["instafy://auth?code=xyz", "instafy://auth#access_token=abc&refresh_token=def"]) {
    assert.equal(isDesktopAuthCallbackDeepLink(url), true, url);
    assert.equal(resolveDesktopDeepLinkTargetUrl(url, START), null,
      "must not be resolvable as a navigation target");
  }
});

test("PKCE-style returns are recognised too", () => {
  assert.equal(isDesktopAuthCallbackDeepLink("instafy://auth?code=xyz"), true);
});

test("ordinary deep links are still navigations", () => {
  assert.equal(isDesktopAuthCallbackDeepLink("instafy://studio"), false);
  assert.ok(resolveDesktopDeepLinkTargetUrl("instafy://studio", START));
});

test("foreign schemes and junk are rejected", () => {
  // Anything that is not our scheme must never be treated as our callback.
  for (const value of ["https://evil.test/auth", "otherapp://auth", "", null, undefined, "not a url"]) {
    assert.equal(isDesktopAuthCallbackDeepLink(value), false, String(value));
  }
});

// The shell holds one callback for a window that is not listening yet. A
// sign-in collects it within seconds; one left far longer belongs to no
// sign-in anyone is waiting for.
test("a held callback is handed over once, within ten minutes of arriving", () => {
  let now = 1_000_000;
  const held = createHeldDesktopAuthCallback({ now: () => now });

  assert.equal(DESKTOP_AUTH_CALLBACK_TTL_MS, 10 * 60 * 1000);
  assert.equal(held.take(), null, "nothing held yet");
  held.hold("instafy://auth?code=first");
  held.hold("instafy://auth?code=second");
  now += DESKTOP_AUTH_CALLBACK_TTL_MS;
  assert.equal(held.take(), "instafy://auth?code=second", "the latest callback, at the limit");
  assert.equal(held.take(), null, "taking empties the slot");
});

test("a held callback expires instead of reaching a later login screen", () => {
  let now = 1_000_000;
  const held = createHeldDesktopAuthCallback({ now: () => now });

  held.hold("instafy://auth?code=stale");
  now += DESKTOP_AUTH_CALLBACK_TTL_MS + 1;
  assert.equal(held.take(), null);
  // Even if the clock is then set back to when it arrived.
  now = 1_000_001;
  assert.equal(held.take(), null, "an expired callback is gone, not kept for later");
});

test("the shell holds callbacks only through the expiring slot", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(path.join(packageRoot, "src", "main.ts"), "utf8");
  assert.match(main, /heldDesktopAuthCallback\.hold\(rawUrl\)/);
  assert.match(
    main,
    /ipcMain\.handle\("instafy:consumePendingAuthCallback"[\s\S]{0,160}return heldDesktopAuthCallback\.take\(\);/,
  );
  assert.doesNotMatch(main, /pendingDesktopAuthCallbackUrl/);
});
