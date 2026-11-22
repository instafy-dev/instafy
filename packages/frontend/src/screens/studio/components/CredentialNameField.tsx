import { useEffect, useId, useRef } from "react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { clampCredentialLabel } from "../../../utils/credentialLabelRules";

type CredentialNameFieldProps = {
  /** The name the connection goes by now, which labels the field. */
  name: string;
  draft: string;
  /** Why the last save was refused, in plain words, or null. */
  error: string | null;
  pending: boolean;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
  "data-testid": string;
};

/**
 * A saved connection's name as a text field, which Rename puts in place of the
 * name. It takes focus with the name selected; Enter saves and Escape cancels,
 * since Desktop has no `window.prompt`, except while an input method is
 * composing, whose Enter and Escape are its own. The field holds at most the
 * 60 characters the controller saves, counted as code points as it counts
 * them, so 60 emoji fit. A refusal shows under the field and is read with it.
 */
export function CredentialNameField({
  name,
  draft,
  error,
  pending,
  onDraftChange,
  onSave,
  onCancel,
  "data-testid": testId,
}: CredentialNameFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();

  // A frame later, after a menu that opened the field has put focus back.
  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return (
    <span className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => {
            // Cut only once a composition ends: cutting text an input method
            // is still composing breaks the composition.
            const composing = (event.nativeEvent as InputEvent).isComposing === true;
            onDraftChange(composing ? event.target.value : clampCredentialLabel(event.target.value));
          }}
          onCompositionEnd={(event) => onDraftChange(clampCredentialLabel(event.currentTarget.value))}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              // The input method's own Enter or Escape, which must not reach a
              // dialog or page around the field either.
              if (event.key === "Escape") {
                event.stopPropagation();
              }
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              onSave();
            } else if (event.key === "Escape") {
              // Only the field closes, not a dialog or page around it, and not
              // while a save is on its way, as Cancel waits too.
              event.preventDefault();
              event.stopPropagation();
              if (!pending) {
                onCancel();
              }
            }
          }}
          // Read-only rather than disabled while saving, so focus stays here.
          readOnly={pending}
          aria-label={`New name for ${name}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          size="sm"
          radius="xl"
          fullWidth={false}
          className="min-w-0 flex-1 basis-40 font-normal"
          data-testid={`${testId}-input`}
        />
        <span className="flex shrink-0 items-center gap-1">
          <Button
            onPress={onSave}
            isPending={pending}
            variant="primary"
            preset="inline"
            data-testid={`${testId}-save`}
          >
            Save
          </Button>
          <Button
            onPress={onCancel}
            isDisabled={pending}
            variant="ghost"
            preset="inline"
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </Button>
        </span>
      </span>
      {error ? (
        <Text
          as="span"
          id={errorId}
          role="alert"
          variant="caption"
          tone="danger"
          className="block whitespace-normal break-words font-normal"
        >
          {error}
        </Text>
      ) : null}
    </span>
  );
}
