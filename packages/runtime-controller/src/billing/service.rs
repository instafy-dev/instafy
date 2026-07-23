use tokio_postgres::error::SqlState;
use tokio_postgres::GenericClient;
use uuid::Uuid;

use super::plans;
use super::plans::BillingPlan;
use super::processors::ProcessorKind;

pub(crate) async fn ensure_default_org_subscription(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<(), String> {
    let savepoint_created = client
        .execute("savepoint ensure_default_org_subscription", &[])
        .await
        .is_ok();

    let existing = match client
        .query_opt(
            "select 1 from org_subscriptions where org_id = $1 order by updated_at desc limit 1",
            &[org_id],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            if savepoint_created {
                let _ = client
                    .execute("rollback to savepoint ensure_default_org_subscription", &[])
                    .await;
                let _ = client
                    .execute("release savepoint ensure_default_org_subscription", &[])
                    .await;
            }

            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(());
            }
            return Err(format!("failed to load subscription: {error}"));
        }
    };
    if existing.is_some() {
        if savepoint_created {
            let _ = client
                .execute("release savepoint ensure_default_org_subscription", &[])
                .await;
        }
        return Ok(());
    }

    let result = async {
        let starter_plan = plans::load_plan(client, "starter")
            .await?
            .ok_or_else(|| "starter billing plan is not configured".to_string())?;

        upsert_org_subscription(
            client,
            org_id,
            ProcessorKind::Dev,
            &starter_plan,
            None,
            None,
        )
        .await?;
        sync_org_credit_limit(client, org_id, starter_plan.credit_limit).await?;
        Ok(())
    }
    .await;

    if savepoint_created {
        match &result {
            Ok(()) => {
                let _ = client
                    .execute("release savepoint ensure_default_org_subscription", &[])
                    .await;
            }
            Err(_) => {
                let _ = client
                    .execute("rollback to savepoint ensure_default_org_subscription", &[])
                    .await;
                let _ = client
                    .execute("release savepoint ensure_default_org_subscription", &[])
                    .await;
            }
        }
    }

    result
}

pub(crate) async fn upsert_org_subscription(
    client: &impl GenericClient,
    org_id: &Uuid,
    processor: ProcessorKind,
    plan: &BillingPlan,
    status_override: Option<&str>,
    external_id_override: Option<&str>,
) -> Result<(), String> {
    let row = match client
        .query_opt(
            "select id from org_subscriptions where org_id = $1 order by updated_at desc limit 1",
            &[org_id],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(());
            }
            return Err(format!("failed to load subscription: {error}"));
        }
    };

    let status = normalize_subscription_status(status_override, plan)?;

    let processor_value = match processor {
        ProcessorKind::Dev => "dev",
        ProcessorKind::Stripe => "stripe",
    };

    let external_id_override = external_id_override
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(existing) = row.as_ref() {
        let subscription_id: Uuid = existing.get("id");
        let external_id_update = external_id_override.map(|value| value.to_string());
        let result = client
            .execute(
                "update org_subscriptions
                 set processor = $1,
                     status = $2,
                     credit_limit = $3,
                     currency = $4,
                     billing_cycle = $5,
                     external_id = coalesce($6, external_id),
                     updated_at = now()
                 where id = $7",
                &[
                    &processor_value,
                    &status,
                    &plan.credit_limit,
                    &plan.currency,
                    &plan.id,
                    &external_id_update,
                    &subscription_id,
                ],
            )
            .await;
        match result {
            Ok(_) => {}
            Err(error) => {
                let code = error.as_db_error().map(|db_error| db_error.code());
                if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                    return Ok(());
                }
                return Err(format!("failed to update subscription: {error}"));
            }
        }
    } else {
        let external_id = external_id_override
            .map(|value| value.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let subscription_id = uuid::Uuid::new_v4();
        let result = client
            .execute(
                "insert into org_subscriptions (id, org_id, processor, external_id, status, currency, credit_limit, billing_cycle) values ($1, $2, $3, $4, $5, $6, $7, $8)",
                &[
                    &subscription_id,
                    org_id,
                    &processor_value,
                    &external_id,
                    &status,
                    &plan.currency,
                    &plan.credit_limit,
                    &plan.id,
                ],
            )
            .await;
        match result {
            Ok(_) => {}
            Err(error) => {
                let code = error.as_db_error().map(|db_error| db_error.code());
                if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                    return Ok(());
                }
                return Err(format!("failed to create subscription: {error}"));
            }
        }
    }

    Ok(())
}

