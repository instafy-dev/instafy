import { forwardRef } from "react";
import { Button, composeRenderProps, type ButtonProps } from "react-aria-components";
import { CONTROL_DEFAULT_SIZE, CONTROL_RADIUS_CLASSES, CONTROL_SIZE_CLASSES, CONTROL_TONE_CLASSES, CONTROL_TRIGGER_BASE, type ControlSize } from "./controlStyles";

type ControlTriggerProps = ButtonProps & { size?: ControlSize };

/** A field that opens an editor or picker; callers own its popup semantics. */
export const ControlTrigger = forwardRef<HTMLButtonElement, ControlTriggerProps>(function ControlTrigger(
  { size = CONTROL_DEFAULT_SIZE, className, ...props },
  ref,
) {
  return <Button
    {...props}
    ref={ref}
    className={composeRenderProps(className, (extra) => [
      CONTROL_TRIGGER_BASE,
      CONTROL_SIZE_CLASSES[size],
      CONTROL_RADIUS_CLASSES.xl,
      CONTROL_TONE_CLASSES.default,
      "w-full data-[hovered]:bg-slate-50 dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]",
      extra,
    ].filter(Boolean).join(" "))}
  />;
});
