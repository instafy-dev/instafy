use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tracing::{error, field, info, instrument, warn};
use uuid::Uuid;

use crate::billing::plans;
use crate::billing::processors::stripe::{
    invoice_subscription_reference, subscription_snapshot_from_object, SubscriptionSnapshot,
};
use crate::billing::processors::{self, ProcessorKind};
use crate::billing::service;
use crate::billing::service::StatusUpdateOutcome;
use crate::{bad_request, internal_error, ApiError, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/billing/webhooks/stripe", post(handle_stripe_webhook))
}

#[instrument(skip_all, fields(event_kind = field::Empty))]
async fn handle_stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let config = state
        .config
        .stripe
        .as_ref()
        .ok_or_else(|| internal_error("Stripe processor is not configured"))?;
    let webhook_secret = config
        .webhook_secret
        .as_deref()
        .ok_or_else(|| internal_error("STRIPE_WEBHOOK_SECRET is not configured"))?;
    let signature_header = headers
        .get("Stripe-Signature")
        .ok_or_else(|| bad_request("Missing Stripe-Signature header"))?
        .to_str()
        .map_err(|_| bad_request("Invalid Stripe-Signature header"))?;

    if !verify_stripe_signature(
        webhook_secret,
        &body,
        signature_header,
        config.webhook_tolerance_seconds,
    ) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError::new("Invalid Stripe webhook signature")),
        ));
    }

    let payload_str = std::str::from_utf8(&body)
        .map_err(|_| bad_request("Stripe webhook payload must be valid UTF-8"))?;
    let event: StripeWebhookEvent = serde_json::from_str(payload_str)
        .map_err(|error| bad_request(&format!("Invalid Stripe webhook payload: {error}")))?;
    tracing::Span::current().record("event_kind", &field::display(&event.kind));

    // Idempotency: Stripe retries deliveries for days and does not guarantee
    // order; a replayed event must not re-apply a state transition.
    {
        let connection = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        let seen = service::webhook_event_seen(&*connection, &event.id)
            .await
            .map_err(internal_error)?;
        if seen {
            info!(event = %event.id, kind = %event.kind, "stripe webhook replay ignored (already processed)");
            return Ok(StatusCode::OK);
        }
    }

    process_stripe_event(&state, &event).await?;

    // Recorded only after successful processing so a failed handler is
    // retried by Stripe instead of being skipped as already-processed.
    {
        let connection = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        if let Err(error) =
            service::record_webhook_event(&*connection, &event.id, &event.kind).await
        {
            warn!(event = %event.id, kind = %event.kind, %error, "failed to record processed webhook event");
        }
    }

    Ok(StatusCode::OK)
}

