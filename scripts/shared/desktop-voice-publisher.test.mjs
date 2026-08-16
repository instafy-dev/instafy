import assert from "node:assert/strict";
import test from "node:test";
import { startDesktopVoiceHarnessServer } from "./desktop-voice-publisher.mjs";

test("desktop voice harness keeps controller config out of browser URLs", async (t) => {
  const input = {
    projectId: "project-sensitive-123",
    controllerUrl: "https://controller-sensitive.example.test",
    controllerAccessToken: "controller-sensitive-token-456",
    publishTimeoutMs: 1_000,
    requireTunnel: true,
  };
  const harness = await startDesktopVoiceHarnessServer(input);
  t.after(async () => {
    await harness.close();
  });

  const appUrl = new URL(harness.appUrl);
  assert.equal(appUrl.pathname, "/studio");
  assert.equal(appUrl.search, "");
  assert.equal(appUrl.hash, "");
  assert.equal(appUrl.hostname, "127.0.0.1");
  for (const sensitiveValue of [input.projectId, input.controllerUrl, input.controllerAccessToken]) {
    assert.equal(harness.appUrl.includes(sensitiveValue), false);
    assert.equal(harness.appUrl.includes(encodeURIComponent(sensitiveValue)), false);
  }

  const redirectResponse = await fetch(new URL("/", appUrl), { redirect: "manual" });
  assert.equal(redirectResponse.status, 302);
  assert.equal(redirectResponse.headers.get("location"), "/studio");
  assert.match(redirectResponse.headers.get("cache-control") ?? "", /no-store/);

  const studioResponse = await fetch(appUrl);
  assert.equal(studioResponse.status, 200);
  assert.match(studioResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(studioResponse.headers.get("referrer-policy"), "no-referrer");
  const html = await studioResponse.text();
  assert.match(html, /fetch\("\/config"/);
  assert.doesNotMatch(html, /window\.location\.href/);
  for (const sensitiveValue of [input.projectId, input.controllerUrl, input.controllerAccessToken]) {
    assert.equal(html.includes(sensitiveValue), false);
  }

  const configResponse = await fetch(new URL("/config", appUrl));
  assert.equal(configResponse.status, 200);
  assert.match(configResponse.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(configResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(configResponse.headers.get("pragma"), "no-cache");
  assert.equal(configResponse.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(configResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await configResponse.json(), {
    projectId: input.projectId,
    controllerUrl: input.controllerUrl,
    controllerAccessToken: input.controllerAccessToken,
  });
});
