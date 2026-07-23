export type BillingProcessor = "dev" | "stripe";

export interface BillingPlanDefinition {
  id: string;
  name: string;
  description: string;
  creditLimit: number;
  maxActiveTunnels: number;
  maxActiveHostedRuntimes: number;
  monthlyPriceCents: number;
  currency: string;
  processor: BillingProcessor;
  highlight?: string;
}

export const BILLING_PLANS: BillingPlanDefinition[] = [
  {
    id: "starter",
    name: "Starter",
    description:
      "Try Instafy with 3 live connections + 1 hosted machine (~2h/day of runtime credits). Bring your own AI credentials for now.",
    creditLimit: 200,
    maxActiveTunnels: 3,
    maxActiveHostedRuntimes: 1,
    monthlyPriceCents: 0,
    currency: "USD",
    processor: "dev",
    highlight: "Free"
  },
  {
    id: "pro",
    name: "Pro",
    description:
      "More credits + higher limits (up to 10 live connections + 3 hosted machines). Bring your own AI credentials for now.",
    creditLimit: 2000,
    maxActiveTunnels: 10,
    maxActiveHostedRuntimes: 3,
    monthlyPriceCents: 1000,
    currency: "USD",
    processor: "stripe",
    highlight: "Higher limits"
  },
  {
    id: "scale",
    name: "Scale",
    description: "For teams that need higher concurrency (up to 25 live connections + 8 hosted machines).",
    creditLimit: 10000,
    maxActiveTunnels: 25,
    maxActiveHostedRuntimes: 8,
    monthlyPriceCents: 10000,
    currency: "USD",
    processor: "stripe",
    highlight: "Highest limits"
  }
];
