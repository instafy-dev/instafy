import { Badge } from "../../components/Badge";
import type { ControllerTunnelGrant } from "../../sdk/instafy";
import {
  formatTunnelLabel,
  RUNTIME_BADGE_CLASSES
} from "../runtimeMenuShared";
import {
  extractTunnelEntitlementDetails,
  formatTunnelEntitlementDetail,
  resolveTunnelStatusBadge
} from "../runtimeLabels";
import { Text } from "../../components/Text";

export type TunnelCopyMode = "url" | "host";

interface RuntimeTunnelDetailsProps {
  grant: ControllerTunnelGrant;
  className?: string;
  pillTestId?: string;
  onCopy?: (mode: TunnelCopyMode, value: string | null | undefined) => void;
  copyDisabled?: boolean;
  statusBadgeTestId?: string;
}

export function RuntimeTunnelDetails({
  grant,
  className,
  pillTestId,
  statusBadgeTestId,
}: RuntimeTunnelDetailsProps) {
  if (!grant) {
    return null;
  }
  const tunnelLabel = formatTunnelLabel(grant);

  const statusBadge = resolveTunnelStatusBadge(grant);
  const entitlementDetails = extractTunnelEntitlementDetails(grant);
  const entitlementText = formatTunnelEntitlementDetail(entitlementDetails);
  const containerClass =
    className ?? "mt-1 flex flex-wrap items-center gap-2 text-xxs text-slate-500";

  return (
    <div className={containerClass}>
      <Badge
        size="xs"
        className="min-w-0 max-w-full overflow-hidden text-ellipsis border-transparent bg-slate-100 text-slate-600"
        data-testid={pillTestId}
      >
        {tunnelLabel}
      </Badge>
      {statusBadge ? (
        <Badge
          size="xs"
          className={`border-transparent ${RUNTIME_BADGE_CLASSES[statusBadge.tone]}`}
          data-testid={statusBadgeTestId}
        >
          {statusBadge.text}
        </Badge>
      ) : null}
      {entitlementText ? (
        <Text as="span" variant="caption" tone="danger" className="text-3xs font-medium">
          {entitlementText}
        </Text>
      ) : null}
    </div>
  );
}
