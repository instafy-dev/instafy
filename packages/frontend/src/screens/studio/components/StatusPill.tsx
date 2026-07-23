import type { ComponentPropsWithoutRef, ComponentType, ReactNode } from "react";

export type StatusPillTone = "danger" | "warning" | "neutral" | "primary";

type StatusPillIcon = ComponentType<{
  "aria-hidden"?: "true";
  className?: string;
}>;

type StatusPillCommonProps = {
  children: ReactNode;
  tone?: StatusPillTone;
  icon?: StatusPillIcon | null;
  iconClassName?: string;
};

function statusPillToneClassName(tone: StatusPillTone): string {
  if (tone === "danger") {
    return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200";
  }
  if (tone === "warning") {
    return "border-secondary-200 bg-secondary-50 text-secondary-800 dark:border-secondary-400/30 dark:bg-secondary-500/10 dark:text-secondary-100";
  }
  if (tone === "primary") {
    return "border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-400/30 dark:bg-primary-500/10 dark:text-primary-100";
  }
  return "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

function statusPillClassName(tone: StatusPillTone, className?: string): string {
  return [
    "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
    statusPillToneClassName(tone),
    className ?? "",
  ].filter(Boolean).join(" ");
}

function StatusPillContent({
  children,
  icon: Icon,
  iconClassName,
}: StatusPillCommonProps) {
  return (
    <>
      {Icon ? (
        <Icon
          aria-hidden="true"
          className={["h-3.5 w-3.5 flex-none", iconClassName ?? ""].filter(Boolean).join(" ")}
        />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
  icon = null,
  iconClassName,
  className,
  ...props
}: StatusPillCommonProps & ComponentPropsWithoutRef<"span">) {
  return (
    <span className={statusPillClassName(tone, className)} {...props}>
      <StatusPillContent icon={icon} iconClassName={iconClassName}>
        {children}
      </StatusPillContent>
    </span>
  );
}

export function StatusPillButton({
  children,
  tone = "neutral",
  icon = null,
  iconClassName,
  className,
  type = "button",
  ...props
}: StatusPillCommonProps & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type={type}
      className={statusPillClassName(
        tone,
        [
          "transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
          className ?? "",
        ].filter(Boolean).join(" "),
      )}
      {...props}
    >
      <StatusPillContent icon={icon} iconClassName={iconClassName}>
        {children}
      </StatusPillContent>
    </button>
  );
}
