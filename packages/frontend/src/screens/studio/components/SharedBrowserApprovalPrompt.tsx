import { useEffect, useRef } from "react";
import { Lock } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { browserApprovalSentence, sharedBrowserApprovalTargetAddress } from "./browserApprovalWords";

export type SharedBrowserApprovalKind = "origin" | "action";
export type SharedBrowserApprovalDecision = "allow_origin" | "allow_once" | "allow_routine" | "deny";

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

export { sharedBrowserApprovalTargetAddress };

/**
 * The browser view's sheet for a pending prompt, in the chat row's own words
 * ("Octo wants to use visitlisboa.com." [Deny] [Allow site]). It shares the
 * row's approval state, so one answer settles both.
 */
export function SharedBrowserApprovalPrompt({
  active = true,
  agentName = "Octo",
  request,
  submitting,
  error,
  onDecision,
}: {
  active?: boolean;
  /** Who asks: the agent holding the browser. */
  agentName?: string;
  request: SharedBrowserApprovalPromptRequest;
  submitting: boolean;
  error?: string | null;
  onDecision: (decision: SharedBrowserApprovalDecision) => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement | null>(null);
  const isOriginApproval = request.kind === "origin";
  const sentence = browserApprovalSentence(agentName.trim() || "Octo", request);
  // The exact site or page the answer is about, as the runtime names it.
  const targetAddress = sharedBrowserApprovalTargetAddress(request);
  const destination =
    targetAddress || request.display.destinationOrigin?.trim() || request.destinationOrigin?.trim() || null;

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
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled])",
          ));
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        aria-labelledby="shared-browser-approval-title"
        aria-modal="true"
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:p-5"
        data-testid="shared-browser-approval-prompt"
        role="alertdialog"
      >
        <div className="min-h-0 overflow-y-auto" data-testid="shared-browser-approval-content">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
              <Lock aria-hidden="true" className="h-4 w-4" />
            </div>
            <Text
              as="h2"
              id="shared-browser-approval-title"
              variant="bodyStrong"
              tone="primary"
              className="min-w-0 flex-1 break-words pt-1.5 leading-snug"
            >
              {sentence}
            </Text>
          </div>
          {destination ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-950/70">
              <Text as="p" variant="caption" tone="muted">
                {targetAddress ? "Page" : isOriginApproval ? "Site" : "Destination"}
              </Text>
              <p
                className="mt-0.5 break-all font-mono text-xs font-medium text-slate-800 dark:text-slate-100"
                data-testid="shared-browser-approval-destination"
              >
                {destination}
              </p>
            </div>
          ) : null}
          {error ? (
            <p
              className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-200"
              data-testid="shared-browser-approval-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex shrink-0 flex-col gap-2 min-[420px]:flex-row min-[420px]:justify-end">
          <Button
            ref={denyButtonRef}
            data-testid="shared-browser-approval-deny"
            fullWidth
            isDisabled={submitting}
            onPress={() => onDecision("deny")}
            preset="form"
            variant="secondary"
            className="min-[420px]:w-auto"
          >
            {submitting ? "Saving…" : "Deny"}
          </Button>
          <Button
            data-testid="shared-browser-approval-allow"
            fullWidth
            isDisabled={submitting}
            onPress={() => onDecision(sharedBrowserApprovalAllowDecision(request.kind))}
            preset="form"
            variant="primary"
            className="min-[420px]:w-auto"
          >
            {isOriginApproval ? "Allow site" : "Allow"}
          </Button>
        </div>
      </section>
    </div>
  );
}
