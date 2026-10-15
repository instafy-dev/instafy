import { Badge } from "../../components/Badge";
import { Text } from "../../components/Text";
import type { RuntimeMenuOption } from "../useRuntimeMenu";

interface RuntimeOptionMetaProps {
  option: RuntimeMenuOption;
  className?: string;
  detailClassName?: string;
  showSessionBadge?: boolean;
  showDetail?: boolean;
  showProviderBadge?: boolean;
  showRuntimeIdBadge?: boolean;
}

const toneClassName: Record<"neutral" | "warning" | "danger", string> = {
  neutral: "bg-slate-100 text-slate-600",
  warning: "bg-secondary-100 text-secondary-700",
  danger: "bg-rose-100 text-rose-700",
};

export function RuntimeOptionMeta({
  option,
  className,
  detailClassName,
  showSessionBadge = true,
  showDetail = true,
  showProviderBadge = true,
  showRuntimeIdBadge = false,
}: RuntimeOptionMetaProps) {
  const containerClass = className ?? "flex min-w-0 flex-col gap-1";
  const detailClass = detailClassName ?? "block break-words";
  const providerBadge = option.providerLabel ?? option.provider ?? null;
  const runtimeIdShort =
    typeof option.id === "string" && option.id.trim().length > 0
      ? option.id.trim().slice(0, 8)
      : null;

  return (
    <div className={containerClass}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Text
          as="span"
          variant="bodyStrong"
          tone="secondary"
          className="min-w-0 max-w-full truncate"
          title={option.label}
        >
          {option.label}
        </Text>
        {showProviderBadge && providerBadge ? (
          <Badge size="xs" className="border-transparent bg-slate-100 text-slate-700">
            {providerBadge}
          </Badge>
        ) : null}
        {option.badge ? (
          <Badge
            size="xs"
            className={`border-transparent ${toneClassName[option.badge.tone ?? "neutral"]}`}
          >
            {option.badge.text}
          </Badge>
        ) : null}
        {showSessionBadge && option.isSessionOverride ? (
          <Badge size="xs" className="border-transparent bg-slate-100 text-slate-600">
            Session
          </Badge>
        ) : null}
        {showRuntimeIdBadge && runtimeIdShort ? (
          // Keep the technical identifier secondary to the machine name;
          // hover reveals the full id without a second details row.
          <Text
            as="span"
            variant="mono"
            tone="muted"
            title={option.id ?? undefined}
            className="shrink-0"
          >
            rt:{runtimeIdShort}
          </Text>
        ) : null}
      </div>
      {showDetail && option.detail ? (
        <Text as="span" variant="caption" tone="muted" className={detailClass}>
          {option.detail}
        </Text>
      ) : null}
    </div>
  );
}
