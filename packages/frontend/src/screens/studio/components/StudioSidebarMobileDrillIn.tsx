import { NavArrowLeft } from "iconoir-react";
import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../../../components/listRowStyles";

type StudioSidebarMobileDrillInProps = {
  open: boolean;
  testId: string;
  title: string;
  backLabel: string;
  backTestId: string;
  onBack: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

export function StudioSidebarMobileDrillIn({
  open,
  testId,
  title,
  backLabel,
  backTestId,
  onBack,
  triggerRef,
  children,
}: StudioSidebarMobileDrillInProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const explicitBackRef = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    explicitBackRef.current = false;
    const trigger = triggerRef?.current;
    const navigation = trigger?.closest("nav");
    panelRef.current?.focus();
    return () => {
      if (!explicitBackRef.current) return;
      // Back may finish through browser history. Wait until the drill-in
      // actually closes, then let the root navigation shed its inert state.
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        // The outer modal may first focus Home when its drilled-in region
        // disappears. Complete that return within navigation, while leaving
        // destination content or a newly opened popup in charge of its focus.
        if (trigger?.isConnected && !trigger.closest("[inert]") &&
          (focused === document.body || Boolean(focused && navigation?.contains(focused)))) trigger.focus();
      });
    };
  }, [open, triggerRef]);

  const goBack = () => {
    explicitBackRef.current = true;
    onBack();
  };

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        goBack();
      }}
      className="absolute inset-0 z-30 flex flex-col border-r border-slate-200/70 bg-slate-50/95 px-3 pb-4 pt-2 outline-none backdrop-blur-sm dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail-muted)]"
      data-testid={testId}
    >
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <IconButton
          variant="ghost"
          size="sm"
          radius="full"
          aria-label={backLabel}
          data-testid={backTestId}
          onPress={goBack}
          className={DRAWER_ICON_BUTTON_TONE_CLASS}
        >
          <NavArrowLeft className="text-base" aria-hidden="true" />
        </IconButton>
        <Text as="h2" id={titleId} variant="bodyStrong" tone="primary">
          {title}
        </Text>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1"
        data-sidebar-scrollport
        style={{ paddingBottom: "var(--sidebar-focused-search-space, 0.25rem)" }}
      >{children}</div>
    </div>
  );
}
