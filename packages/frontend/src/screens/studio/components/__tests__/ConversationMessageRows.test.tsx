// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { RunFailureRetryProvider } from "../RunFailureNotice";
import { ControllerNoticeActionsProvider } from "../ControllerNoticeActions";
import {
  CHAT_SPEAKER_MARKER_SELECTOR,
  readStickyChatSpeakerMarker,
  type StickyChatSpeaker,
} from "../chatSpeakerMarker";

const workspaceTabsMocks = vi.hoisted(() => ({
  openConversationTab: vi.fn(),
  openJobThreadTab: vi.fn(),
  requestUrlPush: vi.fn(),
}));

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    activeConversation: null,
    conversations: [],
  }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({
    activeConversationId: "conversation-local",
    agentHandles: [],
  }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab: workspaceTabsMocks.openConversationTab,
    openJobThreadTab: workspaceTabsMocks.openJobThreadTab,
    requestUrlPush: workspaceTabsMocks.requestUrlPush,
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    runs: [],
  }),
}));

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function findTextNodeOrNull(root: Node, value: string): Text | null {
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.includes(value)) {
      return child as Text;
    }
    const nested = findTextNodeOrNull(child, value);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findTextNode(root: Node, value: string): Text {
  const textNode = findTextNodeOrNull(root, value);
  if (textNode) {
    return textNode;
  }
  throw new Error(`Text node not found: ${value}`);
}

function resolveReachedStickySpeaker(markers: Element[]): StickyChatSpeaker | null {
  return markers.reduce<StickyChatSpeaker | null>(
    (_speaker, marker) => readStickyChatSpeakerMarker(marker),
    null,
  );
}

