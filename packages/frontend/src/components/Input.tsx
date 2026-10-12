import { forwardRef } from "react";
import {
  CONTROL_DEFAULT_SIZE,
  CONTROL_SIZE_CLASSES,
  CONTROL_RADIUS_CLASSES,
  CONTROL_TONE_CLASSES,
  type ControlSize,
  type ControlRadius,
  type ControlTone,
} from "./controlStyles";

const BASE =
  "border text-midnight placeholder:text-slate-400 outline-none transition pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:border-primary-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-[var(--color-studio-dark-active)] dark:disabled:text-slate-500";

const UNSTYLED_BASE =
  "bg-transparent text-midnight placeholder:text-slate-400 outline-none disabled:cursor-not-allowed disabled:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:text-slate-500";

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: ControlSize;
  radius?: ControlRadius;
  tone?: ControlTone;
  fullWidth?: boolean;
  unstyled?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = CONTROL_DEFAULT_SIZE,
    radius = "xl",
    tone = "default",
    fullWidth = true,
    unstyled = false,
    className,
    ...props
  },
  ref
) {
  return (
    <input
      ref={ref}
      className={
        unstyled
          ? [UNSTYLED_BASE, fullWidth ? "w-full" : "", className].filter(Boolean).join(" ")
          : [
              BASE,
              CONTROL_SIZE_CLASSES[size],
              CONTROL_RADIUS_CLASSES[radius],
              CONTROL_TONE_CLASSES[tone],
              fullWidth ? "w-full" : "",
              className,
            ]
              .filter(Boolean)
              .join(" ")
      }
      {...props}
    />
  );
});
