import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import {
  forgetPromptsSentFromThisPageForTests,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import { buildChatTimeDividers, formatChatTimeDivider } from "../chatTimeDividers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const local = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const BASE = local(2026, 7, 15, 10);
const message = (id: string, timestamp: number, rest: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, timestamp, role: "assistant", content: id, ...rest });
const ids = (messages: readonly ChatMessage[]) => [...buildChatTimeDividers(messages).keys()];
const clock = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));

afterEach(() => forgetPromptsSentFromThisPageForTests());

describe("buildChatTimeDividers", () => {
  it("starts at the first valid message and preserves the supplied order", () => {
    const rows = [message("later", BASE), message("earlier", BASE - MINUTE), message("next", BASE + MINUTE)];
    expect([...buildChatTimeDividers(rows)]).toEqual([["later", BASE]]);
    expect(rows.map(row => row.id)).toEqual(["later", "earlier", "next"]);
    expect(ids([])).toEqual([]);
  });

  it("adds a divider at exactly an hour of inactivity, not at 59:59", () => {
    expect(ids([message("first", BASE), message("next", BASE + HOUR - 1_000)])).toEqual(["first"]);
    expect(ids([message("first", BASE), message("next", BASE + HOUR)])).toEqual(["first", "next"]);
    expect(ids([message("first", BASE), message("middle", BASE + 40 * MINUTE), message("last", BASE + 80 * MINUTE)])).toEqual(["first"]);
  });

  it("marks local date changes even less than an hour apart", () => {
    const beforeMidnight = local(2026, 7, 15, 23, 55);
    const afterMidnight = local(2026, 7, 16, 0, 5);
    expect(ids([message("yesterday", beforeMidnight), message("today", afterMidnight)])).toEqual(["yesterday", "today"]);
    expect(ids([message("today", afterMidnight), message("clock-back", beforeMidnight)])).toEqual(["today", "clock-back"]);
  });

  it("does not manufacture a same-day hour gap after a small backward clock step", () => {
    expect(ids([
      message("first", BASE), message("clock-back", BASE - 10 * MINUTE),
      message("not-an-hour", BASE + 55 * MINUTE), message("real-gap", BASE + 115 * MINUTE),
    ])).toEqual(["first", "real-gap"]);
  });

  it("ignores missing, nonfinite and unrepresentable timestamps without resetting the previous valid one", () => {
    const invalid = [undefined, null, NaN, Infinity, -Infinity, 0, -1, 8_640_000_000_000_001];
    const rows = invalid.map((timestamp, index) => message(`invalid-${index}`, timestamp as number));
    expect(ids(rows)).toEqual([]);
    expect(ids([message("first", BASE), ...rows, message("hour-later", BASE + HOUR)])).toEqual(["first", "hour-later"]);
  });

  it("includes visible notices and cards but ignores browser continuations that were never sent", () => {
    const notice = message("notice", BASE + 45 * MINUTE, {
      role: "user", metadata: { browserHandBack: { browserJobId: "browser-job" } },
    });
    const card = message("card", BASE + 95 * MINUTE, { messageType: "action_request" });
    expect(ids([message("first", BASE), notice, card])).toEqual(["first"]);
    rememberPromptSentFromThisPage(notice);
    recordSendFailedForPromptSentFromThisPage(notice);
    expect(ids([message("first", BASE), notice, card])).toEqual(["first", "card"]);
    expect(ids([notice])).toEqual([]);
  });

  it("recomputes the first visible stretch when older history is prepended", () => {
    const current = message("current", BASE);
    expect(ids([current])).toEqual(["current"]);
    expect(ids([message("older", BASE - 30 * MINUTE), current])).toEqual(["older"]);
    expect(ids([message("much-older", BASE - 2 * HOUR), current])).toEqual(["much-older", "current"]);
  });

  it("measures inactivity from a folded run's latest sent nested message", () => {
    const run = message("run", BASE, { messageType: "agent_job_thread", metadata: {
      threadMessages: [message("start", BASE), message("end", BASE + 2 * HOUR)],
    } });
    expect(ids([run, message("immediate-reply", BASE + 2 * HOUR + MINUTE)])).toEqual(["run"]);
    expect(ids([run, message("real-gap", BASE + 3 * HOUR)])).toEqual(["run", "real-gap"]);
    expect(buildChatTimeDividers([run]).get("run")).toBe(BASE);
  });

  it("uses only valid known nested message times, including deeper folded runs", () => {
    const run = message("run", BASE, { messageType: "agent_job_thread", metadata: {
      updatedAt: BASE + 20 * HOUR,
      earlierAttempts: [[message("not-current-activity", BASE + 20 * HOUR)]],
      threadMessages: [null, {}, message("bad-time", Infinity), message("nested-run", BASE, { metadata: {
        threadMessages: [message("nested-end", BASE + 2 * HOUR)],
      } })],
    } });
    expect(ids([run, message("real-gap", BASE + 3 * HOUR)])).toEqual(["run", "real-gap"]);
  });

  it("marks the next visible local day even when folded activity crossed midnight", () => {
    const run = message("yesterday-run", local(2026, 7, 15, 23), { messageType: "agent_job_thread", metadata: {
      threadMessages: [message("today-end", local(2026, 7, 16, 2))],
    } });
    expect(ids([run, message("today", local(2026, 7, 16, 2, 5))])).toEqual(["yesterday-run", "today"]);
  });
});

describe("formatChatTimeDivider", () => {
  it("uses stable Today and Yesterday labels with a localized clock", () => {
    expect(formatChatTimeDivider(BASE, BASE + MINUTE)?.label).toBe(`Today · ${clock(BASE)}`);
    const yesterday = local(2026, 7, 14, 23, 55);
    expect(formatChatTimeDivider(yesterday, local(2026, 7, 15, 0, 5))?.label).toBe(`Yesterday · ${clock(yesterday)}`);
  });

  it.each([
    [2026, 3, 8],
    [2026, 11, 1],
  ])("uses local calendar subtraction across daylight-saving dates %i-%i-%i", (year, month, day) => {
    const yesterday = local(year, month, day, 0, 30);
    const now = local(year, month, day + 1, 0, 15);
    // In a DST zone these can be 22h45 or 24h45 apart, not a 24h day.
    expect(formatChatTimeDivider(yesterday, now)?.label).toBe(`Yesterday · ${clock(yesterday)}`);
  });

  it("uses the date for earlier days and includes the year only when it differs", () => {
    for (const timestamp of [local(2026, 3, 2, 9, 30), local(2025, 12, 20, 9, 30)]) {
      const date = new Date(timestamp);
      const day = new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", ...(date.getFullYear() !== 2026 ? { year: "numeric" as const } : {}),
      }).format(date);
      expect(formatChatTimeDivider(timestamp, BASE)?.label).toBe(`${day} · ${clock(timestamp)}`);
    }
  });

  it("retains an absolute accessible time and rejects invalid values", () => {
    const result = formatChatTimeDivider(BASE, BASE + MINUTE);
    expect(result?.dateTime).toBe(new Date(BASE).toISOString());
    expect(result?.title).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(BASE)));
    for (const timestamp of [NaN, Infinity, 0, -1, 8_640_000_000_000_001]) {
      expect(formatChatTimeDivider(timestamp, BASE)).toBeNull();
    }
    expect(formatChatTimeDivider(BASE, NaN)).toBeNull();
  });
});
