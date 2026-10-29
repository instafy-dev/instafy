import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../../../services/runtimeController/activity";
import type { ProductNotification } from "../../../notifications/notificationContract";
import { HOME_LIVE_DAY_KEY, type HomeFeedDay, type HomeFeedEvent } from "../homeFeed";
import { arrangeHomeSections, homeChatKey } from "../homeSections";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CHAT_A = "22222222-2222-4222-8222-222222222222";
const CHAT_B = "33333333-3333-4333-8333-333333333333";

function activityEvent(id: number, chat: string | null, overrides: Partial<HomeFeedEvent> = {}): HomeFeedEvent {
  const item = {
    id: String(id), kind: "conversation.reply", at: "2026-10-28T08:00:00Z",
    project: { id: PROJECT, name: "Space" }, org: null,
    conversation: chat ? { id: chat, title: null, visibility: "public", threadKind: null } : null,
    run: null, actor: { kind: "system", userId: null, displayName: null, handle: null, avatarSeed: null },
    title: null, preview: "Follow site is ready to preview.", needsYou: false, live: false, seen: false, data: {},
  } as ActivityItem;
  return {
    key: `activity:${id}`, lane: "activity", kind: "reply", title: "Follow site", preview: item.preview,
    at: Date.parse(item.at) - id, project: { id: PROJECT, name: "Space" }, team: { key: "personal", name: "Personal" },
    actor: null, isNew: false, testId: `home-recent-item-${id}`, dismissible: false,
    group: { count: 2, ids: [id, id - 100] },
    source: { type: "activity", item }, ...overrides,
  };
}

function notificationEvent(id: string, chat: string): HomeFeedEvent {
  const item = {
    id, eventName: "conversation.reply", category: "conversations", version: 1, resourceType: "conversation",
    resourceId: chat, occurredAt: "2026-10-28T08:00:00Z", title: "Instafy", body: "",
    url: `/studio?projectId=${PROJECT}&conversationControllerId=${chat}`, readAt: null, seenAt: null, archivedAt: null,
  } as ProductNotification;
  return {
    key: `notification:${id}`, lane: "activity", kind: "reply", title: "Follow site", preview: null, at: 1,
    project: { id: PROJECT, name: "Space" }, team: { key: "personal", name: "Personal" }, actor: null, isNew: true,
    testId: `home-notification-${id}`, dismissible: false, notifications: [item], source: { type: "notification", item },
  };
}

function day(key: string, events: HomeFeedEvent[]): HomeFeedDay {
  return { key, label: key, events };
}

