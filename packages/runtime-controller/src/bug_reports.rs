use std::path::Path as FsPath;
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::config::PgPool;
use crate::conversations::{ensure_conversation_access, load_conversation_record};
use crate::errors::{
    bad_request, internal_error, not_found, too_many_requests, unauthorized, ApiError,
};
use crate::ota::require_operator_access_for_context;
use crate::projects::{ensure_project_read_access, load_project_record};
use crate::state::{publish_controller_event_with_conversation, AppState};

const MAX_SCREENSHOTS: usize = 6;
const MAX_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SUPPORT_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;
const MAX_SUPPORT_REQUEST_BYTES: usize = 20 * 1024 * 1024;
const MAX_SUPPORT_MESSAGE_CHARS: usize = 500;
const MAX_SUPPORT_DETAILS_BYTES: usize = 20_000;
const MAX_SUPPORT_METADATA_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_LOGS_BYTES: usize = 1024 * 1024;
const MAX_LOG_ENTRIES: usize = 500;
const DEFAULT_LIST_LIMIT: i64 = 25;
const MAX_LIST_LIMIT: i64 = 100;

pub(crate) struct SystemBugReportInput {
    pub(crate) message: String,
    pub(crate) details: Option<String>,
    pub(crate) project_id: Option<Uuid>,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) priority: String,
    pub(crate) labels: Vec<String>,
    pub(crate) metadata: JsonValue,
    pub(crate) logs: JsonValue,
    pub(crate) fingerprint: Option<String>,
    pub(crate) dedupe_window_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBugReportRequest {
    message: String,
    details: Option<String>,
    project_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    metadata: Option<JsonValue>,
    logs: Option<JsonValue>,
    screenshots: Option<Vec<CreateBugReportScreenshotRequest>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBugReportScreenshotRequest {
    file_name: String,
    media_type: String,
    data_base64: String,
    byte_length: usize,
}

#[derive(Debug, Default, Deserialize)]
struct BugReportAccessQuery {
    mine: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ListBugReportsQuery {
    mine: Option<bool>,
    limit: Option<i64>,
    status: Option<String>,
    reporter_email: Option<String>,
    project_id: Option<String>,
    search: Option<String>,
    before_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBugReportRequest {
    status: Option<String>,
    priority: Option<String>,
    assignee: Option<String>,
    labels: Option<JsonValue>,
    duplicate_of: Option<String>,
    github_issue_url: Option<String>,
    resolved_at: Option<String>,
    updated_at: Option<String>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBugReportResponse {
    id: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportSummary {
    id: String,
    created_at: String,
    message: String,
    details: Option<String>,
    status: String,
    priority: String,
    assignee: Option<String>,
    labels: JsonValue,
    duplicate_of: Option<String>,
    github_issue_url: Option<String>,
    resolved_at: Option<String>,
    updated_at: String,
    reporter_email: Option<String>,
    user_id: Option<String>,
    project_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    metadata: JsonValue,
    logs: JsonValue,
    screenshot_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportAttachmentDetail {
    id: String,
    file_name: String,
    media_type: String,
    byte_size: i64,
    data_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportDetailResponse {
    id: String,
    created_at: String,
    message: String,
    details: Option<String>,
    status: String,
    priority: String,
    assignee: Option<String>,
    labels: JsonValue,
    duplicate_of: Option<String>,
    github_issue_url: Option<String>,
    resolved_at: Option<String>,
    updated_at: String,
    reporter_email: Option<String>,
    user_id: Option<String>,
    project_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    metadata: JsonValue,
    logs: JsonValue,
    screenshots: Vec<BugReportAttachmentDetail>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportListResponse {
    reports: Vec<BugReportSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBugReportSummary {
    id: String,
    created_at: String,
    updated_at: String,
    message: String,
    status: String,
    project_id: Option<String>,
    screenshot_count: i64,
}

impl From<BugReportSummary> for CustomerBugReportSummary {
    fn from(report: BugReportSummary) -> Self {
        Self {
            id: report.id,
            created_at: report.created_at,
            updated_at: report.updated_at,
            message: report.message,
            status: report.status,
            project_id: report.project_id,
            screenshot_count: report.screenshot_count,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBugReportListResponse {
    reports: Vec<CustomerBugReportSummary>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum BugReportListResponseView {
    Customer(CustomerBugReportListResponse),
    Operator(BugReportListResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBugReportAttachment {
    id: String,
    file_name: String,
    media_type: String,
    byte_size: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBugReportDetailResponse {
    id: String,
    created_at: String,
    updated_at: String,
    message: String,
    details: Option<String>,
    status: String,
    project_id: Option<String>,
    runtime_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    screenshots: Vec<CustomerBugReportAttachment>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum BugReportDetailResponseView {
    Customer(CustomerBugReportDetailResponse),
    Operator(BugReportDetailResponse),
}

pub(crate) fn router() -> Router<AppState> {
    let support = Router::new()
        .route(
            "/support/reports",
            post(post_support_report).get(list_support_reports),
        )
        .route("/support/reports/:bug_report_id", get(get_support_report))
        .layer(DefaultBodyLimit::max(MAX_SUPPORT_REQUEST_BYTES));
    Router::new()
        .merge(support)
        .route("/bug-reports", post(post_bug_report).get(list_bug_reports))
        .route(
            "/bug-reports/:bug_report_id",
            get(get_bug_report).patch(patch_bug_report),
        )
}

async fn post_support_report(
    State(state): State<AppState>,
    request: Request,
) -> Result<(StatusCode, Json<CreateBugReportResponse>), (StatusCode, Json<ApiError>)> {
    // Authenticate and rate-limit before buffering the larger support payload. This keeps
    // unauthenticated or abusive clients from using the 20 MiB route allowance as an
    // allocation/parsing primitive.
    let context = authenticate_request(&state.config, request.headers()).await?;
    require_bug_report_request_access(&context, true)?;
    if !state.config.dev_mode {
        let user_id = context
            .user_id
            .ok_or_else(|| unauthorized("support reports require an authenticated user"))?;
        state
            .rate_limiter
            .enforce(
                format!("bug-reports:user:{user_id}"),
                5,
                Duration::from_secs(10 * 60),
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many support report attempts. Try again in {}s.",
                    limit.retry_after.as_secs().max(1)
                ))
            })?;
    }

    let body_bytes = to_bytes(request.into_body(), MAX_SUPPORT_REQUEST_BYTES)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError::new("support report request exceeds 20 MiB")),
            )
        })?;
    let body = serde_json::from_slice::<CreateBugReportRequest>(&body_bytes)
        .map_err(|_| bad_request("support report request must be valid JSON"))?;
    post_bug_report_with_context(&state, context, true, true, body).await
}

async fn list_support_reports(
    state: State<AppState>,
    headers: HeaderMap,
    Query(mut query): Query<ListBugReportsQuery>,
) -> Result<Json<BugReportListResponseView>, (StatusCode, Json<ApiError>)> {
    query.mine = Some(true);
    list_bug_reports(state, headers, Query(query)).await
}

async fn get_support_report(
    state: State<AppState>,
    headers: HeaderMap,
    path: Path<String>,
) -> Result<Json<BugReportDetailResponseView>, (StatusCode, Json<ApiError>)> {
    get_bug_report(
        state,
        headers,
        path,
        Query(BugReportAccessQuery { mine: Some(true) }),
    )
    .await
}

pub(crate) async fn record_system_bug_report(
    state: &AppState,
    input: SystemBugReportInput,
) -> anyhow::Result<Uuid> {
    ensure_bug_report_tables(&state.pool)
        .await
        .map_err(|(_, Json(error))| anyhow::anyhow!(error.message))?;

    let message = input.message.trim().to_string();
    anyhow::ensure!(!message.is_empty(), "system bug report message is required");

    let details = input
        .details
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let priority = normalize_system_priority(&input.priority);
    let labels = normalize_system_labels(input.labels);
    let fingerprint = normalize_system_fingerprint(input.fingerprint.as_deref());
    let labels_json = JsonValue::Array(labels.iter().cloned().map(JsonValue::String).collect());
    let logs = normalize_logs(input.logs);
    let metadata = normalize_system_metadata(input.metadata, fingerprint.as_deref());

    let connection = state.pool.get().await?;
    if let Some(existing_id) = maybe_load_recent_system_issue(
        &connection,
        fingerprint.as_deref(),
        input.dedupe_window_seconds,
    )
    .await?
    {
        publish_controller_event_with_conversation(
            &state.events,
            "telemetry.system_issue.repeated",
            input.project_id,
            None,
            input.conversation_id,
            input.run_id,
            None,
            json!({
                "bugReportId": existing_id.to_string(),
                "message": message,
                "priority": priority,
                "labels": labels,
                "runtimeId": input.runtime_id.map(|value| value.to_string()),
                "fingerprint": fingerprint,
            }),
        );
        return Ok(existing_id);
    }

    let report_id = Uuid::new_v4();
    let created_at = Utc::now();
    connection
        .execute(
            "insert into bug_reports (
                id, user_id, reporter_email, message, details, project_id, runtime_id, run_id,
                conversation_id, status, priority, labels, metadata, logs, created_at, updated_at
             ) values (
                $1, null, 'system@instafy.dev', $2, $3, $4, $5, $6,
                $7, 'open', $8, $9, $10, $11, $12, $12
             )",
            &[
                &report_id,
                &message,
                &details,
                &input.project_id,
                &input.runtime_id,
                &input.run_id,
                &input.conversation_id,
                &priority,
                &PgJson(&labels_json),
                &PgJson(&metadata),
                &PgJson(&logs),
                &created_at,
            ],
        )
        .await?;

    publish_controller_event_with_conversation(
        &state.events,
        "telemetry.system_issue.created",
        input.project_id,
        None,
        input.conversation_id,
        input.run_id,
        None,
        json!({
            "bugReportId": report_id.to_string(),
            "message": message,
            "priority": priority,
            "labels": labels,
            "runtimeId": input.runtime_id.map(|value| value.to_string()),
            "fingerprint": fingerprint,
        }),
    );

    Ok(report_id)
}

async fn post_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BugReportAccessQuery>,
    Json(body): Json<CreateBugReportRequest>,
) -> Result<(StatusCode, Json<CreateBugReportResponse>), (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mine_only = query.mine.unwrap_or(false);
    require_bug_report_request_access(&context, mine_only)?;
    if !context.is_service_role && !state.config.dev_mode {
        let user_id = context
            .user_id
            .ok_or_else(|| unauthorized("bug reports require an authenticated user"))?;
        state
            .rate_limiter
            .enforce(
                format!("bug-reports:legacy-attempts:user:{user_id}"),
                30,
                Duration::from_secs(10 * 60),
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many bug report attempts. Try again in {}s.",
                    limit.retry_after.as_secs().max(1)
                ))
            })?;
    }
    post_bug_report_with_context(&state, context, mine_only, false, body).await
}

async fn post_bug_report_with_context(
    state: &AppState,
    context: RequestContext,
    mine_only: bool,
    attempt_pre_limited: bool,
    body: CreateBugReportRequest,
) -> Result<(StatusCode, Json<CreateBugReportResponse>), (StatusCode, Json<ApiError>)> {
    let customer_submission = !context.is_service_role;
    if mine_only {
        validate_customer_bug_report_request(&body)?;
    }

    ensure_bug_report_tables(&state.pool).await?;

    let message = body.message.trim().to_string();
    if message.is_empty() {
        return Err(bad_request("bug report message is required"));
    }

    let details = body
        .details
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let project_id = parse_uuid_optional(body.project_id.as_deref(), "projectId")?;
    let runtime_id = parse_uuid_optional(body.runtime_id.as_deref(), "runtimeId")?;
    let run_id = parse_uuid_optional(body.run_id.as_deref(), "runId")?;
    let conversation_id = parse_uuid_optional(body.conversation_id.as_deref(), "conversationId")?;
    let metadata = body.metadata.unwrap_or_else(|| json!({}));
    let logs = normalize_logs(body.logs.unwrap_or_else(|| JsonValue::Array(Vec::new())));
    let screenshots = decode_screenshots(body.screenshots.unwrap_or_default())?;
    if mine_only {
        validate_customer_screenshots(&screenshots)?;
    }

    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;

    let reporter_email = match context.user_id {
        Some(user_id) => load_reporter_email_snapshot(&connection, &user_id).await,
        None => None,
    };
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start bug report creation transaction: {error}"
        ))
    })?;
    if !context.is_service_role {
        authorize_bug_report_context(
            &transaction,
            &context,
            project_id,
            runtime_id,
            run_id,
            conversation_id,
        )
        .await?;
    }
    if customer_submission && !attempt_pre_limited && !state.config.dev_mode {
        let user_id = context
            .user_id
            .ok_or_else(|| unauthorized("bug reports require an authenticated user"))?;
        state
            .rate_limiter
            .enforce(
                format!("bug-reports:user:{user_id}"),
                5,
                Duration::from_secs(10 * 60),
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many bug reports. Try again in {}s.",
                    limit.retry_after.as_secs().max(1)
                ))
            })?;
    }
    if customer_submission {
        let user_id = context
            .user_id
            .ok_or_else(|| unauthorized("support reports require an authenticated user"))?;
        let user_key = user_id.to_string();
        transaction
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
                &[&user_key],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to reserve support report submission: {error}"
                ))
            })?;
        let recent_count = transaction
            .query_one(
                "select count(*)::bigint
                   from bug_reports
                  where user_id = $1
                    and created_at >= now() - interval '24 hours'",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to check support report quota: {error}"))
            })?
            .get::<_, i64>(0);
        if recent_count >= 20 {
            return Err(too_many_requests(
                "Daily support report limit reached. Try again later.",
            ));
        }
    }

    let report_id = Uuid::new_v4();
    let created_at = Utc::now();
    transaction
        .execute(
            "insert into bug_reports (
                id, user_id, reporter_email, message, details, project_id, runtime_id, run_id,
                conversation_id, status, metadata, logs, created_at
             ) values (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, 'open', $10, $11, $12
             )",
            &[
                &report_id,
                &context.user_id,
                &reporter_email,
                &message,
                &details,
                &project_id,
                &runtime_id,
                &run_id,
                &conversation_id,
                &PgJson(&metadata),
                &PgJson(&logs),
                &created_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert bug report: {error}")))?;

    for screenshot in screenshots.iter() {
        let attachment_id = Uuid::new_v4();
        transaction
            .execute(
                "insert into bug_report_attachments (
                    id, bug_report_id, file_name, media_type, byte_size, content, created_at
                 ) values ($1, $2, $3, $4, $5, $6, $7)",
                &[
                    &attachment_id,
                    &report_id,
                    &screenshot.file_name,
                    &screenshot.media_type,
                    &(screenshot.bytes.len() as i64),
                    &screenshot.bytes,
                    &created_at,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to insert bug report attachment: {error}"))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize bug report creation transaction: {error}"
        ))
    })?;

    if context.is_service_role {
        publish_controller_event_with_conversation(
            &state.events,
            "telemetry.bug_report.submitted",
            project_id,
            None,
            conversation_id,
            run_id,
            None,
            user_bug_report_event_data(report_id, screenshots.len()),
        );
    }

    Ok((
        StatusCode::CREATED,
        Json(CreateBugReportResponse {
            id: report_id.to_string(),
            created_at: created_at.to_rfc3339(),
        }),
    ))
}

