import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Lock } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import type {
  RuntimeSharedBrowserApprovalDecision,
  RuntimeSharedBrowserApprovalRequest,
} from "../../../sdk/instafy";
import { displayActivityHost } from "./activityHost";
import {
  sharedBrowserApprovalAllowDecision,
  sharedBrowserApprovalTargetAddress,
} from "./SharedBrowserApprovalPrompt";
import { isActivityHost, type BrowserApprovalOutcome, type SessionBrowserApproval } from "./turnActivity";
import type { SharedBrowserApprovalState } from "./useSharedBrowserApproval";

/**
 * How long a prompt that went away without an answer from this tab stays
 * on screen: it hides the gap of a poll or a grant change, and a prompt
 * answered on another device or a run that stopped then goes away.
 */
export const BROWSER_APPROVAL_GONE_GRACE_MS = 2_000;
/** The row says when a prompt is about to expire only in its last minute. */
export const BROWSER_APPROVAL_EXPIRY_NOTICE_MS = 60_000;
/** The page's own words in a prompt are cut to this many characters. */
const MAX_LABEL_CHARS = 40;

export const BROWSER_APPROVAL_ROW_COPY = {
  deny: "Deny",
  allow: "Allow",
  allowSite: "Allow site",
  saving: "Saving…",
  expiresSoon: "Expires in under a minute",
  announcement: (agent: string, sentence: string) => `${agent} needs your answer: ${sentence}`,
} as const;

type Phase = "pending" | BrowserApprovalOutcome;

function hostOf(origin: string | null | undefined): string | null {
  const value = origin?.trim();
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host ? host.replace(/^www\./u, "") : null;
  } catch {
    return null;
  }
}

/** A host for the activity line: only a name the line's rules accept. */
function activityHostOf(origin: string | null | undefined): string | null {
  const host = hostOf(origin);
  return isActivityHost(host) ? host : null;
}

function shownHost(origin: string | null | undefined): string | null {
  const host = hostOf(origin);
  return host ? displayActivityHost(host) : null;
}

