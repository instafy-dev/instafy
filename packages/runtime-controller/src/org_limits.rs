use axum::http::StatusCode;
use axum::Json;
use tokio_postgres::GenericClient;
use uuid::Uuid;

use crate::{internal_error, ApiError};

pub(crate) const ORG_RESOURCE_LIMIT_MAX: i64 = 100_000;
// Guards against zero/negative lockouts only. 1 is a legitimate business
// value: the starter plan's credit budget funds exactly one hosted machine.
pub(crate) const ORG_RESOURCE_LIMIT_MIN_HOSTED_RUNTIMES: i64 = 1;

#[derive(Clone, Debug, Default)]
pub(crate) struct OrgResourceLimitOverrides {
    pub(crate) max_active_tunnels: Option<i64>,
    pub(crate) max_active_hosted_runtimes: Option<i64>,
}

#[derive(Clone, Debug)]
pub(crate) struct OrgSubscriptionSnapshot {
    pub(crate) plan_id: String,
    pub(crate) status: String,
    pub(crate) processor: String,
}

#[derive(Clone, Debug)]
pub(crate) struct OrgResourceLimitDefaults {
    pub(crate) max_active_tunnels: i64,
    pub(crate) max_active_hosted_runtimes: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct OrgResourceLimits {
    pub(crate) subscription: OrgSubscriptionSnapshot,
    pub(crate) defaults: OrgResourceLimitDefaults,
    pub(crate) overrides: OrgResourceLimitOverrides,
    pub(crate) max_active_tunnels: i64,
    pub(crate) max_active_hosted_runtimes: i64,
}

pub(crate) fn normalize_subscription_plan_for_limits(plan_id: &str, status: &str) -> String {
    let plan = plan_id.trim().to_ascii_lowercase();
    let status = status.trim().to_ascii_lowercase();
    let paid_status = matches!(status.as_str(), "trialing" | "active");
    if !paid_status {
        return "starter".to_string();
    }
    if plan.is_empty() {
        return "starter".to_string();
    }
    plan
}

pub(crate) fn resolve_limit(override_value: Option<i64>, default_value: i64) -> i64 {
    let raw = override_value.unwrap_or(default_value);
    raw.clamp(0, ORG_RESOURCE_LIMIT_MAX)
}

pub(crate) fn resolve_hosted_runtime_limit(override_value: Option<i64>, default_value: i64) -> i64 {
    let resolved = resolve_limit(override_value, default_value);
    resolved.max(ORG_RESOURCE_LIMIT_MIN_HOSTED_RUNTIMES)
}

pub(crate) async fn load_org_subscription_snapshot(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<OrgSubscriptionSnapshot, (StatusCode, Json<ApiError>)> {
    let savepoint_created = client
        .execute("savepoint load_org_subscription_snapshot", &[])
        .await
        .is_ok();

    let row = match client
        .query_opt(
            "select billing_cycle, status, processor
             from org_subscriptions
             where org_id = $1
             order by updated_at desc
             limit 1",
            &[org_id],
        )
        .await
    {
        Ok(row) => row,
        Err(_) => {
            if savepoint_created {
                let _ = client
                    .execute("rollback to savepoint load_org_subscription_snapshot", &[])
                    .await;
                let _ = client
                    .execute("release savepoint load_org_subscription_snapshot", &[])
                    .await;
            }
            return Ok(OrgSubscriptionSnapshot {
                plan_id: "starter".to_string(),
                status: "none".to_string(),
                processor: "dev".to_string(),
            });
        }
    };

    let Some(row) = row else {
        if savepoint_created {
            let _ = client
                .execute("release savepoint load_org_subscription_snapshot", &[])
                .await;
        }
        return Ok(OrgSubscriptionSnapshot {
            plan_id: "starter".to_string(),
            status: "none".to_string(),
            processor: "dev".to_string(),
        });
    };

    if savepoint_created {
        let _ = client
            .execute("release savepoint load_org_subscription_snapshot", &[])
            .await;
    }

    Ok(OrgSubscriptionSnapshot {
        plan_id: row.get::<_, String>("billing_cycle"),
        status: row.get::<_, String>("status"),
        processor: row.get::<_, String>("processor"),
    })
}

pub(crate) async fn load_org_resource_limit_overrides(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<OrgResourceLimitOverrides, (StatusCode, Json<ApiError>)> {
    let savepoint_created = client
        .execute("savepoint load_org_resource_limit_overrides", &[])
        .await
        .is_ok();

    let row = match client
        .query_opt(
            "select max_active_tunnels, max_active_hosted_runtimes
             from org_resource_limits
             where org_id = $1
             limit 1",
            &[org_id],
        )
        .await
    {
        Ok(row) => row,
        Err(_) => {
            if savepoint_created {
                let _ = client
                    .execute(
                        "rollback to savepoint load_org_resource_limit_overrides",
                        &[],
                    )
                    .await;
                let _ = client
                    .execute("release savepoint load_org_resource_limit_overrides", &[])
                    .await;
            }
            return Ok(OrgResourceLimitOverrides::default());
        }
    };

    let Some(row) = row else {
        if savepoint_created {
            let _ = client
                .execute("release savepoint load_org_resource_limit_overrides", &[])
                .await;
        }
        return Ok(OrgResourceLimitOverrides::default());
    };

    if savepoint_created {
        let _ = client
            .execute("release savepoint load_org_resource_limit_overrides", &[])
            .await;
    }

    Ok(OrgResourceLimitOverrides {
        max_active_tunnels: row.get::<_, Option<i64>>("max_active_tunnels"),
        max_active_hosted_runtimes: row.get::<_, Option<i64>>("max_active_hosted_runtimes"),
    })
}

pub(crate) async fn resolve_org_resource_limits(
    client: &impl GenericClient,
    org_id: &Uuid,
) -> Result<OrgResourceLimits, (StatusCode, Json<ApiError>)> {
    let subscription = load_org_subscription_snapshot(client, org_id).await?;
    let overrides = load_org_resource_limit_overrides(client, org_id).await?;

    let plan_id_for_limits =
        normalize_subscription_plan_for_limits(&subscription.plan_id, &subscription.status);
    let plan = crate::billing::plans::load_plan(client, &plan_id_for_limits)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            internal_error(format!(
                "billing plan '{plan_id_for_limits}' is not configured"
            ))
        })?;
    let defaults = OrgResourceLimitDefaults {
        max_active_tunnels: plan.max_active_tunnels,
        max_active_hosted_runtimes: plan.max_active_hosted_runtimes,
    };

    Ok(OrgResourceLimits {
        subscription,
        max_active_tunnels: resolve_limit(
            overrides.max_active_tunnels,
            defaults.max_active_tunnels,
        ),
        max_active_hosted_runtimes: resolve_hosted_runtime_limit(
            overrides.max_active_hosted_runtimes,
            defaults.max_active_hosted_runtimes,
        ),
        defaults,
        overrides,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_limits_plan_on_non_paid_status() {
        assert_eq!(
            normalize_subscription_plan_for_limits("pro", "past_due"),
            "starter"
        );
        assert_eq!(
            normalize_subscription_plan_for_limits("scale", "canceled"),
            "starter"
        );
        assert_eq!(
            normalize_subscription_plan_for_limits("starter", "none"),
            "starter"
        );
    }

    #[test]
    fn normalizes_limits_plan_on_paid_status() {
        assert_eq!(
            normalize_subscription_plan_for_limits("pro", "active"),
            "pro"
        );
        assert_eq!(
            normalize_subscription_plan_for_limits("scale", "trialing"),
            "scale"
        );
        assert_eq!(
            normalize_subscription_plan_for_limits("unknown", "active"),
            "unknown"
        );
    }

    #[test]
    fn resolves_limit_uses_override_when_present() {
        assert_eq!(resolve_limit(Some(50), 3), 50);
        assert_eq!(resolve_limit(Some(0), 3), 0);
        assert_eq!(resolve_limit(None, 3), 3);
    }

    #[test]
    fn resolves_limit_clamps_to_max() {
        assert_eq!(
            resolve_limit(Some(ORG_RESOURCE_LIMIT_MAX + 1), 3),
            ORG_RESOURCE_LIMIT_MAX
        );
        assert_eq!(resolve_limit(Some(-5), 3), 0);
    }

    #[test]
    fn resolves_hosted_runtime_limit_enforces_minimum_floor() {
        assert_eq!(
            resolve_hosted_runtime_limit(None, 1),
            ORG_RESOURCE_LIMIT_MIN_HOSTED_RUNTIMES
        );
        assert_eq!(
            resolve_hosted_runtime_limit(Some(1), 10),
            ORG_RESOURCE_LIMIT_MIN_HOSTED_RUNTIMES
        );
        assert_eq!(resolve_hosted_runtime_limit(Some(3), 10), 3);
    }
}
