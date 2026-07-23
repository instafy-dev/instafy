import {
  callLocalProviderTool,
  type LocalProviderSummary,
} from "./localProviderHostClient";
import {
  captureProviderPhoto,
  captureProviderPhotoSeries,
} from "../camera/cameraBridgeClient";
import { formatCameraCapabilityFailureMessage } from "../camera/cameraRemoteRequestPresentation";
import {
  collectProviderEventEnvelopes,
  createCameraObservationProviderEvent,
  isProviderEventEnvelopeRecord,
} from "../extensions/providerEvents";
import { dispatchObservedProviderEvents } from "../extensions/providerEventChannel";
import {
  CAMERA_OBSERVATION_CAPABILITY,
  resolveCameraObservationPrompt,
  resolveVisualQuestionPrompt,
  type ResolvedVisualQuestionPrompt,
} from "../camera/cameraObservationCapability";
import {
  classifyCapturedImage,
  recordVisionObservation,
} from "../camera/visionRuntime";
import {
  DEVICE_TOGGLE_CAPABILITY,
  resolveDeviceTogglePrompt,
} from "../devices/deviceToggleCapability";
import {
  DEVICE_TOGGLE_SET_POWER_TOOL_ID,
} from "../devices/deviceToggleCapabilityMetadata";
import {
  getLocalCapabilityAssistantDefinition,
  localCapabilityAssistantHasCapability,
  resolveLocalCapabilityAssistantHandle,
  type BuiltInAssistantHandle,
} from "../assistants/localBuiltInAssistantCatalog";
import {
  formatProjectProviderSelectedDeviceLabel,
  getProjectIntegrationByProvider,
  getProjectProviderSelectedDevice,
  resolveProjectCapabilityProviderAccess,
} from "./projectProviderAccess";
import { controllerClient } from "../sdk/instafy";
import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import type {
  ExecuteLocalCapabilityPromptOptions,
  LocalCapabilityRouteDefinition,
  LocalCapabilityRouteExecuteOptions,
  LocalCapabilityRouteMatcherOptions,
  LocalCapabilityRuntimeResult,
  ResolveLocalCapabilityPromptHandleOptions,
} from "./localCapabilityContributions";
export type {
  ExecuteLocalCapabilityPromptOptions,
  LocalCapabilityRuntimeResult,
  LocalCapabilityStatusUpdate,
  LocalCapabilityStatusValue,
  ResolveLocalCapabilityPromptHandleOptions,
} from "./localCapabilityContributions";

function canHandleDeviceTogglePrompt(options: LocalCapabilityRouteMatcherOptions) {
  return (
    localCapabilityAssistantHasCapability(options.handle, DEVICE_TOGGLE_CAPABILITY.id) &&
    resolveDeviceTogglePrompt(options.prompt) !== null
  );
}

