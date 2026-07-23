import { test, expect, type APIRequestContext } from "@playwright/test";
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
  resolvePlanPriceId,
  resolveStripeEnv,
  resolveUserAccessToken,
  resolveUserId,
  signStripePayload,
} from "./stripeTestUtils.js";

interface CreditStatusPayload {
  balance?: number;
  creditLimit?: number;
  subscription?: {
    planId?: string;
    status?: string;
    processor?: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodEnd?: string | null;
  } | null;
}

async function fetchStatus(
  request: APIRequestContext,
  controllerUrl: string,
  accessToken: string,
  projectId: string,
): Promise<CreditStatusPayload> {
  const response = await request.get(
    `${controllerUrl}/credits/status?projectId=${encodeURIComponent(projectId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as CreditStatusPayload;
}

async function postWebhook(
  request: APIRequestContext,
  controllerUrl: string,
  webhookSecret: string,
  event: Record<string, unknown>,
): Promise<number> {
  const body = JSON.stringify(event);
  const signature = signStripePayload(body, webhookSecret);
  const response = await request.post(`${controllerUrl}/billing/webhooks/stripe`, {
    headers: {
      "content-type": "application/json",
      "Stripe-Signature": signature.header,
    },
    data: body,
  });
  return response.status();
}

// Full subscription lifecycle against self-signed webhook events:
// checkout → replay guard → renewal (post-Basil payload shape) → dunning
// grace → recovery → cancel-at-period-end display → cancel (revert to
// Starter) → anti-resurrection → resubscribe.
test.describe.serial("Stripe subscription lifecycle", () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test("survives renewals, dunning, replays, and cancellation", async ({ page }) => {
    const stripe = resolveStripeEnv();
    if (!stripe.enabled) {
      test.skip(true, "Set PLAYWRIGHT_STRIPE_E2E=1 to enable Stripe payments E2E coverage.");
    }
    if (
      !isTruthy(stripe.secretKey) ||
      !isTruthy(stripe.webhookSecret) ||
      !hasPlanPrice(stripe, "pro")
    ) {
      test.skip(
        true,
        "Stripe env missing. Need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and a pro price via STRIPE_PRICE_ID_PRO or STRIPE_PRICE_MAPPING.",
      );
    }
    const proPriceId = resolvePlanPriceId(stripe, "pro");

    const controllerUrl = getControllerUrl();
    const controllerAdminToken = resolveControllerAdminToken();
    if (!controllerUrl || !controllerAdminToken) {
      test.skip(true, "Controller URL and service role token are required.");
    }

    const userId = await resolveUserId(page);
    const userAccessToken = await resolveUserAccessToken(page);
    const request = page.context().request;

    const { projectId, orgId, orgName } = await createControllerOrgAndProject(request, {
      controllerUrl,
      accessToken: controllerAdminToken,
      ownerUserId: userId,
      orgSlug: `playwright-stripe-lifecycle-${Date.now()}`,
      orgName: "Playwright Stripe Lifecycle",
      projectType: "customer",
    });

    await attachControllerProjectToStudio(page, {
      projectId,
      orgId,
      orgName,
      projectName: "Stripe Lifecycle Project",
    });
    const activeProject = await requireWorkspaceProjectId(page).catch(() => null);
    expect(activeProject).toBe(projectId);

    const proLimit = await resolvePlanCreditLimit(
      request,
      controllerUrl,
      userAccessToken,
      projectId,
      "pro",
    );
    const starterLimit = await resolvePlanCreditLimit(
      request,
      controllerUrl,
      userAccessToken,
      projectId,
      "starter",
    );

    await openCreditsPanel(page);
    await expect(page.getByTestId("credits-balance-row")).toBeVisible();
    await expect
      .poll(
        async () =>
          Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN),
        { timeout: 20_000 },
      )
      .toBe(starterLimit);

    const pollUiLimit = (expected: number) =>
      expect
        .poll(
          async () =>
            Number((await page.getByTestId("credits-limit").textContent())?.trim() ?? NaN),
          { timeout: 25_000 },
        )
        .toBe(expected);

    // --- 1. Starting (and abandoning) a checkout must not touch the org's
    // subscription row: the org keeps its Starter entitlements and identity.
    const checkout = await request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId,
        action: "checkout",
        planId: "pro",
        processor: "stripe",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio",
      },
    });
    if (!checkout.ok()) {
      const body = await checkout.text().catch(() => "");
      if ([500, 501].includes(checkout.status())) {
        test.skip(true, `Stripe checkout is not configured/available: ${checkout.status()} ${body}`);
      }
      throw new Error(`Stripe checkout failed (${checkout.status()}): ${body}`);
    }
    const abandoned = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(abandoned.creditLimit).toBe(starterLimit);
    // The pre-checkout row (dev/starter) must be untouched — no status='none',
    // no cs_… external id overwrite.
    expect(abandoned.subscription?.processor ?? "dev").not.toBe("stripe");

    // --- 2. Paid activation via checkout.session.completed.
    const subscriptionId = `sub_test_lifecycle_${Date.now()}`;
    const checkoutCompletedEvent = {
      id: `evt_pw_checkout_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: subscriptionId,
          payment_status: "paid",
          metadata: { orgId, planId: "pro", projectId },
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, checkoutCompletedEvent),
    ).toBe(200);
    await pollUiLimit(proLimit);

    // --- 3. A second checkout while the subscription is live must be refused
    // (it would create a second Stripe subscription: double billing).
    const doubleCheckout = await request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId,
        action: "checkout",
        planId: "scale",
        processor: "stripe",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio",
      },
    });
    expect(doubleCheckout.status()).toBe(409);

    // --- 4. Renewal arrives in the post-Basil (dahlia) payload shape, where
    // the subscription reference lives under parent.subscription_details.
    const renewalEvent = {
      id: `evt_pw_renewal_${Date.now()}`,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: `in_test_${Date.now()}`,
          parent: { subscription_details: { subscription: subscriptionId } },
        },
      },
    };
    expect(await postWebhook(request, controllerUrl, stripe.webhookSecret, renewalEvent)).toBe(
      200,
    );
    const afterRenewal = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterRenewal.creditLimit).toBe(proLimit);
    expect(afterRenewal.subscription?.status).toBe("active");

    // --- 5. A failed renewal charge marks the subscription past_due but must
    // NOT strip the paid limits while Stripe dunning retries the card.
    const dunningEvent = {
      id: `evt_pw_dunning_${Date.now()}`,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_test_${Date.now()}`,
          subscription: subscriptionId,
        },
      },
    };
    expect(await postWebhook(request, controllerUrl, stripe.webhookSecret, dunningEvent)).toBe(
      200,
    );
    const pastDue = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(pastDue.subscription?.status).toBe("past_due");
    expect(pastDue.creditLimit).toBe(proLimit);
    await expect(page.getByTestId("billing-past-due-banner")).toBeVisible({ timeout: 25_000 });

    // --- 6. Dunning recovers: back to active, banner goes away.
    const recoveryEvent = {
      id: `evt_pw_recovery_${Date.now()}`,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: `in_test_${Date.now()}`,
          subscription: subscriptionId,
        },
      },
    };
    expect(await postWebhook(request, controllerUrl, stripe.webhookSecret, recoveryEvent)).toBe(
      200,
    );
    const recovered = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(recovered.subscription?.status).toBe("active");
    expect(recovered.creditLimit).toBe(proLimit);
    await expect(page.getByTestId("billing-past-due-banner")).toBeHidden({ timeout: 25_000 });

    // --- 7. Cancel-at-period-end becomes visible in the app (dahlia shape:
    // current_period_end lives on the subscription item).
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const cancelScheduledEvent = {
      id: `evt_pw_cancel_scheduled_${Date.now()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscriptionId,
          status: "active",
          cancel_at_period_end: true,
          metadata: { orgId, projectId },
          items: {
            data: [
              {
                current_period_end: periodEnd,
                price: { id: proPriceId },
              },
            ],
          },
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, cancelScheduledEvent),
    ).toBe(200);
    const scheduled = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(scheduled.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(scheduled.subscription?.currentPeriodEnd ?? "").not.toBe("");
    await expect(page.getByTestId("billing-renewal-date")).toContainText("Cancels on", {
      timeout: 25_000,
    });

    // --- 8. The period ends: subscription deleted → org reverts to the free
    // Starter tier (never a 0-credit lockout).
    const deletedEvent = {
      id: `evt_pw_deleted_${Date.now()}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subscriptionId,
        },
      },
    };
    expect(await postWebhook(request, controllerUrl, stripe.webhookSecret, deletedEvent)).toBe(
      200,
    );
    const canceled = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(canceled.subscription?.status).toBe("canceled");
    expect(canceled.creditLimit).toBe(starterLimit);
    await pollUiLimit(starterLimit);

    // --- 9. A late/retried invoice.payment_succeeded for the canceled sub
    // must NOT resurrect it with paid credits (out-of-order delivery guard).
    const staleRenewalEvent = {
      id: `evt_pw_stale_renewal_${Date.now()}`,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: `in_test_${Date.now()}`,
          subscription: subscriptionId,
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, staleRenewalEvent),
    ).toBe(200);
    const afterStale = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterStale.subscription?.status).toBe("canceled");
    expect(afterStale.creditLimit).toBe(starterLimit);

    // --- 9b. The same guard must hold on the plan-carrying path: a late
    // customer.subscription.updated (status active, with orgId metadata AND a
    // mapped price) is the shape real Stripe retries have — it must not
    // resurrect the canceled subscription either.
    const staleUpdatedEvent = {
      id: `evt_pw_stale_updated_${Date.now()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscriptionId,
          status: "active",
          metadata: { orgId, projectId },
          items: { data: [{ price: { id: proPriceId } }] },
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, staleUpdatedEvent),
    ).toBe(200);
    const afterStaleUpdated = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterStaleUpdated.subscription?.status).toBe("canceled");
    expect(afterStaleUpdated.creditLimit).toBe(starterLimit);

    // --- 9c. canceled must also not move to past_due (a late
    // invoice.payment_failed would otherwise wedge the org: past_due blocks
    // new checkouts).
    const staleFailedEvent = {
      id: `evt_pw_stale_failed_${Date.now()}`,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_test_${Date.now()}`,
          subscription: subscriptionId,
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, staleFailedEvent),
    ).toBe(200);
    const afterStaleFailed = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterStaleFailed.subscription?.status).toBe("canceled");

    // --- 10. Replaying the ORIGINAL checkout event (same event id, valid
    // signature) must be dropped by idempotency — without it this replay
    // would re-activate Pro for free.
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, checkoutCompletedEvent),
    ).toBe(200);
    const afterReplay = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterReplay.subscription?.status).toBe("canceled");
    expect(afterReplay.creditLimit).toBe(starterLimit);

    // --- 11. Resubscribing after cancellation works via a fresh checkout.
    const resubscribe = await request.post(`${controllerUrl}/billing/checkout`, {
      headers: {
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      data: {
        projectId,
        action: "checkout",
        planId: "pro",
        processor: "stripe",
        successUrl: "https://instafy.dev/studio",
        cancelUrl: "https://instafy.dev/studio",
      },
    });
    expect(resubscribe.ok()).toBeTruthy();
    const newSubscriptionId = `sub_test_resub_${Date.now()}`;
    const resubscribeEvent = {
      id: `evt_pw_resub_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          subscription: newSubscriptionId,
          payment_status: "paid",
          metadata: { orgId, planId: "pro", projectId },
        },
      },
    };
    expect(
      await postWebhook(request, controllerUrl, stripe.webhookSecret, resubscribeEvent),
    ).toBe(200);
    const resubscribed = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(resubscribed.subscription?.status).toBe("active");
    expect(resubscribed.creditLimit).toBe(proLimit);
    await pollUiLimit(proLimit);

    // --- 12. A very late event for the OLD subscription must not clobber the
    // org's NEW live subscription (Stripe retries deliveries for ~72h).
    const oldSubEvent = {
      id: `evt_pw_old_sub_${Date.now()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscriptionId,
          status: "canceled",
          metadata: { orgId, projectId },
          items: { data: [{ price: { id: proPriceId } }] },
        },
      },
    };
    expect(await postWebhook(request, controllerUrl, stripe.webhookSecret, oldSubEvent)).toBe(
      200,
    );
    const afterOldSubEvent = await fetchStatus(request, controllerUrl, userAccessToken, projectId);
    expect(afterOldSubEvent.subscription?.status).toBe("active");
    expect(afterOldSubEvent.creditLimit).toBe(proLimit);
  });
});
