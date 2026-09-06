// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), state: vi.fn(), readAll: vi.fn(), getPreferences: vi.fn(), savePreferences: vi.fn(), navigate: vi.fn(), show: vi.fn(), hide: vi.fn(), foreground: false, subscription: false }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { list: mocks.list, updateState: mocks.state, readAll: mocks.readAll, getPreferences: mocks.getPreferences, savePreferences: mocks.savePreferences } } }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.show, hideStatus: mocks.hide }) }));
vi.mock("../notificationPresentation", () => ({ NOTIFICATION_RECEIVED_EVENT: "instafy:notification-received", claimNotificationPresentation: async () => true }));
vi.mock("../assistantMessageNotifications", () => ({ areMessageNotificationsEnabled: () => false, enableMessageNotifications: async () => true, isAppInForeground: () => mocks.foreground, notifyAssistantMessage: vi.fn() }));
vi.mock("../webPushRegistration", () => ({ hasActiveWebPushSubscription: async () => mocks.subscription }));
import { useNotificationCenter } from "../useNotificationCenter";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const event = (id = A) => ({ id, eventName: "support.reply", version: 1, category: "support", resourceId: id, resourceType: "support_report", occurredAt: "2026-09-06T12:00:00Z", title: "Instafy", body: "Support replied to your report.", url: `/studio?supportReportId=${id}`, readAt: null, seenAt: null, archivedAt: null });
const page = (items = [event()], nextCursor: string | null = null) => ({ items, nextCursor, unreadCount: items.length, asOf: "2026-09-06T12:01:00Z" });
const preferences = { hidePreviews: true, preferences: [{ category: "support", channel: "local", enabled: true }] };
function Harness({ userId = A }: { userId?: string }) {
  const center = useNotificationCenter({ userId, accessToken: `token-${userId}`, navigate: mocks.navigate });
  return <>{center.bell}{center.dialog}</>;
}
let root: Root;
let container: HTMLDivElement;
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => button?.click());
}
async function open() { await act(async () => (document.querySelector('[data-testid="notification-center-bell"]') as HTMLButtonElement).click()); }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.foreground = false; mocks.subscription = false;
  mocks.list.mockResolvedValue(page()); mocks.state.mockResolvedValue(undefined); mocks.readAll.mockResolvedValue(undefined); mocks.getPreferences.mockResolvedValue(preferences); mocks.savePreferences.mockResolvedValue(preferences);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("notification center", () => {
  it("shows the durable unread badge and opens the exact support report", async () => {
    expect(container.querySelector('[data-testid="notification-center-unread"]')?.textContent).toBe("1");
    await open();
    const item = document.querySelector(`[data-testid="notification-${A}"] button`) as HTMLButtonElement;
    await act(async () => item.click());
    expect(mocks.navigate).toHaveBeenCalledWith(`/studio?supportReportId=${A}`);
    expect(mocks.state).toHaveBeenCalledWith({ id: A, action: "read", accessToken: `token-${A}` });
  });
  it("paginates, filters and uses the server snapshot when marking all read", async () => {
    mocks.list.mockImplementation(async ({ before, view }) => before ? page([event(B)]) : page([event()], view === "unread" ? null : "opaque-cursor"));
    await open(); await click("Load more");
    expect(document.querySelectorAll('[data-testid^="notification-111"], [data-testid^="notification-222"]')).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ before: "opaque-cursor" }));
    await click("Unread");
    expect(document.querySelector(`[data-testid="notification-${B}"]`)).toBeNull();
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ view: "unread" }));
    await click("Mark all read");
    expect(mocks.readAll).toHaveBeenCalledWith({ before: "2026-09-06T12:01:00Z", accessToken: `token-${A}` });
    await click("Archive");
    expect(mocks.state).toHaveBeenCalledWith({ id: A, action: "archive", accessToken: `token-${A}` });
  });
  it("saves preview and category/channel preferences on the server", async () => {
    await open(); await click("Preferences");
    const preview = [...document.querySelectorAll('input[type="checkbox"]')][0] as HTMLInputElement;
    await act(async () => preview.click());
    expect(mocks.savePreferences).toHaveBeenCalledWith({ hidePreviews: false, accessToken: `token-${A}` });
    const channel = document.querySelector('[aria-label="Support Browser push"]') as HTMLInputElement;
    await act(async () => channel.click());
    expect(mocks.savePreferences).toHaveBeenCalledWith({ preferences: [{ category: "support", channel: "web_push", enabled: false }], accessToken: `token-${A}` });
  });
  it("clears account state immediately and ignores old-account delayed responses", async () => {
    await open();
    let complete: ((value: ReturnType<typeof page>) => void) | undefined;
    mocks.list.mockImplementation(({ accessToken }) => accessToken === `token-${A}` ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(page([])));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => root.render(<Harness userId={B} />));
    await act(async () => complete?.(page([event()])));
    expect(container.querySelector('[data-testid="notification-center-unread"]')).toBeNull();
    expect(document.querySelector('[data-testid="notification-center"]')).toBeNull();
  });
  it("leaves foreground presentation to Web Push while that channel is active", async () => {
    mocks.foreground = true; mocks.subscription = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalledWith(expect.objectContaining({ action: "seen" }));
  });

  it("acknowledges a queued foreground toast only on actual presentation", async () => {
    mocks.foreground = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.show).toHaveBeenCalled();
    const options = mocks.show.mock.calls.at(-1)?.[3];
    expect(mocks.state).not.toHaveBeenCalledWith(expect.objectContaining({ action: "seen" }));
    await act(async () => options.onShow());
    expect(mocks.state).toHaveBeenCalledWith({ id: A, action: "seen", accessToken: `token-${A}` });
    await act(async () => root.render(<Harness userId={B} />));
    mocks.state.mockClear();
    await act(async () => options.onShow());
    expect(mocks.state).not.toHaveBeenCalled();
  });

});