async function executeDeviceToggleLocalCapabilityPrompt(
  options: LocalCapabilityRouteExecuteOptions,
): Promise<LocalCapabilityRuntimeResult> {
  const providerId = options.resolvedProviderId?.trim();
  const provider = options.resolvedProvider ?? null;
  const action = resolveDeviceTogglePrompt(options.prompt);
  if (!action) {
    return { handled: false };
  }

  if (!providerId) {
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} cannot find a device provider for that action right now.`,
      error: "No device provider was resolved for device toggle.",
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          status: "failed",
          code: "provider_unavailable",
        },
        localCapability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          status: "failed",
        },
      },
    };
  }

  const capabilityEvents: Record<string, unknown>[] = [];
  const emitCapabilityEvent = (event: Record<string, unknown>) => {
    capabilityEvents.push(event);
    if (isProviderEventEnvelopeRecord(event)) {
      dispatchObservedProviderEvents([event]);
    }
    options.onCapabilityEvent?.(event);
  };
  emitCapabilityEvent({
    kind: "capability_invocation",
    capability_id: DEVICE_TOGGLE_CAPABILITY.id,
    action_id: "set_device_power",
    status: "started",
    provider_id: providerId,
    device_id: action.deviceId,
    target_state: action.targetState,
  });
  options.onStatus?.(`${action.summary}…`);

  try {
    const response = await callLocalProviderTool<{
      deviceId?: string;
      deviceLabel?: string;
      targetState?: string;
      previousState?: string;
      powerState?: string;
      simulated?: boolean;
    }>(
      providerId,
      DEVICE_TOGGLE_SET_POWER_TOOL_ID,
      {
        deviceId: action.deviceId,
        targetState: action.targetState,
      },
    );

    const powerState = response.value?.powerState === "on" ? "on" : "off";
    const deviceLabel =
      typeof response.value?.deviceLabel === "string" && response.value.deviceLabel.trim().length > 0
        ? response.value.deviceLabel.trim()
        : action.deviceLabel;
    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: DEVICE_TOGGLE_CAPABILITY.id,
      action_id: "set_device_power",
      status: "completed",
      provider_id: providerId,
      device_id: action.deviceId,
      target_state: action.targetState,
      power_state: powerState,
    });
    options.onStatus?.(`Set ${deviceLabel} -> ${powerState}`);

    const powerVerb = powerState === "on" ? "turned on" : "turned off";
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} ${powerVerb} the ${deviceLabel}.`,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          actionId: "set_device_power",
          status: "completed",
          deviceId: action.deviceId,
          providerId,
        },
        localCapability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          status: "completed",
        },
        deviceControl: {
          deviceId: action.deviceId,
          deviceLabel,
          targetState: action.targetState,
          powerState,
          simulated: response.value?.simulated !== false,
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : {
              id: providerId,
            },
        capabilityEvents,
      },
    };
  } catch (error) {
    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: DEVICE_TOGGLE_CAPABILITY.id,
      action_id: "set_device_power",
      status: "failed",
      provider_id: providerId,
      device_id: action.deviceId,
      target_state: action.targetState,
    });
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} could not execute that device action: ${message}`,
      error: message,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          actionId: "set_device_power",
          status: "failed",
          code: "provider_tool_failed",
          providerId,
        },
        localCapability: {
          id: DEVICE_TOGGLE_CAPABILITY.id,
          status: "failed",
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : {
              id: providerId,
            },
        capabilityEvents,
      },
    };
  }
}

function canHandleCameraObservationPrompt(options: LocalCapabilityRouteMatcherOptions) {
  return (
    localCapabilityAssistantHasCapability(options.handle, CAMERA_OBSERVATION_CAPABILITY.id) &&
    (resolveCameraObservationPrompt(options.prompt) !== null ||
      resolveVisualQuestionPrompt(options.prompt) !== null)
  );
}

async function resolveCameraObservationFailureResponseText(params: {
  assistantDisplayName: string;
  error: string;
  projectId?: string | null;
  providerId: string;
}) {
  const projectId = params.projectId?.trim();
  if (!projectId) {
    return formatCameraCapabilityFailureMessage({
      assistantDisplayName: params.assistantDisplayName,
      error: params.error,
      selectedDevice: null,
    });
  }

  const integrationsResult = await controllerClient.integrations.listForProject(projectId).catch(() => null);
  const integration = integrationsResult?.success
    ? getProjectIntegrationByProvider(integrationsResult.integrations, params.providerId)
    : null;

  return formatCameraCapabilityFailureMessage({
    assistantDisplayName: params.assistantDisplayName,
    error: params.error,
    selectedDevice: getProjectProviderSelectedDevice(integration),
  });
}

async function resolveProjectCameraSelectedDevice(params: {
  projectId?: string | null;
  providerId: string;
}) {
  const projectId = params.projectId?.trim();
  if (!projectId) {
    return null;
  }

  const integrationsResult = await controllerClient.integrations.listForProject(projectId).catch(() => null);
  const integration = integrationsResult?.success
    ? getProjectIntegrationByProvider(integrationsResult.integrations, params.providerId)
    : null;
  return getProjectProviderSelectedDevice(integration);
}

function resolveCameraCaptureSourceLabel(
  providerTitle: string | null | undefined,
  selectedDevice: Awaited<ReturnType<typeof resolveProjectCameraSelectedDevice>>,
) {
  const deviceName = selectedDevice?.name?.trim();
  if (deviceName) {
    return deviceName;
  }

  if (selectedDevice) {
    const formatted = formatProjectProviderSelectedDeviceLabel(selectedDevice).trim();
    if (formatted.length > 0 && formatted !== "another device") {
      return formatted;
    }
  }

  const title = providerTitle?.trim();
  if (title && title.length > 0 && title !== "Camera") {
    return title;
  }

  return null;
}

function formatCameraCaptureSuccessText(params: {
  assistantDisplayName: string;
  lens: string;
  captureCount: number;
  providerTitle?: string | null;
  selectedDevice: Awaited<ReturnType<typeof resolveProjectCameraSelectedDevice>>;
}) {
  const subject =
    params.captureCount === 1
      ? `a ${params.lens} photo`
      : `${params.captureCount} ${params.lens} photo${params.captureCount === 1 ? "" : "s"}`;
  const sourceLabel = resolveCameraCaptureSourceLabel(params.providerTitle, params.selectedDevice);
  if (sourceLabel) {
    return `${params.assistantDisplayName} captured ${subject} on ${sourceLabel}.`;
  }
  return `${params.assistantDisplayName} captured ${subject} from ${params.providerTitle?.trim() || "Camera"}.`;
}

async function executeCameraObservationLocalCapabilityPrompt(
  options: LocalCapabilityRouteExecuteOptions,
): Promise<LocalCapabilityRuntimeResult> {
  const providerId = options.resolvedProviderId?.trim();
  const provider = options.resolvedProvider ?? null;
  const request = resolveCameraObservationPrompt(options.prompt);
  if (!request) {
    const visualQuestion = resolveVisualQuestionPrompt(options.prompt);
    if (visualQuestion) {
      return executeAnswerVisualQuestionLocalCapabilityPrompt(options, visualQuestion);
    }
    return { handled: false };
  }

  if (!providerId) {
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} cannot find a camera provider for that request right now.`,
      error: "No camera provider was resolved for camera observation.",
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
          code: "provider_unavailable",
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
        },
      },
    };
  }

  const capabilityEvents: Record<string, unknown>[] = [];
  const emitCapabilityEvent = (event: Record<string, unknown>) => {
    capabilityEvents.push(event);
    options.onCapabilityEvent?.(event);
  };
  const buildResultEventMetadata = () => {
    const providerEvents = collectProviderEventEnvelopes(capabilityEvents);
    return {
      capabilityEvents,
      ...(providerEvents.length > 0 ? { providerEvents } : {}),
    };
  };
  emitCapabilityEvent({
    kind: "capability_invocation",
    capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
    action_id: request.mode === "series" ? "capture_photo_series" : "capture_photo",
    status: "started",
    provider_id: providerId,
    lens: request.lens,
    requested_count: request.count,
  });
  options.onStatus?.(`${request.summary}…`);

  try {
    if (request.mode === "series") {
      const captureResponse = await captureProviderPhotoSeries({
        providerId,
        provider,
        projectId: options.projectId ?? null,
        lens: request.lens,
        count: request.count,
        onRemoteRequestSummary: (summary) => {
          options.onStatus?.({
            text: summary.text,
            metadata: {
              cameraRequest: {
                text: summary.text,
                tone: summary.tone,
                deviceLabel: summary.deviceLabel,
                requestState: summary.requestState,
                presenceStatus: summary.presenceStatus,
                requiresPermission: summary.requiresPermission,
                hasRecentFailure: summary.hasRecentFailure,
              },
            },
          });
        },
      });
      const result = captureResponse.result;
      const captureCount = result.completedCount;
      const lastCapture = result.captures[result.captures.length - 1] ?? null;

      if (result.cancelled) {
        emitCapabilityEvent({
          kind: "capability_invocation",
          capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
          action_id: "capture_photo_series",
          status: "cancelled",
          provider_id: providerId,
          lens: request.lens,
          completed_count: captureCount,
        });
        options.onStatus?.("Camera capture cancelled");
        return {
          handled: true,
          responseText: `${options.assistantDefinition.displayName} cancelled the camera capture.`,
          metadata: {
            kind: "local_capability_result",
            assistant: {
              handle: options.assistantDefinition.handle,
              displayName: options.assistantDefinition.displayName,
            },
            capability: {
              id: CAMERA_OBSERVATION_CAPABILITY.id,
              actionId: "capture_photo_series",
              status: "cancelled",
              providerId,
            },
            localCapability: {
              id: CAMERA_OBSERVATION_CAPABILITY.id,
              status: "cancelled",
            },
            cameraObservation: {
              mode: request.mode,
              lens: request.lens,
              requestedCount: request.count,
              completedCount: captureCount,
              capture: lastCapture,
            },
            provider: provider
              ? {
                  id: provider.id,
                  title: provider.title,
                  kind: provider.kind,
                }
              : { id: providerId },
            ...buildResultEventMetadata(),
          },
        };
      }

      if (result.error && captureCount === 0) {
        throw new Error(result.error);
      }

      emitCapabilityEvent({
        kind: "capability_invocation",
        capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
        action_id: "capture_photo_series",
        status: "completed",
        provider_id: providerId,
        lens: request.lens,
        completed_count: captureCount,
      });
      if (captureCount > 0) {
        emitCapabilityEvent(
          createCameraObservationProviderEvent({
            providerId,
            providerType: provider?.providerType ?? "phone_camera",
            executionContext: captureResponse.executionContext,
            mode: "series",
            lens: request.lens,
            requestedCount: request.count,
            completedCount: captureCount,
            capture: lastCapture,
            captures: result.captures,
          }) as Record<string, unknown>,
        );
      }
      options.onStatus?.(`Captured ${captureCount} camera photos`);
      const selectedDevice = await resolveProjectCameraSelectedDevice({
        projectId: options.projectId ?? null,
        providerId,
      });

      return {
        handled: true,
        responseText: formatCameraCaptureSuccessText({
          assistantDisplayName: options.assistantDefinition.displayName,
          lens: request.lens,
          captureCount,
          providerTitle: provider?.title ?? null,
          selectedDevice,
        }),
        metadata: {
          kind: "local_capability_result",
          assistant: {
            handle: options.assistantDefinition.handle,
            displayName: options.assistantDefinition.displayName,
          },
          capability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            actionId: "capture_photo_series",
            status: "completed",
            providerId,
            captureCount,
          },
          localCapability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            status: "completed",
          },
          cameraObservation: {
            mode: request.mode,
            lens: request.lens,
            requestedCount: request.count,
            completedCount: captureCount,
            capture: lastCapture,
            captures: result.captures,
          },
          provider: provider
            ? {
                id: provider.id,
                title: provider.title,
                kind: provider.kind,
              }
            : { id: providerId },
          ...buildResultEventMetadata(),
        },
      };
    }

    const captureResponse = await captureProviderPhoto({
      providerId,
      provider,
      projectId: options.projectId ?? null,
      lens: request.lens,
      onRemoteRequestSummary: (summary) => {
        options.onStatus?.({
          text: summary.text,
          metadata: {
            cameraRequest: {
              text: summary.text,
              tone: summary.tone,
              deviceLabel: summary.deviceLabel,
              requestState: summary.requestState,
              presenceStatus: summary.presenceStatus,
              requiresPermission: summary.requiresPermission,
              hasRecentFailure: summary.hasRecentFailure,
            },
          },
        });
      },
    });
    const result = captureResponse.result;
    const captureCount = result.capture ? 1 : 0;
    const lastCapture = result.capture ?? null;

    if (result.cancelled) {
      emitCapabilityEvent({
        kind: "capability_invocation",
        capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
        action_id: "capture_photo",
        status: "cancelled",
        provider_id: providerId,
        lens: request.lens,
        completed_count: captureCount,
      });
      options.onStatus?.("Camera capture cancelled");
      return {
        handled: true,
        responseText: `${options.assistantDefinition.displayName} cancelled the camera capture.`,
        metadata: {
          kind: "local_capability_result",
          assistant: {
            handle: options.assistantDefinition.handle,
            displayName: options.assistantDefinition.displayName,
          },
          capability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            actionId: "capture_photo",
            status: "cancelled",
            providerId,
          },
          localCapability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            status: "cancelled",
          },
          cameraObservation: {
            mode: request.mode,
            lens: request.lens,
            requestedCount: request.count,
            completedCount: captureCount,
            capture: lastCapture,
          },
          provider: provider
            ? {
                id: provider.id,
                title: provider.title,
                kind: provider.kind,
              }
            : { id: providerId },
          ...buildResultEventMetadata(),
        },
      };
    }

    if (result.error && captureCount === 0) {
      throw new Error(result.error);
    }

    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
      action_id: "capture_photo",
      status: "completed",
      provider_id: providerId,
      lens: request.lens,
      completed_count: captureCount,
    });
    if (captureCount > 0) {
      emitCapabilityEvent(
        createCameraObservationProviderEvent({
          providerId,
          providerType: provider?.providerType ?? "phone_camera",
          executionContext: captureResponse.executionContext,
          mode: "single",
          lens: request.lens,
          requestedCount: request.count,
          completedCount: captureCount,
          capture: lastCapture,
        }) as Record<string, unknown>,
      );
    }
    options.onStatus?.(`Captured ${request.lens} photo`);
    const selectedDevice = await resolveProjectCameraSelectedDevice({
      projectId: options.projectId ?? null,
      providerId,
    });

    return {
      handled: true,
      responseText: formatCameraCaptureSuccessText({
        assistantDisplayName: options.assistantDefinition.displayName,
        lens: request.lens,
        captureCount,
        providerTitle: provider?.title ?? null,
        selectedDevice,
      }),
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          actionId: "capture_photo",
          status: "completed",
          providerId,
          captureCount,
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "completed",
        },
        cameraObservation: {
          mode: request.mode,
          lens: request.lens,
          requestedCount: request.count,
          completedCount: captureCount,
          capture: lastCapture,
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : { id: providerId },
        ...buildResultEventMetadata(),
      },
    };
  } catch (error) {
    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
      action_id: request.mode === "series" ? "capture_photo_series" : "capture_photo",
      status: "failed",
      provider_id: providerId,
      lens: request.lens,
      requested_count: request.count,
    });
    const message = error instanceof Error ? error.message : String(error);
    const responseText = await resolveCameraObservationFailureResponseText({
      assistantDisplayName: options.assistantDefinition.displayName,
      error: message,
      projectId: options.projectId ?? null,
      providerId,
    });
    return {
      handled: true,
      responseText,
      error: message,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          actionId: request.mode === "series" ? "capture_photo_series" : "capture_photo",
          status: "failed",
          code: "provider_tool_failed",
          providerId,
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : { id: providerId },
        ...buildResultEventMetadata(),
      },
    };
  }
}

