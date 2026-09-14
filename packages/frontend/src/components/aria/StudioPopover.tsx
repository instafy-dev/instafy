import { useContext, useMemo, useRef, type ReactNode } from "react";
import {
  DEFAULT_SLOT,
  Dialog,
  Popover,
  PopoverContext,
  composeRenderProps,
  type PopoverProps,
} from "react-aria-components";
import {
  DARK_FLOATING_BG_CLASS,
  DARK_FLOATING_SHADOW_CLASS,
  DARK_FLOATING_SOLID_BG_CLASS,
} from "../../theme/darkSurfaces";

const POPOVER_BASE =
  [
    "relative flex min-h-0 flex-col overflow-hidden rounded-2xl text-slate-700",
    "shadow-[0_18px_42px_-26px_rgba(0,0,0,0.18)] outline-none",
    "dark:text-slate-100",
    DARK_FLOATING_BG_CLASS,
    DARK_FLOATING_SHADOW_CLASS,
  ].join(" ");

type TriggerRefLike = { current: Element | null };

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isTriggerRefLike(value: unknown): value is TriggerRefLike {
  return isRecord(value) && "current" in value;
}

export function StudioPopover({
  children,
  className,
  isNonModal = false,
  shouldCloseOnInteractOutside,
  triggerRef,
  ...props
}: PopoverProps) {
  const popoverRef = useRef<HTMLElement | null>(null);
  const contextValue = useContext(PopoverContext);

  const resolvedCloseOnInteractOutside = useMemo(() => {
    const context = (() => {
      if (!isRecord(contextValue) || !("slots" in contextValue)) {
        return contextValue;
      }
      const slots = (contextValue as { slots?: unknown }).slots;
      if (!isRecord(slots)) {
        return contextValue;
      }
      const slotValue = slots[DEFAULT_SLOT];
      return slotValue ?? contextValue;
    })();

    const contextTriggerRef = isRecord(context) && "triggerRef" in context ? context.triggerRef : null;
    const resolvedTriggerRef: TriggerRefLike | null =
      triggerRef ?? (isTriggerRefLike(contextTriggerRef) ? contextTriggerRef : null);

    return (element: Element) => {
      if (resolvedTriggerRef?.current?.contains(element)) {
        return false;
      }
      if (shouldCloseOnInteractOutside) {
        return shouldCloseOnInteractOutside(element);
      }
      return true;
    };
  }, [contextValue, shouldCloseOnInteractOutside, triggerRef]);

  return (
    <Popover
      {...props}
      data-studio-popover=""
      ref={popoverRef}
      isNonModal={isNonModal}
      triggerRef={triggerRef}
      shouldCloseOnInteractOutside={resolvedCloseOnInteractOutside}
      className={composeRenderProps(className, (value) =>
        `${POPOVER_BASE}${value ? ` ${value}` : ""}`
      )}
      children={composeRenderProps(children, (resolvedChildren) => (
        <>
          <div
            aria-hidden="true"
            className={[
              "pointer-events-none absolute inset-0 rounded-[inherit] border border-slate-200/70 bg-white/[0.98] shadow-[inherit]",
              `${DARK_FLOATING_SOLID_BG_CLASS} dark:border-transparent`,
            ].join(" ")}
          />
          {/* Flex shrinking accounts for the popover's own padding when React
              Aria limits its height. Keep decoration outside the scroll area;
              the small gutter preserves focus rings without moving content. */}
          <div
            data-studio-popover-content=""
            className="relative z-10 -m-1 min-h-0 overflow-y-auto overscroll-contain p-1"
          >
            {resolvedChildren}
          </div>
        </>
      ))}
    >
    </Popover>
  );
}

export function StudioDialogPopover({
  children,
  ...props
}: PopoverProps & { children: ReactNode }) {
  return (
    <StudioPopover {...props}>
      <Dialog className="outline-none">{children}</Dialog>
    </StudioPopover>
  );
}
