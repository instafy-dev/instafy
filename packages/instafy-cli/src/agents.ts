import kleur from "kleur";
import { requestControllerApiJson } from "./api.js";
import { findProjectManifest } from "./project-manifest.js";

type AgentCommonOptions = {
  project?: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  json?: boolean;
};

export type AgentListOptions = AgentCommonOptions;

export type AgentContextListOptions = AgentCommonOptions & {
  agent?: string;
  agentId?: string;
  scopeKind?: string;
  scopeId?: string;
  query?: string;
  limit?: number;
};

export type AgentContextPutOptions = AgentCommonOptions & {
  agent?: string;
  agentId?: string;
  scopeKind?: string;
  scopeId?: string;
  title?: string;
  context: string;
};

export type AgentPlanGroupStatusOptions = Omit<AgentCommonOptions, "project"> & {
  groupId: string;
};

export type AgentJobsCancelOptions = Omit<AgentCommonOptions, "project"> & {
  group?: string;
  job?: string;
  reason?: string;
};

type ControllerAgent = {
  id: string;
  handle: string;
  displayName?: string | null;
  display_name?: string | null;
  provider?: string | null;
  model?: string | null;
};

type ControllerAgentContext = {
  id: string;
  agentId?: string;
  agent_id?: string;
  agent?: {
    id: string;
    handle: string;
    displayName?: string | null;
    display_name?: string | null;
  };
  scopeKind?: string;
  scope_kind?: string;
  scopeId?: string;
  scope_id?: string;
  title?: string | null;
  context: string;
  updatedAt?: string | null;
  updated_at?: string | null;
};

type ControllerPlanGroupWorker = {
  jobId?: string | null;
  handle?: string | null;
  status?: string | null;
  outcome?: string | null;
  summary?: string | null;
  errorMessage?: string | null;
  scopeSummary?: string | null;
  lastMessage?: string | null;
  terminal?: boolean;
};

type ControllerPlanGroupStatus = {
  groupId?: string;
  conversationId?: string | null;
  hasLeadContinuation?: boolean;
  hasEarlyCheckpoint?: boolean;
  allTerminal?: boolean;
  workers?: ControllerPlanGroupWorker[];
};

type ControllerJobsCancelResponse = {
  ok?: boolean;
  canceledRunIds?: string[];
  canceledJobIds?: string[];
};

const DEFAULT_CONTEXT_LIMIT = 50;
const MAX_CONTEXT_LIMIT = 200;

function trimOrNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProjectId(rawProject: string | undefined): string {
  const explicit = trimOrNull(rawProject);
  if (explicit) {
    return explicit;
  }

  const fromEnv =
    trimOrNull(process.env["SPACE_ID"]) ??
    trimOrNull(process.env["INSTAFY_SPACE_ID"]) ??
    trimOrNull(process.env["PROJECT_ID"]) ??
    trimOrNull(process.env["INSTAFY_PROJECT_ID"]);
  if (fromEnv) {
    return fromEnv;
  }

  const manifest = findProjectManifest(process.cwd()).manifest;
  const fromManifest = trimOrNull(manifest?.spaceId);
  if (fromManifest) {
    return fromManifest;
  }

  throw new Error(
    "No space configured. Pass --space, set SPACE_ID, or run `instafy space init`.",
  );
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value as number)) {
    return DEFAULT_CONTEXT_LIMIT;
  }
  const normalized = Math.trunc(value as number);
  if (normalized < 1) return 1;
  if (normalized > MAX_CONTEXT_LIMIT) return MAX_CONTEXT_LIMIT;
  return normalized;
}

function resolveScopeKind(raw: string | undefined): string {
  return trimOrNull(raw) ?? "conversation";
}

function resolveScopeId(raw: string | undefined, scopeKind: string): string {
  const explicit = trimOrNull(raw);
  if (explicit) {
    return explicit;
  }

  if (scopeKind === "conversation") {
    const fromEnv =
      trimOrNull(process.env["INSTAFY_CONVERSATION_ID"]) ??
      trimOrNull(process.env["CONVERSATION_ID"]);
    if (fromEnv) {
      return fromEnv;
    }
  }

  throw new Error(
    "No scope id configured. Pass --scope-id, or set INSTAFY_CONVERSATION_ID for conversation scope.",
  );
}

