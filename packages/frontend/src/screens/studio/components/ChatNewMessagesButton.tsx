import { ArrowDown } from "iconoir-react";
import { Button } from "../../../components/Button";

export function ChatNewMessagesButton({ onPress }: { onPress: () => void }) {
  return <Button onPress={onPress} variant="outline" size="sm" radius="full"
    className="pointer-events-auto min-h-11 bg-white px-4 shadow-sm dark:bg-[var(--color-studio-dark-panel)]"
    aria-label="New messages, jump to latest" data-testid="chat-new-messages">
    New messages<ArrowDown aria-hidden="true" className="h-4 w-4" />
  </Button>;
}
