import type { ReactNode, Ref } from "react";
import { NavArrowLeft } from "iconoir-react";
import { useVisualViewportBounds } from "../../hooks/useVisualViewportBounds";
import { useNativeBackButtonAction } from "../../native/useNativeBackButtonAction";
import { IconButton } from "../Button";
import { StudioDialogModal, type StudioDialogAppearance } from "./StudioModal";

interface MobileFocusDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  dialogAriaLabel: string;
  header?: ReactNode;
  dialogRef?: Ref<HTMLElement>;
  children: ReactNode;
  dismissLabel?: string;
  closeDisabled?: boolean;
  appearance?: StudioDialogAppearance;
  "data-testid"?: string;
}

/** A focused phone task: stable header controls above a keyboard-aware scroll area. */
export function MobileFocusDialog({
  isOpen, onOpenChange, dialogAriaLabel, header, dialogRef, children, dismissLabel = "Close", closeDisabled = false, appearance,
  "data-testid": testId,
}: MobileFocusDialogProps) {
  const bounds = useVisualViewportBounds(isOpen);
  const close = () => { if (!closeDisabled) onOpenChange(false); };
  // Consume Back even while saving so it cannot navigate the underlying screen.
  useNativeBackButtonAction(isOpen, close);

  return <StudioDialogModal
    isOpen={isOpen} onOpenChange={(open) => { if (open || !closeDisabled) onOpenChange(open); }}
    isDismissable={!closeDisabled} isKeyboardDismissDisabled={closeDisabled}
    dialogRef={dialogRef} dialogAriaLabel={dialogAriaLabel} data-testid={testId}
    appearance={appearance}
    className="!p-0"
    modalClassName="!max-w-none !rounded-none !border-0 !shadow-none overflow-hidden"
    modalStyle={{ position: "absolute", top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height,
      paddingTop: "var(--instafy-safe-area-inset-top, 0px)",
      paddingRight: "var(--instafy-safe-area-inset-right, 0px)",
      paddingBottom: "var(--instafy-safe-area-inset-bottom, 0px)",
      paddingLeft: "var(--instafy-safe-area-inset-left, 0px)",
    }}
    dialogClassName="flex h-full min-h-0 flex-col"
  >
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-[color:var(--color-studio-dark-panel-border)]">
      <IconButton slot={null} aria-label={dismissLabel} title={dismissLabel} variant="ghost" radius="full"
        className="h-11 w-11 shrink-0" isDisabled={closeDisabled} onPress={close}>
        <NavArrowLeft aria-hidden="true" className="h-5 w-5" />
      </IconButton>
      <div className="min-w-0 flex-1">{header ?? <h2 className="truncate text-base font-semibold">{dialogAriaLabel}</h2>}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
  </StudioDialogModal>;
}
