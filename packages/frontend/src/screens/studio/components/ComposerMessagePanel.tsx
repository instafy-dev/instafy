import type { ReactNode } from "react";
import { StudioPopover, type StudioPopoverProps } from "../../../components/aria/StudioPopover";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";

type MessagePanelPresentation = "list" | "bubbles";

// The same measure applies to inline trays and their floating counterparts.
const PANEL_MEASURE = "w-full max-w-sm";

/** Saved drafts and queued messages share geometry, but bubbles stay separate. */
export function ComposerMessagePopover({
  presentation,
  ...props
}: Omit<StudioPopoverProps, "layout" | "surface" | "placement" | "offset" | "containerPadding" | "className"> & {
  presentation: MessagePanelPresentation;
}) {
  return (
    <StudioPopover
      {...props}
      surface="none"
      placement="top end"
      offset={presentation === "bubbles" ? 16 : 8}
      containerPadding={8}
      // Leave room alongside the queue for dragging without hitting the edge.
      className={`max-h-[calc(100dvh-1rem)] max-w-sm p-0 ${presentation === "bubbles" ? "w-[calc(100dvw-4rem)]" : "w-[calc(100dvw-1rem)]"}`}
    />
  );
}

export function ComposerMessagePanel({
  id,
  title,
  icon,
  presentation,
  headerTestId,
  listTestId,
  showHeader = true,
  fullWidth = false,
  children,
  footer,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  presentation: MessagePanelPresentation;
  headerTestId: string;
  listTestId?: string;
  showHeader?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const header = showHeader ? (
    <div className="flex min-h-10 items-center gap-2 px-3 py-2" data-testid={headerTestId}>
      <Text as="span" tone="muted" className="flex shrink-0 [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
        {icon}
      </Text>
      <Text as="h3" variant="bodyStrong" tone="primary" className="min-w-0 break-words">
        {title}
      </Text>
    </div>
  ) : null;

  return (
    <div id={id} role="region" aria-label={title} className="basis-full dark:[color-scheme:dark]">
      <div className={fullWidth ? "w-full" : `ml-auto ${PANEL_MEASURE}`}>
        {presentation === "list" ? (
          <Surface tone="default" radius="xl" shadow="none" className="overflow-hidden">
            {header}
            <div
              className={`max-h-[min(16rem,35dvh)] divide-y divide-slate-200/70 overflow-y-auto overscroll-contain border-t border-slate-200/70 dark:divide-slate-800/80 ${DARK_DIVIDER_BORDER_CLASS}`}
              data-testid={listTestId}
            >
              {children}
            </div>
          </Surface>
        ) : (
          <>
            {header ? <Surface tone="default" radius="xl" shadow="none" className="mx-1 mb-2">{header}</Surface> : null}
            {children ? <div className="max-h-[min(32rem,60dvh)] overflow-y-auto overscroll-contain" data-testid={listTestId}>{children}</div> : null}
          </>
        )}
        {footer}
      </div>
    </div>
  );
}