fn user_bug_report_event_data(report_id: Uuid, screenshot_count: usize) -> JsonValue {
    // Project event streams are visible to every authorized project member.
    // Keep support content and reporter identity exclusively in bug_reports,
    // whose direct read routes enforce reporter/operator authorization.
    json!({
        "bugReportId": report_id.to_string(),
        "status": "open",
        "screenshotCount": screenshot_count,
    })
}

async fn authorize_bug_report_context(
    transaction: &tokio_postgres::Transaction<'_>,
    context: &RequestContext,
    project_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    run_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(project_id) = project_id else {
        if runtime_id.is_some() || run_id.is_some() || conversation_id.is_some() {
            return Err(bad_request(
                "projectId is required when runtimeId, runId, or conversationId is supplied",
            ));
        }
        return Ok(());
    };

    let project = load_project_record(transaction, &project_id).await?;
    ensure_project_read_access(transaction, &project, context, None).await?;

    let supplied_conversation = if let Some(conversation_id) = conversation_id {
        let conversation = load_conversation_record(transaction, &conversation_id).await?;
        if conversation.project_id != project_id {
            return Err(not_found("conversation not found"));
        }
        ensure_conversation_access(transaction, &conversation, context).await?;
        Some(conversation)
    } else {
        None
    };

    if let Some(run_id) = run_id {
        let run = transaction
            .query_opt(
                "select conversation_id
                 from runs
                 where id = $1 and project_id = $2
                 limit 1",
                &[&run_id, &project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to validate bug report run: {error}"))
            })?;
        let Some(run) = run else {
            return Err(not_found("run not found"));
        };
        let run_conversation_id: Option<Uuid> = run.get("conversation_id");
        if conversation_id.is_some() && conversation_id != run_conversation_id {
            return Err(bad_request(
                "runId does not belong to the supplied conversationId",
            ));
        }
        if let Some(run_conversation_id) = run_conversation_id {
            if supplied_conversation.as_ref().map(|value| value.id) != Some(run_conversation_id) {
                let run_conversation =
                    load_conversation_record(transaction, &run_conversation_id).await?;
                if run_conversation.project_id != project_id {
                    return Err(not_found("run not found"));
                }
                ensure_conversation_access(transaction, &run_conversation, context).await?;
            }
        }
    }

    if let Some(runtime_id) = runtime_id {
        let runtime = transaction
            .query_opt(
                "select 1 from runtimes where id = $1 and project_id = $2 limit 1",
                &[&runtime_id, &project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to validate bug report runtime: {error}"))
            })?;
        if runtime.is_none() {
            return Err(not_found("runtime not found"));
        }
    }

    Ok(())
}

