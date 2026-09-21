// @vitest-environment jsdom
import { act, StrictMode } from "react";
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
const event = (id = A) => ({ id, eventName: "support.reply", version: 1, category: "support", resourceId: id, resourceType: "support_report", occurredAt: "2026-09-06T12:00:00Z", title: "Instafy", body: "Support replied to your report.", url: `/studio?supportReportId=${id}`, readAt: null as string | null, seenAt: null, archivedAt: null });
const page = (items = [event()], nextCursor: string | null = null) => ({ items, nextCursor, unreadCount: items.length, asOf: "2026-09-06T12:01:00Z" });
const preferences = { hidePreviews: true, preferences: [{ category: "support", channel: "local", enabled: true }] };
function Harness({ userId = A, token = `token-${userId}` }: { userId?: string; token?: string }) {
  const center = useNotificationCenter({ userId, accessToken: token, navigate: mocks.navigate });
  return <div>
    {center.error ? <p role="alert">{center.error}</p> : null}
    <span data-testid="count">{center.page.items.length}</span>
    <span data-testid="loading">{String(center.loading)}</span>
    {center.page.items.map(item => <button key={item.id} data-testid={`notification-${item.id}`} data-read={Boolean(item.readAt)} onClick={() => void center.markRead([item])}>{item.body}</button>)}
    <button onClick={() => void center.refresh()}>Retry</button>
    <button onClick={() => void center.loadMore()}>Load more</button>
    <button onClick={() => void center.markRead(center.page.items)}>Mark loaded read</button>
  </div>;
}
let root: Root;
let container: HTMLDivElement;
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => button?.click());
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.foreground = false; mocks.subscription = false;
  mocks.list.mockResolvedValue(page()); mocks.state.mockResolvedValue(undefined); mocks.readAll.mockResolvedValue(undefined); mocks.getPreferences.mockResolvedValue(preferences); mocks.savePreferences.mockResolvedValue(preferences);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("notification center", () => {
  it("exposes Home data and acknowledges only the displayed IDs", async () => {
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("1");
    await click("Mark loaded read");
    expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ id: A, action: "read", accessToken: `token-${A}`, expectedUserId: A, isCurrent: expect.any(Function) }));
    expect(mocks.readAll).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="notification-center-bell"]')).toBeNull();
    const pin = mocks.state.mock.calls.find(([args]) => args.action === "read")?.[0].isCurrent;
    expect(pin()).toBe(true);
    await act(async () => root.render(<Harness token="updated-token" />));
    expect(pin()).toBe(false);
  });
  it("loads older unread pages even when they are outside the first Recent page", async () => {
    mocks.list.mockImplementation(async ({ view, before }) => view === "unread" ? (before ? page([event(B)]) : page([event()], "unread-next")) : page([event()]));
    await click("Retry");
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("2");
    expect(mocks.list).toHaveBeenCalledWith({ view: "unread", before: "unread-next", accessToken: `token-${A}` });
  });
  it("preserves loaded Recent pages while refreshing their read states", async () => {
    mocks.list.mockImplementation(async ({ view, before }) => view === "unread" ? page([]) : before ? page([{ ...event(B), readAt: "2026-09-07T00:00:00Z" }]) : page([event()], "older"));
    await click("Retry"); await click("Load more"); await click("Retry");
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("2");
    await click("Mark loaded read");
    expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ id: A, action: "read", accessToken: `token-${A}`, expectedUserId: A }));
    expect(mocks.state).not.toHaveBeenCalledWith(expect.objectContaining({ id: B }));
  });
  it("retains the oldest loaded row when new arrivals shift page boundaries", async () => {
    const C = "33333333-3333-4333-8333-333333333333";
    const D = "44444444-4444-4444-8444-444444444444";
    const E = "55555555-5555-4555-8555-555555555555";
    let rows = [A, B, C, D].map((id, index) => ({
      ...event(id), occurredAt: `2026-09-07T12:0${4 - index}:00Z`, readAt: "2026-09-07T13:00:00Z",
    }));
    mocks.list.mockImplementation(async ({ view, before }) => {
      if (view === "unread") return page([]);
      const offset = before ? rows.findIndex(item => item.id === before) + 1 : 0;
      const selected = rows.slice(offset, offset + 2);
      return page(selected, offset + 2 < rows.length ? selected.at(-1)!.id : null);
    });
    await click("Retry");
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("2");
    await click("Load more");
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("4");
    rows = [{ ...event(E), occurredAt: "2026-09-07T12:05:00Z", readAt: "2026-09-07T13:00:00Z" }, ...rows];
    await click("Retry");
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("5");
    expect(container.querySelector(`[data-testid="notification-${D}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="notification-${E}"]`)).not.toBeNull();
    expect(mocks.list).toHaveBeenCalledWith({ view: "all", before: C, accessToken: `token-${A}` });
  });
  it("restarts a StrictMode request and ignores its delayed cleanup response", async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    let resolveAbandoned: ((value: ReturnType<typeof page>) => void) | undefined;
    let allRequests = 0;
    mocks.list.mockImplementation(({ view }) => {
      if (view === "unread") return Promise.resolve(page([]));
      allRequests += 1;
      if (allRequests === 1) return new Promise(resolve => { resolveAbandoned = resolve; });
      return Promise.resolve(page([event(B)]));
    });
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    expect(allRequests).toBe(2);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe("false");
    expect(container.querySelector(`[data-testid="notification-${B}"]`)).not.toBeNull();
    await act(async () => resolveAbandoned?.(page([event(A)])));
    expect(container.querySelector(`[data-testid="notification-${A}"]`)).toBeNull();
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("1");
    await click("Retry");
    expect(allRequests).toBe(3);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe("false");
  });
  it("reports server unavailability and recovers without claiming an empty inbox", async () => {
    mocks.list.mockRejectedValue(new Error("Unable to load notifications (404)"));
    await click("Retry");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Notifications are unavailable on this server.");
    mocks.list.mockResolvedValue(page([]));
    await click("Retry");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("clears account data immediately and ignores delayed responses, including token changes", async () => {
    let complete: ((value: ReturnType<typeof page>) => void) | undefined;
    mocks.list.mockImplementation(({ accessToken }) => accessToken === `token-${A}` ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(page([])));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => root.render(<Harness userId={A} token="refreshed-token" />));
    await act(async () => complete?.(page([event()])));
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("0");
    await act(async () => root.render(<Harness userId={B} />));
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("0");
  });
  it("leaves foreground presentation to Web Push while that channel is active", async () => {
    mocks.foreground = true; mocks.subscription = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      // The transport modules are loaded lazily; React act alone does not wait
      // for a cold dynamic import to finish on the CI runner.
      await vi.dynamicImportSettled();
    });
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalledWith(expect.objectContaining({ action: "seen" }));
  });

  it("presents from the unread page refresh already fetched (2 list calls per tick, not 3)", async () => {
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls.map(([args]) => args.view)).toEqual(["all", "unread"]);
    mocks.foreground = true;
    mocks.list.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.dynamicImportSettled();
    });
    expect(mocks.list.mock.calls.map(([args]) => args.view)).toEqual(["all", "unread"]);
    expect(mocks.show).toHaveBeenCalledWith("Support replied to your report.", "info", 10_000, expect.objectContaining({ id: `notification:${A}:${A}` }));
  });

  describe("polling", () => {
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    beforeEach(async () => {
      await act(async () => root.unmount());
      vi.useFakeTimers();
      setVisibility("visible");
      window.dispatchEvent(new Event("pointerdown"));
      mocks.list.mockClear();
      root = createRoot(container);
      await act(async () => root.render(<Harness />));
      expect(mocks.list).toHaveBeenCalledTimes(2);
    });
    afterEach(() => { setVisibility("visible"); vi.useRealTimers(); });
    it("advances 20 s while active and polls once", async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(mocks.list).toHaveBeenCalledTimes(4);
      expect(mocks.list.mock.calls.slice(2).map(([args]) => args.view)).toEqual(["all", "unread"]);
    });
    it("does not poll while the document is hidden and polls once when it is visible again", async () => {
      await act(async () => setVisibility("hidden"));
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      await act(async () => setVisibility("visible"));
      expect(mocks.list).toHaveBeenCalledTimes(4);
    });
    it("backs off to 120 s after three minutes without input", async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await act(async () => window.dispatchEvent(new Event("pointerdown")));
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
      const settled = mocks.list.mock.calls.length;
      expect(settled).toBe(2 + 9 * 2);
      await act(async () => { await vi.advanceTimersByTimeAsync(115_000); });
      expect(mocks.list).toHaveBeenCalledTimes(settled);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(mocks.list).toHaveBeenCalledTimes(settled + 2);
    });
  });

  it("acknowledges a queued foreground toast only on actual presentation", async () => {
    mocks.foreground = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.dynamicImportSettled();
    });
    expect(mocks.show).toHaveBeenCalled();
    const options = mocks.show.mock.calls.at(-1)?.[3];
    expect(mocks.state).not.toHaveBeenCalledWith(expect.objectContaining({ action: "seen" }));
    await act(async () => options.onShow());
    expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ id: A, action: "seen", accessToken: `token-${A}`, expectedUserId: A }));
    await act(async () => root.render(<Harness userId={B} />));
    mocks.state.mockClear();
    await act(async () => options.onShow());
    expect(mocks.state).not.toHaveBeenCalled();
  });

});
