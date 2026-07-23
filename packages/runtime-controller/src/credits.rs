use std::str::FromStr;

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use prost::Message;
use prost_types::value::Kind as ProstKind;
use prost_types::{ListValue, Struct, Value as ProstValue};
use runtime_contracts::{CreditEventRequest, CreditEventResponse, CreditSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::GenericClient;
use tokio_postgres::Transaction;
use tracing::{field, info, instrument};
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::dispatch::DispatchPromptNormalized;
use crate::model_defaults::DEFAULT_MANAGED_AI_PROVIDER_ID;
use crate::projects::ensure_project_org;
use crate::{
    bad_request, ensure_project_access, internal_error, load_project_record,
    parse_optional_uuid_param, unauthorized, ApiError, AppConfig, AppState, ProjectRecord,
};

const AUTO_REFILL_DAILY_WINDOW_ID: &str = "daily";
const AUTO_REFILL_DAILY_REASON: &str = "auto_refill_daily";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/credits", post(credit_event))
        .route("/credits/status", get(credit_status))
        .route("/credits/ledger", get(credit_ledger))
        .route("/credits/policy", get(credit_policy))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditStatusQuery {
    #[serde(alias = "project_id")]
    project_id: Option<String>,
    #[serde(alias = "session_id")]
    session_id: Option<String>,
    #[serde(alias = "access_token")]
    access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditStatusResponse {
    balance: i32,
    credit_limit: i32,
    last_burn_at: Option<String>,
    last_refill_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription: Option<OrgSubscriptionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditPolicyResponse {
    display: CreditDisplayPolicy,
    refill: CreditPolicyRefill,
    plans: Vec<CreditPolicyPlan>,
    usage: CreditUsagePolicy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditDisplayPolicy {
    unit_label: String,
    currency: &'static str,
    units_per_usd: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditPolicyRefill {
    kind: &'static str,
    timezone: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditPolicyPlan {
    id: String,
    name: String,
    currency: String,
    monthly_price_cents: i32,
    credit_limit: i32,
    max_active_tunnels: i64,
    max_active_hosted_runtimes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditUsagePolicy {
    tunnel: CreditUsageRate,
    hosted_runtime: CreditUsageRate,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    hosted_runtime_providers: Vec<HostedRuntimeProviderUsageRate>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    runtime_sizes: Vec<RuntimeSizePolicy>,
    managed_ai: ManagedAiUsageRate,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSizePolicy {
    id: &'static str,
    label: &'static str,
    cpu_count: f64,
    memory_gb: f64,
    credits_per_minute: f64,
    credits_per_hour: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditUsageRate {
    reason: &'static str,
    enabled: bool,
    amount: i32,
    interval_seconds: i64,
    credits_per_minute: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedRuntimeProviderUsageRate {
    provider_id: String,
    display_name: String,
    enabled: bool,
    amount: i32,
    interval_seconds: i64,
    credits_per_minute: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedAiUsageRate {
    reason: &'static str,
    enabled: bool,
    label: String,
    provider: &'static str,
    credits_per_prompt: i32,
    daily_prompt_limit: i32,
    model_label: String,
    input_usd_micros_per_1k: i64,
    cached_input_usd_micros_per_1k: i64,
    output_usd_micros_per_1k: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrgSubscriptionSummary {
    plan_id: String,
    status: String,
    processor: String,
    /// True when the subscription is scheduled to end at the current period
    /// boundary ("cancels on <currentPeriodEnd>").
    cancel_at_period_end: bool,
    /// RFC3339 end of the current billing period ("renews on <date>").
    #[serde(skip_serializing_if = "Option::is_none")]
    current_period_end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditPolicyQuery {
    #[serde(alias = "project_id")]
    project_id: Option<String>,
    #[serde(alias = "session_id")]
    session_id: Option<String>,
    #[serde(alias = "access_token")]
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditLedgerQuery {
    #[serde(alias = "project_id")]
    project_id: Option<String>,
    #[serde(alias = "session_id")]
    session_id: Option<String>,
    #[serde(alias = "access_token")]
    access_token: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditLedgerResponse {
    entries: Vec<CreditLedgerEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditLedgerEntry {
    pub(crate) delta: i32,
    pub(crate) reason: String,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: String,
}

pub(crate) struct CreditLedgerEntryData {
    pub(crate) delta: i32,
    pub(crate) reason: String,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreditLedgerReference {
    pub(crate) ledger_id: Uuid,
    pub(crate) idempotency_key: String,
    pub(crate) reason: String,
    pub(crate) delta: i32,
}

fn credits_per_minute(burn_amount: i32, interval_seconds: i64) -> f64 {
    let amount = burn_amount.max(0) as f64;
    let interval = interval_seconds.max(1) as f64;
    amount * 60.0 / interval
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ManagedAiTokenUsage {
    pub(crate) input_tokens: u64,
    pub(crate) cached_input_tokens: u64,
    pub(crate) output_tokens: u64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ManagedAiUsageCharge {
    pub(crate) reserve_units: i32,
    pub(crate) charged_units: i32,
    pub(crate) adjustment_units: i32,
    pub(crate) input_cost_usd_micros: i64,
    pub(crate) cached_input_cost_usd_micros: i64,
    pub(crate) output_cost_usd_micros: i64,
    pub(crate) total_cost_usd_micros: i64,
}

fn ceil_div_i128(numerator: i128, denominator: i128) -> i128 {
    if numerator <= 0 || denominator <= 0 {
        return 0;
    }
    (numerator + denominator - 1) / denominator
}

fn clamp_i128_to_i32(value: i128) -> i32 {
    value.clamp(0, i128::from(i32::MAX)) as i32
}

fn token_cost_usd_micros(tokens: u64, usd_micros_per_1k: i64) -> i64 {
    if tokens == 0 || usd_micros_per_1k <= 0 {
        return 0;
    }
    let micros = ceil_div_i128(i128::from(tokens) * i128::from(usd_micros_per_1k), 1_000);
    micros.clamp(0, i128::from(i64::MAX)) as i64
}

pub(crate) fn calculate_managed_ai_usage_charge(
    config: &AppConfig,
    usage: ManagedAiTokenUsage,
) -> ManagedAiUsageCharge {
    let input_cost_usd_micros = token_cost_usd_micros(
        usage.input_tokens,
        config.managed_ai_input_usd_micros_per_1k,
    );
    let cached_input_cost_usd_micros = token_cost_usd_micros(
        usage.cached_input_tokens,
        config.managed_ai_cached_input_usd_micros_per_1k,
    );
    let output_cost_usd_micros = token_cost_usd_micros(
        usage.output_tokens,
        config.managed_ai_output_usd_micros_per_1k,
    );
    let total_cost_usd_micros = input_cost_usd_micros
        .saturating_add(cached_input_cost_usd_micros)
        .saturating_add(output_cost_usd_micros);

    let reserve_units = config.managed_ai_credit_burn_amount.max(0);
    let mut charged_units = if total_cost_usd_micros > 0 && config.billing_units_per_usd > 0 {
        clamp_i128_to_i32(ceil_div_i128(
            i128::from(total_cost_usd_micros) * i128::from(config.billing_units_per_usd),
            1_000_000,
        ))
    } else {
        0
    };
    if total_cost_usd_micros > 0 && charged_units == 0 {
        charged_units = 1;
    }

    ManagedAiUsageCharge {
        reserve_units,
        charged_units,
        adjustment_units: charged_units - reserve_units,
        input_cost_usd_micros,
        cached_input_cost_usd_micros,
        output_cost_usd_micros,
        total_cost_usd_micros,
    }
}

fn parse_json_i32(value: &JsonValue) -> Option<i32> {
    match value {
        JsonValue::Number(number) => number.as_i64().and_then(|v| i32::try_from(v).ok()),
        JsonValue::String(raw) => raw.trim().parse::<i32>().ok(),
        _ => None,
    }
}

fn parse_json_i64(value: &JsonValue) -> Option<i64> {
    match value {
        JsonValue::Number(number) => number.as_i64(),
        JsonValue::String(raw) => raw.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn provider_hosted_runtime_billing_overrides(
    provider: &crate::config::RuntimeProviderConfig,
) -> (Option<i32>, Option<i64>) {
    let Some(metadata) = provider.metadata.as_ref() else {
        return (None, None);
    };
    let Some(billing) = metadata.get("billing") else {
        return (None, None);
    };
    let Some(billing) = billing.as_object() else {
        return (None, None);
    };

    let amount = billing.get("creditBurnAmount").and_then(parse_json_i32);
    let interval_seconds = billing
        .get("creditBurnIntervalSeconds")
        .and_then(parse_json_i64);

    (amount, interval_seconds)
}

const FREE_PLAN_DAILY_CREDITS: i64 = 200;
const FREE_PLAN_HOSTED_RUNTIME_DAILY_TARGET_SECONDS: i64 = 2 * 60 * 60;

fn free_plan_hosted_runtime_burn_amount(interval_seconds: i64) -> i32 {
    if FREE_PLAN_DAILY_CREDITS <= 0 {
        return 0;
    }

    let interval_seconds = interval_seconds.max(1);
    let buckets =
        (FREE_PLAN_HOSTED_RUNTIME_DAILY_TARGET_SECONDS + interval_seconds - 1) / interval_seconds;
    if buckets <= 0 {
        return 0;
    }

    (FREE_PLAN_DAILY_CREDITS / buckets)
        .max(1)
        .clamp(0, i64::from(i32::MAX)) as i32
}

pub(crate) fn resolve_hosted_runtime_credit_burn_config_for_provider(
    state: &AppState,
    provider: &crate::config::RuntimeProviderConfig,
) -> (i32, i64) {
    let (amount_override, interval_override) = provider_hosted_runtime_billing_overrides(provider);
    let amount = amount_override
        .unwrap_or(state.config.hosted_runtime_credit_burn_amount)
        .max(0);
    let interval_seconds = interval_override
        .unwrap_or(state.config.hosted_runtime_credit_burn_interval_seconds)
        .max(1);

    let provider_key = crate::provider_identifiers::provider_id_key(&provider.id);
    if provider_key == crate::provider_identifiers::PROVIDER_ID_INSTAFY_CLOUD {
        if amount <= 0 {
            return (0, interval_seconds);
        }
        return (
            free_plan_hosted_runtime_burn_amount(interval_seconds),
            interval_seconds,
        );
    }

    (amount, interval_seconds)
}

#[instrument(skip(state, headers, params), fields(project_id = field::Empty))]
pub(crate) async fn credit_status(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CreditStatusQuery>,
) -> Result<Json<CreditStatusResponse>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    tracing::Span::current().record("project_id", &field::display(project_id));

    let session_id = parse_optional_uuid_param(params.session_id.clone(), "sessionId")?;
    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut connection = state.pool.get().await.map_err(|error| {
        tracing::error!(project_id = %project_id, %error, "credits status: pool error");
        internal_error(format!("failed to get connection: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        tracing::error!(project_id = %project_id, %error, "credits status: tx start failed");
        internal_error(format!("failed to start transaction: {error}"))
    })?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, session_id).await?;
    let project = ensure_project_org(&transaction, &project).await?;
    transaction.commit().await.map_err(|error| {
        tracing::error!(
            project_id = %project_id,
            %error,
            "credits status: transaction commit failed"
        );
        internal_error(format!("failed to finalize credit status check: {error}"))
    })?;

    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;

    let snapshot =
        {
            let transaction = connection.transaction().await.map_err(|error| {
            tracing::error!(project_id = %project_id, %error, "credits status: tx start failed");
            internal_error(format!("failed to start credits status transaction: {error}"))
        })?;

            let _ = attempt_daily_refill(
                &transaction,
                &project_id,
                &org_id,
                None,
                0,
                "credits.status",
            )
            .await?;

            let subscription = load_org_subscription_summary(&transaction, &org_id).await?;
            let snapshot = get_credit_snapshot(&transaction, &org_id).await?;
            transaction.commit().await.map_err(|error| {
                tracing::error!(
                    project_id = %project_id,
                    %error,
                    "credits status: transaction commit failed"
                );
                internal_error(format!("failed to finalize credits status refill: {error}"))
            })?;
            (snapshot, subscription)
        };

    let response = CreditStatusResponse {
        balance: snapshot.0.balance,
        credit_limit: snapshot.0.credit_limit,
        last_burn_at: snapshot.0.last_burn_at.map(|value| value.to_rfc3339()),
        last_refill_at: snapshot.0.last_refill_at.map(|value| value.to_rfc3339()),
        subscription: snapshot.1,
    };
    info!(
        org_id = %org_id,
        project_id = %project_id,
        balance = snapshot.0.balance,
        credit_limit = snapshot.0.credit_limit,
        "credits status served"
    );

    Ok(Json(response))
}

#[instrument(skip(state, headers, params), fields(project_id = field::Empty))]
pub(crate) async fn credit_policy(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CreditPolicyQuery>,
) -> Result<Json<CreditPolicyResponse>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    tracing::Span::current().record("project_id", &field::display(project_id));

    let session_id = parse_optional_uuid_param(params.session_id.clone(), "sessionId")?;
    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

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

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize policy lookup: {error}")))?;

    let plans = crate::billing::plans::load_active_plans(&*connection)
        .await
        .map_err(internal_error)?
        .into_iter()
        .map(|plan| CreditPolicyPlan {
            id: plan.id,
            name: plan.name,
            currency: plan.currency,
            monthly_price_cents: plan.monthly_price_cents,
            credit_limit: plan.credit_limit,
            max_active_tunnels: plan.max_active_tunnels,
            max_active_hosted_runtimes: plan.max_active_hosted_runtimes,
        })
        .collect::<Vec<_>>();

    let tunnel_amount = state.config.tunnel_credit_burn_amount.max(0);
    let tunnel_interval_seconds = state.config.tunnel_credit_burn_interval_seconds.max(1);
    let tunnel_credits_per_minute = credits_per_minute(tunnel_amount, tunnel_interval_seconds);

    let mut hosted_runtime_providers = state
        .provider_registry
        .provider_configs()
        .into_iter()
        .filter(|provider| crate::provider_identifiers::is_instafy_cloud_provider_id(&provider.id))
        .map(|provider| {
            let (amount, interval_seconds) =
                resolve_hosted_runtime_credit_burn_config_for_provider(&state, &provider);
            HostedRuntimeProviderUsageRate {
                provider_id: provider.id,
                display_name: provider.display_name,
                enabled: amount > 0,
                amount,
                interval_seconds,
                credits_per_minute: credits_per_minute(amount, interval_seconds),
            }
        })
        .collect::<Vec<_>>();
    hosted_runtime_providers.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));

    let (hosted_runtime_amount, hosted_runtime_interval_seconds) = hosted_runtime_providers
        .iter()
        .find(|provider| {
            crate::provider_identifiers::provider_id_key(&provider.provider_id)
                == crate::provider_identifiers::PROVIDER_ID_INSTAFY_CLOUD
        })
        .or_else(|| hosted_runtime_providers.first())
        .map(|provider| (provider.amount, provider.interval_seconds))
        .unwrap_or_else(|| {
            (
                state.config.hosted_runtime_credit_burn_amount.max(0),
                state
                    .config
                    .hosted_runtime_credit_burn_interval_seconds
                    .max(1),
            )
        });

    let hosted_runtime_credits_per_minute =
        credits_per_minute(hosted_runtime_amount, hosted_runtime_interval_seconds);
    let managed_ai_amount = state.config.managed_ai_credit_burn_amount.max(0);

    Ok(Json(CreditPolicyResponse {
        display: CreditDisplayPolicy {
            unit_label: state.config.billing_unit_label.clone(),
            currency: "USD",
            units_per_usd: state.config.billing_units_per_usd.max(1),
        },
        refill: CreditPolicyRefill {
            kind: "daily",
            timezone: "UTC",
        },
        plans,
        usage: CreditUsagePolicy {
            tunnel: CreditUsageRate {
                reason: "tunnel_grant",
                enabled: tunnel_amount > 0,
                amount: tunnel_amount,
                interval_seconds: tunnel_interval_seconds,
                credits_per_minute: tunnel_credits_per_minute,
            },
            hosted_runtime: CreditUsageRate {
                reason: "hosted_runtime",
                enabled: hosted_runtime_amount > 0,
                amount: hosted_runtime_amount,
                interval_seconds: hosted_runtime_interval_seconds,
                credits_per_minute: hosted_runtime_credits_per_minute,
            },
            hosted_runtime_providers,
            runtime_sizes: crate::runtime::sizes::RUNTIME_SIZES
                .iter()
                .map(|size| {
                    let per_minute = hosted_runtime_credits_per_minute * size.burn_multiplier;
                    RuntimeSizePolicy {
                        id: size.id,
                        label: size.label,
                        cpu_count: size.cpu_count,
                        memory_gb: size.memory_gb,
                        credits_per_minute: per_minute,
                        credits_per_hour: per_minute * 60.0,
                    }
                })
                .collect(),
            managed_ai: ManagedAiUsageRate {
                reason: "managed_ai_prompt",
                enabled: state.config.managed_ai_enabled && managed_ai_amount > 0,
                label: state.config.managed_ai_label.clone(),
                provider: DEFAULT_MANAGED_AI_PROVIDER_ID,
                credits_per_prompt: managed_ai_amount,
                daily_prompt_limit: state.config.managed_ai_daily_prompt_limit.max(0),
                model_label: state.config.managed_ai_model_label.clone(),
                input_usd_micros_per_1k: state.config.managed_ai_input_usd_micros_per_1k.max(0),
                cached_input_usd_micros_per_1k: state
                    .config
                    .managed_ai_cached_input_usd_micros_per_1k
                    .max(0),
                output_usd_micros_per_1k: state.config.managed_ai_output_usd_micros_per_1k.max(0),
            },
        },
    }))
}

pub(crate) async fn load_org_subscription_summary(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<Option<OrgSubscriptionSummary>, (StatusCode, Json<ApiError>)> {
    // cancel_at_period_end is read out of to_jsonb(row) so this single query
    // works whether or not the column migration has landed. A failed query
    // would abort the caller's transaction, so schema-lag must not error here.
    let row = client
        .query_opt(
            "select billing_cycle, status, processor, current_period_end,
                    coalesce((to_jsonb(org_subscriptions) ->> 'cancel_at_period_end')::boolean, false) as cancel_at_period_end
             from org_subscriptions
             where org_id = $1
             order by updated_at desc
             limit 1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org subscription: {error}")))?;

    let Some(row) = row else {
        return Ok(None);
    };

    Ok(Some(OrgSubscriptionSummary {
        plan_id: row.get::<_, String>("billing_cycle"),
        status: row.get::<_, String>("status"),
        processor: row.get::<_, String>("processor"),
        cancel_at_period_end: row.get::<_, bool>("cancel_at_period_end"),
        current_period_end: row
            .get::<_, Option<DateTime<Utc>>>("current_period_end")
            .map(|value| value.to_rfc3339()),
    }))
}

#[instrument(skip(state, headers, params), fields(project_id = field::Empty))]
pub(crate) async fn credit_ledger(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CreditLedgerQuery>,
) -> Result<Json<CreditLedgerResponse>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    tracing::Span::current().record("project_id", &field::display(project_id));

    let session_id = parse_optional_uuid_param(params.session_id.clone(), "sessionId")?;
    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut connection = state.pool.get().await.map_err(|error| {
        tracing::error!(project_id = %project_id, %error, "credits ledger: pool error");
        internal_error(format!("failed to get connection: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        tracing::error!(project_id = %project_id, %error, "credits ledger: tx start failed");
        internal_error(format!("failed to start transaction: {error}"))
    })?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, session_id).await?;
    let project = ensure_project_org(&transaction, &project).await?;
    transaction.commit().await.map_err(|error| {
        tracing::error!(
            project_id = %project_id,
            %error,
            "credits ledger: transaction commit failed"
        );
        internal_error(format!("failed to finalize credit ledger check: {error}"))
    })?;

    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;
    let limit = params.limit.unwrap_or(25).clamp(5, 100) as i64;

    let entries = load_credit_ledger_entries(&*connection, &org_id, limit)
        .await
        .map_err(|(status, json)| {
            tracing::error!(
                org_id = %org_id,
                project_id = %project_id,
                limit = limit,
                error = %json.0.message,
                "credits ledger: failed to load entries"
            );
            (status, json)
        })?;
    let response = CreditLedgerResponse {
        entries: entries
            .into_iter()
            .map(|entry| CreditLedgerEntry {
                delta: entry.delta,
                reason: entry.reason,
                metadata: entry.metadata,
                created_at: entry.created_at.to_rfc3339(),
            })
            .collect(),
    };
    info!(
        org_id = %org_id,
        project_id = %project_id,
        entry_count = response.entries.len(),
        "credits ledger served"
    );

    Ok(Json(response))
}

#[instrument(
    skip(state, headers, body),
    fields(project_id = field::Empty, action = field::Empty)
)]
pub(crate) async fn credit_event(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let auth = authenticate_request(&state.config, &headers, None).await?;
    if !auth.is_service_role {
        return Err(unauthorized("credit refresh requires service role"));
    }

    let request = match CreditEventRequest::decode(body.clone()) {
        Ok(proto) => proto,
        Err(_) => {
            if let Ok(value) = serde_json::from_slice::<JsonValue>(&body) {
                json_to_credit_request(value)?
            } else {
                return Err(bad_request("invalid credit event payload"));
            }
        }
    };

    let project_id = Uuid::from_str(&request.project_id)
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;
    tracing::Span::current().record("project_id", &field::display(project_id));
    let runtime_id = parse_optional_uuid(&request.runtime_id);
    let idempotency_key = request.request_id.trim().to_string();
    let idempotency_key = (!idempotency_key.is_empty()).then_some(idempotency_key);

    let metadata = struct_to_json(request.metadata.clone());
    let amount = extract_amount(&request, &metadata);
    if amount <= 0 {
        return Err(bad_request("credit amount must be greater than zero"));
    }
    let credit_limit = extract_credit_limit(&request, &metadata);
    let reason = extract_reason(&request, &metadata);

    let mut connection = state.pool.get().await.map_err(|error| {
        tracing::error!(
            project_id = %project_id,
            %error,
            "credit event: failed to get connection"
        );
        internal_error(format!("failed to get connection: {error}"))
    })?;

    let setup_tx = connection.transaction().await.map_err(|error| {
        tracing::error!(
            project_id = %project_id,
            %error,
            "credit event: failed to start org lookup transaction"
        );
        internal_error(format!("failed to start org lookup: {error}"))
    })?;
    let project = load_project_record(&setup_tx, &project_id).await?;
    let project = ensure_project_org(&setup_tx, &project).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;
    setup_tx.commit().await.map_err(|error| {
        tracing::error!(
            project_id = %project_id,
            %error,
            "credit event: failed to finalize org lookup"
        );
        internal_error(format!("failed to finalize org lookup: {error}"))
    })?;

    let action = request.action.to_lowercase();
    tracing::Span::current().record("action", &field::display(&action));

    let snapshot = if action == "status" {
        get_credit_snapshot(&*connection, &org_id).await?
    } else {
        let transaction = connection.transaction().await.map_err(|error| {
            tracing::error!(
                org_id = %org_id,
                project_id = %project_id,
                %error,
                "credit event: failed to start credit transaction"
            );
            internal_error(format!("failed to start transaction: {error}"))
        })?;

        let mut metadata_with_context =
            augment_metadata(metadata.clone(), &request, runtime_id, &action, amount);

        let snapshot = match action.as_str() {
            "burn" => {
                process_credit_burn(
                    &transaction,
                    &project_id,
                    &org_id,
                    runtime_id,
                    amount,
                    &reason,
                    idempotency_key.as_deref(),
                    &mut metadata_with_context,
                )
                .await?
            }
            "refill" => {
                process_credit_refill(
                    &transaction,
                    &project_id,
                    &org_id,
                    runtime_id,
                    amount,
                    credit_limit,
                    &reason,
                    idempotency_key.as_deref(),
                    &mut metadata_with_context,
                )
                .await?
            }
            other => return Err(bad_request(format!("unsupported credit action: {other}"))),
        };

        transaction.commit().await.map_err(|error| {
            tracing::error!(
                org_id = %org_id,
                project_id = %project_id,
                %error,
                "credit event: failed to commit credit transaction"
            );
            internal_error(format!("failed to commit credit event: {error}"))
        })?;

        snapshot
    };

    if action != "status" {
        info!(
            org_id = %org_id,
            project_id = %project_id,
            runtime_id = runtime_id.map(|v| v.to_string()),
            action = action.as_str(),
            amount,
            balance = snapshot.balance,
            credit_limit = snapshot.credit_limit,
            "credit event applied"
        );
    }

    let response = CreditEventResponse {
        snapshot: Some(credit_snapshot_to_proto(snapshot)),
    };

    let mut buf = Vec::new();
    response
        .encode(&mut buf)
        .map_err(|error| internal_error(format!("failed to encode response: {error}")))?;

    let headers = [(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/x-protobuf"),
    )];
    Ok((StatusCode::OK, headers, buf))
}

pub(crate) fn extract_credit_snapshot(metadata: &Option<JsonValue>) -> Option<JsonValue> {
    metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("creditSnapshot"))
        .cloned()
}

pub(crate) fn extract_provider_from_metadata(metadata: &Option<JsonValue>) -> Option<String> {
    metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str)
        .map(|value| value.to_string())
}

pub(crate) fn extract_provider_conversation_state(
    metadata: &Option<JsonValue>,
) -> Option<JsonValue> {
    metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|map| map.get("conversation"))
        .cloned()
}

pub(crate) async fn ensure_sandbox_credit_seed(
    transaction: &Transaction<'_>,
    config: &AppConfig,
    project: &ProjectRecord,
    request: &DispatchPromptNormalized,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if config.sandbox_credit_seed_amount <= 0 {
        return Ok(());
    }

    if !should_seed_project(project, request.project_type_hint.as_deref(), context) {
        return Ok(());
    }

    let project_with_org = if project.org_id.is_some() {
        project.clone()
    } else {
        ensure_project_org(transaction, project).await?
    };

    let org_id = project_with_org
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;

    let existing_seed = transaction
        .query_opt(
            "select id from org_credit_ledger where org_id = $1 and reason = 'sandbox_seed' limit 1",
            &[&org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to query credit ledger seed: {error}")))?;

    if existing_seed.is_some() {
        return Ok(());
    }

    let balance_row = transaction
        .query_opt(
            "select balance, credit_limit from org_credit_balances where org_id = $1",
            &[&org_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to query project credit balance: {error}"))
        })?;

    let (current_balance, current_limit) = match balance_row {
        Some(row) => {
            let balance: Option<i32> = row.get("balance");
            let limit: Option<i32> = row.get("credit_limit");
            (balance.unwrap_or(0), limit.unwrap_or(0))
        }
        None => (0, 0),
    };

    if current_balance > 0 {
        return Ok(());
    }

    let mut metadata_map = JsonMap::new();
    metadata_map.insert(
        "source".to_string(),
        JsonValue::String("sandbox-seed".into()),
    );
    if let Some(project_type) = project_with_org.project_type.as_ref() {
        metadata_map.insert(
            "project_type".to_string(),
            JsonValue::String(project_type.clone()),
        );
    }
    if let Some(session_id) = project_with_org.sandbox_session_id {
        metadata_map.insert(
            "sandbox_session_id".to_string(),
            JsonValue::String(session_id.to_string()),
        );
    }
    let metadata_json = JsonValue::Object(metadata_map);
    let metadata_param = PgJson(&metadata_json);

    transaction
        .execute(
            "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata) values ($1, $2, $3, 'sandbox_seed', $4::jsonb)",
            &[
                &org_id,
                &project_with_org.id,
                &config.sandbox_credit_seed_amount,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert sandbox credit seed: {error}")))?;

    if config.sandbox_credit_seed_limit > 0 {
        let next_limit = std::cmp::max(current_limit, config.sandbox_credit_seed_limit);
        transaction
            .execute(
                "insert into org_credit_balances (org_id, credit_limit)
                 values ($1, $2)
                 on conflict (org_id) do update set credit_limit = excluded.credit_limit, updated_at = now()",
                &[&org_id, &next_limit],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update credit limit: {error}")))?;
    }

    Ok(())
}

fn should_seed_project(
    project: &ProjectRecord,
    project_type_hint: Option<&str>,
    context: &RequestContext,
) -> bool {
    let mut type_hints: Vec<&str> = Vec::new();
    if let Some(hint) = project_type_hint {
        type_hints.push(hint);
    }
    if let Some(existing) = project.project_type.as_deref() {
        type_hints.push(existing);
    }
    let is_sandbox_type = type_hints
        .iter()
        .map(|value| value.trim().to_lowercase())
        .any(|value| value == "sandbox" || value == "demo");
    let has_sandbox_session = project.sandbox_session_id.is_some();
    let is_anonymous = context.user_id.is_none() && project.owner_user_id.is_none();
    is_sandbox_type || has_sandbox_session || is_anonymous
}

fn augment_metadata(
    metadata: JsonValue,
    request: &CreditEventRequest,
    runtime_id: Option<Uuid>,
    action: &str,
    amount: i32,
) -> JsonValue {
    let mut map = match metadata {
        JsonValue::Object(map) => map,
        _ => JsonMap::new(),
    };

    let request_id = request.request_id.trim();
    if !request_id.is_empty() {
        map.entry("requestId".to_string())
            .or_insert_with(|| JsonValue::String(request_id.to_string()));
    }

    map.entry("action".to_string())
        .or_insert_with(|| JsonValue::String(action.to_string()));
    map.entry("amount".to_string())
        .or_insert_with(|| JsonValue::Number(amount.into()));
    if let Some(runtime_id) = runtime_id {
        map.entry("runtimeId".to_string())
            .or_insert_with(|| JsonValue::String(runtime_id.to_string()));
    }
    if !request.provider.is_empty() {
        map.entry("provider".to_string())
            .or_insert_with(|| JsonValue::String(request.provider.clone()));
    }
    if !request.reason.is_empty() {
        map.entry("reason".to_string())
            .or_insert_with(|| JsonValue::String(request.reason.clone()));
    }

    JsonValue::Object(map)
}

fn extract_amount(request: &CreditEventRequest, metadata: &JsonValue) -> i32 {
    if request.amount != 0 {
        request.amount
    } else {
        metadata
            .get("amount")
            .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|f| f as i64)))
            .map(|value| value as i32)
            .unwrap_or(0)
    }
}

fn extract_credit_limit(request: &CreditEventRequest, metadata: &JsonValue) -> Option<i32> {
    if request.credit_limit > 0 {
        Some(request.credit_limit)
    } else {
        metadata
            .get("creditLimit")
            .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|f| f as i64)))
            .map(|value| value as i32)
    }
}

fn extract_reason(request: &CreditEventRequest, metadata: &JsonValue) -> String {
    if !request.reason.is_empty() {
        request.reason.clone()
    } else {
        metadata
            .get("reason")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string()
    }
}

fn parse_optional_uuid(value: &str) -> Option<Uuid> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Uuid::from_str(trimmed).ok()
    }
}

fn json_to_credit_request(
    value: JsonValue,
) -> Result<CreditEventRequest, (StatusCode, Json<ApiError>)> {
    let request_id = value
        .get("requestId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let action = value
        .get("action")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let project_id = value
        .get("projectId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| bad_request("projectId is required"))?
        .to_string();
    let runtime_id = value
        .get("runtimeId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let run_id = value
        .get("runId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let provider = value
        .get("provider")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let metadata = value.get("metadata").cloned();
    let amount = value.get("amount").and_then(JsonValue::as_i64).unwrap_or(0) as i32;
    let credit_limit = value
        .get("creditLimit")
        .and_then(JsonValue::as_i64)
        .unwrap_or(0) as i32;
    let reason = value
        .get("reason")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();

    Ok(CreditEventRequest {
        request_id,
        action,
        project_id,
        runtime_id,
        run_id,
        provider,
        metadata: json_to_struct(metadata),
        amount,
        credit_limit,
        reason,
    })
}

fn json_to_struct(value: Option<JsonValue>) -> Option<Struct> {
    value.and_then(struct_from_json)
}

fn struct_to_json(value: Option<Struct>) -> JsonValue {
    value
        .map(json_from_struct)
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()))
}

pub(crate) async fn load_credit_ledger_entries(
    client: &impl GenericClient,
    org_id: &Uuid,
    limit: i64,
) -> Result<Vec<CreditLedgerEntryData>, (StatusCode, Json<ApiError>)> {
    let rows = client
        .query(
            "select delta, reason, metadata, created_at
             from org_credit_ledger
             where org_id = $1
             order by created_at desc
             limit $2",
            &[org_id, &limit],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credit ledger: {error}")))?;

    let entries = rows
        .into_iter()
        .map(|row| CreditLedgerEntryData {
            delta: row.get("delta"),
            reason: row.get("reason"),
            metadata: row
                .try_get::<_, Option<JsonValue>>("metadata")
                .unwrap_or(None),
            created_at: row.get("created_at"),
        })
        .collect();
    Ok(entries)
}

pub(crate) async fn load_credit_ledger_reference_by_idempotency_key(
    client: &impl GenericClient,
    org_id: &Uuid,
    project_id: &Uuid,
    idempotency_key: &str,
) -> Result<Option<CreditLedgerReference>, (StatusCode, Json<ApiError>)> {
    let trimmed_key = idempotency_key.trim();
    if trimmed_key.is_empty() {
        return Ok(None);
    }

    let row = client
        .query_opt(
            "select id, delta, reason
             from org_credit_ledger
             where org_id = $1 and project_id = $2 and idempotency_key = $3
             limit 1",
            &[org_id, project_id, &trimmed_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load credit ledger reference for idempotency key {trimmed_key}: {error}"
            ))
        })?;

    Ok(row.map(|row| CreditLedgerReference {
        ledger_id: row.get("id"),
        idempotency_key: trimmed_key.to_string(),
        reason: row.get("reason"),
        delta: row.get("delta"),
    }))
}

fn json_from_struct(struct_value: Struct) -> JsonValue {
    let mut map = JsonMap::new();
    for (key, value) in struct_value.fields.into_iter() {
        if let Some(json_value) = json_from_prost_value(value) {
            map.insert(key, json_value);
        }
    }
    JsonValue::Object(map)
}

fn json_from_prost_value(value: ProstValue) -> Option<JsonValue> {
    match value.kind? {
        ProstKind::NullValue(_) => Some(JsonValue::Null),
        ProstKind::NumberValue(n) => Some(JsonValue::from(n)),
        ProstKind::StringValue(s) => Some(JsonValue::from(s)),
        ProstKind::BoolValue(b) => Some(JsonValue::from(b)),
        ProstKind::StructValue(struct_value) => Some(json_from_struct(struct_value)),
        ProstKind::ListValue(ListValue { values }) => {
            let items: Vec<JsonValue> = values
                .into_iter()
                .filter_map(json_from_prost_value)
                .collect();
            Some(JsonValue::Array(items))
        }
    }
}

fn struct_from_json(value: JsonValue) -> Option<Struct> {
    match value {
        JsonValue::Object(map) => {
            let fields = map
                .into_iter()
                .filter_map(|(key, value)| prost_value_from_json(value).map(|v| (key, v)))
                .collect();
            Some(Struct { fields })
        }
        _ => None,
    }
}

fn prost_value_from_json(value: JsonValue) -> Option<ProstValue> {
    let kind = match value {
        JsonValue::Null => ProstKind::NullValue(0),
        JsonValue::Bool(b) => ProstKind::BoolValue(b),
        JsonValue::Number(n) => {
            let float_value = n.as_f64()?;
            ProstKind::NumberValue(float_value)
        }
        JsonValue::String(s) => ProstKind::StringValue(s),
        JsonValue::Array(items) => {
            let values: Vec<ProstValue> = items
                .into_iter()
                .filter_map(prost_value_from_json)
                .collect();
            ProstKind::ListValue(ListValue { values })
        }
        JsonValue::Object(map) => {
            let fields = map
                .into_iter()
                .filter_map(|(key, value)| prost_value_from_json(value).map(|v| (key, v)))
                .collect();
            ProstKind::StructValue(Struct { fields })
        }
    };

    Some(ProstValue { kind: Some(kind) })
}

pub(crate) async fn process_credit_burn(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    org_id: &Uuid,
    runtime_id: Option<Uuid>,
    amount: i32,
    reason: &str,
    idempotency_key: Option<&str>,
    metadata: &mut JsonValue,
) -> Result<CreditSnapshotData, (StatusCode, Json<ApiError>)> {
    let delta = -(amount.abs());
    let metadata_map = metadata
        .as_object_mut()
        .ok_or_else(|| internal_error("credit burn metadata must be an object"))?;
    ensure_managed_ai_provider_metadata(reason, metadata_map);

    let idempotency_key = idempotency_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(key) = idempotency_key {
        metadata_map.insert(
            "idempotencyKey".to_string(),
            JsonValue::String(key.to_string()),
        );
        let existing = transaction
            .query_opt(
                "select 1 from org_credit_ledger where org_id = $1 and project_id = $2 and idempotency_key = $3 limit 1",
                &[org_id, project_id, &key],
            )
            .await
            .map_err(|error| internal_error(format!("failed to check burn idempotency: {error}")))?;
        if existing.is_some() {
            metadata_map.insert("deduped".to_string(), JsonValue::Bool(true));
            return get_credit_snapshot(transaction, org_id).await;
        }
    }
    metadata_map.insert("deduped".to_string(), JsonValue::Bool(false));

    let snapshot_before_burn = ensure_balance_for_burn(
        transaction,
        project_id,
        org_id,
        runtime_id,
        amount,
        reason,
        metadata_map,
    )
    .await?;

    if snapshot_before_burn.balance < amount {
        let shortfall = amount - snapshot_before_burn.balance;
        metadata_map.insert("shortfall".to_string(), JsonValue::from(shortfall));
        return Err(bad_request(
            "insufficient credits available for requested burn",
        ));
    }

    metadata_map.insert("delta".to_string(), JsonValue::Number(delta.into()));
    let idempotency_param = idempotency_key.map(|value| value.to_string());
    let insert_result = if idempotency_param.is_some() {
        transaction
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata, created_by, idempotency_key)
                 values ($1, $2, $3, $4, $5::jsonb, $6, $7)
                 on conflict do nothing",
                &[
                    org_id,
                    project_id,
                    &delta,
                    &reason,
                    &PgJson(&*metadata),
                    &runtime_id,
                    &idempotency_param,
                ],
            )
            .await
    } else {
        transaction
            .execute(
                "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata, created_by, idempotency_key)
                 values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
                &[
                    org_id,
                    project_id,
                    &delta,
                    &reason,
                    &PgJson(&*metadata),
                    &runtime_id,
                    &idempotency_param,
                ],
            )
            .await
    };

    match insert_result {
        Ok(0) if idempotency_param.is_some() => {
            if let Some(map) = metadata.as_object_mut() {
                map.insert("deduped".to_string(), JsonValue::Bool(true));
            }
            return get_credit_snapshot(transaction, org_id).await;
        }
        Ok(_) => {}
        Err(error) => {
            let message = error.to_string();
            if message.contains("Insufficient credits for org") {
                return Err(bad_request(
                    "insufficient credits available for requested burn",
                ));
            }
            return Err(internal_error(format!("failed to burn credits: {error}")));
        }
    }

    get_credit_snapshot(transaction, org_id).await
}

fn ensure_managed_ai_provider_metadata(reason: &str, metadata: &mut JsonMap<String, JsonValue>) {
    if reason == "managed_ai_prompt" {
        metadata
            .entry("managedAiProvider".to_string())
            .or_insert_with(|| JsonValue::String(DEFAULT_MANAGED_AI_PROVIDER_ID.to_string()));
    }
}

pub(crate) async fn merge_credit_ledger_metadata_by_idempotency_key(
    client: &impl GenericClient,
    org_id: &Uuid,
    project_id: &Uuid,
    idempotency_key: &str,
    metadata_patch: &JsonValue,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let trimmed_key = idempotency_key.trim();
    if trimmed_key.is_empty() {
        return Ok(false);
    }
    if !metadata_patch.is_object() {
        return Err(internal_error(
            "credit ledger metadata patch must be a JSON object",
        ));
    }

    let updated = client
        .execute(
            "update org_credit_ledger
             set metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb
             where org_id = $1
               and project_id = $2
               and idempotency_key = $3",
            &[org_id, project_id, &trimmed_key, &PgJson(metadata_patch)],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to merge credit ledger metadata for idempotency key {trimmed_key}: {error}"
            ))
        })?;

    Ok(updated > 0)
}

pub(crate) async fn reconcile_managed_ai_usage_charge(
    transaction: &Transaction<'_>,
    config: &AppConfig,
    project_id: &Uuid,
    org_id: &Uuid,
    runtime_id: Option<Uuid>,
    prompt_id: &Uuid,
    provider: Option<&str>,
    managed_ai_label: Option<&str>,
    usage: ManagedAiTokenUsage,
) -> Result<ManagedAiUsageCharge, (StatusCode, Json<ApiError>)> {
    let charge = calculate_managed_ai_usage_charge(config, usage);
    let base_idempotency_key = format!("managed-ai-prompt:{prompt_id}");

    let reserved_units = transaction
        .query_opt(
            "select abs(delta) as reserved_units
             from org_credit_ledger
             where org_id = $1 and project_id = $2 and idempotency_key = $3
             limit 1",
            &[org_id, project_id, &base_idempotency_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load managed AI reserve ledger row for prompt {prompt_id}: {error}"
            ))
        })?
        .map(|row| row.get::<_, i32>("reserved_units"))
        .unwrap_or(0);

    let adjustment_units = charge.charged_units - reserved_units;
    let managed_ai_label = managed_ai_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.managed_ai_label.as_str());

    let base_metadata_patch = json!({
        "category": "ai_usage",
        "billingKind": "token_usage_reconciled",
        "managedAiLabel": managed_ai_label,
        "managedAiProvider": DEFAULT_MANAGED_AI_PROVIDER_ID,
        "managedAiModelLabel": config.managed_ai_model_label,
        "provider": provider,
        "promptId": prompt_id,
        "usage": {
            "input_tokens": usage.input_tokens,
            "cached_input_tokens": usage.cached_input_tokens,
            "output_tokens": usage.output_tokens,
        },
        "pricing": {
            "currency": "USD",
            "billingUnitsPerUsd": config.billing_units_per_usd,
            "inputUsdMicrosPer1k": config.managed_ai_input_usd_micros_per_1k,
            "cachedInputUsdMicrosPer1k": config.managed_ai_cached_input_usd_micros_per_1k,
            "outputUsdMicrosPer1k": config.managed_ai_output_usd_micros_per_1k,
        },
        "cost": {
            "inputUsdMicros": charge.input_cost_usd_micros,
            "cachedInputUsdMicros": charge.cached_input_cost_usd_micros,
            "outputUsdMicros": charge.output_cost_usd_micros,
            "estimatedUsdMicros": charge.total_cost_usd_micros,
            "reservedUnits": reserved_units,
            "chargedUnits": charge.charged_units,
            "adjustmentUnits": adjustment_units,
        }
    });
    merge_credit_ledger_metadata_by_idempotency_key(
        transaction,
        org_id,
        project_id,
        &base_idempotency_key,
        &base_metadata_patch,
    )
    .await?;

    if adjustment_units > 0 {
        let mut metadata = json!({
            "category": "ai_usage",
            "source": "managed_ai_reconciliation",
            "managedAiLabel": managed_ai_label,
            "managedAiProvider": DEFAULT_MANAGED_AI_PROVIDER_ID,
            "managedAiModelLabel": config.managed_ai_model_label,
            "provider": provider,
            "promptId": prompt_id,
            "usage": {
                "input_tokens": usage.input_tokens,
                "cached_input_tokens": usage.cached_input_tokens,
                "output_tokens": usage.output_tokens,
            },
            "cost": {
                "estimatedUsdMicros": charge.total_cost_usd_micros,
                "reservedUnits": reserved_units,
                "chargedUnits": charge.charged_units,
                "adjustmentUnits": adjustment_units,
            }
        });
        process_credit_burn(
            transaction,
            project_id,
            org_id,
            runtime_id,
            adjustment_units,
            "managed_ai_adjustment",
            Some(&format!("managed-ai-adjustment:{prompt_id}")),
            &mut metadata,
        )
        .await?;
    } else if adjustment_units < 0 {
        let mut metadata = json!({
            "category": "ai_usage",
            "source": "managed_ai_reconciliation",
            "managedAiLabel": managed_ai_label,
            "managedAiProvider": DEFAULT_MANAGED_AI_PROVIDER_ID,
            "managedAiModelLabel": config.managed_ai_model_label,
            "provider": provider,
            "promptId": prompt_id,
            "usage": {
                "input_tokens": usage.input_tokens,
                "cached_input_tokens": usage.cached_input_tokens,
                "output_tokens": usage.output_tokens,
            },
            "cost": {
                "estimatedUsdMicros": charge.total_cost_usd_micros,
                "reservedUnits": reserved_units,
                "chargedUnits": charge.charged_units,
                "adjustmentUnits": adjustment_units,
            }
        });
        process_credit_refill(
            transaction,
            project_id,
            org_id,
            runtime_id,
            adjustment_units.abs(),
            None,
            "managed_ai_adjustment",
            Some(&format!("managed-ai-adjustment:{prompt_id}")),
            &mut metadata,
        )
        .await?;
    }

    Ok(ManagedAiUsageCharge {
        reserve_units: reserved_units,
        adjustment_units,
        ..charge
    })
}

pub(crate) async fn process_credit_refill(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    org_id: &Uuid,
    runtime_id: Option<Uuid>,
    amount: i32,
    credit_limit: Option<i32>,
    reason: &str,
    idempotency_key: Option<&str>,
    metadata: &mut JsonValue,
) -> Result<CreditSnapshotData, (StatusCode, Json<ApiError>)> {
    let metadata_map = metadata
        .as_object_mut()
        .ok_or_else(|| internal_error("credit refill metadata must be an object"))?;

    let idempotency_key = idempotency_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(key) = idempotency_key {
        metadata_map.insert(
            "idempotencyKey".to_string(),
            JsonValue::String(key.to_string()),
        );
        let existing = transaction
            .query_opt(
                "select 1 from org_credit_ledger where org_id = $1 and project_id = $2 and idempotency_key = $3 limit 1",
                &[org_id, project_id, &key],
            )
            .await
            .map_err(|error| internal_error(format!("failed to check refill idempotency: {error}")))?;
        if existing.is_some() {
            metadata_map.insert("deduped".to_string(), JsonValue::Bool(true));
            return get_credit_snapshot(transaction, org_id).await;
        }
    }
    metadata_map.insert("deduped".to_string(), JsonValue::Bool(false));

    metadata_map.insert("delta".to_string(), JsonValue::Number(amount.into()));
    let idempotency_param = idempotency_key.map(|value| value.to_string());
    let insert_result = {
        let metadata_param = PgJson(&*metadata);
        if idempotency_param.is_some() {
            transaction
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata, created_by, idempotency_key)
                     values ($1, $2, $3, $4, $5::jsonb, $6, $7)
                     on conflict do nothing",
                    &[
                        org_id,
                        project_id,
                        &(amount as i32),
                        &reason,
                        &metadata_param,
                        &runtime_id,
                        &idempotency_param,
                    ],
                )
                .await
        } else {
            transaction
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata, created_by, idempotency_key)
                     values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
                    &[
                        org_id,
                        project_id,
                        &(amount as i32),
                        &reason,
                        &metadata_param,
                        &runtime_id,
                        &idempotency_param,
                    ],
                )
                .await
        }
    };

    match insert_result {
        Ok(0) if idempotency_param.is_some() => {
            if let Some(map) = metadata.as_object_mut() {
                map.insert("deduped".to_string(), JsonValue::Bool(true));
            }
            return get_credit_snapshot(transaction, org_id).await;
        }
        Ok(_) => {}
        Err(error) => {
            return Err(internal_error(format!("failed to refill credits: {error}")));
        }
    }

    if let Some(limit) = credit_limit {
        transaction
            .execute(
                "insert into org_credit_balances (org_id, credit_limit) values ($1, $2)
                 on conflict (org_id) do update set credit_limit = excluded.credit_limit, updated_at = now()",
                &[org_id, &limit],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update credit limit: {error}")))?;
    }

    get_credit_snapshot(transaction, org_id).await
}

async fn ensure_balance_for_burn(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    org_id: &Uuid,
    runtime_id: Option<Uuid>,
    amount: i32,
    reason: &str,
    metadata: &mut JsonMap<String, JsonValue>,
) -> Result<CreditSnapshotData, (StatusCode, Json<ApiError>)> {
    let mut snapshot = get_credit_snapshot(transaction, org_id).await?;

    metadata.insert(
        "preBurnBalance".to_string(),
        JsonValue::from(snapshot.balance),
    );
    metadata.insert(
        "creditLimit".to_string(),
        JsonValue::from(snapshot.credit_limit),
    );

    let refill =
        attempt_daily_refill(transaction, project_id, org_id, runtime_id, amount, reason).await?;

    if let Some(outcome) = refill {
        metadata.insert("autoRefillApplied".to_string(), JsonValue::Bool(true));
        metadata.insert(
            "autoRefillWindow".to_string(),
            JsonValue::String(AUTO_REFILL_DAILY_WINDOW_ID.to_string()),
        );
        metadata.insert(
            "autoRefillReason".to_string(),
            JsonValue::String(AUTO_REFILL_DAILY_REASON.to_string()),
        );
        metadata.insert(
            "autoRefillDelta".to_string(),
            JsonValue::from(outcome.delta),
        );
        metadata.insert(
            "postRefillBalance".to_string(),
            JsonValue::from(outcome.snapshot.balance),
        );
        snapshot = outcome.snapshot;
    } else {
        metadata.insert("autoRefillApplied".to_string(), JsonValue::Bool(false));
        metadata.insert(
            "postRefillBalance".to_string(),
            JsonValue::from(snapshot.balance),
        );
    }

    if snapshot.balance < amount {
        let shortfall = amount.saturating_sub(snapshot.balance);
        metadata.insert("shortfall".to_string(), JsonValue::from(shortfall));
    }

    Ok(snapshot)
}

struct AutoRefillOutcome {
    delta: i32,
    snapshot: CreditSnapshotData,
}

pub(crate) struct HostedRuntimeAffordability {
    pub(crate) affordable: bool,
    pub(crate) balance: i32,
    pub(crate) credit_limit: i32,
}

/// Whether the org can pay for at least one hosted-runtime billing bucket.
/// Launching a runtime the first billing sweep immediately kills (~60s later)
/// reads as an unexplained crash — refuse up front with a clear message
/// instead. Accounts for the lazy daily refill: a zero balance still counts
/// as affordable when today's refill hasn't been applied yet and the limit
/// covers the burn. Fails open when no balance row exists.
pub(crate) async fn check_hosted_runtime_affordability(
    transaction: &Transaction<'_>,
    org_id: &Uuid,
    burn_amount: i32,
) -> Result<HostedRuntimeAffordability, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select balance, credit_limit from org_credit_balances where org_id = $1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credit balance: {error}")))?;

    let Some(row) = row else {
        return Ok(HostedRuntimeAffordability {
            affordable: true,
            balance: 0,
            credit_limit: 0,
        });
    };
    let balance: i32 = row.get("balance");
    let credit_limit: i32 = row.get("credit_limit");

    if burn_amount <= 0 || balance >= burn_amount {
        return Ok(HostedRuntimeAffordability {
            affordable: true,
            balance,
            credit_limit,
        });
    }

    // Balance is short, but today's lazy refill may not have run yet.
    if credit_limit >= burn_amount
        && balance < credit_limit
        && daily_window_allows(transaction, org_id, Utc::now()).await?
    {
        return Ok(HostedRuntimeAffordability {
            affordable: true,
            balance,
            credit_limit,
        });
    }

    Ok(HostedRuntimeAffordability {
        affordable: false,
        balance,
        credit_limit,
    })
}

async fn attempt_daily_refill(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    org_id: &Uuid,
    runtime_id: Option<Uuid>,
    burn_amount: i32,
    trigger_reason: &str,
) -> Result<Option<AutoRefillOutcome>, (StatusCode, Json<ApiError>)> {
    // Lock the balance row to avoid double-refills when multiple requests race on a new day.
    transaction
        .execute(
            "insert into org_credit_balances(org_id) values ($1) on conflict (org_id) do nothing",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to ensure credit balance row: {error}")))?;
    let balance_row = transaction
        .query_one(
            "select balance, credit_limit from org_credit_balances where org_id = $1 for update",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock credit balance row: {error}")))?;
    let balance: i32 = balance_row.get("balance");
    let credit_limit: i32 = balance_row.get("credit_limit");

    if credit_limit <= 0 || balance >= credit_limit {
        return Ok(None);
    }

    let now = Utc::now();
    if !daily_window_allows(transaction, org_id, now).await? {
        return Ok(None);
    }

    let delta_to_limit = credit_limit - balance;
    if delta_to_limit <= 0 {
        return Ok(None);
    }

    let shortfall = if burn_amount > balance {
        burn_amount - balance
    } else {
        0
    };
    let mut metadata_map = JsonMap::new();
    metadata_map.insert(
        "action".to_string(),
        JsonValue::String("refill".to_string()),
    );
    metadata_map.insert("amount".to_string(), JsonValue::from(delta_to_limit));
    metadata_map.insert(
        "window".to_string(),
        JsonValue::String(AUTO_REFILL_DAILY_WINDOW_ID.to_string()),
    );
    metadata_map.insert(
        "source".to_string(),
        JsonValue::String("auto-daily".to_string()),
    );
    metadata_map.insert("shortfall".to_string(), JsonValue::from(shortfall));
    metadata_map.insert("creditLimit".to_string(), JsonValue::from(credit_limit));
    metadata_map.insert("preRefillBalance".to_string(), JsonValue::from(balance));
    if let Some(runtime_id) = runtime_id {
        metadata_map.insert(
            "runtimeId".to_string(),
            JsonValue::String(runtime_id.to_string()),
        );
    }
    if !trigger_reason.is_empty() {
        metadata_map.insert(
            "triggerReason".to_string(),
            JsonValue::String(trigger_reason.to_string()),
        );
    }

    let mut metadata = JsonValue::Object(metadata_map);
    let snapshot = process_credit_refill(
        transaction,
        project_id,
        org_id,
        runtime_id,
        delta_to_limit,
        None,
        AUTO_REFILL_DAILY_REASON,
        None,
        &mut metadata,
    )
    .await?;

    Ok(Some(AutoRefillOutcome {
        delta: delta_to_limit,
        snapshot,
    }))
}

async fn daily_window_allows(
    transaction: &Transaction<'_>,
    org_id: &Uuid,
    now: DateTime<Utc>,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let last_refill = transaction
        .query_opt(
            "select created_at from org_credit_ledger where org_id = $1 and reason = $2 order by created_at desc limit 1",
            &[org_id, &AUTO_REFILL_DAILY_REASON],
        )
        .await
        .map_err(|error| internal_error(format!("failed to query last daily refill: {error}")))?;

    if let Some(row) = last_refill {
        let created_at: DateTime<Utc> = row.get("created_at");
        if created_at.date_naive() == now.date_naive() {
            return Ok(false);
        }
    }

    Ok(true)
}

pub(crate) async fn get_credit_snapshot<C>(
    client: &C,
    org_id: &Uuid,
) -> Result<CreditSnapshotData, (StatusCode, Json<ApiError>)>
where
    C: GenericClient,
{
    let balance_row = client
        .query_opt(
            "select balance, credit_limit from org_credit_balances where org_id = $1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credit balance: {error}")))?;

    let (balance, credit_limit) = balance_row
        .map(|row| {
            (
                row.get::<_, i32>("balance"),
                row.get::<_, i32>("credit_limit"),
            )
        })
        .unwrap_or((0, 0));

    let last_burn_at = client
        .query_opt(
            "select created_at from org_credit_ledger where org_id = $1 and delta < 0 order by created_at desc limit 1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load last burn entry: {error}")))?
        .map(|row| row.get::<_, DateTime<Utc>>("created_at"));

    let last_refill_at = client
        .query_opt(
            "select created_at from org_credit_ledger where org_id = $1 and delta > 0 order by created_at desc limit 1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load last refill entry: {error}")))?
        .map(|row| row.get::<_, DateTime<Utc>>("created_at"));

    Ok(CreditSnapshotData {
        balance,
        credit_limit,
        last_burn_at,
        last_refill_at,
    })
}

