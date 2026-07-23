import type { ReactNode } from "react";

export interface MenuItemContentProps {
  start?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
  startClassName?: string;
  endClassName?: string;
  textClassName?: string;
}

const DEFAULT_ICON_CLASS =
  "shrink-0 text-slate-400 dark:text-slate-300 [&>svg]:h-4 [&>svg]:w-4";

export function MenuItemContent({
  start,
  end,
  children,
  startClassName = DEFAULT_ICON_CLASS,
  endClassName = DEFAULT_ICON_CLASS,
  textClassName,
}: MenuItemContentProps) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {start ? <span className={startClassName}>{start}</span> : null}
        <span className={["min-w-0 flex-1 truncate text-left", textClassName].filter(Boolean).join(" ")}>
          {children}
        </span>
      </span>
      {end ? <span className={endClassName}>{end}</span> : null}
    </>
  );
}
