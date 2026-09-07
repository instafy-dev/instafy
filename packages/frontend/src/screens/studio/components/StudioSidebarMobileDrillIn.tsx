import { NavArrowLeft } from "iconoir-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
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
  children: ReactNode;
};

export function StudioSidebarMobileDrillIn({
  open,
  testId,
  title,
  backLabel,
  backTestId,
  onBack,
  children,
}: StudioSidebarMobileDrillInProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
      className="absolute inset-0 z-30 flex flex-col border-r border-slate-200/70 bg-slate-50/95 px-3 pb-4 pt-2 outline-none backdrop-blur-sm dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail-muted)]"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 pb-2">
        <IconButton
          variant="ghost"
          size="sm"
          radius="full"
          aria-label={backLabel}
          data-testid={backTestId}
          onPress={onBack}
          className={DRAWER_ICON_BUTTON_TONE_CLASS}
        >
          <NavArrowLeft className="text-base" aria-hidden="true" />
        </IconButton>
        <Text as="p" variant="bodyStrong" tone="primary">
          {title}
        </Text>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-1">{children}</div>
    </div>
  );
}
