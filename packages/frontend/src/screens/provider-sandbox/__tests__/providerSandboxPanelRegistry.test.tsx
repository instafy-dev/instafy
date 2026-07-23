import { describe, expect, it } from "vitest";
import { resolveProviderSandboxPanel } from "../providerSandboxPanelRegistry";

describe("providerSandboxPanelRegistry", () => {
  it("resolves the simulated devices panel for supported routes", () => {
    expect(resolveProviderSandboxPanel("simulated-devices", "settings_card")).toBeTypeOf(
      "function",
    );
    expect(resolveProviderSandboxPanel("simulated-devices", "detail_view")).toBeTypeOf(
      "function",
    );
  });

  it("returns null for unsupported provider sandbox routes", () => {
    expect(resolveProviderSandboxPanel("custom-provider", "detail_view")).toBeNull();
    expect(resolveProviderSandboxPanel("simulated-devices", "status_card")).toBeNull();
  });
});
