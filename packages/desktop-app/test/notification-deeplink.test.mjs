import test from "node:test";
import assert from "node:assert/strict";
import { resolveDesktopNotificationTargetUrl, resolveDesktopNotificationBody, resolveDesktopNotificationClickTargetUrl } from "../dist/deepLinks.js";
const ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://app.example.test";
test("desktop notification click preserves the exact report and conversation IDs", () => {
  for (const route of [`/studio?supportReportId=${ID}`, `/studio?projectId=${ID}&conversationControllerId=${ID}`, `/studio?projectId=${ID}`, `/studio?projectId=${ID}&panel=automations`, "/studio"]) {
    assert.equal(resolveDesktopNotificationTargetUrl(route, `${ORIGIN}/studio`), ORIGIN + route);
  }
});
test("desktop notification IPC cannot carry external routes, secrets or controller bindings", () => {
  for (const route of ["https://evil.test/studio", "//evil.test/studio", "/\\evil.test/studio", "/login", "/studio#token", `/studio?supportReportId=${ID}&controllerUrl=https://evil.test`, `/studio?supportReportId=${ID}&supportReportId=${ID}`, "/studio?supportReportId=secret", null, {}, "x".repeat(513)]) {
    assert.equal(resolveDesktopNotificationTargetUrl(route, `${ORIGIN}/studio`), null);
  }
});

test("desktop previews accept static event descriptions and reject arbitrary text", () => {
  assert.equal(resolveDesktopNotificationBody("There is a new reply to your support report."), "There is a new reply to your support report.");
  assert.equal(resolveDesktopNotificationBody("private diagnostics and conversation content"), "You have a new notification.");
});

test("external desktop clicks preserve validated identity for read acknowledgement after login", () => {
  const payload = { url: `/studio?supportReportId=${ID}`, eventId: ID, accountId: ID };
  assert.equal(resolveDesktopNotificationClickTargetUrl(payload, ORIGIN), `${ORIGIN}/studio?supportReportId=${ID}&notificationEventId=${ID}&notificationAccountId=${ID}`);
  assert.equal(resolveDesktopNotificationClickTargetUrl({ ...payload, eventId: "invalid" }, ORIGIN), null);
  assert.equal(resolveDesktopNotificationClickTargetUrl({ ...payload, url: payload.url + "&notificationEventId=" + ID }, ORIGIN), null);
});
