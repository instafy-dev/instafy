import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
// Provider mock: production claims, validation, visibility and routing run unchanged.
function database(values: Map<string, unknown>) {
  return { close() {}, transaction() {
    const tx: { oncomplete?: () => void; onabort?: () => void; objectStore?: () => unknown } = {};
    let pending = 0; let aborted = false;
    const request = (operation: () => unknown) => {
      const result: { result?: unknown; onsuccess?: () => void } = {}; pending += 1;
      queueMicrotask(() => {
        if (aborted) return;
        try { result.result = operation(); result.onsuccess?.(); }
        catch { aborted = true; tx.onabort?.(); }
        pending -= 1;
        queueMicrotask(() => { if (!pending && !aborted) tx.oncomplete?.(); });
      });
      return result;
    };
    tx.objectStore = () => ({
      get: (key: string) => request(() => values.get(key)),
      add: (value: unknown, key: string) => request(() => { if (values.has(key)) throw new Error("ConstraintError"); values.set(key, value); }),
      openCursor: () => request(() => null),
    });
    return tx;
  } };
}
function worker({ account = A as string | null, visible = false } = {}) {
  const events = new Map<string, (event: unknown) => void>();
  const values = new Map<string, unknown>([["active-account", account]]);
  const show = vi.fn(); const navigate = vi.fn(); const focus = vi.fn(); const post = vi.fn(); const openWindow = vi.fn();
  const context = vm.createContext({ URL, Date, Promise, db: database(values), self: { location: { origin: "https://studio.example.test" }, addEventListener: (name: string, listener: (event: unknown) => void) => events.set(name, listener), registration: { showNotification: show }, clients: { matchAll: async () => [{ visibilityState: visible ? "visible" : "hidden", focused: visible, navigate, focus, postMessage: post }], openWindow } } });
  vm.runInContext(readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8") + "\nnotificationDatabase = async () => db;", context);
  const dispatch = async (name: string, event: object) => {
    let work: Promise<unknown> = Promise.resolve();
    events.get(name)?.({ ...event, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  };
  return { values, show, navigate, focus, post, openWindow, dispatch, clients: context.self.clients };
}
const payload = { eventId: B, accountId: A, title: "secret prompt", body: "internal logs and support notes", url: `/studio?supportReportId=${B}` };
describe("service-worker push transport simulation", () => {
  it("replaces retries with a stable tag and never displays arbitrary payload text", async () => {
    const w = worker();
    await Promise.all([w.dispatch("push", { data: { json: () => payload } }), w.dispatch("push", { data: { json: () => payload } })]);
    expect(w.show).toHaveBeenCalledTimes(2);
    expect(w.show).toHaveBeenCalledWith("Instafy", { body: "You have a new notification.", tag: B, renotify: false, data: { url: payload.url, eventId: B, accountId: A } });
  });
  it("displays every valid foreground push, even when the page already claimed it", async () => {
    const w = worker({ visible: true });
    await w.dispatch("push", { data: { json: () => payload } });
    expect(w.show).toHaveBeenCalledOnce();
    expect(w.post).toHaveBeenCalledWith({ type: "instafy:notification-received", accountId: A, eventId: B });
    const background = worker(); background.values.set(`${A}:${B}`, Date.now());
    await background.dispatch("push", { data: { json: () => payload } });
    expect(background.show).toHaveBeenCalledOnce();
  });
  it("suppresses deliveries after signout/account switch and rejects unsafe URLs", async () => {
    for (const account of [null, B]) {
      const w = worker({ account }); await w.dispatch("push", { data: { json: () => payload } }); expect(w.show).not.toHaveBeenCalled();
    }
    const w = worker(); await w.dispatch("push", { data: { json: () => ({ ...payload, url: "https://evil.test" }) } }); expect(w.show).not.toHaveBeenCalled();
  });
  it("resumes the exact report signed out, but refuses a different signed-in account", async () => {
    const signedOut = worker({ account: null });
    await signedOut.dispatch("notificationclick", { notification: { data: payload, close: vi.fn() } });
    expect(signedOut.navigate).toHaveBeenCalledWith(`${payload.url}&notificationEventId=${B}&notificationAccountId=${A}`);
    const switched = worker({ account: B });
    await switched.dispatch("notificationclick", { notification: { data: payload, close: vi.fn() } });
    expect(switched.navigate).not.toHaveBeenCalled();
  });
  it("revalidates the account after window lookup before presenting a push", async () => {
    const w = worker();
    w.clients.matchAll = async () => { w.values.set("active-account", B); return []; };
    await w.dispatch("push", { data: { json: () => payload } });
    expect(w.show).not.toHaveBeenCalled();
  });
  it("revalidates account changes during click window lookup", async () => {
    for (const initial of [A, null]) {
      const w = worker({ account: initial });
      w.clients.matchAll = async () => {
        w.values.set("active-account", B);
        return [{ navigate: w.navigate, focus: w.focus }];
      };
      await w.dispatch("notificationclick", { notification: { data: payload, close: vi.fn() } });
      expect(w.navigate).not.toHaveBeenCalled();
      expect(w.openWindow).not.toHaveBeenCalled();
    }
  });
  it("carries an authorized receipt on a cold-start click and rejects malformed event IDs", async () => {
    const w = worker({ account: null });
    w.clients.matchAll = async () => [];
    await w.dispatch("notificationclick", { notification: { data: payload, close: vi.fn() } });
    expect(w.openWindow).toHaveBeenCalledWith(`${payload.url}&notificationEventId=${B}&notificationAccountId=${A}`);
    w.openWindow.mockClear();
    await w.dispatch("notificationclick", { notification: { data: { ...payload, eventId: "not-a-uuid" }, close: vi.fn() } });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("honors preview opt-in using only the static backend event descriptions", async () => {
    const w = worker();
    await w.dispatch("push", { data: { json: () => ({ ...payload, body: "There is a new reply to your support report." }) } });
    expect(w.show.mock.calls[0][1].body).toBe("There is a new reply to your support report.");
  });

});
