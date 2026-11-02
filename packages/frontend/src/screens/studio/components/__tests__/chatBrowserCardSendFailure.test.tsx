// @vitest-environment jsdom

import { act, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPromptsSentFromThisPageForTests,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
  usePromptSendFailureVersion,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { forgetBrowserAutoStartsForTests } from "../browserAutoStart";
import {
  BrowserRequestHostContext,
  browserRequestContinuedKeys,
  newestBrowserRequestKey,
  type BrowserRequestCardState,
  type BrowserRequestHost,
} from "../browserRequest";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { routedBrowserWaitingKeys } from "../routedBrowserFold";
import { useChatBrowserRequest } from "../useChatBrowserRequest";

/**
 * A browser card leaves the chat once a continuation for it is in the chat,
 * and comes back with its button when the controller did not take that
 * continuation. A failed send may add no message, though: the chat does not
 * add an error again when it repeats the chat's last one within 15 s
 * (useConversationControllerDispatch). Only the sent-prompt registry knows
 * then, so the chat works out its rows and the cards' host again when the
 * registry says a send failed, as ChatPanel does (chatPanelPromptSendFailures
 * .test.ts reads that ChatPanel memoizes them the same way).
 */

const userInputRequests = vi.hoisted(() => ({ getUserInputRequest: vi.fn(), answerUserInputRequest: vi.fn() }));
vi.mock("../../../../services/runtimeController/userInputRequests", () => userInputRequests);
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ activeConversation: null, conversations: [] }),
}));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({
  useRuntimeMenuOptions: () => ({ runtime: { effectiveRuntimeId: null, preferredRuntimeId: null } }),
}));
vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({ activeConversationId: "conversation-local", agentHandles: [] }),
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openJobThreadTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../services/runtimeController/previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/previews")>()),
  getSitePreview: () => new Promise(() => {}),
}));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runs: [] }) }));

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: "message", role: "assistant", authorId: null, content: "", timestamp: 0, files: null, messageType: null,
    metadata: null, ...overrides };
}

const TASK = "Find a first-visit Seville itinerary on https://www.visitasevilla.es and verify the key places.";
const MAP_JOB = "77777777-7777-4777-8777-777777777777";
const MAP_RUN = "88888888-8888-4888-8888-888888888888";
const CARD_KEY = `job:${MAP_JOB}`;
const ERROR = "Controller unavailable. Try again shortly.";
const IN_USE = "Someone else is using Instafy's browser right now.";

function cardMessage(id: string, jobId: string, runId: string, timestamp: number, request: Record<string, unknown>) {
  return createMessage({ id, content: "Continue this task in Instafy's browser.", timestamp, messageType: "action_request",
    metadata: { messageType: "action_request", jobId, runId, source: "agent", kind: "update",
      details: { testId: "browser-request-card", title: "Continue in Instafy's browser", browserRequest: request,
        actions: [{ id: "continue-browser", label: "Open browser and continue", variant: "primary",
          event: "instafy:request-browser", busyLabel: "Opening browser…", testId: "browser-request-continue" }] } } });
}

function mapTurn(now: number): ChatMessage[] {
  return [
    createMessage({ id: "ask", role: "user", authorId: "user-1", content: "Plan 3 days in Seville.", timestamp: now - 6000,
      metadata: { runId: MAP_RUN } }),
    createMessage({ id: "map-step", content: "uw add-point", timestamp: now - 5000, messageType: "command_execution",
      metadata: { jobId: MAP_JOB, runId: MAP_RUN, source: "agent", kind: "update", outcome: "in_progress",
        messageType: "command_execution", details: { status: "completed" } } }),
    cardMessage("map-card", MAP_JOB, MAP_RUN, now - 4000, { task: TASK, location: "auto", continueBuilding: true }),
    createMessage({ id: "map-reply", content: "I made the Seville map and asked for a check of the sights.",
      timestamp: now - 3000, metadata: { jobId: MAP_JOB, runId: MAP_RUN, source: "agent", outcome: "succeeded" } }),
  ];
}

