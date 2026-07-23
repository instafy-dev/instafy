// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as providerSandboxSdk from "../providerSandboxSdk";
import { createProviderSandboxSnapshot } from "../providerSandboxSnapshot";
import {
  ProviderSandboxSdkProvider,
  useProviderSandboxCapabilityProfile,
  useProviderSandboxHostData,
  useProviderSandboxHostMutations,
  useProviderSandboxSurfaceInfo,
} from "../providerSandboxSdk";

function renderSandboxSdkProbe(hostState: Record<string, unknown> | null) {
  function Probe() {
    const info = useProviderSandboxSurfaceInfo();
    const capabilityProfile = useProviderSandboxCapabilityProfile();
    const hostData = useProviderSandboxHostData();
    const hostMutations = useProviderSandboxHostMutations();
    return (
      <div>
        <span>{info.providerId ?? "missing-provider"}</span>
        <span>{info.surfaceId ?? "missing-surface"}</span>
        <span>{capabilityProfile.canMutateHost ? "can-mutate-host" : "read-only-host"}</span>
        <span>{hostData.canReadHostData ? "can-read-host-data" : "no-host-data"}</span>
        <span>{hostMutations.controls.map((control) => control.id).join(",") || "no-controls"}</span>
        <span>{hostData.resources.map((resource) => resource.id).join(",") || "no-resources"}</span>
      </div>
    );
  }

  return renderToStaticMarkup(
    <ProviderSandboxSdkProvider
      snapshot={createProviderSandboxSnapshot({
        hostState: hostState as never,
        fallbackProviderId: "fallback-provider",
        fallbackSurfaceId: "fallback-surface",
      })}
    >
      <Probe />
    </ProviderSandboxSdkProvider>,
  );
}

describe("providerSandboxSdk", () => {
  it("exports only the grouped provider-facing host hooks", () => {
    expect("createProviderSandboxSnapshot" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxClient" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxPendingInvalidatedResourceIds" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostActions" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostAction" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostControls" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostControl" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostSections" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostSection" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostResources" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostResource" in providerSandboxSdk).toBe(false);
    expect("useProviderSandboxHostData" in providerSandboxSdk).toBe(true);
    expect("useProviderSandboxHostMutations" in providerSandboxSdk).toBe(true);
  });

  it("gates host collections by granted capabilities", () => {
    const html = renderSandboxSdkProbe({
      version: 1,
      providerId: "simulated-devices",
      providerTitle: "Simulated devices",
      familyId: "simulated-devices",
      surfaceId: "settings_card",
      resolvedTheme: "light",
      grantedCapabilities: ["host_controls"],
      hostControls: [
        {
          id: "simulated_device_power_state",
          kind: "toggle",
          label: "Power state",
          value: true,
        },
      ],
      hostResources: [
        {
          id: "attachment_status",
          title: "Attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      ],
    });

    expect(html).toContain("simulated-devices");
    expect(html).toContain("settings_card");
    expect(html).toContain("can-mutate-host");
    expect(html).toContain("no-host-data");
    expect(html).toContain("simulated_device_power_state");
    expect(html).toContain("no-resources");
  });

  it("exposes resources when the resource capability is granted", () => {
    const html = renderSandboxSdkProbe({
      version: 1,
      providerId: "simulated-devices",
      providerTitle: "Simulated devices",
      familyId: "simulated-devices",
      surfaceId: "detail_view",
      resolvedTheme: "light",
      grantedCapabilities: ["host_resources"],
      hostResources: [
        {
          id: "attachment_status",
          title: "Attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      ],
    });

    expect(html).toContain("detail_view");
    expect(html).toContain("read-only-host");
    expect(html).toContain("can-read-host-data");
    expect(html).toContain("attachment_status");
    expect(html).toContain("no-controls");
  });

  it("falls back to route ids before host state arrives", () => {
    const html = renderSandboxSdkProbe(null);

    expect(html).toContain("fallback-provider");
    expect(html).toContain("fallback-surface");
  });
});
