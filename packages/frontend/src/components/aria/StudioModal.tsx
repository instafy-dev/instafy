import { type CSSProperties, type ReactNode, type Ref } from "react";
import { useNativeBackButtonAction } from "../../native/useNativeBackButtonAction";
import { StudioDialogGutterContext, type StudioDialogGutter } from "./StudioDialogSpacing";
import {
  Dialog,
  Modal,
  ModalOverlay,
  composeRenderProps,
  type ModalOverlayProps,
} from "react-aria-components";

const OVERLAY_BASE =
  "fixed inset-0 z-[80] flex items-center justify-center pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]";

const MODAL_BASE =
  "w-full rounded-2xl border shadow-xl outline-none";

export type StudioDialogSize = "sm" | "md" | "lg";

const MODAL_SIZE_CLASSES: Record<StudioDialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export type StudioDialogAppearance = "default" | "dark";

const OVERLAY_APPEARANCE_CLASSES: Record<StudioDialogAppearance, string> = {
  default: "bg-black/40 backdrop-blur-sm",
  dark: "bg-zinc-950/70 backdrop-blur-sm",
};

export type StudioDialogBackdrop = "standard" | "opaque";
export type StudioDialogLayout = "default" | "editor";

const EDITOR_MODAL_CLASS =
  "max-h-[calc(100dvh-max(var(--instafy-safe-area-inset-top,0px),1rem)-max(var(--instafy-safe-area-inset-bottom,0px),1rem))] overflow-hidden";
const EDITOR_DIALOG_CLASS = "flex max-h-[inherit] min-h-0 flex-col";

const MODAL_APPEARANCE_CLASSES: Record<StudioDialogAppearance, string> = {
  default:
    "border-slate-200 bg-white dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]",
  dark: "dark border-white/10 bg-zinc-950 text-slate-100",
};

interface StudioDialogModalProps extends ModalOverlayProps {
  children: ReactNode;
  /** A modal with drill-in steps can consume Back without dismissing its surface. */
  onNativeBack?: () => void;
  appearance?: StudioDialogAppearance;
  backdrop?: StudioDialogBackdrop;
  /** Maximum width: 24rem, 32rem or 42rem. Viewport clearance still applies. */
  size?: StudioDialogSize;
  /** Shared section gutters. Responsive is 16px narrow / 20px at sm and above. */
  gutter?: StudioDialogGutter;
  /** Bounded header/body/footer layout. Pair with a scrollable StudioDialogBody. */
  layout?: StudioDialogLayout;
  modalClassName?: ModalOverlayProps["className"];
  modalStyle?: CSSProperties;
  dialogClassName?: string;
  dialogRef?: Ref<HTMLElement>;
  dialogAriaLabel?: string;
  dialogAriaLabelledBy?: string;
}

export function StudioDialogModal({
  children,
  onNativeBack,
  appearance = "default",
  backdrop = "standard",
  size = "md",
  gutter = "default",
  layout = "default",
  className,
  modalClassName,
  modalStyle,
  dialogClassName,
  dialogRef,
  dialogAriaLabel,
  dialogAriaLabelledBy,
  ...props
}: StudioDialogModalProps) {
  // Native Back closes the top modal before drawers/routes, including on wider
  // phones. A busy modal consumes Back without dismissing its underlying page.
  useNativeBackButtonAction(Boolean(props.isOpen), () => {
    if (props.isKeyboardDismissDisabled) return;
    if (onNativeBack) onNativeBack();
    else props.onOpenChange?.(false);
  });
  const normalizedDialogLabelledBy = dialogAriaLabelledBy?.trim() || undefined;
  const normalizedDialogLabel = normalizedDialogLabelledBy
    ? undefined
    : dialogAriaLabel?.trim() || "Dialog";

  return (
    <ModalOverlay
      {...props}
      className={composeRenderProps(className, (value) =>
        `${OVERLAY_BASE} ${
          backdrop === "opaque" ? "bg-zinc-950" : OVERLAY_APPEARANCE_CLASSES[appearance]
        }${value ? ` ${value}` : ""}`
      )}
    >
      <Modal
        style={modalStyle}
        className={composeRenderProps(modalClassName, (value) =>
          [MODAL_BASE, MODAL_SIZE_CLASSES[size], MODAL_APPEARANCE_CLASSES[appearance], layout === "editor" ? EDITOR_MODAL_CLASS : "", value].filter(Boolean).join(" ")
        )}
      >
        <Dialog
          ref={dialogRef}
          className={["outline-none", layout === "editor" ? EDITOR_DIALOG_CLASS : "", dialogClassName].filter(Boolean).join(" ")}
          aria-label={normalizedDialogLabel}
          aria-labelledby={normalizedDialogLabelledBy}
        >
          <StudioDialogGutterContext.Provider value={gutter}>{children}</StudioDialogGutterContext.Provider>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
