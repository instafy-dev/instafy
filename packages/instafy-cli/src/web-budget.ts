// SPDX-License-Identifier: AGPL-3.0-only
// The runtime's research-only credential is bound to its granted controller. It never uses a saved CLI login,
// a workspace's server setting, or a page's URL. A broken shared binding must never become a fresh local allowance.

export type ResearchBudget = {
  scope: "this task";
  loadsUsed: number;
  loadsLeft: number;
  loadsPerTurn: number;
  loadsPerHost: number;
  hostSpacingSeconds: number;
  hosts: Record<string, { loads: number; lastAt?: number }>;
};

export type ResearchReservation = {
  allowed: boolean;
  code?: "turn_limit" | "host_limit" | "time_limit";
  waitMs: number;
  budget: ResearchBudget;
};

export class ResearchBudgetError extends Error {}

function invalidResponse(): never {
  throw new ResearchBudgetError("The controller returned an invalid research allowance. No further pages were loaded.");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readBudget(value: unknown): ResearchBudget {
  if (!object(value) || value.scope !== "this task" || !whole(value.loadsPerTurn, 1, 200) ||
      !whole(value.loadsPerHost, 1, value.loadsPerTurn) || !whole(value.loadsUsed, 0, value.loadsPerTurn) ||
      value.loadsLeft !== value.loadsPerTurn - value.loadsUsed || value.hostSpacingSeconds !== 2 ||
      !object(value.hosts) || Object.keys(value.hosts).length > 1_200) invalidResponse();
  for (const entry of Object.values(value.hosts)) {
    if (!object(entry) || !whole(entry.loads, 0, value.loadsPerHost) ||
        (entry.lastAt !== undefined && (typeof entry.lastAt !== "number" || !Number.isFinite(entry.lastAt)))) invalidResponse();
  }
  return value as ResearchBudget;
}

/** Only the trusted runtime environment enables this path. All three bindings must be present together. */
export function sharedResearchBudget(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = globalThis.fetch,
): SharedResearchBudget | null {
  const enabled = env.INSTAFY_RESEARCH_SHARED?.trim();
  const rawUrl = env.INSTAFY_RESEARCH_CONTROLLER_URL?.trim();
  const token = env.INSTAFY_RESEARCH_ACCESS_TOKEN?.trim();
  if (enabled === undefined && rawUrl === undefined && token === undefined) return null;
  if (enabled !== "1" || !rawUrl || !token || /[\r\n]/.test(token)) {
    throw new ResearchBudgetError("This task requires a shared research allowance, but its runtime binding is incomplete. No pages were loaded.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
  } catch {
    throw new ResearchBudgetError("The task's research controller binding is invalid. No pages were loaded.");
  }
  return new SharedResearchBudget(new URL("/agent/research-budget", url.origin), token, fetcher);
}

export class SharedResearchBudget {
  current: ResearchBudget | null = null;

  constructor(private readonly endpoint: URL, private readonly token: string, private readonly fetcher: typeof fetch) {}

  private async request(body?: { loadId: string; requestId: string; host: string; remainingMs: number }, remainingMs = 5_000): Promise<Record<string, unknown>> {
    // A transport retry reuses the reservation IDs, including when the first response was lost after the commit.
    const deadline = Date.now() + Math.max(1, Math.min(5_000, body?.remainingMs ?? remainingMs));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(1, deadline - Date.now()));
      try {
        let response: Response;
        try {
          response = await this.fetcher(this.endpoint.href, {
            method: body ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/json",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            redirect: "error",
            signal: abort.signal,
          });
        } catch {
          if (attempt === 0 && !abort.signal.aborted && Date.now() < deadline) continue;
          throw new ResearchBudgetError("The task's shared research allowance is unavailable. No further pages were loaded; do not switch to a local allowance.");
        }
        if (!response.ok) {
          throw new ResearchBudgetError(`The controller refused the shared research allowance (HTTP ${response.status}). No further pages were loaded.`);
        }
        let value: unknown;
        try { value = await response.json(); } catch { invalidResponse(); }
        if (!object(value)) invalidResponse();
        return value;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ResearchBudgetError("The task's shared research allowance is unavailable.");
  }

  async status(remainingMs = 5_000): Promise<ResearchBudget> {
    const response = await this.request(undefined, remainingMs);
    this.current = readBudget(response.budget);
    return this.current;
  }

  async reserve(loadId: string, requestId: string, host: string, remainingMs: number): Promise<ResearchReservation> {
    const response = await this.request({ loadId, requestId, host, remainingMs: Math.max(0, Math.min(600_000, Math.trunc(remainingMs))) });
    const budget = readBudget(response.budget);
    if (typeof response.allowed !== "boolean" || !whole(response.waitMs, 0, 600_000) ||
        (response.allowed ? response.code !== undefined : !["turn_limit", "host_limit", "time_limit"].includes(String(response.code)))) invalidResponse();
    this.current = budget;
    return { allowed: response.allowed, ...(response.code ? { code: response.code as ResearchReservation["code"] } : {}), waitMs: response.waitMs, budget };
  }
}
