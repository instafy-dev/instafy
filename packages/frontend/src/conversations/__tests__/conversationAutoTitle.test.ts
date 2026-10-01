import { describe, expect, it } from "vitest";

import type { ConversationState } from "../ConversationsProvider";
import type { ChatMessage } from "../../screens/studio/types";
import {
  describeSkillImport,
  findReusableBlankConversation,
  getConversationAutoTitleSeed,
  getFallbackConversationTitle,
  getFirstUserMessage,
  getOpeningUserMessage,
  getStructuredConversationTitle,
  isDefaultConversationTitle,
  isReusableBlankConversation,
  shouldAutoTitleConversation,
} from "../conversationAutoTitle";

const FREEFINANCE_IMPORT =
  "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --name freefinance --start";
const BOOKKEEPING_PACK_IMPORT =
  "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping --start";

function userMessage(content: string, id = "user-1"): ChatMessage {
  return {
    id,
    role: "user",
    authorId: "user-a",
    content,
    timestamp: Date.now(),
    files: null,
    messageType: "user",
    metadata: null,
  };
}

function createConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    localId: "conv-1",
    title: "Conversation 1",
    visibility: "private",
    lifecycleStatus: "active",
    controllerId: null,
    parentConversationId: null,
    threadKind: null,
    ownerAgent: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: Date.now(),
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
    activeGoal: overrides.activeGoal ?? null,
  };
}

