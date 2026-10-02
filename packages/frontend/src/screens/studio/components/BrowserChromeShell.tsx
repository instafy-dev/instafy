import { createContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pause, Play, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";

export type BrowserChromeState = "ready" | "starting" | "paused" | "unavailable";

export const BrowserAddressMenuAnchorContext = createContext<{
  ref: RefObject<HTMLDivElement | null>;
  width: number;
} | null>(null);

const browserChromeStateLabel: Record<BrowserChromeState, string> = {
  ready: "Ready",
  starting: "Starting…",
  paused: "Paused",
  unavailable: "Unavailable",
};

export function BrowserStatusPill({
  state,
  detail,
  testId,
  compact = false,
  resume,
}: {
  state: BrowserChromeState;
  detail?: string | null;
  testId?: string;
  compact?: boolean;
  resume?: { onPress: () => void; disabled?: boolean };
}) {
  const label = browserChromeStateLabel[state];
  if (state === "ready") {
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
  const toneClassName =
    state === "unavailable"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      : "border-slate-300/80 bg-slate-100/80 text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300";

  if (state === "paused" && resume) {
    return (
      <Button
        type="button"
        aria-label="Resume agent control"
        variant="secondary"
        radius="full"
        size="xs"
        className="h-8 shrink-0 max-[540px]:min-h-10"
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
    <span
      aria-label={detail ? `${label}: ${detail}` : label}
      aria-live="polite"
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border text-xxs font-medium ${compact ? "px-1.5" : "px-2"} ${toneClassName}`}
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
    </span>
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
  testId?: string;
}) {
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
    <div className="w-full min-w-0 shrink-0" data-browser-session-safe-zone="true">
      <div
        ref={toolbarRef}
        aria-busy={busy || undefined}
        aria-label={label}
        className={`flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-hidden border-b border-slate-200 bg-slate-50 px-2 max-[400px]:px-1 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel-soft)] ${compact ? "h-12 pointer-coarse:h-13" : "h-11 max-[540px]:h-auto max-[540px]:flex-wrap max-[400px]:gap-0.5"}`}
        data-testid={testId}
        data-browser-session-safe-zone="true"
        role="toolbar"
      >
        {leading ? <div className="flex shrink-0 items-center">{leading}</div> : null}
        <div className="flex shrink-0 items-center">{navigation}</div>
        <div className={`min-w-0 flex-1 ${compact ? "" : "max-[540px]:basis-24"}`}>{address}</div>
        {status || actions ? (
          <div
            className={`flex shrink-0 items-center gap-1 ${compact ? "" : "max-[540px]:order-last max-[540px]:min-h-10 max-[540px]:w-full max-[540px]:basis-full max-[540px]:justify-between max-[540px]:border-t max-[540px]:border-slate-200/80 dark:max-[540px]:border-[color:var(--color-studio-dark-divider)]"}`}
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
              <div className={`flex min-w-0 shrink-0 items-center max-[540px]:flex-1 max-[540px]:justify-end max-[540px]:overflow-hidden ${compact ? "gap-1" : "gap-0.5"}`}>
                {actions}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {feedback ? (
        <div
          className={`flex min-h-8 items-center gap-2 border-b px-3 py-1 text-xs ${
            feedbackTone === "error"
            ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
          }`}
          data-testid={feedbackTestId}
          id={feedbackId}
          role={feedbackTone === "error" ? "alert" : "status"}
        >
          <span className="min-w-0 flex-1 break-words">{feedback}</span>
          {onDismissFeedback ? (
            <IconButton
              aria-label="Dismiss browser message"
              size="xs"
              radius="full"
              variant="ghost"
              className="shrink-0 max-[540px]:h-10 max-[540px]:w-10"
              onPress={onDismissFeedback}
              title="Dismiss"
              type="button"
            >
              <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
    </BrowserAddressMenuAnchorContext.Provider>
  );
}