describe("ConversationMessageRows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const globalWithCss = globalThis as { CSS?: { escape?: (value: string) => string } };
    globalWithCss.CSS = {
      ...globalWithCss.CSS,
      escape: globalWithCss.CSS?.escape ?? ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")),
    };
    workspaceTabsMocks.openConversationTab.mockReset();
    workspaceTabsMocks.openJobThreadTab.mockReset();
    workspaceTabsMocks.requestUrlPush.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderSpeakerBoundaryMessages(messages: ChatMessage[], target?: string, highlight: string | undefined = target) {
    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={messages}
          targetedMessageId={target}
          highlightedMessageId={highlight}
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
        />,
      );
    });
  }

  it("reveals a matched runtime event's canonical text with attribution and a target marker", async () => {
    const target = createMessage({ id: "matched-event", content: "Recovered the missing report", messageType: "status", timestamp: Date.UTC(2026, 8, 10, 12, 30),
      metadata: { messageType: "status", agent: { handle: "octo" } } });
    await renderSpeakerBoundaryMessages([target], target.id);
    expect(container.querySelector('[data-testid="chat-matched-message-content"]')?.textContent).toContain("Recovered the missing report");
    expect(container.querySelector('[data-chat-message-target="true"]')?.getAttribute("data-chat-scroll-message-id")).toBe(target.id);
    expect(container.querySelector(CHAT_SPEAKER_MARKER_SELECTOR)).not.toBeNull();
    expect(container.querySelector("time")).not.toBeNull();
  });

  it("keeps the search destination focusable after its temporary highlight clears", async () => {
    const target = createMessage({ id: "search-destination", content: "Matched history" });
    await renderSpeakerBoundaryMessages([target], target.id);
    const row = container.querySelector<HTMLElement>('[data-chat-scroll-message-id="search-destination"]')!;
    expect(row.tabIndex).toBe(-1);
    expect(row.getAttribute("role")).toBe("article");
    expect(row.getAttribute("aria-label")).toBe("Search result");
    row.focus();
    await renderSpeakerBoundaryMessages([target], target.id, "");
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute("data-chat-message-target")).toBeNull();
    expect(row.getAttribute("aria-label")).toBe("Search result");
  });

  async function renderWithNoticeActions(
    messages: ChatMessage[],
    actions: {
      onOpenMachines: () => void;
      onShowSelfHostHelp: () => void;
      onOpenCredits: () => void;
      onRunAutomation?: (automationId: string) => void;
      viewerUserId?: string | null;
    },
  ) {
    await act(async () => {
      root.render(
        <ControllerNoticeActionsProvider
          value={{
            onRunAutomation: vi.fn(),
            viewerUserId: null,
            ...actions,
          }}
        >
          <ConversationMessageRows
            messages={messages}
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
        </ControllerNoticeActionsProvider>,
      );
    });
  }

  it("gives a scheduled-run failure a working way out", async () => {
    // The reported bug: this card was text-only, so a reader told to "start or
    // repair the runtime" had nothing to click.
    const onOpenMachines = vi.fn();
    const onShowSelfHostHelp = vi.fn();
    const notice = createMessage({
      id: "automation-launch-failed",
      role: "assistant",
      authorId: null,
      content:
        "This scheduled run couldn't start: no self-hosted runtime was online for this space; " +
        "this schedule is pinned to a self-hosted machine, so start Instafy on that machine and " +
        "the next scheduled run will pick it up",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: { reason: "automation_launch_failed", automationId: "automation-1" },
      },
    });

    await renderWithNoticeActions([notice], {
      onOpenMachines,
      onShowSelfHostHelp,
      onOpenCredits: vi.fn(),
    });

    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-controller-notice-action"]',
    );
    expect(action).not.toBeNull();
    expect(action?.textContent).toContain("How to start it");
    await act(async () => {
      action?.click();
    });
    expect(onShowSelfHostHelp).toHaveBeenCalledTimes(1);
    expect(onOpenMachines).not.toHaveBeenCalled();
  });

  it("routes an out-of-credits failure to credits rather than Machines", async () => {
    const onOpenMachines = vi.fn();
    const onOpenCredits = vi.fn();
    const notice = createMessage({
      id: "automation-out-of-credits",
      role: "assistant",
      authorId: null,
      content: "This scheduled run couldn't start: this team is out of credits for today",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: {
          reason: "automation_launch_failed",
          automationId: "automation-1",
          failureCode: "insufficient_credits",
        },
      },
    });

    await renderWithNoticeActions([notice], {
      onOpenMachines,
      onShowSelfHostHelp: vi.fn(),
      onOpenCredits,
    });

    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-controller-notice-action"]',
    );
    expect(action?.textContent).toContain("Open credits");
    await act(async () => {
      action?.click();
    });
    expect(onOpenCredits).toHaveBeenCalledTimes(1);
    expect(onOpenMachines).not.toHaveBeenCalled();
  });

  it("leaves the notice button-free when no action provider is mounted", async () => {
    // Thread previews and other hosts render this card without the provider;
    // it must degrade to its old shape rather than throw.
    const notice = createMessage({
      id: "runtime-unavailable",
      role: "assistant",
      authorId: null,
      content: "Runtime is unavailable.",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: { reason: "runtime_unavailable" },
      },
    });

    await renderSpeakerBoundaryMessages([notice]);

    expect(container.querySelector('[data-testid="chat-controller-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-controller-notice-action"]')).toBeNull();
  });

  it("renders normal chat messages without decorative corner notches", async () => {
    const shortPrompt = createMessage({
      id: "short-prompt",
      role: "user",
      authorId: "user-1",
      content: "1+1?",
      timestamp: 1,
    });
    const longPrompt = createMessage({
      id: "long-prompt",
      role: "user",
      authorId: "user-1",
      content:
        "Now inspect the exact Demo files for the no-hardware preparatory patch. Stay read-only and do not edit files.\n\nReturn the smallest patch plan, test, stop condition, and any reason not to implement this now.",
      timestamp: 2,
    });
    const shortAnswer = createMessage({
      id: "short-answer",
      role: "assistant",
      content: "2",
      timestamp: 3,
    });
    const longAnswer = createMessage({
      id: "long-answer",
      role: "assistant",
      content: "Patch plan received.",
      timestamp: 4,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[shortPrompt, shortAnswer, longPrompt, longAnswer]}
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
        />,
      );
    });

    const userBubbles = Array.from(container.querySelectorAll('[data-testid="chat-bubble-user"]'));
    expect(userBubbles).toHaveLength(2);
    expect(userBubbles[0]?.querySelector('[data-testid="chat-message-start-notch"]')).toBeNull();
    expect(userBubbles[0]?.querySelector('[data-testid="chat-message-tail-notch"]')).toBeNull();
    expect(userBubbles[1]?.querySelector('[data-testid="chat-message-start-notch"]')).toBeNull();
    expect(userBubbles[1]?.querySelector('[data-testid="chat-message-tail-notch"]')).toBeNull();
    expect(userBubbles[1]?.className).toContain("rounded-2xl");
    expect(userBubbles[1]?.className).toContain("rounded-br-none");
    expect(container.querySelector('[data-testid="chat-message-start-notch"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-tail-notch"]')).toBeNull();
  });

  it("renders a mobile speaker marker for assistant rows", async () => {
    const message = createMessage({
      id: "assistant-response",
      role: "assistant",
      content: "Reviewed the selected section.",
      timestamp: 1,
      metadata: {
        agent: {
          handle: "reviewer",
          avatarSeed: "reviewer-seed",
        },
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[message]}
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
        />,
      );
    });

    const speakerMarker = container.querySelector('[data-testid="chat-speaker-marker"]');
    expect(speakerMarker).toBeInstanceOf(HTMLElement);
    expect(speakerMarker?.getAttribute("data-agent-handle")).toBe("reviewer");
    expect(speakerMarker?.getAttribute("data-agent-avatar-seed")).toBe("reviewer-seed");
    const inlineSpeaker = container.querySelector('[data-testid="chat-speaker-inline"]');
    expect(inlineSpeaker).toBeInstanceOf(HTMLElement);
    expect(inlineSpeaker?.textContent).toContain("reviewer");
    expect(inlineSpeaker?.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle")).toBe("reviewer");
    const speakerIdentityNodes = Array.from(
      container.querySelectorAll('[data-testid="chat-speaker-marker"], [data-testid="chat-speaker-inline"]'),
    ).map((node) => node.getAttribute("data-testid"));
    expect(speakerIdentityNodes).toEqual(["chat-speaker-marker", "chat-speaker-inline"]);
  });

  it("hands the sticky speaker to the human author at an assistant-to-human boundary", async () => {
    const assistantMessage = createMessage({
      id: "assistant-response",
      role: "assistant",
      content: "I checked the current state.",
      timestamp: 1,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });
    // Another person's message: one's own would clear the pill instead, since
    // the right side already says who wrote it.
    const humanMessage = createMessage({
      id: "human-response",
      role: "user",
      authorId: "user-2",
      content: "I will decide what to do next.",
      timestamp: 2,
    });

    await renderSpeakerBoundaryMessages([assistantMessage, humanMessage]);

    const markers = Array.from(container.querySelectorAll(CHAT_SPEAKER_MARKER_SELECTOR));
    expect(markers.map((marker) => marker.getAttribute("data-chat-speaker-kind"))).toEqual([
      "assistant",
      "human",
    ]);
    expect(markers[1]?.getAttribute("data-testid")).toBe("chat-speaker-human-marker");
    expect(readStickyChatSpeakerMarker(markers[0] ?? null)).toEqual({
      kind: "assistant",
      handle: "octo",
      avatarSeed: "octo-seed",
    });
    expect(resolveReachedStickySpeaker(markers)).toEqual({
      kind: "human",
      label: "Teammate",
      avatarSeed: "user-2",
    });
  });

  it("renders a sticky human speaker marker for a user-authored long message", async () => {
    const ownerPrompt = createMessage({
      id: "owner-runbook-prompt",
      role: "user",
      authorId: "user-2",
      content: [
        "Inspect the demo files for the no-hardware preparatory patch.",
        "Stay read-only and do not edit files.",
        "Return the smallest patch plan, test, stop condition, and any reason not to implement this now.",
      ].join("\n\n"),
      timestamp: 1,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[ownerPrompt]}
          currentUserId="user-1"
          chatClientSessionId="session-1"
          projectId="project-1"
          runtimeId={null}
          conversationLocalId="conversation-local"
          conversationControllerId="conversation-controller"
          firstPlanMessageId={null}
          humanLabelByUserId={new Map([["user-2", "Owner"]])}
          runAgentIdentityByRunId={new Map()}
          runAgentHandleByRunId={new Map()}
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });

    const marker = container.querySelector('[data-testid="chat-speaker-human-marker"]');
    expect(marker).toBeInstanceOf(HTMLElement);
    expect(marker?.getAttribute("data-chat-speaker-kind")).toBe("human");
    expect(marker?.getAttribute("data-human-label")).toBe("Owner");
    expect(marker?.getAttribute("data-human-avatar-seed")).toBe("user-2");
    expect(readStickyChatSpeakerMarker(marker)).toEqual({
      kind: "human",
      label: "Owner",
      avatarSeed: "user-2",
    });
  });

  it("clears the sticky speaker at the current user's own message: the right side already says who", async () => {
    const ownPrompt = createMessage({
      id: "own-long-prompt",
      role: "user",
      authorId: "user-1",
      content:
        "Now inspect the exact Demo files for the no-hardware preparatory patch. Stay read-only and do not edit files.",
      timestamp: 1,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[ownPrompt]}
          currentUserId="user-1"
          chatClientSessionId="session-1"
          projectId="project-1"
          runtimeId={null}
          conversationLocalId="conversation-local"
          conversationControllerId="conversation-controller"
          firstPlanMessageId={null}
          humanLabelByUserId={new Map([["user-1", "Owner"]])}
          runAgentIdentityByRunId={new Map()}
          runAgentHandleByRunId={new Map()}
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-speaker-human-marker"]')).toBeNull();
    const marker = container.querySelector('[data-testid="chat-speaker-boundary"]');
    expect(marker).toBeInstanceOf(HTMLElement);
    expect(marker?.getAttribute("data-chat-speaker-kind")).toBe("boundary");
    expect(readStickyChatSpeakerMarker(marker)).toBeNull();
  });

  it("clears the sticky assistant speaker at an assistant-to-controller boundary", async () => {
    const assistantMessage = createMessage({
      id: "assistant-response",
      role: "assistant",
      content: "I am checking the workspace.",
      timestamp: 1,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });
    const controllerNotice = createMessage({
      id: "runtime-alert",
      role: "assistant",
      content: "Runtime unavailable.",
      timestamp: 2,
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "octo", avatarSeed: "octo-seed" },
        status: "failed",
        details: { reason: "runtime_start_failed" },
      },
    });

    await renderSpeakerBoundaryMessages([assistantMessage, controllerNotice]);

    const markers = Array.from(container.querySelectorAll(CHAT_SPEAKER_MARKER_SELECTOR));
    expect(markers.map((marker) => marker.getAttribute("data-chat-speaker-kind"))).toEqual([
      "assistant",
      "boundary",
    ]);
    expect(markers[1]?.getAttribute("data-testid")).toBe("chat-speaker-boundary");
    const notice = container.querySelector('[data-testid="chat-controller-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Workspace unavailable");
    expect(notice?.textContent).toContain("Open Machines");
    const inlineSpeakers = Array.from(container.querySelectorAll('[data-testid="chat-speaker-inline"]'));
    expect(inlineSpeakers).toHaveLength(2);
    expect(inlineSpeakers[1]?.textContent).toContain("octo");
    expect(inlineSpeakers[1]?.querySelector('[data-testid="chat-avatar-assistant"]')).not.toBeNull();
    expect(resolveReachedStickySpeaker(markers)).toBeNull();
  });

  it("attributes a terminal runtime notice to its verified custom agent", async () => {
    const controllerNotice = createMessage({
      id: "reviewer-runtime-alert",
      role: "assistant",
      content: "Runtime unavailable.",
      timestamp: 1,
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "reviewer", avatarSeed: "reviewer-seed" },
        details: { reason: "runtime_start_failed" },
      },
    });

    await renderSpeakerBoundaryMessages([controllerNotice]);

    const inlineSpeaker = container.querySelector('[data-testid="chat-speaker-inline"]');
    expect(inlineSpeaker?.textContent).toContain("reviewer");
    expect(inlineSpeaker?.textContent).not.toContain("octo");
    expect(
      inlineSpeaker?.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle"),
    ).toBe("reviewer");
    expect(
      container.querySelector(CHAT_SPEAKER_MARKER_SELECTOR)?.getAttribute(
        "data-chat-speaker-kind",
      ),
    ).toBe("boundary");
  });

  it("attributes a recoverable startup notice to its verified custom agent without Octo copy", async () => {
    const controllerNotice = createMessage({
      id: "reviewer-runtime-starting",
      role: "assistant",
      content: "Runtime is still connecting.",
      timestamp: 1,
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "reviewer", avatarSeed: "reviewer-seed" },
        details: {
          reason: "runtime_not_ready",
          detail: "status=starting, lastSeen=unknown",
        },
      },
    });

    await renderSpeakerBoundaryMessages([controllerNotice]);

    const inlineSpeaker = container.querySelector('[data-testid="chat-speaker-inline"]');
    expect(inlineSpeaker?.textContent).toContain("reviewer");
    expect(inlineSpeaker?.textContent).not.toContain("octo");
    const notice = container.querySelector('[data-testid="chat-controller-notice"]');
    expect(notice?.textContent).toContain("Starting the workspace");
    expect(notice?.textContent).not.toContain("Octo");
  });

  it("restores the inline assistant identity after a human boundary", async () => {
    const firstAssistantMessage = createMessage({
      id: "assistant-before-human",
      role: "assistant",
      content: "I checked the current state.",
      timestamp: 1,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });
    const humanMessage = createMessage({
      id: "human-response",
      role: "user",
      authorId: "user-1",
      content: "Please check one more thing.",
      timestamp: 2,
    });
    const secondAssistantMessage = createMessage({
      id: "assistant-after-human",
      role: "assistant",
      content: "I checked that too.",
      timestamp: 3,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });

    await renderSpeakerBoundaryMessages([
      firstAssistantMessage,
      humanMessage,
      secondAssistantMessage,
    ]);

    const inlineSpeakers = Array.from(
      container.querySelectorAll('[data-testid="chat-speaker-inline"]'),
    );
    expect(inlineSpeakers).toHaveLength(2);
    expect(
      inlineSpeakers.map((node) =>
        node.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle"),
      ),
    ).toEqual(["octo", "octo"]);
  });

  it("does not repeatedly scan earlier human messages while resolving assistant identities", async () => {
    let firstMessageRoleReads = 0;
    const firstHumanMessage = createMessage({
      id: "first-human-message",
      role: "user",
      authorId: "user-1",
      content: "First note.",
    });
    Object.defineProperty(firstHumanMessage, "role", {
      get: () => {
        firstMessageRoleReads += 1;
        return "user";
      },
    });
    const messages = [
      firstHumanMessage,
      ...Array.from({ length: 150 }, (_, index) => createMessage({
        id: `human-note-${index}`,
        role: "user",
        authorId: "user-1",
        content: "Another note.",
        timestamp: index + 1,
      })),
      createMessage({
        id: "assistant-after-notes",
        content: "I reviewed the notes.",
        timestamp: 152,
        metadata: { agent: { handle: "reviewer", avatarSeed: "reviewer" } },
      }),
    ];

    await renderSpeakerBoundaryMessages(messages);

    // Rendering this row and its neighbor may inspect its role, but resolving
    // every later speaker must not revisit it once per message.
    expect(firstMessageRoleReads).toBeLessThan(50);
    expect(container.querySelectorAll('[data-testid="chat-message-row"]')).toHaveLength(messages.length);
    expect(container.querySelector('[data-testid="chat-speaker-inline"] [data-agent-handle]')
      ?.getAttribute("data-agent-handle")).toBe("reviewer");
  });

  it("restores the inline assistant identity after a controller boundary", async () => {
    const firstAssistantMessage = createMessage({
      id: "assistant-before-controller",
      role: "assistant",
      content: "I am checking the workspace.",
      timestamp: 1,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });
    const controllerNotice = createMessage({
      id: "runtime-alert",
      role: "assistant",
      content: "Runtime unavailable.",
      timestamp: 2,
      messageType: "runtime_alert",
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        agent: { handle: "octo", avatarSeed: "octo-seed" },
        status: "failed",
        details: { reason: "runtime_start_failed" },
      },
    });
    const secondAssistantMessage = createMessage({
      id: "assistant-after-controller",
      role: "assistant",
      content: "The workspace is available again.",
      timestamp: 3,
      metadata: { agent: { handle: "octo", avatarSeed: "octo-seed" } },
    });

    await renderSpeakerBoundaryMessages([
      firstAssistantMessage,
      controllerNotice,
      secondAssistantMessage,
    ]);

    const inlineSpeakers = Array.from(
      container.querySelectorAll('[data-testid="chat-speaker-inline"]'),
    );
    expect(inlineSpeakers).toHaveLength(3);
    expect(
      inlineSpeakers.map((node) =>
        node.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle"),
      ),
    ).toEqual(["octo", "octo", "octo"]);
  });

  it("uses the chat speaker row instead of a nested run-preview identity header", async () => {
    const message = createMessage({
      id: "failed-run",
      role: "assistant",
      content: "",
      timestamp: 1,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        jobId: "run-1",
        agent: { handle: "octo" },
        threadMessages: [
          createMessage({
            id: "failed-run-summary",
            role: "assistant",
            content: "Upstream 400 rejected the AI request. Retry later or switch credentials.",
            timestamp: 2,
            messageType: "error",
            metadata: {
              messageType: "error",
              kind: "completion",
              outcome: "failed",
              source: "agent",
              status: "failed",
            },
          }),
        ],
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[message]}
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
        />,
      );
    });

    const speaker = container.querySelector('[data-testid="chat-speaker-inline"]');
    expect(speaker?.textContent).toContain("octo");
    expect(container.textContent).toContain("Upstream 400 rejected the AI request.");
    expect(container.querySelector('[data-testid="agent-thread-preview-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-thread-owner-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-job-thread-avatar"]')).toBeNull();
    // Run status folds into the speaker header beside author and timestamp,
    // and the preview drops its duplicate content-level caption (#145).
    const runStatus = speaker?.querySelector('[data-testid="chat-speaker-run-status"]');
    expect(runStatus?.textContent).toBe("Run failed");
    expect(container.querySelector('[data-testid="agent-thread-terminal-status"]')).toBeNull();
  });

  it.each([
    {
      label: "hides the matching command owner beside a visible author",
      actor: "octo",
      continuation: false,
      expectedOwner: null,
    },
    {
      label: "keeps a different command actor beside the visible author",
      actor: "reviewer",
      continuation: false,
      expectedOwner: "@reviewer",
    },
    {
      label: "keeps the command owner when the repeated author header is hidden",
      actor: "octo",
      continuation: true,
      expectedOwner: "@octo",
    },
  ])("$label", async ({ actor, continuation, expectedOwner }) => {
    const now = Date.now();
    const message = createMessage({
      id: "live-command-thread",
      timestamp: now,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        jobId: "live-command-job",
        agent: { handle: "octo" },
        threadMessages: [
          createMessage({
            id: "command-reasoning",
            content: "Checking the test suite.",
            timestamp: now - 1,
            messageType: "reasoning",
            metadata: { agent: { handle: "octo" } },
          }),
          createMessage({
            id: "live-command",
            content: "Running command...",
            timestamp: now,
            messageType: "command_execution",
            metadata: {
              messageType: "command_execution",
              agent: { handle: actor },
              details: { command: "pnpm test", status: "running" },
            },
          }),
        ],
      },
    });
    const previousMessage = createMessage({
      id: "previous-author-message",
      content: "I will run the tests.",
      timestamp: now - 2,
      metadata: { agent: { handle: "octo" } },
    });

    await renderSpeakerBoundaryMessages(continuation ? [previousMessage, message] : [message]);

    const rows = container.querySelectorAll('[data-testid="chat-message-row"]');
    const commandRow = rows[rows.length - 1];
    expect(commandRow).toBeDefined();
    // The live command must render in every case, including the negative badge assertion.
    expect(commandRow.textContent).toContain("Running tests…");
    const speaker = commandRow.querySelector('[data-testid="chat-speaker-inline"]');
    if (continuation) {
      expect(speaker).toBeNull();
    } else {
      expect(speaker?.textContent).toContain("octo");
    }
    const owner = commandRow.querySelector('[data-testid="agent-thread-command-owner"]');
    if (expectedOwner === null) {
      expect(owner).toBeNull();
    } else {
      expect(owner?.textContent).toBe(expectedOwner);
    }
  });

  it("animates only the active job thread speaker avatar", async () => {
    const historicalThread = createMessage({
      id: "historical-thread",
      role: "assistant",
      timestamp: 1,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        jobId: "run-1",
        agent: { handle: "octo" },
      },
    });
    const prompt = createMessage({
      id: "prompt",
      role: "user",
      authorId: "user-1",
      content: "Run another check.",
      timestamp: 2,
    });
    const activeThread = createMessage({
      id: "active-thread",
      role: "assistant",
      timestamp: 3,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        jobId: "run-2",
        agent: { handle: "octo" },
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[historicalThread, prompt, activeThread]}
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
          activeAssistantAvatarMotion={{ messageId: "active-thread", motion: "thinking" }}
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });

    const inlineSpeakers = Array.from(
      container.querySelectorAll('[data-testid="chat-speaker-inline"]'),
    );
    expect(inlineSpeakers).toHaveLength(2);
    expect(inlineSpeakers[0]?.querySelector('[data-octo-motion="idle"]')).not.toBeNull();
    expect(inlineSpeakers[1]?.querySelector('[data-octo-motion="thinking"]')).not.toBeNull();
  });

  it("labels left-aligned human messages by visible author group", async () => {
    const teammateFirst = createMessage({
      id: "teammate-first",
      role: "user",
      authorId: "user-2",
      content: "I started this earlier.",
      timestamp: 1,
    });
    const teammateFollowup = createMessage({
      id: "teammate-followup",
      role: "user",
      authorId: "user-2",
      content: "Here is more context.",
      timestamp: 2,
    });
    const ownPrompt = createMessage({
      id: "own-prompt",
      role: "user",
      authorId: "user-1",
      content: "Continue from here.",
      timestamp: 3,
    });
    const otherTeammate = createMessage({
      id: "other-teammate",
      role: "user",
      authorId: "user-3",
      content: "I have a separate note.",
      timestamp: 4,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[teammateFirst, teammateFollowup, ownPrompt, otherTeammate]}
          currentUserId="user-1"
          chatClientSessionId="session-1"
          projectId="project-1"
          runtimeId={null}
          conversationLocalId="conversation-local"
          conversationControllerId="conversation-controller"
          firstPlanMessageId={null}
          humanLabelByUserId={new Map([
            ["user-2", "Alice"],
            ["user-3", "Bob"],
          ])}
          runAgentIdentityByRunId={new Map()}
          runAgentHandleByRunId={new Map()}
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });

    const labels = Array.from(container.querySelectorAll('[data-testid="chat-human-speaker-label"]'));
    expect(labels).toHaveLength(2);
    expect(labels[0]?.textContent).toContain("Alice");
    expect(labels[1]?.textContent).toContain("Bob");
    expect(labels[0]?.querySelector('[data-testid="chat-avatar-human"]')).not.toBeNull();
    expect(labels[1]?.querySelector('[data-testid="chat-avatar-human"]')).not.toBeNull();
    expect(labels[0]?.querySelector("time")).not.toBeNull();
    expect(labels[1]?.querySelector("time")).not.toBeNull();
    // Each teammate group head shows one face twice in the DOM: in the avatar
    // gutter (desktop) and inside the label (narrow layouts, where the gutter
    // collapses); only one is visible per breakpoint.
    expect(container.querySelectorAll('[data-testid="chat-avatar-human"]')).toHaveLength(4);
    for (const label of labels) {
      const labelAvatarWrapper = label.querySelector('[data-testid="chat-avatar-human"]')?.parentElement;
      expect(labelAvatarWrapper?.className).toContain("sm:hidden");
    }
  });

  it("deduplicates narrow inline speaker identity until the assistant changes", async () => {
    const firstOcto = createMessage({
      id: "first-octo",
      role: "assistant",
      content: "First Octo answer.",
      timestamp: 1,
      metadata: { agent: { handle: "octo" } },
    });
    const prompt = createMessage({
      id: "prompt",
      role: "user",
      authorId: "user-1",
      content: "Follow up.",
      timestamp: 2,
    });
    const reviewer = createMessage({
      id: "reviewer",
      role: "assistant",
      content: "Reviewer answer.",
      timestamp: 3,
      metadata: { agent: { handle: "reviewer" } },
    });
    const reviewerAgain = createMessage({
      id: "reviewer-again",
      role: "assistant",
      content: "Reviewer continuation.",
      timestamp: 4,
      metadata: { agent: { handle: "reviewer" } },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[firstOcto, prompt, reviewer, reviewerAgain]}
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
        />,
      );
    });

    const markers = Array.from(container.querySelectorAll('[data-testid="chat-speaker-marker"]'));
    expect(markers).toHaveLength(3);
    const inlineSpeakers = Array.from(container.querySelectorAll('[data-testid="chat-speaker-inline"]'));
    expect(inlineSpeakers).toHaveLength(2);
    expect(
      inlineSpeakers.map((node) => node.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle")),
    ).toEqual(["octo", "reviewer"]);
  });

  it("restores visible speaker identity for agent job thread rows after a short user turn", async () => {
    const firstFailure = createMessage({
      id: "first-failure",
      role: "assistant",
      content: "The upstream provider rejected the AI request.",
      timestamp: 1,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        agent: { handle: "octo" },
      },
    });
    const prompt = createMessage({
      id: "prompt",
      role: "user",
      authorId: "user-1",
      content: "jow are you?",
      timestamp: 2,
    });
    const secondFailure = createMessage({
      id: "second-failure",
      role: "assistant",
      content: "The upstream provider rejected the AI request again.",
      timestamp: 3,
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        agent: { handle: "octo" },
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[firstFailure, prompt, secondFailure]}
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
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="chat-speaker-marker"]')).toHaveLength(2);
    const inlineSpeakers = Array.from(container.querySelectorAll('[data-testid="chat-speaker-inline"]'));
    expect(inlineSpeakers).toHaveLength(2);
    expect(
      inlineSpeakers.map((node) =>
        node.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle"),
      ),
    ).toEqual(["octo", "octo"]);
  });

  it("reserves the avatar gutter on assistant rows with faces at speaker heads", async () => {
    const firstOcto = createMessage({
      id: "first-octo",
      role: "assistant",
      content: "First Octo answer.",
      timestamp: 1,
      metadata: { agent: { handle: "octo" } },
    });
    const prompt = createMessage({
      id: "prompt",
      role: "user",
      authorId: "user-1",
      content: "Follow up.",
      timestamp: 2,
    });
    const octoAgain = createMessage({
      id: "octo-again",
      role: "assistant",
      content: "Octo continuation.",
      timestamp: 3,
      metadata: { agent: { handle: "octo" } },
    });
    const reviewer = createMessage({
      id: "reviewer",
      role: "assistant",
      content: "Reviewer answer.",
      timestamp: 4,
      metadata: { agent: { handle: "reviewer" } },
    });
    const reviewerAgain = createMessage({
      id: "reviewer-again",
      role: "assistant",
      content: "Reviewer continuation.",
      timestamp: 5,
      metadata: { agent: { handle: "reviewer" } },
    });
    const octoReturns = createMessage({
      id: "octo-returns",
      role: "assistant",
      content: "Octo takes back over.",
      timestamp: 6,
      metadata: { agent: { handle: "octo" } },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[firstOcto, prompt, octoAgain, reviewer, reviewerAgain, octoReturns]}
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
          renderAssistantAvatar={(_metadata, identity) => (
            <span data-testid="assistant-avatar" data-agent-handle={identity?.handle ?? "assistant"} />
          )}
          assistantAvatarPlaceholder={<span data-testid="assistant-avatar-placeholder" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });

    // Slack-style grammar (#177): speaker heads carry the face in the gutter,
    // continuation rows keep an empty spacer so header, body, and chip rows
    // all share one left alignment line.
    const gutterAvatars = Array.from(container.querySelectorAll('[data-testid="assistant-avatar"]'));
    expect(gutterAvatars.map((node) => node.getAttribute("data-agent-handle"))).toEqual([
      "octo",
      "octo",
      "reviewer",
      "octo",
    ]);
    expect(container.querySelectorAll('[data-testid="assistant-avatar-placeholder"]')).toHaveLength(1);
    const inlineSpeakers = Array.from(container.querySelectorAll('[data-testid="chat-speaker-inline"]'));
    expect(
      inlineSpeakers.map((node) => node.querySelector("[data-agent-handle]")?.getAttribute("data-agent-handle")),
    ).toEqual([
      "octo",
      "octo",
      "reviewer",
      "octo",
    ]);
    // The label's own avatar only serves narrow layouts where the gutter
    // collapses; desktop shows the gutter face instead.
    for (const inlineSpeaker of inlineSpeakers) {
      const profileDoor = inlineSpeaker.querySelector('[data-testid="chat-speaker-agent-profile"]');
      expect(profileDoor?.className).toContain("sm:hidden");
    }
  });

  it("trims layout-only trailing blank lines when copying selected bubble text from document copy", async () => {
    const message = createMessage({
      id: "prompt",
      role: "user",
      authorId: "user-1",
      content: "create a goal to count to 3",
      timestamp: 1,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[message]}
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
        />,
      );
    });

    const bubble = container.querySelector('[data-testid="chat-bubble-user"]');
    expect(bubble).not.toBeNull();
    const textNode = findTextNode(bubble!, "create a goal to count to 3");
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({ commonAncestorContainer: textNode }),
      toString: () => "create a goal to count to 3\n\n\n",
    };
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { setData },
    });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "create a goal to count to 3");
    getSelectionSpy.mockRestore();
  });

  it("trims layout-only trailing blank lines when copying selected assistant response text", async () => {
    const message = createMessage({
      id: "assistant-response",
      role: "assistant",
      content: "Counted to 3: 1, 2, 3.",
      timestamp: 1,
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[message]}
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
        />,
      );
    });

    const bubble = container.querySelector('[data-testid="chat-bubble-assistant"]');
    expect(bubble).not.toBeNull();
    const textNode = findTextNode(bubble!, "Counted to 3: 1, 2, 3.");
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({ commonAncestorContainer: textNode }),
      toString: () => "Counted to 3: 1, 2, 3.\n\n",
    };
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { setData },
    });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "Counted to 3: 1, 2, 3.");
    getSelectionSpy.mockRestore();
  });

  it("bridges the workflow spine between a team plan and its lead continuation", async () => {
    const planMessage = createMessage({
      id: "plan-message",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [
            {
              handle: "runtime",
              label: "Runtime/tool boundaries",
              scopeSummary: "Runtime boundary inspection",
              writeScope: { mode: "read_only" },
            },
          ],
          lead: {
            leadHandle: "octo",
            expectedReportFormat: "Final report.",
          },
        },
      },
    });
    const workerMessage = createMessage({
      id: "worker-message",
      content: "Worker evidence.",
      metadata: {
        jobId: "worker-job-1",
        agent: { handle: "runtime" },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });
    const leadMessage = createMessage({
      id: "lead-message",
      content: "Severity-ranked findings.",
      metadata: {
        jobId: "lead-job-1",
        agent: { handle: "octo" },
        outcome: "succeeded",
        multiAgentPlan: {
          role: "lead_continuation",
          groupId: "group-1",
        },
      },
    });
    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[planMessage, leadMessage]}
          allConversationMessages={[planMessage, workerMessage, leadMessage]}
          currentUserId={null}
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
        />,
      );
    });

    expect(container.querySelector('[data-testid="multi-agent-inline-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-plan-card"]')).toBeNull();
    expect(container.textContent).toContain("Severity-ranked findings.");
    expect(container.textContent).toContain("I'm splitting this into workstreams.");
    expect(container.querySelectorAll('[data-testid="chat-workflow-spine"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="assistant-avatar"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="chat-speaker-marker"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="chat-speaker-inline"]')).toHaveLength(1);
    expect(container.querySelector('[data-message-type="multi_agent_plan"] [data-testid="thread-spine"]')).toBeNull();
  });

  it("keeps worker trace and details actions behind the team chip menu", async () => {
    const planMessage = createMessage({
      id: "plan-message",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [
            {
              handle: "runtime",
              label: "Runtime/tool boundaries",
              scopeSummary: "Runtime boundary inspection",
              writeScope: { mode: "read_only" },
            },
          ],
          lead: {
            leadHandle: "octo",
            expectedReportFormat: "Final report.",
          },
        },
      },
    });
    const workerCommand = createMessage({
      id: "worker-command",
      content: "Running command...",
      messageType: "command_execution",
      metadata: {
        jobId: "worker-job-1",
        messageType: "command_execution",
      },
    });
    const workerMessage = createMessage({
      id: "worker-message",
      content: "Worker evidence.",
      metadata: {
        jobId: "worker-job-1",
        agent: { handle: "runtime" },
        outcome: "succeeded",
        leaseMetrics: {
          queuedAt: "2026-05-12T10:00:00Z",
          leasedAt: "2026-05-12T10:00:02.250Z",
          completedAt: "2026-05-12T10:00:06.500Z",
          queueWaitMs: 2250,
          wallTimeMs: 4250,
          leaseAttempts: 2,
          leasedByRuntimeId: "11111111-1111-4111-8111-111111111111",
          agentHandle: "runtime",
        },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });
    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[planMessage]}
          allConversationMessages={[planMessage, workerCommand, workerMessage]}
          currentUserId={null}
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
        />,
      );
    });

    const evidenceRow = container.querySelector<HTMLButtonElement>('[data-testid="multi-agent-evidence-row"]');
    expect(evidenceRow).not.toBeNull();
    const teamChip = container.querySelector<HTMLElement>('[data-testid="multi-agent-team-chip"]');
    expect(teamChip?.getAttribute("aria-label")).toContain("1 runtime for 1 leased lane");
    expect(container.querySelector('[data-testid="multi-agent-open-run"]')).toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-runtime-metrics"]')).toBeNull();
    expect(evidenceRow?.getAttribute("aria-label")).toBe("Open run trace for @runtime; status done");
    expect(evidenceRow?.getAttribute("aria-expanded")).toBeNull();
    expect(evidenceRow?.getAttribute("title")).toContain("Runtime: 11111111-1111-4111-8111-111111111111");
    expect(evidenceRow?.getAttribute("title")).toContain("Tool updates: 1");
    expect(container.textContent).not.toContain("Copy metrics");

    const chipShell = container.querySelector<HTMLElement>('[data-testid="multi-agent-chip-shell"]');
    expect(chipShell?.className).toContain("relative");
    expect(chipShell?.className).not.toContain("gap-");

    const menuButton = container.querySelector<HTMLButtonElement>('[data-testid="multi-agent-chip-menu-button"]');
    expect(menuButton).not.toBeNull();
    expect(menuButton?.parentElement?.className).toContain("absolute");

    await act(async () => {
      menuButton?.click();
    });

    const menu = document.body.querySelector('[data-testid="multi-agent-chip-menu"]');
    expect(menu?.textContent).toContain("Open run trace");
    expect(menu?.textContent).toContain("Show details");
    expect(menu?.textContent).toContain("Copy reference");
    expect(menu?.textContent).toContain("Copy metrics");

    const showDetailsItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((entry) =>
      entry.textContent?.includes("Show details"),
    ) as HTMLElement | undefined;
    expect(showDetailsItem).toBeTruthy();

    await act(async () => {
      showDetailsItem?.click();
    });

    expect(workspaceTabsMocks.requestUrlPush).not.toHaveBeenCalled();
    expect(workspaceTabsMocks.openJobThreadTab).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="multi-agent-evidence-detail"]')?.textContent).toContain(
      "Worker evidence.",
    );
    expect(container.querySelector('[data-testid="multi-agent-runtime-metrics"]')?.textContent).toBe(
      "runtime 11111111 · wait 2.3s · ran 4.3s · try 2 · 1 tool update",
    );

    await act(async () => {
      evidenceRow?.click();
    });

    expect(workspaceTabsMocks.requestUrlPush).toHaveBeenCalledTimes(1);
    expect(workspaceTabsMocks.openJobThreadTab).toHaveBeenCalledWith({
      conversationId: "conversation-local",
      jobId: "worker-job-1",
      title: "@runtime run",
    });
    expect(evidenceRow?.getAttribute("aria-expanded")).toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-evidence-detail"]')?.textContent).toContain(
      "Worker evidence.",
    );
  });

  it("uses durable lease metric tool counts when worker trace rows are not loaded", async () => {
    const planMessage = createMessage({
      id: "plan-message",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [
            {
              handle: "runtime",
              label: "Runtime/tool boundaries",
              scopeSummary: "Runtime boundary inspection",
              writeScope: { mode: "read_only" },
            },
          ],
          lead: {
            leadHandle: "octo",
            expectedReportFormat: "Final report.",
          },
        },
      },
    });
    const workerMessage = createMessage({
      id: "worker-message",
      content: "Worker evidence.",
      metadata: {
        jobId: "worker-job-1",
        agent: { handle: "runtime" },
        outcome: "succeeded",
        leaseMetrics: {
          queuedAt: "2026-05-12T10:00:00Z",
          leasedAt: "2026-05-12T10:00:02.250Z",
          completedAt: "2026-05-12T10:00:06.500Z",
          queueWaitMs: 2250,
          wallTimeMs: 4250,
          leaseAttempts: 1,
          leasedByRuntimeId: "11111111-1111-4111-8111-111111111111",
          agentHandle: "runtime",
          toolUpdateCount: 3,
        },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[planMessage]}
          allConversationMessages={[planMessage, workerMessage]}
          currentUserId={null}
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
        />,
      );
    });

    const evidenceRow = container.querySelector<HTMLButtonElement>('[data-testid="multi-agent-evidence-row"]');
    expect(evidenceRow?.getAttribute("title")).toContain("Tool updates: 3");

    const menuButton = container.querySelector<HTMLButtonElement>('[data-testid="multi-agent-chip-menu-button"]');
    await act(async () => {
      menuButton?.click();
    });
    const showDetailsItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((entry) =>
      entry.textContent?.includes("Show details"),
    ) as HTMLElement | undefined;
    await act(async () => {
      showDetailsItem?.click();
    });

    expect(container.querySelector('[data-testid="multi-agent-runtime-metrics"]')?.textContent).toBe(
      "runtime 11111111 · wait 2.3s · ran 4.3s · 3 tool updates",
    );
  });

  it("summarizes runtime spread on the workstreams chip without adding visible metric badges", async () => {
    const planMessage = createMessage({
      id: "plan-message",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [
            { handle: "alpha", label: "Alpha", scopeSummary: "Alpha scope" },
            { handle: "beta", label: "Beta", scopeSummary: "Beta scope" },
          ],
          lead: { leadHandle: "octo", expectedReportFormat: "Final report." },
        },
      },
    });
    const workerAlpha = createMessage({
      id: "worker-alpha",
      content: "Alpha evidence.",
      timestamp: 1,
      metadata: {
        jobId: "worker-alpha-job",
        agent: { handle: "alpha" },
        outcome: "succeeded",
        leaseMetrics: {
          queueWaitMs: 100,
          wallTimeMs: 4300,
          leaseAttempts: 1,
          leasedByRuntimeId: "aaaaaaaa-1111-4111-8111-111111111111",
          agentHandle: "alpha",
        },
        multiAgentPlan: { role: "worker", parentJobId: "plan-job-1", groupId: "group-1" },
      },
    });
    const workerBeta = createMessage({
      id: "worker-beta",
      content: "Beta evidence.",
      timestamp: 2,
      metadata: {
        jobId: "worker-beta-job",
        agent: { handle: "beta" },
        outcome: "succeeded",
        leaseMetrics: {
          queueWaitMs: 1400,
          wallTimeMs: 980,
          leaseAttempts: 1,
          leasedByRuntimeId: "bbbbbbbb-2222-4222-8222-222222222222",
          agentHandle: "beta",
        },
        multiAgentPlan: { role: "worker", parentJobId: "plan-job-1", groupId: "group-1" },
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[planMessage]}
          allConversationMessages={[planMessage, workerAlpha, workerBeta]}
          currentUserId={null}
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
        />,
      );
    });

    const status = container.querySelector('[data-testid="multi-agent-inline-status"]');
    const teamChip = container.querySelector<HTMLElement>('[data-testid="multi-agent-team-chip"]');
    expect(status?.getAttribute("aria-label")).toContain("2 runtimes across 2 leased lanes");
    expect(teamChip?.tagName).toBe("BUTTON");
    expect(teamChip?.getAttribute("aria-label")).toContain("2 runtimes across 2 leased lanes");
    expect(container.textContent).not.toContain("2 runtimes across 2 leased lanes");

    await act(async () => {
      teamChip?.click();
    });

    const teamMenu = document.body.querySelector('[data-testid="multi-agent-team-menu"]');
    const teamRuntimeSummary = document.body.querySelector('[data-testid="multi-agent-team-runtime-summary"]');
    expect(teamRuntimeSummary?.textContent).toContain("2 runtimes across 2 leased lanes");
    expect(teamRuntimeSummary?.textContent).not.toContain("Runtime spread:");
    expect(teamRuntimeSummary?.textContent).toContain("@alpha · runtime aaaaaaaa · wait 100ms · ran 4.3s");
    expect(teamRuntimeSummary?.textContent).toContain("@beta · runtime bbbbbbbb · wait 1.4s · ran 980ms");
    expect(teamMenu?.textContent).toContain("Copy runtime summary");
  });

  it("does not draw a nested run spine through an attached workflow continuation", async () => {
    const planMessage = createMessage({
      id: "plan-message",
      content: "I'm splitting this into workstreams.",
      messageType: "multi_agent_plan",
      metadata: {
        messageType: "multi_agent_plan",
        jobId: "plan-job-1",
        details: {
          mode: "read_only",
          agents: [
            {
              handle: "runtime",
              label: "Runtime/tool boundaries",
              scopeSummary: "Runtime boundary inspection",
              writeScope: { mode: "read_only" },
            },
          ],
          lead: {
            leadHandle: "octo",
            expectedReportFormat: "Final report.",
          },
        },
      },
    });
    const workerMessage = createMessage({
      id: "worker-message",
      content: "Worker evidence.",
      metadata: {
        jobId: "worker-job-1",
        agent: { handle: "runtime" },
        multiAgentPlan: {
          role: "worker",
          parentJobId: "plan-job-1",
          groupId: "group-1",
        },
      },
    });
    const leadThreadMessage = createMessage({
      id: "lead-thread-message",
      content: "Severity-ranked findings.",
      metadata: {
        messageType: "agent_job_thread",
        jobId: "lead-job-1",
        agent: { handle: "octo" },
        threadMessages: [
          createMessage({
            id: "lead-summary",
            content: "Severity-ranked findings.",
            metadata: {
              source: "agent",
              kind: "completion",
              status: "completed",
              agent: { handle: "octo" },
              outcome: "succeeded",
              multiAgentPlan: {
                role: "lead_continuation",
                groupId: "group-1",
              },
            },
          }),
        ],
      },
    });

    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={[planMessage, leadThreadMessage]}
          allConversationMessages={[planMessage, workerMessage, leadThreadMessage]}
          currentUserId={null}
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
        />,
      );
    });

    expect(container.textContent).toContain("Severity-ranked findings.");
    expect(container.querySelectorAll('[data-testid="chat-workflow-spine"]')).toHaveLength(2);
    expect(container.querySelector('[data-message-type="multi_agent_plan"] [data-testid="thread-spine"]')).toBeNull();
    expect(container.querySelector('[data-message-type="agent_job_thread"] [data-testid="thread-spine"]')).toBeNull();
    expect(container.querySelector('[data-message-type="agent_job_thread"] [data-workflow-spine-notch-anchor="true"]')).not.toBeNull();
  });

  it("renders failed-run error bubbles with a friendly body, details toggle, and retry", async () => {
    const rawFailure =
      "Codex completed without returning a final assistant message after retry. The run trace contains the raw Codex events for debugging.";
    const promptMessage = createMessage({
      id: "user-prompt",
      role: "user",
      authorId: "user-1",
      content: "Build me a landing page",
      timestamp: 1,
    });
    const failureMessage = createMessage({
      id: "run-failure",
      role: "assistant",
      content: rawFailure,
      timestamp: 2,
      messageType: "error",
      metadata: {
        source: "agent",
        outcome: "failed",
        messageType: "error",
        errorMessage: rawFailure,
      },
    });
    const requestRetry = vi.fn();

    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={{ pendingRetryKey: null, requestRetry, autoRetryingKey: null }}>
          <ConversationMessageRows
            messages={[promptMessage, failureMessage]}
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
        </RunFailureRetryProvider>,
      );
    });

    expect(container.textContent).toContain(
      "The reply didn't come through — this is usually a temporary provider hiccup.",
    );
    expect(container.textContent).not.toContain(rawFailure);
    expect(container.querySelector('[data-testid="run-failure-details"]')).toBeNull();
    expect(container.querySelector('[data-testid="run-failure-auto-retrying"]')).toBeNull();

    const detailsToggle = container.querySelector(
      '[data-testid="run-failure-details-toggle"]',
    ) as HTMLButtonElement | null;
    expect(detailsToggle).not.toBeNull();
    await act(async () => {
      detailsToggle?.click();
    });
    expect(container.querySelector('[data-testid="run-failure-details"]')?.textContent).toBe(rawFailure);

    const retryButton = container.querySelector(
      '[data-testid="run-failure-retry"]',
    ) as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();
    await act(async () => {
      retryButton?.click();
    });
    expect(requestRetry).toHaveBeenCalledTimes(1);
    expect(requestRetry.mock.calls[0]?.[0]?.id).toBe("run-failure");
  });

  it("shows the calm auto-retry state for the failure being re-dispatched automatically", async () => {
    const rawFailure =
      "Codex completed without returning a final assistant message after retry. The run trace contains the raw Codex events for debugging.";
    const promptMessage = createMessage({
      id: "user-prompt",
      role: "user",
      authorId: "user-1",
      content: "Build me a landing page",
      timestamp: 1,
    });
    const failureMessage = createMessage({
      id: "run-failure",
      role: "assistant",
      content: rawFailure,
      timestamp: 2,
      messageType: "error",
      metadata: {
        source: "agent",
        outcome: "failed",
        messageType: "error",
        errorMessage: rawFailure,
      },
    });
    const requestRetry = vi.fn();

    await act(async () => {
      root.render(
        <RunFailureRetryProvider
          value={{ pendingRetryKey: null, requestRetry, autoRetryingKey: "run-failure" }}
        >
          <ConversationMessageRows
            messages={[promptMessage, failureMessage]}
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
        </RunFailureRetryProvider>,
      );
    });

    // Calm auto state: friendly sentence + quiet "trying again automatically",
    // Details still available, no manual "Try again" button.
    expect(container.textContent).toContain(
      "The reply didn't come through — this is usually a temporary provider hiccup.",
    );
    expect(container.querySelector('[data-testid="run-failure-auto-retrying"]')?.textContent).toBe(
      "Trying again automatically…",
    );
    expect(container.querySelector('[data-testid="run-failure-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="run-failure-details-toggle"]')).not.toBeNull();
  });
});
