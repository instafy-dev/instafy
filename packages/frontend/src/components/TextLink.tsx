import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

type TextLinkSize = "xs" | "sm" | "md";
type TextLinkTone = "default" | "muted" | "danger";

const SIZE_CLASSES: Record<TextLinkSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
};

const TONE_CLASSES: Record<TextLinkTone, string> = {
  default:
    "text-slate-700 decoration-slate-300 hover:text-slate-900 hover:decoration-slate-500 dark:text-slate-200 dark:decoration-slate-600 dark:hover:text-slate-50 dark:hover:decoration-slate-400",
  muted:
    "text-slate-600 decoration-slate-300 hover:text-slate-900 hover:decoration-slate-500 dark:text-slate-300 dark:decoration-slate-600 dark:hover:text-slate-50 dark:hover:decoration-slate-400",
  danger:
    "text-rose-600 decoration-rose-200 hover:text-rose-700 hover:decoration-rose-300 dark:text-rose-300 dark:decoration-rose-900/60 dark:hover:text-rose-200 dark:hover:decoration-rose-700/70",
};

export type TextLinkProps = Omit<LinkProps, "className" | "children"> & {
  children: ReactNode;
  className?: string;
  size?: TextLinkSize;
  tone?: TextLinkTone;
  underline?: boolean;
};

export function TextLink({
  size = "sm",
  tone = "default",
  underline = true,
  className,
  children,
  ...props
}: TextLinkProps) {
  return (
    <Link
      {...props}
      className={[
        "font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-primary-400/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950",
        SIZE_CLASSES[size],
        underline ? "underline underline-offset-4" : "",
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
}

