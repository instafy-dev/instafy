import { expect } from "@playwright/test";

import {
  privateRuntimeTest as test,
  registerPrivateRuntime,
} from "../utils/privateRuntimeHarness.js";

test.describe("Runtime unavailable dispatch retargeting", () => {
  test("queued dispatches pinned to an unavailable runtime can be leased by a healthy runtime", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const unavailableRuntime = await registerPrivateRuntime(request, {
      controllerUrl: controller,
      accessToken,
      projectId,
      displayName: "Unavailable Runtime",
    });
    const stopResponse = await request.post(`${controller}/runtime/stop`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: unavailableRuntime.runtimeId,
        reason: "playwright-runtime-unavailable-retarget",
      },
    });
    expect(stopResponse.ok()).toBeTruthy();

    const healthyRuntime = await registerPrivateRuntime(request, {
      controllerUrl: controller,
      accessToken,
      projectId,
      displayName: "Healthy Runtime",
    });

    const dispatchResponse = await request.post(`${controller}/dispatch-prompt`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId,
        promptText: "Retarget this queued run.",
        intent: "feature",
        runtimeType: "self-hosted",
        runtimeId: unavailableRuntime.runtimeId,
        preferRuntime: true,
      },
    });
    expect(dispatchResponse.ok()).toBeTruthy();
    const dispatchPayload = (await dispatchResponse.json()) as {
      jobId?: string;
      jobIds?: string[];
    };
    const jobId =
      typeof dispatchPayload.jobId === "string"
        ? dispatchPayload.jobId
        : Array.isArray(dispatchPayload.jobIds) && typeof dispatchPayload.jobIds[0] === "string"
          ? dispatchPayload.jobIds[0]
          : null;
    expect(jobId).toBeTruthy();

    const leaseResponse = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${healthyRuntime.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: healthyRuntime.runtimeId,
        max: 1,
        lease_seconds: 120,
      },
    });
    expect(leaseResponse.ok()).toBeTruthy();
    const leasePayload = (await leaseResponse.json()) as { jobs?: Array<{ id?: string }> };
    expect(Array.isArray(leasePayload.jobs)).toBeTruthy();
    expect(leasePayload.jobs?.length ?? 0).toBe(1);
    expect(leasePayload.jobs?.[0]?.id).toBe(jobId);

    const completeResponse = await request.post(`${controller}/agent/complete`, {
      headers: {
        authorization: `Bearer ${healthyRuntime.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        job_id: jobId,
        outcome: "succeeded",
        summary: "playwright runtime unavailable retarget guard",
      },
    });
    expect(completeResponse.ok()).toBeTruthy();
  });
});
