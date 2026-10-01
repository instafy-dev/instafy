/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversationState";
import type { ChatMessage } from "../../screens/studio/types";

const requestTitleMock = vi.hoisted(() => vi.fn());
const updateMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      conversations: {
        ...actual.controllerClient.conversations,
        requestTitle: requestTitleMock,
        updateMetadata: updateMetadataMock,
      },
    },
  };
});

import { useConversationAutoTitle } from "../useConversationAutoTitle";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const ME = "user-a";
const TEAMMATE = "user-b";
let nextConversation = 0;

function userMessage(content: string, index: number, authorId = ME): ChatMessage {
  return {
    id: `user-${index}`,
    role: "user",
    authorId,
    content,
    timestamp: Date.now() + index,
    files: null,
    messageType: "user",
    metadata: null,
  };
}

type MaybeAutoTitle = ReturnType<typeof useConversationAutoTitle>["maybeAutoTitleConversation"];
type QueueAutoTitle = ReturnType<typeof useConversationAutoTitle>["queueAutoTitleConversation"];

// The attempt cache is module-wide, as in the app, so every case uses a fresh id.
// `hasRemoteMessages` marks a chat loaded from the controller: its earlier
// messages live in the history query, not in this local list.
function buildConversation(
  messages: string[],
  hasRemoteMessages = false,
  overrides: Partial<ConversationState> & { authorId?: string } = {},
): ConversationState {
  nextConversation += 1;
  const { authorId = ME, ...rest } = overrides;
  return {
    localId: `conversation-${nextConversation}`,
    controllerId: `controller-${nextConversation}`,
    title: "Conversation 1",
    parentConversationId: null,
    threadKind: null,
    hasRemoteMessages,
    messages: messages.map((content, index) => userMessage(content, index, authorId)),
    ...rest,
  } as unknown as ConversationState;
}

function Harness({
  conversations,
  setConversationTitle,
  onReady,
}: {
  conversations: ConversationState[];
  setConversationTitle: (conversationId: string, title: string) => void;
  onReady?: (maybeAutoTitle: MaybeAutoTitle, queueAutoTitle: QueueAutoTitle) => void;
}) {
  const { maybeAutoTitleConversation, queueAutoTitleConversation } = useConversationAutoTitle({
    conversations,
    currentUserId: ME,
    resolveProjectId: () => PROJECT_ID,
    ensureControllerConversationId: async (_projectId, conversation) => conversation.controllerId,
    setConversationTitle,
  });
  onReady?.(maybeAutoTitleConversation, queueAutoTitleConversation);
  return null;
}

