import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { Text } from "../../../components/Text";
import {
  resolveProviderHostSurfacePolicy,
  type ProviderHostSurfaceEntry,
} from "../../../providers/providerHostSurfaces";

type ProviderHostSurfacePolicyNoticeProps = {
  entry: ProviderHostSurfaceEntry;
};

function formatSurfaceLabel(surface: string) {
  switch (surface) {
    case "settings_card":
      return "Settings card";
    case "status_card":
      return "Status card";
    case "detail_view":
      return "Detail view";
    case "extension_tile":
      return "Extension tile";
    default:
      return surface.replace(/[_-]+/g, " ");
  }
}

export function ProviderHostSurfacePolicyNotice({
  entry,
}: ProviderHostSurfacePolicyNoticeProps) {
  const policy = resolveProviderHostSurfacePolicy(entry);
  const surfaceLabel = formatSurfaceLabel(entry.surface.surface);
  const description =
    entry.surface.description?.trim() ||
    `${entry.provider.title} declares this ${surfaceLabel.toLowerCase()} through a sandboxed provider surface.`;

  return (
    <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-3">
      <div className="flex flex-col gap-3">
        <div className="space-y-1">
          <Text variant="bodyStrong" tone="secondary">
            {entry.surface.title?.trim() || entry.provider.title}
          </Text>
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{surfaceLabel}</Badge>
          <Badge tone="neutral">{entry.familyId}</Badge>
          <Badge tone="neutral">{policy.renderMode}</Badge>
        </div>

        <div className="space-y-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2">
          <Text variant="caption" tone="secondary">
            This provider surface is reserved for an isolated provider UI container.
          </Text>
          <Text variant="caption" tone="muted">
            Settings and Extensions keep using the shared host renderer for trusted declarative and interactive
            surfaces. Sandboxed surfaces fall back to this notice until the provider declares a sandbox container
            descriptor for this shell slot.
          </Text>
        </div>
      </div>
    </Card>
  );
}
