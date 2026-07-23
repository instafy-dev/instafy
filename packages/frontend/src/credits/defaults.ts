import type { BillingState } from "../types";

export const DEFAULT_BILLING_STATE: BillingState = {
  creditBalance: 0,
  creditLimit: 0,
  lastCreditBurnAt: null,
  lastCreditRefillAt: null,
  subscription: null
};

export function createDefaultBillingState(): BillingState {
  return JSON.parse(JSON.stringify(DEFAULT_BILLING_STATE)) as BillingState;
}

export function cloneBillingState(state: BillingState): BillingState {
  return JSON.parse(JSON.stringify(state)) as BillingState;
}
