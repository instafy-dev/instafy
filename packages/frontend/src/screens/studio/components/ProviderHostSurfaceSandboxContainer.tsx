import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { Text } from "../../../components/Text";
import type { ProviderHostSurfaceEntry } from "../../../providers/providerHostSurfaces";
import type { SurfaceHostActionBinding } from "./ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "./ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "./ProviderHostSurfaceCard";
import { ProviderHostSurfacePolicyNotice } from "./ProviderHostSurfacePolicyNotice";
import { useProviderHostSurfaceSandboxRuntime } from "./useProviderHostSurfaceSandboxRuntime";

type ProviderHostSurfaceSandboxContainerProps = {
  entry: ProviderHostSurfaceEntry;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
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

export function ProviderHostSurfaceSandboxContainer({
  entry,
  hostActionBindings,
  hostControlBindings,
  hostSectionBindings,
}: ProviderHostSurfaceSandboxContainerProps) {
  const {
    iframeHeight,
    iframeRef,
    iframeSrc,
    onIframeLoad,
    policy,
    sandbox,
  } = useProviderHostSurfaceSandboxRuntime({
    entry,
    hostActionBindings,
    hostControlBindings,
    hostSectionBindings,
  });
  const surfaceLabel = formatSurfaceLabel(entry.surface.surface);
  const title =
    sandbox?.title?.trim() ||
    entry.surface.title?.trim() ||
    entry.provider.title;
  const description =
    entry.surface.description?.trim() ||
    `${entry.provider.title} is mounted through an isolated provider UI container.`;
  if (!sandbox) {
    return <ProviderHostSurfacePolicyNotice entry={entry} />;
  }

  return (
    <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-3">
      <div className="flex flex-col gap-3">
        <div className="space-y-1">
          <Text variant="bodyStrong" tone="secondary">
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{surfaceLabel}</Badge>
          <Badge tone="neutral">{entry.familyId}</Badge>
          <Badge tone="neutral">{policy.renderMode}</Badge>
          <Badge tone="neutral">{sandbox.kind}</Badge>
          {sandbox.capabilities?.map((capability) => (
            <Badge key={capability} tone="neutral">
              {capability}
            </Badge>
          ))}
        </div>

        <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <iframe
            ref={iframeRef}
            title={title}
            src={iframeSrc}
            loading="lazy"
            referrerPolicy="origin"
            sandbox="allow-forms allow-modals allow-popups allow-scripts"
            allow={sandbox.allow}
            className="w-full border-0 bg-[var(--surface-base)]"
            style={{ height: `${iframeHeight}px` }}
            onLoad={onIframeLoad}
            data-testid={`provider-host-sandbox-frame-${entry.provider.id}`}
          />
        </div>

        <Text variant="caption" tone="muted">
          Sandboxed provider surfaces render here through an isolated iframe container instead of the shared host card.
        </Text>
      </div>
    </Card>
  );
}
