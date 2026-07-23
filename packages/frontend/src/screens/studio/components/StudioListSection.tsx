import type { ReactNode } from "react";
import { NavArrowDown, NavArrowRight } from "iconoir-react";
import { Text } from "../../../components/Text";

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
  return (
    <section className={["min-w-0 space-y-4", className].filter(Boolean).join(" ")} data-testid={dataTestId}>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
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
              variant="bodyStrong"
              tone="primary"
              className="truncate text-base font-semibold leading-5 tracking-[-0.015em] text-slate-900 dark:text-slate-100"
            >
              {title}
            </Text>
            {description ? (
              <Text variant="body" tone="muted" className="mt-0.5 leading-5">
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
    <div
      className={[
        "min-w-0 overflow-hidden rounded-2xl border border-slate-200/70 bg-white/85 shadow-sm shadow-slate-200/40",
        "dark:border-slate-800 dark:bg-slate-950/50 dark:shadow-black/10",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={dataTestId}
    >
      {children}
    </div>
  );
}

interface StudioListGroupHeaderProps {
  label: string;
  count: number;
  collapsed: boolean;
  onPress: () => void;
  testId: string;
}

export function StudioListGroupHeader({
  label,
  count,
  collapsed,
  onPress,
  testId,
}: StudioListGroupHeaderProps) {
  const Icon = collapsed ? NavArrowRight : NavArrowDown;
  return (
    <button
      type="button"
      className="group flex min-w-0 w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/35 focus-visible:ring-inset dark:hover:bg-slate-900/45"
      aria-expanded={!collapsed}
      onClick={onPress}
      data-testid={testId}
    >
      <Text
        as="span"
        variant="caption"
        tone="muted"
        className="min-w-0 truncate text-xxs font-medium uppercase tracking-[0.12em]"
      >
        {label}
      </Text>
      <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 px-1.5 text-3xs font-medium leading-none text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        {count}
      </span>
      <Icon
        className="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300"
        aria-hidden={true}
      />
    </button>
  );
}

interface StudioListRowProps {
  children?: ReactNode;
  separated?: boolean;
}

export function StudioListRow({ children, separated = true }: StudioListRowProps) {
  return (
    <div className={separated ? "border-t border-slate-200/70 dark:border-slate-800" : ""}>
      {children}
    </div>
  );
}
