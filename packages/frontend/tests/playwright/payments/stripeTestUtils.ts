import type { APIRequestContext, Page } from "@playwright/test";
import crypto from "node:crypto";

export function isTruthy(value: string | undefined | null): boolean {
  return (value ?? "").trim() !== "" && (value ?? "").trim() !== "0";
}

export function resolveStripeEnv() {
  const mapping = (process.env.STRIPE_PRICE_MAPPING ?? "").trim();
  const enabled =
    (process.env.PLAYWRIGHT_STRIPE_E2E ?? "").trim() === "1" ||
    Boolean(process.env.CI);
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  // These specs create real customers/subscriptions and fire webhooks. On a
  // LIVE key that pollutes the production Stripe account (and can generate
  // real invoices), so refuse unless someone very explicitly opts in.
  if (
    secretKey.startsWith("sk_live") &&
    (process.env.STRIPE_ALLOW_LIVE ?? "").trim() !== "1"
  ) {
    throw new Error(
      "Refusing to run payments E2E against a LIVE Stripe key (sk_live…). " +
        "Point STRIPE_SECRET_KEY at a test-mode key, or set STRIPE_ALLOW_LIVE=1 if you really mean it.",
    );
  }
  return {
    enabled,
    secretKey,
    webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim(),
    priceIdPro: (process.env.STRIPE_PRICE_ID_PRO ?? "").trim(),
    priceIdScale: (process.env.STRIPE_PRICE_ID_SCALE ?? "").trim(),
    priceMapping: mapping,
  };
}

export function hasPlanPrice(
  stripe: ReturnType<typeof resolveStripeEnv>,
  planId: string,
): boolean {
  const normalized = planId.toLowerCase().trim();
  if (normalized === "pro") {
    return isTruthy(stripe.priceIdPro) || stripe.priceMapping.toLowerCase().includes("pro:");
  }
  if (normalized === "scale") {
    return isTruthy(stripe.priceIdScale) || stripe.priceMapping.toLowerCase().includes("scale:");
  }
  return stripe.priceMapping.toLowerCase().includes(`${normalized}:`);
}

export function resolvePlanPriceId(
  stripe: ReturnType<typeof resolveStripeEnv>,
  planId: string,
): string {
  const normalized = planId.toLowerCase().trim();
  if (!normalized) return "";
  const direct =
    normalized === "pro"
      ? stripe.priceIdPro
      : normalized === "scale"
        ? stripe.priceIdScale
        : "";
  if (isTruthy(direct)) return direct;

  for (const pair of stripe.priceMapping.split(",")) {
    const [rawKey, rawValue] = pair.split(":");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = (rawValue ?? "").trim();
    if (!key || !value) continue;
    if (key === normalized) return value;
  }
  return "";
}

export function resolveControllerAdminToken(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

export async function resolveUserId(page: Page): Promise<string> {
  const userId = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getUser) {
      return null;
    }
    const result = await client.auth.getUser();
    return result?.data?.user?.id ?? null;
  });
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Unable to resolve authenticated user id for Stripe test.");
  }
  return userId.trim();
}

export async function resolveUserAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const client = (window as any).__INSTAFY_SUPABASE__;
    if (!client?.auth?.getSession) {
      return null;
    }
    const result = await client.auth.getSession();
    return result?.data?.session?.access_token ?? null;
  });
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Unable to resolve Supabase session access token for Stripe test.");
  }
  return token.trim();
}

export function signStripePayload(
  payload: string,
  secret: string,
): { header: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `${timestamp}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(toSign, "utf8").digest("hex");
  return {
    timestamp,
    header: `t=${timestamp},v1=${signature}`,
  };
}

export async function resolvePlanCreditLimit(
  request: APIRequestContext,
  controllerUrl: string,
  accessToken: string,
  projectId: string,
  planId: string,
): Promise<number> {
  const response = await request.get(
    `${controllerUrl}/credits/policy?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`Credit policy request failed (${response.status()}): ${body}`);
  }

  const payload = (await response.json()) as {
    plans?: Array<{ id?: string; creditLimit?: number }>;
  };
  const normalizedPlanId = planId.trim().toLowerCase();
  const plan = Array.isArray(payload.plans)
    ? payload.plans.find(
        (entry) =>
          typeof entry.id === "string" && entry.id.trim().toLowerCase() === normalizedPlanId,
      )
    : null;

  if (!plan || typeof plan.creditLimit !== "number") {
    throw new Error(`Unable to resolve credit limit for plan ${planId}.`);
  }

  return plan.creditLimit;
}