fn normalize_subscription_status(
    override_value: Option<&str>,
    plan: &BillingPlan,
) -> Result<&'static str, String> {
    let desired = override_value
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let fallback = if plan.monthly_price_cents > 0 {
        "trialing"
    } else {
        "active"
    };

    parse_subscription_status(desired.unwrap_or(fallback))
}

fn parse_subscription_status(value: &str) -> Result<&'static str, String> {
    match value {
        "trialing" => Ok("trialing"),
        "active" => Ok("active"),
        "past_due" => Ok("past_due"),
        "canceled" => Ok("canceled"),
        "none" => Ok("none"),
        other => Err(format!("unsupported subscription status: {other}")),
    }
}

pub(crate) struct OrgSubscriptionStatusUpdate {
    pub(crate) org_id: Uuid,
    pub(crate) credit_limit: i32,
    pub(crate) previous_status: String,
}

pub(crate) enum StatusUpdateOutcome {
    Updated(OrgSubscriptionStatusUpdate),
    /// The subscription is already canceled locally; a (re)activation was
    /// refused so a late or replayed webhook cannot resurrect it.
    SkippedCanceled {
        org_id: Uuid,
    },
    NotFound,
}

pub(crate) async fn update_subscription_status_by_external_id(
    client: &impl GenericClient,
    processor: ProcessorKind,
    external_id: &str,
    status: &str,
) -> Result<StatusUpdateOutcome, String> {
    let normalized_external = external_id.trim();
    if normalized_external.is_empty() {
        return Ok(StatusUpdateOutcome::NotFound);
    }
    let status_value = parse_subscription_status(status.trim())?;

    let processor_value = match processor {
        ProcessorKind::Dev => "dev",
        ProcessorKind::Stripe => "stripe",
    };

    // FOR UPDATE: concurrent deliveries for the same subscription (Stripe
    // emits deleted + updated near-simultaneously on cancel) serialize on the
    // row so the canceled guard below cannot be raced.
    let row = client
        .query_opt(
            "select id, org_id, credit_limit, status from org_subscriptions where processor = $1 and external_id = $2 order by updated_at desc limit 1 for update",
            &[&processor_value, &normalized_external],
        )
        .await
        .map_err(|error| format!("failed to load subscription: {error}"))?;

    let Some(row) = row else {
        return Ok(StatusUpdateOutcome::NotFound);
    };

    let subscription_id: Uuid = row.get("id");
    let org_id: Uuid = row.get("org_id");
    let credit_limit: i32 = row.get("credit_limit");
    let previous_status: String = row.get("status");

    // Stripe does not guarantee delivery order and retries for days. Once a
    // subscription is canceled locally, no stale event may move it anywhere
    // else — only an explicit new checkout brings an org back.
    if previous_status == "canceled" && status_value != "canceled" {
        return Ok(StatusUpdateOutcome::SkippedCanceled { org_id });
    }

    client
        .execute(
            "update org_subscriptions set status = $1, updated_at = now() where id = $2",
            &[&status_value, &subscription_id],
        )
        .await
        .map_err(|error| format!("failed to update subscription: {error}"))?;

    Ok(StatusUpdateOutcome::Updated(OrgSubscriptionStatusUpdate {
        org_id,
        credit_limit,
        previous_status,
    }))
}