/** The chat's rows and the cards' host, memoized as ChatPanel memoizes them. */
function ChatRows({ messages, cardStates }: {
  messages: ChatMessage[];
  cardStates: ReadonlyMap<string, BrowserRequestCardState>;
}) {
  const promptSendFailures = usePromptSendFailureVersion();
  const collapsed = useMemo(() => collapseLifecycleMessages(messages), [messages]);
  const rows = useMemo(() => {
    void promptSendFailures;
    return synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
  }, [collapsed, promptSendFailures]);
  const continuedKeys = useMemo(() => {
    void promptSendFailures;
    return browserRequestContinuedKeys(messages);
  }, [messages, promptSendFailures]);
  const routedWaitingKeys = useMemo(() => {
    void promptSendFailures;
    return routedBrowserWaitingKeys(messages);
  }, [messages, promptSendFailures]);
  const newestCardKey = useMemo(() => newestBrowserRequestKey(messages), [messages]);
  const host = useMemo<BrowserRequestHost>(() => ({
    transport: "shared", personalAvailable: false, sharedUnavailable: false,
    cardStates, continuedKeys, routedWaitingKeys, newestCardKey,
  }), [cardStates, continuedKeys, routedWaitingKeys, newestCardKey]);
  return (
    <BrowserRequestHostContext.Provider value={host}>
      <ConversationMessageRows
        messages={rows}
        allConversationMessages={collapsed}
        currentUserId="user-1"
        chatClientSessionId="session-1"
        projectId="project-1"
        runtimeId={null}
        conversationLocalId="conversation-local"
        conversationControllerId="conversation-controller"
        firstPlanMessageId={null}
        humanLabelByUserId={new Map()}
        runAgentIdentityByRunId={new Map()}
        runAgentHandleByRunId={new Map()}
        renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
        onRequestActions={vi.fn()}
        onRequestActionsAtPoint={vi.fn()}
        onCancelTerminalCommand={null}
        onMessageContextMenu={vi.fn()}
      />
    </BrowserRequestHostContext.Provider>
  );
}

let releaseDispatch: (() => void) | null = null;
let sends = 0;
let errorsAdded = 0;

/**
 * A chat whose card the person presses, with the press as Studio sends it
 * (useChatBrowserRequest) and its send as the submit path makes it: the
 * continuation joins the chat before its dispatch, a dispatch the controller
 * did not take adds its error unless that repeats the chat's last message
 * from the last 15 s, the registry records the failure, and the press fails
 * with the error.
 */
function PressChat({ initial, held }: { initial: ChatMessage[]; held: BrowserRequestCardState }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const state = useChatBrowserRequest({
    identity: "chat-1", messages, canWrite: true, ready: true, transport: "shared", open: true, busy: false,
    personalAvailable: false, personalReady: false, sharedReady: true, sharedUnavailable: false,
    agentName: "Octo",
    activate: () => {},
    continueTask: async (_transport, task, extras) => {
      sends += 1;
      // What the dispatch compares with: the chat as it was before this send.
      const before = messagesRef.current;
      const prompt = createMessage({ id: `lookup-${sends}`, role: "user", authorId: "user-1",
        content: extras.display ?? task, timestamp: Date.now(),
        metadata: { ...extras.metadata, clientMessageId: `lookup-client-${sends}`, dispatchContent: task } });
      rememberPromptSentFromThisPage(prompt);
      setMessages((current) => [...current, prompt]);
      await new Promise<void>((resolve) => { releaseDispatch = resolve; });
      const latest = before.at(-1);
      const repeatsLastError = latest?.role === "assistant" && latest.messageType === "error" &&
        latest.content === ERROR && Date.now() - latest.timestamp < 15_000;
      if (!repeatsLastError) {
        errorsAdded += 1;
        setMessages((current) => [...current, createMessage({ id: `error-${sends}`, content: ERROR, timestamp: Date.now(),
          messageType: "error", metadata: { messageType: "error" } })]);
      }
      recordSendFailedForPromptSentFromThisPage({ metadata: prompt.metadata });
      throw new Error(ERROR);
    },
    onError: () => {},
  });
  // Studio could not open the card by itself: it stays a button, with why.
  const cardStates = useMemo(
    () => state.cardStates.has(CARD_KEY) ? state.cardStates : new Map([[CARD_KEY, held]]),
    [held, state.cardStates],
  );
  return <ChatRows messages={messages} cardStates={cardStates} />;
}

