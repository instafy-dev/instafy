import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogBody } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";

/**
 * The one confirm step for History actions (Revert, Remove). The safe
 * choice is focused first; Escape and the backdrop cancel.
 */
export function HistoryConfirmDialog({
  isOpen,
  title,
  detail = null,
  body,
  cancelLabel,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
  testId,
}: {
  isOpen: boolean;
  title: string;
  /** What the action applies to (a version, an entry), named in the dialog. */
  detail?: string | null;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      isDismissable
      dialogAriaLabel={detail ? `${title} ${detail}` : title}
      gutter="responsive"
      data-testid={testId}
    >
      <StudioDialogBody>
        <Text as="h2" variant="subtitle" tone="primary">{title}</Text>
        {detail ? (
          <Text variant="bodyStrong" className="mt-2 break-words" data-testid={`${testId}-detail`}>
            {detail}
          </Text>
        ) : null}
        <Text tone="muted" className="mt-2">{body}</Text>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onPress={onCancel} autoFocus data-testid={`${testId}-cancel`}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onPress={onConfirm}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </Button>
        </div>
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
