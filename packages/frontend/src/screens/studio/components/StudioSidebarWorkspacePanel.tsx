import { useLayoutEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../../../components/listRowStyles";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { StudioSidebarMobileDrillIn } from "./StudioSidebarMobileDrillIn";

interface StudioSidebarWorkspacePanelProps {
  mode?: "teams-and-spaces" | "spaces";
  open: boolean;
  desktop: boolean;
  portalTarget: HTMLDivElement | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}

/** Keeps scope selection in the layout's drawer, or inside mobile navigation. */
export function StudioSidebarWorkspacePanel({
  mode = "teams-and-spaces",
  open,
  desktop,
  portalTarget,
  triggerRef,
  onClose,
  children,
}: StudioSidebarWorkspacePanelProps) {
  const titleId = useId();
  const title = mode === "spaces" ? "Spaces" : "Browse teams";
  const panelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !desktop || !portalTarget) {
      return;
    }
    // Move focus before the new panel can receive keyboard input. Delaying a
    // frame leaves Escape on the old trigger and can close the parent modal.
    panelRef.current?.focus();
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
      <StudioSidebarMobileDrillIn
        open
        testId="sidebar-project-switcher-menu"
        title={title}
        backLabel="Back"
        backTestId="sidebar-project-switcher-back"
        triggerRef={triggerRef}
        onBack={onClose}
      >
        {children}
      </StudioSidebarMobileDrillIn>
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
      <div className={`shrink-0 border-b border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`}>
        <DrawerHeader
          title={<span id={titleId}>{title}</span>}
          titleAs="h2"
          frame="rail"
          actions={
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label={mode === "spaces" ? "Close spaces" : "Close team and spaces"}
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
