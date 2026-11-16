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
          tone="primary"
          className="min-w-0 max-w-full truncate"
          title={option.label}
        >
          {option.label}
        </Text>
        {showProviderBadge && providerBadge ? (
          <Badge size="xs" className="border-transparent">
            {providerBadge}
          </Badge>
        ) : null}
        {option.badge ? (
          <Badge size="xs" tone={option.badge.tone ?? "neutral"}>
            {option.badge.text}
          </Badge>
        ) : null}
        {showSessionBadge && option.isSessionOverride ? (
          <Badge size="xs" className="border-transparent">
            Session
          </Badge>
        ) : null}
        {showRuntimeIdBadge && runtimeIdShort ? (
          // Keep the technical identifier secondary to the machine name;
          // hover reveals the full id without a second details row.
          <Text
            as="span"
            variant="mono"
            tone="secondary"
            title={option.id ?? undefined}
            className="shrink-0"
          >
            rt:{runtimeIdShort}
          </Text>
        ) : null}
      </div>
      {showDetail && option.detail ? (
        <Text as="span" variant="bodyCompact" tone="secondary" className={detailClass}>
          {option.detail}
        </Text>
      ) : null}
    </div>
  );
}
