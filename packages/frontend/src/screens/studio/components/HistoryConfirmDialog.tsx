import { Button } from "../../../components/Button";
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
      modalClassName="p-5"
      data-testid={testId}
    >
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
      {detail ? (
        <p className="mt-2 break-words text-sm font-medium text-slate-700 dark:text-slate-200" data-testid={`${testId}-detail`}>
          {detail}
        </p>
      ) : null}
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{body}</p>
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
    </StudioDialogModal>
  );
}
