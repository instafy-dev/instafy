import { describe, expect, it } from "vitest";
import { withUserMentionMetadata } from "../userMentions";

const USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const editor = (children: unknown[]) => JSON.stringify({ root: { children } });
const mention = (userId: string) => ({ type: "user-mention", userId, handle: "teammate", displayName: "Teammate" });

describe("structured human mention metadata", () => {
  it("normalizes and deduplicates selected people without forwarding names or editor state", () => {
    expect(withUserMentionMetadata({ unrelated: true }, editor([
      mention(USER_ID.toUpperCase()), mention(USER_ID), mention("invalid-id"),
      { type: "assistant-mention", userId: USER_ID, handle: "octo" },
    ]))).toEqual({ unrelated: true, mentionedUserIds: [USER_ID] });
  });

  it("never guesses plain @text or retains a removed/private-declined mention from prior metadata", () => {
    expect(withUserMentionMetadata({ mentionedUserIds: [USER_ID] }, editor([
      { type: "text", text: "@teammate", userId: USER_ID },
    ]))).toEqual({});
    expect(withUserMentionMetadata(null, "invalid JSON")).toEqual({});
  });

  it("allows 32 distinct people and rejects 33 rather than silently dropping a recipient", () => {
    const nodes = Array.from({ length: 33 }, (_, i) => mention(`${i.toString(16).padStart(8, "0")}-bbbb-4ccc-8ddd-eeeeeeeeeeee`));
    expect(withUserMentionMetadata(null, editor(nodes.slice(0, 32))).mentionedUserIds).toHaveLength(32);
    expect(() => withUserMentionMetadata(null, editor(nodes))).toThrow("Mention up to 32 people");
  });
});