describe("useConversationAutoTitle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const setConversationTitle = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // A managed-tier account has no default credential of its own, so the
    // controller answers without a title and without an error.
    requestTitleMock.mockReset().mockResolvedValue({ success: true, title: null, error: null });
    updateMetadataMock.mockReset().mockResolvedValue(true);
    setConversationTitle.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  let queueAutoTitle!: QueueAutoTitle;

  async function render(conversation: ConversationState): Promise<MaybeAutoTitle> {
    let maybeAutoTitle!: MaybeAutoTitle;
    await act(async () => root.render(
      <Harness
        conversations={[conversation]}
        setConversationTitle={setConversationTitle}
        onReady={(next, queue) => { maybeAutoTitle = next; queueAutoTitle = queue; }}
      />,
    ));
    return maybeAutoTitle;
  }

  async function renderAndSettle(conversation: ConversationState): Promise<MaybeAutoTitle> {
    const maybeAutoTitle = await render(conversation);
    await settle();
    return maybeAutoTitle;
  }

  it("titles a managed-tier chat from its opening message when the controller has no title", async () => {
    const conversation = buildConversation(["help me file my VAT return for March"]);
    await renderAndSettle(conversation);
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "help me file my VAT return for March" });
    expect(setConversationTitle).toHaveBeenCalledWith(conversation.localId, "File my VAT return for March");
    expect(updateMetadataMock).toHaveBeenCalledWith({
      conversationId: conversation.controllerId,
      metadata: { title: "File my VAT return for March" },
    });
  });

  it("titles a connector import opener without the model", async () => {
    const conversation = buildConversation([
      "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --name freefinance --start",
    ]);
    await renderAndSettle(conversation);
    expect(setConversationTitle).toHaveBeenCalledWith(conversation.localId, "Connect FreeFinance");
  });

  it("never titles a chat from a later reply", async () => {
    const conversation = buildConversation(["/skills start freefinance", "Yes, that one"]);
    await renderAndSettle(conversation);
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "Yes, that one" });
    expect(setConversationTitle).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });

  it("never titles a loaded chat from a reply when its opening message is not held here", async () => {
    // Opening a long chat seeds the latest reply from the merged history.
    const loaded = buildConversation([], true);
    const maybeAutoTitle = await renderAndSettle(loaded);
    await act(async () => maybeAutoTitle(loaded.localId, "Yes, that one"));
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "Yes, that one" });
    expect(setConversationTitle).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();

    // A reply sent after a reload is the only message held locally.
    const replied = buildConversation(["Yes, that one"], true);
    await renderAndSettle(replied);
    expect(setConversationTitle).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });

  it("titles a loaded chat from its opening message once its whole history is known", async () => {
    const loaded = buildConversation([], true);
    const maybeAutoTitle = await renderAndSettle(loaded);
    await act(async () => maybeAutoTitle(loaded.localId, "Yes, that one", { content: "Book the March invoices", authorId: ME }));
    expect(setConversationTitle).toHaveBeenCalledWith(loaded.localId, "Book the March invoices");
    expect(updateMetadataMock).toHaveBeenCalledWith({
      conversationId: loaded.controllerId,
      metadata: { title: "Book the March invoices" },
    });
  });

  it("leaves a chat whose opening message someone else wrote to that person's client", async () => {
    const teammates = buildConversation(["Plan the spring launch"], false, { authorId: TEAMMATE });
    await renderAndSettle(teammates);
    expect(requestTitleMock).toHaveBeenCalled();
    expect(setConversationTitle).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();

    const loaded = buildConversation([], true);
    const maybeAutoTitle = await renderAndSettle(loaded);
    await act(async () => maybeAutoTitle(loaded.localId, "Yes, that one", { content: "Plan the spring launch", authorId: TEAMMATE }));
    expect(setConversationTitle).not.toHaveBeenCalled();
  });

  it("waits for the chat list before titling a chat rebuilt from a message or a draft", async () => {
    const pending = buildConversation(["Book the March invoices"], false, { remoteSummaryPending: true });
    await renderAndSettle(pending);
    expect(requestTitleMock).not.toHaveBeenCalled();
    expect(setConversationTitle).not.toHaveBeenCalled();

    // The list confirms it as an untitled chat this tab holds whole.
    await renderAndSettle({ ...pending, remoteSummaryPending: false });
    expect(setConversationTitle).toHaveBeenCalledWith(pending.localId, "Book the March invoices");
  });

  it("keeps the opening message read before the requests when a list refresh lands during them", async () => {
    let answerTitle!: (value: unknown) => void;
    requestTitleMock.mockImplementation(() => new Promise((resolve) => { answerTitle = resolve; }));
    const conversation = buildConversation(["Draft the April newsletter"]);
    await render(conversation);
    await settle();
    expect(requestTitleMock).toHaveBeenCalledTimes(1);
    // The list now reports the chat's message as remote history.
    await render({ ...conversation, hasRemoteMessages: true });
    await act(async () => answerTitle({ success: true, title: null, error: null }));
    await settle();
    expect(setConversationTitle).toHaveBeenCalledWith(conversation.localId, "Draft the April newsletter");
  });

  it("keeps the opening message a submit queues with when a list refresh lands before the message does", async () => {
    let answerTitle!: (value: unknown) => void;
    requestTitleMock.mockImplementation(() => new Promise((resolve) => { answerTitle = resolve; }));
    const blank = buildConversation([]);
    await renderAndSettle(blank);
    // A submit queues the title in the same tick it appends the message, so
    // the list this hook reads does not hold the message yet.
    act(() => queueAutoTitle(blank.localId, "Draft the April newsletter", { content: "Draft the April newsletter", authorId: ME }));
    await settle();
    expect(requestTitleMock).toHaveBeenCalledTimes(1);
    // The next list refresh reports that message as remote history.
    await render({ ...blank, hasRemoteMessages: true, messages: [userMessage("Draft the April newsletter", 0)] });
    await act(async () => answerTitle({ success: true, title: null, error: null }));
    await settle();
    expect(setConversationTitle).toHaveBeenCalledWith(blank.localId, "Draft the April newsletter");
  });

  it("keeps the model title when the controller returns one", async () => {
    requestTitleMock.mockResolvedValue({ success: true, title: "Quarterly VAT filing", error: null });
    const conversation = buildConversation(["help me file my VAT return for March"]);
    await renderAndSettle(conversation);
    expect(setConversationTitle).toHaveBeenCalledWith(conversation.localId, "Quarterly VAT filing");
  });

  it("gives no fallback title when the request is refused or fails", async () => {
    // A viewer is refused (403), and an outage is no answer either; neither
    // means the controller has no title to give.
    requestTitleMock.mockResolvedValue({ success: false, title: null, error: "Forbidden" });
    const conversation = buildConversation(["Draft the April newsletter"]);
    await renderAndSettle(conversation);
    expect(requestTitleMock).toHaveBeenCalled();
    expect(setConversationTitle).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });
});
