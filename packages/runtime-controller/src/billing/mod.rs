use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::projects::ensure_project_org;
use crate::projects::{ensure_project_access, load_project_record, parse_optional_uuid_param};
use crate::{bad_request, forbidden, internal_error, unauthorized, ApiError, AppState};
use tracing::{error, field, info, instrument};

pub(crate) mod plans;
pub(crate) mod processors;
pub(crate) mod service;
mod webhooks;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/billing/checkout", post(post_checkout))
        .merge(webhooks::router())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutRequest {
    project_id: String,
    action: CheckoutAction,
    plan_id: Option<String>,
    processor: Option<String>,
    success_url: Option<String>,
    cancel_url: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CheckoutAction {
    Checkout,
    Portal,
    /// In-place plan switch on the existing Stripe subscription. Never creates
    /// a new subscription (that is what checkout does, and doing it with a
    /// live subscription would double-bill).
    ChangePlan,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutResponse {
    processor: String,
    checkout_url: String,
    reference: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalResponse {
    url: String,
}

#[instrument(
    skip_all,
    fields(project_id = field::Empty, plan_id = field::Empty, processor = field::Empty)
)]
async fn post_checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CheckoutRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::parse_str(payload.project_id.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    tracing::Span::current().record("project_id", &field::display(project_id));
    let session_id = parse_optional_uuid_param(payload.session_id.clone(), "sessionId")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, session_id).await?;
    let project = ensure_project_org(&transaction, &project).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;
    require_org_billing_manager(&transaction, &org_id, &context).await?;

    match payload.action {
        CheckoutAction::Portal => {
            let return_url = payload
                .success_url
                .as_deref()
                .ok_or_else(|| bad_request("successUrl is required for portal"))?;

            let subscription_row = transaction
                .query_opt(
                    "select processor, external_id, status from org_subscriptions where org_id = $1 order by updated_at desc limit 1",
                    &[&org_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load org subscription: {error}")))?;

            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize portal request: {error}"))
            })?;

            let Some(row) = subscription_row else {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ApiError::new("No subscription found for organization")),
                ));
            };

            let processor_raw: String = row.get("processor");
            let external_id: String = row.get("external_id");
            let status: String = row.get("status");
            // Canceled subscriptions keep portal access on purpose: customers
            // must still be able to download past invoices/receipts.
            if status.as_str() == "none" {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ApiError::new("Subscription is not active")),
                ));
            }

            let processor_kind = processors::parse_processor(&processor_raw).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError::new("Subscription processor is not supported")),
                )
            })?;

            let processor_context = processors::ProcessorContext {
                config: &state.config,
                http_client: &state.http_client,
            };
            let portal_url = processors::create_portal_session(
                processor_context,
                processor_kind,
                &external_id,
                return_url,
            )
            .await
            .map_err(|error| error.into_response())?;

            return Ok(Json(json!(PortalResponse { url: portal_url })));
        }
        CheckoutAction::ChangePlan => {
            let plan_id = payload
                .plan_id
                .as_deref()
                .ok_or_else(|| bad_request("planId is required for a plan change"))?;
            let plan = plans::load_active_plan(&transaction, plan_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| bad_request(&format!("Unknown plan id: {plan_id}")))?;
            tracing::Span::current().record("plan_id", &field::display(&plan.id));

            if plan.monthly_price_cents <= 0 {
                return Err(bad_request(
                    "Use the billing portal to cancel your subscription and move to the free plan.",
                ));
            }

            let billing_ref = service::load_org_billing_ref(&transaction, &org_id)
                .await
                .map_err(internal_error)?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize plan change check: {error}"))
            })?;

            let Some(existing) = billing_ref.filter(|existing| existing.processor == "stripe")
            else {
                return Err(bad_request(
                    "No Stripe subscription found for this organization; start a checkout instead.",
                ));
            };
            match existing.status.as_str() {
                "active" | "trialing" => {}
                "past_due" => {
                    return Err(bad_request(
                        "Your last payment failed. Update your payment method in the billing portal before changing plans.",
                    ));
                }
                _ => {
                    return Err(bad_request(
                        "No active subscription to change; start a checkout instead.",
                    ));
                }
            }
            if existing.billing_cycle.as_deref() == Some(plan.id.as_str()) {
                return Err(bad_request("This organization is already on that plan."));
            }
            if !existing.external_id.starts_with("sub_") {
                return Err(bad_request(
                    "This subscription cannot be changed automatically; use the billing portal.",
                ));
            }

            let stripe_config = state
                .config
                .stripe
                .as_ref()
                .ok_or_else(|| internal_error("Stripe processor is not configured"))?;
            let price_id = stripe_config
                .price_lookup
                .get(&plan.id.to_ascii_lowercase())
                .ok_or_else(|| internal_error("Stripe price ID missing for requested plan"))?
                .clone();

            let processor_context = processors::ProcessorContext {
                config: &state.config,
                http_client: &state.http_client,
            };
            processors::stripe::change_subscription_price(
                &processor_context,
                &existing.external_id,
                &price_id,
                &plan.id,
            )
            .await
            .map_err(|error| {
                error!(
                    org_id = %org_id,
                    project_id = %project.id,
                    plan = %plan.id,
                    subscription_id = %existing.external_id,
                    message = ?error,
                    "plan change processor error"
                );
                error.into_response()
            })?;

            info!(
                org_id = %org_id,
                project_id = %project.id,
                plan = %plan.id,
                subscription_id = %existing.external_id,
                "stripe subscription plan change requested; entitlements follow via webhook"
            );
            // Entitlements flip when customer.subscription.updated arrives.
            return Ok(Json(json!({ "status": "pending", "planId": plan.id })));
        }
        CheckoutAction::Checkout => {}
    }

    let plan_id = payload
        .plan_id
        .as_deref()
        .ok_or_else(|| bad_request("planId is required for checkout"))?;
    let plan = plans::load_active_plan(&transaction, plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| bad_request(&format!("Unknown plan id: {plan_id}")))?;
    tracing::Span::current().record("plan_id", &field::display(&plan.id));

    let processor_value = payload
        .processor
        .as_deref()
        .ok_or_else(|| bad_request("processor is required for checkout"))?;
    let processor_kind = processors::parse_processor(processor_value)
        .ok_or_else(|| bad_request("Unsupported processor"))?;
    tracing::Span::current().record("processor", &field::display(processor_kind.as_str()));

    let success_url = payload
        .success_url
        .as_deref()
        .ok_or_else(|| bad_request("successUrl is required for checkout"))?;
    let cancel_url = payload.cancel_url.as_deref().unwrap_or(success_url);

    // Plan changes for an org that already pays through Stripe must go through
    // the billing portal (subscription update). A second checkout would create
    // a second live Stripe subscription and double-bill the customer.
    let billing_ref = service::load_org_billing_ref(&transaction, &org_id)
        .await
        .map_err(internal_error)?;
    if let Some(existing) = billing_ref
        .as_ref()
        .filter(|existing| existing.processor == "stripe")
    {
        if matches!(existing.status.as_str(), "active" | "trialing" | "past_due") {
            info!(
                org_id = %org_id,
                project_id = %project.id,
                plan = %plan.id,
                existing_status = %existing.status,
                existing_plan = existing.billing_cycle.as_deref().unwrap_or("<unknown>"),
                "checkout rejected: org already has a live Stripe subscription"
            );
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "This organization already has an active subscription. Use Manage subscription to change plans.",
                )),
            ));
        }
    }
    let existing_customer_id = billing_ref
        .as_ref()
        .and_then(|existing| existing.external_customer_id.clone());

    let processor_context = processors::ProcessorContext {
        config: &state.config,
        http_client: &state.http_client,
    };

    let checkout_session = processors::create_checkout_session(
        processor_context,
        processor_kind,
        processors::CheckoutInput {
            plan: &plan,
            org_id: &org_id,
            project_id: &project.id,
            success_url,
            cancel_url,
            customer_id: existing_customer_id.as_deref(),
        },
    )
    .await
    .map_err(|error| {
        error!(
            org_id = %org_id,
            project_id = %project.id,
            plan = %plan.id,
            processor = processor_kind.as_str(),
            message = ?error,
            "checkout processor error"
        );
        error.into_response()
    })?;

    // Free plans and the dev processor take effect immediately. Paid Stripe
    // checkouts must NOT touch the org's subscription row here: the session is
    // unpaid until the checkout.session.completed webhook arrives, and an
    // abandoned checkout would otherwise corrupt a live subscription (status
    // 'none' blocks the billing portal and the cs_… reference orphans the
    // real sub_… id).
    let applies_immediately =
        plan.monthly_price_cents <= 0 || matches!(processor_kind, processors::ProcessorKind::Dev);

    if applies_immediately {
        service::upsert_org_subscription(
            &transaction,
            &org_id,
            processor_kind,
            &plan,
            None,
            checkout_session.reference.as_deref(),
        )
        .await
        .map_err(|error| {
            error!(
                org_id = %org_id,
                project_id = %project.id,
                plan = %plan.id,
                processor = processor_kind.as_str(),
                %error,
                "failed to upsert org subscription"
            );
            internal_error(error)
        })?;
        service::sync_org_credit_limit(&transaction, &org_id, plan.credit_limit)
            .await
            .map_err(|error| {
                error!(
                    org_id = %org_id,
                    project_id = %project.id,
                    plan = %plan.id,
                    processor = processor_kind.as_str(),
                    %error,
                    "failed to sync credit limit"
                );
                internal_error(error)
            })?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize checkout: {error}")))?;

    let processor_label = checkout_session.processor.as_str();

    info!(
        org_id = %org_id,
        project_id = %project.id,
        plan = %plan.id,
        plan_name = %plan.name,
        processor = processor_label,
        checkout_url = checkout_session.checkout_url,
        reference = checkout_session.reference,
        "org subscription updated via checkout",
    );

    Ok(Json(json!(CheckoutResponse {
        processor: processor_label.to_string(),
        checkout_url: checkout_session.checkout_url,
        reference: checkout_session.reference,
        expires_at: checkout_session.expires_at,
    })))
}

async fn require_org_billing_manager(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot manage organization billing",
        ));
    }
    if context.is_service_role {
        return Ok(());
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to manage organization billing"))?;
    let row = transaction
        .query_opt(
            "select role from org_memberships where org_id = $1 and user_id = $2 limit 1",
            &[org_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to verify organization billing access: {error}"
            ))
        })?;
    let role = row.map(|row| row.get::<_, String>("role"));
    if role.as_deref().is_some_and(role_can_manage_billing) {
        return Ok(());
    }

    Err(forbidden(
        "You need to be an organization owner or admin to manage billing",
    ))
}

fn role_can_manage_billing(role: &str) -> bool {
    matches!(role, "owner" | "admin")
}

#[cfg(test)]
mod billing_permission_tests {
    use super::role_can_manage_billing;

    #[test]
    fn only_organization_owners_and_admins_can_manage_billing() {
        assert!(role_can_manage_billing("owner"));
        assert!(role_can_manage_billing("admin"));
        assert!(!role_can_manage_billing("builder"));
        assert!(!role_can_manage_billing("viewer"));
    }
}
