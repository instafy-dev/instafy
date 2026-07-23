import type { ComponentType } from "react";
import { SimulatedDevicesSandboxPanel } from "./SimulatedDevicesSandboxPanel";

type ProviderSandboxPanelComponent = ComponentType;

type ProviderSandboxPanelRegistration = {
  providerId: string;
  surfaceIds: readonly string[];
  Component: ProviderSandboxPanelComponent;
};

function normalizeId(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const PROVIDER_SANDBOX_PANEL_REGISTRATIONS: readonly ProviderSandboxPanelRegistration[] = [
  {
    providerId: "simulated-devices",
    surfaceIds: ["settings_card", "detail_view"],
    Component: SimulatedDevicesSandboxPanel,
  },
];

export function resolveProviderSandboxPanel(
  providerId: string | null | undefined,
  surfaceId: string | null | undefined,
) {
  const normalizedProviderId = normalizeId(providerId);
  const normalizedSurfaceId = normalizeId(surfaceId);
  if (!normalizedProviderId || !normalizedSurfaceId) {
    return null;
  }

  return (
    PROVIDER_SANDBOX_PANEL_REGISTRATIONS.find((registration) => {
      if (normalizeId(registration.providerId) !== normalizedProviderId) {
        return false;
      }
      return registration.surfaceIds.some(
        (registeredSurfaceId) => normalizeId(registeredSurfaceId) === normalizedSurfaceId,
      );
    })?.Component ?? null
  );
}
