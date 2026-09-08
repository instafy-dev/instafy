import { useEffect, useState } from "react";
import type { RuntimeBrowserSessionAction } from "../../../sdk/instafy";

// How long the latest action stays captioned before the ticker fades out when
// the agent goes quiet.
const ACTION_TICKER_IDLE_MS = 6000;

const TYPE_DOT: Record<RuntimeBrowserSessionAction["type"], string> = {
  navigate: "bg-sky-400",
  nav_result: "bg-sky-400",
  click: "bg-emerald-400",
  type: "bg-violet-400",
  scroll: "bg-slate-400",
  human_input: "bg-amber-400",
};

function actionCaption(action: RuntimeBrowserSessionAction): string {
  const label = action.label.trim();
  if (label.length > 0) {
    return label;
  }
  switch (action.type) {
    case "navigate":
      return action.url ? `Opening ${hostOf(action.url)}` : "Navigating";
    case "nav_result":
      return action.url ? `Opened ${hostOf(action.url)}` : "Loaded page";
    case "click":
      return "Clicked";
    case "type":
      return "Typing";
    case "scroll":
      return "Scrolling";
    case "human_input":
      return "Waiting for your input";
    default:
      return "Working";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A calm caption of the agent's most recent browser action, overlaid on the
 * live view so the user can follow what it's doing without reading the raw VNC
 * frames. Idle actions fade out; the newest replaces the previous.
 */
export function ActionTicker({ actions }: { actions: RuntimeBrowserSessionAction[] }) {
  const latest = actions.length > 0 ? actions[actions.length - 1] : null;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!latest) {
      setVisible(false);
      return;
    }
    // `latest` is stable between polls (the buffer state only changes when new
    // events arrive), so this re-arms exactly once per new action.
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), ACTION_TICKER_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [latest]);

  if (!latest) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-2"
      data-testid="browser-action-ticker"
      aria-live="polite"
    >
      <div
        className={[
          "flex max-w-[92%] items-center gap-2 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1 text-xxs font-medium text-slate-100 shadow-sm backdrop-blur-sm transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0",
        ].join(" ")}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TYPE_DOT[latest.type]}`} aria-hidden="true" />
        <span className="truncate">{actionCaption(latest)}</span>
      </div>
    </div>
  );
}
