// Background phone-side claim loop for Knosh's contract-owned robot skills.
// Instafy mounts this component through the trusted feature-module seam but
// remains unaware of the product-specific request family and execution logic.

import { useEffect, useRef } from "react";
import {
  integrationIsAttached,
  providerRequestTargetsCurrentDevice,
  useActiveProjectId,
} from "@instafy/frontend/feature-api/runtime-bridge";

import { KNOSH_PROVIDER_FAMILY } from "../../provider/family.mjs";
import { postProbe, type RobotBridgeEvent } from "../robot/bridgeClient";
import { KNOSH_NATIVE_CAPABILITY_RUNTIME } from "../robot/nativeRobotRuntime";
import {
  findContractSkill,
  runSkill,
  skillIdFromToolName,
  type SkillRunnerHooks,
} from "../robot/skillRunner";

type ControllerFeatureApi = typeof import(
  "@instafy/frontend/feature-api/controller"
);
type ControllerClient = ControllerFeatureApi["controllerClient"];
type ProviderRequestRecord = Awaited<
  ReturnType<ControllerClient["providerRequests"]["list"]>
>[number];

function loadControllerFeatureApi(): Promise<ControllerFeatureApi> {
  return import("@instafy/frontend/feature-api/controller");
}

const IDLE_DELAY_MS = 2_500;
const GATED_DELAY_MS = 10_000;
const BUSY_DELAY_MS = 2_000;
const HANDLED_DELAY_MS = 500;
const DEFAULT_DELAY_MS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Only exact tool IDs present in the current @knosh/contract are claimable.
 * This deliberately does not match the broader knosh.robot.* namespace.
 */
export function isClaimableKnoshSkillToolRequest(
  request: ProviderRequestRecord,
): boolean {
  if (
    request.requestKind !== "tool_call" ||
    !KNOSH_NATIVE_CAPABILITY_RUNTIME.matchesProvider({
      providerId: request.providerId,
    })
  ) {
    return false;
  }
  const skillId = skillIdFromToolName(request.toolName ?? "");
  const skill = skillId ? findContractSkill(skillId) : null;
  return Boolean(
    skill &&
      !skill.steps.some((step) => "driveTo" in step) &&
      skill.postconditions.every(
        (postcondition) => postcondition.kind === "joint_near",
      ),
  );
}

export function jointStateFromProbeEvents(
  events: readonly RobotBridgeEvent[] | undefined,
): Record<string, number> | null {
  for (const event of [...(events ?? [])].reverse()) {
    if (event.event !== "telemetry" && event.kind !== "telemetry") {
      continue;
    }
    const value = isRecord(event.value) ? event.value : event;
    const observation = isRecord(value.observation) ? value.observation : null;
    const jointState = Array.isArray(observation?.joint_state)
      ? observation.joint_state
      : [];
    const joints: Record<string, number> = {};
    for (const joint of jointState) {
      if (
        isRecord(joint) &&
        typeof joint.joint_name === "string" &&
        typeof joint.position_deg === "number" &&
        Number.isFinite(joint.position_deg)
      ) {
        joints[joint.joint_name] = joint.position_deg;
      }
    }
    if (Object.keys(joints).length > 0) {
      return joints;
    }
  }
  return null;
}

export function buildKnoshSkillRunnerHooks(
  probeOptions: { providerId: string; projectId: string },
  postProbeFn: typeof postProbe = postProbe,
): SkillRunnerHooks {
  return {
    sendCommand: async (command) => {
      const response = await postProbeFn(
        { commandJson: command },
        probeOptions,
      );
      if (!response.ok) {
        throw new Error(
          response.error?.trim() || "Robot bridge command failed.",
        );
      }
    },
    readJointState: async () => {
      const response = await postProbeFn(
        { commandJson: { name: "stop_all_motion" } },
        probeOptions,
      );
      if (!response.ok) {
        throw new Error(
          response.error?.trim() ||
            "Robot bridge telemetry probe failed.",
        );
      }
      const joints = jointStateFromProbeEvents(response.events);
      if (!joints) {
        throw new Error(
          "telemetry reply carried no joint_state observation",
        );
      }
      return joints;
    },
  };
}

export type KnoshSkillExecutionDeps = {
  postProbe?: typeof postProbe;
  runSkill?: typeof runSkill;
};

