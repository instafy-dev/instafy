import type { ReactNode } from "react";
import { CheckCircle, InfoCircle, WarningTriangle } from "iconoir-react";
import { Button, type ButtonProps } from "../../../components/Button";
import { Surface, type SurfaceProps } from "../../../components/Surface";
import { Text } from "../../../components/Text";

const ACCESS_CARD_BASE_CLASS_NAME =
  "relative w-full max-w-[min(100%,42rem)] min-w-0 overflow-hidden border-slate-200/70 p-5 text-sm dark:border-white/10 sm:p-6";

const ACCESS_CARD_DECISION_CLASS_NAME =
  "bg-[radial-gradient(circle_at_8%_0%,rgba(37,99,235,0.13),transparent_35%),linear-gradient(145deg,rgba(255,255,255,0.96),rgba(248,250,252,0.88))] shadow-card-lg dark:bg-[radial-gradient(circle_at_10%_0%,rgba(59,130,246,0.2),transparent_34%),linear-gradient(145deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025))] dark:shadow-modal";

const ACCESS_CARD_RESOLVED_CLASS_NAME =
  "bg-white/92 shadow-none dark:bg-white/[0.05] dark:shadow-none";

export const ACCESS_SECTION_LABEL_CLASS_NAME =
  "text-xxs tracking-[0.18em] text-slate-500 dark:text-slate-400";

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
        <Text as="div" variant="bodyStrong" tone="primary" className="text-lg text-slate-950 dark:text-white">
          {title}
        </Text>
        {description ? (
          <Text as="div" variant="body" tone="muted" className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
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
      tone="subtle"
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

type AccessStatusTone = "success" | "info" | "warning" | "danger";

const ACCESS_STATUS_PANEL_CLASS_NAMES: Record<AccessStatusTone, string> = {
  success:
    "border-emerald-200/70 bg-emerald-50/80 text-emerald-950 shadow-emerald-950/5 dark:border-emerald-300/20 dark:bg-emerald-400/10 dark:text-emerald-100",
  info:
    "border-sky-200/70 bg-sky-50/80 text-sky-950 shadow-sky-950/5 dark:border-sky-300/20 dark:bg-sky-400/10 dark:text-sky-100",
  warning:
    "border-amber-200/80 bg-amber-50/80 text-amber-950 shadow-amber-950/5 dark:border-amber-300/20 dark:bg-amber-400/10 dark:text-amber-100",
  danger:
    "border-rose-200/80 bg-rose-50/80 text-rose-950 shadow-rose-950/5 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-100",
};

const ACCESS_STATUS_ICON_CLASS_NAMES: Record<AccessStatusTone, string> = {
  success: "bg-emerald-500 text-white shadow-emerald-950/20 dark:bg-emerald-300 dark:text-emerald-950",
  info: "bg-sky-500 text-white shadow-sky-950/20 dark:bg-sky-300 dark:text-sky-950",
  warning: "bg-amber-400 text-amber-950 shadow-amber-950/20 dark:bg-amber-300 dark:text-amber-950",
  danger: "bg-rose-500 text-white shadow-rose-950/20 dark:bg-rose-300 dark:text-rose-950",
};

const ACCESS_STATUS_DESCRIPTION_CLASS_NAMES: Record<AccessStatusTone, string> = {
  success: "text-emerald-800 dark:text-emerald-100/80",
  info: "text-sky-800 dark:text-sky-100/80",
  warning: "text-amber-800 dark:text-amber-100/80",
  danger: "text-rose-800 dark:text-rose-100/80",
};

function AccessStatusIcon({ tone, icon }: { tone: AccessStatusTone; icon?: ReactNode }) {
  const Icon =
    tone === "success"
      ? CheckCircle
      : tone === "info"
        ? InfoCircle
        : WarningTriangle;

  return (
    <span
      className={joinClassNames(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full shadow-sm",
        ACCESS_STATUS_ICON_CLASS_NAMES[tone],
      )}
    >
      {icon ?? <Icon className="h-4 w-4" aria-hidden="true" />}
    </span>
  );
}

export function AccessStatusPanel({
  title,
  description,
  action,
  icon,
  tone = "success",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: AccessStatusTone;
  className?: string;
}) {
  return (
    <div
      className={joinClassNames(
        "flex w-full flex-row items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm shadow-sm",
        ACCESS_STATUS_PANEL_CLASS_NAMES[tone],
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <AccessStatusIcon tone={tone} icon={icon} />
        <span className="min-w-0">
          <span className="block font-semibold">{title}</span>
          {description ? (
            <span className={joinClassNames("mt-0.5 block text-sm", ACCESS_STATUS_DESCRIPTION_CLASS_NAMES[tone])}>
              {description}
            </span>
          ) : null}
        </span>
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

type AccessProviderChoiceButtonProps = Omit<
  ButtonProps,
  "children" | "className" | "fullWidth" | "radius" | "size" | "variant"
> & {
  icon: ReactNode;
  title: string;
  description: string;
  featured?: boolean;
  className?: string;
};

export function AccessProviderChoiceButton({
  icon,
  title,
  description,
  featured = false,
  className,
  ...props
}: AccessProviderChoiceButtonProps) {
  return (
    <Button
      {...props}
      variant="ghost"
      size="sm"
      radius="2xl"
      fullWidth
      className={joinClassNames(
        "items-start justify-start gap-3 border p-3 text-left shadow-sm",
        featured
          ? "border-primary-200/80 bg-primary-50/80 shadow-primary-600/10 hover:bg-primary-100/80 data-[hovered]:bg-primary-100/80 dark:border-primary-400/25 dark:bg-primary-400/10 dark:hover:bg-primary-400/15 dark:data-[hovered]:bg-primary-400/15"
          : "border-slate-200/70 bg-white/70 shadow-slate-950/5 hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.07] dark:data-[hovered]:bg-white/[0.07]",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0">
          <span className="block font-semibold text-slate-950 dark:text-white">{title}</span>
          <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-300">
            {description}
          </span>
        </span>
      </span>
    </Button>
  );
}