describe("a browser card whose press the controller did not take", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const g = globalThis as { CSS?: { escape?: (value: string) => string } };
    g.CSS = { ...g.CSS, escape: g.CSS?.escape ?? ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")) };
    forgetBrowserAutoStartsForTests();
    forgetPromptsSentFromThisPageForTests();
    releaseDispatch = null;
    sends = 0;
    errorsAdded = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    forgetPromptsSentFromThisPageForTests();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const read = () => ({
    cards: container.querySelectorAll('[data-testid="browser-request-card"]').length,
    button: container.querySelector<HTMLButtonElement>('[data-testid="browser-request-continue"]'),
    site: container.querySelector('[data-testid="browser-request-destination"]')?.textContent ?? null,
    reason: container.querySelector('[data-testid="browser-request-reason"]')?.textContent ?? null,
    line: container.querySelector('[data-testid="browser-request-opening"]')?.textContent ?? null,
    notices: [...container.querySelectorAll('[data-testid="chat-browser-request-notice"]')]
      .map((row) => row.textContent?.trim()),
  });
  const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

  /** Presses the card; the continuation joins the chat while it is sent. */
  async function press() {
    await act(async () => { read().button!.click(); });
    await tick();
    expect(releaseDispatch).not.toBeNull();
  }

  /** The controller answers that it did not take the continuation. */
  async function fail() {
    await act(async () => { releaseDispatch!(); releaseDispatch = null; });
    await tick();
  }

  it("comes back with its button, site and reason when the failure adds no message", async () => {
    // The person's own message failed a moment ago: its error is the chat's
    // last message, and the card's press fails the same way.
    const now = Date.now();
    const typed = createMessage({ id: "typed", role: "user", authorId: "user-1", content: "Also add tapas bars.",
      timestamp: now - 2000, metadata: { clientMessageId: "typed-client" } });
    const typedError = createMessage({ id: "typed-error", content: ERROR, timestamp: now - 1000, messageType: "error",
      metadata: { messageType: "error" } });
    await act(async () => root.render(
      <PressChat initial={[...mapTurn(now), typed, typedError]} held={{ kind: "button", reason: IN_USE }} />,
    ));
    expect(read()).toMatchObject({ cards: 1, site: "For www.visitasevilla.es", reason: IN_USE, notices: [] });

    // While it is sent, the card has left and its one line is the record.
    await press();
    expect(read()).toMatchObject({ cards: 0, notices: ["Opened Instafy's browser for www.visitasevilla.es"] });

    await fail();
    const chat = read();
    expect(sends).toBe(1);
    // Its error repeats the chat's last message: nothing joined the chat.
    expect(errorsAdded).toBe(0);
    expect(chat.cards).toBe(1);
    expect(chat.button?.disabled).toBe(false);
    expect(chat.site).toBe("For www.visitasevilla.es");
    expect(chat.reason).toBe(ERROR);
    expect(chat.notices).toEqual([]);
  });

  it("comes back with its button after each failed press, also when the second adds no message", async () => {
    await act(async () => root.render(
      <PressChat initial={mapTurn(Date.now())} held={{ kind: "button", reason: IN_USE }} />,
    ));
    // The first failure adds its error to the chat.
    await press();
    await fail();
    expect(errorsAdded).toBe(1);
    expect(read()).toMatchObject({ cards: 1, reason: ERROR, notices: [] });
    expect(read().button?.disabled).toBe(false);

    // Pressed again within 15 s, it fails the same way: no new message, and
    // the card's reason is the same, so its state does not change either.
    await press();
    expect(read()).toMatchObject({ cards: 0, notices: ["Opened Instafy's browser for www.visitasevilla.es"] });
    await fail();
    const chat = read();
    expect(sends).toBe(2);
    expect(errorsAdded).toBe(1);
    expect(chat.cards).toBe(1);
    expect(chat.button?.disabled).toBe(false);
    expect(chat.site).toBe("For www.visitasevilla.es");
    expect(chat.reason).toBe(ERROR);
    expect(chat.notices).toEqual([]);
  });

  // A message Octo sent straight to the browser: Studio opened its card by
  // itself, and the turn read "Opening Instafy's browser…". Its continuation
  // did not go out, and nothing joined the chat.
  it("stops reading as opening, and shows its button, when Studio's own start was not taken", async () => {
    const now = Date.now();
    const ROUTED_JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ROUTED_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const routedKey = `job:${ROUTED_JOB}`;
    const asked = createMessage({ id: "asked", role: "user", authorId: "user-1", timestamp: now - 3000,
      content: "Check the opening hours on https://www.alcazarsevilla.org", metadata: { runId: ROUTED_RUN } });
    const routedCard = cardMessage("routed-card", ROUTED_JOB, ROUTED_RUN, now - 2000,
      { task: "Check the opening hours on https://www.alcazarsevilla.org", location: "auto", routed: true });
    const continuation = createMessage({ id: "routed-continuation", role: "user", authorId: "user-1", timestamp: now - 1000,
      content: "Check the opening hours on https://www.alcazarsevilla.org",
      metadata: { browserRequestOf: routedKey, browserAutoStarted: true, browserTransport: "shared",
        clientMessageId: "routed-client" } });
    rememberPromptSentFromThisPage(continuation);
    const messages = [asked, routedCard, continuation];
    await act(async () => root.render(
      <ChatRows messages={messages} cardStates={new Map([[routedKey, { kind: "opening", note: null }]])} />,
    ));
    expect(read()).toMatchObject({ cards: 0, line: "Opening Instafy's browser…" });

    await act(async () => {
      recordSendFailedForPromptSentFromThisPage({ metadata: continuation.metadata });
      root.render(<ChatRows messages={messages} cardStates={new Map([[routedKey, { kind: "button", reason: ERROR }]])} />);
    });
    const chat = read();
    expect(chat.line).toBeNull();
    expect(chat.cards).toBe(1);
    expect(chat.button?.disabled).toBe(false);
    expect(chat.site).toBe("For www.alcazarsevilla.org");
    expect(chat.reason).toBe(ERROR);
  });
});
