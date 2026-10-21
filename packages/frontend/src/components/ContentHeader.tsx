import type { ReactNode } from "react";
import { Text } from "./Text";
import { DARK_DIVIDER_BORDER_CLASS, DARK_PANEL_SOFT_BG_CLASS } from "../theme/darkSurfaces";

interface ContentHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Resource paths stay on one line; explanatory text wraps by default. */
  truncateSubtitle?: boolean;
  titleAs?: "h2" | "h3" | "h4" | "p";
  /** Full resource name when the visible title is truncated. */
  titleText?: string;
  /** An enclosing tab already names this content. Keep its heading accessible. */
  titleHidden?: boolean;
  icon?: ReactNode;
  leading?: ReactNode;
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  density?: "default" | "compact";
  tone?: "default" | "subtle";
  "data-testid"?: string;
}

/**
 * Headers within working content, such as file viewers and repeated diff files.
 * Density changes spacing, never typography or pointer-aware action targets.
 * The header owns the single divider between its controls and their content.
 */
export function ContentHeader({
  title,
  subtitle,
  truncateSubtitle = false,
  titleAs = "h3",
  titleText,
  titleHidden = false,
  icon,
  leading,
  titleAccessory,
  actions,
  density = "default",
  tone = "default",
  "data-testid": testId,
}: ContentHeaderProps) {
  return (
    <div
      className={[
        "flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 px-4",
        DARK_DIVIDER_BORDER_CLASS,
        density === "compact" ? "py-1.5" : "py-2",
        tone === "subtle" ? `bg-slate-50/80 ${DARK_PANEL_SOFT_BG_CLASS}` : "",
      ].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        {icon && !titleHidden ? (
          <Text as="span" tone="muted" aria-hidden="true" className="flex shrink-0 items-center [&>svg]:size-4">
            {icon}
          </Text>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Text as={titleAs} variant="bodyStrong" tone="primary" title={titleText}
              className={titleHidden ? "sr-only" : "min-w-0 truncate"}>
              {title}
            </Text>
            {titleAccessory ? <div className="shrink-0">{titleAccessory}</div> : null}
          </div>
          {subtitle && !titleHidden ? (
            <Text variant="caption" tone="muted" className={`mt-0.5 ${truncateSubtitle ? "truncate" : "break-words"}`}
              title={truncateSubtitle && typeof subtitle === "string" ? subtitle : undefined}>{subtitle}</Text>
          ) : null}
        </div>
      </div>
      {actions ? <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