async fn list_bug_reports(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListBugReportsQuery>,
) -> Result<Json<BugReportListResponseView>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mine_only = query.mine.unwrap_or(false);
    require_bug_report_request_access(&context, mine_only)?;

    ensure_bug_report_tables(&state.pool).await?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reporter_email = query
        .reporter_email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let project_id = parse_uuid_optional(query.project_id.as_deref(), "project_id")?;
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let before_created_at = query
        .before_created_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|parsed| parsed.with_timezone(&Utc))
                .map_err(|_| bad_request("before_created_at must be a valid RFC3339 timestamp"))
        })
        .transpose()?;
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let can_view_all = !mine_only
        && (context.is_service_role
            || require_bug_report_operator_access(&state, &headers)
                .await
                .is_ok());

    if !can_view_all {
        let user_id = context
            .user_id
            .ok_or_else(|| unauthorized("bug reports require an authenticated user"))?;
        let rows = connection
            .query(
                "select br.id, br.created_at, br.updated_at, br.message, br.status, br.project_id,
                        (select count(*)::bigint from bug_report_attachments bra where bra.bug_report_id = br.id) as screenshot_count
                   from bug_reports br
                  where br.user_id = $1
                    and ($3::text is null or br.status = $3)
                    and ($4::uuid is null or br.project_id = $4)
                    and ($5::timestamptz is null or br.created_at < $5)
                    and (
                      $6::text is null
                      or br.message ilike ('%' || $6 || '%')
                      or coalesce(br.details, '') ilike ('%' || $6 || '%')
                    )
                  order by br.created_at desc
                  limit $2",
                &[
                    &user_id,
                    &limit,
                    &status,
                    &project_id,
                    &before_created_at,
                    &search,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load support reports: {error}")))?;
        let reports = rows
            .into_iter()
            .map(|row| CustomerBugReportSummary {
                id: row.get::<_, Uuid>("id").to_string(),
                created_at: row
                    .get::<_, chrono::DateTime<Utc>>("created_at")
                    .to_rfc3339(),
                updated_at: row
                    .get::<_, chrono::DateTime<Utc>>("updated_at")
                    .to_rfc3339(),
                message: row.get("message"),
                status: row.get("status"),
                project_id: row
                    .get::<_, Option<Uuid>>("project_id")
                    .map(|value| value.to_string()),
                screenshot_count: row.get("screenshot_count"),
            })
            .collect();
        return Ok(Json(BugReportListResponseView::Customer(
            CustomerBugReportListResponse { reports },
        )));
    }

    let rows = connection
        .query(
            "select br.*,
                        (select count(*)::bigint from bug_report_attachments bra where bra.bug_report_id = br.id) as screenshot_count
                   from bug_reports br
                  where ($2::text is null or br.status = $2)
                    and ($3::text is null or lower(coalesce(br.reporter_email, '')) = lower($3))
                    and ($4::uuid is null or br.project_id = $4)
                    and ($5::timestamptz is null or br.created_at < $5)
                    and (
                      $6::text is null
                      or br.message ilike ('%' || $6 || '%')
                      or coalesce(br.details, '') ilike ('%' || $6 || '%')
                      or coalesce(br.reporter_email, '') ilike ('%' || $6 || '%')
                      or coalesce(br.project_id::text, '') ilike ('%' || $6 || '%')
                      or coalesce(br.conversation_id::text, '') ilike ('%' || $6 || '%')
                    )
                  order by br.created_at desc
                  limit $1",
            &[
                &limit,
                &status,
                &reporter_email,
                &project_id,
                &before_created_at,
                &search,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load bug reports: {error}")))?;

    let reports = rows
        .into_iter()
        .map(map_bug_report_summary_row)
        .collect::<Vec<_>>();
    Ok(Json(BugReportListResponseView::Operator(
        BugReportListResponse { reports },
    )))
}

async fn get_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bug_report_id_raw): Path<String>,
    Query(query): Query<BugReportAccessQuery>,
) -> Result<Json<BugReportDetailResponseView>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mine_only = query.mine.unwrap_or(false);
    require_bug_report_request_access(&context, mine_only)?;

    ensure_bug_report_tables(&state.pool).await?;
    let bug_report_id = Uuid::parse_str(bug_report_id_raw.trim())
        .map_err(|_| bad_request("bug_report_id must be a valid UUID"))?;

    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;

    let can_view_all = !mine_only
        && (context.is_service_role
            || require_bug_report_operator_access(&state, &headers)
                .await
                .is_ok());
    let row = if !can_view_all {
        let viewer = context
            .user_id
            .ok_or_else(|| unauthorized("bug reports require an authenticated user"))?;
        connection
            .query_opt(
                "select id, user_id, created_at, updated_at, message, details, status,
                        project_id, runtime_id, run_id, conversation_id
                   from bug_reports
                  where id = $1 and user_id = $2",
                &[&bug_report_id, &viewer],
            )
            .await
    } else {
        connection
            .query_opt("select * from bug_reports where id = $1", &[&bug_report_id])
            .await
    }
    .map_err(|error| internal_error(format!("failed to load bug report: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("bug report not found"));
    };

    let owner_user_id: Option<Uuid> = row.get("user_id");
    if !can_view_all {
        let viewer = context
            .user_id
            .ok_or_else(|| unauthorized("bug reports require an authenticated user"))?;
        if owner_user_id != Some(viewer) {
            return Err(not_found("bug report not found"));
        }
    }

    if !can_view_all {
        let screenshots = connection
            .query(
                "select id, file_name, media_type, byte_size
                   from bug_report_attachments
                  where bug_report_id = $1
                  order by created_at asc",
                &[&bug_report_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load bug report attachments: {error}"))
            })?;
        let attachments = screenshots
            .into_iter()
            .map(|attachment| CustomerBugReportAttachment {
                id: attachment.get::<_, Uuid>("id").to_string(),
                file_name: attachment.get("file_name"),
                media_type: attachment.get("media_type"),
                byte_size: attachment.get("byte_size"),
            })
            .collect();
        return Ok(Json(BugReportDetailResponseView::Customer(
            CustomerBugReportDetailResponse {
                id: row.get::<_, Uuid>("id").to_string(),
                created_at: row
                    .get::<_, chrono::DateTime<Utc>>("created_at")
                    .to_rfc3339(),
                updated_at: row
                    .get::<_, chrono::DateTime<Utc>>("updated_at")
                    .to_rfc3339(),
                message: row.get("message"),
                details: row.get("details"),
                status: row.get("status"),
                project_id: row
                    .get::<_, Option<Uuid>>("project_id")
                    .map(|value| value.to_string()),
                runtime_id: row
                    .get::<_, Option<Uuid>>("runtime_id")
                    .map(|value| value.to_string()),
                run_id: row
                    .get::<_, Option<Uuid>>("run_id")
                    .map(|value| value.to_string()),
                conversation_id: row
                    .get::<_, Option<Uuid>>("conversation_id")
                    .map(|value| value.to_string()),
                screenshots: attachments,
            },
        )));
    }

    let screenshots = connection
        .query(
            "select id, file_name, media_type, byte_size, content
               from bug_report_attachments
              where bug_report_id = $1
              order by created_at asc",
            &[&bug_report_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load bug report attachments: {error}"))
        })?;

    let attachments = screenshots
        .into_iter()
        .map(|attachment| BugReportAttachmentDetail {
            id: attachment.get::<_, Uuid>("id").to_string(),
            file_name: attachment.get("file_name"),
            media_type: attachment.get("media_type"),
            byte_size: attachment.get("byte_size"),
            data_base64: BASE64.encode(attachment.get::<_, Vec<u8>>("content")),
        })
        .collect();

    Ok(Json(BugReportDetailResponseView::Operator(
        BugReportDetailResponse {
            id: row.get::<_, Uuid>("id").to_string(),
            created_at: row
                .get::<_, chrono::DateTime<Utc>>("created_at")
                .to_rfc3339(),
            message: row.get("message"),
            details: row.get("details"),
            status: row.get("status"),
            priority: row.get("priority"),
            assignee: row.get("assignee"),
            labels: row.get::<_, PgJson<JsonValue>>("labels").0,
            duplicate_of: row
                .get::<_, Option<Uuid>>("duplicate_of")
                .map(|value| value.to_string()),
            github_issue_url: row.get("github_issue_url"),
            resolved_at: row
                .get::<_, Option<chrono::DateTime<Utc>>>("resolved_at")
                .map(|value| value.to_rfc3339()),
            updated_at: row
                .get::<_, chrono::DateTime<Utc>>("updated_at")
                .to_rfc3339(),
            reporter_email: row.get("reporter_email"),
            user_id: owner_user_id.map(|value| value.to_string()),
            project_id: row
                .get::<_, Option<Uuid>>("project_id")
                .map(|value| value.to_string()),
            runtime_id: row
                .get::<_, Option<Uuid>>("runtime_id")
                .map(|value| value.to_string()),
            run_id: row
                .get::<_, Option<Uuid>>("run_id")
                .map(|value| value.to_string()),
            conversation_id: row
                .get::<_, Option<Uuid>>("conversation_id")
                .map(|value| value.to_string()),
            metadata: row.get::<_, PgJson<JsonValue>>("metadata").0,
            logs: row.get::<_, PgJson<JsonValue>>("logs").0,
            screenshots: attachments,
        },
    )))
}

fn require_bug_report_request_access(
    context: &RequestContext,
    mine_only: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if mine_only || !context.is_service_role {
        require_user_session(context)?;
    }
    Ok(())
}

/// Whether the authenticated context belongs to a bug-reports-only operator
/// (`BUG_REPORTS_OPERATOR_USER_IDS`). Only an interactive user session
/// qualifies: `require_user_session` rejects service-role and runtime-scoped
/// tokens, exactly like the general operator allowlist does.
fn is_bug_report_operator(state: &AppState, context: &RequestContext) -> bool {
    let Ok(user_id) = require_user_session(context) else {
        return false;
    };
    state
        .config
        .bug_reports_operator_user_ids
        .contains(&user_id)
}

/// Operator gate for the bug-report routes only.
///
/// Authenticates the bearer exactly like `require_operator_access` and succeeds
/// when either the full operator check passes (service role, operator org
/// membership, `OPERATOR_CONSOLE_ALLOWED_USER_IDS`) or the signed-in user is
/// listed in `BUG_REPORTS_OPERATOR_USER_IDS`. The latter grants nothing outside
/// this module: every other operator route keeps calling
/// `require_operator_access`, so a bug-reports-only operator is still refused
/// there. Failures carry the same error shape as `require_operator_access`.
/// Deliberately private to this module so no other route can pick it up.
async fn require_bug_report_operator_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<RequestContext, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    if is_bug_report_operator(state, &context) {
        return Ok(context);
    }
    require_operator_access_for_context(state, context).await
}

async fn patch_bug_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bug_report_id_raw): Path<String>,
    Json(body): Json<UpdateBugReportRequest>,
) -> Result<Json<BugReportSummary>, (StatusCode, Json<ApiError>)> {
    require_bug_report_operator_access(&state, &headers).await?;
    ensure_bug_report_tables(&state.pool).await?;

    let bug_report_id = Uuid::parse_str(bug_report_id_raw.trim())
        .map_err(|_| bad_request("bug_report_id must be a valid UUID"))?;
    let duplicate_of = parse_uuid_optional(body.duplicate_of.as_deref(), "duplicateOf")?;
    let status = body
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_bug_report_status)
        .transpose()?;
    let priority = body
        .priority
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_bug_report_priority)
        .transpose()?;
    let assignee = body
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let github_issue_url = body
        .github_issue_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let resolved_at = body
        .resolved_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|parsed| parsed.with_timezone(&Utc))
                .map_err(|_| bad_request("resolvedAt must be a valid RFC3339 timestamp"))
        })
        .transpose()?;
    let updated_at = body
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|parsed| parsed.with_timezone(&Utc))
                .map_err(|_| bad_request("updatedAt must be a valid RFC3339 timestamp"))
        })
        .transpose()?
        .unwrap_or_else(Utc::now);
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;

    let existing_row = connection
        .query_opt("select * from bug_reports where id = $1", &[&bug_report_id])
        .await
        .map_err(|error| internal_error(format!("failed to load bug report: {error}")))?;
    let Some(existing_row) = existing_row else {
        return Err(not_found("bug report not found"));
    };

    let existing_status: String = existing_row.get("status");
    let existing_priority: String = existing_row.get("priority");
    let existing_assignee: Option<String> = existing_row.get("assignee");
    let existing_labels: JsonValue = existing_row.get::<_, PgJson<JsonValue>>("labels").0;
    let existing_duplicate_of: Option<Uuid> = existing_row.get("duplicate_of");
    let existing_github_issue_url: Option<String> = existing_row.get("github_issue_url");
    let existing_resolved_at: Option<chrono::DateTime<Utc>> = existing_row.get("resolved_at");
    let existing_metadata: JsonValue = existing_row.get::<_, PgJson<JsonValue>>("metadata").0;

    let next_status = status.unwrap_or(existing_status);
    let next_priority = priority.unwrap_or(existing_priority);
    let next_assignee = body
        .assignee
        .as_ref()
        .map(|_| assignee.clone())
        .unwrap_or(existing_assignee);
    let next_labels = body
        .labels
        .map(normalize_labels)
        .transpose()?
        .unwrap_or(existing_labels);
    let next_duplicate_of = if body.duplicate_of.is_some() {
        duplicate_of
    } else {
        existing_duplicate_of
    };
    let next_github_issue_url = if body.github_issue_url.is_some() {
        github_issue_url
    } else {
        existing_github_issue_url
    };
    let next_resolved_at = if body.resolved_at.is_some() {
        resolved_at
    } else {
        existing_resolved_at
    };
    let next_metadata = body.metadata.unwrap_or(existing_metadata);

    let row = connection
        .query_opt(
            "update bug_reports
                set status = $2,
                    priority = $3,
                    assignee = $4,
                    labels = $5,
                    duplicate_of = $6,
                    github_issue_url = $7,
                    resolved_at = $8,
                    updated_at = $9,
                    metadata = $10
              where id = $1
              returning *,
                (select count(*)::bigint from bug_report_attachments bra where bra.bug_report_id = bug_reports.id) as screenshot_count",
            &[
                &bug_report_id,
                &next_status,
                &next_priority,
                &next_assignee,
                &PgJson(&next_labels),
                &next_duplicate_of,
                &next_github_issue_url,
                &next_resolved_at,
                &updated_at,
                &PgJson(&next_metadata),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update bug report: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("bug report not found"));
    };

    Ok(Json(map_bug_report_summary_row(row)))
}