async function executeAnswerVisualQuestionLocalCapabilityPrompt(
  options: LocalCapabilityRouteExecuteOptions,
  request: ResolvedVisualQuestionPrompt,
): Promise<LocalCapabilityRuntimeResult> {
  const providerId = options.resolvedProviderId?.trim();
  const provider = options.resolvedProvider ?? null;

  if (!providerId) {
    return {
      handled: true,
      responseText: `${options.assistantDefinition.displayName} cannot find a camera provider for that request right now.`,
      error: "No camera provider was resolved for camera observation.",
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
          code: "provider_unavailable",
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
        },
      },
    };
  }

  const capabilityEvents: Record<string, unknown>[] = [];
  const emitCapabilityEvent = (event: Record<string, unknown>) => {
    capabilityEvents.push(event);
    options.onCapabilityEvent?.(event);
  };
  const buildResultEventMetadata = () => {
    const providerEvents = collectProviderEventEnvelopes(capabilityEvents);
    return {
      capabilityEvents,
      ...(providerEvents.length > 0 ? { providerEvents } : {}),
    };
  };
  emitCapabilityEvent({
    kind: "capability_invocation",
    capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
    action_id: "answer_visual_question",
    status: "started",
    provider_id: providerId,
    lens: "front",
    question: request.question,
  });
  options.onStatus?.(`${request.summary}…`);

  try {
    // Phone-backed embodied providers commonly treat the front camera as the
    // user's point-of-view capture source.
    const captureResponse = await captureProviderPhoto({
      providerId,
      provider,
      projectId: options.projectId ?? null,
      lens: "front",
      onRemoteRequestSummary: (summary) => {
        options.onStatus?.({
          text: summary.text,
          metadata: {
            cameraRequest: {
              text: summary.text,
              tone: summary.tone,
              deviceLabel: summary.deviceLabel,
              requestState: summary.requestState,
              presenceStatus: summary.presenceStatus,
              requiresPermission: summary.requiresPermission,
              hasRecentFailure: summary.hasRecentFailure,
            },
          },
        });
      },
    });
    const result = captureResponse.result;
    const capture = result.capture ?? null;

    if (result.cancelled) {
      emitCapabilityEvent({
        kind: "capability_invocation",
        capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
        action_id: "answer_visual_question",
        status: "cancelled",
        provider_id: providerId,
        lens: "front",
        completed_count: capture ? 1 : 0,
      });
      options.onStatus?.("Camera capture cancelled");
      return {
        handled: true,
        responseText: `${options.assistantDefinition.displayName} cancelled the camera capture.`,
        metadata: {
          kind: "local_capability_result",
          assistant: {
            handle: options.assistantDefinition.handle,
            displayName: options.assistantDefinition.displayName,
          },
          capability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            actionId: "answer_visual_question",
            status: "cancelled",
            providerId,
          },
          localCapability: {
            id: CAMERA_OBSERVATION_CAPABILITY.id,
            status: "cancelled",
          },
          cameraObservation: {
            mode: "single",
            lens: "front",
            requestedCount: 1,
            completedCount: capture ? 1 : 0,
            capture,
          },
          provider: provider
            ? {
                id: provider.id,
                title: provider.title,
                kind: provider.kind,
              }
            : { id: providerId },
          ...buildResultEventMetadata(),
        },
      };
    }

    if (result.error && !capture) {
      throw new Error(result.error);
    }
    if (!capture) {
      throw new Error("The camera provider did not return a capture for the visual question.");
    }
    const webPath = capture.webPath?.trim();
    if (!webPath) {
      throw new Error(
        "The captured photo did not include a readable image path for classification.",
      );
    }

    const classification = await classifyCapturedImage(webPath, request.question);

    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
      action_id: "answer_visual_question",
      status: "completed",
      provider_id: providerId,
      lens: "front",
      completed_count: 1,
      label: classification.label,
      latency_ms: classification.latencyMs,
      agent_runtime: classification.agentRuntime,
    });
    emitCapabilityEvent(
      createCameraObservationProviderEvent({
        providerId,
        providerType: provider?.providerType ?? "phone_camera",
        executionContext: captureResponse.executionContext,
        mode: "single",
        lens: "front",
        requestedCount: 1,
        completedCount: 1,
        capture,
      }) as Record<string, unknown>,
    );

    recordVisionObservation({
      atMs: Date.now(),
      question: request.question,
      label: classification.label,
      answer: classification.answer,
      latencyMs: classification.latencyMs,
    });
    options.onStatus?.(`Answered visual question (${classification.label})`);

    return {
      handled: true,
      responseText: classification.answer,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          actionId: "answer_visual_question",
          status: "completed",
          providerId,
          captureCount: 1,
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "completed",
        },
        cameraObservation: {
          mode: "single",
          lens: "front",
          requestedCount: 1,
          completedCount: 1,
          capture,
        },
        vision: {
          question: request.question,
          label: classification.label,
          answer: classification.answer,
          latencyMs: classification.latencyMs,
          agentRuntime: classification.agentRuntime,
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : { id: providerId },
        ...buildResultEventMetadata(),
      },
    };
  } catch (error) {
    emitCapabilityEvent({
      kind: "capability_invocation",
      capability_id: CAMERA_OBSERVATION_CAPABILITY.id,
      action_id: "answer_visual_question",
      status: "failed",
      provider_id: providerId,
      lens: "front",
      question: request.question,
    });
    const message = error instanceof Error ? error.message : String(error);
    const responseText = await resolveCameraObservationFailureResponseText({
      assistantDisplayName: options.assistantDefinition.displayName,
      error: message,
      projectId: options.projectId ?? null,
      providerId,
    });
    return {
      handled: true,
      responseText,
      error: message,
      metadata: {
        kind: "local_capability_result",
        assistant: {
          handle: options.assistantDefinition.handle,
          displayName: options.assistantDefinition.displayName,
        },
        capability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          actionId: "answer_visual_question",
          status: "failed",
          code: "provider_tool_failed",
          providerId,
        },
        localCapability: {
          id: CAMERA_OBSERVATION_CAPABILITY.id,
          status: "failed",
        },
        provider: provider
          ? {
              id: provider.id,
              title: provider.title,
              kind: provider.kind,
            }
          : { id: providerId },
        ...buildResultEventMetadata(),
      },
    };
  }
}

