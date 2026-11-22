import type { ReactNode } from "react";
import { Globe } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ChatBubbleRow } from "./ChatBubbleRow";
import type { OpenBrowserPause } from "./useShowBrowserOnRequest";

export const BROWSER_PAUSE_OPEN_LABEL = "Open Instafy's browser";

/**
 * The way back to a pause in Instafy's browser that still waits for the
 * person (openBrowserPause), at the end of the chat while the Browser view is
 * not on screen: after a reload, on another device, once the browser's own
 * request ran out, or with the view closed. Octo's reply above it says what
 * to do on the page. The press only brings the browser forward and sends Octo
 * nothing: the person finishes there and lets Octo continue from the Browser
 * view.
 */
export function BrowserPauseRow({
  pause,
  browserVisible,
  avatar,
  onOpen,
}: {
  pause: OpenBrowserPause | null;
  browserVisible: boolean;
  avatar: ReactNode;
  onOpen: () => void;
}) {
  if (!pause || browserVisible) return null;
  return (
    <ChatBubbleRow align="left" avatar={avatar} testId="browser-pause-row">
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-1">
        <Button
          variant="outline"
          size="sm"
          radius="full"
          onPress={onOpen}
          data-testid="browser-pause-open"
        >
          <Globe className="h-3.5 w-3.5" aria-hidden="true" />
          {BROWSER_PAUSE_OPEN_LABEL}
        </Button>
      </div>
    </ChatBubbleRow>
  );
}