describe("arrangeHomeSections", () => {
  it("names one chat by the same key whichever row stands for it", () => {
    expect(homeChatKey(activityEvent(1, CHAT_A.toUpperCase()), [])).toBe(CHAT_A);
    expect(homeChatKey(notificationEvent("n1", CHAT_A), [])).toBe(CHAT_A);
    expect(homeChatKey(activityEvent(2, null), [])).toBeNull();
  });

  it("merges rows in a row for the same chat into one that stands for all their updates", () => {
    const sections = arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [day("today", [
        activityEvent(30, CHAT_A), notificationEvent("n1", CHAT_A), activityEvent(20, CHAT_A), activityEvent(10, CHAT_B, { title: "Lisbon trip" }),
      ])] },
      conversations: [], resumeChatKey: null, recentChats: [],
    });
    const rows = sections.activity[0].events;
    expect(rows.map((row) => row.key)).toEqual(["activity:30", "activity:10"]);
    // The newest row stands for 2 + 1 + 2 updates, and keeps every durable alert it covers.
    expect(rows[0].group).toEqual({ count: 5, ids: [30, -70, 20, -80] });
    expect(rows[0].isNew).toBe(true);
    expect(rows[0].notifications?.map((item) => item.id)).toEqual(["n1"]);
  });

  it("never merges rows about no chat, or rows for one chat with another chat between them", () => {
    const sections = arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [day("today", [
        activityEvent(40, null), activityEvent(30, null), activityEvent(20, CHAT_A), activityEvent(15, CHAT_B, { title: "Lisbon trip" }), activityEvent(10, CHAT_A),
      ])] },
      conversations: [], resumeChatKey: null, recentChats: [],
    });
    expect(sections.activity[0].events.map((row) => row.key)).toEqual(
      ["activity:40", "activity:30", "activity:20", "activity:15", "activity:10"],
    );
  });

  it("merges past rows in a row for different chats that would read exactly the same", () => {
    // Five untitled chats in one space, each with the same last update, read
    // as five identical rows: they become one, standing for all their updates.
    const chats = [CHAT_A, CHAT_B, "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"];
    const sections = arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [
        day(HOME_LIVE_DAY_KEY, [activityEvent(90, chats[0], { kind: "running" }), activityEvent(80, chats[1], { kind: "running" })]),
        day("today", [
          activityEvent(30, chats[0]), activityEvent(20, chats[1]), activityEvent(10, chats[2]),
          activityEvent(5, chats[3], { title: "Lisbon trip" }), activityEvent(4, chats[4]),
        ]),
      ] },
      conversations: [], resumeChatKey: null, recentChats: [],
    });
    // Work in flight stays one row per chat.
    expect(sections.activity[0].events.map((row) => row.key)).toEqual(["activity:90", "activity:80"]);
    const rows = sections.activity[1].events;
    expect(rows.map((row) => row.key)).toEqual(["activity:30", "activity:5", "activity:4"]);
    expect(rows[0].group).toEqual({ count: 6, ids: [30, -70, 20, -80, 10, -90] });
    expect(rows[0].title).toBe("Follow site");

    // A different update, space or kind keeps the rows apart.
    const apart = arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [day("today", [
        activityEvent(30, chats[0]),
        activityEvent(20, chats[1], { preview: "Lisbon map is ready to preview." }),
        activityEvent(10, chats[2], { project: { id: "99999999-9999-4999-8999-999999999999", name: "Other space" } }),
        activityEvent(5, chats[3], { kind: "run_failed", statusLabel: "Run failed" }),
      ])] },
      conversations: [], resumeChatKey: null, recentChats: [],
    });
    expect(apart.activity[0].events.map((row) => row.key)).toEqual(["activity:30", "activity:20", "activity:10", "activity:5"]);
  });

  it("lists each chat once: Unread, then Continue working, Recent chats, Recent activity", () => {
    const unread = activityEvent(50, CHAT_A, { lane: "needs" });
    const recent = activityEvent(40, CHAT_B);
    const sections = arrangeHomeSections({
      feed: { needs: [unread], hasCut: false, activity: [
        day(HOME_LIVE_DAY_KEY, [activityEvent(60, CHAT_A, { kind: "running" })]),
        day("today", [recent, activityEvent(30, "44444444-4444-4444-8444-444444444444")]),
      ] },
      conversations: [],
      resumeChatKey: CHAT_A,
      recentChats: [unread, recent],
    });
    expect(sections.showResume).toBe(false);
    expect(sections.recentChats).toEqual([recent]);
    expect(sections.activity.map((group) => group.key)).toEqual(["today"]);
    expect(sections.activity[0].events.map((row) => row.key)).toEqual(["activity:30"]);
    // Its In progress row stepped aside; the row that lists the chat says it instead.
    expect(sections.liveByChat.get(CHAT_A)?.key).toBe("activity:60");
    expect(sections.liveByChat.size).toBe(1);

    const resumed = arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [day("today", [recent])] },
      conversations: [], resumeChatKey: CHAT_B, recentChats: [recent],
    });
    expect(resumed.showResume).toBe(true);
    expect(resumed.recentChats).toEqual([]);
    expect(resumed.activity).toEqual([]);
  });

  it("puts the chat Continue working gave way to first under Unread, where a phone still shows it", () => {
    const resumed = activityEvent(10, CHAT_A, { lane: "needs" });
    const newer = [1, 2, 3, 4, 5].map((n) => activityEvent(50 + n, `9999999${n}-9999-4999-8999-999999999999`, { lane: "needs" }));
    const sections = arrangeHomeSections({
      feed: { needs: [...newer, resumed], hasCut: false, activity: [] },
      conversations: [], resumeChatKey: CHAT_A, recentChats: [],
    });
    expect(sections.showResume).toBe(false);
    expect(sections.needs.map((row) => row.key)).toEqual([resumed.key, ...newer.map((row) => row.key)]);
    // Without a chat to resume, Unread keeps its newest-first order.
    expect(arrangeHomeSections({
      feed: { needs: [...newer, resumed], hasCut: false, activity: [] },
      conversations: [], resumeChatKey: null, recentChats: [],
    }).needs.map((row) => row.key)).toEqual([...newer, resumed].map((row) => row.key));
  });

  it("puts the cut before the first row already seen, among the rows that remain", () => {
    const fresh = activityEvent(30, CHAT_A, { isNew: true });
    const sections = arrangeHomeSections({
      feed: { needs: [], hasCut: true, activity: [
        day(HOME_LIVE_DAY_KEY, [activityEvent(60, "55555555-5555-4555-8555-555555555555", { kind: "running" })]),
        day("today", [activityEvent(40, CHAT_B, { isNew: true }), fresh, activityEvent(10, null)]),
      ] },
      conversations: [], resumeChatKey: null, recentChats: [activityEvent(40, CHAT_B)],
    });
    // One In progress row, then the new row; the seen row follows the cut.
    expect(sections.sinceCutIndex).toBe(2);
    expect(arrangeHomeSections({
      feed: { needs: [], hasCut: false, activity: [day("today", [fresh, activityEvent(10, null)])] },
      conversations: [], resumeChatKey: null, recentChats: [],
    }).sinceCutIndex).toBeNull();
  });
});
