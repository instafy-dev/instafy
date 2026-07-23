import { Badge } from "../../components/Badge";
import {
  useProviderSandboxCapabilityProfile,
  useProviderSandboxHostData,
  useProviderSandboxHostMutations,
  useProviderSandboxSurfaceInfo,
} from "./providerSandboxSdk";

function formatLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function ProviderSurfaceSandboxHeader() {
  const capabilityProfile = useProviderSandboxCapabilityProfile();
  const hostData = useProviderSandboxHostData();
  const hostMutations = useProviderSandboxHostMutations();
  const surfaceInfo = useProviderSandboxSurfaceInfo();
  const providerId = surfaceInfo.providerId ?? "provider";
  const surfaceId = surfaceInfo.surfaceId ?? "surface";
  const providerTitle = surfaceInfo.providerTitle?.trim() || formatLabel(providerId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Sandboxed provider surface</Badge>
        <Badge tone="neutral">{providerId}</Badge>
        <Badge tone="neutral">{surfaceId}</Badge>
        {surfaceInfo.resolvedTheme ? <Badge tone="neutral">{surfaceInfo.resolvedTheme}</Badge> : null}
        {surfaceInfo.stateToken ? (
          <Badge tone="neutral">{surfaceInfo.stateToken.slice(0, 8)}</Badge>
        ) : null}
        {hostData.pendingInvalidatedResourceIds.map((resourceId) => (
          <Badge key={resourceId} tone="warning">
            {resourceId}
          </Badge>
        ))}
        {capabilityProfile.capabilities.map((capability) => (
          <Badge key={capability} tone="neutral">
            {capability}
          </Badge>
        ))}
        {hostMutations.actions.map((action) => (
          <Badge key={action.id} tone="neutral">
            {action.label}
          </Badge>
        ))}
        {hostMutations.controls.map((control) => (
          <Badge key={control.id} tone="neutral">
            {control.label}
          </Badge>
        ))}
        {hostData.sections.map((section) => (
          <Badge key={section.id} tone="neutral">
            {section.title ?? section.id}
          </Badge>
        ))}
        {hostData.resources.map((resource) => (
          <Badge key={resource.id} tone="neutral">
            {resource.title ?? resource.id}
          </Badge>
        ))}
      </div>

      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{providerTitle}</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          This route is mounted inside an isolated iframe container for the{" "}
          {formatLabel(surfaceId).toLowerCase()} slot.
        </p>
      </div>
    </div>
  );
}
