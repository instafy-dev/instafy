//! A task's fresh-page allowance, shared by native and controller-dispatched helpers.
//! The controller owns the binding and settings snapshot; tools can only reserve against
//! their exact active job. A row lock serializes reservations across runtimes/controllers.
use crate::{
    active_job_auth::{authorize_active_job, ActiveJobProjectAccess},
    auth::{authenticate_request, RequestContext},
    bad_request, internal_error, unauthorized, ApiError, AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use runtime_contracts::research::{ResearchSettings, RESEARCH_RESERVE_SCOPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use tokio_postgres::{types::Json as PgJson, Transaction};
use uuid::Uuid;

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;
const HOST_SPACING_MS: i64 = 2_000;
const MAX_HOPS: usize = 6;
const MAX_LEGACY_ANCESTRY: usize = 128;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/agent/research-budget", get(status).post(reserve))
}

/// Resolve the only possible parent before enqueuing. Untrusted metadata never selects a pool.
pub(crate) async fn dispatch_parent(
    tx: &Transaction<'_>,
    state: &AppState,
    context: &RequestContext,
    metadata: &Value,
) -> ApiResult<Option<Uuid>> {
    if context.scoped_claims.is_some() {
        return crate::active_job_auth::authorize_active_job_if_scoped(
            tx,
            state,
            context,
            ActiveJobProjectAccess::Read,
        )
        .await
        .map(|job| job.map(|job| job.job_id));
    }
    if !context.is_service_role {
        return Ok(None);
    }
    Ok(metadata
        .get("multiAgentPlan")
        .or_else(|| metadata.get("multi_agent_plan"))
        .and_then(|plan| {
            plan.get("parentJobId")
                .or_else(|| plan.get("parent_job_id"))
        })
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok()))
}

/// New jobs have one immutable binding. Legacy jobs inherit through their stored hierarchy,
/// so a rolling deployment cannot multiply an already-live parent's allowance.
pub(crate) async fn bind_job(
    tx: &Transaction<'_>,
    project_id: Uuid,
    job_id: Uuid,
    parent: Option<Uuid>,
) -> ApiResult<Uuid> {
    let source = parent.unwrap_or(job_id);
    let budget = ensure_binding(tx, project_id, source).await?;
    if source != job_id {
        if tx
            .query_opt(
                "select 1 from agent_jobs where id=$1 and project_id=$2",
                &[&job_id, &project_id],
            )
            .await
            .map_err(|e| internal_error(format!("validate research child: {e}")))?
            .is_none()
        {
            return Err(bad_request("Research child must belong to this project"));
        }
        bind_to_budget(tx, job_id, budget).await?;
    }
    Ok(budget)
}
async fn ensure_binding(tx: &Transaction<'_>, project_id: Uuid, job_id: Uuid) -> ApiResult<Uuid> {
    if let (_, Some(budget)) = load_job_binding(tx, project_id, job_id).await? {
        return Ok(budget);
    }
    // Only lazy creation needs this project lock. Siblings can arrive through different
    // runtimes, so locking just the requested job would let them create separate pools.
    // Already-bound jobs go straight to their own budget's reservation row lock.
    tx.query_one(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&format!("research-bindings:{project_id}")],
    )
    .await
    .map_err(|e| internal_error(format!("lock research bindings: {e}")))?;
    let mut unbound = Vec::new();
    let mut visited = BTreeSet::new();
    let mut current = job_id;
    let budget = loop {
        if !visited.insert(current) || visited.len() > MAX_LEGACY_ANCESTRY {
            return Err(bad_request("Research job ancestry is cyclic or too deep"));
        }
        // Re-read after taking the lock: a sibling may have bound the common ancestor.
        // Only the controller's stored parent column participates, never payload metadata.
        let (parent, existing) = load_job_binding(tx, project_id, current).await?;
        if let Some(budget) = existing {
            break budget;
        }
        unbound.push(current);
        if let Some(parent) = parent {
            current = parent;
            continue;
        }
        let settings = crate::research_settings::load(tx, &project_id).await?;
        let budget = Uuid::new_v4();
        tx.execute(
            "insert into agent_research_budgets(id,project_id,settings) values($1,$2,$3)",
            &[&budget, &project_id, &PgJson(settings)],
        )
        .await
        .map_err(|e| internal_error(format!("create research budget: {e}")))?;
        break budget;
    };
    for id in unbound.into_iter().rev() {
        bind_to_budget(tx, id, budget).await?;
    }
    Ok(budget)
}