fn map_bug_report_summary_row(row: tokio_postgres::Row) -> BugReportSummary {
    BugReportSummary {
        id: row.get::<_, Uuid>("id").to_string(),
        created_at: row
            .get::<_, chrono::DateTime<Utc>>("created_at")
            .to_rfc3339(),
        message: row.get("message"),
        details: row.get("details"),
        status: row.get("status"),
        priority: row.get("priority"),
        assignee: row.get("assignee"),
        labels: row.get::<_, PgJson<JsonValue>>("labels").0,
        duplicate_of: row
            .get::<_, Option<Uuid>>("duplicate_of")
            .map(|value| value.to_string()),
        github_issue_url: row.get("github_issue_url"),
        resolved_at: row
            .get::<_, Option<chrono::DateTime<Utc>>>("resolved_at")
            .map(|value| value.to_rfc3339()),
        updated_at: row
            .get::<_, chrono::DateTime<Utc>>("updated_at")
            .to_rfc3339(),
        reporter_email: row.get("reporter_email"),
        user_id: row
            .get::<_, Option<Uuid>>("user_id")
            .map(|value| value.to_string()),
        project_id: row
            .get::<_, Option<Uuid>>("project_id")
            .map(|value| value.to_string()),
        runtime_id: row
            .get::<_, Option<Uuid>>("runtime_id")
            .map(|value| value.to_string()),
        run_id: row
            .get::<_, Option<Uuid>>("run_id")
            .map(|value| value.to_string()),
        conversation_id: row
            .get::<_, Option<Uuid>>("conversation_id")
            .map(|value| value.to_string()),
        metadata: row.get::<_, PgJson<JsonValue>>("metadata").0,
        logs: row.get::<_, PgJson<JsonValue>>("logs").0,
        screenshot_count: row.get("screenshot_count"),
    }
}