const LOCAL_CAPABILITY_ROUTE_DEFINITIONS: LocalCapabilityRouteDefinition[] = [
  ...APPLICATION_FRONTEND_FEATURES.localCapabilityRoutes,
  {
    id: "instafy.camera-observation",
    capabilityId: CAMERA_OBSERVATION_CAPABILITY.id,
    requiresLocalProvider: true,
    matches: canHandleCameraObservationPrompt,
    execute: executeCameraObservationLocalCapabilityPrompt,
  },
  {
    id: "instafy.device-toggle",
    capabilityId: DEVICE_TOGGLE_CAPABILITY.id,
    requiresLocalProvider: true,
    matches: canHandleDeviceTogglePrompt,
    execute: executeDeviceToggleLocalCapabilityPrompt,
  },
];

function deriveRouteConversationState(
  route: LocalCapabilityRouteDefinition,
  messages: ExecuteLocalCapabilityPromptOptions["conversationMessages"],
) {
  return route.deriveConversationState?.(messages ?? []) ?? null;
}

function resolveMatchingLocalCapabilityRoute(
  options: LocalCapabilityRouteMatcherOptions & {
    conversationMessages?: ExecuteLocalCapabilityPromptOptions["conversationMessages"];
  },
): { route: LocalCapabilityRouteDefinition; conversationState: unknown } | null {
  for (const route of LOCAL_CAPABILITY_ROUTE_DEFINITIONS) {
    if (!localCapabilityAssistantHasCapability(options.handle, route.capabilityId)) {
      continue;
    }
    const conversationState = deriveRouteConversationState(
      route,
      options.conversationMessages,
    );
    if (route.matches({ ...options, conversationState })) {
      return { route, conversationState };
    }
  }
  return null;
}