function cut(label: string): string {
  const characters = [...label.trim()];
  return characters.length <= MAX_LABEL_CHARS ? characters.join("") : `${characters.slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

/**
 * What the agent waits to do, in one sentence: "Octo wants to send the form
 * “Search” on visitlisboa.com." The label is the runtime's already-masked
 * name of the control, the only place the page's own words appear, because
 * the person needs them to decide.
 */
export function browserApprovalSentence(agent: string, request: RuntimeSharedBrowserApprovalRequest): string {
  const destination = shownHost(request.display.destinationOrigin) ?? shownHost(request.destinationOrigin);
  const site = shownHost(request.sourceOrigin) ?? destination ?? "this site";
  const label = cut(request.display.label);
  const quoted = label ? ` “${label}”` : "";
  // The exact page a site prompt or a navigation will load, when the runtime names it.
  const page = sharedBrowserApprovalTargetAddress(request);
  switch (request.operation) {
    case "approve-origin":
      return page ? `${agent} wants to open ${page}.` : `${agent} wants to use ${destination ?? site}.`;
    case "navigate":
      return `${agent} wants to open ${page ?? destination ?? "a page"}.`;
    case "click":
      return `${agent} wants to click${quoted} on ${site}.`;
    case "type":
      return `${agent} wants to type into${quoted || " a field"} on ${site}.`;
    case "form-submit": {
      const elsewhere = destination && destination !== site ? ` It goes to ${destination}.` : "";
      return `${agent} wants to send ${label ? `the form${quoted}` : "a form"} on ${site}.${elsewhere}`;
    }
    case "press-enter":
      return `${agent} wants to press Enter on${quoted || " a control"} on ${site}.`;
    case "press-space":
      return `${agent} wants to press Space on${quoted || " a control"} on ${site}.`;
    case "press-key": {
      // The runtime names the key itself: "Press Tab on Search".
      const key = cut(request.display.label.trim().replace(/^Press /u, ""));
      return `${agent} wants to press ${key || "a key"} on ${site}.`;
    }
    default:
      return `${agent} wants to take a step${quoted} on ${site}.`;
  }
}

/** What the turn's line keeps of an answered prompt: the operation and the sites, never its label. */
function settlement(request: RuntimeSharedBrowserApprovalRequest, outcome: BrowserApprovalOutcome): SessionBrowserApproval {
  const destinationHost = activityHostOf(request.display.destinationOrigin) ?? activityHostOf(request.destinationOrigin);
  return {
    approvalId: request.approvalId,
    outcome,
    operation: request.operation,
    host: request.kind === "origin" ? destinationHost : (activityHostOf(request.sourceOrigin) ?? destinationHost),
    destinationHost,
  };
}

/**
 * A pending Instafy's browser prompt as one compact row: the lock, one
 * sentence, Deny and Allow. Once answered (here, in the browser view's sheet
 * or on another device) or left to expire, the row goes and the turn's line
 * says what happened ("you allowed a search"). It shares the sheet's approval
 * state, so one answer settles both, and it never takes focus.
 */
export function BrowserApprovalRow({
  agentDisplayName,
  approval,
  onSettled,
  frame,
}: {
  agentDisplayName: string;
  approval: SharedBrowserApprovalState;
  onSettled?: (settled: SessionBrowserApproval) => void;
  /** Wraps the row when it shows (the chat's fallback row gives it an avatar). */
  frame?: (row: ReactNode) => ReactNode;
}) {
  const agent = agentDisplayName.trim() || "Octo";
  const request = approval.pending?.request ?? null;
  const lastDecision = approval.lastDecision;
  const [shown, setShown] = useState<{ request: RuntimeSharedBrowserApprovalRequest; phase: Phase } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pressedRef = useRef<{ approvalId: string; decision: RuntimeSharedBrowserApprovalDecision } | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const sentenceId = useId();

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
    }, BROWSER_APPROVAL_GONE_GRACE_MS);
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

  // The turn's line says what happened once the row goes.
  const settledPhase = shown && shown.phase !== "pending" ? shown.phase : null;
  const settledRequest = settledPhase ? shown?.request ?? null : null;
  useEffect(() => {
    if (settledPhase && settledRequest) onSettledRef.current?.(settlement(settledRequest, settledPhase));
  }, [settledPhase, settledRequest]);

  // Said once to screen readers when the row appears, politely.
  const sentence = shown && asking ? browserApprovalSentence(agent, shown.request) : null;
  const [announced, setAnnounced] = useState<{ approvalId: string; text: string } | null>(null);
  const shownApprovalId = asking ? shown?.request.approvalId ?? null : null;
  useEffect(() => {
    if (!shownApprovalId || !sentence) return;
    setAnnounced((current) =>
      current?.approvalId === shownApprovalId
        ? current
        : { approvalId: shownApprovalId, text: BROWSER_APPROVAL_ROW_COPY.announcement(agent, sentence) },
    );
  }, [agent, sentence, shownApprovalId]);

  if (!shown || !asking || !sentence) return null;
  const shownRequest = shown.request;
  const remainingMs = shownRequest.expiresAtMs - nowMs;
  const submitting = approval.submitting;
  // Only the prompt on screen can be answered, and only while it is still the
  // one waiting: not while a newer one replaces it, nor in the grace after it
  // went away.
  const answerable = approval.pending?.request.approvalId === shownRequest.approvalId;
  const pressed = pressedRef.current?.approvalId === shownRequest.approvalId ? pressedRef.current.decision : null;
  const press = (decision: RuntimeSharedBrowserApprovalDecision) => {
    pressedRef.current = { approvalId: shownRequest.approvalId, decision };
    void approval.decide(decision, shownRequest.approvalId);
  };
  const copy = BROWSER_APPROVAL_ROW_COPY;
  const denyPending = submitting && pressed === "deny";
  const allowPending = submitting && pressed !== null && pressed !== "deny";

  const row = (
    <div
      role="group"
      aria-labelledby={sentenceId}
      data-testid="browser-approval-row"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 py-1"
    >
      <span className="flex min-w-0 basis-[min(100%,20rem)] grow items-start gap-1.5">
        <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-500 dark:text-slate-400" />
        <Text
          as="span"
          id={sentenceId}
          variant="caption"
          className="min-w-0 text-slate-700 dark:text-slate-200"
          data-testid="browser-approval-sentence"
        >
          {sentence}
        </Text>
      </span>
      <span className="flex flex-none items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          radius="full"
          onPress={() => press("deny")}
          isDisabled={!answerable || (submitting && !denyPending)}
          isPending={denyPending}
          data-testid="browser-approval-deny"
        >
          {denyPending ? copy.saving : copy.deny}
        </Button>
        <Button
          variant="primary"
          size="sm"
          radius="full"
          onPress={() => press(sharedBrowserApprovalAllowDecision(shownRequest.kind))}
          isDisabled={!answerable || (submitting && !allowPending)}
          isPending={allowPending}
          data-testid="browser-approval-allow"
        >
          {allowPending ? copy.saving : shownRequest.kind === "origin" ? copy.allowSite : copy.allow}
        </Button>
      </span>
      {remainingMs <= BROWSER_APPROVAL_EXPIRY_NOTICE_MS ? (
        <Text
          as="span"
          variant="caption"
          tone="muted"
          role="timer"
          aria-live="off"
          data-testid="browser-approval-expiry"
        >
          {copy.expiresSoon}
        </Text>
      ) : null}
      {approval.error ? (
        <Text
          as="span"
          variant="caption"
          tone="danger"
          role="alert"
          data-testid="browser-approval-error"
        >
          {approval.error}
        </Text>
      ) : null}
      <span className="sr-only" aria-live="polite" data-testid="browser-approval-announcement">
        {announced?.approvalId === shownRequest.approvalId ? announced.text : ""}
      </span>
    </div>
  );
  return frame ? <>{frame(row)}</> : row;
}
