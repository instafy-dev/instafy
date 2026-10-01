import { describe, expect, it } from "vitest";
import type { ConversationState } from "../../conversations/conversationState";
import { getFallbackConversationTitle } from "../../conversations/conversationAutoTitle";
import { deriveSpaceNameFromMessage, resolveSpaceAutoName } from "../spaceAutoName";

// Built in pieces so the public boundary gate does not read it as a token.
const FAKE_GITHUB_TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

const FREEFINANCE_IMPORT =
  "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --name freefinance --start";
const ACME_REPORTS_IMPORT =
  "/skills import https://github.com/acme/tools/tree/main/skills/acme-reports --name acme-reports --start";

function importNamed(slug: string): string {
  return `/skills import https://github.com/acme/tools/tree/main/skills/x --name ${slug} --start`;
}

function conversation(overrides: Partial<ConversationState> & { opening?: string } = {}): ConversationState {
  const { opening, ...rest } = overrides;
  return {
    localId: "conversation-1",
    title: "Conversation 1",
    visibility: "public",
    lifecycleStatus: "active",
    parentConversationId: null,
    threadKind: null,
    createdAt: 1,
    messages: opening
      ? [{ id: "user-1", role: "user", authorId: "user-a", content: opening, timestamp: 1, files: null, messageType: "user", metadata: null }]
      : [],
    ...rest,
  } as ConversationState;
}

describe("deriveSpaceNameFromMessage", () => {
  it("names a new space after the tool or pack an import sets up", () => {
    expect(deriveSpaceNameFromMessage(FREEFINANCE_IMPORT)).toBe("FreeFinance");
    expect(deriveSpaceNameFromMessage("/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping --start"))
      .toBe("Bookkeeping");
  });

  it("names nothing from a prompt's own words, which everyone in the space would see", () => {
    expect(deriveSpaceNameFromMessage("plan our Q3 launch with the design team")).toBeNull();
    expect(deriveSpaceNameFromMessage("Connect Notion")).toBeNull();
    expect(deriveSpaceNameFromMessage(`${FAKE_GITHUB_TOKEN} please use this for the repo`)).toBeNull();
    expect(deriveSpaceNameFromMessage("hi")).toBeNull();
    expect(deriveSpaceNameFromMessage("/skills start freefinance")).toBeNull();
  });

  it("keeps a long pack name to 60 characters, cut at a word", () => {
    const long = deriveSpaceNameFromMessage(importNamed(Array.from({ length: 40 }, (_, index) => `word${index}`).join("-")));
    expect(long).toBe("Word0 Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9");
    // No small word is left dangling where it was cut.
    expect(deriveSpaceNameFromMessage(importNamed(
      "monthly-bookkeeping-checklist-for-small-businesses-and-the-accountants-office",
    ))).toBe("Monthly Bookkeeping Checklist For Small Businesses");
    // A name that fits is kept whole, and one word too long to fit is not cut.
    expect(deriveSpaceNameFromMessage(importNamed("quarterly-vat-filing"))).toBe("Quarterly Vat Filing");
    expect(deriveSpaceNameFromMessage(importNamed("a".repeat(61)))).toBeNull();
  });
});

