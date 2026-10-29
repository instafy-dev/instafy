import { Button } from "../../../components/Button";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { BrowserUnavailableNotice } from "./BrowserUnavailableNotice";
import type { HostedBrowserViewState } from "./hostedBrowserViewState";

export type BrowserSessionRecoveryProps = {
  viewState: HostedBrowserViewState;
  reason: string | null;
  runtimeLimit?: {
    summary: string;
    blockerProjectCopy?: string | null;
    busy: boolean;
    onTakeOver?: () => void;
  };
  onRetry: () => void;
  onHide?: () => void;
  presentation?: "overlay" | "compact";
};

/** Presentation only: the browser owner decides when to show this and what a retry may do. */
export function BrowserSessionRecovery({
  viewState,
  reason,
  runtimeLimit,
  onRetry,
  onHide,
  presentation = "overlay",
}: BrowserSessionRecoveryProps) {
  const compact = presentation === "compact";
  const card = (
    <Surface
      tone="default"
      radius="2xl"
      shadow={compact ? "none" : "sm"}
      className={compact
        ? "relative min-w-0 w-full p-3"
        : "pointer-events-auto max-h-full min-w-0 w-full max-w-md overflow-y-auto p-4"}
      data-testid={compact ? "browser-session-collapsed-card" : runtimeLimit ? "browser-runtime-limit-card" : "browser-session-state-card"}
    >
      {runtimeLimit ? (
        <div className="min-w-0 space-y-3" data-testid="browser-runtime-limit-notice">
          <Text variant="bodyStrong" tone="primary">Cloud runtime already in use</Text>
          <Text variant="bodyCompact" tone="secondary" className="[overflow-wrap:anywhere]">{runtimeLimit.summary}</Text>
          {runtimeLimit.blockerProjectCopy ? (
            <Text variant="bodyCompact" tone="secondary" className="[overflow-wrap:anywhere]">{runtimeLimit.blockerProjectCopy}</Text>
          ) : null}
          <Text variant="caption" tone="muted">
            {runtimeLimit.onTakeOver
              ? "Stop it to free the slot and open Shared Browser here. This can interrupt work running there."
              : "Stop another cloud runtime, then try again."}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            {runtimeLimit.onTakeOver ? (
              <Button preset="inline" variant="primary" onPress={runtimeLimit.onTakeOver}
                isDisabled={runtimeLimit.busy} data-testid="browser-runtime-limit-takeover">
                {runtimeLimit.busy ? "Opening here..." : "Stop and open here"}
              </Button>
            ) : null}
            <Button preset="inline" variant="secondary" onPress={onRetry}
              isDisabled={runtimeLimit.busy} data-testid="browser-runtime-limit-retry">
              Try again
            </Button>
          </div>
        </div>
      ) : reason ? (
        <div className="min-w-0 space-y-3" data-testid="browser-session-error-notice" data-view-state={viewState.kind}>
          <BrowserUnavailableNotice sentence={viewState.sentence ?? ""} reason={reason} />
          {viewState.action || (compact && onHide) ? (
            <div className="flex flex-wrap items-center gap-2">
              {viewState.action ? (
                <Button preset="inline" variant="secondary" onPress={onRetry} data-testid="browser-session-error-retry">
                  {viewState.action}
                </Button>
              ) : null}
              {compact && onHide ? <Button preset="inline" variant="ghost" onPress={onHide}>Hide</Button> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <LoadingStatus className="min-w-0" data-testid="browser-session-loading-notice" data-view-state={viewState.kind}>
          <span data-testid="browser-session-view-sentence">{viewState.sentence}</span>
        </LoadingStatus>
      )}
    </Surface>
  );
  if (compact) return card;
  return (
    <div
      className={[
        "pointer-events-none absolute inset-0 flex min-h-0 items-center justify-center p-4 sm:p-6",
        runtimeLimit ? "bg-slate-950/15 backdrop-blur-[1px]" : "",
      ].join(" ")}
      data-testid={runtimeLimit ? "browser-runtime-limit-scrim" : undefined}
    >
      {card}
    </div>
  );
}

/** Stays over the retained page while its owner reconnects the existing transport. */
export function BrowserSessionReconnecting() {
  return (
    <Surface tone="default" radius="xl" shadow="sm"
      className="pointer-events-none absolute right-3 top-3 max-w-[calc(100%-1.5rem)] px-3 py-2"
      data-testid="browser-session-reconnecting">
      <LoadingStatus>Reconnecting…</LoadingStatus>
    </Surface>
  );
}

/**
 * Over the blank tab a chat's browser turn starts on, until its first page:
 * where Octo is going ("Octo is opening visitlisboa.com…"), so the view is
 * never a blank page with nothing said.
 */
export function BrowserSessionArrival({ note }: { note: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4"
      data-testid="browser-session-agent-arrival"
    >
      <Surface tone="default" radius="xl" shadow="sm" className="max-w-full px-3 py-2">
        <LoadingStatus>{note}</LoadingStatus>
      </Surface>
    </div>
  );
}