/// Applies a plan + status to the subscription row matching `external_id`.
/// Subscription-scoped webhook events must write through this (never keyed by
/// org): a late event for an old subscription must not clobber the org's
/// current one, and a canceled subscription must stay canceled.
pub(crate) async fn apply_plan_update_by_external_id(
    client: &impl GenericClient,
    processor: ProcessorKind,
    external_id: &str,
    plan: &BillingPlan,
    status: &str,
) -> Result<StatusUpdateOutcome, String> {
    let normalized_external = external_id.trim();
    if normalized_external.is_empty() {
        return Ok(StatusUpdateOutcome::NotFound);
    }
    let status_value = parse_subscription_status(status.trim())?;
    let processor_value = match processor {
        ProcessorKind::Dev => "dev",
        ProcessorKind::Stripe => "stripe",
    };

    let row = client
        .query_opt(
            "select id, org_id, credit_limit, status from org_subscriptions where processor = $1 and external_id = $2 order by updated_at desc limit 1 for update",
            &[&processor_value, &normalized_external],
        )
        .await
        .map_err(|error| format!("failed to load subscription: {error}"))?;

    let Some(row) = row else {
        return Ok(StatusUpdateOutcome::NotFound);
    };

    let subscription_id: Uuid = row.get("id");
    let org_id: Uuid = row.get("org_id");
    let previous_status: String = row.get("status");

    if previous_status == "canceled" && status_value != "canceled" {
        return Ok(StatusUpdateOutcome::SkippedCanceled { org_id });
    }

    client
        .execute(
            "update org_subscriptions
             set status = $1,
                 credit_limit = $2,
                 currency = $3,
                 billing_cycle = $4,
                 updated_at = now()
             where id = $5",
            &[
                &status_value,
                &plan.credit_limit,
                &plan.currency,
                &plan.id,
                &subscription_id,
            ],
        )
        .await
        .map_err(|error| format!("failed to update subscription: {error}"))?;

    Ok(StatusUpdateOutcome::Updated(OrgSubscriptionStatusUpdate {
        org_id,
        credit_limit: plan.credit_limit,
        previous_status,
    }))
}

/// Best-effort persistence of Stripe-side subscription details (customer id,
/// cancel-at-period-end flag, current period end). Missing columns (schema
/// lag) and missing tables are tolerated, mirroring the rest of this module.
pub(crate) async fn update_subscription_details_by_org(
    client: &impl GenericClient,
    org_id: &Uuid,
    external_customer_id: Option<&str>,
    cancel_at_period_end: Option<bool>,
    current_period_end_epoch: Option<i64>,
) -> Result<(), String> {
    let customer = external_customer_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if customer.is_none() && cancel_at_period_end.is_none() && current_period_end_epoch.is_none() {
        return Ok(());
    }
    let result = client
        .execute(
            "update org_subscriptions
             set external_customer_id = coalesce($2, external_customer_id),
                 cancel_at_period_end = coalesce($3, cancel_at_period_end),
                 current_period_end = coalesce(to_timestamp(($4::bigint)::double precision), current_period_end)
             where id = (
                 select id from org_subscriptions where org_id = $1
                 order by updated_at desc limit 1
             )",
            &[org_id, &customer, &cancel_at_period_end, &current_period_end_epoch],
        )
        .await;
    tolerate_missing_schema(result).map(|_| ())
}

pub(crate) async fn update_subscription_details_by_external_id(
    client: &impl GenericClient,
    processor: ProcessorKind,
    external_id: &str,
    external_customer_id: Option<&str>,
    cancel_at_period_end: Option<bool>,
    current_period_end_epoch: Option<i64>,
) -> Result<(), String> {
    let normalized_external = external_id.trim();
    if normalized_external.is_empty() {
        return Ok(());
    }
    let customer = external_customer_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if customer.is_none() && cancel_at_period_end.is_none() && current_period_end_epoch.is_none() {
        return Ok(());
    }
    let processor_value = match processor {
        ProcessorKind::Dev => "dev",
        ProcessorKind::Stripe => "stripe",
    };
    let result = client
        .execute(
            "update org_subscriptions
             set external_customer_id = coalesce($3, external_customer_id),
                 cancel_at_period_end = coalesce($4, cancel_at_period_end),
                 current_period_end = coalesce(to_timestamp(($5::bigint)::double precision), current_period_end)
             where id = (
                 select id from org_subscriptions
                 where processor = $1 and external_id = $2
                 order by updated_at desc limit 1
             )",
            &[
                &processor_value,
                &normalized_external,
                &customer,
                &cancel_at_period_end,
                &current_period_end_epoch,
            ],
        )
        .await;
    tolerate_missing_schema(result).map(|_| ())
}

