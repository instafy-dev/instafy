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
  hasPlanPrice,
  isTruthy,
  resolveControllerAdminToken,
  resolvePlanCreditLimit,
  resolveStripeEnv,
  resolveUserAccessToken,
  resolveUserId,
  signStripePayload,
} from "./stripeTestUtils.js";

test.describe.serial("Stripe billing", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("activates Pro plan after Stripe webhook", async ({ page }) => {
    const stripe = resolveStripeEnv();
    if (!stripe.enabled) {
      test.skip(true, "Set PLAYWRIGHT_STRIPE_E2E=1 to enable Stripe payments E2E coverage.");
    }
    if (!isTruthy(stripe.secretKey) || !isTruthy(stripe.webhookSecret) || !hasPlanPrice(stripe, "pro")) {
      test.skip(
        true,
        "Stripe env missing. Need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and a pro price via STRIPE_PRICE_ID_PRO or STRIPE_PRICE_MAPPING."
      );
    }

    const controllerUrl = getControllerUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    if (!controllerUrl || !controllerAdminToken) {
      test.skip(true, "Controller URL and service role token are required.");
    }

    const userId = await resolveUserId(page);
    const userAccessToken = await resolveUserAccessToken(page);
    const orgSlug = `playwright-stripe-${Date.now()}`;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId: userId,
        orgSlug,
        orgName: "Playwright Stripe",
        projectType: "customer"
      }
    );

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Stripe Billing Project",
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
    // Fresh orgs are provisioned on the "starter" plan (daily credit budget),
    // so the pre-checkout baseline is the starter limit — not 0.
    const expectedStarterCreditLimit = await resolvePlanCreditLimit(
      page.context().request,
      controllerUrl,
      userAccessToken,
      projectId,
      "starter",
    );

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    await expect
      .poll(async () => Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedStarterCreditLimit);

    const checkout = await page.context().request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json"
      },
      data: {
        projectId,
        action: "checkout",
        planId: "pro",
        processor: "stripe",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio"
      }
    });
    if (!checkout.ok()) {
      const body = await checkout.text().catch(() => "");
      if ([500, 501].includes(checkout.status())) {
        test.skip(true, `Stripe checkout is not configured/available: ${checkout.status()} ${body}`);
      }
      throw new Error(`Stripe checkout failed (${checkout.status()}): ${body}`);
    }
    const checkoutPayload = (await checkout.json()) as { checkoutUrl?: string };
    expect(checkoutPayload.checkoutUrl).toBeTruthy();

    const statusBeforeWebhook = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(statusBeforeWebhook.ok()).toBeTruthy();
    const statusBefore = (await statusBeforeWebhook.json()) as { creditLimit?: number; balance?: number };
    // Starter plan baseline: limit is the starter budget and the daily refill
    // tops the balance up to it on the first status call.
    expect(statusBefore.creditLimit ?? 0).toBe(expectedStarterCreditLimit);
    expect(statusBefore.balance ?? 0).toBe(expectedStarterCreditLimit);

    const webhookEvent = {
      id: `evt_playwright_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: `sub_test_${Date.now()}`,
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

    const statusAfterWebhook = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(statusAfterWebhook.ok()).toBeTruthy();
    const after = (await statusAfterWebhook.json()) as { creditLimit?: number; balance?: number };
    expect(after.creditLimit).toBe(expectedProCreditLimit);
    expect(after.balance).toBe(expectedProCreditLimit);

    await expect
      .poll(async () => Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedProCreditLimit);
    await expect
      .poll(async () => Number((await page.getByTestId("credits-balance").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedProCreditLimit);
  });

  test("activates Scale plan after Stripe webhook", async ({ page }) => {
    const stripe = resolveStripeEnv();
    if (!stripe.enabled) {
      test.skip(true, "Set PLAYWRIGHT_STRIPE_E2E=1 to enable Stripe payments E2E coverage.");
    }
    if (!isTruthy(stripe.secretKey) || !isTruthy(stripe.webhookSecret) || !hasPlanPrice(stripe, "scale")) {
      test.skip(
        true,
        "Stripe env missing. Need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and a scale price via STRIPE_PRICE_ID_SCALE or STRIPE_PRICE_MAPPING."
      );
    }

    const controllerUrl = getControllerUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    if (!controllerUrl || !controllerAdminToken) {
      test.skip(true, "Controller URL and service role token are required.");
    }

    const userId = await resolveUserId(page);
    const userAccessToken = await resolveUserAccessToken(page);
    const orgSlug = `playwright-stripe-scale-${Date.now()}`;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId: userId,
        orgSlug,
        orgName: "Playwright Stripe Scale",
        projectType: "customer"
      }
    );

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Stripe Billing Scale Project",
    });

    const activeProject = await requireWorkspaceProjectId(page).catch(() => null);
    expect(activeProject).toBe(projectId);
    const expectedScaleCreditLimit = await resolvePlanCreditLimit(
      page.context().request,
      controllerUrl,
      userAccessToken,
      projectId,
      "scale",
    );
    // Fresh orgs are provisioned on the "starter" plan (daily credit budget),
    // so the pre-checkout baseline is the starter limit — not 0.
    const expectedStarterCreditLimit = await resolvePlanCreditLimit(
      page.context().request,
      controllerUrl,
      userAccessToken,
      projectId,
      "starter",
    );

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    await expect
      .poll(async () => Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedStarterCreditLimit);

    const checkout = await page.context().request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json"
      },
      data: {
        projectId,
        action: "checkout",
        planId: "scale",
        processor: "stripe",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio"
      }
    });
    if (!checkout.ok()) {
      const body = await checkout.text().catch(() => "");
      if ([500, 501].includes(checkout.status())) {
        test.skip(true, `Stripe checkout is not configured/available: ${checkout.status()} ${body}`);
      }
      throw new Error(`Stripe checkout failed (${checkout.status()}): ${body}`);
    }

    const statusBeforeWebhook = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(statusBeforeWebhook.ok()).toBeTruthy();
    const statusBefore = (await statusBeforeWebhook.json()) as { creditLimit?: number; balance?: number };
    // Starter plan baseline: limit is the starter budget and the daily refill
    // tops the balance up to it on the first status call.
    expect(statusBefore.creditLimit ?? 0).toBe(expectedStarterCreditLimit);
    expect(statusBefore.balance ?? 0).toBe(expectedStarterCreditLimit);

    const webhookEvent = {
      id: `evt_playwright_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: `sub_test_${Date.now()}`,
          metadata: {
            orgId,
            planId: "scale",
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

    const statusAfterWebhook = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(statusAfterWebhook.ok()).toBeTruthy();
    const after = (await statusAfterWebhook.json()) as { creditLimit?: number; balance?: number };
    expect(after.creditLimit).toBe(expectedScaleCreditLimit);
    expect(after.balance).toBe(expectedScaleCreditLimit);
  });
});
