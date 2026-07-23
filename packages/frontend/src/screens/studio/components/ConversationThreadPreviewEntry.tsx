import {
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavArrowDown, NavArrowRight, OpenNewWindow, Threads } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { useProject } from "../../../projects/useProject";
import { useRuntimeMenuOptions } from "../../../runtime/useRuntimeMenu";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import type { ChatMessage } from "../types";
import { truncate } from "./chatContentHelpers";
import {
  collapseLifecycleMessages,
  shouldDisplayChatMessage,
  synthesizeAgentJobThreadMessages,
} from "./chatMessagePresentation";
import { getMessageType } from "./chatMessageMetadata";
import { isGenericProgressLabel } from "./threadPreviewHelpers";

type AssistantMessageEntryProps = {
  message: ChatMessage;
  conversationMessages: ChatMessage[];
  projectId?: string | null;
  conversationLocalId?: string | null;
  conversationControllerId?: string | null;
  onMessageContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void;
};

type UserMessageBubbleProps = {
  message: ChatMessage;
  projectId?: string | null;
  runtimeId?: string | null;
  align?: "left" | "right";
};

export function ConversationThreadPreviewEntry({
  message,
  AssistantMessageEntry,
  UserMessageBubble,
  onMessageContextMenu,
}: {
  message: ChatMessage;
  AssistantMessageEntry: ComponentType<AssistantMessageEntryProps>;
  UserMessageBubble: ComponentType<UserMessageBubbleProps>;
  onMessageContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void;
}) {
  const metadata =
    message.metadata && typeof message.metadata === "object" && message.metadata !== null && !Array.isArray(message.metadata)
      ? message.metadata
      : null;
  const threadLocalId = typeof metadata?.threadLocalId === "string" ? metadata.threadLocalId.trim() : "";
  const { conversations } = useConversations();
  const { openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const { activeProjectId } = useProject();
  const runtimeMenu = useRuntimeMenuOptions();
  const runtimeContext = runtimeMenu.runtime;
  const runtimeId = runtimeContext.effectiveRuntimeId ?? runtimeContext.preferredRuntimeId ?? null;
  const threadConversation = useMemo(
    () => (threadLocalId ? conversations.find((entry) => entry.localId === threadLocalId) ?? null : null),
    [conversations, threadLocalId],
  );
  const parentThreadConversation = useMemo(() => {
    const parentControllerId = threadConversation?.parentConversationId ?? null;
    if (!parentControllerId) {
      return null;
    }
    return conversations.find((entry) => entry.controllerId === parentControllerId) ?? null;
  }, [conversations, threadConversation?.parentConversationId]);
  const rawThreadMessages = useMemo(
    () => threadConversation?.messages ?? [],
    [threadConversation?.messages],
  );
  const firstSeedUserMessage = useMemo(
    () => rawThreadMessages.find((candidate) => candidate.role === "user" && candidate.content.trim().length > 0) ?? null,
    [rawThreadMessages],
  );
  const inheritedSeedUserMessage = useMemo(() => {
    const parentMessages = parentThreadConversation?.messages ?? [];
    for (let index = parentMessages.length - 1; index >= 0; index -= 1) {
      const candidate = parentMessages[index];
      if (candidate.role !== "user") {
        continue;
      }
      const content = candidate.content.trim();
      if (!content) {
        continue;
      }
      return candidate;
    }
    return null;
  }, [parentThreadConversation?.messages]);
  const seedCommandText = useMemo(
    () => firstSeedUserMessage?.content.trim() ?? inheritedSeedUserMessage?.content.trim() ?? "",
    [firstSeedUserMessage, inheritedSeedUserMessage],
  );
  const isSlashSeedThread = useMemo(() => seedCommandText.startsWith("/"), [seedCommandText]);
  const collapsedThreadAllMessages = useMemo(
    () => collapseLifecycleMessages(threadConversation?.messages ?? []),
    [threadConversation],
  );
  const collapsedThreadVisibleMessages = useMemo(
    () => collapsedThreadAllMessages.filter((candidate) => shouldDisplayChatMessage(candidate)),
    [collapsedThreadAllMessages],
  );
  const visibleThreadMessages = useMemo(() => {
    if (!threadConversation) {
      return [];
    }
    const synthesized = synthesizeAgentJobThreadMessages(
      collapsedThreadAllMessages,
      collapsedThreadVisibleMessages,
    );
    if (!isSlashSeedThread || !firstSeedUserMessage) {
      return synthesized;
    }
    return synthesized.filter((candidate) => candidate.id !== firstSeedUserMessage.id);
  }, [
    collapsedThreadAllMessages,
    collapsedThreadVisibleMessages,
    firstSeedUserMessage,
    isSlashSeedThread,
    threadConversation,
  ]);

  const preview = useMemo(() => {
    if (!threadConversation) {
      return "";
    }
    const threadMessages = rawThreadMessages;
    const isPreviewCandidate = (candidate: ChatMessage) => {
      const content = candidate.content.trim();
      if (!content) {
        return false;
      }
      if (isSlashSeedThread && firstSeedUserMessage && candidate.id === firstSeedUserMessage.id) {
        return false;
      }
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
      if (!type) {
        if (isGenericProgressLabel(content)) {
          return false;
        }
        return true;
      }
      return ![
        "command_execution",
        "mcp_tool_call",
        "todo_list",
        "web_search",
        "token_usage",
        "runtime_switch",
        "reasoning",
        "status",
      ].includes(type);
    };

    const resolveLast = (predicate: (candidate: ChatMessage) => boolean) => {
      for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
        const candidate = threadMessages[index];
        if (predicate(candidate)) {
          return candidate;
        }
      }
      return null;
    };

    const lastFileChange = resolveLast((candidate) => {
      if (!isPreviewCandidate(candidate)) {
        return false;
      }
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
      return type === "file_change";
    });
    const lastAssistant = resolveLast((candidate) => candidate.role === "assistant" && isPreviewCandidate(candidate));
    const lastAny = lastFileChange ?? lastAssistant ?? resolveLast(isPreviewCandidate);
    const fallback = lastAny ?? resolveLast((candidate) => {
      if (!candidate.content.trim()) {
        return false;
      }
      if (isSlashSeedThread && firstSeedUserMessage && candidate.id === firstSeedUserMessage.id) {
        return false;
      }
      return true;
    });
    const text = fallback?.content?.trim() ?? "";
    return text ? truncate(text, 220) : "";
  }, [firstSeedUserMessage, isSlashSeedThread, rawThreadMessages, threadConversation]);

  const isRunning = (threadConversation?.pendingRunIds ?? []).length > 0;
  const title = useMemo(() => {
    const explicitTitle = (threadConversation?.title ?? "").trim();
    if (explicitTitle) {
      return explicitTitle;
    }
    const content = seedCommandText;
    if (!content) {
      return "";
    }
    const lowered = content.toLowerCase();
    if (lowered.startsWith("/learn")) {
      return "Learn";
    }
    if (lowered.startsWith("/terminal") || lowered.startsWith("/term")) {
      return "Terminal";
    }
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return firstLine ? truncate(firstLine, 48) : "";
  }, [seedCommandText, threadConversation]);
  const previewText = preview || (isRunning ? "Starting…" : "No messages yet.");

  const [expanded, setExpanded] = useState(false);
  const threadBottomRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollThreadRef = useRef(true);

  const scrollThreadToBottom = useCallback(() => {
    const target = threadBottomRef.current;
    if (!target) {
      return;
    }
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "end", behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, []);

  const handleThreadScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const distanceFromBottom = node.scrollHeight - (node.scrollTop + node.clientHeight);
    shouldAutoScrollThreadRef.current = distanceFromBottom < 32;
  }, []);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    shouldAutoScrollThreadRef.current = true;
    scrollThreadToBottom();
  }, [expanded, scrollThreadToBottom]);

  const handleOpen = useCallback(() => {
    if (!threadLocalId) {
      return;
    }
    requestUrlPush();
    openConversationTab(threadLocalId);
  }, [openConversationTab, requestUrlPush, threadLocalId]);

  const threadMessages = visibleThreadMessages;

  const threadScrollKey = useMemo(() => {
    const last = threadMessages[threadMessages.length - 1];
    if (!last) {
      return "empty";
    }
    return `${last.id}:${last.content.length}`;
  }, [threadMessages]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    if (!shouldAutoScrollThreadRef.current) {
      return;
    }
    scrollThreadToBottom();
  }, [expanded, scrollThreadToBottom, threadScrollKey]);

  if (!threadConversation) {
    return null;
  }

  if (isSlashSeedThread) {
    return (
      <div
        data-testid="conversation-thread-preview"
        data-message-type="conversation_thread"
        className="min-w-0 max-w-[min(calc(100%-2.5rem),42rem)] text-sm text-slate-700 dark:text-slate-200 sm:max-w-[min(80%,42rem)]"
      >
        {threadMessages.length === 0 ? (
          <div className="relative py-1">
            <Text as="div" variant="caption" tone="muted" className="flex min-w-0 items-center gap-1.5 text-xs">
              {isRunning ? <Spinner aria-label="Thread is running" tone="slate" size="xs" className="h-3.5 w-3.5" /> : null}
              <span
                className={`${isRunning ? "instafy-status-sweep" : ""} min-w-0 truncate`}
                data-sweep-text={previewText}
              >
                {previewText}
              </span>
            </Text>
          </div>
        ) : (
          <div className="space-y-3">
            {threadMessages.map((threadMessage) => (
              <div
                key={threadMessage.id}
                className={threadMessage.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                {threadMessage.role === "user" ? (
                  <UserMessageBubble
                    message={threadMessage}
                    projectId={activeProjectId}
                    runtimeId={runtimeId}
                  />
                ) : (
                  <AssistantMessageEntry
                    message={threadMessage}
                    conversationMessages={threadMessages}
                    projectId={activeProjectId}
                    conversationLocalId={threadConversation.localId}
                    conversationControllerId={threadConversation.controllerId ?? null}
                    onMessageContextMenu={onMessageContextMenu}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const threadIcon = <Threads aria-hidden="true" className="h-4 w-4 text-slate-600 dark:text-slate-300" />;

  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      data-testid="conversation-thread-preview"
      data-message-type="conversation_thread"
      className="max-w-[min(80%,42rem)] px-4 py-3 text-sm text-slate-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-900">
              {threadIcon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {title ? (
                  <Text as="div" variant="body" className="min-w-0 truncate font-semibold text-slate-900 dark:text-slate-100">
                    {title}
                  </Text>
                ) : (
                  <Text as="div" variant="body" className="font-semibold text-slate-900 dark:text-slate-100">
                    Thread
                  </Text>
                )}
                {isRunning ? <Spinner aria-label="Thread is running" tone="primary" size="xs" /> : null}
              </div>
              {!expanded ? (
                <Text as="div" variant="caption" tone="muted" className="mt-2 break-words">
                  {previewText}
                </Text>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <IconButton
            aria-label="Open thread in new tab"
            variant="ghost"
            size="xs"
            radius="full"
            onPress={handleOpen}
          >
            <OpenNewWindow aria-hidden="true" className="h-4 w-4" />
          </IconButton>
          <IconButton
            aria-label={expanded ? "Collapse thread" : "Expand thread"}
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <NavArrowDown aria-hidden="true" className="h-4 w-4" />
            ) : (
              <NavArrowRight aria-hidden="true" className="h-4 w-4" />
            )}
          </IconButton>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="max-h-[28rem] space-y-3 overflow-auto pr-1" onScroll={handleThreadScroll}>
            {threadMessages.length === 0 ? (
              <Text as="div" variant="caption" tone="muted">
                No messages yet.
              </Text>
            ) : (
              threadMessages.map((threadMessage) => (
                <div
                  key={threadMessage.id}
                  className={threadMessage.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  {threadMessage.role === "user" ? (
                    <UserMessageBubble
                      message={threadMessage}
                      projectId={activeProjectId}
                      runtimeId={runtimeId}
                      align="right"
                    />
                  ) : (
                    <AssistantMessageEntry
                      message={threadMessage}
                      conversationMessages={threadMessages}
                      projectId={activeProjectId}
                      conversationLocalId={threadConversation.localId}
                      conversationControllerId={threadConversation.controllerId ?? null}
                      onMessageContextMenu={onMessageContextMenu}
                    />
                  )}
                </div>
              ))
            )}
            <div ref={threadBottomRef} />
          </div>
        </div>
      ) : null}
    </Surface>
  );
}