function extractLeadingBuiltInAssistantHandle(prompt: string): BuiltInAssistantHandle | null {
  const match = prompt.match(/^@([a-z0-9_-]+)\b/i);
  return resolveLocalCapabilityAssistantHandle(match?.[1] ?? "");
}

export function resolveSingleLocalCapabilityHandleForPrompt(
  options: ResolveLocalCapabilityPromptHandleOptions,
): BuiltInAssistantHandle | null {
  const handles = Array.from(options.targetHandles)
    .map((handle) => resolveLocalCapabilityAssistantHandle(handle))
    .filter((handle): handle is BuiltInAssistantHandle => handle !== null);
  const promptHandle = extractLeadingBuiltInAssistantHandle(options.prompt);
  const conversationHandles = LOCAL_CAPABILITY_ROUTE_DEFINITIONS.flatMap((route) => {
    const conversationState = deriveRouteConversationState(
      route,
      options.conversationMessages,
    );
    const rawHandle = route.resolveConversationHandle?.(conversationState);
    const handle = resolveLocalCapabilityAssistantHandle(rawHandle);
    return handle ? [handle] : [];
  });
  const candidates = [
    ...(promptHandle ? [promptHandle] : []),
    ...conversationHandles,
    ...(handles.length === 1 ? handles : []),
  ];

  for (const handle of new Set(candidates)) {
    if (
      resolveMatchingLocalCapabilityRoute({
        handle,
        prompt: options.prompt,
        conversationMessages: options.conversationMessages,
      })
    ) {
      return handle;
    }
  }

  return null;
}

