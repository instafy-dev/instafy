import { type ComponentType, useState } from "react";
import { Check, ClipboardCheck, Globe, NavArrowRight, Terminal } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import type {
  ChatMessage,
  ChatMessageCommitRange,
  ChatMessageFileChange,
} from "../types";
import { parseCommandExecutionOutput, parseTodoItems, truncate } from "./chatContentHelpers";
import {
  formatPromptContextModeLabel,
  formatTokenCountLabel,
  getTimelineHeading,
  isPlaywrightCliCommand,
  parseTemplateToolCall,
  resolveBrowserToolRuntimeId,
  resolveTimelineStatusBadge,
  resolveTokenUsageForMessage,
} from "./chatMessageDetailHelpers";
import { getMessageType } from "./chatMessageMetadata";
import { CommandOutputBlock } from "./CommandOutputBlock";
import { TemplateToolCallDetails } from "./TemplateToolCallDetails";

type MessageContentProps = {
  content: string;
  className?: string;
  projectId?: string | null;
};

type ChatFileChangeListProps = {
  files: ChatMessageFileChange[];
  projectId?: string | null;
  commitRange?: ChatMessageCommitRange | null;
};

export function TimelineEntry({
  message,
  conversationMessages,
  details,
  metadataRecord,
  defaultPlanExpanded,
  projectId,
  onCancelTerminalCommand,
  conversationLocalId,
  conversationControllerId,
  MessageContent,
  ChatFileChangeList,
  renderContext = "conversation",
}: {
  message: ChatMessage;
  conversationMessages: ChatMessage[];
  details: Record<string, unknown> | null;
  metadataRecord?: Record<string, unknown> | null;
  defaultPlanExpanded?: boolean;
  projectId?: string | null;
  onCancelTerminalCommand?: (() => void | Promise<void>) | null;
  conversationLocalId?: string | null;
  conversationControllerId?: string | null;
  MessageContent: ComponentType<MessageContentProps>;
  ChatFileChangeList: ComponentType<ChatFileChangeListProps>;
  renderContext?: "conversation" | "runTrace";
}) {
  const messageType = getMessageType(message);
  const heading = getTimelineHeading(messageType, details);
  const statusFromDetails = details && typeof details.status === "string" ? (details.status as string) : null;
  const resolvedMetadata =
    metadataRecord ??
    (message.metadata && typeof message.metadata === "object" && message.metadata !== null && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null);
  const statusFromMetadata =
    resolvedMetadata && typeof resolvedMetadata.status === "string"
      ? (resolvedMetadata.status as string)
      : null;
  const commandExecution = messageType === "command_execution" ? parseCommandExecutionOutput(message) : null;
  const status = statusFromDetails ?? statusFromMetadata ?? commandExecution?.status ?? null;
  const statusBadge = resolveTimelineStatusBadge(messageType, status);
  const aggregatedOutputRaw =
    commandExecution?.output ??
    (details && typeof details.aggregatedOutput === "string"
      ? (details.aggregatedOutput as string)
      : details && typeof details.aggregated_output === "string"
        ? (details.aggregated_output as string)
        : resolvedMetadata && typeof resolvedMetadata.aggregatedOutput === "string"
          ? (resolvedMetadata.aggregatedOutput as string)
          : resolvedMetadata && typeof resolvedMetadata.aggregated_output === "string"
            ? (resolvedMetadata.aggregated_output as string)
            : null);
  const aggregatedOutput = aggregatedOutputRaw && aggregatedOutputRaw.trim().length > 0 ? aggregatedOutputRaw : null;
  const todoItems = parseTodoItems(details);
  const usage = resolveTokenUsageForMessage(conversationMessages, message.id);
  const templateToolCall =
    messageType === "mcp_tool_call" ? parseTemplateToolCall(details ?? undefined) : null;
  const canOpenBrowser =
    messageType === "command_execution" && isPlaywrightCliCommand(commandExecution?.command ?? null);
  const browserToolRuntimeId = resolveBrowserToolRuntimeId(details, resolvedMetadata);
  const isPlanMessage = messageType === "todo_list";
  const planSummary =
    isPlanMessage && todoItems.length > 0
      ? {
          completed: todoItems.filter((item) => item.completed).length,
          total: todoItems.length,
        }
      : null;
  const planProgressPercent =
    planSummary && planSummary.total > 0 ? Math.round((planSummary.completed / planSummary.total) * 100) : null;
  const planCompleted = planSummary ? planSummary.completed === planSummary.total : false;
  const initialPlanExpanded =
    defaultPlanExpanded ?? (isPlanMessage && planSummary !== null && planSummary.completed === 0);
  const [planExpanded, setPlanExpanded] = useState<boolean>(initialPlanExpanded);
  const isRunTrace = renderContext === "runTrace";
  const stepsWithIndex = todoItems.map((item, index) => ({ ...item, index }));
  const completedSteps = stepsWithIndex.filter((item) => item.completed);
  const pendingSteps = stepsWithIndex.filter((item) => !item.completed);
  const nextStep = pendingSteps[0] ?? null;
  const isCommandExecutionWithOutput = messageType === "command_execution" && Boolean(aggregatedOutput);
  const bubbleClassName = isCommandExecutionWithOutput
    ? "flex-1 min-w-0 max-w-[56rem] border-0 bg-transparent p-0 shadow-none dark:bg-transparent"
    : "max-w-[min(80%,42rem)] px-3 py-2.5 text-sm text-slate-700";

  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      data-testid="chat-bubble-assistant"
      data-message-type={messageType ?? undefined}
      className={bubbleClassName}
    >
      {!isCommandExecutionWithOutput ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {messageType === "command_execution" ? (
                <Terminal className="h-4 w-4 text-slate-500" aria-hidden="true" />
              ) : messageType === "local_capability_result" ? (
                <Globe className="h-4 w-4 text-slate-500" aria-hidden="true" />
              ) : messageType === "todo_list" ? (
                <ClipboardCheck className="h-4 w-4 text-slate-500" aria-hidden="true" />
              ) : null}
              {heading && messageType !== "command_execution" && messageType !== "todo_list" ? (
                <Text variant="overline" tone="subtle">
                  {heading}
                </Text>
              ) : null}
            </div>
            {messageType !== "todo_list" ? (
              <MessageContent content={message.content} projectId={projectId ?? null} />
            ) : null}
          </div>
          {statusBadge ? (
            <Badge size="xs" className={statusBadge.className}>
              {statusBadge.showSpinner ? (
                <>
                  <Spinner aria-hidden="true" tone="primary" size="xs" />
                  <span className="sr-only">In progress</span>
                </>
              ) : null}
              {statusBadge.label}
            </Badge>
          ) : null}
          {canOpenBrowser ? (
            <Button
              variant="outline"
              size="xs"
              radius="full"
              onPress={() => {
                if (typeof window === "undefined") {
                  return;
                }
                window.dispatchEvent(
                  new CustomEvent("instafy:browser-open", {
                    detail: {
                      args: browserToolRuntimeId ? [browserToolRuntimeId] : [],
                      runtimeId: browserToolRuntimeId ?? undefined,
                      conversationLocalId: conversationLocalId ?? undefined,
                      conversationControllerId: conversationControllerId ?? undefined,
                    },
                  }),
                );
              }}
            >
              Open browser
            </Button>
          ) : null}
          {isPlanMessage && todoItems.length > 0 ? (
            <Button
              onPress={() => setPlanExpanded((value) => !value)}
              variant="ghost"
              size="icon"
              radius="full"
              className="h-6 w-6 text-slate-500 hover:bg-transparent hover:text-slate-700 data-[hovered]:bg-transparent data-[hovered]:text-slate-700"
              aria-label={planExpanded ? "Hide plan details" : "Show plan details"}
            >
              <NavArrowRight
                className={`h-3 w-3 transition-transform ${planExpanded ? "rotate-90 text-slate-600" : "text-slate-400"}`}
                aria-hidden="true"
              />
            </Button>
          ) : null}
        </div>
      ) : null}
      {planSummary && planProgressPercent !== null ? (
        <div className="mt-3">
          <Text as="div" variant="caption" tone="muted" className="flex items-center justify-between font-medium">
            <span>{planProgressPercent}% complete</span>
            <span>
              {planSummary.completed}/{planSummary.total} steps
            </span>
          </Text>
          <div className="mt-2 h-1.5 w-full rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full ${planCompleted ? "bg-primary-600" : "bg-primary-400"}`}
              style={{ width: `${planProgressPercent}%` }}
            />
          </div>
        </div>
      ) : null}
      {templateToolCall ? <TemplateToolCallDetails info={templateToolCall} /> : null}
      {aggregatedOutput && (!isPlanMessage || planExpanded) ? (
        <CommandOutputBlock
          command={messageType === "command_execution" ? message.content : null}
          output={aggregatedOutput}
          status={status}
          className={isCommandExecutionWithOutput ? "" : "mt-3"}
          compact={isRunTrace}
          collapsible={isRunTrace}
          defaultOutputVisible={!isRunTrace}
          subtle={isRunTrace}
          onCancel={onCancelTerminalCommand ?? null}
        />
      ) : null}
      {isPlanMessage && !planExpanded && todoItems.length > 0 ? (
        <div className="mt-3 space-y-1 text-xs text-slate-600">
          {completedSteps.length > 0 ? (
            <Text as="p" variant="caption" tone="subtle" className="flex items-start gap-2">
              <Check className="ml-[-2px] mr-[-2px] h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
              <span>
                Step {completedSteps[completedSteps.length - 1].index + 1} -{" "}
                {truncate(completedSteps[completedSteps.length - 1].text, 70)}
              </span>
            </Text>
          ) : null}
          <Text as="p" variant="caption" tone="inherit" className="flex items-start gap-2">
            <NavArrowRight className="mt-[2px] h-3 w-3 flex-shrink-0 text-slate-500" aria-hidden="true" />
            <span>
              {nextStep ? (
                <>
                  Step {nextStep.index + 1} - {truncate(nextStep.text, 70)}
                </>
              ) : (
                "All done"
              )}
            </span>
          </Text>
        </div>
      ) : null}
      {todoItems.length > 0 && (!isPlanMessage || planExpanded) ? (
        <ul className="mt-3 space-y-2 text-sm">
          {todoItems.map((item, index) => (
            <li key={`${item.text}-${index}`} className="flex items-start gap-2">
              <span
                className={`mt-1 inline-flex h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                  item.completed ? "bg-primary-500" : "bg-slate-300"
                }`}
                aria-hidden="true"
              />
              <span className={item.completed ? "line-through text-slate-400" : "text-slate-600"}>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {usage && (!isPlanMessage || planExpanded) ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge size="xs" className="text-slate-600">
            Input {usage.inputTokens}
          </Badge>
          <Badge size="xs" className="text-slate-600">
            Cached {usage.cachedInputTokens}
          </Badge>
          <Badge size="xs" className="text-slate-600">
            Output {usage.outputTokens}
          </Badge>
          {usage.context ? (
            <Badge size="xs" className="text-slate-600">
              {formatPromptContextModeLabel(usage.context)}
            </Badge>
          ) : null}
          {usage.context?.estimatedPromptTokens !== null &&
          usage.context?.estimatedPromptTokens !== undefined ? (
            <Badge size="xs" className="text-slate-600">
              Prompt {formatTokenCountLabel(usage.context.estimatedPromptTokens)}
            </Badge>
          ) : null}
          {usage.context?.estimatedPromptUsagePercent !== null &&
          usage.context?.estimatedPromptUsagePercent !== undefined ? (
            <Badge size="xs" className="text-slate-600">
              {usage.context.estimatedPromptUsagePercent}% window
            </Badge>
          ) : null}
        </div>
      ) : null}
      {message.files && message.files.length > 0 ? (
        <div className="mt-3">
          <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} />
        </div>
      ) : null}
    </Surface>
  );
}
