import { Copy } from "iconoir-react";
import { Badge } from "../../components/Badge";
import { IconButton } from "../../components/Button";
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
  onCopy?: (mode: TunnelCopyMode) => void;
  copyDisabled?: boolean;
  copyTestId?: string;
  statusBadgeTestId?: string;
}

export function RuntimeTunnelDetails({
  grant,
  className,
  pillTestId,
  onCopy,
  copyDisabled = false,
  copyTestId,
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
    className ??
    "mt-1 flex flex-wrap items-center gap-2 text-xxs text-slate-500 dark:text-slate-400";

  return (
    <div className={containerClass}>
      <Badge
        size="xs"
        className="min-w-0 max-w-full overflow-hidden text-ellipsis border-transparent bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300"
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
      {onCopy ? (
        <IconButton
          type="button"
          variant="ghost"
          size="xs"
          radius="full"
          onPress={() => onCopy("url")}
          isDisabled={copyDisabled}
          aria-label="Copy tunnel URL"
          data-testid={copyTestId}
          className="shrink-0 text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
