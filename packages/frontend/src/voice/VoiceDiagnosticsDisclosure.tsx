import type { ReactNode } from "react";

type VoiceDiagnosticsDisclosureProps = {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  testIdPrefix?: string;
  variant?: "default" | "inverse";
};

export function VoiceDiagnosticsDisclosure({
  title,
  description,
  children,
  className = "",
  contentClassName = "",
  testIdPrefix = "voice-diagnostics",
  variant = "default",
}: VoiceDiagnosticsDisclosureProps) {
  const shellClassName =
    variant === "inverse"
      ? "rounded-2xl border border-white/10 bg-black/20 p-4 text-slate-200"
      : "rounded-2xl border border-slate-200/70 bg-white/70 p-4 text-slate-700 dark:border-slate-800/80 dark:bg-slate-950/50 dark:text-slate-200";
  const titleClassName =
    variant === "inverse"
      ? "text-xxs uppercase tracking-[0.24em] text-slate-400"
      : "text-xxs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400";
  const descriptionClassName =
    variant === "inverse"
      ? "mt-1 text-xs text-slate-400"
      : "mt-1 text-xs text-slate-500 dark:text-slate-400";
  const badgeClassName =
    variant === "inverse"
      ? "rounded-full border border-white/10 bg-white/8 px-2.5 py-1 text-3xs uppercase tracking-[0.18em] text-slate-300"
      : "rounded-full border border-slate-200/70 bg-slate-100/80 px-2.5 py-1 text-3xs uppercase tracking-[0.18em] text-slate-500 dark:border-slate-800/80 dark:bg-slate-900/80 dark:text-slate-400";

  return (
    <details
      className={[shellClassName, className].filter(Boolean).join(" ")}
      data-testid={`${testIdPrefix}-details`}
    >
      <summary
        className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden"
        data-testid={`${testIdPrefix}-summary`}
      >
        <div>
          <div className={titleClassName}>{title}</div>
          {description ? <div className={descriptionClassName}>{description}</div> : null}
        </div>
        <span className={badgeClassName}>Collapsed</span>
      </summary>
      <div className={["mt-3", contentClassName].filter(Boolean).join(" ")} data-testid={`${testIdPrefix}-content`}>
        {children}
      </div>
    </details>
  );
}