#[derive(Debug)]
struct DecodedScreenshot {
    file_name: String,
    media_type: String,
    bytes: Vec<u8>,
}

fn validate_customer_bug_report_request(
    request: &CreateBugReportRequest,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if request.message.trim().chars().count() > MAX_SUPPORT_MESSAGE_CHARS {
        return Err(bad_request(format!(
            "support report message must be {MAX_SUPPORT_MESSAGE_CHARS} characters or shorter"
        )));
    }
    if request
        .details
        .as_deref()
        .map(|value| value.len() > MAX_SUPPORT_DETAILS_BYTES)
        .unwrap_or(false)
    {
        return Err(bad_request(format!(
            "support report details must be {MAX_SUPPORT_DETAILS_BYTES} bytes or smaller"
        )));
    }
    if let Some(metadata) = request.metadata.as_ref() {
        if !metadata.is_object() {
            return Err(bad_request("support report metadata must be a JSON object"));
        }
        if json_encoded_len(metadata) > MAX_SUPPORT_METADATA_BYTES {
            return Err(bad_request(format!(
                "support report metadata must be {MAX_SUPPORT_METADATA_BYTES} bytes or smaller"
            )));
        }
    }
    if let Some(logs) = request.logs.as_ref() {
        let Some(entries) = logs.as_array() else {
            return Err(bad_request("support report logs must be a JSON array"));
        };
        if entries.len() > MAX_LOG_ENTRIES {
            return Err(bad_request(format!(
                "support report logs may contain at most {MAX_LOG_ENTRIES} entries"
            )));
        }
        if json_encoded_len(logs) > MAX_SUPPORT_LOGS_BYTES {
            return Err(bad_request(format!(
                "support report logs must be {MAX_SUPPORT_LOGS_BYTES} bytes or smaller"
            )));
        }
    }
    Ok(())
}

