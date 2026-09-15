import { Capacitor } from "@capacitor/core";
import { NavArrowLeft, NavArrowRight } from "iconoir-react";
import { IconButton } from "../components/Button";
import { isDesktopShell } from "../lib/desktopShell";
import { useStudioHistory, type StudioHistory } from "./useStudioHistory";

export function studioHistoryControlsAvailable(): boolean {
  return isDesktopShell() || Capacitor.isNativePlatform();
}

function StudioHistoryControlsView({ className, history }: { className?: string; history: StudioHistory }) {
  const { canGoBack, canGoForward, goBack, goForward } = history;

  return (
    <div role="group" aria-label="App history" data-testid="studio-history-controls" className={`flex shrink-0 items-center gap-1 ${className ?? ""}`}>
      <IconButton aria-label="Go back" title="Go back" variant="ghost" isDisabled={!canGoBack}
        className="!h-11 !w-11 min-h-11 min-w-11 shrink-0" onPress={goBack}>
        <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
      </IconButton>
      <IconButton aria-label="Go forward" title="Go forward" variant="ghost" isDisabled={!canGoForward}
        className="!h-11 !w-11 min-h-11 min-w-11 shrink-0" onPress={goForward}>
        <NavArrowRight className="h-5 w-5" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function OwnedStudioHistoryControls({ className }: { className?: string }) {
  return <StudioHistoryControlsView className={className} history={useStudioHistory()} />;
}

/** Native shells have no browser toolbar. These controls navigate Studio, never
 * the separate Personal or Shared browser page, and do not intercept keys. */
export function StudioHistoryControls({ enabled = studioHistoryControlsAvailable(), className, history }: {
  enabled?: boolean;
  className?: string;
  /** Conditional surfaces share the layout's owner so Forward survives hiding them. */
  history?: StudioHistory;
}) {
  return enabled ? history
    ? <StudioHistoryControlsView className={className} history={history} />
    : <OwnedStudioHistoryControls className={className} /> : null;
}
