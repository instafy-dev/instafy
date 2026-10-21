// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SitePreviewPane } from "../SitePreviewPane";
import { ASK_CONFIRM_ARM_MS } from "../previewHost/AskConfirmStrip";
import { ASK_HIDDEN_TEXT, ASK_NO_CLICK_TEXT, ASK_NOT_SENT_TEXT, ASK_SENT_DEADLINE_MS, type SiteAskHost } from "../previewHost/useSiteAsks";
import { FRAME_GESTURE_MS } from "../previewHost/frameGesture";
import type { AskRunOutcome } from "../previewHost/siteAsks";

// Ask Octo from a site in a preview pane (docs/Bound-Sites.md §2a): the layout says who may ask, an ask from the
// pane's own frame becomes the person's own message through the conversation's send path, and the page hears what
// became of it. Every page message is a request: the words are Studio's, and the caps are Studio's.

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER = "https://p-aaaaaaaaaaaaaaaaaaaaaaaaaa--11111111111141118111111111111111.preview.localhost/";
const ORIGIN = new URL(VIEWER).origin;

const mocks = vi.hoisted(() => ({
  createSitePreviewViewer: vi.fn(),
  getSitePreview: vi.fn(),
  heartbeatSitePreviewViewer: vi.fn(),
  revokeSitePreviewViewer: vi.fn(),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  ...mocks,
}));

const record = { previewId: PREVIEW_ID, title: "Running shoes", port: 4180, path: "/", runtimeId: "runtime-1",
  status: "active", health: { listening: true, status: 200 }, messageId: null, createdAt: null };

let askSeq = 0;
const askMessage = (overrides: Record<string, unknown> = {}) => ({
  source: "instafy-bind", v: 1, type: "ask",
  payload: {
    id: `int_m1abc_${(askSeq += 1).toString(36).padStart(4, "0")}`, intent: "check_size", label: "Ask Octo",
    say: "Is size {size} in stock for {ref}?", params: { ref: "shoes:karhu-ikoni-3", size: "10" }, ref: "shoes:karhu-ikoni-3",
    ...overrides,
  },
});

