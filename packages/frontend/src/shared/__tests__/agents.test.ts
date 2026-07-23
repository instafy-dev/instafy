import { describe, expect, it } from "vitest";
import {
  createAssistantProviderRegistry,
  createBuiltInAssistantRegistry,
  createBuiltInAssistantRegistryFromProviders,
} from "@instafy/sdk/agents";
import {
  LOCAL_ASSISTANT_PROVIDERS,
  builtInAssistantHasCapability,
  buildBuiltInAssistantPromptContextMetadata,
  getBuiltInAssistantDisplayName,
  getBuiltInAssistantMentionPatternSource,
  getBuiltInAssistantDefinition,
  getDefaultAssistantHandle,
  getDefaultAssistantMentionToken,
  isReservedBuiltInAgentHandle,
  normalizeAgentHandle,
  normalizeCustomAgentHandle,
  resolveBuiltInAssistantHandle,
  resolveBuiltInAssistantMentionToken,
} from "../../assistants/localBuiltInAssistantCatalog";
import { LOCAL_CAPABILITY_DEFINITIONS } from "../../capabilities/localCapabilityCatalog";

describe("shared agents", () => {
  it("supports app-local assistant catalogs through the generic registry", () => {
    const registry = createBuiltInAssistantRegistry([
      {
        handle: "guide",
        mentionToken: "@guide",
        displayName: "Guide",
        aliases: ["coach"],
        capabilityBindings: [
          {
            capabilityId: "camera_observation",
            enabled: true,
            source: "system",
          },
        ],
        summary: "Helpful guide.",
        promptSummary: "Guide assistant.",
        promptInstructions: ["Stay focused on observation tasks."],
      },
    ]);

    expect(registry.getDefaultHandle()).toBe("guide");
    expect(registry.resolveHandle("@coach")).toBe("guide");
    expect(registry.hasCapability("guide", "camera_observation")).toBe(true);
    expect(registry.getMentionPatternSource()).toContain("@guide");
  });

  it("supports provider-registered assistant catalogs", () => {
    const providerRegistry = createAssistantProviderRegistry(LOCAL_ASSISTANT_PROVIDERS);
    const registry = createBuiltInAssistantRegistryFromProviders(LOCAL_ASSISTANT_PROVIDERS);

    expect(providerRegistry.has("local_core_assistants")).toBe(true);
    expect(providerRegistry.has("private_assistant_provider")).toBe(false);
    expect(registry.resolveHandle("@unknown")).toBeNull();
    expect(registry.resolveHandle("@ai")).toBe("octo");
  });

  it("normalizes built-in aliases to the canonical assistant handle", () => {
    expect(resolveBuiltInAssistantHandle("@octo")).toBe("octo");
    expect(resolveBuiltInAssistantHandle("@ai")).toBe("octo");
    expect(resolveBuiltInAssistantHandle("@unknown")).toBeNull();
    expect(resolveBuiltInAssistantMentionToken("@ai")).toBe("@octo");
  });

  it("rejects reserved handles from the custom-agent path", () => {
    expect(isReservedBuiltInAgentHandle("octo")).toBe(true);
    expect(isReservedBuiltInAgentHandle("@ai")).toBe(true);
    expect(normalizeCustomAgentHandle("@octo")).toBeNull();
    expect(normalizeCustomAgentHandle("ai")).toBeNull();
    expect(normalizeCustomAgentHandle("@sloth")).toBe("sloth");
  });

  it("keeps the default assistant metadata stable", () => {
    expect(getDefaultAssistantHandle()).toBe("octo");
    expect(getDefaultAssistantMentionToken()).toBe("@octo");
    expect(normalizeAgentHandle("@octo")).toBe("octo");
    expect(getBuiltInAssistantMentionPatternSource()).toContain("@octo");
    expect(getBuiltInAssistantMentionPatternSource()).toContain("@ai");
    expect(getBuiltInAssistantMentionPatternSource()).not.toContain("@unknown");
  });

  it("exposes built-in capability bindings", () => {
    const octo = getBuiltInAssistantDefinition("octo");
    expect(getBuiltInAssistantDefinition("unknown")).toBeNull();
    expect(octo?.displayName).toBe("Octo");
    expect(getBuiltInAssistantDisplayName("octo")).toBe("Octo");
    expect(getBuiltInAssistantDisplayName("@unknown")).toBeNull();
    expect(builtInAssistantHasCapability("octo", "camera_observation")).toBe(true);
    expect(builtInAssistantHasCapability("unknown", "workspace_admin")).toBe(false);
    expect(builtInAssistantHasCapability("octo", "device_toggle")).toBe(true);
    expect(builtInAssistantHasCapability("octo", "workspace_admin")).toBe(false);
  });

  it("builds prompt-context metadata only for generic built-in assistants", () => {
    const metadata = buildBuiltInAssistantPromptContextMetadata(
      ["octo", "unknown"],
      LOCAL_CAPABILITY_DEFINITIONS,
      [
        {
          capabilityId: "camera_observation",
          status: "available",
          summary: "Camera capture is configured",
          resources: ["camera"],
        },
      ],
    );

    expect(metadata).not.toBeNull();
    expect(metadata?.assistants).toHaveLength(1);
    expect(metadata?.assistants[0]?.handle).toBe("octo");
    expect(metadata?.assistants[0]?.enabledCapabilityIds).toEqual([
      "camera_observation",
      "device_toggle",
    ]);
  });
});
