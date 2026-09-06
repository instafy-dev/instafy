import { describe, expect, it } from "vitest";
import { canonicalNotificationUrl, isNotificationEventName, NOTIFICATION_EVENT_LABELS, safeNotificationBody } from "../notificationContract";
const ID = "11111111-1111-4111-8111-111111111111";
describe("canonical notification routes", () => {
  it("preserves exact report and conversation identities", () => {
    expect(canonicalNotificationUrl(`/studio?supportReportId=${ID}`)).toBe(`/studio?supportReportId=${ID}`);
    expect(canonicalNotificationUrl(`/studio?projectId=${ID}&conversationControllerId=${ID}`)).toBe(`/studio?projectId=${ID}&conversationControllerId=${ID}`);
    expect(canonicalNotificationUrl(`/studio?projectId=${ID}`)).toBe(`/studio?projectId=${ID}`);
    expect(canonicalNotificationUrl(`/studio?projectId=${ID}&panel=automations`)).toBe(`/studio?projectId=${ID}&panel=automations`);
  });
  it.each(["https://evil.invalid/studio", "//evil.invalid/studio", "/\\evil.invalid/studio", "/login", "/studio#secret", `/studio?supportReportId=${ID}&controllerUrl=https://evil.invalid`, `/studio?supportReportId=${ID}&supportReportId=${ID}`, "/studio?supportReportId=private-log", "/studio?projectId=../../secret"]) ("rejects untrusted route %s", (url) => expect(canonicalNotificationUrl(url)).toBeNull());
  it("uses only registry labels, not producer content", () => {
    expect(isNotificationEventName("support.reply")).toBe(true);
    expect(isNotificationEventName("__proto__")).toBe(false);
    expect(isNotificationEventName("support.internal_note")).toBe(false);
    expect(Object.values(NOTIFICATION_EVENT_LABELS).every((text) => text.length < 100)).toBe(true);
  });
  it("accepts only static registry descriptions for opt-in lock-screen previews", () => {
    for (const body of Object.values(NOTIFICATION_EVENT_LABELS)) expect(safeNotificationBody(body)).toBe(body);
    expect(safeNotificationBody("Private prompt /workspace/project diagnostics")).toBe("You have a new notification.");
    expect(safeNotificationBody(undefined)).toBe("You have a new notification.");
  });

});
