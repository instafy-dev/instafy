use crate::{
    auth::authenticate_request,
    bad_request, forbidden, internal_error,
    projects::{ensure_project_read_access, load_project_record},
    ApiError, AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use runtime_contracts::research::{
    ResearchSettings, DEFAULT_MAX_PAGE_LOADS, DEFAULT_MAX_PAGE_LOADS_PER_SITE, MAX_PAGE_LOADS,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use uuid::Uuid;

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/research-settings",
        get(read).patch(update),
    )
}

pub(crate) async fn load(tx: &Transaction<'_>, project_id: &Uuid) -> ApiResult<ResearchSettings> {
    let row = tx.query_opt("select max_page_loads, max_page_loads_per_site from project_research_settings where project_id=$1", &[project_id]).await.map_err(|e| internal_error(format!("load research settings: {e}")))?;
    row.map(|r| ResearchSettings {
        max_page_loads: r.get::<_, i32>(0) as u32,
        max_page_loads_per_site: r.get::<_, i32>(1) as u32,
    })
    .unwrap_or_default()
    .validate()
    .map_err(internal_error)
}

fn response(settings: ResearchSettings, can_manage: bool) -> Value {
    json!({"maxPageLoads": settings.max_page_loads, "maxPageLoadsPerSite": settings.max_page_loads_per_site, "canManage": can_manage,
        "limits": {"maxPageLoads":{"min":1,"max":MAX_PAGE_LOADS,"default":DEFAULT_MAX_PAGE_LOADS}, "maxPageLoadsPerSite":{"min":1,"max":MAX_PAGE_LOADS,"default":DEFAULT_MAX_PAGE_LOADS_PER_SITE}}})
}
async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Shared research settings require a signed-in user",
        ));
    }
    let mut db = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("research settings connection: {e}")))?;
    let tx = db
        .transaction()
        .await
        .map_err(|e| internal_error(format!("research settings transaction: {e}")))?;
    let project = load_project_record(&tx, &project_id).await?;
    let access = ensure_project_read_access(&tx, &project, &context, None).await?;
    Ok(Json(response(
        load(&tx, &project_id).await?,
        access.can_manage,
    )))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    #[serde(default, deserialize_with = "present_integer")]
    max_page_loads: Option<u32>,
    #[serde(default, deserialize_with = "present_integer")]
    max_page_loads_per_site: Option<u32>,
}
fn present_integer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
    u32::deserialize(d).map(Some)
}
impl Patch {
    fn apply(self, current: ResearchSettings) -> ApiResult<ResearchSettings> {
        if self.max_page_loads.is_none() && self.max_page_loads_per_site.is_none() {
            return Err(bad_request("Provide maxPageLoads or maxPageLoadsPerSite"));
        }
        ResearchSettings {
            max_page_loads: self.max_page_loads.unwrap_or(current.max_page_loads),
            max_page_loads_per_site: self
                .max_page_loads_per_site
                .unwrap_or(current.max_page_loads_per_site),
        }
        .validate()
        .map_err(bad_request)
    }
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(patch): Json<Patch>,
) -> ApiResult<Json<Value>> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Runtime tokens cannot change shared research settings",
        ));
    }
    let mut db = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("research settings connection: {e}")))?;
    let tx = db
        .transaction()
        .await
        .map_err(|e| internal_error(format!("research settings transaction: {e}")))?;
    let project = load_project_record(&tx, &project_id).await?;
    let access = ensure_project_read_access(&tx, &project, &context, None).await?;
    if !access.can_manage {
        return Err(forbidden(
            "Only space managers can change shared research settings",
        ));
    }
    tx.query_one(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&format!("research-settings:{project_id}")],
    )
    .await
    .map_err(|e| internal_error(format!("lock research settings: {e}")))?;
    let settings = patch.apply(load(&tx, &project_id).await?)?;
    tx.execute("insert into project_research_settings(project_id,max_page_loads,max_page_loads_per_site,updated_by) values($1,$2,$3,$4) on conflict(project_id) do update set max_page_loads=excluded.max_page_loads,max_page_loads_per_site=excluded.max_page_loads_per_site,updated_by=excluded.updated_by,updated_at=now()", &[&project_id,&(settings.max_page_loads as i32),&(settings.max_page_loads_per_site as i32),&context.user_id]).await.map_err(|e|internal_error(format!("save research settings: {e}")))?;
    tx.commit()
        .await
        .map_err(|e| internal_error(format!("save research settings: {e}")))?;
    Ok(Json(response(settings, true)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn research_partial_updates_preserve_other_limit_and_validate() {
        let patch: Patch = serde_json::from_value(json!({"maxPageLoads":30})).unwrap();
        assert_eq!(
            patch.apply(ResearchSettings::default()).unwrap(),
            ResearchSettings {
                max_page_loads: 30,
                max_page_loads_per_site: 25
            }
        );
        for value in [
            json!({}),
            json!({"maxPageLoads":0}),
            json!({"maxPageLoads":201}),
            json!({"maxPageLoads":3}),
            json!({"maxPageLoadsPerSite":101}),
        ] {
            assert!(serde_json::from_value::<Patch>(value)
                .unwrap()
                .apply(ResearchSettings::default())
                .is_err());
        }
        for value in [
            json!({"maxPageLoads":null}),
            json!({"maxPageLoads":1.5}),
            json!({"maxPageLoads":"20"}),
            json!({"maxPageLoads":20,"scope":"other"}),
        ] {
            assert!(serde_json::from_value::<Patch>(value).is_err());
        }
    }
}
