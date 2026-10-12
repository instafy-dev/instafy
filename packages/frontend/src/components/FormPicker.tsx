import { forwardRef, type ReactNode } from "react";
import { Button, composeRenderProps, type ButtonProps, type PopoverProps } from "react-aria-components";
import { ControlChevron } from "./ControlChevron";
import { CONTROL_DEFAULT_SIZE, CONTROL_RADIUS_CLASSES, CONTROL_SIZE_CLASSES, CONTROL_TONE_CLASSES, CONTROL_TRIGGER_BASE } from "./controlStyles";
import { StudioPopover } from "./aria/StudioPopover";

type FormPickerTriggerProps = Omit<ButtonProps, "children"> & {
  children: ReactNode;
  leading?: ReactNode;
};

/** Form-sized menu trigger; the owning picker keeps its selection and actions. */
export const FormPickerTrigger = forwardRef<HTMLButtonElement, FormPickerTriggerProps>(function FormPickerTrigger(
  { children, leading, className, ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-haspopup="menu"
      className={composeRenderProps(className, (extra) => [
        CONTROL_TRIGGER_BASE,
        CONTROL_SIZE_CLASSES[CONTROL_DEFAULT_SIZE],
        CONTROL_RADIUS_CLASSES.xl,
        CONTROL_TONE_CLASSES.default,
        "w-full justify-between gap-2 data-[hovered]:bg-slate-50 dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]",
        extra,
      ].filter(Boolean).join(" "))}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {leading ? <span className="shrink-0">{leading}</span> : null}
        <span className="truncate">{children}</span>
      </span>
      <ControlChevron />
    </Button>
  );
});

export function FormPickerPopover({ className, ...props }: PopoverProps) {
  return (
    <StudioPopover
      isNonModal
      placement="bottom start"
      offset={6}
      {...props}
      className={composeRenderProps(className, (extra) => [
        "min-w-[var(--trigger-width)] p-2",
        extra,
      ].filter(Boolean).join(" "))}
    />
  );
}
