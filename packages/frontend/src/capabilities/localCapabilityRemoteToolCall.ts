import type { BuiltInAssistantDefinition } from "@instafy/sdk/agents";
import { getRegisteredNativeRuntimeProvider } from "../extensions/extensionCatalog";
import { controllerClient } from "../sdk/instafy/controllerClient";
import {
  CONTROLLER_PROVIDER_REQUEST_TIMEOUT_ERROR,
  type ControllerProviderToolCallEnvelope,
} from "../services/runtimeController/providerRequests";
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

/**
 * What became of a dispatched call: the device ran it ("completed") or
 * reported it failed ("failed"); it never reached a device, or expired before
 * one picked it up ("not_run"); or no answer says either way, so the device
 * may have run it or may still run it ("unconfirmed").
 */
export type RemoteToolCallOutcome = "completed" | "failed" | "not_run" | "unconfirmed";

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
 *
 * A call that no answer settles (the wait ran out after a device took it, or
 * the answer was lost on the way) is reported as unconfirmed, not failed: the
 * device may have run it, or may still run it, and the conversation must not
 * say otherwise.
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

  const response: ControllerProviderToolCallEnvelope = await controllerClient.providerRequests
    .dispatchToolCall({
      projectId,
      providerId,
      name: toolName,
      argumentsValue,
      timeoutMs: REMOTE_TOOL_CALL_TIMEOUT_MS,
    })
    .catch((error: unknown) => ({
      // The call may have been queued before it failed, so a device may run it.
      ok: false,
      providerId,
      name: toolName,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
      noDeviceReply: "unknown" as const,
    }));

  const reportedError = response.error?.trim() || null;
  const timeoutSeconds = Math.round(REMOTE_TOOL_CALL_TIMEOUT_MS / 1000);
  let outcome: RemoteToolCallOutcome;
  let responseText: string;
  let code: string | null = null;
  // Only a call that is known not to have run, or that the device reported as
  // failed, is an error. One that no answer settles is not: the device may
  // have moved, so the conversation must not say it did not.
  let error: string | null = null;
  if (response.ok === true) {
    outcome = "completed";
    responseText = `${assistantName} ran ${title} on ${deviceLabel}.`;
  } else if (response.noDeviceReply === "unknown") {
    outcome = "unconfirmed";
    code = "remote_tool_unconfirmed";
    const controllerStoppedWaiting =
      response.request !== undefined || reportedError === CONTROLLER_PROVIDER_REQUEST_TIMEOUT_ERROR;
    const reason = response.request?.claimedAt
      ? `it took the request and did not report back within ${timeoutSeconds} s`
      : controllerStoppedWaiting || !reportedError
        ? `no answer came back within ${timeoutSeconds} s`
        : `no answer came back (${reportedError})`;
    responseText = `${assistantName} asked ${deviceLabel} to run ${title}, but ${reason}; it may have run, or may still run.`;
  } else if (response.noDeviceReply === "never_claimed") {
    outcome = "not_run";
    code = "remote_tool_not_claimed";
    error = `${deviceLabel} did not pick up the request within ${timeoutSeconds} s.`;
    responseText = `${assistantName} asked ${deviceLabel} to run ${title}, but it did not pick up the request within ${timeoutSeconds} s, so ${title} did not run.`;
  } else if (response.noDeviceReply === "not_queued") {
    outcome = "not_run";
    code = "remote_tool_not_sent";
    error = reportedError ?? `The request for ${title} could not be sent.`;
    responseText = `${assistantName} could not ask ${deviceLabel} to run ${title}: ${error}`;
  } else {
    outcome = "failed";
    code = "remote_tool_failed";
    error = reportedError ?? `${deviceLabel} did not report a result for ${title}.`;
    responseText = `${assistantName} could not run ${title} on ${deviceLabel}: ${error}`;
  }
  const status = outcome === "completed" ? "completed" : outcome === "unconfirmed" ? "unconfirmed" : "failed";
  emitCapabilityEvent(capabilityEvent(status));

  return {
    handled: true,
    responseText,
    ...(error ? { error } : {}),
    metadata: {
      kind: "local_capability_result",
      assistant: assistantMetadata,
      capability: {
        id: route.capabilityId,
        actionId: toolName,
        status,
        ...(code ? { code } : {}),
        providerId,
      },
      localCapability: {
        id: route.capabilityId,
        status,
      },
      remoteToolCall: {
        providerId,
        deviceLabel,
        dispatched: true,
        toolName,
        arguments: argumentsValue,
        outcome,
        ok: outcome === "completed" ? true : outcome === "unconfirmed" ? null : false,
        error: outcome === "completed" ? null : (error ?? reportedError),
        result: response.value ?? null,
        ...(response.request ? { request: response.request } : {}),
      },
      capabilityEvents,
    },
  };
}
