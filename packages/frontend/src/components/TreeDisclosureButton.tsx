import type { ReactNode } from "react";
import { NavArrowDown, NavArrowRight } from "iconoir-react";
import { Spinner } from "./Spinner";

export type TreeDisclosureButtonProps = {
  expanded: boolean;
  loading?: boolean;
  onPress?: () => void;
  pressElement?: "button" | "span";
  label?: string;
  title?: string;
  testId?: string;
  className?: string;
};

const TREE_DISCLOSURE_BASE =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-400 dark:text-slate-500";

export function TreeDisclosureButton({
  expanded,
  loading = false,
  onPress,
  pressElement = "button",
  label,
  title,
  testId,
  className,
}: TreeDisclosureButtonProps) {
  const icon = loading ? (
    <Spinner aria-hidden="true" size="xs" tone="slate" />
  ) : expanded ? (
    <NavArrowDown aria-hidden="true" />
  ) : (
    <NavArrowRight aria-hidden="true" />
  );

  if (!onPress) {
    return (
      <span className={[TREE_DISCLOSURE_BASE, className].filter(Boolean).join(" ")}>
        {icon}
      </span>
    );
  }

  const pressClassName = [
    TREE_DISCLOSURE_BASE,
    "rounded-md border-0 bg-transparent p-0 transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 dark:hover:text-slate-200",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (pressElement === "span") {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPress();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onPress();
        }}
        aria-label={label}
        aria-expanded={expanded}
        title={title}
        data-testid={testId}
        className={pressClassName}
      >
        {icon}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
      aria-label={label}
      aria-expanded={expanded}
      title={title}
      data-testid={testId}
      className={pressClassName}
    >
      {icon}
    </button>
  );
}

export type TreeRowMarkerSlotProps = {
  children?: ReactNode;
  className?: string;
  depth?: number;
};

export function TreeRowMarkerSlot({ children, className, depth = 0 }: TreeRowMarkerSlotProps) {
  return (
    <span
      className={[
        "inline-flex h-5 w-5 shrink-0 items-center justify-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={depth > 0 ? { marginLeft: `${depth * 12}px` } : undefined}
    >
      {children}
    </span>
  );
}
