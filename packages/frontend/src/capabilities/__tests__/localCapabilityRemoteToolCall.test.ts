import { beforeEach, describe, expect, it, vi } from "vitest";

// A device-backed extension the way a feature module contributes one: a
// native runtime family that lists the exact tool ids another device may ask
// for, and a chat route that maps a prompt to one of them. Its saved device was
// set up from an Android phone, and this client can otherwise reach the family
// itself (supportsOnClient is true everywhere), the way a browser with a
// Bluetooth transport of its own can.
const harness = vi.hoisted(() => ({
  getPlatform: vi.fn(() => "web"),
  listForProject: vi.fn(),
  dispatchToolCall: vi.fn(),
  routeExecute: vi.fn(),
  remoteToolIds: ["rover.skill.wake", "rover.skill.look_at"] as string[],
}));

vi.mock("@capacitor/core", async () => {
  const actual = await vi.importActual<typeof import("@capacitor/core")>("@capacitor/core");
  return {
    ...actual,
    Capacitor: new Proxy(actual.Capacitor, {
      get(target, property, receiver) {
        if (property === "getPlatform") {
          return harness.getPlatform;
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

vi.mock("../localProviderHostClient", async () => {
  const actual = await vi.importActual<typeof import("../localProviderHostClient")>(
    "../localProviderHostClient",
  );
  return {
    ...actual,
    listLocalProviders: vi.fn(async () => ({ ok: true, providers: [] })),
  };
});

vi.mock("../../sdk/instafy/controllerClient", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy/controllerClient")>(
    "../../sdk/instafy/controllerClient",
  );
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      integrations: {
        ...actual.controllerClient.integrations,
        listForProject: harness.listForProject,
      },
      providerRequests: {
        ...actual.controllerClient.providerRequests,
        dispatchToolCall: harness.dispatchToolCall,
      },
    },
  };
});

vi.mock("virtual:instafy/frontend-feature-manifest", async () => {
  const { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } = await import(
    "../../features/publicCoreFrontendFeatureModule"
  );
  const { INSTAFY_FEATURE_MODULE_API_VERSION, defineInstafyFeatureModule } = await import(
    "@instafy/sdk/feature-modules"
  );
  const roverProvider = {
    id: "rover",
    title: "Rover",
    kind: "embodied_robot",
    providerType: "rover",
    capabilityIds: ["robot_embodiment"],
  };
  const roverModule = defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "test.rover",
    capabilityAssistantProviders: [
      {
        id: "test_rover_assistant",
        title: "Rover assistant",
        description: "Test assistant bound to the robot capability.",
        assistants: [
          {
            handle: "rover",
            mentionToken: "@rover",
            displayName: "Rover",
            aliases: [],
            capabilityBindings: [
              { capabilityId: "robot_embodiment", enabled: true, source: "system" },
            ],
            summary: "Test robot assistant.",
          },
        ],
      },
    ],
    capabilityProviders: [
      {
        id: "test_rover_capability",
        title: "Rover capability",
        description: "Test robot capability.",
        capabilities: [
          {
            id: "robot_embodiment",
            title: "Robot embodiment",
            description: "Test robot capability.",
            actions: [{ id: "perform_behavior", title: "Perform", description: "Perform." }],
          },
        ],
      },
    ],
    nativeRuntimeFamilyRegistrations: [
      {
        familyId: "rover",
        capabilityIds: ["robot_embodiment"],
        supportsOnClient: () => true,
        resolveCurrentProvider: async (providerId: string) => ({ ...roverProvider, id: providerId }),
        get remoteToolIds() {
          return harness.remoteToolIds;
        },
      },
    ],
    localCapabilityRoutes: [
      {
        id: "test.rover-route",
        capabilityId: "robot_embodiment",
        requiresLocalProvider: true,
        matches: ({ prompt }: { prompt: string }) => /\b(look at me|wake|dance|drive)\b/i.test(prompt),
        resolveRemoteToolCall: ({ prompt }: { prompt: string }) => {
          if (/\blook at me\b/i.test(prompt)) {
            return {
              toolName: "rover.skill.look_at",
              arguments: { azimuth_deg: 0 },
              title: "Look at me",
            };
          }
          if (/\bdrive\b/i.test(prompt)) {
            return { toolName: "rover.skill.drive", arguments: {}, title: "Drive" };
          }
          return null;
        },
        execute: harness.routeExecute,
      },
    ],
  });
  return {
    APPLICATION_FRONTEND_FEATURE_MODULES: Object.freeze([
      PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
      roverModule,
    ]),
  };
});

import { executeLocalCapabilityPrompt } from "../localCapabilityRuntime";
import { REMOTE_TOOL_CALL_TIMEOUT_MS } from "../localCapabilityRemoteToolCall";
import { resolveProjectCapabilityProviderAccess } from "../projectProviderAccess";

const PROJECT_ID = "project-1";
const BOARD = {
  transport: "ble",
  identifier: "AA:BB:CC:DD:EE:FF",
  address: "AA:BB:CC:DD:EE:FF",
  name: "Rover Board",
  nativePlatform: "android",
};

function roverIntegration(metadata: Record<string, unknown> = {}) {
  return {
    id: "integration-rover",
    projectId: PROJECT_ID,
    provider: "rover",
    status: "attached",
    connectionType: "native_runtime",
    credentialId: null,
    metadata: {
      attached: true,
      enabled: true,
      selectedDevice: BOARD,
      selectedDevices: { android: BOARD },
      ...metadata,
    },
    requiredScopes: [],
    capabilities: ["robot_embodiment"],
    createdBy: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
  };
}

function runPrompt(
  prompt: string,
  overrides: Partial<Parameters<typeof executeLocalCapabilityPrompt>[0]> = {},
) {
  return executeLocalCapabilityPrompt({
    handle: "rover",
    prompt,
    sessionId: "instafy_chat_conversation-1",
    runtimeMode: "conversation_local_capability",
    projectId: PROJECT_ID,
    initiatedBy: "person",
    ...overrides,
  });
}

describe("a person's robot prompt on a device without the robot", () => {
  beforeEach(() => {
    harness.getPlatform.mockReturnValue("web");
    harness.remoteToolIds = ["rover.skill.wake", "rover.skill.look_at"];
    harness.listForProject.mockReset();
    harness.listForProject.mockResolvedValue({
      success: true,
      integrations: [roverIntegration()],
    });
    harness.dispatchToolCall.mockReset();
    harness.dispatchToolCall.mockResolvedValue({
      ok: true,
      providerId: "rover",
      name: "rover.skill.look_at",
      value: { skill_id: "look_at", status: "succeeded" },
    });
    harness.routeExecute.mockReset();
    harness.routeExecute.mockResolvedValue({ handled: true, responseText: "ran here" });
  });

  it("routes to the phone holding the saved device instead of this client's own transport", async () => {
    const access = await resolveProjectCapabilityProviderAccess({
      projectId: PROJECT_ID,
      assistantHandle: "rover",
      capabilityId: "robot_embodiment",
    });

    expect(access).toMatchObject({
      providerId: "rover",
      provider: null,
      allowed: true,
      source: "project_integration",
      remoteDevice: {
        label: "Rover Board (AA:BB:CC:DD:EE:FF)",
        selectedDevice: { nativePlatform: "android" },
      },
    });
  });

  it("sends the exact tool call as a controller provider request and reports the phone's result", async () => {
    const statuses: unknown[] = [];
    const result = await runPrompt("@rover look at me", {
      onStatus: (status) => statuses.push(status),
    });

    expect(harness.dispatchToolCall).toHaveBeenCalledTimes(1);
    expect(harness.dispatchToolCall).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      providerId: "rover",
      name: "rover.skill.look_at",
      argumentsValue: { azimuth_deg: 0 },
      timeoutMs: REMOTE_TOOL_CALL_TIMEOUT_MS,
    });
    expect(harness.routeExecute).not.toHaveBeenCalled();
    expect(statuses).toEqual(["Asking Rover Board (AA:BB:CC:DD:EE:FF) to run Look at me…"]);
    expect(result.handled).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.responseText).toBe("Rover ran Look at me on Rover Board (AA:BB:CC:DD:EE:FF).");
    expect(result.metadata).toMatchObject({
      kind: "local_capability_result",
      capability: {
        id: "robot_embodiment",
        actionId: "rover.skill.look_at",
        status: "completed",
        providerId: "rover",
      },
      localCapability: { id: "robot_embodiment", status: "completed" },
      remoteToolCall: {
        dispatched: true,
        toolName: "rover.skill.look_at",
        arguments: { azimuth_deg: 0 },
        deviceLabel: "Rover Board (AA:BB:CC:DD:EE:FF)",
        outcome: "completed",
        ok: true,
        error: null,
        result: { skill_id: "look_at", status: "succeeded" },
      },
    });
  });

  it("shows the phone's failure as the result", async () => {
    harness.dispatchToolCall.mockResolvedValue({
      ok: false,
      providerId: "rover",
      name: "rover.skill.look_at",
      error: "look_at blocked: the robot is stowed; run wake first",
    });

    const result = await runPrompt("@rover look at me");

    expect(result.error).toBe("look_at blocked: the robot is stowed; run wake first");
    expect(result.responseText).toBe(
      "Rover could not run Look at me on Rover Board (AA:BB:CC:DD:EE:FF): look_at blocked: the robot is stowed; run wake first",
    );
    expect(result.metadata).toMatchObject({
      capability: { status: "failed", code: "remote_tool_failed" },
      remoteToolCall: { dispatched: true, outcome: "failed", ok: false },
    });
  });

  describe("when no reply from the phone settles the call", () => {
    const DEVICE = "Rover Board (AA:BB:CC:DD:EE:FF)";

    it("does not say a call the controller stopped waiting for did not run", async () => {
      // What an older controller returns at its deadline, with nothing about
      // whether the phone had taken the request.
      harness.dispatchToolCall.mockResolvedValue({
        ok: false,
        providerId: "rover",
        name: "rover.skill.look_at",
        error: "Timed out waiting for the provider device to respond.",
        noDeviceReply: "unknown",
      });
      const onCapabilityEvent = vi.fn();

      const result = await runPrompt("@rover look at me", { onCapabilityEvent });

      expect(result.error).toBeUndefined();
      expect(result.responseText).toBe(
        `Rover asked ${DEVICE} to run Look at me, but no answer came back within 30 s; it may have run, or may still run.`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "unconfirmed", code: "remote_tool_unconfirmed" },
        localCapability: { status: "unconfirmed" },
        remoteToolCall: {
          dispatched: true,
          outcome: "unconfirmed",
          ok: null,
          error: "Timed out waiting for the provider device to respond.",
        },
      });
      expect(onCapabilityEvent.mock.calls.map(([event]) => event.status)).toEqual([
        "started",
        "unconfirmed",
      ]);
    });

    it("says the phone took the request when the controller reports it was claimed", async () => {
      const request = {
        id: "request-1",
        status: "expired",
        claimedAt: "2026-10-12T12:00:28.000Z",
        claimedByDeviceLabel: "Rover Board",
      };
      harness.dispatchToolCall.mockResolvedValue({
        ok: false,
        providerId: "rover",
        name: "rover.skill.look_at",
        error: "Timed out waiting for the provider device to respond.",
        noDeviceReply: "unknown",
        request,
      });

      const result = await runPrompt("@rover look at me");

      expect(result.error).toBeUndefined();
      expect(result.responseText).toBe(
        `Rover asked ${DEVICE} to run Look at me, but it took the request and did not report back within 30 s; it may have run, or may still run.`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "unconfirmed" },
        remoteToolCall: { outcome: "unconfirmed", ok: null, request },
      });
    });

    it("says a call no phone picked up before the controller expired it did not run", async () => {
      harness.dispatchToolCall.mockResolvedValue({
        ok: false,
        providerId: "rover",
        name: "rover.skill.look_at",
        error: "Timed out waiting for the provider device to respond.",
        noDeviceReply: "never_claimed",
        request: { id: "request-1", status: "expired", claimedAt: null, claimedByDeviceLabel: null },
      });

      const result = await runPrompt("@rover look at me");

      expect(result.error).toBe(`${DEVICE} did not pick up the request within 30 s.`);
      expect(result.responseText).toBe(
        `Rover asked ${DEVICE} to run Look at me, but it did not pick up the request within 30 s, so Look at me did not run.`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "failed", code: "remote_tool_not_claimed" },
        localCapability: { status: "failed" },
        remoteToolCall: { outcome: "not_run", ok: false },
      });
    });

    it("does not say a call whose answer was lost did not run", async () => {
      harness.dispatchToolCall.mockResolvedValue({
        ok: false,
        providerId: "rover",
        name: "rover.skill.look_at",
        error: "Unable to dispatch provider tool call: Failed to fetch",
        noDeviceReply: "unknown",
      });

      const result = await runPrompt("@rover look at me");

      expect(result.error).toBeUndefined();
      expect(result.responseText).toBe(
        `Rover asked ${DEVICE} to run Look at me, but no answer came back (Unable to dispatch provider tool call: Failed to fetch); it may have run, or may still run.`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "unconfirmed", code: "remote_tool_unconfirmed" },
        remoteToolCall: { outcome: "unconfirmed", ok: null },
      });
    });

    it("does not say a call did not run when the dispatch itself rejects", async () => {
      harness.dispatchToolCall.mockRejectedValue(new Error("socket hang up"));

      const result = await runPrompt("@rover look at me");

      expect(result.error).toBeUndefined();
      expect(result.responseText).toBe(
        `Rover asked ${DEVICE} to run Look at me, but no answer came back (socket hang up); it may have run, or may still run.`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "unconfirmed", code: "remote_tool_unconfirmed" },
        remoteToolCall: { dispatched: true, outcome: "unconfirmed", ok: null, error: "socket hang up" },
      });
    });

    it("says a call the controller refused before queueing it did not run", async () => {
      harness.dispatchToolCall.mockResolvedValue({
        ok: false,
        providerId: "rover",
        name: "rover.skill.look_at",
        error: "provider is not attached to this project",
        statusCode: 400,
        noDeviceReply: "not_queued",
      });

      const result = await runPrompt("@rover look at me");

      expect(result.error).toBe("provider is not attached to this project");
      expect(result.responseText).toBe(
        `Rover could not ask ${DEVICE} to run Look at me: provider is not attached to this project`,
      );
      expect(result.metadata).toMatchObject({
        capability: { status: "failed", code: "remote_tool_not_sent" },
        remoteToolCall: { outcome: "not_run", ok: false },
      });
    });
  });

  it.each([
    ["sent by the app on the person's behalf", { initiatedBy: "app" as const }],
    ["with no initiator", { initiatedBy: undefined }],
  ])("refuses a prompt %s without dispatching it", async (_label, overrides) => {
    const result = await runPrompt("@rover look at me", overrides);

    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(result.metadata).toMatchObject({
      capability: { status: "failed", code: "remote_requires_person" },
      remoteToolCall: { dispatched: false },
    });
  });

  it("refuses a tool id the family does not list, even when the route asks for it", async () => {
    const result = await runPrompt("@rover drive to the kitchen");

    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      capability: { status: "failed", code: "remote_tool_not_allowed" },
    });
  });

  it("refuses a prompt the route has no remote call for instead of running it here", async () => {
    const result = await runPrompt("@rover dance");

    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      capability: { status: "failed", code: "remote_tool_unavailable" },
    });
  });

  it("keeps the integration's assistant allow list for a remote request", async () => {
    harness.listForProject.mockResolvedValue({
      success: true,
      integrations: [roverIntegration({ allowedAssistantHandles: ["someone-else"] })],
    });

    const result = await runPrompt("@rover look at me");

    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      capability: { status: "failed", code: "provider_access_denied" },
      providerAccess: { allowed: false, source: "project_integration_denied" },
    });
  });

  it("runs on the phone itself as before when that phone holds the saved device", async () => {
    harness.getPlatform.mockReturnValue("android");

    const result = await runPrompt("@rover look at me");

    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).toHaveBeenCalledTimes(1);
    expect(harness.routeExecute.mock.calls[0]?.[0]).toMatchObject({
      resolvedProviderId: "rover",
      resolvedProvider: { id: "rover" },
    });
    expect(result.responseText).toBe("ran here");
  });

  it("does not reach another device for a family that lists no remote tool ids", async () => {
    harness.remoteToolIds = [];

    const result = await runPrompt("@rover look at me");

    // The family's own transport on this client is used, as before.
    expect(harness.dispatchToolCall).not.toHaveBeenCalled();
    expect(harness.routeExecute).toHaveBeenCalledTimes(1);
    expect(result.responseText).toBe("ran here");
  });
});
