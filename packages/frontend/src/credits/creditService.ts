import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled
} from "../sdk/instafy";

export interface CreditSnapshot {
  balance: number;
  creditLimit: number;
  lastBurnAt: string | null;
  lastRefillAt: string | null;
  subscription?: {
    planId: string;
    status: string;
    processor: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodEnd?: string | null;
  } | null;
}

export interface CreditSnapshotResult {
  success: boolean;
  snapshot?: CreditSnapshot;
  error?: string;
}

export interface CreditLedgerEntry {
  delta: number;
  reason: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreditLedgerResult {
  success: boolean;
  entries?: CreditLedgerEntry[];
  error?: string;
}

export interface CreditPolicyPlan {
  id: string;
  name: string;
  currency: string;
  monthlyPriceCents: number;
  creditLimit: number;
  maxActiveTunnels: number;
  maxActiveHostedRuntimes: number;
}

export interface CreditUsageRate {
  reason: string;
  enabled: boolean;
  amount: number;
  intervalSeconds: number;
  creditsPerMinute: number;
}

export interface ManagedAiUsageRate {
  reason: string;
  enabled: boolean;
  label: string;
  provider?: string;
  creditsPerPrompt: number;
  dailyPromptLimit: number;
  modelLabel: string;
  inputUsdMicrosPer1k: number;
  cachedInputUsdMicrosPer1k: number;
  outputUsdMicrosPer1k: number;
}

export interface HostedRuntimeProviderUsageRate {
  providerId: string;
  displayName: string;
  enabled: boolean;
  amount: number;
  intervalSeconds: number;
  creditsPerMinute: number;
}

export interface RuntimeSizePolicy {
  id: string;
  label: string;
  cpuCount: number;
  memoryGb: number;
  creditsPerMinute: number;
  creditsPerHour: number;
}

export interface CreditPolicy {
  display: {
    unitLabel: string;
    currency: string;
    unitsPerUsd: number;
  };
  refill: {
    kind: string;
    timezone: string;
  };
  plans: CreditPolicyPlan[];
  usage: {
    tunnel: CreditUsageRate;
    hostedRuntime: CreditUsageRate;
    hostedRuntimeProviders?: HostedRuntimeProviderUsageRate[];
    runtimeSizes?: RuntimeSizePolicy[];
    managedAi: ManagedAiUsageRate;
  };
}

export interface CreditPolicyResult {
  success: boolean;
  policy?: CreditPolicy;
  error?: string;
}

const CONTROLLER_DISABLED_ERROR =
  "Runtime controller is not configured. Set VITE_CONTROLLER_URL to enable credit status.";

export async function fetchCreditSnapshot(projectId: string): Promise<CreditSnapshotResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }
  const trimmedProjectId = projectId?.trim();
  if (!trimmedProjectId) {
    return { success: false, error: "A project id is required to load credits." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return {
      success: false,
      error: "Missing session token for controller credits check."
    };
  }

  const url = new URL(`${requestContext.baseUrl}/credits/status`);
  url.searchParams.set("projectId", trimmedProjectId);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(response, "Credits request failed", requestContext),
      };
    }

    const payload = (await response.json()) as {
      balance?: number;
      creditLimit?: number;
      lastBurnAt?: string | null;
      lastRefillAt?: string | null;
      subscription?: {
        planId?: string;
        status?: string;
        processor?: string;
        cancelAtPeriodEnd?: boolean;
        currentPeriodEnd?: string | null;
      } | null;
      credit_limit?: number;
      last_burn_at?: string | null;
      last_refill_at?: string | null;
    };

    const subscription =
      payload.subscription &&
      typeof payload.subscription === "object" &&
      typeof payload.subscription.planId === "string" &&
      typeof payload.subscription.status === "string" &&
      typeof payload.subscription.processor === "string"
        ? {
            planId: payload.subscription.planId,
            status: payload.subscription.status,
            processor: payload.subscription.processor,
            cancelAtPeriodEnd: payload.subscription.cancelAtPeriodEnd === true,
            currentPeriodEnd:
              typeof payload.subscription.currentPeriodEnd === "string"
                ? payload.subscription.currentPeriodEnd
                : null
          }
        : null;

    return {
      success: true,
      snapshot: {
        balance: typeof payload.balance === "number" ? payload.balance : 0,
        creditLimit:
          typeof payload.creditLimit === "number"
            ? payload.creditLimit
            : typeof payload.credit_limit === "number"
              ? payload.credit_limit
              : 0,
        lastBurnAt: payload.lastBurnAt ?? payload.last_burn_at ?? null,
        lastRefillAt: payload.lastRefillAt ?? payload.last_refill_at ?? null,
        subscription
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to load credits: ${message}`
    };
  }
}

export async function fetchCreditLedger(
  projectId: string,
  limit = 25
): Promise<CreditLedgerResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }
  const trimmedProjectId = projectId?.trim();
  if (!trimmedProjectId) {
    return { success: false, error: "A project id is required to load credits." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return {
      success: false,
      error: "Missing session token for controller credits check."
    };
  }

  const normalizedLimit = Math.min(Math.max(limit, 5), 100);
  const url = new URL(`${requestContext.baseUrl}/credits/ledger`);
  url.searchParams.set("projectId", trimmedProjectId);
  url.searchParams.set("limit", normalizedLimit.toString());

  try {
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(
          response,
          "Credits ledger request failed",
          requestContext,
        ),
      };
    }

    const payload = (await response.json()) as {
      entries?: Array<{
        delta?: number;
        reason?: string;
        metadata?: Record<string, unknown> | null;
        createdAt?: string;
        created_at?: string;
      }>;
    };

    const entries: CreditLedgerEntry[] = Array.isArray(payload.entries)
      ? payload.entries
          .map((entry) => ({
            delta: typeof entry.delta === "number" ? entry.delta : 0,
            reason: entry.reason ?? "activity",
            metadata: entry.metadata ?? null,
            createdAt: entry.createdAt ?? entry.created_at ?? ""
          }))
          .filter((entry) => entry.createdAt.length > 0)
      : [];

    return { success: true, entries };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to load credit activity: ${message}`
    };
  }
}

export async function fetchCreditPolicy(projectId: string): Promise<CreditPolicyResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }
  const trimmedProjectId = projectId?.trim();
  if (!trimmedProjectId) {
    return { success: false, error: "A project id is required to load credit policy." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return {
      success: false,
      error: "Missing session token for controller credit policy request."
    };
  }

  const url = new URL(`${requestContext.baseUrl}/credits/policy`);
  url.searchParams.set("projectId", trimmedProjectId);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(
          response,
          "Credit policy request failed",
          requestContext,
        ),
      };
    }

    const payload = (await response.json()) as CreditPolicy;
    if (!payload || typeof payload !== "object") {
      return { success: false, error: "Credit policy response was invalid." };
    }

    return { success: true, policy: payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to load credit policy: ${message}`
    };
  }
}