describe("Ask Octo from a site in a preview pane", () => {
  let root: Root;
  let container: HTMLDivElement;
  let send: ReturnType<typeof vi.fn<SiteAskHost["send"]>>;
  let outcomes: Map<string, AskRunOutcome>;
  let canAsk: SiteAskHost["canAsk"];
  let posted: ReturnType<typeof vi.spyOn>;
  let userSeq = 0;
  let userId = "user-1";
  const activation = { isActive: false };

  const host = (): SiteAskHost => ({ canAsk, userId, send, outcomes: new Map(outcomes) });
  async function render(options: { visible?: boolean; asks?: SiteAskHost | null } = {}) {
    const asks = options.asks === undefined ? host() : options.asks;
    await act(async () => root.render(<SitePreviewPane projectId="project-1" previewId={PREVIEW_ID} title="Running shoes" visible={options.visible ?? true} asks={asks} />));
    await flush();
  }
  async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid=site-preview-frame]")!;
  /** The person clicks in the frame: it takes the focus, and the browser's user activation is on for a moment. */
  function clickInFrame() {
    frame().focus();
    activation.isActive = true;
  }
  /** A message from the frame; by default right after a click in it (`clicked: false`: the page posts on its own). */
  async function fromFrame(data: unknown, { origin = ORIGIN, source, clicked = true }: { origin?: string; source?: MessageEventSource | null; clicked?: boolean } = {}) {
    if (clicked) clickInFrame();
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin, source: source === undefined ? frame().contentWindow : source })); });
    await flush();
  }
  type Sent = { type: string; caps?: Record<string, unknown>; payload?: { id: string; state: string; reason?: string } };
  const sent = (): Sent[] => posted.mock.calls.map((call: unknown[]) => call[0] as Sent);
  const statuses = () => sent().filter(message => message.type === "ask-status").map(message => message.payload);
  const layouts = () => sent().filter(message => message.type === "layout");

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    activation.isActive = false;
    Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => activation });
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.createSitePreviewViewer.mockResolvedValue({ viewerUrl: VIEWER, idleTimeoutSeconds: 1800, expiresAt: null });
    mocks.getSitePreview.mockResolvedValue(record);
    mocks.heartbeatSitePreviewViewer.mockResolvedValue("live");
    mocks.revokeSitePreviewViewer.mockResolvedValue(undefined);
    send = vi.fn<SiteAskHost["send"]>().mockResolvedValue(true);
    outcomes = new Map();
    canAsk = true;
    // Each test is its own person, so the tab-wide caps of one test do not reach the next.
    userId = `user-${(userSeq += 1)}`;
    await render();
    posted = vi.spyOn(frame().contentWindow!, "postMessage").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (navigator as { userActivation?: unknown }).userActivation;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("tells the site this person may ask, and sends a click as their own message with the site intent, answering sent then done", async () => {
    await act(async () => frame().dispatchEvent(new Event("load")));
    expect(layouts().at(-1)?.caps).toEqual({ location: "host", ask: true });

    const ask = askMessage();
    await fromFrame(ask);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      text: "Is size 10 in stock for Karhu ikoni 3? · via Running shoes",
      metadata: { siteIntent: { previewId: PREVIEW_ID, askId: ask.payload.id, intent: "check_size", label: "Ask Octo", say: "Is size {size} in stock for {ref}?", ref: "shoes:karhu-ikoni-3", params: { ref: "shoes:karhu-ikoni-3", size: "10" } } },
    });
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "sent" }]);
    expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ type: "ask-status" }), ORIGIN);

    // Its run ends: the page hears done, once.
    outcomes.set(ask.payload.id, "running");
    await render();
    expect(statuses()).toHaveLength(1);
    outcomes.set(ask.payload.id, "done");
    await render();
    await render();
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "sent" }, { id: ask.payload.id, state: "done" }]);
  });

  it("reads asks only from its own frame at the viewer's origin, and drops a repeated id", async () => {
    await fromFrame(askMessage(), { origin: "https://attacker.example" });
    await fromFrame(askMessage(), { source: window });
    expect(send).not.toHaveBeenCalled();
    const ask = askMessage();
    await fromFrame(ask);
    outcomes.set(ask.payload.id, "done");
    await render();
    await fromFrame(ask);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("someone who may not send messages here: the layout gives the reason, and a click sends nothing", async () => {
    canAsk = "You can view this space but not send messages in it, so you can't ask Octo here.";
    await render();
    expect(layouts().at(-1)?.caps).toEqual({ location: "host", ask: canAsk });
    const ask = askMessage();
    await fromFrame(ask);
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "declined", reason: canAsk }]);
  });

  it("where Studio takes no asks the layout leaves caps.ask out", async () => {
    await render({ asks: null });
    expect(layouts().at(-1)?.caps).toEqual({ location: "host" });
    await fromFrame(askMessage());
    expect(send).not.toHaveBeenCalled();
  });

  it("one ask at a time per person and site, with a plain reason; the next goes once the first one's run ended", async () => {
    const first = askMessage();
    await fromFrame(first);
    const second = askMessage();
    await fromFrame(second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)).toEqual({ id: second.payload.id, state: "declined", reason: "Octo is still answering your last question from this site. Try again when it's done." });
    outcomes.set(first.payload.id, "failed");
    await render();
    expect(statuses().at(-1)).toEqual({ id: first.payload.id, state: "failed", reason: "Octo could not finish. The chat says why." });
    await fromFrame(askMessage());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a send the chat refused is declined, and does not count", async () => {
    send.mockResolvedValueOnce(false);
    const ask = askMessage();
    await fromFrame(ask);
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "declined", reason: ASK_NOT_SENT_TEXT }]);
    await fromFrame(askMessage());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a slow send still answers sent before the page gives up at 5 s", async () => {
    let finish: (sent: boolean) => void = () => {};
    send.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const ask = askMessage();
    await fromFrame(ask);
    expect(statuses()).toEqual([]);
    await advance(ASK_SENT_DEADLINE_MS);
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "sent" }]);
    await act(async () => { finish(true); });
    await flush();
    expect(statuses()).toHaveLength(1);
  });

  it("a page in a hidden pane asks nothing", async () => {
    await render({ visible: false });
    const ask = askMessage();
    await fromFrame(ask);
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "declined", reason: ASK_HIDDEN_TEXT }]);
  });

  it("an unreadable ask is declined by its id, never sent", async () => {
    await fromFrame({ source: "instafy-bind", v: 1, type: "ask", payload: { id: "int_bad_0001", intent: "check_size", label: "Ask Octo", params: "size=10" } });
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ id: "int_bad_0001", state: "declined", reason: "Instafy could not read this question, so it wasn't sent." }]);
  });

  it("an intent marked confirm shows Studio's own strip first: the page waits, Send is off for a moment, Cancel sends nothing", async () => {
    const ask = askMessage({ confirm: true });
    await fromFrame(ask);
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ id: ask.payload.id, state: "confirm" }]);
    const strip = container.querySelector("[data-testid=site-ask-confirm]")!;
    expect(strip.textContent).toContain("Send “Is size 10 in stock for Karhu ikoni 3? · via Running shoes” as you?");
    const sendButton = () => container.querySelector<HTMLButtonElement>("[data-testid=site-ask-confirm-send]")!;
    expect(sendButton().disabled).toBe(true);
    await act(async () => sendButton().click());
    expect(send).not.toHaveBeenCalled();
    await advance(ASK_CONFIRM_ARM_MS);
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    // Studio's own strip, not the page, says the person confirmed it.
    expect(send.mock.calls[0][0].metadata).toMatchObject({ siteIntent: { confirmed: true } });
    expect(statuses().at(-1)).toEqual({ id: ask.payload.id, state: "sent" });
    expect(container.querySelector("[data-testid=site-ask-confirm]")).toBeNull();

    outcomes.set(ask.payload.id, "done");
    await render();
    const cancelled = askMessage({ confirm: true });
    await fromFrame(cancelled);
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=site-ask-confirm-cancel]")!.click());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)).toEqual({ id: cancelled.payload.id, state: "declined", reason: "Not sent." });
  });

  it("an ask nobody just clicked sends nothing: a page posting on load, focus elsewhere, or an old click", async () => {
    const onLoad = askMessage();
    await fromFrame(onLoad, { clicked: false });
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ id: onLoad.payload.id, state: "declined", reason: ASK_NO_CLICK_TEXT }]);

    // The browser saw a click, but in Studio, not in this frame.
    activation.isActive = true;
    (document.activeElement as HTMLElement | null)?.blur();
    const elsewhere = askMessage();
    await fromFrame(elsewhere, { clicked: false });
    expect(send).not.toHaveBeenCalled();

    // The frame has the focus from a click long ago; the activation is over.
    frame().focus();
    activation.isActive = false;
    const later = askMessage();
    await fromFrame(later, { clicked: false });
    expect(send).not.toHaveBeenCalled();
    expect(statuses().map(status => status?.reason)).toEqual([ASK_NO_CLICK_TEXT, ASK_NO_CLICK_TEXT, ASK_NO_CLICK_TEXT]);

    // A real click in the frame: it is sent, and declined ones did not use up the caps.
    await fromFrame(askMessage());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("without the browser's user activation, focus moving into the frame a moment ago counts as the click", async () => {
    delete (navigator as { userActivation?: unknown }).userActivation;
    frame().focus();
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await advance(0);
    await fromFrame(askMessage(), { clicked: false });
    expect(send).toHaveBeenCalledTimes(1);
    outcomes.set((send.mock.calls[0][0].metadata.siteIntent as { askId: string }).askId, "done");
    await render();
    await advance(FRAME_GESTURE_MS);
    const stale = askMessage();
    await fromFrame(stale, { clicked: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)).toEqual({ id: stale.payload.id, state: "declined", reason: ASK_NO_CLICK_TEXT });
  });

  it("a run that started holds the one-at-a-time slot past 15 minutes, until it ends", async () => {
    const first = askMessage();
    await fromFrame(first);
    outcomes.set(first.payload.id, "running");
    await render();
    await advance(16 * 60_000);
    const second = askMessage();
    await fromFrame(second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)).toMatchObject({ id: second.payload.id, state: "declined" });
    outcomes.set(first.payload.id, "done");
    await render();
    await fromFrame(askMessage());
    expect(send).toHaveBeenCalledTimes(2);
  });
});
