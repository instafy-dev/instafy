import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import { isDefaultConversationTitle } from "../../../conversations/conversationAutoTitle";
import type { StudioDestination } from "../../../navigation/studioNavigation";
import { toastChatName } from "../../../notifications/useNotificationCenter";
import type { RuntimeSharedBrowserApprovalRequest } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { statusBehavior } from "../../../status/statusBehavior";
import type { RunRecord } from "../../../types";
import { generateUUID } from "../../../utils/uuid";
import {
  conversationSurfaceScope,
  showPromptView,
  type ConversationSurfaces,
} from "../../../workspace/conversationSurfaces";
import { BROWSER_AGENT_DEFAULT_NAME } from "./browserAgentTabs";
import { extractAgentIdentityFromMetadata } from "./chatAssistantIdentity";
import {
  selectSpaceSharedBrowserApprovalTargets,
  type SpaceSharedBrowserApprovalTarget,
} from "./chatSharedBrowserApproval";
import { useApprovalGrant } from "./useChatSharedBrowserApproval";
import { useSharedBrowserApproval } from "./useSharedBrowserApproval";

/** A chat of the space, as far as a waiting prompt needs it. */
export type WaitingPromptChat = { localId: string; controllerId?: string | null; title: string };

/** The longest agent name a toast quotes. */
const AGENT_NAME_MAX_CHARS = 40;

/**
 * How long a prompt a read lane stopped holding still counts as waiting,
 * unless its time ran out: a lane whose grant is renewed (every few minutes)
 * reads its prompt again from nothing, and the toast and the tab's Approve do
 * not blink, nor a closed toast come back, meanwhile.
 */
export const WAITING_PROMPT_REREAD_GRACE_MS = 2_000;

/**
 * What the toast says: who waits and in which chat, by the chat's name, never
 * the step, the page or the site the prompt is about.
 */
export function waitingPromptToastText(agentName: string, chatName: string | null): string {
  const shown = toastChatName(chatName);
  return shown
    ? `${agentName} is waiting for your OK in “${shown}”.`
    : `${agentName} is waiting for your OK in another chat.`;
}

/**
 * The chat whose own prompts are on screen, read by its chat panel: the chat
 * shown, unless it shows as a job thread, whose panel does not read them.
 */
export function chatReadingOwnPrompts(
  activeTabKind: string | null | undefined,
  visibleConversationControllerId: string | null,
): string | null {
  return activeTabKind === "jobThread" ? null : visibleConversationControllerId;
}

/** The open chats' tabs, Approve on those a prompt waits in (`waiting`: lowercased controller ids). */
export function withChatsAwaitingOk<T extends { controllerId?: string | null }>(
  tabs: T[],
  waiting: ReadonlySet<string>,
): (T & { attention?: boolean })[] {
  if (waiting.size === 0) return tabs;
  return tabs.map((tab) => {
    const controllerId = tab.controllerId?.trim().toLowerCase();
    return controllerId && waiting.has(controllerId) ? { ...tab, attention: true } : tab;
  });
}

/**
 * View on a waiting prompt's toast: opens its chat where the prompt shows,
 * Chat in front, or its Browser view if that was in front (never a file or a
 * site, which would hide it).
 */
export function openChatAwaitingOk({ userId, projectId, chat, updateSurfaces, navigate }: {
  userId: string | null;
  projectId: string;
  chat: { conversationId: string; localId: string | null };
  updateSurfaces: (scope: string | null, change: (state: ConversationSurfaces) => ConversationSurfaces) => void;
  navigate: (destination: StudioDestination) => void;
}): void {
  if (chat.localId) updateSurfaces(conversationSurfaceScope(userId, projectId, chat.localId), showPromptView);
  navigate({ kind: "conversation", projectId, conversationId: chat.localId, conversationControllerId: chat.conversationId });
}

