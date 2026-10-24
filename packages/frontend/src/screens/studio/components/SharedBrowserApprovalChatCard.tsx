import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "../../../components/Badge";
import { Text } from "../../../components/Text";
import type {
  RuntimeSharedBrowserApprovalDecision,
  RuntimeSharedBrowserApprovalRequest,
} from "../../../sdk/instafy";
import { ChatActionCard } from "./ChatActionCard";
import { ChatBubbleRow } from "./ChatBubbleRow";
import {
  sharedBrowserApprovalActionDescription,
  sharedBrowserApprovalAllowDecision,
} from "./SharedBrowserApprovalPrompt";
import type { SharedBrowserApprovalState } from "./useSharedBrowserApproval";

/**
 * How long a prompt that went away without an answer from this tab stays
 * on screen: it hides the gap of a poll or a grant change, and a prompt
 * answered on another device or a run that stopped then goes away.
 */
export const SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS = 2_000;

export const SHARED_BROWSER_APPROVAL_CHAT_COPY = {
  overline: "Instafy's browser",
  actionTitle: "Allow this browser action?",
  originTitle: (agent: string) => `Allow ${agent} to use this site?`,
  onlyYou: "Only you can answer.",
  expiresIn: (clock: string) => `Expires in ${clock}.`,
  deny: "Deny",
  allowOnce: "Allow once",
  allowSite: "Allow site",
  saving: "Saving…",
  allowed: "Allowed",
  denied: "Denied",
  expired: "Expired",
  allowedNote: (agent: string) => `${agent} is continuing.`,
  deniedNote: (agent: string) => `${agent} won't take this step.`,
  expiredNote: (agent: string) => `${agent} didn't take this step. Send a message to continue.`,
} as const;

type Phase = "pending" | "allowed" | "denied" | "expired";