async fn process_stripe_event(
    state: &AppState,
    event: &StripeWebhookEvent,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let config = state
        .config
        .stripe
        .as_ref()
        .ok_or_else(|| internal_error("Stripe processor is not configured"))?;
    let object = &event.data.object;

    match event.kind.as_str() {
        "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
            let metadata = stripe_metadata(object);
            let org_id = parse_uuid(
                metadata.get("orgId").map(String::as_str),
                "Stripe metadata orgId",
            )?;
            let plan_id = metadata
                .get("planId")
                .ok_or_else(|| bad_request("Stripe metadata planId missing"))?;

            // Async payment methods (e.g. SEPA) complete the session before the
            // charge settles; entitlement waits for async_payment_succeeded.
            if event.kind == "checkout.session.completed"
                && stripe_string_field(object, "payment_status").as_deref() == Some("unpaid")
            {
                info!(
                    event = %event.id,
                    org_id = %org_id,
                    plan = %plan_id,
                    "stripe checkout completed but unpaid; awaiting async payment result"
                );
                return Ok(());
            }

            let external_id = stripe_checkout_external_id(object);
            apply_subscription_update(
                state,
                &org_id,
                plan_id,
                ProcessorKind::Stripe,
                "active",
                external_id.as_deref(),
            )
            .await?;
            info!(
                event = %event.id,
                kind = %event.kind,
                org_id = %org_id,
                plan = %plan_id,
                "stripe checkout session applied"
            );

            // Best-effort: persist the customer id (for checkout reuse) and the
            // period details (for "renews on <date>" display). Never fails the
            // webhook — the entitlement is already granted above.
            let mut snapshot = SubscriptionSnapshot {
                customer: stripe_reference_field(object, "customer"),
                ..SubscriptionSnapshot::default()
            };
            if let Some(subscription_id) = external_id
                .as_deref()
                .filter(|value| value.starts_with("sub_"))
            {
                let context = processors::ProcessorContext {
                    config: &state.config,
                    http_client: &state.http_client,
                };
                match processors::stripe::fetch_subscription_snapshot(&context, subscription_id)
                    .await
                {
                    Ok(fetched) => {
                        snapshot.cancel_at_period_end = fetched.cancel_at_period_end;
                        snapshot.current_period_end = fetched.current_period_end;
                        if snapshot.customer.is_none() {
                            snapshot.customer = fetched.customer;
                        }
                    }
                    Err(fetch_error) => warn!(
                        event = %event.id,
                        org_id = %org_id,
                        subscription_id,
                        ?fetch_error,
                        "failed to fetch subscription snapshot after checkout"
                    ),
                }
            }
            persist_details_by_org(state, &org_id, &snapshot).await;
        }
        "checkout.session.async_payment_failed" => {
            let metadata = stripe_metadata(object);
            warn!(
                event = %event.id,
                session = stripe_string_field(object, "id").as_deref().unwrap_or("<unknown>"),
                org_id = metadata.get("orgId").map(String::as_str).unwrap_or("<unknown>"),
                "stripe checkout async payment failed; no entitlement was granted"
            );
        }
        "customer.subscription.deleted" => {
            let subscription_id = stripe_string_field(object, "id");
            if let Some(subscription_id) = subscription_id.as_deref() {
                let outcome = apply_subscription_status_update(
                    state,
                    ProcessorKind::Stripe,
                    subscription_id,
                    "canceled",
                )
                .await?;
                log_status_outcome(&outcome, event, subscription_id, "canceled");
            } else {
                warn!(
                    event = %event.id,
                    kind = %event.kind,
                    "stripe subscription deleted payload missing id"
                );
            }
        }
        "invoice.payment_failed" => {
            let subscription_id = invoice_subscription_reference(object);
            if let Some(subscription_id) = subscription_id.as_deref() {
                let outcome = apply_subscription_status_update(
                    state,
                    ProcessorKind::Stripe,
                    subscription_id,
                    "past_due",
                )
                .await?;
                log_status_outcome(&outcome, event, subscription_id, "past_due");
            } else {
                warn!(
                    event = %event.id,
                    kind = %event.kind,
                    "invoice.payment_failed without a resolvable subscription reference (checked top-level and parent.subscription_details)"
                );
            }
        }
        "invoice.payment_succeeded" => {
            let subscription_id = invoice_subscription_reference(object);
            if let Some(subscription_id) = subscription_id.as_deref() {
                let outcome = apply_subscription_status_update(
                    state,
                    ProcessorKind::Stripe,
                    subscription_id,
                    "active",
                )
                .await?;
                log_status_outcome(&outcome, event, subscription_id, "active");
            } else {
                warn!(
                    event = %event.id,
                    kind = %event.kind,
                    "invoice.payment_succeeded without a resolvable subscription reference (checked top-level and parent.subscription_details)"
                );
            }
        }
        "customer.subscription.updated" => {
            let subscription_id = stripe_string_field(object, "id");
            let status = stripe_string_field(object, "status");
            let mapped = match status.as_deref() {
                Some("active") => Some("active"),
                Some("trialing") => Some("trialing"),
                Some("past_due")
                | Some("unpaid")
                | Some("incomplete")
                | Some("incomplete_expired") => Some("past_due"),
                Some("canceled") => Some("canceled"),
                _ => None,
            };

            let Some(subscription_id) = subscription_id else {
                warn!(
                    event = %event.id,
                    kind = %event.kind,
                    "stripe subscription updated payload missing id"
                );
                return Ok(());
            };
            let Some(status) = mapped else {
                info!(
                    event = %event.id,
                    kind = %event.kind,
                    subscription_id,
                    "stripe subscription updated ignored (unsupported status)"
                );
                return Ok(());
            };

            let metadata = stripe_metadata(object);
            let org_id = metadata
                .get("orgId")
                .and_then(|value| Uuid::parse_str(value.trim()).ok());
            let price_id = stripe_subscription_price_id(object);
            let plan_id = stripe_plan_from_subscription(config, object);
            if plan_id.is_none() {
                if let Some(price_id) = price_id.as_deref() {
                    warn!(
                        event = %event.id,
                        subscription_id,
                        price_id,
                        "stripe subscription price is not in the configured price mapping; applying status-only update"
                    );
                }
            }

            if let Some(plan_id) = plan_id.as_deref() {
                // Always key the write by the event's subscription id — an
                // org-keyed write would let a late event for an OLD
                // subscription clobber the org's current one, and would
                // bypass the canceled-resurrection guard.
                let outcome = apply_subscription_plan_update_by_external_id(
                    state,
                    ProcessorKind::Stripe,
                    &subscription_id,
                    plan_id,
                    status,
                )
                .await?;
                match &outcome {
                    StatusUpdateOutcome::NotFound => {
                        // Unknown subscription id. The only legitimate case is
                        // a first activation racing the checkout webhook, and
                        // then the org's row is still the dev/starter default.
                        // If the org is already bound to a DIFFERENT Stripe
                        // subscription (live or canceled), refuse: this event
                        // is stale or belongs to an orphaned subscription.
                        let claimable = match org_id {
                            Some(org_id) => org_row_claimable_for(state, &org_id).await?,
                            None => false,
                        };
                        if let (Some(org_id), true) = (org_id, claimable) {
                            apply_subscription_plan_update(
                                state,
                                &org_id,
                                plan_id,
                                ProcessorKind::Stripe,
                                status,
                                &subscription_id,
                            )
                            .await?;
                            info!(
                                event = %event.id,
                                kind = %event.kind,
                                org_id = %org_id,
                                subscription_id,
                                status,
                                plan = plan_id,
                                "stripe subscription updated (first activation by org metadata)"
                            );
                        } else {
                            warn!(
                                event = %event.id,
                                kind = %event.kind,
                                subscription_id,
                                status,
                                plan = plan_id,
                                "stripe subscription update matched no local subscription and the org row is not claimable; refusing to clobber — reconcile manually if this subscription should be live"
                            );
                        }
                    }
                    outcome => log_status_outcome(outcome, event, &subscription_id, status),
                }
            } else {
                let outcome = apply_subscription_status_update(
                    state,
                    ProcessorKind::Stripe,
                    &subscription_id,
                    status,
                )
                .await?;
                log_status_outcome(&outcome, event, &subscription_id, status);
            }

            // Persist cancel-at-period-end + period end so the app can render
            // "renews/cancels on <date>" without asking Stripe.
            let snapshot = subscription_snapshot_from_object(object);
            persist_details_by_external_id(state, &subscription_id, &snapshot).await;
        }
        "charge.refunded" => {
            // No-refund policy: any refund was issued manually in the Stripe
            // dashboard. Surface it loudly; entitlements are handled manually.
            warn!(
                event = %event.id,
                charge = stripe_string_field(object, "id").as_deref().unwrap_or("<unknown>"),
                amount_refunded = object.get("amount_refunded").and_then(JsonValue::as_i64).unwrap_or(0),
                "stripe charge refunded — review subscription entitlements in the dashboard"
            );
        }
        "charge.dispute.created" => {
            let charge_id = stripe_reference_field(object, "charge");
            error!(
                event = %event.id,
                charge = charge_id.as_deref().unwrap_or("<unknown>"),
                amount = object.get("amount").and_then(JsonValue::as_i64).unwrap_or(0),
                reason = object.get("reason").and_then(JsonValue::as_str).unwrap_or("<unknown>"),
                "stripe chargeback opened"
            );
            if let Some(charge_id) = charge_id.as_deref() {
                let context = processors::ProcessorContext {
                    config: &state.config,
                    http_client: &state.http_client,
                };
                match processors::stripe::fetch_charge_subscription_id(&context, charge_id).await {
                    Ok(Some(subscription_id)) => {
                        // A chargeback ends the relationship under the
                        // no-refund policy: cancel the Stripe subscription so
                        // it stops billing (a later status event would
                        // otherwise restore paid credits), then mark it
                        // canceled locally, which reverts credits to Starter.
                        if let Err(cancel_error) =
                            processors::stripe::cancel_subscription(&context, &subscription_id)
                                .await
                        {
                            error!(
                                event = %event.id,
                                charge = charge_id,
                                subscription_id,
                                ?cancel_error,
                                "chargeback: failed to cancel subscription in Stripe; cancel it manually"
                            );
                        }
                        let outcome = apply_subscription_status_update(
                            state,
                            ProcessorKind::Stripe,
                            &subscription_id,
                            "canceled",
                        )
                        .await?;
                        log_status_outcome(&outcome, event, &subscription_id, "canceled");
                        error!(
                            event = %event.id,
                            charge = charge_id,
                            subscription_id,
                            "chargeback: subscription canceled and credits reverted to starter; review the dispute in the dashboard"
                        );
                    }
                    Ok(None) => error!(
                        event = %event.id,
                        charge = charge_id,
                        "chargeback charge has no invoice/subscription; manual review required"
                    ),
                    Err(fetch_error) => error!(
                        event = %event.id,
                        charge = charge_id,
                        ?fetch_error,
                        "failed to resolve chargeback subscription; manual review required"
                    ),
                }
            }
        }
        _ => {
            info!(event = %event.id, kind = %event.kind, "stripe webhook ignored");
        }
    }

    Ok(())
}

