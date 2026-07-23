import { requestControllerApiJson } from "./api.js";

export interface OperatorProjectSupportSnapshot {
  project: {
    projectId: string;
    projectName?: string | null;
    projectType?: string | null;
    ownerUserId?: string | null;
    ownerEmail?: string | null;
    orgId: string;
    orgName?: string | null;
    orgSlug?: string | null;
  };
  credits: {
    balance: number;
    creditLimit: number;
    lastBurnAt?: string | null;
    lastRefillAt?: string | null;
    subscription?: {
      planId: string;
      status: string;
      processor: string;
    } | null;
    entries: Array<{
      delta: number;
      reason: string;
      metadata?: Record<string, unknown> | null;
      createdAt: string;
    }>;
  };
  runtime: {
    preferredRuntimeId?: string | null;
    runtimes: Array<{
      runtimeId: string;
      status: string;
      provider: string;
      displayName?: string | null;
      health: string;
      isLocal: boolean;
      lastSeenAt?: string | null;
      endpointUrl?: string | null;
      taskRef?: string | null;
    }>;
  };
}

export interface OperatorProjectSearchResult {
  projectId: string;
  projectName?: string | null;
  projectType?: string | null;
  projectStatus?: string | null;
  ownerUserId?: string | null;
  ownerEmail?: string | null;
  orgId: string;
  orgName?: string | null;
  orgSlug?: string | null;
}

interface OperatorCreditSnapshot {
  balance: number;
  creditLimit: number;
  lastBurnAt?: string | null;
  lastRefillAt?: string | null;
  subscription?: {
    planId: string;
    status: string;
    processor: string;
  } | null;
  entries: Array<{
    delta: number;
    reason: string;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
  }>;
}

interface BaseOpsOptions {
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  json?: boolean;
}

interface ProjectOpsOptions extends BaseOpsOptions {
  projectId: string;
}

interface ProjectSearchOptions extends BaseOpsOptions {
  query: string;
  limit?: number;
}

interface CreditAdjustOptions extends ProjectOpsOptions {
  amount: number;
  note?: string;
}

interface RuntimeStopOptions extends ProjectOpsOptions {
  runtimeId: string;
  reason?: string;
}

export async function opsLoadSupport(options: ProjectOpsOptions): Promise<OperatorProjectSupportSnapshot> {
  return requestControllerApiJson<OperatorProjectSupportSnapshot>({
    method: "GET",
    path: `/operator/projects/${encodeURIComponent(options.projectId)}/support`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });
}

export async function opsProjectsSearch(options: ProjectSearchOptions) {
  const params = new URLSearchParams();
  params.set("q", options.query);
  params.set("limit", String(options.limit ?? 10));

  const response = await requestControllerApiJson<{ projects: OperatorProjectSearchResult[] }>({
    method: "GET",
    path: `/operator/projects/search?${params.toString()}`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  if (options.json) {
    printJson(response.projects);
    return;
  }

  if (!response.projects.length) {
    console.log("No projects matched.");
    return;
  }

  console.table(
    response.projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName ?? "",
      projectType: project.projectType ?? "",
      projectStatus: project.projectStatus ?? "",
      org: project.orgName ?? project.orgSlug ?? project.orgId,
      ownerEmail: project.ownerEmail ?? "",
    })),
  );
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printCreditSummary(label: string, credits: OperatorCreditSnapshot) {
  console.log(`${label}`);
  console.log(`Balance: ${credits.balance}`);
  console.log(`Limit: ${credits.creditLimit}`);
  if (credits.subscription) {
    console.log(
      `Plan: ${credits.subscription.planId} (${credits.subscription.status}, ${credits.subscription.processor})`,
    );
  }
  if (credits.lastBurnAt) {
    console.log(`Last burn: ${credits.lastBurnAt}`);
  }
  if (credits.lastRefillAt) {
    console.log(`Last refill: ${credits.lastRefillAt}`);
  }
}

export async function opsCreditsStatus(options: ProjectOpsOptions) {
  const snapshot = await opsLoadSupport(options);
  if (options.json) {
    printJson(snapshot.credits);
    return;
  }
  console.log(`Project: ${snapshot.project.projectId}`);
  console.log(`Org: ${snapshot.project.orgName ?? snapshot.project.orgSlug ?? snapshot.project.orgId}`);
  printCreditSummary("Credits", snapshot.credits);
}

async function adjustCredits(
  action: "add" | "set",
  options: CreditAdjustOptions,
): Promise<OperatorCreditSnapshot> {
  return requestControllerApiJson<OperatorCreditSnapshot>({
    method: "POST",
    path: `/operator/projects/${encodeURIComponent(options.projectId)}/credits/adjust`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: {
      action,
      amount: options.amount,
      note: options.note,
    },
  });
}

export async function opsCreditsAdd(options: CreditAdjustOptions) {
  const credits = await adjustCredits("add", options);
  if (options.json) {
    printJson(credits);
    return;
  }
  printCreditSummary("Updated credits", credits);
}

export async function opsCreditsSet(options: CreditAdjustOptions) {
  const credits = await adjustCredits("set", options);
  if (options.json) {
    printJson(credits);
    return;
  }
  printCreditSummary("Updated credits", credits);
}

export async function opsRuntimesList(options: ProjectOpsOptions) {
  const snapshot = await opsLoadSupport(options);
  if (options.json) {
    printJson(snapshot.runtime);
    return;
  }

  if (!snapshot.runtime.runtimes.length) {
    console.log("No runtimes found for project.");
    return;
  }

  console.table(
    snapshot.runtime.runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      displayName: runtime.displayName ?? "",
      provider: runtime.provider,
      status: runtime.status,
      health: runtime.health,
      local: runtime.isLocal ? "yes" : "no",
      lastSeenAt: runtime.lastSeenAt ?? "",
    })),
  );
}

export async function opsRuntimesStop(options: RuntimeStopOptions) {
  const response = await requestControllerApiJson<{ ok: boolean }>({
    method: "POST",
    path: `/operator/projects/${encodeURIComponent(options.projectId)}/runtimes/${encodeURIComponent(options.runtimeId)}/stop`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: {
      reason: options.reason,
    },
  });

  if (options.json) {
    printJson(response);
    return;
  }
  console.log(response.ok ? "Runtime stopped." : "Runtime stop request returned no confirmation.");
}