/// Returns true when this event id was seen before. Missing table (schema
/// lag) degrades to "not seen" so webhooks keep working without idempotency.
pub(crate) async fn webhook_event_seen(
    client: &impl GenericClient,
    event_id: &str,
) -> Result<bool, String> {
    let event_id = event_id.trim();
    if event_id.is_empty() {
        return Ok(false);
    }
    let result = client
        .query_opt(
            "select 1 from billing_webhook_events where event_id = $1",
            &[&event_id],
        )
        .await;
    match result {
        Ok(row) => Ok(row.is_some()),
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(false);
            }
            Err(format!("failed to check webhook event: {error}"))
        }
    }
}

/// Records a processed event id AFTER successful handling, so failed handlers
/// are retried by Stripe rather than skipped as already-processed.
pub(crate) async fn record_webhook_event(
    client: &impl GenericClient,
    event_id: &str,
    kind: &str,
) -> Result<(), String> {
    let event_id = event_id.trim();
    if event_id.is_empty() {
        return Ok(());
    }
    let result = client
        .execute(
            "insert into billing_webhook_events (event_id, processor, kind)
             values ($1, 'stripe', $2)
             on conflict (event_id) do nothing",
            &[&event_id, &kind],
        )
        .await;
    tolerate_missing_schema(result).map(|_| ())
}

pub(crate) struct OrgBillingRef {
    pub(crate) processor: String,
    pub(crate) status: String,
    pub(crate) external_id: String,
    pub(crate) external_customer_id: Option<String>,
    pub(crate) billing_cycle: Option<String>,
}

pub(crate) async fn load_org_billing_ref(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<Option<OrgBillingRef>, String> {
    // external_customer_id is read out of to_jsonb(row) so this single query
    // works whether or not the column migration has landed. A failed query
    // would abort the caller's transaction, so schema-lag must not error here.
    let result = client
        .query_opt(
            "select processor, status, external_id, billing_cycle,
                    to_jsonb(org_subscriptions) ->> 'external_customer_id' as external_customer_id
             from org_subscriptions where org_id = $1
             order by updated_at desc limit 1",
            &[org_id],
        )
        .await;
    let row = match result {
        Ok(row) => row,
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(None);
            }
            return Err(format!("failed to load subscription: {error}"));
        }
    };
    Ok(row.map(|row| OrgBillingRef {
        processor: row.get("processor"),
        status: row.get("status"),
        external_id: row.get("external_id"),
        external_customer_id: row.get("external_customer_id"),
        billing_cycle: row.get("billing_cycle"),
    }))
}

fn tolerate_missing_schema(result: Result<u64, tokio_postgres::Error>) -> Result<u64, String> {
    match result {
        Ok(count) => Ok(count),
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(
                code,
                Some(&SqlState::UNDEFINED_TABLE) | Some(&SqlState::UNDEFINED_COLUMN)
            ) {
                return Ok(0);
            }
            Err(format!("failed to update billing record: {error}"))
        }
    }
}

/// Paid activation: grant the full daily budget immediately. Without this a
/// customer who upgrades mid-day keeps their old (possibly empty) balance
/// until the midnight refill — paying money and receiving nothing usable.
pub(crate) async fn top_up_org_credit_balance(
    client: &impl GenericClient,
    org_id: &Uuid,
    credit_limit: i32,
) -> Result<(), String> {
    let result = client
        .execute(
            "update org_credit_balances
             set balance = greatest(balance, $2), updated_at = now()
             where org_id = $1",
            &[org_id, &credit_limit],
        )
        .await;
    tolerate_missing_schema(result).map(|_| ())
}

pub(crate) async fn sync_org_credit_limit(
    client: &impl GenericClient,
    org_id: &Uuid,
    credit_limit: i32,
) -> Result<(), String> {
    let result = client
        .execute(
            "insert into org_credit_balances (org_id, balance, credit_limit, updated_at) values ($1, $2, $2, now())
             on conflict (org_id) do update
             set credit_limit = excluded.credit_limit,
                 balance = least(org_credit_balances.balance, excluded.credit_limit),
                 updated_at = excluded.updated_at",
            &[org_id, &credit_limit],
        )
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            let code = error.as_db_error().map(|db_error| db_error.code());
            if matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
                return Ok(());
            }
            Err(format!("failed to upsert credit balance: {error}"))
        }
    }
}