fn log_status_outcome(
    outcome: &StatusUpdateOutcome,
    event: &StripeWebhookEvent,
    subscription_id: &str,
    status: &str,
) {
    match outcome {
        StatusUpdateOutcome::Updated(update) => info!(
            event = %event.id,
            kind = %event.kind,
            subscription_id,
            status,
            previous_status = %update.previous_status,
            org_id = %update.org_id,
            "stripe subscription status applied"
        ),
        StatusUpdateOutcome::SkippedCanceled { org_id } => info!(
            event = %event.id,
            kind = %event.kind,
            subscription_id,
            status,
            org_id = %org_id,
            "stripe status event refused: subscription is canceled locally (stale or out-of-order delivery)"
        ),
        StatusUpdateOutcome::NotFound => warn!(
            event = %event.id,
            kind = %event.kind,
            subscription_id,
            status,
            "stripe event matched no local subscription; if this org checked out recently the checkout webhook may be missing — reconcile manually"
        ),
    }
}

async fn persist_details_by_org(state: &AppState, org_id: &Uuid, snapshot: &SubscriptionSnapshot) {
    let connection = match state.pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(org_id = %org_id, %error, "failed to get connection for subscription details");
            return;
        }
    };
    if let Err(error) = service::update_subscription_details_by_org(
        &*connection,
        org_id,
        snapshot.customer.as_deref(),
        snapshot.cancel_at_period_end,
        snapshot.current_period_end,
    )
    .await
    {
        warn!(org_id = %org_id, %error, "failed to persist subscription details");
    }
}

