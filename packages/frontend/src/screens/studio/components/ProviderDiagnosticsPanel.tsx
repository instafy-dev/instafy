import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import {
  discoverLocalProvider,
  postLocalProviderTransportProbe,
  readLocalProviderResource,
  type LocalProviderSummary,
} from "../../../capabilities/localProviderHostClient";
import { resolveExtensionDefinition } from "../../../extensions/extensionCatalog";

type ProviderDiagnosticsPanelProps = {
  provider: LocalProviderSummary;
  onRefreshProviders?: () => Promise<void>;
  allowCollapse?: boolean;
  autoDiscoverOnExpand?: boolean;
};

type PendingDiagnosticsAction = "discover" | "read_resource" | "transport_probe" | null;

type DiagnosticsOutput = {
  label: string;
  value: unknown;
} | null;

function normalizeStringArray(values: Iterable<string | null | undefined>) {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function formatProviderLabel(provider: LocalProviderSummary) {
  return resolveExtensionDefinition({ provider }).title;
}

function collectToolIds(provider: LocalProviderSummary, discoveredProvider: Record<string, unknown> | null) {
  const discoveredToolIds = Array.isArray(discoveredProvider?.tool_surfaces)
    ? discoveredProvider.tool_surfaces
        .map((tool) =>
          tool && typeof tool === "object" && typeof tool.id === "string" ? tool.id.trim() : "",
        )
        .filter(Boolean)
    : [];
  return normalizeStringArray([...(provider.toolIds ?? []), ...discoveredToolIds]);
}

function collectResourceUris(
  provider: LocalProviderSummary,
  discoveredProvider: Record<string, unknown> | null,
) {
  const discoveredResourceUris = Array.isArray(discoveredProvider?.resources)
    ? discoveredProvider.resources
        .map((resource) =>
          resource && typeof resource === "object" && typeof resource.uri === "string"
            ? resource.uri.trim()
            : "",
        )
        .filter(Boolean)
    : [];
  return normalizeStringArray([...(provider.resourceUris ?? []), ...discoveredResourceUris]);
}

function resolvePreferredDiagnosticResourceUri(resourceUris: string[]) {
  const normalized = normalizeStringArray(resourceUris);
  if (normalized.length === 0) {
    return null;
  }

  const preferredPatterns = [/status/i, /health/i, /summary/i, /state/i];
  const discouragedPatterns = [/manifest/i, /profile/i, /replay/i, /session/i];

  const preferred = normalized.find(
    (uri) =>
      preferredPatterns.some((pattern) => pattern.test(uri)) &&
      !discouragedPatterns.some((pattern) => pattern.test(uri)),
  );
  return preferred ?? normalized[0] ?? null;
}

function formatDiagnosticsValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ProviderDiagnosticsPanel({
  provider,
  onRefreshProviders,
  allowCollapse = true,
  autoDiscoverOnExpand = true,
}: ProviderDiagnosticsPanelProps) {
  const [expanded, setExpanded] = useState(!allowCollapse);
  const [pendingAction, setPendingAction] = useState<PendingDiagnosticsAction>(null);
  const [discoveredProvider, setDiscoveredProvider] = useState<Record<string, unknown> | null>(null);
  const [output, setOutput] = useState<DiagnosticsOutput>(null);
  const [error, setError] = useState<string | null>(null);

  const toolIds = useMemo(
    () => collectToolIds(provider, discoveredProvider),
    [discoveredProvider, provider],
  );
  const resourceUris = useMemo(
    () => collectResourceUris(provider, discoveredProvider),
    [discoveredProvider, provider],
  );
  const preferredResourceUri = useMemo(
    () => resolvePreferredDiagnosticResourceUri(resourceUris),
    [resourceUris],
  );
  const transportProbeSupported =
    typeof discoveredProvider?.transport_probe_supported === "boolean"
      ? discoveredProvider.transport_probe_supported
      : provider.transportProbeSupported === true;

  const runDiscovery = useCallback(async () => {
    setPendingAction("discover");
    setError(null);
    try {
      const result = await discoverLocalProvider(provider.id);
      const nextProvider =
        result.provider && typeof result.provider === "object" && !Array.isArray(result.provider)
          ? result.provider
          : null;
      setDiscoveredProvider(nextProvider);
      setOutput({
        label: "Latest discovery",
        value: nextProvider ?? result,
      });
      await onRefreshProviders?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [onRefreshProviders, provider.id]);

  const handleToggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  useEffect(() => {
    if (!expanded || !autoDiscoverOnExpand || discoveredProvider || output || pendingAction !== null) {
      return;
    }
    void runDiscovery();
  }, [autoDiscoverOnExpand, discoveredProvider, expanded, output, pendingAction, runDiscovery]);

  const handleReadResource = useCallback(async () => {
    if (!preferredResourceUri) {
      return;
    }
    setPendingAction("read_resource");
    setError(null);
    try {
      const result = await readLocalProviderResource(provider.id, preferredResourceUri);
      setOutput({
        label: `Resource read: ${preferredResourceUri}`,
        value: result,
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [preferredResourceUri, provider.id]);

  const handleTransportProbe = useCallback(async () => {
    setPendingAction("transport_probe");
    setError(null);
    try {
      const result = await postLocalProviderTransportProbe(provider.id, {
        readStatus: true,
        drainPending: true,
        skipCommand: true,
      });
      setOutput({
        label: "Transport probe",
        value: result,
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [provider.id]);

  return (
    <div className="space-y-3">
      {allowCollapse ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={expanded ? "secondary" : "ghost"}
            size="xs"
            radius="full"
            onPress={handleToggleExpanded}
            data-testid={`project-provider-diagnostics-toggle-${provider.id}`}
          >
            {expanded ? "Hide diagnostics" : "Diagnostics"}
          </Button>
          {expanded ? (
            <Badge tone="neutral" size="xs">
              {formatProviderLabel(provider)}
            </Badge>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" size="xs">
            {formatProviderLabel(provider)}
          </Badge>
        </div>
      )}

      {expanded ? (
        <div
          className="space-y-3 rounded-2xl border border-slate-200/70 bg-slate-50/80 px-3 py-3 shadow-sm shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900/30 dark:shadow-none"
          data-testid={`project-provider-diagnostics-panel-${provider.id}`}
        >
          <div className="space-y-2">
            <Text variant="caption" tone="muted">
              Diagnostics use the same local provider host endpoints that chat, Robot Lab, and future runtime skills use.
            </Text>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null}
                onPress={() => {
                  void runDiscovery();
                }}
                data-testid={`project-provider-diagnostics-refresh-${provider.id}`}
              >
                {pendingAction === "discover" ? "Refreshing…" : "Refresh discovery"}
              </Button>
              <Button
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null || !preferredResourceUri}
                onPress={() => {
                  void handleReadResource();
                }}
                data-testid={`project-provider-diagnostics-read-resource-${provider.id}`}
              >
                {pendingAction === "read_resource" ? "Reading…" : "Read status resource"}
              </Button>
              <Button
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null || !transportProbeSupported}
                onPress={() => {
                  void handleTransportProbe();
                }}
                data-testid={`project-provider-diagnostics-probe-${provider.id}`}
              >
                {pendingAction === "transport_probe" ? "Probing…" : "Probe transport"}
              </Button>
              {(output || error) ? (
                <Button
                  variant="ghost"
                  size="xs"
                  radius="full"
                  isDisabled={pendingAction !== null}
                  onPress={() => {
                    setOutput(null);
                    setError(null);
                  }}
                  data-testid={`project-provider-diagnostics-clear-${provider.id}`}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Text variant="caption" tone="muted">
              Advertised tools: {toolIds.length > 0 ? toolIds.join(", ") : "Not advertised yet"}
            </Text>
            <Text variant="caption" tone="muted">
              Advertised resources: {resourceUris.length > 0 ? resourceUris.join(", ") : "Not advertised yet"}
            </Text>
            <Text variant="caption" tone="muted">
              Preferred status resource: {preferredResourceUri ?? "Unavailable"}
            </Text>
            <Text variant="caption" tone="muted">
              Transport probe: {transportProbeSupported ? "Supported" : "Unavailable"}
            </Text>
          </div>

          {error ? (
            <div className="space-y-1">
              <Text variant="caption" tone="warning">
                Diagnostics error
              </Text>
              <Text variant="caption" tone="warning">
                {error}
              </Text>
            </div>
          ) : null}

          {output ? (
            <div className="space-y-2">
              <Text variant="caption" tone="secondary">
                {output.label}
              </Text>
              <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-slate-950/95 font-mono text-xs shadow-sm shadow-slate-900/10 dark:border-white/10 dark:bg-slate-950">
                <pre
                  className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-slate-100"
                  data-testid={`project-provider-diagnostics-output-${provider.id}`}
                >
                  {formatDiagnosticsValue(output.value)}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