describe("conversationAutoTitle", () => {
  it("recognizes generated default conversation titles", () => {
    expect(isDefaultConversationTitle("Conversation 1")).toBe(true);
    expect(isDefaultConversationTitle("Conversation 42")).toBe(true);
    expect(isDefaultConversationTitle("Build launch plan")).toBe(false);
  });

  it("only auto-titles root conversations before the first user turn", () => {
    expect(
      shouldAutoTitleConversation(createConversation(), "Can you plan a launch campaign?"),
    ).toBe(true);

    expect(
      shouldAutoTitleConversation(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "hello",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
        "Can you plan a launch campaign?",
      ),
    ).toBe(false);

    expect(
      shouldAutoTitleConversation(
        createConversation({ parentConversationId: "parent-1", threadKind: "thread" }),
        "/learn",
      ),
    ).toBe(false);

    expect(
      shouldAutoTitleConversation(
        createConversation({ title: "Launch checklist" }),
        "Can you plan a launch campaign?",
      ),
    ).toBe(false);
  });

  it("extracts the latest user turn as an auto-title seed while the title is still default", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: " Can you plan a launch campaign? ",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe("Can you plan a launch campaign?");

    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "First",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
            {
              id: "user-2",
              role: "user",
              authorId: null,
              content: "Second",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe("Second");
  });

  it("does not seed auto-title for manually titled conversations or child threads", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          title: "Launch checklist",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Can you plan a launch campaign?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBeNull();

    expect(
      getConversationAutoTitleSeed(
        createConversation({
          parentConversationId: "parent-1",
          threadKind: "thread",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Can you plan a launch campaign?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does not invoke AI auto-title from a record-only ambient turn", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-silent",
              role: "user",
              authorId: "user-1",
              content: "Taylor, do you prefer option A?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: {
                groupParticipation: {
                  decision: "silent",
                  reason: "directed_to_human",
                },
                groupParticipationPreflight: { status: "resolved" },
              },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("waits for controller classification before auto-titling a deferred turn", () => {
    const deferredMessage = {
      id: "user-deferred",
      role: "user" as const,
      authorId: "user-1",
      content: "What is 1 + 1?",
      timestamp: Date.now(),
      files: null,
      messageType: "user",
      metadata: {
        groupParticipationPreflight: { status: "controller_deferred" },
      },
    };

    expect(
      getConversationAutoTitleSeed(
        createConversation({ messages: [deferredMessage] }),
      ),
    ).toBeNull();
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              ...deferredMessage,
              metadata: {
                ...deferredMessage.metadata,
                groupParticipation: { decision: "respond" },
              },
            },
          ],
        }),
      ),
    ).toBe("What is 1 + 1?");
  });

  it("derives structured titles from completed GitHub import metadata", () => {
    expect(
      getStructuredConversationTitle([
        {
          id: "assistant-1",
          role: "assistant",
          authorId: null,
          content: "Imported files.",
          timestamp: Date.now(),
          files: null,
          messageType: "assistant",
          metadata: {
            githubImport: {
              repo: "example/device-provider",
            },
          },
        },
      ]),
    ).toBe("Import example/device-provider");
  });

  it("titles a first-party connector import by the tool it connects", () => {
    expect(getStructuredConversationTitle([userMessage(FREEFINANCE_IMPORT)])).toBe("Connect FreeFinance");
    expect(getStructuredConversationTitle([
      userMessage("/skills import https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion/ --start"),
    ])).toBe("Connect Notion");
    // A borrowed --name does not make another pack first-party.
    expect(getStructuredConversationTitle([
      userMessage("/skills import https://github.com/someone/pack/tree/main/finance --overwrite --name freefinance"),
    ])).toBe("Set up Freefinance");
  });

  it("titles any other skill import by its pack or skill name", () => {
    expect(getStructuredConversationTitle([userMessage(BOOKKEEPING_PACK_IMPORT)])).toBe("Set up Bookkeeping");
    expect(getStructuredConversationTitle([
      userMessage("/skills import https://github.com/acme/tools/tree/main/.agents/skills --start"),
    ])).toBe("Set up Tools");
    expect(getStructuredConversationTitle([
      userMessage("/skills import https://github.com/acme/tools/tree/main/skills/acme-reports --name acme-reports --start"),
    ])).toBe("Set up Acme Reports");
    expect(getStructuredConversationTitle([userMessage("/skills import --start")])).toBeNull();
    expect(getStructuredConversationTitle([userMessage("/skills list")])).toBeNull();
    expect(describeSkillImport(FREEFINANCE_IMPORT)).toEqual({ firstParty: true, label: "FreeFinance" });
    expect(describeSkillImport(BOOKKEEPING_PACK_IMPORT)).toEqual({ firstParty: false, label: "Bookkeeping" });
  });

  it("builds a short sentence-case fallback title from an opening message", () => {
    expect(getFallbackConversationTitle("Book the March invoices")).toBe("Book the March invoices");
    expect(getFallbackConversationTitle("Plan the launch.")).toBe("Plan the launch");
    expect(getFallbackConversationTitle("Yes, that one")).toBe("Yes, that one");
    expect(getFallbackConversationTitle("Kannst du mir bei meiner Steuererklärung helfen?"))
      .toBe("Kannst du mir bei meiner Steuererklärung");
    const long = getFallbackConversationTitle("Internationalization considerations for multilingual onboarding documentation");
    expect(long).toBe("Internationalization considerations");
    expect(long!.length).toBeLessThanOrEqual(48);
  });

  it("starts after greetings and requests for help, and ends at the first sentence", () => {
    expect(getFallbackConversationTitle("help me file my VAT return for March")).toBe("File my VAT return for March");
    expect(getFallbackConversationTitle("Can you help me with my taxes?")).toBe("My taxes");
    expect(getFallbackConversationTitle("I need to reconcile the bank statements for Q3"))
      .toBe("Reconcile the bank statements");
    expect(getFallbackConversationTitle("Thanks! Now book the March invoices")).toBe("Now book the March invoices");
    expect(getFallbackConversationTitle("Bitte erstelle eine Rechnung für die Firma Müller"))
      .toBe("Erstelle eine Rechnung für die Firma");
    expect(getFallbackConversationTitle("Bitte erstelle die Rechnung für März")).toBe("Erstelle die Rechnung für März");
    // The sum is not a plain word, and "What" alone is too short.
    expect(getFallbackConversationTitle("What is 1+1? Reply with just the number.")).toBeNull();
    expect(getFallbackConversationTitle("@octo   **what** is 1+2? Reply with just the number.")).toBeNull();
    expect(getFallbackConversationTitle("1. Do this 2. Do that")).toBe("Do this");
  });

  it("stops where a link, address, path or code was taken out instead of joining the words around it", () => {
    expect(getFallbackConversationTitle("email me at bob@example.com about the invoice")).toBe("Email me");
    expect(getFallbackConversationTitle("Look at https://example.com/some/page please")).toBeNull();
    expect(getFallbackConversationTitle("email jane@example.com about https://example.com/invoice/42 today please"))
      .toBeNull();
    expect(getFallbackConversationTitle("Fix the bug in src/components/Card.tsx where the button overflows"))
      .toBe("Fix the bug");
    expect(getFallbackConversationTitle("Hi @bob can you review the PR")).toBe("Review the PR");
    expect(getFallbackConversationTitle("https://example.com/report summarize this page")).toBe("Summarize this page");
    expect(getFallbackConversationTitle("```js\nconsole.log(1)\n```")).toBeNull();
    expect(getFallbackConversationTitle("Use and/or in the copy")).toBeNull();
  });

  it("builds the title from plain words only and ends it before the first word that is not one", () => {
    // Letters in any script, apostrophes and hyphens inside a word, and
    // ending punctuation after it.
    expect(getFallbackConversationTitle("Can you help me with my taxes?")).toBe("My taxes");
    expect(getFallbackConversationTitle("Book the March invoices")).toBe("Book the March invoices");
    expect(getFallbackConversationTitle("Plan the spring launch")).toBe("Plan the spring launch");
    expect(getFallbackConversationTitle("Don't re-send the invoice")).toBe("Don't re-send the invoice");
    expect(getFallbackConversationTitle("Подготовь отчёт за квартал")).toBe("Подготовь отчёт за квартал");
    // A digit, a symbol or a word over 20 letters ends the title there.
    expect(getFallbackConversationTitle("pay with card 4111 1111 1111 1111 please")).toBe("Pay with card");
    expect(getFallbackConversationTitle("check the box at admin:Hunter2x now")).toBe("Check the box");
    expect(getFallbackConversationTitle("Book the invoices for $400 today")).toBe("Book the invoices");
    expect(getFallbackConversationTitle("Draft the launch Supercalifragilisticexpialidocious memo")).toBe("Draft the launch");
    // With fewer than two words left there is no title, not a later sentence.
    for (const message of [
      "log in with Sommer2024! and check the invoices",
      "admin:Hunter2x is the login",
      "add KqWmXrTzLpVnBcHdJfGsYaQe to the env",
      "add sk-proj-Zx9 Yw8Vu7Ts6R q5Po4Nm3Lk2 to the env",
      "use Hunter2x. Then open the dashboard",
    ]) {
      expect(getFallbackConversationTitle(message)).toBeNull();
    }
  });

  it("never echoes what may be a credential", () => {
    expect(getFallbackConversationTitle("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 please use this for the repo")).toBeNull();
    expect(getFallbackConversationTitle("sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa please")).toBeNull();
    expect(getFallbackConversationTitle("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc check this")).toBeNull();
    expect(getFallbackConversationTitle("revert 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c please")).toBeNull();
    // A secret can look like any word, so a message about one gets no title.
    expect(getFallbackConversationTitle("my password is Hunter2!x9 can you log in")).toBeNull();
    expect(getFallbackConversationTitle("Here is the API key for staging")).toBeNull();
    expect(getFallbackConversationTitle("Mein Passwort ist sonnenblume")).toBeNull();
    for (const message of [
      "pw Hunter2x then open the dashboard",
      "use pass Hunter2x for the admin account",
      "my pin is 4821 for the card",
      "Meine Zugangsdaten sind max Sommer2024",
      "Hier die Passwörter Sommer2024 und Winter2025",
    ]) {
      expect(getFallbackConversationTitle(message)).toBeNull();
    }
    // Each of these words alone keeps an otherwise plain message untitled.
    for (const word of [
      "password", "passwords", "Passwort", "Passwörter", "passwd", "pwd", "passphrase", "passcodes",
      "PIN", "pins", "login", "logins", "credentials", "Zugangsdaten", "Kennwort", "Kennwörter",
      "secret", "tokens", "API key", "api-keys", "apikey", "private key",
    ]) {
      expect(getFallbackConversationTitle(`Please update the ${word} for staging`), word).toBeNull();
    }
    // An over-long word is never cut down to fit.
    expect(getFallbackConversationTitle("x".repeat(80))).toBeNull();
  });

  it("does not end a cut title on a dangling small word", () => {
    expect(getFallbackConversationTitle("plan our spring launch with the design team")).toBe("Plan our spring launch");
    expect(getFallbackConversationTitle("draft a launch plan for the spring sale")).toBe("Draft a launch plan");
    // A whole message is kept as written.
    expect(getFallbackConversationTitle("what are you waiting for")).toBe("What are you waiting for");
  });

  it("gives no fallback title for one word, slash commands, links alone or default-looking text", () => {
    for (const message of ["hi", "Hi!", "hello there", "ok", "test", "Yes", "asdf", "Hey, can you help?"]) {
      expect(getFallbackConversationTitle(message)).toBeNull();
    }
    expect(getFallbackConversationTitle("/skills start freefinance")).toBeNull();
    expect(getFallbackConversationTitle("/goal finish the report")).toBeNull();
    expect(getFallbackConversationTitle("https://example.com/a/b")).toBeNull();
    expect(getFallbackConversationTitle("  ...  ")).toBeNull();
    expect(getFallbackConversationTitle("conversation 7")).toBeNull();
    expect(getFallbackConversationTitle(FREEFINANCE_IMPORT)).toBe("Connect FreeFinance");
  });

  it("reads the opening user message and its author, not the latest", () => {
    const messages = [userMessage("  "), userMessage(" Book March invoices ", "user-2"), userMessage("Yes, that one", "user-3")];
    expect(getFirstUserMessage(messages)).toEqual({ content: "Book March invoices", authorId: "user-a" });
    expect(getOpeningUserMessage(createConversation({ messages })))
      .toEqual({ content: "Book March invoices", authorId: "user-a" });
    expect(getOpeningUserMessage(createConversation())).toBeNull();
  });

  it("does not know the opening message of a chat loaded from the controller or rebuilt here", () => {
    // Its history is in the message query; the local list holds only what
    // arrived since, such as a reply sent after a reload.
    expect(getOpeningUserMessage(createConversation({ hasRemoteMessages: true }))).toBeNull();
    expect(getOpeningUserMessage(createConversation({
      hasRemoteMessages: true,
      messages: [userMessage("Yes, that one")],
    }))).toBeNull();
    // Built from one incoming message, or from a saved draft, before the chat
    // list has confirmed it.
    expect(getOpeningUserMessage(createConversation({
      remoteSummaryPending: true,
      messages: [userMessage("Yes, that one")],
    }))).toBeNull();
  });

  it("reuses pristine blank conversations, including the default assistant starter state", () => {
    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              authorId: null,
              content: "How can I help with your space?",
              timestamp: Date.now(),
              files: null,
              messageType: "status",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          draft: "hello",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              authorId: null,
              content: "How can I help with your space?",
              timestamp: Date.now(),
              files: null,
              messageType: "status",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Build me a landing page",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("finds the newest reusable blank conversation", () => {
    const reusableOlder = createConversation({
      localId: "conv-older",
      visibility: "public",
      createdAt: 10,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          authorId: null,
          content: "How can I help with your project?",
          timestamp: 10,
          files: null,
          messageType: "status",
          metadata: null,
        },
      ],
    });
    const reusableNewer = createConversation({
      localId: "conv-newer",
      visibility: "public",
      createdAt: 20,
      messages: [],
    });

    expect(
      findReusableBlankConversation([
        reusableOlder,
        createConversation({
          localId: "conv-used",
          visibility: "public",
          createdAt: 30,
          draft: "draft",
        }),
        reusableNewer,
      ])?.localId,
    ).toBe("conv-newer");
  });
});
