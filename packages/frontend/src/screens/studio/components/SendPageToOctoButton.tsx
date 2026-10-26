import { ChatPlusIn } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";

export const SEND_PAGE_TO_OCTO_LABEL = "Send page to Octo";

/**
 * The same button in the Personal and Shared Browser toolbars. A press reads
 * the page on screen once and adds it to the person's next message; it gives
 * Octo no access to the browser.
 */
export function SendPageToOctoButton({
  onPress,
  pending = false,
  disabled = false,
}: {
  onPress: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <IconButton
      aria-label={SEND_PAGE_TO_OCTO_LABEL}
      aria-busy={pending || undefined}
      className="shrink-0"
      data-testid="browser-send-page"
      isDisabled={disabled || pending}
      onPress={onPress}
      size="sm"
      title={`${SEND_PAGE_TO_OCTO_LABEL}: add a copy of this page to your next message`}
      type="button"
      variant="ghost"
    >
      {pending ? (
        <Spinner aria-hidden="true" size="xs" tone="slate" />
      ) : (
        <ChatPlusIn className="h-4 w-4" aria-hidden="true" />
      )}
    </IconButton>
  );
}
