import type { ReactNode } from "react";
import { Text } from "../../../components/Text";
import { useHeadingRepeatedInSettingsNavigation } from "../../../components/SettingsNavigationLabelContext";
import { Surface } from "../../../components/Surface";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";

type StudioListTone = "neutral" | "attention" | "activity" | "suggestion";

// One quiet shell for every section icon — the earlier per-section hues
// (rose/sky/violet) put three competing accents on one screen and fought the
// single-accent brand. Urgency is carried by badges and row status icons.
const SECTION_ICON_NEUTRAL_CLASSES =
  "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300";
const SECTION_ICON_TONE_CLASSES: Record<StudioListTone, string> = {
  neutral: SECTION_ICON_NEUTRAL_CLASSES,
  attention: SECTION_ICON_NEUTRAL_CLASSES,
  activity: SECTION_ICON_NEUTRAL_CLASSES,
  suggestion: SECTION_ICON_NEUTRAL_CLASSES,
};

interface StudioListSectionProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: StudioListTone;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function StudioListSection({
  title,
  description,
  icon,
  tone = "neutral",
  actions,
  children,
  className,
  "data-testid": dataTestId,
}: StudioListSectionProps) {
  const repeatedHeading = useHeadingRepeatedInSettingsNavigation(title);
  return (
    <section className={["min-w-0 space-y-4", className].filter(Boolean).join(" ")} data-testid={dataTestId}>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && !repeatedHeading ? (
            <span
              className={[
                "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                SECTION_ICON_TONE_CLASSES[tone],
              ].join(" ")}
              aria-hidden={true}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <Text
              as="h2"
              variant="subtitleStrong"
              tone="primary"
              className={repeatedHeading ? "sr-only" : "truncate"}
            >
              {title}
            </Text>
            {description ? (
              <Text variant="bodyCompact" tone="muted" className={repeatedHeading ? undefined : "mt-0.5"}>
                {description}
              </Text>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center justify-end">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

interface StudioListSurfaceProps {
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function StudioListSurface({ children, className, "data-testid": dataTestId }: StudioListSurfaceProps) {
  return (
    <Surface
      tone="default"
      shadow="none"
      className={["min-w-0 overflow-hidden", className].filter(Boolean).join(" ")}
      data-testid={dataTestId}
    >
      {children}
    </Surface>
  );
}

interface StudioListRowProps {
  children?: ReactNode;
  separated?: boolean;
}

export function StudioListRow({ children, separated = true }: StudioListRowProps) {
  return (
    <div className={separated ? `border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}` : ""}>
      {children}
    </div>
  );
}
