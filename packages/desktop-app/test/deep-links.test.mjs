import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "deepLinks.js");
const { findInstafyDesktopDeepLinkArg, resolveDesktopDeepLinkTargetUrl } =
  await import(modulePath);

test("resolveDesktopDeepLinkTargetUrl maps host-style Studio links to the configured app origin", () => {
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy://studio?projectId=project-1&conversationId=conv-1",
      "https://prod.instafy.dev/studio",
    ),
    "https://prod.instafy.dev/studio?projectId=project-1&conversationId=conv-1",
  );
});

test("resolveDesktopDeepLinkTargetUrl maps path-style Studio links to the configured app origin", () => {
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy:///studio?projectId=project-1",
      "http://127.0.0.1:5173/studio",
    ),
    "http://127.0.0.1:5173/studio?projectId=project-1",
  );
});

// The page's auth client reads its address: #access_token=... replaces the
// session and #error_description=... ends it. No Instafy link carries a
// fragment, so none is passed on.
test("resolveDesktopDeepLinkTargetUrl drops every fragment", () => {
  for (const [deepLink, expected] of [
    ["instafy:///studio?projectId=project-1#bottom", "https://prod.instafy.dev/studio?projectId=project-1"],
    ["instafy://login#access_token=a&refresh_token=b&token_type=bearer", "https://prod.instafy.dev/login"],
    ["instafy://studio#error_description=x", "https://prod.instafy.dev/studio"],
    // Route matching is case-sensitive, so this is a navigation, not a callback.
    ["instafy://AUTH#access_token=a&refresh_token=b", "https://prod.instafy.dev/AUTH"],
  ]) {
    assert.equal(resolveDesktopDeepLinkTargetUrl(deepLink, "https://prod.instafy.dev/studio"), expected, deepLink);
  }
});

test("resolveDesktopDeepLinkTargetUrl rejects links that carry session parameters", () => {
  for (const deepLink of [
    "instafy://login?error_description=x&redirect=%2Fstudio",
    "instafy://studio?projectId=project-1&code=code-from-a-link",
    "instafy:///login?access_token=a&refresh_token=b",
    "instafy://studio?error=access_denied",
    "instafy://studio?%61ccess_token=a",
    "instafy://studio?ERROR_DESCRIPTION=x",
    "instafy://studio?%20code%20=x",
  ]) {
    assert.equal(resolveDesktopDeepLinkTargetUrl(deepLink, "https://prod.instafy.dev/studio"), null, deepLink);
  }
});

test("resolveDesktopDeepLinkTargetUrl keeps the links Instafy makes", () => {
  for (const [deepLink, expected] of [
    [
      "instafy://studio?projectId=project-1&panel=settings&settingsTab=project",
      "https://prod.instafy.dev/studio?projectId=project-1&panel=settings&settingsTab=project",
    ],
    ["instafy://login?type=recovery", "https://prod.instafy.dev/login?type=recovery"],
    ["instafy://invite?token=invite-token", "https://prod.instafy.dev/invite?token=invite-token"],
  ]) {
    assert.equal(resolveDesktopDeepLinkTargetUrl(deepLink, "https://prod.instafy.dev/studio"), expected, deepLink);
  }
});

test("resolveDesktopDeepLinkTargetUrl rejects auth and non-Instafy links", () => {
  assert.equal(
    resolveDesktopDeepLinkTargetUrl("instafy://auth?code=test", "https://prod.instafy.dev/studio"),
    null,
  );
  assert.equal(
    resolveDesktopDeepLinkTargetUrl("https://prod.instafy.dev/studio", "https://prod.instafy.dev/studio"),
    null,
  );
});

test("resolveDesktopDeepLinkTargetUrl rejects controller credential overrides for every app origin", () => {
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy://studio?projectId=project-1&controllerAccessToken=attacker-token",
      "https://prod.instafy.dev/studio",
    ),
    null,
  );
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy://studio?controllerUrl=https%3A%2F%2Fattacker.example",
      "https://prod.instafy.dev/studio",
    ),
    null,
  );
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy://studio?controllerAccessToken=local-harness-token",
      "http://127.0.0.1:5173/studio",
    ),
    null,
  );
  assert.equal(
    resolveDesktopDeepLinkTargetUrl(
      "instafy://studio?projectId=project-1&controllerUrl=http%3A%2F%2Flocalhost%3A8788",
      "https://self-hosted.example.test/studio",
    ),
    null,
  );
});

test("resolveDesktopDeepLinkTargetUrl detects encoded and case-varied credential keys", () => {
  for (const deepLink of [
    "instafy://studio?CONTROLLERACCESSTOKEN=attacker-token",
    "instafy://studio?%63ontrollerUrl=https%3A%2F%2Fattacker.example",
    "instafy://studio?%20controllerAccessToken%20=attacker-token",
  ]) {
    assert.equal(
      resolveDesktopDeepLinkTargetUrl(deepLink, "http://127.0.0.1:5173/studio"),
      null,
    );
  }
});

test("findInstafyDesktopDeepLinkArg finds the first Instafy protocol argument", () => {
  assert.equal(
    findInstafyDesktopDeepLinkArg([
      "/Applications/Instafy Studio.app",
      "--flag",
      "instafy://studio?projectId=project-1",
    ]),
    "instafy://studio?projectId=project-1",
  );
});
