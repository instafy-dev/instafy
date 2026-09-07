import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../../../components/listRowStyles";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { StudioSidebarMobileDrillIn } from "./StudioSidebarMobileDrillIn";

interface StudioSidebarWorkspacePanelProps {
  open: boolean;
  desktop: boolean;
  portalTarget: HTMLDivElement | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}

/** Keeps scope selection in the layout's drawer, or inside mobile navigation. */
export function StudioSidebarWorkspacePanel({
  open,
  desktop,
  portalTarget,
  triggerRef,
  onClose,
  children,
}: StudioSidebarWorkspacePanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || (desktop && !portalTarget)) {
      return;
    }
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [desktop, open, portalTarget]);

  const dismiss = () => {
    onClose();
    triggerRef.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  };

  if (!open) {
    return null;
  }
  if (!desktop) {
    return (
      <div ref={panelRef} tabIndex={-1} className="outline-none" onKeyDown={handleKeyDown}>
        <StudioSidebarMobileDrillIn
          open
          testId="sidebar-project-switcher-menu"
          title="Team & spaces"
          backLabel="Back"
          backTestId="sidebar-project-switcher-back"
          onBack={dismiss}
        >
          {children}
        </StudioSidebarMobileDrillIn>
      </div>
    );
  }
  if (!portalTarget) {
    return null;
  }
  return createPortal(
    <div
      ref={panelRef}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col outline-none"
      data-testid="sidebar-project-switcher-menu"
    >
      <div className={`shrink-0 border-b border-slate-200/70 px-4 pb-3 pt-4 ${DARK_DIVIDER_BORDER_CLASS}`}>
        <DrawerHeader
          title={<span id={titleId}>Team & spaces</span>}
          titleAs="h2"
          titleClassName="!text-base !font-semibold"
          actions={
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Close team and spaces"
              data-testid="sidebar-project-switcher-close"
              className={DRAWER_ICON_BUTTON_TONE_CLASS}
              onPress={dismiss}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </div>,
    portalTarget,
  );
}