async fn load_job_binding(
    tx: &Transaction<'_>,
    project_id: Uuid,
    job_id: Uuid,
) -> ApiResult<(Option<Uuid>, Option<Uuid>)> {
    let row = tx
        .query_opt(
            "select j.parent_job_id, binding.budget_id, b.project_id as budget_project_id
             from agent_jobs j
             left join agent_job_research_budgets binding on binding.job_id=j.id
             left join agent_research_budgets b on b.id=binding.budget_id
             where j.id=$1 and j.project_id=$2",
            &[&job_id, &project_id],
        )
        .await
        .map_err(|e| internal_error(format!("validate research job: {e}")))?
        .ok_or_else(|| bad_request("Research parent must belong to this project"))?;
    let budget: Option<Uuid> = row.get("budget_id");
    if budget.is_some() && row.get::<_, Option<Uuid>>("budget_project_id") != Some(project_id) {
        return Err(bad_request("Research budget must belong to this project"));
    }
    Ok((row.get("parent_job_id"), budget))
}

async fn bind_to_budget(tx: &Transaction<'_>, job_id: Uuid, budget: Uuid) -> ApiResult<()> {
    tx.execute(
        "insert into agent_job_research_budgets(job_id,budget_id) values($1,$2)
         on conflict(job_id) do nothing",
        &[&job_id, &budget],
    )
    .await
    .map_err(|e| internal_error(format!("bind research budget: {e}")))?;
    let actual: Uuid = tx
        .query_one(
            "select budget_id from agent_job_research_budgets where job_id=$1",
            &[&job_id],
        )
        .await
        .map_err(|e| internal_error(format!("verify research binding: {e}")))?
        .get(0);
    if actual != budget {
        return Err(bad_request("A research job cannot change its task budget"));
    }
    Ok(())
}
pub(crate) async fn job_settings(
    tx: &Transaction<'_>,
    project_id: Uuid,
    job_id: Uuid,
) -> ApiResult<ResearchSettings> {
    let id = ensure_binding(tx, project_id, job_id).await?;
    let row = tx
        .query_one(
            "select settings from agent_research_budgets where id=$1",
            &[&id],
        )
        .await
        .map_err(|e| internal_error(format!("read research budget settings: {e}")))?;
    serde_json::from_value(row.get("settings"))
        .map_err(|e| internal_error(format!("invalid research settings: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reservation {
    load_id: Uuid,
    request_id: Uuid,
    host: String,
    remaining_ms: u64,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BudgetState {
    loads: BTreeMap<Uuid, Load>,
    hosts: BTreeMap<String, Host>,
    grants: BTreeMap<Uuid, Grant>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
struct Load {
    hosts: BTreeSet<String>,
    hops: usize,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    loads: u32,
    last_at: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    load_id: Uuid,
    host: String,
    at: i64,
}

fn canonical_host(host: &str) -> ApiResult<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host.is_empty() || host.len() > 253 {
        return Err(bad_request("host must be a valid hostname"));
    }
    let parsed =
        url::Host::parse(host).map_err(|_| bad_request("host must be a valid hostname"))?;
    let normalized = parsed.to_string();
    if normalized.contains(['/', '@', '?', '#']) {
        return Err(bad_request("host must be a valid hostname"));
    }
    Ok(normalized)
}
impl BudgetState {
    fn snapshot(&self, settings: ResearchSettings) -> Value {
        json!({"scope":"this task","loadsUsed":self.loads.len(),"loadsLeft":settings.max_page_loads.saturating_sub(self.loads.len() as u32),"loadsPerTurn":settings.max_page_loads,"loadsPerHost":settings.max_page_loads_per_site,"hostSpacingSeconds":2,"hosts":self.hosts})
    }
    fn response(
        &self,
        settings: ResearchSettings,
        allowed: bool,
        code: Option<&str>,
        wait: i64,
    ) -> Value {
        let mut value =
            json!({"allowed":allowed,"waitMs":wait.max(0),"budget":self.snapshot(settings)});
        if let Some(code) = code {
            value["code"] = json!(code);
        }
        value
    }
    fn reserve(
        &mut self,
        settings: ResearchSettings,
        request: &Reservation,
        now: i64,
    ) -> ApiResult<Value> {
        if request.remaining_ms > 600_000 {
            return Err(bad_request("remainingMs must be at most 600000"));
        }
        let host = canonical_host(&request.host)?;
        if let Some(grant) = self.grants.get(&request.request_id) {
            if grant.load_id != request.load_id || grant.host != host {
                return Err(bad_request(
                    "requestId already belongs to a different reservation",
                ));
            }
            // A lost response may be retried after its reserved start. Rebook
            // behind later reservations instead of starting beside another helper.
            let at = if grant.at < now {
                self.hosts
                    .get(&host)
                    .filter(|site| site.last_at > grant.at)
                    .map_or(now, |site| (site.last_at + HOST_SPACING_MS).max(now))
            } else {
                grant.at
            };
            let wait = (at - now).max(0);
            if wait >= request.remaining_ms as i64 {
                return Ok(self.response(settings, false, Some("time_limit"), wait));
            }
            if at != grant.at {
                self.grants
                    .get_mut(&request.request_id)
                    .expect("existing grant")
                    .at = at;
                self.hosts.get_mut(&host).expect("granted host").last_at = at;
            }
            return Ok(self.response(settings, true, None, wait));
        }
        let load = self.loads.get(&request.load_id);
        if load.is_some_and(|load| load.hops >= MAX_HOPS) {
            return Err(bad_request(
                "A page load may reserve at most six redirect hops",
            ));
        }
        if load.is_none() && self.loads.len() >= settings.max_page_loads as usize {
            return Ok(self.response(settings, false, Some("turn_limit"), 0));
        }
        let new_host = load.is_none_or(|load| !load.hosts.contains(&host));
        let site = self.hosts.get(&host);
        if new_host && site.is_some_and(|site| site.loads >= settings.max_page_loads_per_site) {
            return Ok(self.response(settings, false, Some("host_limit"), 0));
        }
        let at = site.map_or(now, |site| (site.last_at + HOST_SPACING_MS).max(now));
        let wait = at - now;
        if wait >= request.remaining_ms as i64 {
            return Ok(self.response(settings, false, Some("time_limit"), wait));
        }
        let load = self.loads.entry(request.load_id).or_default();
        load.hosts.insert(host.clone());
        load.hops += 1;
        let site = self.hosts.entry(host.clone()).or_default();
        if new_host {
            site.loads += 1;
        }
        site.last_at = at;
        self.grants.insert(
            request.request_id,
            Grant {
                load_id: request.load_id,
                host,
                at,
            },
        );
        Ok(self.response(settings, true, None, wait))
    }
}
async fn operate(
    state: &AppState,
    headers: HeaderMap,
    request: Option<Reservation>,
) -> ApiResult<Json<Value>> {
    let context = authenticate_request(&state.config, &headers).await?;
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("A live research job credential is required"))?;
    let mut db = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("research budget connection: {e}")))?;
    let tx = db
        .transaction()
        .await
        .map_err(|e| internal_error(format!("research budget transaction: {e}")))?;
    let job = authorize_active_job(
        &tx,
        state,
        claims,
        RESEARCH_RESERVE_SCOPE,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    let budget = ensure_binding(&tx, job.project_id, job.job_id).await?;
    let row=tx.query_one("select settings,state,floor(extract(epoch from clock_timestamp())*1000)::bigint as now_ms from agent_research_budgets where id=$1 for update", &[&budget]).await.map_err(|e|internal_error(format!("lock research budget: {e}")))?;
    let settings: ResearchSettings = serde_json::from_value(row.get("settings"))
        .map_err(|e| internal_error(format!("invalid research budget settings: {e}")))?;
    let mut saved: BudgetState = serde_json::from_value(row.get("state"))
        .map_err(|e| internal_error(format!("invalid research budget state: {e}")))?;
    let result = if let Some(request) = request {
        let response = saved.reserve(settings, &request, row.get("now_ms"))?;
        tx.execute(
            "update agent_research_budgets set state=$2 where id=$1",
            &[&budget, &PgJson(saved)],
        )
        .await
        .map_err(|e| internal_error(format!("save research reservation: {e}")))?;
        response
    } else {
        json!({"budget":saved.snapshot(settings)})
    };
    tx.commit()
        .await
        .map_err(|e| internal_error(format!("commit research budget: {e}")))?;
    Ok(Json(result))
}
async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    operate(&state, headers, None).await
}
async fn reserve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<Reservation>,
) -> ApiResult<Json<Value>> {
    operate(&state, headers, Some(request)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(load_id: Uuid, host: &str) -> Reservation {
        Reservation {
            load_id,
            request_id: Uuid::new_v4(),
            host: host.into(),
            remaining_ms: 60_000,
        }
    }
    #[test]
    fn research_redirects_share_total_and_count_each_site_once_with_pacing() {
        let mut state = BudgetState::default();
        let settings = ResearchSettings {
            max_page_loads: 2,
            max_page_loads_per_site: 1,
        };
        let id = Uuid::new_v4();
        let first = request(id, "WWW.Example.com.");
        assert_eq!(state.reserve(settings, &first, 10000).unwrap()["waitMs"], 0);
        assert_eq!(
            state.reserve(settings, &first, 10001).unwrap()["budget"]["loadsUsed"],
            1
        );
        let second = request(id, "example.com");
        assert_eq!(
            state.reserve(settings, &second, 10001).unwrap()["waitMs"],
            2000
        );
        assert_eq!(
            state
                .reserve(settings, &request(id, "other.example"), 10002)
                .unwrap()["budget"]["loadsUsed"],
            1
        );
        assert_eq!(state.hosts["example.com"].loads, 1);
        assert_eq!(
            state
                .reserve(settings, &request(Uuid::new_v4(), "example.com"), 10003)
                .unwrap()["code"],
            "host_limit"
        );
        assert_eq!(
            state
                .reserve(settings, &request(Uuid::new_v4(), "third.example"), 10003)
                .unwrap()["allowed"],
            true
        );
        assert_eq!(
            state
                .reserve(settings, &request(Uuid::new_v4(), "fourth.example"), 10003)
                .unwrap()["code"],
            "turn_limit"
        );
    }
    #[test]
    fn research_exhausted_time_does_not_charge_and_reservations_cannot_be_rebound() {
        let mut state = BudgetState::default();
        let settings = ResearchSettings::default();
        let first = request(Uuid::new_v4(), "example.com");
        state.reserve(settings, &first, 10000).unwrap();
        let mut next = request(Uuid::new_v4(), "example.com");
        next.remaining_ms = 500;
        assert_eq!(
            state.reserve(settings, &next, 10000).unwrap()["code"],
            "time_limit"
        );
        assert_eq!(state.loads.len(), 1);
        next.request_id = first.request_id;
        assert!(state.reserve(settings, &next, 10000).is_err());
        for _ in 1..MAX_HOPS {
            state
                .reserve(settings, &request(first.load_id, "example.com"), 10000)
                .unwrap();
        }
        assert!(state
            .reserve(settings, &request(first.load_id, "example.com"), 10000)
            .is_err());
    }
    #[test]
    fn research_lost_response_retry_rebooks_behind_helpers_without_spending_twice() {
        let mut state = BudgetState::default();
        let settings = ResearchSettings::default();
        let mut first = request(Uuid::new_v4(), "example.com");
        let second = request(Uuid::new_v4(), "example.com");
        state.reserve(settings, &first, 10000).unwrap();
        assert_eq!(
            state.reserve(settings, &second, 10000).unwrap()["waitMs"],
            2000
        );
        first.remaining_ms = 2000;
        assert_eq!(
            state.reserve(settings, &first, 11900).unwrap()["code"],
            "time_limit"
        );
        assert_eq!(state.hosts["example.com"].last_at, 12000);
        first.remaining_ms = 60000;
        assert_eq!(
            state.reserve(settings, &first, 11900).unwrap()["waitMs"],
            2100
        );
        assert_eq!(
            state.reserve(settings, &first, 11901).unwrap()["waitMs"],
            2099
        );
        assert_eq!(state.loads.len(), 2);
        assert_eq!(state.loads[&first.load_id].hops, 1);
        assert_eq!(state.hosts["example.com"].loads, 2);
    }
}
