import { expect } from "@playwright/test";

import {
  privateRuntimeTest as test,
  registerPrivateRuntime,
} from "../utils/privateRuntimeHarness.js";

test.describe("Runtime activity", () => {
  test("explicit idle does not release active job leases", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const { runtimeId, agentToken } = await registerPrivateRuntime(request, {
      controllerUrl: controller,
      accessToken,
      projectId,
      displayName: "Playwright Runtime",
    });

    const dispatchResponse = await request.post(`${controller}/dispatch-prompt`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId,
        promptText: "Write a short hello-world response.",
        intent: "feature",
        runtimeType: "self-hosted",
      },
    });
    expect(dispatchResponse.ok()).toBeTruthy();
    const dispatchPayload = (await dispatchResponse.json()) as Record<string, unknown>;
    const jobId =
      typeof dispatchPayload.jobId === "string"
        ? dispatchPayload.jobId
        : Array.isArray(dispatchPayload.jobIds) && typeof dispatchPayload.jobIds[0] === "string"
          ? dispatchPayload.jobIds[0]
          : null;
    expect(jobId).toBeTruthy();

    const leaseResponse = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeId,
        max: 1,
        lease_seconds: 120,
      },
    });
    expect(leaseResponse.ok()).toBeTruthy();
    const leasePayload = (await leaseResponse.json()) as { jobs?: Array<{ id?: string }> };
    expect(Array.isArray(leasePayload.jobs)).toBeTruthy();
    expect(leasePayload.jobs?.length ?? 0).toBe(1);
    expect(leasePayload.jobs?.[0]?.id).toBe(jobId);

    const idleResponse = await request.post(
      `${controller}/projects/${encodeURIComponent(projectId)}/runtime/activity`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          status: "idle",
          idleTtlSeconds: 90,
          lastInteractionAt: new Date().toISOString(),
        },
      },
    );
    expect(idleResponse.ok()).toBeTruthy();
    const idlePayload = (await idleResponse.json()) as Record<string, unknown>;
    expect(idlePayload.ok).toBe(true);
    expect(idlePayload.releasedJobs).toBe(0);

    const leaseAgainResponse = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeId,
        max: 1,
        lease_seconds: 120,
      },
    });
    expect(leaseAgainResponse.ok()).toBeTruthy();
    const leaseAgainPayload = (await leaseAgainResponse.json()) as { jobs?: unknown[] };
    expect(Array.isArray(leaseAgainPayload.jobs)).toBeTruthy();
    expect(leaseAgainPayload.jobs?.length ?? 0).toBe(0);

    const completeResponse = await request.post(`${controller}/agent/complete`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        job_id: jobId,
        outcome: "succeeded",
        summary: "playwright runtime activity idle guard",
      },
    });
    expect(completeResponse.ok()).toBeTruthy();
  });
});
