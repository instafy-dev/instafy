import type { ReactNode } from "react";
import type { ModalOverlayProps, PopoverProps } from "react-aria-components";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import { StudioDialogModal } from "./StudioModal";
import { StudioDialogPopover } from "./StudioPopover";

type BreakpointKey = "sm" | "md" | "lg" | "xl" | "2xl";

interface SurfaceTestIdProps {
  "data-testid"?: string;
}

interface ResponsiveDialogSurfaceProps {
  children: ReactNode;
  mobileChildren?: ReactNode;
  minDesktopBreakpoint?: BreakpointKey;
  desktop: PopoverProps & SurfaceTestIdProps;
  mobile?: (ModalOverlayProps & SurfaceTestIdProps) & {
    modalClassName?: ModalOverlayProps["className"];
    dialogAriaLabel?: string;
    dialogAriaLabelledBy?: string;
  };
  mobileFullScreen?: boolean;
}

export function ResponsiveDialogSurface({
  children,
  mobileChildren,
  minDesktopBreakpoint = "lg",
  desktop,
  mobile,
  mobileFullScreen = true,
}: ResponsiveDialogSurfaceProps) {
  const isDesktop = useBreakpoint(minDesktopBreakpoint);

  if (isDesktop) {
    return <StudioDialogPopover {...desktop}>{children}</StudioDialogPopover>;
  }

  const {
    modalClassName,
    dialogAriaLabel,
    dialogAriaLabelledBy,
    className,
    isDismissable = true,
    ...mobileOverlayProps
  } = mobile ?? {};

  const overlayClassName = [
    mobileFullScreen
      ? "items-stretch justify-stretch p-0"
      : "h-[100dvh] min-h-0 overflow-hidden",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const resolvedModalClassName = [
    mobileFullScreen
      ? "h-[100dvh] w-[100dvw] max-w-none rounded-none border-0 shadow-none"
      : "min-h-0 max-h-full overflow-y-auto overscroll-contain",
    modalClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <StudioDialogModal
      {...mobileOverlayProps}
      isDismissable={isDismissable}
      className={overlayClassName || undefined}
      modalClassName={resolvedModalClassName || undefined}
      dialogAriaLabel={dialogAriaLabel}
      dialogAriaLabelledBy={dialogAriaLabelledBy}
    >
      {mobileChildren ?? children}
    </StudioDialogModal>
  );
}
