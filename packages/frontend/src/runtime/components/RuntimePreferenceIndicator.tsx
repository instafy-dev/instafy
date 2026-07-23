import { RuntimeOptionMeta } from "./RuntimeOptionMeta";
import { RuntimeStateIndicator } from "../runtimeMenuShared";
import type { RuntimeMenuOption } from "../useRuntimeMenu";
import { Text } from "../../components/Text";
import {
  formatFallbackRuntimeLabel,
  formatRuntimeSourceLabel,
  type RuntimePreferenceDetails,
} from "../runtimePreferenceUtils";

interface RuntimePreferenceIndicatorProps {
  preference: RuntimePreferenceDetails | null;
  runtimeOptionsById: Map<string, RuntimeMenuOption>;
  className?: string;
}

export function RuntimePreferenceIndicator({
  preference,
  runtimeOptionsById,
  className,
}: RuntimePreferenceIndicatorProps) {
  if (!preference) {
    return null;
  }

  const runtimeOption = preference.runtimeId
    ? runtimeOptionsById.get(preference.runtimeId)
    : null;
  const fallbackOption: RuntimeMenuOption =
    runtimeOption ??
    ({
      id: preference.runtimeId,
      label:
        preference.displayName ??
        formatFallbackRuntimeLabel(preference.runtimeId),
      detail: null,
      state: "offline",
      badge: null,
      isSessionOverride: false,
      needsActivation: false,
      isLikelyLocal: false,
      tunnel: null,
      endpoint: null,
      launchedAt: null,
    } as RuntimeMenuOption);
  const runtimeSourceLabel = formatRuntimeSourceLabel(preference.source);

  return (
    <Text
      as="div"
      variant="caption"
      tone="muted"
      className={`flex flex-wrap items-center gap-3 text-xxs ${className ?? ""}`.trim()}
    >
      <span className="inline-flex items-center gap-2">
        <RuntimeStateIndicator option={fallbackOption} />
        <RuntimeOptionMeta
          option={fallbackOption}
          showSessionBadge={false}
          className="flex flex-col text-xxs text-slate-600"
          detailClassName="text-3xs text-slate-400"
        />
      </span>
      {runtimeSourceLabel ? (
        <Text as="span" variant="caption" tone="subtle" className="text-xxs">
          {runtimeSourceLabel}
        </Text>
      ) : null}
    </Text>
  );
}
