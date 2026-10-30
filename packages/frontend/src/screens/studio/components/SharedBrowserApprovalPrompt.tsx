import { useEffect, useRef } from "react";
import { Lock } from "iconoir-react";
import { Button } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { StudioDialogBody, StudioDialogFooter } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogGutterContext } from "../../../components/aria/StudioDialogSpacing";
import {
  browserApprovalGoesTo,
  browserApprovalSentence,
  sharedBrowserApprovalTargetAddress,
} from "./browserApprovalWords";

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
 * ("Octo wants to use visitlisboa.com." [Deny] [Allow site]), which name the
 * exact site or page it is about, and where a step on the page goes ("Goes to
 * httpbin.org") when the sentence does not say. It shares the row's approval
 * state, so one answer settles both.
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
  const goesTo = browserApprovalGoesTo(request);

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
      <Surface
        aria-labelledby="shared-browser-approval-title"
        aria-modal="true"
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden"
        data-approval-origin={request.display.destinationOrigin?.trim() || request.destinationOrigin?.trim() || undefined}
        data-testid="shared-browser-approval-prompt"
        role="alertdialog"
        tone="floating"
        shadow="lg"
      >
        <StudioDialogGutterContext.Provider value="responsive">
          <StudioDialogBody scrollable className="space-y-4" data-testid="shared-browser-approval-content">
            <div className="flex items-start gap-3">
              <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <Text
                as="h2"
                id="shared-browser-approval-title"
                variant="subtitle"
                tone="primary"
                className="min-w-0 flex-1 break-words"
              >
                {sentence}
              </Text>
            </div>

            {goesTo ? (
              <Text as="p" tone="muted" className="break-words" data-testid="shared-browser-approval-destination">
                Goes to {goesTo}
              </Text>
            ) : null}

            {error ? (
              <InlineNotice
                tone="danger"
                data-testid="shared-browser-approval-error"
                role="alert"
              >
                {error}
              </InlineNotice>
            ) : null}

          </StudioDialogBody>
          <StudioDialogFooter padding="default" divider className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:justify-end">
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
          </StudioDialogFooter>
        </StudioDialogGutterContext.Provider>
      </Surface>
    </div>
  );
}
