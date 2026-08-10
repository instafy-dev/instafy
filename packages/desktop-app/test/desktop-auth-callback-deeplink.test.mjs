import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isDesktopAuthCallbackDeepLink, resolveDesktopDeepLinkTargetUrl } = await import(
  path.join(packageRoot, "dist", "deepLinks.js")
);
const START = "https://prod.instafy.dev/studio";

test("an OAuth return is recognised as a callback, not a navigation", () => {
  // The bug: signing in with GitHub from the app completed in the browser and
  // the app never saw it. The callback must reach the renderer as data --
  // navigating to it would drop the fragment that IS the session.
  const url = "instafy://auth#access_token=abc&refresh_token=def";
  assert.equal(isDesktopAuthCallbackDeepLink(url), true);
  assert.equal(resolveDesktopDeepLinkTargetUrl(url, START), null,
    "must not be resolvable as a navigation target");
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
