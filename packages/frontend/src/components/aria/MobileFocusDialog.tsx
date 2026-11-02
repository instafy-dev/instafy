import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { NavArrowLeft } from "iconoir-react";
import { useVisualViewportBounds } from "../../hooks/useVisualViewportBounds";
import { revealFocusedEditable } from "../../utils/revealFocusedEditable";
import { IconButton } from "../Button";
import { StudioDialogModal, type StudioDialogAppearance } from "./StudioModal";
import type { StudioDialogGutter } from "./StudioDialogSpacing";

interface MobileFocusDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  dialogAriaLabel: string;
  header?: ReactNode;
  /** Fixed beside the scrolling form, or scrolls with it in very short viewports. */
  footer?: ReactNode;
  dialogRef?: Ref<HTMLElement>;
  children: ReactNode;
  dismissLabel?: string;
  closeDisabled?: boolean;
  appearance?: StudioDialogAppearance;
  /** Applied to shared body/footer sections; the mobile navigation header keeps its own layout. */
  gutter?: StudioDialogGutter;
  "data-testid"?: string;
}

/** A focused phone task: stable header controls above a keyboard-aware scroll area. */
export function MobileFocusDialog({
  isOpen, onOpenChange, dialogAriaLabel, header, footer, dialogRef, children, dismissLabel = "Close", closeDisabled = false, appearance, gutter,
  "data-testid": testId,
}: MobileFocusDialogProps) {
  const bounds = useVisualViewportBounds(isOpen);
  const shortViewport = bounds.height < 240;
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const scroller = shortViewport ? contentRef.current : bodyRef.current;
    revealFocusedEditable(scroller);
  }, [bounds.height, bounds.width, bounds.top, bounds.left, isOpen, shortViewport]);
  const close = () => { if (!closeDisabled) onOpenChange(false); };
  return <StudioDialogModal
    isOpen={isOpen} onOpenChange={(open) => { if (open || !closeDisabled) onOpenChange(open); }}
    isDismissable={!closeDisabled} isKeyboardDismissDisabled={closeDisabled}
    dialogRef={dialogRef} dialogAriaLabel={dialogAriaLabel} data-testid={testId}
    appearance={appearance}
    gutter={gutter}
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
    <div className={`flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-[color:var(--color-studio-dark-panel-border)] ${shortViewport ? "h-11 border-b-0" : "py-2"}`}>
      <IconButton slot={null} aria-label={dismissLabel} title={dismissLabel} variant="ghost"
        className="h-11 w-11 shrink-0" isDisabled={closeDisabled} onPress={close}>
        <NavArrowLeft aria-hidden="true" className="h-5 w-5" />
      </IconButton>
      <div className={`min-w-0 flex-1 ${shortViewport ? "[&_p]:hidden [&_h2~*]:hidden" : ""}`}>
        {header ?? <h2 className="truncate text-base font-semibold">{dialogAriaLabel}</h2>}
      </div>
    </div>
    <div ref={contentRef} data-mobile-dialog-content="" className={shortViewport
      ? "min-h-0 flex-1 overflow-y-auto overscroll-contain"
      : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
      <div ref={bodyRef} data-mobile-dialog-body="" className={shortViewport
        ? "flow-root"
        : "min-h-0 flex-1 overflow-y-auto overscroll-contain"}>{children}</div>
      {footer ? <div className="shrink-0">{footer}</div> : null}
    </div>
  </StudioDialogModal>;
}
