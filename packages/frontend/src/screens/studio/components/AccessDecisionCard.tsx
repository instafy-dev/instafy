import type { ReactNode } from "react";
import { Surface, type SurfaceProps } from "../../../components/Surface";
import { Text } from "../../../components/Text";

const ACCESS_CARD_BASE_CLASS_NAME =
  "relative w-full max-w-[min(100%,42rem)] min-w-0 overflow-hidden border-slate-200/70 p-5 text-sm dark:border-white/10 sm:p-6";

const ACCESS_CARD_DECISION_CLASS_NAME =
  "bg-[radial-gradient(circle_at_8%_0%,rgba(37,99,235,0.06),transparent_35%),linear-gradient(145deg,rgba(255,255,255,0.96),rgba(248,250,252,0.88))] shadow-card-lg dark:bg-[radial-gradient(circle_at_10%_0%,rgba(59,130,246,0.2),transparent_34%),linear-gradient(145deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025))] dark:shadow-modal";

const ACCESS_CARD_RESOLVED_CLASS_NAME =
  "bg-white/92 shadow-none dark:bg-white/[0.05] dark:shadow-none";

// Size and tracking only: AccessSectionLabel's tone owns the colour, and a
// grey here fought it (slate-500 painted in light and dark alike).
export const ACCESS_SECTION_LABEL_CLASS_NAME = "text-xxs tracking-[0.18em]";

function joinClassNames(...values: Array<string | undefined | null | false>) {
  return values.filter(Boolean).join(" ");
}

export function AccessDecisionCard({
  className,
  children,
  resolved = false,
  tone = "default",
  radius = "3xl",
  shadow,
  ...props
}: SurfaceProps & { resolved?: boolean }) {
  return (
    <Surface
      {...props}
      tone={tone}
      radius={radius}
      shadow={shadow ?? (resolved ? "none" : "lg")}
      className={joinClassNames(
        ACCESS_CARD_BASE_CLASS_NAME,
        resolved ? ACCESS_CARD_RESOLVED_CLASS_NAME : ACCESS_CARD_DECISION_CLASS_NAME,
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-white/25" />
      {children}
    </Surface>
  );
}

export function AccessDecisionContent({
  icon,
  title,
  description,
  children,
  bodyPlacement = "content",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  bodyPlacement?: "content" | "full";
}) {
  const header = (
    <div className="flex items-start gap-5">
      {icon ? (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-sm shadow-slate-950/10 dark:border-white/15 dark:bg-white dark:text-slate-950 dark:shadow-black/30">
          {icon}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <Text as="div" variant="titleCompact" tone="primary">
          {title}
        </Text>
        {description ? (
          <Text as="div" variant="bodyRoomy" tone="muted" className="mt-1">
            {description}
          </Text>
        ) : null}
        {bodyPlacement === "content" ? children : null}
      </div>
    </div>
  );

  if (bodyPlacement === "full") {
    return (
      <div>
        {header}
        {children}
      </div>
    );
  }

  return (
    header
  );
}

export function AccessSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Text
      as="div"
      variant="overline"
      tone="muted"
      className={joinClassNames(ACCESS_SECTION_LABEL_CLASS_NAME, className)}
    >
      {children}
    </Text>
  );
}

export function AccessPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-slate-200/70 bg-slate-900/[0.04] px-3 py-1 text-xs font-medium text-slate-700 shadow-inner shadow-white/60 dark:border-white/10 dark:bg-white/[0.08] dark:text-slate-100 dark:shadow-none">
      {children}
    </span>
  );
}
