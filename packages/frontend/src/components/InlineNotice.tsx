import type { ReactNode } from "react";
import { CheckCircle, InfoCircle, WarningTriangle } from "iconoir-react";
import { Text } from "./Text";

export type InlineNoticeTone = "info" | "success" | "warning" | "danger";

const ROOT_TONE_CLASSES: Record<InlineNoticeTone, string> = {
  info: "border-primary-200/80 bg-primary-50/70 text-primary-900 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-50",
  success:
    "border-emerald-200/80 bg-emerald-50/70 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-50",
  warning:
    "border-secondary-200/80 bg-secondary-50/70 text-secondary-900 dark:border-secondary-500/30 dark:bg-secondary-500/10 dark:text-secondary-50",
  danger:
    "border-rose-200/80 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-50",
};

const ICON_TONE_CLASSES: Record<InlineNoticeTone, string> = {
  info: "text-primary-600 dark:text-primary-300",
  success: "text-emerald-600 dark:text-emerald-300",
  warning: "text-secondary-600 dark:text-secondary-300",
  danger: "text-rose-600 dark:text-rose-300",
};

const TITLE_TONE_CLASSES: Record<InlineNoticeTone, string> = {
  info: "text-primary-700 dark:text-primary-100",
  success: "text-emerald-700 dark:text-emerald-100",
  warning: "text-secondary-700 dark:text-secondary-100",
  danger: "text-rose-700 dark:text-rose-100",
};

const BODY_TONE_CLASSES: Record<InlineNoticeTone, string> = {
  info: "text-primary-700/90 dark:text-primary-100/85",
  success: "text-emerald-700/90 dark:text-emerald-100/85",
  warning: "text-secondary-700/90 dark:text-secondary-100/85",
  danger: "text-rose-700/90 dark:text-rose-100/85",
};

export type InlineNoticeProps = {
  tone?: InlineNoticeTone;
  title?: string | null;
  children: ReactNode;
  className?: string;
  /** Announce the notice: "status" for outcomes, "alert" for errors. */
  role?: "status" | "alert";
  "data-testid"?: string;
};

export function InlineNotice({
  tone = "info",
  title = null,
  children,
  className,
  role,
  "data-testid": dataTestId,
}: InlineNoticeProps) {
  const Icon = tone === "success" ? CheckCircle : tone === "info" ? InfoCircle : WarningTriangle;

  return (
    <div
      className={[
        "flex items-start gap-2.5 rounded-xl border px-3 py-2",
        ROOT_TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role={role}
      data-testid={dataTestId}
    >
      <Icon className={["mt-0.5 h-4 w-4 shrink-0", ICON_TONE_CLASSES[tone]].join(" ")} aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        {title ? (
          <Text variant="bodyStrong" tone="inherit" className={TITLE_TONE_CLASSES[tone]}>
            {title}
          </Text>
        ) : null}
        <Text variant="caption" tone="inherit" className={BODY_TONE_CLASSES[tone]}>
          {children}
        </Text>
      </div>
    </div>
  );
}
