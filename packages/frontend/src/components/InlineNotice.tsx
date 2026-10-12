import type { ReactNode } from "react";
import { CheckCircle, InfoCircle, WarningTriangle } from "iconoir-react";
import { Text } from "./Text";
import { SEMANTIC_TONE_CLASSES, type SemanticTone } from "../theme/semanticTones";

export type InlineNoticeTone = SemanticTone;

export type InlineNoticeProps = {
  tone?: InlineNoticeTone;
  title?: ReactNode;
  children: ReactNode;
  density?: "compact" | "comfortable";
  actions?: ReactNode;
  className?: string;
  /** Announce the notice: "status" for outcomes, "alert" for errors. */
  role?: "status" | "alert";
  "data-testid"?: string;
};

export function InlineNotice({
  tone = "info",
  title = null,
  children,
  density = "compact",
  actions,
  className,
  role,
  "data-testid": dataTestId,
}: InlineNoticeProps) {
  const Icon = tone === "success" ? CheckCircle : tone === "info" ? InfoCircle : WarningTriangle;

  return (
    <div
      className={[
        "flex items-start gap-2.5 rounded-xl border px-3 py-2",
        SEMANTIC_TONE_CLASSES[tone].surface,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role={role}
      data-testid={dataTestId}
    >
      <Icon className={["mt-0.5 h-4 w-4 shrink-0", SEMANTIC_TONE_CLASSES[tone].icon].join(" ")} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
          {title ? <Text variant="bodyStrong" tone={tone}>{title}</Text> : null}
          <Text as="div" variant={density === "compact" ? "caption" : "bodyCompact"} tone={tone}>
            {children}
          </Text>
        </div>
        {actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
