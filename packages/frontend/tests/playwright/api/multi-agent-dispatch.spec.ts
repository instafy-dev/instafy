import { expect, type APIRequestContext } from "@playwright/test";

import {
  privateRuntimeTest as test,
  registerPrivateRuntime,
} from "../utils/privateRuntimeHarness.js";

async function registerRuntime(request: APIRequestContext, input: {
  controller: string;
  accessToken: string;
  projectId: string;
  displayName: string;
}): Promise<{ runtimeId: string; agentToken: string }> {
  return registerPrivateRuntime(request, {
    controllerUrl: input.controller,
    accessToken: input.accessToken,
    projectId: input.projectId,
    displayName: input.displayName,
  });
}

function extractJobAgentHandle(job: unknown): string | null {
  if (!job || typeof job !== "object") {
    return null;
  }
  const payload = (job as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const metadata = (payload as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const agent = (metadata as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object") {
    return null;
  }
  const handle = (agent as { handle?: unknown }).handle;
  return typeof handle === "string" && handle.trim().length > 0
    ? handle.trim().toLowerCase()
    : null;
}

type LeasedAgentJob = {
  id: string;
  payload?: unknown;
  leased_by_runtime_id?: string | null;
  leaseMetrics?: {
    queuedAt?: string;
    leasedAt?: string | null;
    queueWaitMs?: number | null;
    leaseAttempts?: number;
    leasedByRuntimeId?: string | null;
    agentHandle?: string | null;
  };
};

async function leaseJobs(
  request: APIRequestContext,
  controller: string,
  runtime: { runtimeId: string; agentToken: string },
  expectedCount: number,
): Promise<LeasedAgentJob[]> {
  const jobs: LeasedAgentJob[] = [];
  const seenJobIds = new Set<string>();
  for (let attempt = 0; attempt < expectedCount + 2 && jobs.length < expectedCount; attempt += 1) {
    const response = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${runtime.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtime.runtimeId,
        max: Math.min(5, expectedCount - jobs.length),
        lease_seconds: 120,
      },
    });
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as { jobs?: LeasedAgentJob[] };
    const leasedJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    if (leasedJobs.length === 0) {
      break;
    }
    for (const job of leasedJobs) {
      if (!job?.id || seenJobIds.has(job.id)) {
        continue;
      }
      seenJobIds.add(job.id);
      jobs.push(job);
    }
  }
  expect(jobs).toHaveLength(expectedCount);
  return jobs;
}

function expectLeaseMetrics(job: LeasedAgentJob, runtimeId: string, expectedHandle: string) {
  expect(job.leased_by_runtime_id).toBe(runtimeId);
  expect(job.leaseMetrics?.leasedByRuntimeId).toBe(runtimeId);
  expect(job.leaseMetrics?.agentHandle).toBe(expectedHandle);
  expect(typeof job.leaseMetrics?.queuedAt).toBe("string");
  expect(typeof job.leaseMetrics?.leasedAt).toBe("string");
  expect(job.leaseMetrics?.leaseAttempts).toBeGreaterThanOrEqual(1);
  expect(job.leaseMetrics?.queueWaitMs).toBeGreaterThanOrEqual(0);
}