export function deriveLocalCapabilityPromptMetadataPatch(options: {
  handle: BuiltInAssistantHandle;
  prompt: string;
  conversationMessages?: ExecuteLocalCapabilityPromptOptions["conversationMessages"];
}): Record<string, unknown> | null {
  const match = resolveMatchingLocalCapabilityRoute({
    handle: options.handle,
    prompt: options.prompt,
    conversationMessages: options.conversationMessages,
  });
  if (!match?.route.buildPromptMetadataPatch) {
    return null;
  }
  return match.route.buildPromptMetadataPatch(match.conversationState);
}

export async function executeLocalCapabilityPrompt(
  options: ExecuteLocalCapabilityPromptOptions,
): Promise<LocalCapabilityRuntimeResult> {
  const assistantDefinition = getLocalCapabilityAssistantDefinition(options.handle);
  if (!assistantDefinition) {
    return { handled: false };
  }

  const match = resolveMatchingLocalCapabilityRoute({
    handle: options.handle,
    prompt: options.prompt,
    conversationMessages: options.conversationMessages,
  });
  if (!match) {
    return { handled: false };
  }
  const { route, conversationState } = match;

  let resolvedProviderId: string | null = null;
  let resolvedProvider: LocalProviderSummary | null = null;
  if (route.requiresLocalProvider) {
    const providerAccess = await resolveProjectCapabilityProviderAccess({
      projectId: options.projectId ?? null,
      assistantHandle: options.handle,
      capabilityId: route.capabilityId,
    });
    if (!providerAccess.allowed) {
      const providerLabel =
        providerAccess.provider?.title?.trim() || providerAccess.providerId?.trim() || "Local provider";
      const responseText =
        providerAccess.unavailableReason === "attached_on_other_device"
          ? `${assistantDefinition.displayName} cannot reach ${providerLabel} from this device yet. It is attached on another device, and phone-backed extensions currently run only from that same device.`
          : providerAccess.source === "project_policy_unavailable"
            ? `${assistantDefinition.displayName} cannot verify whether ${providerLabel} is allowed for this project right now. Reconnect the project controller or reopen Extensions, then try again.`
            : `${assistantDefinition.displayName} cannot use ${providerLabel} in this project yet. Open Extensions and attach or enable it there before asking for that real-world action.`;
      return {
        handled: true,
        error: providerAccess.reason ?? "Provider access is not available for this project.",
        responseText,
        metadata: {
          kind: "local_capability_result",
          assistant: {
            handle: assistantDefinition.handle,
            displayName: assistantDefinition.displayName,
          },
          capability: {
            id: route.capabilityId,
            status: "failed",
            code: "provider_access_denied",
          },
          localCapability: {
            id: route.capabilityId,
            status: "failed",
          },
          providerAccess,
        },
      };
    }
    resolvedProviderId = providerAccess.providerId;
    resolvedProvider = providerAccess.provider;
  }

  return route.execute({
    ...options,
    assistantDefinition,
    resolvedProviderId,
    resolvedProvider,
    conversationState,
  });
}