fn json_encoded_len(value: &JsonValue) -> usize {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .unwrap_or(usize::MAX)
}

fn validate_customer_screenshots(
    screenshots: &[DecodedScreenshot],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let total_bytes = screenshots.iter().try_fold(0usize, |total, screenshot| {
        total
            .checked_add(screenshot.bytes.len())
            .ok_or_else(|| bad_request("support report screenshot payload is too large"))
    })?;
    if total_bytes > MAX_SUPPORT_SCREENSHOT_BYTES {
        return Err(bad_request(format!(
            "support report screenshots may total at most {MAX_SUPPORT_SCREENSHOT_BYTES} bytes"
        )));
    }
    for screenshot in screenshots {
        let file_name = screenshot.file_name.as_str();
        if file_name.len() > 255
            || file_name == "."
            || file_name == ".."
            || file_name.contains('/')
            || file_name.contains('\\')
            || FsPath::new(file_name)
                .file_name()
                .and_then(|value| value.to_str())
                != Some(file_name)
        {
            return Err(bad_request(
                "support report screenshot fileName must be a plain file name",
            ));
        }
        let matches_content = match screenshot.media_type.as_str() {
            "image/png" => screenshot
                .bytes
                .starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            "image/jpeg" => screenshot.bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "image/webp" => {
                screenshot.bytes.len() >= 12
                    && &screenshot.bytes[..4] == b"RIFF"
                    && &screenshot.bytes[8..12] == b"WEBP"
            }
            _ => false,
        };
        if !matches_content {
            return Err(bad_request(
                "support report screenshots must be PNG, JPEG, or WebP images matching mediaType",
            ));
        }
    }
    Ok(())
}

fn decode_screenshots(
    screenshots: Vec<CreateBugReportScreenshotRequest>,
) -> Result<Vec<DecodedScreenshot>, (StatusCode, Json<ApiError>)> {
    if screenshots.len() > MAX_SCREENSHOTS {
        return Err(bad_request(format!(
            "at most {MAX_SCREENSHOTS} screenshots can be attached"
        )));
    }

    screenshots
        .into_iter()
        .map(|screenshot| {
            let file_name = screenshot.file_name.trim().to_string();
            let media_type = screenshot.media_type.trim().to_string();
            if file_name.is_empty() {
                return Err(bad_request("screenshot fileName is required"));
            }
            if media_type.is_empty() || !media_type.starts_with("image/") {
                return Err(bad_request("screenshots must be image attachments"));
            }
            let bytes = BASE64
                .decode(screenshot.data_base64.trim().as_bytes())
                .map_err(|_| bad_request("screenshot dataBase64 is invalid"))?;
            if bytes.len() != screenshot.byte_length {
                return Err(bad_request("screenshot byteLength does not match content"));
            }
            if bytes.len() > MAX_SCREENSHOT_BYTES {
                return Err(bad_request("screenshots must be 4 MB or smaller"));
            }
            Ok(DecodedScreenshot {
                file_name,
                media_type,
                bytes,
            })
        })
        .collect()
}

fn normalize_logs(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(entries) => JsonValue::Array(
            entries
                .into_iter()
                .rev()
                .take(MAX_LOG_ENTRIES)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        ),
        other => other,
    }
}

fn normalize_system_priority(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "low" | "normal" | "high" | "urgent" => value.trim().to_lowercase(),
        _ => "high".to_string(),
    }
}