/** The AI the run is for, by the name the chat shows it with. */
function runAgentName(metadata: Record<string, unknown>): string {
  const handle = extractAgentIdentityFromMetadata(metadata)?.handle ?? null;
  const builtIn = handle ? getBuiltInAssistantDisplayName(handle) : null;
  if (builtIn) return builtIn;
  const agent = metadata.agent;
  const displayName = agent && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as Record<string, unknown>).displayName
    : null;
  const name = typeof displayName === "string" ? displayName.replace(/\s+/g, " ").trim() : "";
  return name && [...name].length <= AGENT_NAME_MAX_CHARS ? name : BROWSER_AGENT_DEFAULT_NAME;
}

/**
 * Reads the prompt of one running browser turn, with a grant that can only
 * read it: nothing here answers a prompt. It reports the prompt's id while one
 * waits (and through a re-read, `WAITING_PROMPT_REREAD_GRACE_MS`), and nothing
 * of what it is about.
 */
function WaitingBrowserPromptLane({ projectId, userId, target, browserSessionId, onChange }: {
  projectId: string;
  userId: string;
  target: SpaceSharedBrowserApprovalTarget;
  browserSessionId: string;
  onChange: (runId: string, approvalId: string | null) => void;
}) {
  const grant = useApprovalGrant({ projectId, runtimeId: target.runtimeId, browserSessionId, answers: false });
  const forThisRun = useCallback(
    (request: RuntimeSharedBrowserApprovalRequest) => request.runId === target.runId && request.initiatorUserId === userId,
    [target.runId, userId],
  );
  const lane = useSharedBrowserApproval({
    active: Boolean(grant),
    projectId,
    browserSessionId,
    runtimeId: target.runtimeId,
    browserPageId: target.browserPageId,
    originEndpoint: grant?.endpoint ?? null,
    originAccessToken: grant?.accessToken ?? null,
    acceptsRequest: forThisRun,
  });
  const approvalId = lane.pending?.request.approvalId ?? null;
  const expiresAtMs = lane.pending?.request.expiresAtMs ?? null;
  const [waitingId, setWaitingId] = useState<string | null>(null);
  const lastPrompt = useRef<{ approvalId: string; expiresAtMs: number } | null>(null);
  useEffect(() => {
    if (approvalId && expiresAtMs !== null) {
      lastPrompt.current = { approvalId, expiresAtMs };
      setWaitingId(approvalId);
      return;
    }
    const gone = () => {
      lastPrompt.current = null;
      setWaitingId(null);
    };
    const leftMs = lastPrompt.current
      ? Math.min(WAITING_PROMPT_REREAD_GRACE_MS, lastPrompt.current.expiresAtMs - Date.now())
      : 0;
    if (leftMs <= 0) {
      gone();
      return;
    }
    const timer = window.setTimeout(gone, leftMs);
    return () => window.clearTimeout(timer);
  }, [approvalId, expiresAtMs]);
  useEffect(() => {
    onChange(target.runId, waitingId);
    return () => onChange(target.runId, null);
  }, [onChange, target.runId, waitingId]);
  return null;
}

/**
 * A prompt that a browser turn the person started waits on in a chat that is
 * not on screen reaches them: a toast names the chat ("Octo is waiting for
 * your OK in “…”." with View), and the chat's tab says Approve
 * (`onWaitingChange`) until the prompt is answered, runs out or its chat
 * comes on screen. View opens the chat (`onView`), where the prompt shows and
 * is answered as it is today. Only the person who started a turn is told of
 * its prompts: a teammate's turn is never read, and the origin answers a
 * prompt only to the person who started the run. Nothing of the prompt, its
 * page or its site shows outside its chat.
 *
 * Reads: only the turn that holds a machine's browser can ask, so this reads
 * one prompt a machine, of the person's newest running browser turn there,
 * and none for the chat on screen, which reads its own. Each read is the
 * prompt read the open chat makes (every 1.5 s while the turn runs, every
 * 400 ms while a prompt waits, none while the tab is hidden), with a
 * view-only grant minted once a machine and renewed before it runs out.
 */