describe("resolveSpaceAutoName", () => {
  it("waits until a chat has a real title", () => {
    expect(resolveSpaceAutoName([])).toBeNull();
    expect(resolveSpaceAutoName([conversation({ opening: "help me" })])).toBeNull();
  });

  it("prefers the connector a chat opened with over that chat's title", () => {
    expect(resolveSpaceAutoName([conversation({ title: "Connect FreeFinance", opening: FREEFINANCE_IMPORT })]))
      .toBe("FreeFinance");
    // Loaded from the controller, so its messages are not held here: the
    // title the import gave it still names the tool or pack.
    const loaded = { hasRemoteMessages: true };
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Connect FreeFinance" })])).toBe("FreeFinance");
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Set up Bookkeeping" })])).toBe("Bookkeeping");
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Set up Team" })])).toBe("Team");
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Connect the printer" })])).toBeNull();
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Set up my new laptop" })])).toBeNull();
  });

  it("names a space from a title only when it names a first-party connector or pack", () => {
    const loaded = { hasRemoteMessages: true };
    // A fallback or model title is someone's own words in the same shape.
    const ownWords = getFallbackConversationTitle("set up Google Ads for the shop");
    expect(ownWords).toBe("Set up Google Ads");
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: ownWords! })])).toBeNull();
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Connect Google Ads" })])).toBeNull();
    // Another pack's import title cannot be told apart from such words, so
    // only the import line itself names the space after it.
    expect(resolveSpaceAutoName([conversation({ ...loaded, title: "Set up Acme Reports" })])).toBeNull();
    expect(resolveSpaceAutoName([conversation({ title: "Set up Acme Reports", opening: ACME_REPORTS_IMPORT })]))
      .toBe("Acme Reports");
  });

  it("keeps a name taken from a long import to 60 characters", () => {
    const opening = importNamed("monthly-bookkeeping-checklist-for-small-businesses-and-the-accountants-office");
    expect(resolveSpaceAutoName([conversation({ title: "Set up Monthly Bookkeeping", opening })]))
      .toBe("Monthly Bookkeeping Checklist For Small Businesses");
  });

  it("never names a space after a chat's own words", () => {
    expect(resolveSpaceAutoName([conversation({ title: "Quarterly VAT filing", opening: "Quarterly VAT filing" })])).toBeNull();
    // An opening line held here decides, so a matching title alone does not.
    expect(resolveSpaceAutoName([conversation({ title: "Set up Docker", opening: "Set up Docker" })])).toBeNull();
    expect(resolveSpaceAutoName([conversation({ title: "Yes, that one", hasRemoteMessages: true })])).toBeNull();
  });

  it("never reads a later import as the chat's opening line", () => {
    // After a reload the local list holds only the reply sent since.
    expect(resolveSpaceAutoName([
      conversation({ title: "Plan the books", hasRemoteMessages: true, opening: FREEFINANCE_IMPORT }),
    ])).toBeNull();
    // Nor one that rebuilt the chat from a single incoming message.
    expect(resolveSpaceAutoName([
      conversation({ title: "Connect FreeFinance", remoteSummaryPending: true, opening: FREEFINANCE_IMPORT }),
    ])).toBeNull();
  });

  it("waits for the first shared root chat's title instead of using a newer chat", () => {
    const chats = [
      conversation({ localId: "newer", title: "Book March invoices", hasRemoteMessages: true, createdAt: 30 }),
      conversation({ localId: "thread", title: "Thread notes here", threadKind: "thread", parentConversationId: "parent", hasRemoteMessages: true, createdAt: 1 }),
      conversation({ localId: "private", title: "Salary review notes", visibility: "private", hasRemoteMessages: true, createdAt: 2 }),
      conversation({ localId: "hidden", title: "Old hidden work", lifecycleStatus: "hidden", hasRemoteMessages: true, createdAt: 3 }),
      // Nobody has written here yet, so it is not the first conversation.
      conversation({ localId: "blank", title: "Conversation 1", createdAt: 0 }),
      conversation({ localId: "first", title: "Conversation 2", hasRemoteMessages: true, createdAt: 10 }),
    ];
    expect(resolveSpaceAutoName(chats)).toBeNull();
    const titled = chats.map((chat) => (chat.localId === "first" ? { ...chat, title: "Set up Bookkeeping" } : chat));
    expect(resolveSpaceAutoName(titled)).toBe("Bookkeeping");
    const newerImport = chats.map((chat) => (chat.localId === "newer" ? { ...chat, title: "Connect FreeFinance" } : chat));
    expect(resolveSpaceAutoName(newerImport)).toBeNull();
  });

  it("names nothing when the chat list may not reach back to the first chat", () => {
    const chats = Array.from({ length: 50 }, (_, index) => conversation({
      localId: `chat-${index}`,
      controllerId: `controller-${index}`,
      title: "Connect FreeFinance",
      hasRemoteMessages: true,
      createdAt: index,
    }));
    expect(resolveSpaceAutoName(chats)).toBeNull();
    expect(resolveSpaceAutoName(chats.slice(1))).toBe("FreeFinance");
  });
});