fn normalize_system_labels(labels: Vec<String>) -> Vec<String> {
    let mut values = labels
        .into_iter()
        .map(|label| label.trim().to_lowercase())
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn normalize_system_fingerprint(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn normalize_system_metadata(mut metadata: JsonValue, fingerprint: Option<&str>) -> JsonValue {
    let Some(fingerprint) = fingerprint else {
        return metadata;
    };

    match metadata {
        JsonValue::Object(ref mut object) => {
            object
                .entry("fingerprint".to_string())
                .or_insert_with(|| JsonValue::String(fingerprint.to_string()));
            metadata
        }
        other => json!({
            "value": other,
            "fingerprint": fingerprint,
        }),
    }
}

async fn maybe_load_recent_system_issue(
    connection: &bb8::PooledConnection<'_, crate::config::PgConnectionManager>,
    fingerprint: Option<&str>,
    dedupe_window_seconds: Option<i64>,
) -> anyhow::Result<Option<Uuid>> {
    let Some(fingerprint) = fingerprint else {
        return Ok(None);
    };
    let window_seconds = dedupe_window_seconds.unwrap_or(15 * 60).max(60);
    let since = Utc::now() - chrono::Duration::seconds(window_seconds);
    let row = connection
        .query_opt(
            "select id
               from bug_reports
              where reporter_email = 'system@instafy.dev'
                and status <> 'resolved'
                and metadata->>'fingerprint' = $1
                and created_at >= $2
              order by created_at desc
              limit 1",
            &[&fingerprint, &since],
        )
        .await?;

    Ok(row.map(|row| row.get("id")))
}

fn normalize_bug_report_status(value: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    match value {
        "open" | "in_progress" | "resolved" => Ok(value.to_string()),
        _ => Err(bad_request("status must be open, in_progress, or resolved")),
    }
}

fn normalize_bug_report_priority(value: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    match value {
        "low" | "normal" | "high" | "urgent" => Ok(value.to_string()),
        _ => Err(bad_request("priority must be low, normal, high, or urgent")),
    }
}

fn normalize_labels(value: JsonValue) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let JsonValue::Array(entries) = value else {
        return Err(bad_request("labels must be an array"));
    };
    let mut labels = Vec::new();
    for entry in entries {
        let Some(label) = entry.as_str() else {
            return Err(bad_request("labels must be an array of strings"));
        };
        let trimmed = label.trim();
        if !trimmed.is_empty() {
            labels.push(JsonValue::String(trimmed.to_string()));
        }
    }
    Ok(JsonValue::Array(labels))
}

async fn ensure_bug_report_tables(pool: &PgPool) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    connection
        .batch_execute(
            "
            create table if not exists bug_reports (
                id uuid primary key,
                user_id uuid,
                reporter_email text,
                message text not null,
                details text,
                project_id uuid,
                runtime_id uuid,
                run_id uuid,
                conversation_id uuid,
                status text not null default 'open',
                priority text not null default 'normal',
                assignee text,
                labels jsonb not null default '[]'::jsonb,
                duplicate_of uuid references bug_reports(id) on delete set null,
                github_issue_url text,
                resolved_at timestamptz,
                metadata jsonb not null default '{}'::jsonb,
                logs jsonb not null default '[]'::jsonb,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );

            create table if not exists bug_report_attachments (
                id uuid primary key,
                bug_report_id uuid not null references bug_reports(id) on delete cascade,
                file_name text not null,
                media_type text not null,
                byte_size bigint not null,
                content bytea not null,
                created_at timestamptz not null default now()
            );

            alter table bug_reports add column if not exists priority text not null default 'normal';
            alter table bug_reports add column if not exists assignee text;
            alter table bug_reports add column if not exists labels jsonb not null default '[]'::jsonb;
            alter table bug_reports add column if not exists duplicate_of uuid references bug_reports(id) on delete set null;
            alter table bug_reports add column if not exists github_issue_url text;
            alter table bug_reports add column if not exists resolved_at timestamptz;
            alter table bug_reports add column if not exists updated_at timestamptz not null default now();

            create index if not exists bug_reports_created_at_idx on bug_reports (created_at desc);
            create index if not exists bug_reports_user_id_idx on bug_reports (user_id, created_at desc);
            create index if not exists bug_reports_project_id_idx on bug_reports (project_id, created_at desc);
            create index if not exists bug_reports_status_created_at_idx on bug_reports (status, created_at desc);
            create index if not exists bug_reports_priority_created_at_idx on bug_reports (priority, created_at desc);
            create index if not exists bug_reports_assignee_created_at_idx on bug_reports (assignee, created_at desc);
            create index if not exists bug_reports_duplicate_of_idx on bug_reports (duplicate_of);
            create index if not exists bug_report_attachments_bug_report_id_idx on bug_report_attachments (bug_report_id, created_at asc);

            alter table bug_reports enable row level security;
            alter table bug_report_attachments enable row level security;
            revoke all privileges on table bug_reports from anon, authenticated;
            revoke all privileges on table bug_report_attachments from anon, authenticated;
            ",
        )
        .await
        .map_err(|error| internal_error(format!("failed to ensure bug report tables: {error}")))?;
    Ok(())
}

async fn load_reporter_email_snapshot(
    connection: &bb8::PooledConnection<'_, crate::config::PgConnectionManager>,
    user_id: &Uuid,
) -> Option<String> {
    match connection
        .query_opt(
            "select email from auth.users where id = $1 limit 1",
            &[user_id],
        )
        .await
    {
        Ok(Some(row)) => row.get::<_, Option<String>>("email"),
        Ok(None) => None,
        Err(error)
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false) =>
        {
            None
        }
        Err(error) => {
            tracing::warn!(?error, "failed to load reporter email snapshot");
            None
        }
    }
}

