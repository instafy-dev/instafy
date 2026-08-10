import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled
} from "../sdk/instafy";

export interface CheckoutSessionRequest {
  projectId: string;
  planId: string;
  processor: string;
  successUrl: string;
  cancelUrl?: string;
}

export interface CheckoutSessionResult {
  success: boolean;
  checkoutUrl?: string;
  error?: string;
}

export interface BillingPortalRequest {
  projectId: string;
  returnUrl: string;
}

export interface BillingPortalResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface PlanChangeRequest {
  projectId: string;
  planId: string;
}

export interface PlanChangeResult {
  success: boolean;
  error?: string;
}

const CONTROLLER_DISABLED_ERROR =
  "Runtime controller is not configured. Set VITE_CONTROLLER_URL to enable billing checkout.";

export async function requestCheckoutSession(
  params: CheckoutSessionRequest
): Promise<CheckoutSessionResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }

  const trimmedProject = params.projectId?.trim();
  if (!trimmedProject) {
    return { success: false, error: "Select or create a project before starting checkout." };
  }

  const trimmedPlan = params.planId?.trim();
  if (!trimmedPlan) {
    return { success: false, error: "Choose a plan before starting checkout." };
  }

  const processor = params.processor?.trim();
  if (!processor) {
    return { success: false, error: "Select a billing processor before starting checkout." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return { success: false, error: "Missing controller session token for checkout." };
  }

  const payload = {
    projectId: trimmedProject,
    action: "checkout",
    planId: trimmedPlan,
    processor,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl ?? params.successUrl
  };

  try {
    const response = await fetch(`${requestContext.baseUrl}/billing/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(response, "Checkout failed", requestContext),
      };
    }
    const body = (await response.json()) as { checkoutUrl?: string };
    if (!body.checkoutUrl) {
      return { success: false, error: "Checkout response missing redirect url." };
    }
    return { success: true, checkoutUrl: body.checkoutUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to start checkout: ${message}`
    };
  }
}

/**
 * Switches the org's existing Stripe subscription to another paid plan in
 * place. Used instead of a second checkout, which would create a second live
 * subscription (double billing). The new limits apply once the subscription
 * webhook lands — poll the credit snapshot after a success.
 */
export async function requestPlanChange(params: PlanChangeRequest): Promise<PlanChangeResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }

  const trimmedProject = params.projectId?.trim();
  if (!trimmedProject) {
    return { success: false, error: "Select or create a project before changing plans." };
  }
  const trimmedPlan = params.planId?.trim();
  if (!trimmedPlan) {
    return { success: false, error: "Choose a plan before continuing." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return { success: false, error: "Missing controller session token for plan change." };
  }

  const payload = {
    projectId: trimmedProject,
    action: "changePlan",
    planId: trimmedPlan
  };

  try {
    const response = await fetch(`${requestContext.baseUrl}/billing/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(response, "Plan change failed", requestContext),
      };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to change plan: ${message}`
    };
  }
}

export async function requestBillingPortalSession(
  params: BillingPortalRequest
): Promise<BillingPortalResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: CONTROLLER_DISABLED_ERROR };
  }

  const trimmedProject = params.projectId?.trim();
  if (!trimmedProject) {
    return { success: false, error: "Select or create a project before opening the billing portal." };
  }

  const returnUrl = params.returnUrl?.trim();
  if (!returnUrl) {
    return { success: false, error: "A return URL is required for billing portal." };
  }

  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return { success: false, error: "Missing controller session token for billing portal." };
  }

  const payload = {
    projectId: trimmedProject,
    action: "portal",
    successUrl: returnUrl
  };

  try {
    const response = await fetch(`${requestContext.baseUrl}/billing/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(response, "Billing portal failed", requestContext),
      };
    }

    const body = (await response.json()) as { url?: string };
    if (!body.url) {
      return { success: false, error: "Billing portal response missing url." };
    }
    return { success: true, url: body.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to open billing portal: ${message}`
    };
  }
}
