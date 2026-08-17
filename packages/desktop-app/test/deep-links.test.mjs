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
      "instafy:///studio?projectId=project-1#bottom",
      "http://127.0.0.1:5173/studio",
    ),
    "http://127.0.0.1:5173/studio?projectId=project-1#bottom",
  );
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
