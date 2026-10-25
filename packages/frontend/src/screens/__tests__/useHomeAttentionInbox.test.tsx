// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listInbox: vi.fn() }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { notifications: { listInbox: mocks.listInbox } } }));

import { NOTIFICATION_FEED_CHANGED_EVENT } from "../../notifications/notificationFeedEvents";
import { NOTIFICATION_RECEIVED_EVENT } from "../../notifications/notificationPresentation";
import { HOME_ATTENTION_POLL_ACTIVE_MS, HOME_ATTENTION_POLL_IDLE_MS, useHomeAttentionInbox } from "../useHomeAttentionInbox";

const USER = "11111111-1111-4111-8111-111111111111";

function Harness({ conversation = null }: { conversation?: string | null }) {
  const { items } = useHomeAttentionInbox({ currentUserId: USER, visibleConversationControllerId: conversation });
  return <span data-testid="count">{items.length}</span>;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

let root: Root;
let container: HTMLDivElement;
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setVisibility("visible");
  window.dispatchEvent(new Event("pointerdown"));
  mocks.listInbox.mockReset();
  mocks.listInbox.mockResolvedValue({ success: true, items: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(mocks.listInbox).toHaveBeenCalledTimes(1);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setVisibility("visible");
  vi.useRealTimers();
});

describe("Home attention inbox", () => {
  // Measurement A: a visibility flip every 4.6 s re-read the inbox on each
  // flip (14 per 64 s). The notification center's own check covers a quick
  // return and announces a changed feed.
  it("does not re-read the inbox on quick visibility flips", async () => {
    for (let flip = 0; flip < 14; flip += 1) {
      await act(async () => setVisibility("hidden"));
      await advance(2_300);
      await act(async () => setVisibility("visible"));
      await advance(2_300);
    }
    expect(mocks.listInbox).toHaveBeenCalledTimes(1);
  });

  it("refreshes at once when the notification feed changes, a push arrives or the chat changes", async () => {
    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_FEED_CHANGED_EVENT)));
    expect(mocks.listInbox).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT)));
    expect(mocks.listInbox).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<Harness conversation="22222222-2222-4222-8222-222222222222" />));
    expect(mocks.listInbox).toHaveBeenCalledTimes(4);
  });

  it("falls back to a read every 2 min while active and every 10 min once idle", async () => {
    for (let step = 0; step < 2; step += 1) {
      await act(async () => window.dispatchEvent(new Event("pointerdown")));
      await advance(HOME_ATTENTION_POLL_ACTIVE_MS / 2 - 1);
    }
    expect(mocks.listInbox).toHaveBeenCalledTimes(1);
    await advance(2);
    expect(mocks.listInbox).toHaveBeenCalledTimes(2);
    // No more input: idle from 180 s after the last touch, next read 10 min
    // after the last one.
    await advance(HOME_ATTENTION_POLL_IDLE_MS - 1_000);
    expect(mocks.listInbox).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(mocks.listInbox).toHaveBeenCalledTimes(3);
  });
});