function hostOf(origin: string | null | undefined): string | null {
  const value = origin?.trim();
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function clock(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function describe(agent: string, request: RuntimeSharedBrowserApprovalRequest): string {
  const destination = hostOf(request.display.destinationOrigin) ?? hostOf(request.destinationOrigin);
  if (request.kind === "origin") {
    return `${agent} paused before reading or acting on ${destination ?? "a new site"}.`;
  }
  if (request.operation === "navigate" && destination) {
    return `${agent} is waiting to open ${destination}.`;
  }
  const site = hostOf(request.sourceOrigin) ?? destination;
  return `${agent} is waiting to ${sharedBrowserApprovalActionDescription(request)}${site ? ` on ${site}` : ""}.`;
}

/**
 * A pending Instafy's browser prompt as a chat card, for the person who
 * started the run: the same prompt and decision as the browser view's sheet,
 * answerable while the view reconnects, failed, is hidden or another tab is
 * shown. It shares the sheet's approval state, so one answer settles both.
 * It never takes focus.
 */
export function SharedBrowserApprovalChatCard({
  agentDisplayName,
  approval,
  avatar,
}: {
  agentDisplayName: string;
  approval: SharedBrowserApprovalState;
  avatar: ReactNode;
}) {
  const agent = agentDisplayName.trim() || "Octo";
  const request = approval.pending?.request ?? null;
  const lastDecision = approval.lastDecision;
  const [shown, setShown] = useState<{ request: RuntimeSharedBrowserApprovalRequest; phase: Phase } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pressedRef = useRef<{ approvalId: string; decision: RuntimeSharedBrowserApprovalDecision } | null>(null);

  useEffect(() => {
    if (!request) return;
    // The same prompt again (every poll, or after a gap) keeps its phase.
    setShown((current) => (current?.request.approvalId === request.approvalId ? current : { request, phase: "pending" }));
  }, [request]);

  useEffect(() => {
    if (request || !shown || shown.phase !== "pending") return;
    const approvalId = shown.request.approvalId;
    if (lastDecision?.approvalId === approvalId) {
      setShown({ request: shown.request, phase: lastDecision.decision === "deny" ? "denied" : "allowed" });
      return;
    }
    if (Date.now() >= shown.request.expiresAtMs) {
      setShown({ request: shown.request, phase: "expired" });
      return;
    }
    const timer = window.setTimeout(() => {
      setShown((current) => (current?.request.approvalId === approvalId && current.phase === "pending" ? null : current));
    }, SHARED_BROWSER_APPROVAL_CHAT_GONE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [lastDecision, request, shown]);

  const asking = shown?.phase === "pending";
  const expiresAtMs = shown?.request.expiresAtMs ?? null;
  useEffect(() => {
    if (!asking || expiresAtMs === null) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [asking, expiresAtMs]);
  useEffect(() => {
    if (asking && expiresAtMs !== null && nowMs >= expiresAtMs) {
      setShown((current) => (current && current.phase === "pending" ? { request: current.request, phase: "expired" } : current));
    }
  }, [asking, expiresAtMs, nowMs]);

  if (!shown) return null;
  const shownRequest = shown.request;
  const isOrigin = shownRequest.kind === "origin";
  const lifetimeMs = Math.max(0, shownRequest.expiresAtMs - shownRequest.requestedAtMs);
  const remainingMs = Math.min(lifetimeMs, shownRequest.expiresAtMs - nowMs);
  const submitting = asking && approval.submitting;
  // Only the prompt on screen can be answered, and only while it is still the
  // one waiting: not while a newer one replaces it, nor in the grace after it
  // went away.
  const answerable = approval.pending?.request.approvalId === shownRequest.approvalId;
  const pressed = pressedRef.current?.approvalId === shownRequest.approvalId ? pressedRef.current.decision : null;
  const press = (decision: RuntimeSharedBrowserApprovalDecision) => {
    pressedRef.current = { approvalId: shownRequest.approvalId, decision };
    void approval.decide(decision, shownRequest.approvalId);
  };
  const copy = SHARED_BROWSER_APPROVAL_CHAT_COPY;

  return (
    <ChatBubbleRow align="left" avatar={avatar} testId="chat-browser-approval-row">
      <ChatActionCard
        testId="chat-browser-approval-card"
        overline={copy.overline}
        title={isOrigin ? copy.originTitle(agent) : copy.actionTitle}
        description={describe(agent, shownRequest)}
        actions={asking ? [
          {
            id: "deny",
            label: copy.deny,
            variant: "outline",
            onPress: () => press("deny"),
            isDisabled: submitting || !answerable,
            isLoading: submitting && pressed === "deny",
            loadingLabel: copy.saving,
            testId: "chat-browser-approval-deny",
          },
          {
            id: "allow",
            label: isOrigin ? copy.allowSite : copy.allowOnce,
            variant: "primary",
            onPress: () => press(sharedBrowserApprovalAllowDecision(shownRequest.kind)),
            isDisabled: submitting || !answerable,
            isLoading: submitting && pressed !== null && pressed !== "deny",
            loadingLabel: copy.saving,
            testId: "chat-browser-approval-allow",
          },
        ] : []}
      >
        {asking ? (
          <div className="space-y-1">
            <Text
              as="div"
              variant="caption"
              tone="muted"
              role="timer"
              aria-live="off"
              data-testid="chat-browser-approval-countdown"
            >
              {copy.onlyYou} {copy.expiresIn(clock(remainingMs))}
            </Text>
            {approval.error ? (
              <Text as="div" variant="caption" tone="danger" role="alert" data-testid="chat-browser-approval-error">
                {approval.error}
              </Text>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2" role="status" data-testid="chat-browser-approval-state">
            <Badge tone={shown.phase === "allowed" ? "success" : shown.phase === "expired" ? "warning" : "neutral"}>
              {shown.phase === "allowed" ? copy.allowed : shown.phase === "denied" ? copy.denied : copy.expired}
            </Badge>
            <Text as="span" variant="caption" tone="muted">
              {shown.phase === "allowed"
                ? copy.allowedNote(agent)
                : shown.phase === "denied"
                  ? copy.deniedNote(agent)
                  : copy.expiredNote(agent)}
            </Text>
          </div>
        )}
      </ChatActionCard>
    </ChatBubbleRow>
  );
}