async fn persist_details_by_external_id(
    state: &AppState,
    subscription_id: &str,
    snapshot: &SubscriptionSnapshot,
) {
    let connection = match state.pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(subscription_id, %error, "failed to get connection for subscription details");
            return;
        }
    };
    if let Err(error) = service::update_subscription_details_by_external_id(
        &*connection,
        ProcessorKind::Stripe,
        subscription_id,
        snapshot.customer.as_deref(),
        snapshot.cancel_at_period_end,
        snapshot.current_period_end,
    )
    .await
    {
        warn!(subscription_id, %error, "failed to persist subscription details");
    }
}

async fn starter_credit_limit(
    client: &impl tokio_postgres::GenericClient,
) -> Result<i32, (StatusCode, Json<ApiError>)> {
    Ok(plans::load_plan(client, "starter")
        .await
        .map_err(internal_error)?
        .map(|plan| plan.credit_limit)
        .unwrap_or(200))
}

/// Which org credit limit a subscription status maps to. `None` means "leave
/// the limit unchanged" — used for past_due so a single failed renewal charge
/// does not strip paid credits while Stripe dunning is still retrying the card.
async fn credit_limit_for_status(
    client: &impl tokio_postgres::GenericClient,
    status: &str,
    paid_limit: i32,
) -> Result<Option<i32>, (StatusCode, Json<ApiError>)> {
    match status {
        "active" | "trialing" => Ok(Some(paid_limit)),
        "past_due" => Ok(None),
        // canceled / none / anything else: revert to the free Starter tier
        // instead of locking the org out at 0 credits.
        _ => Ok(Some(starter_credit_limit(client).await?)),
    }
}