fn credit_snapshot_to_proto(data: CreditSnapshotData) -> CreditSnapshot {
    CreditSnapshot {
        balance: data.balance,
        credit_limit: data.credit_limit,
        last_burn_at: data.last_burn_at.map(datetime_to_timestamp),
        last_refill_at: data.last_refill_at.map(datetime_to_timestamp),
    }
}

fn datetime_to_timestamp(value: DateTime<Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: value.timestamp(),
        nanos: value.timestamp_subsec_nanos() as i32,
    }
}

pub(crate) struct CreditSnapshotData {
    pub(crate) balance: i32,
    pub(crate) credit_limit: i32,
    pub(crate) last_burn_at: Option<DateTime<Utc>>,
    pub(crate) last_refill_at: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::task::JoinHandle;
    use tokio_postgres::NoTls;

    #[test]
    fn free_plan_hosted_runtime_burn_amount_targets_two_hours() {
        assert_eq!(free_plan_hosted_runtime_burn_amount(480), 13);
        assert_eq!(free_plan_hosted_runtime_burn_amount(600), 16);
    }

    #[test]
    fn free_plan_hosted_runtime_burn_amount_caps_single_bucket_intervals() {
        // When the billing interval exceeds the 2h target window, cap the burn amount to the
        // daily credit allowance so a single bucket doesn't immediately exhaust credits.
        assert_eq!(free_plan_hosted_runtime_burn_amount(7200), 200);
        assert_eq!(free_plan_hosted_runtime_burn_amount(10_000), 200);
    }

