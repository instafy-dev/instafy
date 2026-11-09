import { createContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pause, Play, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
import { Spinner } from "../../../components/Spinner";
import { useToastClearanceRef } from "../../../status/toastClearance";
import { DARK_DIVIDER_BORDER_CLASS, DARK_PANEL_SOFT_BG_CLASS } from "../../../theme/darkSurfaces";
import { BrowserStateBadge } from "./BrowserStateBadge";

/** `off` is neutral: Instafy's browser is not running. `unavailable` is for the Personal Browser and the site preview. */
export type BrowserChromeState = "ready" | "starting" | "waiting" | "paused" | "off" | "unavailable";

export const BrowserAddressMenuAnchorContext = createContext<{
  ref: RefObject<HTMLDivElement | null>;
  width: number;
} | null>(null);

export const BROWSER_CHROME_STATE_LABELS: Record<BrowserChromeState, string> = {
  ready: "Ready",
  starting: "Starting…",
  // A pause waits for the person viewing, as the reading row says of a prompt.
  waiting: "Waiting for you",
  paused: "Paused",
  off: "Off",
  unavailable: "Unavailable",
};

export function BrowserStatusPill({
  state,
  detail,
  testId,
  compact = false,
  resume,
  startingShownInView = false,
}: {
  state: BrowserChromeState;
  detail?: string | null;
  testId?: string;
  compact?: boolean;
  resume?: { onPress: () => void; disabled?: boolean };
  /**
   * The view says it is starting itself (a centered "Opening Instafy's
   * browser…"), so `starting` only tells a screen reader, as `ready` does:
   * one loading signal on screen, not two.
   */
  startingShownInView?: boolean;
}) {
  const label = BROWSER_CHROME_STATE_LABELS[state];
  if (state === "ready" || (state === "starting" && startingShownInView)) {
    return (
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-label={detail ? `${label}: ${detail}` : label}
        data-testid={testId}
      >
        {label}
      </span>
    );
  }
  if (state === "paused" && resume) {
    return (
      <Button
        type="button"
        aria-label="Resume agent control"
        variant="secondary"
        preset="toolbarLabel"
        className="shrink-0"
        data-testid={testId}
        isDisabled={resume.disabled}
        onPress={resume.onPress}
        title={`${detail ?? label} Resume agent control.`}
      >
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Resume</span>
      </Button>
    );
  }

  return (
    <BrowserStateBadge
      tone={state === "unavailable" ? "danger" : "neutral"}
      compact={compact}
      aria-label={detail ? `${label}: ${detail}` : label}
      aria-live="polite"
      data-testid={testId}
      role="status"
      title={detail ?? label}
    >
      {state === "starting" ? <Spinner aria-hidden="true" tone="slate" size="xs" /> : null}
      {state === "paused" ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {state === "unavailable" ? (
        <span
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current/50"
          aria-hidden="true"
        >
          <Xmark className="h-3 w-3" aria-hidden="true" />
        </span>
      ) : null}
      {compact ? <span className="sr-only">{label}</span> : <span>{label}</span>}
    </BrowserStateBadge>
  );
}

export function BrowserChromeShell({
  label,
  leading,
  navigation,
  address,
  status,
  actions,
  feedback,
  feedbackId,
  feedbackTestId,
  feedbackTone = "error",
  onDismissFeedback,
  busy = false,
  compact = false,
  clearsToasts = true,
  testId,
}: {
  label: string;
  leading?: ReactNode;
  navigation: ReactNode;
  address: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  feedback?: string | null;
  feedbackId?: string;
  feedbackTestId?: string;
  feedbackTone?: "error" | "success";
  onDismissFeedback?: (() => void) | null;
  busy?: boolean;
  compact?: boolean;
  /**
   * Toasts start below this bar and its message while it is on screen, as
   * they do below Chat | Browser, so a toast never covers the address. Off
   * for a bar that is not a view's top bar.
   */
  clearsToasts?: boolean;
  testId?: string;
}) {
  const toastClearance = useToastClearanceRef<HTMLDivElement>(clearsToasts);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!compact || !toolbar) return;
    const updateWidth = () => setToolbarWidth(toolbar.getBoundingClientRect().width);
    updateWidth();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(toolbar);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, [compact]);

  return (
    <BrowserAddressMenuAnchorContext.Provider value={compact ? { ref: toolbarRef, width: toolbarWidth } : null}>
    <div ref={toastClearance} className="w-full min-w-0 shrink-0" data-browser-session-safe-zone="true">
      <div
        ref={toolbarRef}
        aria-busy={busy || undefined}
        aria-label={label}
        className={`flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-hidden border-b border-slate-200 bg-slate-50 px-2 max-[400px]:px-1 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_SOFT_BG_CLASS} ${compact ? "min-h-12 py-1" : "h-11 max-[540px]:h-auto max-[540px]:flex-wrap max-[540px]:py-1 max-[400px]:gap-0.5"}`}
        data-testid={testId}
        data-browser-session-safe-zone="true"
        role="toolbar"
      >
        {leading ? <div className="flex shrink-0 items-center">{leading}</div> : null}
        {navigation ? <div className="flex shrink-0 items-center">{navigation}</div> : null}
        <div className={`min-w-0 flex-1 ${compact ? "" : "max-[540px]:basis-24"}`}>{address}</div>
        {status || actions ? (
          <div
            className={`flex shrink-0 items-center gap-2 ${compact ? "" : "max-[540px]:order-last max-[540px]:min-h-10 max-[540px]:w-full max-[540px]:basis-full max-[540px]:justify-between"}`}
            data-testid="browser-chrome-context-row"
          >
            {status ? (
              <div
                className={compact ? "contents" : "flex shrink-0 items-center"}
                data-testid="browser-chrome-status-slot"
              >
                {status}
              </div>
            ) : null}
            {actions ? (
              <div className="flex min-w-0 shrink-0 items-center gap-2 max-[540px]:flex-1 max-[540px]:justify-end">
                {actions}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {feedback ? (
        <InlineNotice
          appearance="bar"
          tone={feedbackTone === "error" ? "danger" : "success"}
          data-testid={feedbackTestId}
          id={feedbackId}
          role={feedbackTone === "error" ? "alert" : "status"}
          dismiss={onDismissFeedback ? (
            <IconButton
              aria-label="Dismiss browser message"
              size="xs"
              variant="ghost"
              className="shrink-0"
              onPress={onDismissFeedback}
              title="Dismiss"
              type="button"
            >
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : null}
        >
          {feedback}
        </InlineNotice>
      ) : null}
    </div>
    </BrowserAddressMenuAnchorContext.Provider>
  );
}