fn parse_uuid_optional(
    raw: Option<&str>,
    field: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(value) = raw else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = Uuid::parse_str(trimmed)
        .map_err(|_| bad_request(format!("{field} must be a valid UUID")))?;
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_logs_caps_entries_and_keeps_latest_order() {
        let logs = JsonValue::Array((0..510).map(|index| json!({ "index": index })).collect());

        let normalized = normalize_logs(logs);
        let entries = normalized.as_array().expect("logs should remain an array");
        assert_eq!(entries.len(), MAX_LOG_ENTRIES);
        assert_eq!(
            entries
                .first()
                .and_then(|entry| entry.get("index"))
                .and_then(JsonValue::as_i64),
            Some(10),
        );
        assert_eq!(
            entries
                .last()
                .and_then(|entry| entry.get("index"))
                .and_then(JsonValue::as_i64),
            Some(509),
        );
    }

    #[test]
    fn decode_screenshots_rejects_byte_length_mismatch() {
        let error = decode_screenshots(vec![CreateBugReportScreenshotRequest {
            file_name: "shot.png".to_string(),
            media_type: "image/png".to_string(),
            data_base64: BASE64.encode(b"abc"),
            byte_length: 9,
        }])
        .expect_err("expected mismatch to fail");

        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.1 .0.message,
            "screenshot byteLength does not match content"
        );
    }

    #[test]
    fn user_bug_report_event_payload_excludes_content_and_identity() {
        let report_id = Uuid::new_v4();
        let payload = user_bug_report_event_data(report_id, 2);

        assert_eq!(
            payload,
            json!({
                "bugReportId": report_id,
                "status": "open",
                "screenshotCount": 2,
            })
        );
        for sensitive_key in [
            "message",
            "details",
            "reporterEmail",
            "reporter_email",
            "metadata",
            "logs",
        ] {
            assert!(payload.get(sensitive_key).is_none());
        }
    }

    #[test]
    fn mine_only_access_requires_an_interactive_user_session() {
        let user_id = Uuid::new_v4();
        let human = RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        };
        assert!(require_bug_report_request_access(&human, true).is_ok());

        let service = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        let service_error = require_bug_report_request_access(&service, true)
            .expect_err("service role must not enter mine-only mode");
        assert_eq!(service_error.0, StatusCode::UNAUTHORIZED);
        assert!(require_bug_report_request_access(&service, false).is_ok());

        let scoped = RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: Some(runtime_contracts::AccessTokenClaims {
                aud: "runtime".to_string(),
                sub: user_id.to_string(),
                project_id: Uuid::new_v4().to_string(),
                origin_id: None,
                runtime_id: Some(Uuid::new_v4().to_string()),
                protocol: None,
                scopes: Vec::new(),
                lease_id: None,
                runtime_generation: None,
                run_id: None,
                iat: 0,
                exp: i64::MAX,
                jti: Uuid::new_v4().to_string(),
                prefer_runtime: None,
                actor_label: None,
                browser_session_id: None,
            }),
        };
        let scoped_error = require_bug_report_request_access(&scoped, true)
            .expect_err("runtime-scoped token must not enter mine-only mode");
        assert_eq!(scoped_error.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn customer_summary_projection_excludes_operator_and_diagnostic_fields() {
        let report = BugReportSummary {
            id: Uuid::new_v4().to_string(),
            created_at: Utc::now().to_rfc3339(),
            message: "customer summary".to_string(),
            details: Some("sensitive details".to_string()),
            status: "open".to_string(),
            priority: "urgent".to_string(),
            assignee: Some("internal-operator".to_string()),
            labels: json!(["internal"]),
            duplicate_of: Some(Uuid::new_v4().to_string()),
            github_issue_url: Some("https://github.invalid/internal".to_string()),
            resolved_at: None,
            updated_at: Utc::now().to_rfc3339(),
            reporter_email: Some("customer@example.invalid".to_string()),
            user_id: Some(Uuid::new_v4().to_string()),
            project_id: Some(Uuid::new_v4().to_string()),
            runtime_id: Some(Uuid::new_v4().to_string()),
            run_id: Some(Uuid::new_v4().to_string()),
            conversation_id: Some(Uuid::new_v4().to_string()),
            metadata: json!({ "secret": true }),
            logs: json!([{ "secret": true }]),
            screenshot_count: 2,
        };

        let serialized = serde_json::to_value(CustomerBugReportSummary::from(report))
            .expect("customer summary should serialize");
        assert_eq!(serialized["message"], "customer summary");
        assert_eq!(serialized["screenshotCount"], 2);
        for key in [
            "details",
            "priority",
            "assignee",
            "labels",
            "duplicateOf",
            "githubIssueUrl",
            "reporterEmail",
            "userId",
            "runtimeId",
            "runId",
            "conversationId",
            "metadata",
            "logs",
        ] {
            assert!(
                serialized.get(key).is_none(),
                "unexpected customer field {key}"
            );
        }
    }

    #[test]
    fn customer_upload_validation_rejects_unstructured_logs_and_fake_images() {
        let request = CreateBugReportRequest {
            message: "summary".to_string(),
            details: None,
            project_id: None,
            runtime_id: None,
            run_id: None,
            conversation_id: None,
            metadata: None,
            logs: Some(json!({ "message": "not an array" })),
            screenshots: None,
        };
        let logs_error = validate_customer_bug_report_request(&request)
            .expect_err("customer logs must use the bounded array contract");
        assert_eq!(logs_error.0, StatusCode::BAD_REQUEST);

        let image_error = validate_customer_screenshots(&[DecodedScreenshot {
            file_name: "fake.png".to_string(),
            media_type: "image/png".to_string(),
            bytes: b"not a png".to_vec(),
        }])
        .expect_err("declared image type must match content");
        assert_eq!(image_error.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn normalize_system_labels_dedupes_and_trims() {
        assert_eq!(
            normalize_system_labels(vec![
                " Runtime ".to_string(),
                "provider".to_string(),
                "runtime".to_string(),
                "".to_string(),
            ]),
            vec!["provider".to_string(), "runtime".to_string()]
        );
    }

    #[test]
    fn normalize_system_metadata_adds_fingerprint() {
        let metadata = normalize_system_metadata(json!({ "source": "test" }), Some("proxy.down"));

        assert_eq!(metadata["source"], JsonValue::String("test".to_string()));
        assert_eq!(
            metadata["fingerprint"],
            JsonValue::String("proxy.down".to_string())
        );
    }

    fn build_dummy_pool() -> anyhow::Result<PgPool> {
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            "postgresql://ignored:ignored@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        Ok(bb8::Pool::builder().max_size(1).build_unchecked(manager))
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .expect("bearer header value"),
        );
        headers
    }

    #[tokio::test]
    async fn bug_report_operator_gate_admits_listed_users_without_widening_operator_access(
    ) -> anyhow::Result<()> {
        use crate::ota::require_operator_access;
        use crate::tests::{
            build_app_config, build_test_state, test_origin_private_key, test_origin_public_key,
        };
        use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

        let listed_user_id = Uuid::new_v4();
        let unlisted_user_id = Uuid::new_v4();
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "bug-report-operator-gate",
        );
        config.operator_console_org_id = None;
        config.operator_console_allowed_user_ids = vec![];
        config.bug_reports_operator_user_ids = vec![listed_user_id];
        // No database is reachable here: every path below must decide before
        // touching the pool, exactly like `require_operator_access` does when no
        // operator organization is configured.
        let state = build_test_state(build_dummy_pool()?, config);

        let listed_headers = bearer(
            &crate::auth::issue_controller_token(&state.config, &listed_user_id)
                .map_err(|error| anyhow::anyhow!("issue listed token: {error:?}"))?
                .token,
        );
        let unlisted_headers = bearer(
            &crate::auth::issue_controller_token(&state.config, &unlisted_user_id)
                .map_err(|error| anyhow::anyhow!("issue unlisted token: {error:?}"))?
                .token,
        );
        let service_headers = bearer("service-role-token");
        let scoped_headers = bearer(
            &mint_scoped_token(
                &state.config,
                ScopedTokenRequest {
                    audience: Uuid::new_v4().to_string(),
                    subject: listed_user_id.to_string(),
                    project_id: Uuid::new_v4().to_string(),
                    origin_id: None,
                    runtime_id: Some(Uuid::new_v4().to_string()),
                    protocol: None,
                    scopes: vec!["telemetry.write".to_string()],
                    lease_id: None,
                    run_id: None,
                    prefer_runtime: None,
                    ttl_seconds: Some(300),
                },
            )
            .map_err(|error| anyhow::anyhow!("mint scoped token: {error:?}"))?
            .token,
        );

        // Listed interactive user: admitted to bug-report triage only.
        let listed = require_bug_report_operator_access(&state, &listed_headers)
            .await
            .map_err(|error| anyhow::anyhow!("listed user must pass: {error:?}"))?;
        assert_eq!(listed.user_id, Some(listed_user_id));
        assert!(!listed.is_service_role);
        let refused = require_operator_access(&state, &listed_headers)
            .await
            .expect_err("bug-reports-only operator must not pass the full operator gate");
        assert_eq!(refused.0, StatusCode::FORBIDDEN);

        // Everyone else gets exactly the full operator gate's answer.
        let unlisted_bug_reports = require_bug_report_operator_access(&state, &unlisted_headers)
            .await
            .expect_err("unlisted user must be refused");
        let unlisted_operator = require_operator_access(&state, &unlisted_headers)
            .await
            .expect_err("unlisted user must be refused by the operator gate too");
        assert_eq!(unlisted_bug_reports.0, StatusCode::FORBIDDEN);
        assert_eq!(unlisted_bug_reports.0, unlisted_operator.0);
        assert_eq!(unlisted_bug_reports.1.message, unlisted_operator.1.message);

        let service = require_bug_report_operator_access(&state, &service_headers)
            .await
            .map_err(|error| anyhow::anyhow!("service role must pass: {error:?}"))?;
        assert!(service.is_service_role);

        // A runtime-scoped token for the listed user is not an operator session.
        let scoped = require_bug_report_operator_access(&state, &scoped_headers)
            .await
            .expect_err("scoped token must be refused");
        assert_eq!(scoped.0, StatusCode::FORBIDDEN);

        // No bearer at all is an anonymous context; the operator gate answers
        // 403 "operator session required" and so does this one.
        let anonymous = require_bug_report_operator_access(&state, &HeaderMap::new())
            .await
            .expect_err("missing bearer must be refused");
        let anonymous_operator = require_operator_access(&state, &HeaderMap::new())
            .await
            .expect_err("missing bearer must be refused by the operator gate too");
        assert_eq!(anonymous.0, StatusCode::FORBIDDEN);
        assert_eq!(anonymous.0, anonymous_operator.0);
        assert_eq!(anonymous.1.message, anonymous_operator.1.message);
        Ok(())
    }
}
