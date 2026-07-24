import { describe, expect, it } from "vitest";
import type {
  ControllerProjectIntegration,
  ControllerProviderRequestRecord,
} from "../../services/runtimeController";
import {
  integrationIsAttached,
  providerRequestTargetsCurrentDevice,
} from "../providerRequestClaimSupport";

function integration(
  overrides: Partial<ControllerProjectIntegration> = {},
): ControllerProjectIntegration {
  return {
    id: "integration-1",
    projectId: "project-1",
    provider: "fixture-provider",
    status: "attached",
    connectionType: "native_runtime",
    credentialId: null,
    metadata: {},
    capabilities: [],
    requiredScopes: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function request(
  overrides: Partial<ControllerProviderRequestRecord> = {},
): ControllerProviderRequestRecord {
  return {
    id: "request-1",
    projectId: "project-1",
    providerId: "fixture-provider",
    requestKind: "tool_call",
    toolName: "fixture.run",
    resourceUri: null,
    arguments: {},
    status: "pending",
    requestedBy: null,
    claimedByDeviceId: null,
    claimedByDeviceLabel: null,
    response: null,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    claimedAt: null,
    completedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("provider request claim support", () => {
  it("accepts only attached and explicitly enabled integrations", () => {
    expect(integrationIsAttached(integration())).toBe(true);
    expect(integrationIsAttached(integration({ status: "connected" }))).toBe(true);
    expect(
      integrationIsAttached(integration({ metadata: { enabled: false } })),
    ).toBe(false);
    expect(integrationIsAttached(integration({ status: "disabled" }))).toBe(false);
  });

  it("routes pending requests by provider and claimed requests by exact device", () => {
    expect(
      providerRequestTargetsCurrentDevice(
        request(),
        "FIXTURE-PROVIDER",
        "device-1",
      ),
    ).toBe(true);
    expect(
      providerRequestTargetsCurrentDevice(
        request({ providerId: "other-provider" }),
        "fixture-provider",
        "device-1",
      ),
    ).toBe(false);
    expect(
      providerRequestTargetsCurrentDevice(
        request({ status: "claimed", claimedByDeviceId: "DEVICE-1" }),
        "fixture-provider",
        "device-1",
      ),
    ).toBe(true);
    expect(
      providerRequestTargetsCurrentDevice(
        request({ status: "claimed", claimedByDeviceId: "device-2" }),
        "fixture-provider",
        "device-1",
      ),
    ).toBe(false);
  });
});
