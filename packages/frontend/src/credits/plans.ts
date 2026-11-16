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

// A description shows on its plan's card in Credits > Plans, above the plan's
// credits a day, live connections and hosted machines. Those come from the
// controller's plan catalog (billing_plans, which an operator can change), so
// a description repeats none of them. It names no hosted machine hours either
// (their rate is 0 until an operator sets one), and nothing about how AI is
// paid for: Instafy AI, where it is on, spends credits on every plan, and a
// person's own AI connection spends none.
export const BILLING_PLANS: BillingPlanDefinition[] = [
  {
    id: "starter",
    name: "Starter",
    description: "Try Instafy.",
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
    description: "More credits and higher limits.",
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
    description: "For teams that need more hosted machines and live connections at once.",
    creditLimit: 10000,
    maxActiveTunnels: 25,
    maxActiveHostedRuntimes: 8,
    monthlyPriceCents: 10000,
    currency: "USD",
    processor: "stripe",
    highlight: "Highest limits"
  }
];
