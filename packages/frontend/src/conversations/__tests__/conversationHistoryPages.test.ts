import { describe, expect, it } from "vitest";
import { reconcileConversationHistory, type ConversationHistoryData, type ConversationHistoryPage } from "../conversationHistoryPages";

function page(from: number, to: number, readVersion = 1, hasMore = true): ConversationHistoryPage {
  const messages = Array.from({ length: to - from + 1 }, (_, index) => {
    const n = to - index;
    return { id: String(n).padStart(4, "0"), content: `Message ${n}`, role: "assistant" as const, timestamp: n };
  });
  return { messages, nextCursor: hasMore ? messages[messages.length - 1]?.id ?? null : null, hasMore, notFound: false, accessDenied: false, readVersion };
}

describe("reconcileConversationHistory", () => {
  const cached: ConversationHistoryData = { pages: [page(101, 150), page(51, 100), page(1, 50, 1, false)], pageParams: [null, "0101", "0051"] };

  it("adds new messages and updates existing ones without gaps or duplicate IDs across pages", () => {
    const latest = page(111, 160, 2);
    latest.messages[20].content = "Edited on server";
    const result = reconcileConversationHistory(cached, latest);
    const messages = result.pages.flatMap((entry) => entry.messages);
    expect(messages).toHaveLength(160);
    expect(new Set(messages.map((message) => message.id)).size).toBe(160);
    expect(messages[20].content).toBe("Edited on server");
    expect(result.pageParams).toEqual([null, "0111", "0061", "0011"]);
    expect(result.pages.at(-1)?.hasMore).toBe(false);
    expect(result.pages.at(-1)?.nextCursor).toBeNull();
  });

  it("resets the older cursor when more than a page arrived so no missing range is skipped", () => {
    const latest = page(211, 260, 2);
    expect(reconcileConversationHistory(cached, latest)).toEqual({ pages: [latest], pageParams: [null] });
  });

  it("keeps pagination available at the oldest retained server ID", () => {
    const truncated = { pages: cached.pages.slice(0, 2), pageParams: cached.pageParams.slice(0, 2) };
    const result = reconcileConversationHistory(truncated, page(111, 160, 2));
    expect(result.pages.at(-1)?.hasMore).toBe(true);
    expect(result.pages.at(-1)?.nextCursor).toBe("0051");
  });

  it("treats a complete or empty fresh response as authoritative", () => {
    const latest = page(141, 150, 2, false);
    expect(reconcileConversationHistory(cached, latest).pages).toEqual([latest]);
    const empty = { ...latest, messages: [] };
    expect(reconcileConversationHistory(cached, empty).pages).toEqual([empty]);
  });

  it("removes rows missing from the refreshed range but keeps older rows", () => {
    const latest = page(111, 160, 2);
    latest.messages = latest.messages.filter((message) => message.id !== "0140");
    const messages = reconcileConversationHistory(cached, latest).pages.flatMap((entry) => entry.messages);
    expect(messages.some((message) => message.id === "0140")).toBe(false);
    expect(messages.some((message) => message.id === "0100")).toBe(true);
  });

  it("preserves server cursor order for timestamps differing below JavaScript millisecond precision", () => {
    const serverRows = Array.from({ length: 51 }, (_, n) => ({
      id: String(n).padStart(4, "0"), content: `Message ${n}`, role: "assistant" as const,
      timestamp: Date.parse(`2026-09-07T08:00:00.123${String(999 - n).padStart(3, "0")}Z`),
    }));
    const previous = { ...page(1, 50), messages: serverRows.slice(1), nextCursor: "0050" };
    const latest = { ...page(1, 50, 2), messages: serverRows.slice(0, 50), nextCursor: "0049" };
    const result = reconcileConversationHistory({ pages: [previous], pageParams: [null] }, latest);
    expect(result.pages.flatMap((entry) => entry.messages)).toEqual(serverRows);
    expect(result.pageParams).toEqual([null, "0049"]);
    expect(result.pages.at(-1)?.nextCursor).toBe("0050");
  });

  it("does not overwrite newer history or recreate unchanged cached arrays", () => {
    expect(reconcileConversationHistory(cached, page(101, 150))).toBe(cached);
    expect(reconcileConversationHistory(cached, page(101, 150, 0))).toBe(cached);
  });

  it("removes every cached page for explicit access denial", () => {
    const denied = { ...page(1, 0, 2, false), accessDenied: true };
    expect(reconcileConversationHistory(cached, denied).pages).toEqual([denied]);
  });
});
