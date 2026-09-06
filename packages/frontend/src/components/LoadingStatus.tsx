import type { HTMLAttributes } from "react";
import { Spinner, type SpinnerSize } from "./Spinner";

interface LoadingStatusProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
}

/** A local loading announcement that leaves the surrounding workspace usable. */
export function LoadingStatus({ children, className, size = "sm", ...props }: LoadingStatusProps) {
  return (
    <span
      {...props}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={[
        "inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400",
        className,
      ].filter(Boolean).join(" ")}
    >
      <Spinner size={size} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