export function WaitingBrowserPrompts({
  enabled, userId, projectId, runs, chats, chatOnScreen, onView, onWaitingChange,
}: {
  enabled: boolean;
  userId: string | null;
  projectId: string | null;
  runs: Readonly<Record<string, RunRecord>> | null | undefined;
  chats: readonly WaitingPromptChat[];
  /** The controller id of the chat whose own prompts are on screen. */
  chatOnScreen: string | null;
  onView: (chat: { conversationId: string; localId: string | null }) => void;
  /** The controller ids (lowercased) of the chats a prompt waits in. */
  onWaitingChange: (conversationIds: ReadonlySet<string>) => void;
}) {
  const { showStatus, hideStatus } = useStatus();
  const browserSessionId = useMemo(() => generateUUID(), []);
  const targets = useMemo(
    () => enabled && runs
      ? selectSpaceSharedBrowserApprovalTargets(Object.values(runs), { userId, projectId, chatOnScreen })
      : [],
    [chatOnScreen, enabled, projectId, runs, userId],
  );
  // The prompt each watched run waits on, by run.
  const [asking, setAsking] = useState<Readonly<Record<string, string>>>({});
  const report = useCallback((runId: string, approvalId: string | null) => {
    setAsking((current) => {
      if ((current[runId] ?? null) === approvalId) return current;
      const next = { ...current };
      if (approvalId) next[runId] = approvalId;
      else delete next[runId];
      return next;
    });
  }, []);
  const waiting = useMemo(
    () => targets.flatMap((target) => asking[target.runId] ? [{ target, approvalId: asking[target.runId]! }] : []),
    [asking, targets],
  );

  // Said only when it changes: the tabs that show it belong to the whole layout.
  const waitingKey = [...new Set(waiting.map(({ target }) => target.conversationId))].sort().join("\n");
  const onWaitingChangeRef = useRef(onWaitingChange);
  onWaitingChangeRef.current = onWaitingChange;
  const saidKey = useRef("");
  useEffect(() => {
    if (saidKey.current === waitingKey) return;
    saidKey.current = waitingKey;
    onWaitingChangeRef.current(new Set(waitingKey ? waitingKey.split("\n") : []));
  }, [waitingKey]);
  useEffect(() => () => {
    if (saidKey.current) onWaitingChangeRef.current(new Set());
    saidKey.current = "";
  }, []);

  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  // One toast per prompt: it goes when the prompt does. It waits behind an
  // existing action and stays until resolved or dismissed. Once the person
  // closes it, it does not come back for the same prompt (the chat's tab still
  // says Approve).
  const toasts = useRef(new Map<string, string>());
  useEffect(() => {
    const live = new Set(waiting.map(({ approvalId }) => approvalId));
    for (const [approvalId, toastId] of toasts.current) {
      if (!live.has(approvalId)) {
        toasts.current.delete(approvalId);
        hideStatus(toastId);
      }
    }
    for (const { target, approvalId } of waiting) {
      if (toasts.current.has(approvalId)) continue;
      const chat = chatsRef.current.find((item) => item.controllerId?.trim().toLowerCase() === target.conversationId) ?? null;
      const title = chat?.title.trim() ?? "";
      const toastId = `browser-prompt:${approvalId}`;
      toasts.current.set(approvalId, toastId);
      showStatus(
        waitingPromptToastText(runAgentName(target.runMetadata), title && !isDefaultConversationTitle(title) ? title : null),
        "info",
        0,
        {
          id: toastId,
          behavior: statusBehavior.actionRequired,
          nonPreemptive: true,
          actionLabel: "View",
          onAction: () => onViewRef.current({ conversationId: target.conversationId, localId: chat?.localId ?? null }),
        },
      );
    }
  }, [hideStatus, showStatus, waiting]);
  useEffect(() => {
    const shown = toasts.current;
    return () => {
      for (const toastId of shown.values()) hideStatus(toastId);
      shown.clear();
    };
  }, [hideStatus]);

  if (!userId || !projectId) return null;
  return (
    <>
      {targets.map((target) => (
        <WaitingBrowserPromptLane
          key={`${target.runId}\n${target.runtimeId}\n${target.browserPageId}`}
          projectId={projectId}
          userId={userId}
          target={target}
          browserSessionId={browserSessionId}
          onChange={report}
        />
      ))}
    </>
  );
}