    fn credit_error(context: &str, error: (StatusCode, axum::Json<ApiError>)) -> anyhow::Error {
        let (status, axum::Json(body)) = error;
        anyhow::anyhow!(
            "{context} failed with status {} and message {}",
            status.as_u16(),
            body.message
        )
    }

    async fn connect_test_db() -> anyhow::Result<Option<(tokio_postgres::Client, JoinHandle<()>)>> {
        let url = match std::env::var("TEST_DATABASE_URL") {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };

        let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
        let handle = tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("[runtime-controller credits tests] connection error: {error}");
            }
        });

        client
            .batch_execute("SET search_path TO pg_temp, public;")
            .await?;

        Ok(Some((client, handle)))
    }

    async fn create_credit_tables(client: &tokio_postgres::Client) -> anyhow::Result<()> {
        client
            .batch_execute(
                "CREATE EXTENSION IF NOT EXISTS pgcrypto;
	                CREATE TEMP TABLE org_credit_balances (
	                    org_id uuid PRIMARY KEY,
	                    balance int NOT NULL DEFAULT 0,
	                    credit_limit int NOT NULL DEFAULT 0,
	                    on_hold int NOT NULL DEFAULT 0,
	                    updated_at timestamptz NOT NULL DEFAULT now()
	                );
	                CREATE TEMP TABLE org_credit_ledger (
	                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	                    org_id uuid NOT NULL,
	                    project_id uuid,
	                    delta int NOT NULL,
	                    reason text NOT NULL,
	                    balance_after int NOT NULL,
	                    metadata jsonb,
	                    created_at timestamptz NOT NULL DEFAULT now(),
	                    created_by uuid,
	                    idempotency_key text
	                );
	                CREATE UNIQUE INDEX org_credit_ledger_idempotency_unique
	                    ON org_credit_ledger(org_id, project_id, idempotency_key)
	                    WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
	                CREATE OR REPLACE FUNCTION pg_temp.org_credit_ledger_before_insert()
	                RETURNS trigger AS $$
	                DECLARE
	                    current_balance int;
	                BEGIN
                    INSERT INTO org_credit_balances(org_id)
                    VALUES (NEW.org_id)
                    ON CONFLICT (org_id) DO NOTHING;

                    SELECT balance INTO current_balance
                    FROM org_credit_balances
                    WHERE org_id = NEW.org_id
                    FOR UPDATE;

                    current_balance := coalesce(current_balance, 0) + NEW.delta;

                    IF current_balance < 0 THEN
                        RAISE EXCEPTION 'Insufficient credits for org %', NEW.org_id;
                    END IF;

                    UPDATE org_credit_balances
                    SET balance = current_balance,
                        updated_at = now()
                    WHERE org_id = NEW.org_id;

                    NEW.balance_after := current_balance;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;

                CREATE TRIGGER org_credit_ledger_balance_guard
                BEFORE INSERT ON org_credit_ledger
                FOR EACH ROW
                EXECUTE FUNCTION pg_temp.org_credit_ledger_before_insert();",
            )
            .await?;

        Ok(())
    }

    #[tokio::test]
    async fn burn_triggers_daily_auto_refill() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credits auto-refill test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let project_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        client
            .execute(
                "INSERT INTO org_credit_balances (org_id, credit_limit) VALUES ($1, $2)",
                &[&org_id, &50],
            )
            .await?;

        let runtime_id = Uuid::new_v4();
        let mut metadata = JsonValue::Object(JsonMap::new());
        let transaction = client.transaction().await?;

        let snapshot = process_credit_burn(
            &transaction,
            &project_id,
            &org_id,
            Some(runtime_id),
            10,
            "burn",
            None,
            &mut metadata,
        )
        .await
        .map_err(|error| credit_error("initial burn", error))?;

        assert_eq!(snapshot.balance, 40);
        transaction.commit().await?;

        if let JsonValue::Object(map) = &metadata {
            assert_eq!(map.get("autoRefillApplied"), Some(&JsonValue::Bool(true)));
            assert_eq!(
                map.get("autoRefillWindow"),
                Some(&JsonValue::String("daily".to_string()))
            );
        } else {
            panic!("metadata should remain an object");
        }

        let rows = client
            .query(
                "SELECT delta, reason FROM org_credit_ledger ORDER BY created_at",
                &[],
            )
            .await?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<_, i32>("delta"), 50);
        assert_eq!(rows[0].get::<_, String>("reason"), "auto_refill_daily");
        assert_eq!(rows[1].get::<_, i32>("delta"), -10);
        assert_eq!(rows[1].get::<_, String>("reason"), "burn");

        connection_handle.abort();

        Ok(())
    }

    #[tokio::test]
    async fn burn_refills_only_once_per_day() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credits window cadence test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let project_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        client
            .execute(
                "INSERT INTO org_credit_balances (org_id, credit_limit) VALUES ($1, $2)",
                &[&org_id, &100],
            )
            .await?;

        // First burn triggers the daily refill.
        let mut first_metadata = JsonValue::Object(JsonMap::new());
        let tx1 = client.transaction().await?;
        let snapshot1 = process_credit_burn(
            &tx1,
            &project_id,
            &org_id,
            None,
            60,
            "first",
            None,
            &mut first_metadata,
        )
        .await
        .map_err(|error| credit_error("first burn", error))?;
        assert_eq!(snapshot1.balance, 40);
        tx1.commit().await?;

        // Second burn should fail because the daily window has already been consumed.
        let mut second_metadata = JsonValue::Object(JsonMap::new());
        let tx2 = client.transaction().await?;
        let burn_result = process_credit_burn(
            &tx2,
            &project_id,
            &org_id,
            None,
            80,
            "second",
            None,
            &mut second_metadata,
        )
        .await;
        drop(tx2);

        match burn_result {
            Ok(snapshot) => panic!(
                "expected burn to fail once daily refill is exhausted but balance was {}",
                snapshot.balance
            ),
            Err(error) => {
                assert_eq!(error.0, StatusCode::BAD_REQUEST);
                assert_eq!(
                    error.1 .0.message,
                    "insufficient credits available for requested burn"
                );
            }
        }

        let rows = client
            .query(
                "SELECT count(*)::int as count FROM org_credit_ledger WHERE org_id = $1",
                &[&org_id],
            )
            .await?;
        let count = rows
            .first()
            .and_then(|row| row.try_get::<_, i32>("count").ok())
            .unwrap_or(0);
        assert_eq!(count, 2);

        connection_handle.abort();

        Ok(())
    }

    #[tokio::test]
    async fn burn_dedupes_on_idempotency_key() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credits idempotency test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let project_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        client
	            .execute(
	                "INSERT INTO org_credit_balances (org_id, credit_limit, balance) VALUES ($1, $2, $3)",
	                &[&org_id, &25, &10],
	            )
	            .await?;

        let key = "dedupe-key-1";
        let mut metadata1 = JsonValue::Object(JsonMap::new());
        let tx1 = client.transaction().await?;
        let snapshot1 = process_credit_burn(
            &tx1,
            &project_id,
            &org_id,
            None,
            5,
            "burn",
            Some(key),
            &mut metadata1,
        )
        .await
        .map_err(|error| credit_error("first deduped burn", error))?;
        assert_eq!(snapshot1.balance, 20);
        tx1.commit().await?;

        let mut metadata2 = JsonValue::Object(JsonMap::new());
        let tx2 = client.transaction().await?;
        let snapshot2 = process_credit_burn(
            &tx2,
            &project_id,
            &org_id,
            None,
            5,
            "burn-retry",
            Some(key),
            &mut metadata2,
        )
        .await
        .map_err(|error| credit_error("second deduped burn", error))?;
        assert_eq!(snapshot2.balance, 20);
        tx2.commit().await?;

        let rows = client
	            .query(
	                "SELECT count(*)::int as count FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND idempotency_key = $3",
	                &[&org_id, &project_id, &key],
	            )
	            .await?;
        let count = rows
            .first()
            .and_then(|row| row.try_get::<_, i32>("count").ok())
            .unwrap_or(0);
        assert_eq!(count, 1);

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn refill_dedupes_on_idempotency_key() -> anyhow::Result<()> {
        let Some((mut client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credits refill idempotency test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let project_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        client
	            .execute(
	                "INSERT INTO org_credit_balances (org_id, credit_limit, balance) VALUES ($1, $2, $3)",
	                &[&org_id, &25, &10],
	            )
	            .await?;

        let key = "refill-dedupe-key-1";
        let mut metadata1 = JsonValue::Object(JsonMap::new());
        let tx1 = client.transaction().await?;
        let snapshot1 = process_credit_refill(
            &tx1,
            &project_id,
            &org_id,
            None,
            5,
            None,
            "refill",
            Some(key),
            &mut metadata1,
        )
        .await
        .map_err(|error| credit_error("first deduped refill", error))?;
        assert_eq!(snapshot1.balance, 15);
        tx1.commit().await?;

        let mut metadata2 = JsonValue::Object(JsonMap::new());
        let tx2 = client.transaction().await?;
        let snapshot2 = process_credit_refill(
            &tx2,
            &project_id,
            &org_id,
            None,
            5,
            None,
            "refill-retry",
            Some(key),
            &mut metadata2,
        )
        .await
        .map_err(|error| credit_error("second deduped refill", error))?;
        assert_eq!(snapshot2.balance, 15);
        tx2.commit().await?;

        let rows = client
	            .query(
	                "SELECT count(*)::int as count FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND idempotency_key = $3",
	                &[&org_id, &project_id, &key],
	            )
	            .await?;
        let count = rows
            .first()
            .and_then(|row| row.try_get::<_, i32>("count").ok())
            .unwrap_or(0);
        assert_eq!(count, 1);

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn ledger_helper_returns_entries() -> anyhow::Result<()> {
        let Some((client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credit ledger test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        client
            .execute(
                "INSERT INTO org_credit_ledger (org_id, project_id, delta, reason, metadata) VALUES ($1, $2, 25, 'refill', '{\"planId\": \"pro\"}')",
                &[&org_id, &project_id],
            )
            .await?;
        client
            .execute(
                "INSERT INTO org_credit_ledger (org_id, project_id, delta, reason, metadata) VALUES ($1, $2, -5, 'burn', '{\"runtime\": \"agent\"}')",
                &[&org_id, &project_id],
            )
            .await?;

        let entries = load_credit_ledger_entries(&client, &org_id, 10)
            .await
            .map_err(|error| credit_error("ledger helper", error))?;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].delta, -5);
        assert_eq!(entries[0].reason, "burn");
        assert_eq!(entries[1].delta, 25);

        connection_handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn merge_ledger_metadata_by_idempotency_key_updates_existing_entry() -> anyhow::Result<()>
    {
        let Some((client, connection_handle)) = connect_test_db().await? else {
            eprintln!("skipping credit ledger metadata merge test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        create_credit_tables(&client).await?;

        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let idempotency_key = "managed-ai-prompt:test";
        client
            .execute(
                "INSERT INTO org_credit_balances (org_id, credit_limit, balance) VALUES ($1, $2, $3)",
                &[&org_id, &200_i32, &25_i32],
            )
            .await?;
        client
            .execute(
                "INSERT INTO org_credit_ledger (org_id, project_id, delta, reason, metadata, idempotency_key)
                 VALUES ($1, $2, -3, 'managed_ai_prompt', '{\"source\": \"managed_ai\"}', $3)",
                &[&org_id, &project_id, &idempotency_key],
            )
            .await?;

        let merged = merge_credit_ledger_metadata_by_idempotency_key(
            &client,
            &org_id,
            &project_id,
            idempotency_key,
            &json!({
                "category": "ai_usage",
                "provider": "openai",
                "usage": {
                    "input_tokens": 1200,
                    "cached_input_tokens": 0,
                    "output_tokens": 240,
                }
            }),
        )
        .await
        .map_err(|error| credit_error("merge credit ledger metadata", error))?;

        assert!(merged);

        let row = client
            .query_one(
                "SELECT metadata FROM org_credit_ledger WHERE org_id = $1 AND project_id = $2 AND idempotency_key = $3",
                &[&org_id, &project_id, &idempotency_key],
            )
            .await?;
        let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
        assert_eq!(
            metadata.get("source"),
            Some(&JsonValue::String("managed_ai".to_string()))
        );
        assert_eq!(
            metadata.get("category"),
            Some(&JsonValue::String("ai_usage".to_string()))
        );
        assert_eq!(
            metadata.get("provider"),
            Some(&JsonValue::String("openai".to_string()))
        );
        assert_eq!(
            metadata
                .get("usage")
                .and_then(JsonValue::as_object)
                .and_then(|usage| usage.get("output_tokens"))
                .and_then(JsonValue::as_i64),
            Some(240)
        );

        connection_handle.abort();
        Ok(())
    }

    #[test]
    fn managed_ai_charge_uses_token_pricing() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "test-key",
        );
        let charge = calculate_managed_ai_usage_charge(
            &config,
            ManagedAiTokenUsage {
                input_tokens: 1_000,
                cached_input_tokens: 500,
                output_tokens: 250,
            },
        );

        assert_eq!(charge.reserve_units, 1);
        assert_eq!(charge.input_cost_usd_micros, 250);
        assert_eq!(charge.cached_input_cost_usd_micros, 13);
        assert_eq!(charge.output_cost_usd_micros, 500);
        assert_eq!(charge.total_cost_usd_micros, 763);
        assert_eq!(charge.charged_units, 1);
        assert_eq!(charge.adjustment_units, 0);
    }

    #[test]
    fn managed_ai_usage_rate_serializes_provider_attribution() {
        let value = serde_json::to_value(ManagedAiUsageRate {
            reason: "managed_ai_prompt",
            enabled: true,
            label: "Instafy AI".to_string(),
            provider: DEFAULT_MANAGED_AI_PROVIDER_ID,
            credits_per_prompt: 1,
            daily_prompt_limit: 20,
            model_label: "GPT-5.5".to_string(),
            input_usd_micros_per_1k: 250,
            cached_input_usd_micros_per_1k: 25,
            output_usd_micros_per_1k: 2_000,
        })
        .expect("managed AI usage rate should serialize");

        assert_eq!(
            value.get("provider"),
            Some(&json!(DEFAULT_MANAGED_AI_PROVIDER_ID))
        );
        assert_eq!(value.get("modelLabel"), Some(&json!("GPT-5.5")));
    }

    #[test]
    fn managed_ai_burn_metadata_keeps_authoritative_provider_attribution() {
        let mut metadata = JsonMap::new();
        ensure_managed_ai_provider_metadata("managed_ai_prompt", &mut metadata);
        assert_eq!(
            metadata.get("managedAiProvider"),
            Some(&json!(DEFAULT_MANAGED_AI_PROVIDER_ID))
        );

        metadata.insert(
            "managedAiProvider".to_string(),
            JsonValue::String("configured-provider".to_string()),
        );
        ensure_managed_ai_provider_metadata("managed_ai_prompt", &mut metadata);
        assert_eq!(
            metadata.get("managedAiProvider"),
            Some(&json!("configured-provider"))
        );

        let mut unrelated = JsonMap::new();
        ensure_managed_ai_provider_metadata("hosted_runtime", &mut unrelated);
        assert!(!unrelated.contains_key("managedAiProvider"));
    }
}
