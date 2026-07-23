import { useEffect, useRef } from "react";
import { Lock } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";

export type SharedBrowserApprovalKind = "origin" | "action";
export type SharedBrowserApprovalDecision = "allow_origin" | "allow_once" | "deny";

export type SharedBrowserApprovalPromptRequest = {
  approvalId: string;
  kind: SharedBrowserApprovalKind;
  operation: string;
  sourceOrigin: string | null;
  destinationOrigin: string | null;
  expiresAtMs: number;
  display: {
    label: string;
    destinationOrigin: string | null;
  };
};

export function sharedBrowserApprovalAllowDecision(
  kind: SharedBrowserApprovalKind,
): SharedBrowserApprovalDecision {
  return kind === "origin" ? "allow_origin" : "allow_once";
}

function actionDescription(request: SharedBrowserApprovalPromptRequest): string {
  const label = request.display.label.trim();
  const target = label ? ` “${label}”` : "";
  switch (request.operation) {
    case "navigate":
      return "navigate to the approved destination";
    case "click":
      return `click${target || " the selected item"}`;
    case "type":
      return `type into${target || " the selected field"}`;
    case "form-submit":
      return `submit the form from${target || " the selected field"}`;
    case "press-key":
      return label ? `press the requested key (${label})` : "press the requested key";
    case "press-enter":
      return `press Enter on${target || " the selected item"}`;
    case "press-space":
      return `press Space on${target || " the selected item"}`;
    default:
      return label ? `perform the requested browser action on${target}` : "perform the requested browser action";
  }
}

export function SharedBrowserApprovalPrompt({
  active = true,
  request,
  submitting,
  error,
  onDecision,
}: {
  active?: boolean;
  request: SharedBrowserApprovalPromptRequest;
  submitting: boolean;
  error?: string | null;
  onDecision: (decision: SharedBrowserApprovalDecision) => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement | null>(null);
  const allowButtonRef = useRef<HTMLButtonElement | null>(null);
  const isOriginApproval = request.kind === "origin";
  const destination =
    request.display.destinationOrigin?.trim() || request.destinationOrigin?.trim() || null;

  useEffect(() => {
    if (active) {
      denyButtonRef.current?.focus();
    }
  }, [active, request.approvalId]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-end justify-center overflow-y-auto bg-slate-950/60 p-2 backdrop-blur-[2px] sm:items-center sm:p-4"
      data-browser-session-safe-zone="true"
      data-testid="shared-browser-approval-scrim"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) {
          event.preventDefault();
          event.stopPropagation();
          onDecision("deny");
        } else if (event.key === "Tab") {
          const movingBackward = event.shiftKey;
          const target = event.target;
          if (
            (movingBackward && target === denyButtonRef.current) ||
            (!movingBackward && target === allowButtonRef.current)
          ) {
            event.preventDefault();
            (movingBackward ? allowButtonRef : denyButtonRef).current?.focus();
          }
        }
      }}
    >
      <section
        aria-describedby="shared-browser-approval-description"
        aria-labelledby="shared-browser-approval-title"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:p-5"
        data-testid="shared-browser-approval-prompt"
        role="alertdialog"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
            <Lock aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <Text as="h2" id="shared-browser-approval-title" variant="bodyStrong" tone="primary">
              {isOriginApproval
                ? "Allow the AI agent to use this site?"
                : "Allow this browser action?"}
            </Text>
            <Text
              as="p"
              id="shared-browser-approval-description"
              variant="body"
              tone="secondary"
              className="leading-snug"
            >
              {isOriginApproval
                ? "Shared Browser is paused before the AI agent can read or act on a new site."
                : `The AI agent is waiting to ${actionDescription(request)}.`}
            </Text>
          </div>
        </div>

        {destination ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-950/70">
            <Text as="p" variant="caption" tone="muted">
              {isOriginApproval ? "Site" : "Destination"}
            </Text>
            <p
              className="mt-0.5 break-all font-mono text-xs font-medium text-slate-800 dark:text-slate-100"
              data-testid="shared-browser-approval-destination"
            >
              {destination}
            </p>
          </div>
        ) : null}

        <Text as="p" variant="caption" tone="muted" className="mt-3 leading-snug">
          {isOriginApproval
            ? "Allow applies to this site for the current AI turn. You will still approve actions separately."
            : "This approval is used once. Only you can approve it, and it expires automatically."}
        </Text>

        {error ? (
          <p
            className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-200"
            data-testid="shared-browser-approval-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-2 min-[420px]:flex-row min-[420px]:justify-end">
          <Button
            ref={denyButtonRef}
            data-testid="shared-browser-approval-deny"
            fullWidth
            isDisabled={submitting}
            onPress={() => onDecision("deny")}
            radius="full"
            size="sm"
            variant="secondary"
            className="min-[420px]:w-auto"
          >
            {submitting ? "Saving…" : "Deny"}
          </Button>
          <Button
            ref={allowButtonRef}
            data-testid="shared-browser-approval-allow"
            fullWidth
            isDisabled={submitting}
            onPress={() => onDecision(sharedBrowserApprovalAllowDecision(request.kind))}
            radius="full"
            size="sm"
            variant="primary"
            className="min-[420px]:w-auto"
          >
            {isOriginApproval ? "Allow site" : "Allow once"}
          </Button>
        </div>
      </section>
    </div>
  );
}
