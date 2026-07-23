import { test, expect } from "@playwright/test";
import {
  prepareStudio,
  getControllerUrl,
  requireWorkspaceProjectId,
  createControllerOrgAndProject,
  attachControllerProjectToStudio,
} from "../utils/harness.js";
import { openCreditsPanel } from "../utils/sidebar.js";
import {
  isTruthy,
  resolveControllerAdminToken,
  resolvePlanCreditLimit,
  resolvePlanPriceId,
  resolveStripeEnv,
  resolveUserAccessToken,
  resolveUserId,
  signStripePayload,
} from "./stripeTestUtils.js";

async function stripeRequestForm<T>(
  method: "POST" | "DELETE",
  path: string,
  secretKey: string,
  form?: Record<string, string>
): Promise<T> {
  const url = `https://api.stripe.com${path}`;
  const body = form ? new URLSearchParams(form) : undefined;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {})
    },
    body
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Stripe API request failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

test.describe.serial("Stripe billing portal", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("opens Billing Portal for active subscription", async ({ page }) => {
    const stripe = resolveStripeEnv();
    if (!stripe.enabled) {
      test.skip(true, "Set PLAYWRIGHT_STRIPE_E2E=1 to enable Stripe payments E2E coverage.");
    }
    if (!isTruthy(stripe.secretKey) || !isTruthy(stripe.webhookSecret)) {
      test.skip(true, "Stripe env missing. Need STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    }

    const priceId = resolvePlanPriceId(stripe, "pro");
    if (!isTruthy(priceId)) {
      test.skip(true, "Stripe env missing Pro price id (STRIPE_PRICE_ID_PRO or STRIPE_PRICE_MAPPING).");
    }

    const controllerUrl = getControllerUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    if (!controllerUrl || !controllerAdminToken) {
      test.skip(true, "Controller URL and service role token are required.");
    }

    const userId = await resolveUserId(page);
    const userAccessToken = await resolveUserAccessToken(page);
    const orgSlug = `playwright-stripe-portal-${Date.now()}`;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId: userId,
        orgSlug,
        orgName: "Playwright Stripe Portal",
        projectType: "customer"
      }
    );

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Stripe Billing Portal Project",
    });

    const activeProject = await requireWorkspaceProjectId(page).catch(() => null);
    expect(activeProject).toBe(projectId);
    const expectedProCreditLimit = await resolvePlanCreditLimit(
      page.context().request,
      controllerUrl,
      userAccessToken,
      projectId,
      "pro",
    );

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    const customer = await stripeRequestForm<{ id: string }>("POST", "/v1/customers", stripe.secretKey, {
      email: `playwright+portal-${Date.now()}@instafy.dev`,
      name: "Playwright Stripe Portal"
    });

    const subscription = await stripeRequestForm<{ id: string }>(
      "POST",
      "/v1/subscriptions",
      stripe.secretKey,
      {
        customer: customer.id,
        "items[0][price]": priceId,
        trial_period_days: "1"
      }
    );

    const webhookEvent = {
      id: `evt_playwright_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: subscription.id,
          metadata: {
            orgId,
            planId: "pro",
            projectId
          }
        }
      }
    } as Record<string, any>;

    const webhookBody = JSON.stringify(webhookEvent);
    const signature = signStripePayload(webhookBody, stripe.webhookSecret);
    const webhookResponse = await page.context().request.post(`${controllerUrl}/billing/webhooks/stripe`, {
      headers: {
        "content-type": "application/json",
        "Stripe-Signature": signature.header
      },
      data: webhookBody
    });
    if (!webhookResponse.ok()) {
      const body = await webhookResponse.text().catch(() => "");
      throw new Error(`Stripe webhook replay failed (${webhookResponse.status()}): ${body}`);
    }

    await expect
      .poll(async () => Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedProCreditLimit);

    await expect(page.getByTestId("billing-manage-subscription")).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByTestId("billing-manage-subscription").click()
    ]);

    await expect.poll(() => popup.url(), { timeout: 60_000 }).toContain("billing.stripe.com");

    await popup.close().catch(() => {});

    await stripeRequestForm("DELETE", `/v1/subscriptions/${subscription.id}`, stripe.secretKey).catch(() => {});
    await stripeRequestForm("DELETE", `/v1/customers/${customer.id}`, stripe.secretKey).catch(() => {});

    const status = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(status.ok()).toBeTruthy();
    const payload = (await status.json()) as { creditLimit?: number; balance?: number };
    expect(payload.creditLimit).toBe(expectedProCreditLimit);
    expect(payload.balance).toBeGreaterThan(0);
  });
});
