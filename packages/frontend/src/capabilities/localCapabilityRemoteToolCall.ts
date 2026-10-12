import type { BuiltInAssistantDefinition } from "@instafy/sdk/agents";
import { getRegisteredNativeRuntimeProvider } from "../extensions/extensionCatalog";
import { controllerClient } from "../sdk/instafy/controllerClient";
import type {
  ExecuteLocalCapabilityPromptOptions,
  LocalCapabilityRouteDefinition,
  LocalCapabilityRuntimeResult,
} from "./localCapabilityContributions";
import type { ProjectProviderRemoteDevice } from "./projectProviderAccess";

/**
 * How long the controller holds the dispatch open for the other device. The
 * device polls its queue every few seconds and then runs the action, so this
 * covers a poll, a Bluetooth reconnect and an action of several seconds.
 */
export const REMOTE_TOOL_CALL_TIMEOUT_MS = 30_000;

export interface ExecuteRemoteToolCallOptions {
  route: LocalCapabilityRouteDefinition;
  options: ExecuteLocalCapabilityPromptOptions;
  assistantDefinition: BuiltInAssistantDefinition;
  conversationState: unknown;
  providerId: string;
  remoteDevice: ProjectProviderRemoteDevice;
  /** Exact tool ids the provider's native runtime family accepts from another device. */
  remoteToolIds: readonly string[];
}

/**
 * Sends the one tool call a person's prompt asks of the device the provider is
 * attached on, through the controller's provider-request queue, and turns that
 * device's reply into the chat result. Refuses, without dispatching, a prompt
 * the app sent on the person's behalf, a prompt the route has no remote call
 * for, and any tool id the family does not list.
 */
export async function executeRemoteToolCall(
  input: ExecuteRemoteToolCallOptions,
): Promise<LocalCapabilityRuntimeResult> {
  const { route, options, assistantDefinition, providerId, remoteDevice } = input;
  const assistantName = assistantDefinition.displayName;
  const deviceLabel = remoteDevice.label;
  const providerLabel = getRegisteredNativeRuntimeProvider(providerId)?.title?.trim() || providerId;
  const assistantMetadata = {
    handle: assistantDefinition.handle,
    displayName: assistantName,
  };
  const refuse = (code: string, error: string, responseText: string): LocalCapabilityRuntimeResult => ({
    handled: true,
    error,
    responseText,
    metadata: {
      kind: "local_capability_result",
      assistant: assistantMetadata,
      capability: {
        id: route.capabilityId,
        status: "failed",
        code,
        providerId,
      },
      localCapability: {
        id: route.capabilityId,
        status: "failed",
      },
      remoteToolCall: {
        providerId,
        deviceLabel,
        dispatched: false,
      },
    },
  });

  if (options.initiatedBy !== "person") {
    return refuse(
      "remote_requires_person",
      "Only a message a person sends from the chat can ask another device to act.",
      `${assistantName} did not send that to ${deviceLabel}. Only a message you send from the chat box can ask another device to act.`,
    );
  }

  const projectId = options.projectId?.trim() ?? "";
  if (!projectId) {
    return refuse(
      "remote_requires_project",
      "Another device can only be asked to act inside a space.",
      `${assistantName} can only ask ${deviceLabel} to act inside a space.`,
    );
  }

  const call =
    route.resolveRemoteToolCall?.({
      handle: options.handle,
      prompt: options.prompt,
      conversationState: input.conversationState,
    }) ?? null;
  if (!call) {
    return refuse(
      "remote_tool_unavailable",
      `No action that ${providerId} accepts from another device matches this prompt.`,
      `${assistantName} cannot do that from this device. ${providerLabel} is attached on ${deviceLabel}, and from here it can only ask that device for the few actions its extension allows.`,
    );
  }

  const toolName = call.toolName.trim();
  if (!input.remoteToolIds.includes(toolName)) {
    return refuse(
      "remote_tool_not_allowed",
      `Tool ${toolName || "(none)"} is not one that ${providerId} accepts from another device.`,
      `${assistantName} cannot ask ${deviceLabel} for that action from this device.`,
    );
  }

  const title = call.title?.trim() || toolName;
  const argumentsValue = call.arguments ?? {};
  const capabilityEvents: Record<string, unknown>[] = [];
  const emitCapabilityEvent = (event: Record<string, unknown>) => {
    capabilityEvents.push(event);
    options.onCapabilityEvent?.(event);
  };
  const capabilityEvent = (status: string) => ({
    kind: "capability_invocation",
    capability_id: route.capabilityId,
    action_id: toolName,
    status,
    provider_id: providerId,
    remote_device: deviceLabel,
  });

  emitCapabilityEvent(capabilityEvent("started"));
  options.onStatus?.(`Asking ${deviceLabel} to run ${title}…`);

  const response = await controllerClient.providerRequests
    .dispatchToolCall({
      projectId,
      providerId,
      name: toolName,
      argumentsValue,
      timeoutMs: REMOTE_TOOL_CALL_TIMEOUT_MS,
    })
    .catch((error: unknown) => ({
      ok: false as const,
      providerId,
      name: toolName,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    }));

  const ok = response.ok === true;
  const error = ok
    ? null
    : response.error?.trim() || `${deviceLabel} did not report a result for ${title}.`;
  emitCapabilityEvent(capabilityEvent(ok ? "completed" : "failed"));

  return {
    handled: true,
    responseText: ok
      ? `${assistantName} ran ${title} on ${deviceLabel}.`
      : `${assistantName} could not run ${title} on ${deviceLabel}: ${error}`,
    ...(error ? { error } : {}),
    metadata: {
      kind: "local_capability_result",
      assistant: assistantMetadata,
      capability: {
        id: route.capabilityId,
        actionId: toolName,
        status: ok ? "completed" : "failed",
        ...(ok ? {} : { code: "remote_tool_failed" }),
        providerId,
      },
      localCapability: {
        id: route.capabilityId,
        status: ok ? "completed" : "failed",
      },
      remoteToolCall: {
        providerId,
        deviceLabel,
        dispatched: true,
        toolName,
        arguments: argumentsValue,
        ok,
        error,
        result: response.value ?? null,
      },
      capabilityEvents,
    },
  };
}
