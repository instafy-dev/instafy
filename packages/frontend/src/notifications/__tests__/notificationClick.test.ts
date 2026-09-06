// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNotificationClickUrl } from "../notificationContract";
import { routeNotificationClick, NOTIFICATION_NAVIGATE_EVENT } from "../notificationPresentation";
import { getNotificationSession, isNotificationSessionCurrent, setNotificationSession } from "../notificationSession";
const A = { userId: "11111111-1111-4111-8111-111111111111", accessToken: "a" };
const B = { userId: "22222222-2222-4222-8222-222222222222", accessToken: "b" };
beforeEach(() => setNotificationSession(null));
describe("notification clicks and session generation", () => {
  it("resumes an IDs-only URL signed out and rejects the previous account's click", () => {
    const listener = vi.fn(); window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, listener);
    const payload = { accountId: A.userId, eventId: B.userId, url: `/studio?supportReportId=${B.userId}` };
    expect(routeNotificationClick(payload)).toBe(true);
    expect(listener.mock.calls[0][0].detail).toEqual({ url: buildNotificationClickUrl(payload) });
    setNotificationSession(B);
    expect(routeNotificationClick(payload)).toBe(false);
    expect(routeNotificationClick({ ...payload, url: "javascript:alert(1)" })).toBe(false);
    window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, listener);
  });
  it("does not mistake A → B → A for the original async registration session", () => {
    setNotificationSession(A); const previous = getNotificationSession();
    setNotificationSession(B); setNotificationSession(A);
    expect(previous && isNotificationSessionCurrent(previous)).toBe(false);
  });
});
