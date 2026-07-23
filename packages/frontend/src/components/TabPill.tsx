import { forwardRef } from "react";
import { Button, type ButtonProps } from "./Button";

type TabTone = "primary" | "slate";

const ACTIVE_CLASSES: Record<TabTone, string> = {
  primary: "border-primary-200 bg-primary-50 text-primary-800 shadow-sm",
  slate: "bg-slate-900 text-white shadow-md shadow-slate-900/15",
};

const INACTIVE_CLASSES: Record<TabTone, string> = {
  primary: "border-transparent text-slate-600 hover:bg-slate-100 data-[hovered]:bg-slate-100",
  slate: "text-slate-600 hover:bg-slate-100 data-[hovered]:bg-slate-100",
};

export type TabPillProps = ButtonProps & {
  active?: boolean;
  tone?: TabTone;
};

export const TabPill = forwardRef<HTMLButtonElement, TabPillProps>(function TabPill(
  { active = false, tone = "primary", radius = "xl", className, ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant="ghost"
      size="sm"
      radius={radius}
      className={[
        "gap-1.5 border px-2.5 py-1 text-sm font-semibold",
        active ? ACTIVE_CLASSES[tone] : INACTIVE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
