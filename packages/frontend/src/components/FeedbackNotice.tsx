import type { HTMLAttributes, ReactNode } from "react";
import { CheckCircle, InfoCircle, WarningTriangle } from "iconoir-react";
import { Surface } from "./Surface";
import { Text } from "./Text";
import { SEMANTIC_TONE_CLASSES, type SemanticTone } from "../theme/semanticTones";

export type FeedbackNoticeProps = HTMLAttributes<HTMLDivElement> & {
  tone?: SemanticTone | "neutral";
  icon?: ReactNode;
  actions?: ReactNode;
  dismiss?: ReactNode;
  compact?: boolean;
};

/** Shared floating feedback, with actions below the message at every width. Owners provide placement, announcements and lifetime. */
export function FeedbackNotice({
  children,
  tone = "neutral",
  icon,
  actions,
  dismiss,
  compact = false,
  className,
  ...props
}: FeedbackNoticeProps) {
  const Icon = tone === "success" ? CheckCircle
    : tone === "warning" || tone === "danger" ? WarningTriangle : InfoCircle;
  const marker = icon !== undefined ? icon : tone === "neutral" ? null : (
    <Icon className={`h-4 w-4 ${SEMANTIC_TONE_CLASSES[tone].icon}`} aria-hidden="true" />
  );
  return (
    <Surface tone="floating" radius="xl" shadow="sm"
      className={["min-w-0 max-w-full", compact ? "px-3 py-1.5" : "p-3", className].filter(Boolean).join(" ")}
      {...props}>
      <div className="flex min-w-0 items-start gap-2">
        {marker ? <span className="mt-0.5 flex shrink-0 items-center" aria-hidden="true">{marker}</span> : null}
        <div className="min-w-0 flex-1">
          <Text as="div" variant={compact ? "caption" : "bodyCompact"} tone="primary"
            className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {children}
          </Text>
          {actions ? <div className="mt-2 flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {dismiss ? <div className={`flex shrink-0 items-center ${compact ? "h-4" : "h-5"}`}>{dismiss}</div> : null}
      </div>
    </Surface>
  );
}