async fn apply_subscription_update(
    state: &AppState,
    org_id: &Uuid,
    plan_id: &str,
    processor: ProcessorKind,
    status: &str,
    external_id: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to begin transaction: {error}")))?;

    let plan = plans::load_plan(&transaction, plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| bad_request("Stripe planId is not recognized"))?;

    service::upsert_org_subscription(
        &transaction,
        org_id,
        processor,
        &plan,
        Some(status),
        external_id,
    )
    .await
    .map_err(|error| {
        error!(
            org_id = %org_id,
            plan = %plan.id,
            processor = processor.as_str(),
            %error,
            "failed to upsert subscription via webhook"
        );
        internal_error(error)
    })?;
    if let Some(next_limit) =
        credit_limit_for_status(&transaction, status, plan.credit_limit).await?
    {
        service::sync_org_credit_limit(&transaction, org_id, next_limit)
            .await
            .map_err(|error| {
                error!(
                    org_id = %org_id,
                    plan = %plan.id,
                    processor = processor.as_str(),
                    %error,
                    "failed to sync credit limit via webhook"
                );
                internal_error(error)
            })?;
        // Checkout activations grant the new plan's budget immediately;
        // renewals keep flowing through the daily refill. This function is
        // only reached from checkout.session events, and replays are blocked
        // by webhook idempotency.
        if matches!(status, "active" | "trialing") {
            service::top_up_org_credit_balance(&transaction, org_id, next_limit)
                .await
                .map_err(internal_error)?;
        }
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit webhook transaction: {error}"))
    })?;

    Ok(())
}

async fn apply_subscription_status_update(
    state: &AppState,
    processor: ProcessorKind,
    external_id: &str,
    status: &str,
) -> Result<StatusUpdateOutcome, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to begin transaction: {error}")))?;

    let outcome = service::update_subscription_status_by_external_id(
        &transaction,
        processor,
        external_id,
        status,
    )
    .await
    .map_err(internal_error)?;

    if let StatusUpdateOutcome::Updated(update) = &outcome {
        if let Some(next_limit) =
            credit_limit_for_status(&transaction, status, update.credit_limit).await?
        {
            service::sync_org_credit_limit(&transaction, &update.org_id, next_limit)
                .await
                .map_err(internal_error)?;
        }
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit webhook transaction: {error}"))
    })?;

    Ok(outcome)
}

async fn apply_subscription_plan_update(
    state: &AppState,
    org_id: &Uuid,
    plan_id: &str,
    processor: ProcessorKind,
    status: &str,
    external_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to begin transaction: {error}")))?;

    let plan = plans::load_plan(&transaction, plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| bad_request("Stripe planId is not recognized"))?;

    service::upsert_org_subscription(
        &transaction,
        org_id,
        processor,
        &plan,
        Some(status),
        Some(external_id),
    )
    .await
    .map_err(|error| internal_error(error))?;

    if let Some(next_limit) =
        credit_limit_for_status(&transaction, status, plan.credit_limit).await?
    {
        service::sync_org_credit_limit(&transaction, org_id, next_limit)
            .await
            .map_err(|error| internal_error(error))?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit webhook transaction: {error}"))
    })?;

    Ok(())
}

async fn apply_subscription_plan_update_by_external_id(
    state: &AppState,
    processor: ProcessorKind,
    external_id: &str,
    plan_id: &str,
    status: &str,
) -> Result<StatusUpdateOutcome, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to begin transaction: {error}")))?;

    let plan = plans::load_plan(&transaction, plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| bad_request("Stripe planId is not recognized"))?;

    let outcome = service::apply_plan_update_by_external_id(
        &transaction,
        processor,
        external_id,
        &plan,
        status,
    )
    .await
    .map_err(internal_error)?;

    if let StatusUpdateOutcome::Updated(update) = &outcome {
        if let Some(next_limit) =
            credit_limit_for_status(&transaction, status, plan.credit_limit).await?
        {
            service::sync_org_credit_limit(&transaction, &update.org_id, next_limit)
                .await
                .map_err(|error| internal_error(error))?;
        }
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit webhook transaction: {error}"))
    })?;

    Ok(outcome)
}

