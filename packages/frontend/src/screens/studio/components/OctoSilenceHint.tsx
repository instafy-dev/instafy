import { Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";

export const OCTO_SILENCE_HINT_MESSAGE =
  "Octo read that and stayed out — mention @octo to bring it in.";

/**
 * Ephemeral, muted line near the composer explaining a witnessed skill-mode
 * decline. Never a transcript message, never persisted; the caller controls
 * visibility (auto-dismiss + one-shot flag live in useOctoSilenceHint).
 * Clicking anywhere on the line dismisses it; the labeled button is the
 * accessible dismiss control.
 */
export function OctoSilenceHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Surface
      tone="subtle"
      radius="xl"
      shadow="none"
      role="status"
      data-testid="octo-silence-hint"
      onClick={onDismiss}
      className="pointer-events-auto mx-1 flex items-center justify-between gap-2 py-1 pl-3 pr-1 sm:mx-2"
    >
      <Text as="span" variant="caption" tone="muted" className="min-w-0">{OCTO_SILENCE_HINT_MESSAGE}</Text>
      <IconButton
        type="button"
        size="sm"
        variant="ghost"
        tone="muted"
        aria-label="Dismiss hint"
        onPress={onDismiss}
        onClick={(event) => event.stopPropagation()}
        className="shrink-0"
      >
        <Xmark className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </Surface>
  );
}
