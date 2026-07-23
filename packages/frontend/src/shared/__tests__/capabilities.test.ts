import { describe, expect, it } from "vitest";
import {
  createCapabilityAvailabilityRegistry,
  createCapabilityExecutorProviderRegistry,
  createCapabilityProviderRegistry,
  createCapabilityRegistry,
  createCapabilityExecutorRegistry,
  createCapabilityExecutorRegistryFromProviders,
  executeCapabilityInvocation,
  formatCapabilityAvailability,
  formatCapabilityPromptContext,
  hasEnabledCapability,
  listCapabilityDefinitionsFromProviders,
  listEnabledCapabilityIds,
  type CapabilityBinding,
} from "@instafy/sdk/capabilities";
import {
  LOCAL_CAPABILITY_PROVIDER_REGISTRY,
  resolveSingleLocalBuiltInCapabilityHandle,
} from "../../capabilities/localCapabilityCatalog";
import { resolveSingleLocalCapabilityHandleForPrompt } from "../../capabilities/localCapabilityRuntime";

describe("shared capabilities", () => {
  it("builds a registry with normalized unique ids", () => {
    const registry = createCapabilityRegistry([
      {
        id: " project_memory ",
        title: "Project memory",
        description: "Allows an agent to read or update project memory.",
        actions: [
          {
            id: " read ",
            title: "Read",
            description: "Read memory blocks.",
          },
        ],
      },
      {
        id: "project_memory",
        title: "Duplicate",
        description: "Should be ignored.",
        actions: [],
      },
    ]);

    expect(Array.from(registry.keys())).toEqual(["project_memory"]);
    expect(registry.get("project_memory")?.actions[0]?.id).toBe("read");
  });

  it("builds provider registries and flattens unique capability definitions", () => {
    const providerRegistry = createCapabilityProviderRegistry([
      {
        id: " local_actuator ",
        title: " Local actuator ",
        description: " Registers device motion ",
        capabilities: [
          {
            id: " device_motion ",
            title: "Device motion",
            description: "Local device motion actions.",
            actions: [],
          },
        ],
      },
      {
        id: "local_actuator",
        title: "Duplicate",
        description: "Should be ignored.",
        capabilities: [],
      },
    ]);

    expect(Array.from(providerRegistry.keys())).toEqual(["local_actuator"]);
    expect(providerRegistry.get("local_actuator")?.capabilities[0]?.id).toBe("device_motion");
    expect(
      listCapabilityDefinitionsFromProviders(providerRegistry.values()).map((entry) => entry.id),
    ).toEqual(["device_motion"]);
  });

  it("tracks enabled capability bindings", () => {
    const bindings: CapabilityBinding[] = [
      {
        capabilityId: "project_memory",
        enabled: true,
        source: "agent",
      },
      {
        capabilityId: "device_motion",
        enabled: false,
        source: "integration",
      },
      {
        capabilityId: "project_memory",
        enabled: true,
        source: "project",
      },
    ];

    expect(listEnabledCapabilityIds(bindings)).toEqual(["project_memory"]);
    expect(hasEnabledCapability(bindings, "project_memory")).toBe(true);
    expect(hasEnabledCapability(bindings, "device_motion")).toBe(false);
  });

  it("routes capability invocations through a registered executor", async () => {
    const registry = createCapabilityExecutorRegistry([
      {
        capabilityId: "project_memory",
        execute: async (invocation) => ({
          ok: true as const,
          capabilityId: invocation.capabilityId,
          actionId: invocation.actionId,
          value: {
            handled: true,
            input: invocation.input,
          },
        }),
      },
    ]);

    const result = await executeCapabilityInvocation<{ handled: boolean; input: unknown }>(
      registry,
      {
        capabilityId: "project_memory",
        actionId: "write",
        input: { key: "memory" },
      },
    );

    expect(result).toEqual({
      ok: true,
      capabilityId: "project_memory",
      actionId: "write",
      value: {
        handled: true,
        input: { key: "memory" },
      },
    });
  });

  it("builds executor registries from executor providers", async () => {
    const providerRegistry = createCapabilityExecutorProviderRegistry([
      {
        id: "local_memory",
        title: "Local memory",
        description: "Provides a memory executor.",
        createExecutors: () => [
          {
            capabilityId: "project_memory",
            execute: async (invocation) => ({
              ok: true as const,
              capabilityId: invocation.capabilityId,
              actionId: invocation.actionId,
              value: { handledBy: "provider" },
            }),
          },
        ],
      },
    ]);

    expect(providerRegistry.has("local_memory")).toBe(true);

    const registry = createCapabilityExecutorRegistryFromProviders(providerRegistry.values(), undefined);
    const result = await executeCapabilityInvocation<{ handledBy: string }>(registry, {
      capabilityId: "project_memory",
      actionId: "write",
      input: { key: "memory" },
    });

    expect(result).toEqual({
      ok: true,
      capabilityId: "project_memory",
      actionId: "write",
      value: { handledBy: "provider" },
    });
  });

  it("returns a structured error when no executor is registered", async () => {
    const registry = createCapabilityExecutorRegistry([]);

    const result = await executeCapabilityInvocation(registry, {
      capabilityId: "device_motion",
      actionId: "move",
      input: { prompt: "@guide move forward" },
    });

    expect(result).toEqual({
      ok: false,
      capabilityId: "device_motion",
      actionId: "move",
      error: "No capability executor is registered for device_motion.",
      code: "missing_executor",
    });
  });

  it("formats prompt context for capability-aware agents", () => {
    const promptContext = formatCapabilityPromptContext({
      id: "device_motion",
      title: "Device motion",
      description: "Translate device requests into motion actions.",
      actions: [
        {
          id: "move",
          title: "Move",
          description: "Run a named device motion.",
        },
      ],
      promptContext: {
        instructions: ["Prefer high-level behaviors."],
        constraints: ["Do not invent unsupported hardware access."],
        examples: ["@guide move forward"],
      },
    });

    expect(promptContext).toContain("Device motion (device_motion)");
    expect(promptContext).toContain("Actions: move");
    expect(promptContext).toContain("Prefer high-level behaviors.");
    expect(promptContext).toContain("@guide move forward");
  });

  it("normalizes and formats capability availability", () => {
    const registry = createCapabilityAvailabilityRegistry([
      {
        capabilityId: " physical_observation ",
        status: "available_on_request",
        summary: "Observation capture is ready after user confirmation",
        resources: ["external_sensor"],
      },
    ]);

    expect(Array.from(registry.keys())).toEqual(["physical_observation"]);
    expect(
      formatCapabilityAvailability({
        capabilityId: "physical_observation",
        status: "available_on_request",
        summary: "Observation capture is ready after user confirmation",
        resources: ["external_sensor"],
      }),
    ).toContain("physical_observation: available_on_request");
  });

  it("resolves only locally available built-in capability targets", () => {
    expect(LOCAL_CAPABILITY_PROVIDER_REGISTRY.has("local_camera")).toBe(true);
    expect(LOCAL_CAPABILITY_PROVIDER_REGISTRY.has("local_device_toggle")).toBe(true);
    expect(
      resolveSingleLocalBuiltInCapabilityHandle(["@octo"], "device_toggle"),
    ).toBe("octo");
    expect(
      resolveSingleLocalBuiltInCapabilityHandle(["@octo"], "unknown_capability"),
    ).toBeNull();
    expect(
      resolveSingleLocalBuiltInCapabilityHandle(["@octo", "@guide"], "device_toggle"),
    ).toBeNull();
    expect(
      resolveSingleLocalBuiltInCapabilityHandle(["@octo"], "camera_observation"),
    ).toBe("octo");
  });

  it("routes prompt-scoped local capability handles for explicit mentions and active learning turns", () => {
    expect(
      resolveSingleLocalCapabilityHandleForPrompt({
        targetHandles: ["octo"],
        prompt: "@octo take a photo",
      }),
    ).toBe("octo");

  });
});
