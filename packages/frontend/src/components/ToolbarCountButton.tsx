import type { ReactNode, Ref } from "react";
import { Button, type ButtonProps } from "./Button";

type ToolbarCountButtonProps = {
  count: number;
  expanded: boolean;
  children: ReactNode;
  onPress: ButtonProps["onPress"];
  ref?: Ref<HTMLButtonElement>;
  "aria-label": string;
  "aria-controls": string;
  "data-testid"?: string;
  title?: string;
};

/** A quiet toolbar trigger with a decorative count; its label carries the full count. */
export function ToolbarCountButton({
  count,
  expanded,
  children,
  ...props
}: ToolbarCountButtonProps) {
  if (count <= 0) return null;

  return (
    <Button
      {...props}
      type="button"
      aria-expanded={expanded}
      variant={expanded ? "secondary" : "ghost"}
      preset="toolbar"
      className="relative flex-none"
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white dark:bg-slate-300 dark:text-slate-950 dark:ring-[color:var(--color-studio-dark-panel)]"
      >
        {count > 99 ? "99+" : String(count)}
      </span>
    </Button>
  );
}