/// Whether the org's subscription row may be claimed by a subscription event
/// that matched no local row. Only the dev/starter default row is claimable
/// (first paid activation racing the checkout webhook); a row already bound
/// to another Stripe subscription must not be clobbered by a stray event.
async fn org_row_claimable_for(
    state: &AppState,
    org_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let billing_ref = service::load_org_billing_ref(&*connection, org_id)
        .await
        .map_err(internal_error)?;
    Ok(match billing_ref {
        None => true,
        Some(existing) => existing.processor != "stripe",
    })
}

fn parse_uuid(value: Option<&str>, label: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let raw = value.ok_or_else(|| bad_request(&format!("{label} missing")))?;
    Uuid::parse_str(raw.trim()).map_err(|_| bad_request(&format!("{label} must be a valid UUID")))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn verify_stripe_signature(
    secret: &str,
    payload: &[u8],
    header: &str,
    tolerance_seconds: i64,
) -> bool {
    verify_stripe_signature_at(secret, payload, header, tolerance_seconds, unix_now())
}

fn verify_stripe_signature_at(
    secret: &str,
    payload: &[u8],
    header: &str,
    tolerance_seconds: i64,
    now: i64,
) -> bool {
    let mut timestamp: Option<&str> = None;
    let mut signatures: Vec<&str> = Vec::new();
    for part in header.split(',') {
        let mut pieces = part.splitn(2, '=');
        let key = pieces.next().unwrap_or("").trim();
        let value = pieces.next().unwrap_or("").trim();
        match key {
            "t" => timestamp = Some(value),
            "v1" => signatures.push(value),
            _ => {}
        }
    }

    let Some(ts) = timestamp else {
        return false;
    };
    if signatures.is_empty() {
        return false;
    }

    // Reject stale timestamps so a captured delivery cannot be replayed
    // indefinitely (the signature itself never expires).
    if tolerance_seconds > 0 {
        let Ok(ts_value) = ts.parse::<i64>() else {
            return false;
        };
        if (now - ts_value).abs() > tolerance_seconds {
            return false;
        }
    }

    let mut data = Vec::with_capacity(ts.len() + 1 + payload.len());
    data.extend_from_slice(ts.as_bytes());
    data.push(b'.');
    data.extend_from_slice(payload);

    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(&data);
    let expected = mac.finalize().into_bytes();

    for signature in signatures {
        if let Ok(decoded) = hex::decode(signature) {
            if decoded.as_slice().ct_eq(expected.as_ref()).into() {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Deserialize)]
struct StripeWebhookEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: StripeEventData,
}

#[derive(Debug, Deserialize)]
struct StripeEventData {
    pub object: JsonValue,
}

fn stripe_object_field<'a>(object: &'a JsonValue, field: &str) -> Option<&'a JsonValue> {
    object.get(field)
}