export async function executeKnoshSkillToolRequest(
  request: ProviderRequestRecord,
  providerId: string,
  projectId: string,
  deps: KnoshSkillExecutionDeps = {},
): Promise<Record<string, unknown>> {
  const toolName = request.toolName ?? "";
  const skillId = skillIdFromToolName(toolName);
  if (!skillId || !findContractSkill(skillId)) {
    return {
      ok: false,
      providerId,
      name: toolName,
      error: `Unsupported Knosh skill tool: ${toolName || "unknown"}.`,
    };
  }

  const hooks = buildKnoshSkillRunnerHooks(
    { providerId, projectId },
    deps.postProbe ?? postProbe,
  );
  const result = await (deps.runSkill ?? runSkill)(
    skillId,
    request.arguments,
    hooks,
  );
  return {
    ok: result.status === "succeeded",
    providerId,
    name: toolName,
    value: result,
  };
}

export type KnoshSkillClaimDeps = KnoshSkillExecutionDeps & {
  claim?: ControllerClient["providerRequests"]["claim"];
  complete?: ControllerClient["providerRequests"]["complete"];
};

export async function handleKnoshSkillProviderRequest(
  params: {
    projectId: string;
    request: ProviderRequestRecord;
    deviceId: string;
    deviceLabel?: string | null;
  },
  deps: KnoshSkillClaimDeps = {},
): Promise<boolean> {
  if (!isClaimableKnoshSkillToolRequest(params.request)) {
    return false;
  }

  const providerId = params.request.providerId;
  const controllerApi =
    deps.claim && deps.complete
      ? null
      : await loadControllerFeatureApi();
  const claim =
    deps.claim ??
    controllerApi?.controllerClient.providerRequests.claim;
  const complete =
    deps.complete ??
    controllerApi?.controllerClient.providerRequests.complete;
  if (!claim || !complete) {
    throw new Error("Instafy provider-request API is unavailable.");
  }

  const claimed = await claim({
    projectId: params.projectId,
    requestId: params.request.id,
    providerId,
    deviceId: params.deviceId,
    deviceLabel: params.deviceLabel ?? undefined,
  }).catch(() => null);

  if (!claimed || claimed.status !== "claimed") {
    return false;
  }

  let response: Record<string, unknown>;
  try {
    response = await executeKnoshSkillToolRequest(
      params.request,
      providerId,
      params.projectId,
      deps,
    );
  } catch (error) {
    response = {
      ok: false,
      providerId,
      name: params.request.toolName ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await complete({
    projectId: params.projectId,
    requestId: params.request.id,
    providerId,
    deviceId: params.deviceId,
    response,
  });
  return true;
}

export function KnoshSkillRequestBridge() {
  const activeProjectId = useActiveProjectId();
  const busyRef = useRef(false);

  useEffect(() => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectId) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timerId = window.setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || busyRef.current) {
        schedule(BUSY_DELAY_MS);
        return;
      }

      busyRef.current = true;
      let nextDelayMs = DEFAULT_DELAY_MS;

      try {
        const {
          controllerClient,
          getProjectIntegrationByProvider,
          getProjectProviderSelectedDevice,
        } = await loadControllerFeatureApi();
        const integrationsResult = await controllerClient.integrations
          .listForProject(projectId)
          .catch(() => null);
        const integration = integrationsResult?.success
          ? getProjectIntegrationByProvider(
              integrationsResult.integrations,
              KNOSH_PROVIDER_FAMILY.id,
            )
          : null;
        if (!integration || !integrationIsAttached(integration)) {
          nextDelayMs = GATED_DELAY_MS;
          return;
        }

        const providerId = integration.provider;
        const selection = await KNOSH_NATIVE_CAPABILITY_RUNTIME.resolveSelection(
          {
            providerId,
            selectedDevice:
              getProjectProviderSelectedDevice(integration),
          },
        ).catch(() => null);
        const deviceId = selection?.transportTarget.trim() ?? "";
        if (!selection || !deviceId) {
          nextDelayMs = GATED_DELAY_MS;
          return;
        }

        const pendingRequests = await controllerClient.providerRequests
          .list({
            projectId,
            providerId,
            statuses: ["pending", "claimed"],
            limit: 5,
          })
          .catch(() => []);

        const nextRequest =
          pendingRequests.find(
            (request) =>
              isClaimableKnoshSkillToolRequest(request) &&
              providerRequestTargetsCurrentDevice(
                request,
                providerId,
                deviceId,
              ),
          ) ?? null;

        if (!nextRequest) {
          nextDelayMs = IDLE_DELAY_MS;
          return;
        }

        await handleKnoshSkillProviderRequest({
          projectId,
          request: nextRequest,
          deviceId,
          deviceLabel: selection.selectedDevice?.name ?? null,
        });
        nextDelayMs = HANDLED_DELAY_MS;
      } finally {
        busyRef.current = false;
        schedule(nextDelayMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeProjectId]);

  return null;
}
