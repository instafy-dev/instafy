import type { ReactNode } from "react";
import { Button } from "./Button";
import { Text } from "./Text";

/** One footer for explicit-save settings, independent of the form's persistence API. */
export function SettingsFormActions({ saveLabel, saving, disabled, onSave, onCancel,
  cancelDisabled, hint, secondary, saveTestId, cancelTestId }: {
  saveLabel: string;
  saving?: boolean;
  disabled?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  cancelDisabled?: boolean;
  hint?: ReactNode;
  secondary?: ReactNode;
  saveTestId?: string;
  cancelTestId?: string;
}) {
  const actionClass = "min-h-11 shrink-0 sm:pointer-fine:min-h-9";
  return <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200/70 pt-3 dark:border-[color:var(--color-studio-dark-divider)]" data-testid="settings-form-actions">
    {hint ? <Text as="p" variant="caption" tone="muted" className="min-w-0 grow basis-64">{hint}</Text> : null}
    {secondary ? <div className="mr-auto">{secondary}</div> : null}
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onCancel ? <Button type="button" onPress={onCancel} isDisabled={saving || cancelDisabled}
        variant="ghost" size="sm" radius="xl" className={actionClass} data-testid={cancelTestId}>Cancel</Button> : null}
      <Button type={onSave ? "button" : "submit"} onPress={onSave} isDisabled={saving || disabled}
        variant="primary" size="sm" radius="xl" className={actionClass} data-testid={saveTestId}>
        {saving ? "Saving…" : saveLabel}
      </Button>
    </div>
  </div>;
}