test.describe("Multi-agent dispatch", () => {
  test("fans out one @mention prompt to all mentioned agents", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const runtime = await registerRuntime(request, {
      controller,
      accessToken,
      projectId,
      displayName: "Playwright Multi Agent Runtime",
    });

    const createConversationResponse = await request.post(
      `${controller}/projects/${encodeURIComponent(projectId)}/conversations/blank`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(createConversationResponse.ok()).toBeTruthy();
    const createConversationPayload = (await createConversationResponse.json()) as {
      conversationId?: string;
      conversation_id?: string;
    };
    const conversationId =
      createConversationPayload.conversationId ?? createConversationPayload.conversation_id ?? null;
    expect(conversationId).toBeTruthy();

    const dispatchResponse = await request.post(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          promptText: "Hello @a and @b",
          intent: "question",
          runtimeType: "self-hosted",
          runtimeId: runtime.runtimeId,
          metadata: {
            agentSelection: {
              active: ["octo"],
              mentions: ["a", "b"],
            },
          },
        },
      },
    );
    expect(dispatchResponse.ok()).toBeTruthy();
    const dispatchPayload = (await dispatchResponse.json()) as {
      runIds?: string[];
      runId?: string;
      jobIds?: string[];
      jobId?: string;
    };
    const runIds = Array.isArray(dispatchPayload.runIds)
      ? dispatchPayload.runIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : typeof dispatchPayload.runId === "string"
        ? [dispatchPayload.runId]
        : [];
    const jobIds = Array.isArray(dispatchPayload.jobIds)
      ? dispatchPayload.jobIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : typeof dispatchPayload.jobId === "string"
        ? [dispatchPayload.jobId]
        : [];

    expect(new Set(runIds).size).toBe(2);
    expect(new Set(jobIds).size).toBe(2);

    const jobs = await leaseJobs(request, controller, runtime, 2);

    const leasedJobIds = jobs
      .map((job) => (typeof job.id === "string" ? job.id : null))
      .filter((value): value is string => Boolean(value));
    expect(new Set(leasedJobIds).size).toBe(2);

    const handles = jobs
      .map((job) => extractJobAgentHandle(job))
      .filter((value): value is string => Boolean(value))
      .sort();
    expect(handles).toEqual(["a", "b"]);

    for (const job of jobs) {
      if (!job?.id) {
        continue;
      }
      const handle = extractJobAgentHandle(job) ?? "agent";
      const messageResponse = await request.post(`${controller}/agent/message`, {
        headers: {
          authorization: `Bearer ${runtime.agentToken}`,
          "content-type": "application/json",
        },
        data: {
          job_id: job.id,
          content: `${handle}: independent reply`,
          message_type: "assistant",
        },
      });
      expect(messageResponse.ok()).toBeTruthy();

      const completeResponse = await request.post(`${controller}/agent/complete`, {
        headers: {
          authorization: `Bearer ${runtime.agentToken}`,
          "content-type": "application/json",
        },
        data: {
          job_id: job.id,
          outcome: "succeeded",
          summary: `${handle} done`,
        },
      });
      expect(completeResponse.ok()).toBeTruthy();
    }

    const conversationMessagesResponse = await request.get(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages?limit=100`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    expect(conversationMessagesResponse.ok()).toBeTruthy();
    const conversationMessagesPayload = (await conversationMessagesResponse.json()) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const assistantContents = (conversationMessagesPayload.messages ?? [])
      .filter((message) => message.role === "assistant" && typeof message.content === "string")
      .map((message) => message.content ?? "")
      .filter((content) => content.includes("independent reply"));
    expect(assistantContents).toHaveLength(2);
  });

  test("lets multiple runtimes split fanout work when each runtime leases one job", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const runtimeA = await registerRuntime(request, {
      controller,
      accessToken,
      projectId,
      displayName: "Playwright Fanout Runtime A",
    });
    const runtimeB = await registerRuntime(request, {
      controller,
      accessToken,
      projectId,
      displayName: "Playwright Fanout Runtime B",
    });

    const createConversationResponse = await request.post(
      `${controller}/projects/${encodeURIComponent(projectId)}/conversations/blank`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(createConversationResponse.ok()).toBeTruthy();
    const createConversationPayload = (await createConversationResponse.json()) as {
      conversationId?: string;
      conversation_id?: string;
    };
    const conversationId =
      createConversationPayload.conversationId ?? createConversationPayload.conversation_id ?? null;
    expect(conversationId).toBeTruthy();

    const dispatchResponse = await request.post(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          promptText: "@a inspect routing. @b inspect tests.",
          intent: "question",
          runtimeType: "self-hosted",
          metadata: {
            agentSelection: {
              active: ["octo"],
              mentions: ["a", "b"],
            },
          },
        },
      },
    );
    expect(dispatchResponse.ok()).toBeTruthy();
    const dispatchPayload = (await dispatchResponse.json()) as {
      jobIds?: string[];
      jobId?: string;
    };
    const jobIds = Array.isArray(dispatchPayload.jobIds)
      ? dispatchPayload.jobIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : typeof dispatchPayload.jobId === "string"
        ? [dispatchPayload.jobId]
        : [];
    expect(new Set(jobIds).size).toBe(2);

    async function leaseOne(runtime: { runtimeId: string; agentToken: string }): Promise<LeasedAgentJob> {
      const response = await request.post(`${controller}/agent/lease`, {
        headers: {
          authorization: `Bearer ${runtime.agentToken}`,
          "content-type": "application/json",
        },
        data: {
          runtime_id: runtime.runtimeId,
          max: 1,
          lease_seconds: 120,
        },
      });
      expect(response.ok()).toBeTruthy();
      const payload = (await response.json()) as {
        jobs?: LeasedAgentJob[];
      };
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBeTruthy();
      return jobs[0] as LeasedAgentJob;
    }

    const jobA = await leaseOne(runtimeA);
    const jobB = await leaseOne(runtimeB);
    expect(jobA.id).not.toBe(jobB.id);
    expect(new Set([jobA.id, jobB.id])).toEqual(new Set(jobIds));

    const leasedHandles = [extractJobAgentHandle(jobA), extractJobAgentHandle(jobB)].sort();
    expect(leasedHandles).toEqual(["a", "b"]);
    expectLeaseMetrics(jobA, runtimeA.runtimeId, extractJobAgentHandle(jobA) ?? "");
    expectLeaseMetrics(jobB, runtimeB.runtimeId, extractJobAgentHandle(jobB) ?? "");

    const emptyLeaseResponse = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${runtimeA.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeA.runtimeId,
        max: 1,
        lease_seconds: 120,
      },
    });
    expect(emptyLeaseResponse.ok()).toBeTruthy();
    const emptyLeasePayload = (await emptyLeaseResponse.json()) as { jobs?: unknown[] };
    expect(Array.isArray(emptyLeasePayload.jobs)).toBeTruthy();
    expect(emptyLeasePayload.jobs).toHaveLength(0);
  });

  test("keeps sibling agent outcomes independent when one job fails", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const runtime = await registerRuntime(request, {
      controller,
      accessToken,
      projectId,
      displayName: "Playwright Mixed Outcome Runtime",
    });

    const createConversationResponse = await request.post(
      `${controller}/projects/${encodeURIComponent(projectId)}/conversations/blank`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {},
      },
    );
    expect(createConversationResponse.ok()).toBeTruthy();
    const createConversationPayload = (await createConversationResponse.json()) as {
      conversationId?: string;
      conversation_id?: string;
    };
    const conversationId =
      createConversationPayload.conversationId ?? createConversationPayload.conversation_id ?? null;
    expect(conversationId).toBeTruthy();

    const dispatchResponse = await request.post(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          promptText: "@a summarize routing. @b summarize tests.",
          intent: "question",
          runtimeType: "self-hosted",
          runtimeId: runtime.runtimeId,
          metadata: {
            agentSelection: {
              active: ["octo"],
              mentions: ["a", "b"],
            },
          },
        },
      },
    );
    expect(dispatchResponse.ok()).toBeTruthy();
    const dispatchPayload = (await dispatchResponse.json()) as {
      jobIds?: string[];
      jobId?: string;
    };
    const jobIds = Array.isArray(dispatchPayload.jobIds)
      ? dispatchPayload.jobIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : typeof dispatchPayload.jobId === "string"
        ? [dispatchPayload.jobId]
        : [];
    expect(new Set(jobIds).size).toBe(2);

    const jobs = await leaseJobs(request, controller, runtime, 2);

    const jobByHandle = new Map(
      jobs.map((job) => [extractJobAgentHandle(job), job] as const),
    );
    const jobA = jobByHandle.get("a");
    const jobB = jobByHandle.get("b");
    expect(jobA?.id).toBeTruthy();
    expect(jobB?.id).toBeTruthy();
    expectLeaseMetrics(jobA as LeasedAgentJob, runtime.runtimeId, "a");
    expectLeaseMetrics(jobB as LeasedAgentJob, runtime.runtimeId, "b");

    const completeAResponse = await request.post(`${controller}/agent/complete`, {
      headers: {
        authorization: `Bearer ${runtime.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        job_id: (jobA as LeasedAgentJob).id,
        outcome: "succeeded",
        summary: "A-SUCCESS-INDEPENDENT",
      },
    });
    expect(completeAResponse.ok()).toBeTruthy();

    const completeBResponse = await request.post(`${controller}/agent/complete`, {
      headers: {
        authorization: `Bearer ${runtime.agentToken}`,
        "content-type": "application/json",
      },
      data: {
        job_id: (jobB as LeasedAgentJob).id,
        outcome: "failed",
        error_message: "B-FAILURE-INDEPENDENT",
      },
    });
    expect(completeBResponse.ok()).toBeTruthy();

    const conversationMessagesResponse = await request.get(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages?limit=100`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    expect(conversationMessagesResponse.ok()).toBeTruthy();
    const conversationMessagesPayload = (await conversationMessagesResponse.json()) as {
      messages?: Array<{ role?: string; content?: string; metadata?: Record<string, unknown> }>;
    };
    const assistantMessages = (conversationMessagesPayload.messages ?? []).filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages.some((message) => message.content === "A-SUCCESS-INDEPENDENT")).toBe(true);
    expect(assistantMessages.some((message) => message.content === "B-FAILURE-INDEPENDENT")).toBe(true);
    expect(
      assistantMessages.some((message) => {
        const metadata = message.metadata;
        return (
          message.content === "A-SUCCESS-INDEPENDENT" &&
          typeof metadata?.agent === "object" &&
          (metadata.agent as { handle?: unknown }).handle === "a"
        );
      }),
    ).toBe(true);
    expect(
      assistantMessages.some((message) => {
        const metadata = message.metadata;
        return (
          message.content === "B-FAILURE-INDEPENDENT" &&
          typeof metadata?.agent === "object" &&
          (metadata.agent as { handle?: unknown }).handle === "b" &&
          metadata.outcome === "failed"
        );
      }),
    ).toBe(true);
  });
});
