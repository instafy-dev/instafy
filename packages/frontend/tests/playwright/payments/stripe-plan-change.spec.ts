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

test.describe.serial("Stripe plan changes", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("updates credit limit when subscription price changes", async ({ page }) => {
    const stripe = resolveStripeEnv();
    if (!stripe.enabled) {
      test.skip(true, "Set PLAYWRIGHT_STRIPE_E2E=1 to enable Stripe payments E2E coverage.");
    }
    if (!isTruthy(stripe.webhookSecret)) {
      test.skip(true, "Stripe env missing. Need STRIPE_WEBHOOK_SECRET.");
    }

    const proPriceId = resolvePlanPriceId(stripe, "pro");
    const scalePriceId = resolvePlanPriceId(stripe, "scale");
    if (!isTruthy(proPriceId) || !isTruthy(scalePriceId)) {
      test.skip(true, "Stripe env missing Pro/Scale price ids (STRIPE_PRICE_ID_* or STRIPE_PRICE_MAPPING).");
    }

    const controllerUrl = getControllerUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    if (!controllerUrl || !controllerAdminToken) {
      test.skip(true, "Controller URL and service role token are required.");
    }

    const userId = await resolveUserId(page);
    const userAccessToken = await resolveUserAccessToken(page);
    const orgSlug = `playwright-stripe-plan-${Date.now()}`;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(
      page.context().request,
      {
        controllerUrl,
        accessToken: controllerAdminToken,
        ownerUserId: userId,
        orgSlug,
        orgName: "Playwright Stripe Plan Change",
        projectType: "customer"
      }
    );

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Stripe Plan Change Project",
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
    const expectedScaleCreditLimit = await resolvePlanCreditLimit(
      page.context().request,
      controllerUrl,
      userAccessToken,
      projectId,
      "scale",
    );

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();

    const subscriptionId = `sub_test_${Date.now()}`;

    const activateEvent = {
      id: `evt_playwright_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: subscriptionId,
          metadata: {
            orgId,
            planId: "pro",
            projectId
          }
        }
      }
    } as Record<string, any>;

    const activateBody = JSON.stringify(activateEvent);
    const activateSig = signStripePayload(activateBody, stripe.webhookSecret);
    const activateResponse = await page.context().request.post(`${controllerUrl}/billing/webhooks/stripe`, {
      headers: {
        "content-type": "application/json",
        "Stripe-Signature": activateSig.header
      },
      data: activateBody
    });
    if (!activateResponse.ok()) {
      const body = await activateResponse.text().catch(() => "");
      throw new Error(`Stripe activation webhook failed (${activateResponse.status()}): ${body}`);
    }

    await expect
      .poll(async () => Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN), { timeout: 20_000 })
      .toBe(expectedProCreditLimit);

    const upgradeEvent = {
      id: `evt_playwright_${Date.now()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscriptionId,
          status: "active",
          metadata: {
            orgId,
            projectId
          },
          items: {
            data: [
              {
                price: {
                  id: scalePriceId
                }
              }
            ]
          }
        }
      }
    } as Record<string, any>;

    const upgradeBody = JSON.stringify(upgradeEvent);
    const upgradeSig = signStripePayload(upgradeBody, stripe.webhookSecret);
    const upgradeResponse = await page.context().request.post(`${controllerUrl}/billing/webhooks/stripe`, {
      headers: {
        "content-type": "application/json",
        "Stripe-Signature": upgradeSig.header
      },
      data: upgradeBody
    });
    if (!upgradeResponse.ok()) {
      const body = await upgradeResponse.text().catch(() => "");
      throw new Error(`Stripe subscription update webhook failed (${upgradeResponse.status()}): ${body}`);
    }

    const statusAfterUpgrade = await page.context().request.get(
      `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`
        }
      }
    );
    expect(statusAfterUpgrade.ok()).toBeTruthy();
    const payload = (await statusAfterUpgrade.json()) as { creditLimit?: number; balance?: number };
    expect(payload.creditLimit).toBe(expectedScaleCreditLimit);
    expect(payload.balance ?? 0).toBeGreaterThanOrEqual(0);
  });
});