fn stripe_string_field(object: &JsonValue, field: &str) -> Option<String> {
    stripe_object_field(object, field)
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Stripe references are delivered either as a bare id string or as an
/// expanded object with an `id` field; accept both.
fn stripe_reference_field(object: &JsonValue, field: &str) -> Option<String> {
    match stripe_object_field(object, field)? {
        JsonValue::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Object(map) => map
            .get("id")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        _ => None,
    }
}

fn stripe_metadata(object: &JsonValue) -> HashMap<String, String> {
    let mut metadata = HashMap::new();
    let Some(map) = object.get("metadata").and_then(JsonValue::as_object) else {
        return metadata;
    };
    for (key, value) in map {
        if let Some(text) = value.as_str() {
            metadata.insert(key.clone(), text.to_string());
        } else if value.is_number() || value.is_boolean() {
            metadata.insert(key.clone(), value.to_string());
        }
    }
    metadata
}

fn stripe_checkout_external_id(object: &JsonValue) -> Option<String> {
    stripe_reference_field(object, "subscription").or_else(|| stripe_string_field(object, "id"))
}

fn stripe_subscription_price_id(object: &JsonValue) -> Option<String> {
    let items = stripe_object_field(object, "items")?;
    let data = stripe_object_field(items, "data")?.as_array()?;
    let first = data.first()?;
    let price = stripe_object_field(first, "price")?;
    match price {
        JsonValue::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Object(map) => map
            .get("id")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        _ => None,
    }
}

fn stripe_plan_from_subscription(
    config: &crate::config::StripeConfig,
    object: &JsonValue,
) -> Option<String> {
    let price_id = stripe_subscription_price_id(object)?;
    let price_id = price_id.trim();
    if price_id.is_empty() {
        return None;
    }

    let plan_key = config.price_lookup.iter().find_map(|(key, value)| {
        if value.trim() == price_id {
            Some(key.as_str())
        } else {
            None
        }
    })?;

    Some(plan_key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signed_header(secret: &str, payload: &[u8], timestamp: i64) -> String {
        let payload_str = std::str::from_utf8(payload).unwrap();
        let signed_payload = format!("{timestamp}.{payload_str}");
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(signed_payload.as_bytes());
        let digest = mac.finalize().into_bytes();
        format!("t={timestamp},v1={}", hex::encode(digest))
    }

    #[test]
    fn stripe_signature_passes_with_valid_payload() {
        let payload = br#"{\"id\":\"evt_test\"}"#;
        let secret = "whsec_test";
        let now = 1_700_000_000;
        let header = signed_header(secret, payload, now);
        assert!(verify_stripe_signature_at(
            secret, payload, &header, 300, now
        ));
    }

    #[test]
    fn stripe_signature_rejects_invalid_payload() {
        let payload = br#"{}"#;
        let header = "t=1,v1=deadbeef";
        assert!(!verify_stripe_signature_at(
            "secret", payload, header, 300, 1
        ));
    }

    #[test]
    fn stripe_signature_rejects_stale_timestamp() {
        let payload = br#"{\"id\":\"evt_test\"}"#;
        let secret = "whsec_test";
        let signed_at = 1_700_000_000;
        let header = signed_header(secret, payload, signed_at);
        // Valid signature, but delivered 10 minutes later: replay refused.
        assert!(!verify_stripe_signature_at(
            secret,
            payload,
            &header,
            300,
            signed_at + 600
        ));
        // Within tolerance it still verifies.
        assert!(verify_stripe_signature_at(
            secret,
            payload,
            &header,
            300,
            signed_at + 120
        ));
    }

    #[test]
    fn invoice_subscription_resolves_pre_and_post_basil_shapes() {
        let pre_basil = json!({ "subscription": "sub_123" });
        assert_eq!(
            invoice_subscription_reference(&pre_basil).as_deref(),
            Some("sub_123")
        );

        let post_basil = json!({
            "parent": { "subscription_details": { "subscription": "sub_456" } }
        });
        assert_eq!(
            invoice_subscription_reference(&post_basil).as_deref(),
            Some("sub_456")
        );

        let expanded = json!({ "subscription": { "id": "sub_789" } });
        assert_eq!(
            invoice_subscription_reference(&expanded).as_deref(),
            Some("sub_789")
        );

        let none = json!({ "id": "in_123" });
        assert_eq!(invoice_subscription_reference(&none), None);
    }

    #[test]
    fn subscription_snapshot_reads_item_level_period_end() {
        let post_basil = json!({
            "customer": "cus_1",
            "cancel_at_period_end": true,
            "items": { "data": [ { "current_period_end": 1_800_000_000i64 } ] }
        });
        let snapshot = subscription_snapshot_from_object(&post_basil);
        assert_eq!(snapshot.customer.as_deref(), Some("cus_1"));
        assert_eq!(snapshot.cancel_at_period_end, Some(true));
        assert_eq!(snapshot.current_period_end, Some(1_800_000_000));

        let pre_basil = json!({
            "customer": { "id": "cus_2" },
            "cancel_at_period_end": false,
            "current_period_end": 1_750_000_000i64
        });
        let snapshot = subscription_snapshot_from_object(&pre_basil);
        assert_eq!(snapshot.customer.as_deref(), Some("cus_2"));
        assert_eq!(snapshot.cancel_at_period_end, Some(false));
        assert_eq!(snapshot.current_period_end, Some(1_750_000_000));
    }
}
