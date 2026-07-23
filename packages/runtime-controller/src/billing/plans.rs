use tokio_postgres::GenericClient;

const STARTER_PLAN_CREDIT_LIMIT: i32 = 200;
const PRO_PLAN_CREDIT_LIMIT: i32 = 2_000;
const SCALE_PLAN_CREDIT_LIMIT: i32 = 10_000;

fn fallback_plan(plan_id: &str) -> Option<BillingPlan> {
    match plan_id.trim().to_ascii_lowercase().as_str() {
        "starter" => Some(BillingPlan {
            id: "starter".to_string(),
            name: "Starter".to_string(),
            currency: "usd".to_string(),
            monthly_price_cents: 0,
            credit_limit: STARTER_PLAN_CREDIT_LIMIT,
            max_active_tunnels: 3,
            max_active_hosted_runtimes: 1,
            active: true,
        }),
        "pro" => Some(BillingPlan {
            id: "pro".to_string(),
            name: "Pro".to_string(),
            currency: "usd".to_string(),
            monthly_price_cents: 1_000,
            credit_limit: PRO_PLAN_CREDIT_LIMIT,
            max_active_tunnels: 10,
            max_active_hosted_runtimes: 3,
            active: true,
        }),
        "scale" => Some(BillingPlan {
            id: "scale".to_string(),
            name: "Scale".to_string(),
            currency: "usd".to_string(),
            monthly_price_cents: 10_000,
            credit_limit: SCALE_PLAN_CREDIT_LIMIT,
            max_active_tunnels: 25,
            max_active_hosted_runtimes: 8,
            active: true,
        }),
        _ => None,
    }
}

fn fallback_active_plans() -> Vec<BillingPlan> {
    ["starter", "pro", "scale"]
        .into_iter()
        .filter_map(fallback_plan)
        .collect()
}

#[derive(Clone, Debug)]
pub(crate) struct BillingPlan {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) currency: String,
    pub(crate) monthly_price_cents: i32,
    pub(crate) credit_limit: i32,
    pub(crate) max_active_tunnels: i64,
    pub(crate) max_active_hosted_runtimes: i64,
    pub(crate) active: bool,
}

pub(crate) async fn load_plan(
    client: &impl GenericClient,
    plan_id: &str,
) -> Result<Option<BillingPlan>, String> {
    let normalized = plan_id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }

    let savepoint_created = client.execute("savepoint load_plan", &[]).await.is_ok();
    let row = match client
        .query_opt(
            "select id, name, currency, monthly_price_cents, credit_limit, max_active_tunnels, max_active_hosted_runtimes, active
             from billing_plans
             where id = $1
             limit 1",
            &[&normalized],
        )
        .await
    {
        Ok(row) => row,
        Err(_) => {
            if savepoint_created {
                let _ = client.execute("rollback to savepoint load_plan", &[]).await;
                let _ = client.execute("release savepoint load_plan", &[]).await;
            }
            return Ok(fallback_plan(&normalized));
        }
    };

    let Some(row) = row else {
        if savepoint_created {
            let _ = client.execute("release savepoint load_plan", &[]).await;
        }
        return Ok(fallback_plan(&normalized));
    };

    if savepoint_created {
        let _ = client.execute("release savepoint load_plan", &[]).await;
    }

    Ok(Some(BillingPlan {
        id: row.get("id"),
        name: row.get("name"),
        currency: row.get("currency"),
        monthly_price_cents: row.get("monthly_price_cents"),
        credit_limit: row.get("credit_limit"),
        max_active_tunnels: row.get("max_active_tunnels"),
        max_active_hosted_runtimes: row.get("max_active_hosted_runtimes"),
        active: row.get("active"),
    }))
}

pub(crate) async fn load_active_plan(
    client: &impl GenericClient,
    plan_id: &str,
) -> Result<Option<BillingPlan>, String> {
    let plan = load_plan(client, plan_id).await?;
    Ok(plan.filter(|plan| plan.active))
}

pub(crate) async fn load_active_plans(
    client: &impl GenericClient,
) -> Result<Vec<BillingPlan>, String> {
    let savepoint_created = client
        .execute("savepoint load_active_plans", &[])
        .await
        .is_ok();
    let rows = match client
        .query(
            "select id, name, currency, monthly_price_cents, credit_limit, max_active_tunnels, max_active_hosted_runtimes, active
             from billing_plans
             where active = true
             order by monthly_price_cents asc, id asc",
            &[],
        )
        .await
    {
        Ok(rows) => rows,
        Err(_) => {
            if savepoint_created {
                let _ = client
                    .execute("rollback to savepoint load_active_plans", &[])
                    .await;
                let _ = client.execute("release savepoint load_active_plans", &[]).await;
            }
            return Ok(fallback_active_plans());
        }
    };

    if rows.is_empty() {
        if savepoint_created {
            let _ = client
                .execute("release savepoint load_active_plans", &[])
                .await;
        }
        return Ok(fallback_active_plans());
    }

    if savepoint_created {
        let _ = client
            .execute("release savepoint load_active_plans", &[])
            .await;
    }

    Ok(rows
        .into_iter()
        .map(|row| BillingPlan {
            id: row.get("id"),
            name: row.get("name"),
            currency: row.get("currency"),
            monthly_price_cents: row.get("monthly_price_cents"),
            credit_limit: row.get("credit_limit"),
            max_active_tunnels: row.get("max_active_tunnels"),
            max_active_hosted_runtimes: row.get("max_active_hosted_runtimes"),
            active: row.get("active"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::fallback_plan;

    #[test]
    fn fallback_plan_matches_seeded_catalog_defaults() {
        let starter = fallback_plan("starter").expect("starter plan");
        assert_eq!(starter.monthly_price_cents, 0);
        assert_eq!(starter.credit_limit, 200);
        assert_eq!(starter.max_active_tunnels, 3);
        assert_eq!(starter.max_active_hosted_runtimes, 1);

        let pro = fallback_plan("pro").expect("pro plan");
        assert_eq!(pro.monthly_price_cents, 1_000);
        assert_eq!(pro.credit_limit, 2_000);
        assert_eq!(pro.max_active_tunnels, 10);
        assert_eq!(pro.max_active_hosted_runtimes, 3);

        let scale = fallback_plan("scale").expect("scale plan");
        assert_eq!(scale.monthly_price_cents, 10_000);
        assert_eq!(scale.credit_limit, 10_000);
        assert_eq!(scale.max_active_tunnels, 25);
        assert_eq!(scale.max_active_hosted_runtimes, 8);
    }
}