function displayName(agent: ControllerAgent): string {
  return trimOrNull(agent.displayName) ?? trimOrNull(agent.display_name) ?? `@${agent.handle}`;
}

function contextScope(card: ControllerAgentContext): string {
  const kind = trimOrNull(card.scopeKind) ?? trimOrNull(card.scope_kind) ?? "scope";
  const id = trimOrNull(card.scopeId) ?? trimOrNull(card.scope_id) ?? "unknown";
  return `${kind}:${id}`;
}

function contextAgentLabel(card: ControllerAgentContext): string {
  const handle = trimOrNull(card.agent?.handle);
  if (handle) {
    return `@${handle}`;
  }
  return trimOrNull(card.agentId) ?? trimOrNull(card.agent_id) ?? "agent";
}

function summarize(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildContextQuery(options: AgentContextListOptions): string[] {
  const query: string[] = [`limit=${normalizeLimit(options.limit)}`];
  if (trimOrNull(options.agent)) {
    query.push(`agent=${trimOrNull(options.agent) as string}`);
  }
  if (trimOrNull(options.agentId)) {
    query.push(`agentId=${trimOrNull(options.agentId) as string}`);
  }
  if (trimOrNull(options.scopeKind)) {
    query.push(`scopeKind=${trimOrNull(options.scopeKind) as string}`);
  }
  if (trimOrNull(options.scopeId)) {
    query.push(`scopeId=${trimOrNull(options.scopeId) as string}`);
  }
  if (trimOrNull(options.query)) {
    query.push(`q=${trimOrNull(options.query) as string}`);
  }
  return query;
}

export async function agentsList(options: AgentListOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const agents = await requestControllerApiJson<ControllerAgent[]>({
    method: "GET",
    path: "/me/agents",
    query: [`projectId=${projectId}`],
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  if (options.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }

  if (!agents.length) {
    console.log(kleur.yellow("No agents found."));
    return;
  }

  console.log(kleur.bold("Agents"));
  for (const agent of agents) {
    const provider = trimOrNull(agent.provider);
    const model = trimOrNull(agent.model);
    const details = [provider, model].filter(Boolean).join(" · ");
    console.log(
      `- ${kleur.cyan(`@${agent.handle}`)} ${displayName(agent)}${details ? ` (${details})` : ""}`,
    );
    console.log(`  id: ${agent.id}`);
  }
}

export async function agentContextsList(options: AgentContextListOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const contexts = await requestControllerApiJson<ControllerAgentContext[]>({
    method: "GET",
    path: `/projects/${encodeURIComponent(projectId)}/agent-contexts`,
    query: buildContextQuery(options),
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  if (options.json) {
    console.log(JSON.stringify(contexts, null, 2));
    return;
  }

  if (!contexts.length) {
    console.log(kleur.yellow("No agent context cards found."));
    return;
  }

  console.log(kleur.bold("Agent context"));
  for (const card of contexts) {
    const title = trimOrNull(card.title);
    const updatedAt = trimOrNull(card.updatedAt) ?? trimOrNull(card.updated_at);
    console.log(
      `- ${kleur.cyan(contextAgentLabel(card))} ${kleur.gray(`[${contextScope(card)}]`)}${title ? ` ${title}` : ""}`,
    );
    console.log(`  ${summarize(card.context)}`);
    if (updatedAt) {
      console.log(`  updated: ${updatedAt}`);
    }
  }
}

export async function agentContextPut(options: AgentContextPutOptions): Promise<void> {
  const projectId = resolveProjectId(options.project);
  const scopeKind = resolveScopeKind(options.scopeKind);
  const scopeId = resolveScopeId(options.scopeId, scopeKind);
  const agent = trimOrNull(options.agent);
  const agentId = trimOrNull(options.agentId);
  if (!agent && !agentId) {
    throw new Error("Pass --agent <handle> or --agent-id <uuid>.");
  }

  const saved = await requestControllerApiJson<ControllerAgentContext>({
    method: "POST",
    path: `/projects/${encodeURIComponent(projectId)}/agent-contexts`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: {
      agent,
      agentId,
      scopeKind,
      scopeId,
      title: trimOrNull(options.title),
      context: options.context,
    },
  });

  if (options.json) {
    console.log(JSON.stringify(saved, null, 2));
    return;
  }

  console.log(
    `${kleur.green("Saved")} ${kleur.cyan(contextAgentLabel(saved))} context for ${kleur.gray(contextScope(saved))}.`,
  );
}

function workerLabel(worker: ControllerPlanGroupWorker): string {
  const handle = trimOrNull(worker.handle);
  if (handle) {
    return handle.startsWith("@") ? handle : `@${handle}`;
  }
  return trimOrNull(worker.jobId) ?? "worker";
}

export async function agentPlanGroupStatus(
  options: AgentPlanGroupStatusOptions,
): Promise<void> {
  const groupId = trimOrNull(options.groupId);
  if (!groupId) {
    throw new Error("Pass a plan group id.");
  }

  const status = await requestControllerApiJson<ControllerPlanGroupStatus>({
    method: "GET",
    path: `/agent/plan-groups/${encodeURIComponent(groupId)}/status`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(kleur.bold(`Plan group ${trimOrNull(status.groupId) ?? groupId}`));
  const conversationId = trimOrNull(status.conversationId);
  if (conversationId) {
    console.log(`  conversation: ${conversationId}`);
  }
  console.log(
    `  allTerminal: ${status.allTerminal === true} · hasEarlyCheckpoint: ${status.hasEarlyCheckpoint === true} · hasLeadContinuation: ${status.hasLeadContinuation === true}`,
  );

  const workers = status.workers ?? [];
  if (!workers.length) {
    console.log(kleur.yellow("No worker jobs found."));
    return;
  }

  for (const worker of workers) {
    const marker = worker.terminal ? "terminal" : "running";
    const details = [trimOrNull(worker.status) ?? "unknown", marker, trimOrNull(worker.outcome)]
      .filter(Boolean)
      .join(" · ");
    console.log(`- ${kleur.cyan(workerLabel(worker))} ${kleur.gray(`[${details}]`)}`);
    const scope = trimOrNull(worker.scopeSummary);
    if (scope) {
      console.log(`  scope: ${scope}`);
    }
    const summary = trimOrNull(worker.summary) ?? trimOrNull(worker.lastMessage);
    if (summary) {
      console.log(`  ${summarize(summary)}`);
    }
    const errorMessage = trimOrNull(worker.errorMessage);
    if (errorMessage) {
      console.log(`  ${kleur.red(`error: ${summarize(errorMessage)}`)}`);
    }
  }
}

export async function agentJobsCancel(options: AgentJobsCancelOptions): Promise<void> {
  const groupId = trimOrNull(options.group);
  const jobId = trimOrNull(options.job);
  if ((groupId && jobId) || (!groupId && !jobId)) {
    throw new Error("Pass exactly one of --group <groupId> or --job <jobId>.");
  }

  const reason = trimOrNull(options.reason);
  const result = await requestControllerApiJson<ControllerJobsCancelResponse>({
    method: "POST",
    path: groupId
      ? `/jobs/plan-groups/${encodeURIComponent(groupId)}/cancel`
      : `/jobs/${encodeURIComponent(jobId as string)}/cancel`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: reason ? { reason } : {},
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const target = groupId ? `plan group ${groupId}` : `job ${jobId}`;
  const canceledJobs = result.canceledJobIds?.length ?? 0;
  const canceledRuns = result.canceledRunIds?.length ?? 0;
  if (!canceledJobs && !canceledRuns) {
    console.log(kleur.yellow(`Nothing to cancel for ${target} (no queued or leased jobs).`));
    return;
  }
  console.log(
    `${kleur.green("Canceled")} ${canceledJobs} job(s) and ${canceledRuns} run(s) for ${target}.`,
  );
}
