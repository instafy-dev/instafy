import { Text } from "../../../components/Text";

type ExtensionDeveloperDetailsProps = {
  eligibleAssistantLabel: string;
  kindLabel?: string | null;
  discoveredCapabilityLabel: string;
  projectCapabilityLabel: string;
  integrationId?: string | null;
  source: "host" | "project_integration" | "native_runtime";
};

export function ExtensionDeveloperDetails({
  eligibleAssistantLabel,
  kindLabel,
  discoveredCapabilityLabel,
  projectCapabilityLabel,
  integrationId,
  source,
}: ExtensionDeveloperDetailsProps) {
  return (
    <div className="space-y-1">
      <Text variant="caption" tone="muted">
        Eligible assistants: {eligibleAssistantLabel}
      </Text>
      {kindLabel ? (
        <Text variant="caption" tone="muted">
          Family: {kindLabel}
        </Text>
      ) : null}
      <Text variant="caption" tone="muted">
        {source === "host" ? "Discovered capabilities" : "Extension capabilities"}:{" "}
        {discoveredCapabilityLabel}
      </Text>
      <Text variant="caption" tone="muted">
        Space scope: {projectCapabilityLabel}
      </Text>
      {integrationId ? (
        <Text variant="caption" tone="muted">
          Integration record: {integrationId}
        </Text>
      ) : null}
      {source === "project_integration" ? (
        <Text variant="caption" tone="muted">
          This row is coming from saved project policy rather than live extension discovery.
        </Text>
      ) : null}
      {source === "native_runtime" ? (
        <Text variant="caption" tone="muted">
          This row is coming from the current device runtime rather than live extension discovery.
        </Text>
      ) : null}
    </div>
  );
}
