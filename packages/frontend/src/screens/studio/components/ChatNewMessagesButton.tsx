import type { RefObject } from "react";
import { ArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";

export function ChatNewMessagesButton({ onPress, hasNewMessages = true, readingRegionRef }: {
  onPress: () => void;
  hasNewMessages?: boolean;
  readingRegionRef?: RefObject<HTMLElement | null>;
}) {
  return <Button onPress={(event) => {
    // This action disappears after navigation. Keep keyboard focus in the
    // reading region, without opening the composer's software keyboard.
    if (event.target === event.target.ownerDocument.activeElement) {
      readingRegionRef?.current?.focus({ preventScroll: true });
    }
    onPress();
  }} variant="outline" preset="inline" className="pointer-events-auto"
    aria-label={hasNewMessages ? "New messages, jump to latest" : "Jump to latest"} data-testid="chat-new-messages">
    {hasNewMessages ? "New messages" : "Return to latest"}<ArrowDown aria-hidden="true" className="h-4 w-4" />
  </Button>;
}
