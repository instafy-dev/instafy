use std::path::Path as FsPath;
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
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
const MAX_CUSTOMER_SCREENSHOT_DIMENSION: u32 = 8_192;
const MAX_CUSTOMER_SCREENSHOT_PIXELS: u64 = 25_000_000;
const MAX_CUSTOMER_ATTACHMENT_BYTES_PER_24_HOURS: i64 = 32 * 1024 * 1024;
const MAX_SUPPORT_REQUEST_BYTES: usize = 20 * 1024 * 1024;
const MAX_SUPPORT_MESSAGE_CHARS: usize = 500;
const MAX_SUPPORT_DETAILS_BYTES: usize = 20_000;
const MAX_SUPPORT_METADATA_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_LOGS_BYTES: usize = 1024 * 1024;
const MAX_LOG_ENTRIES: usize = 500;
const MAX_SUPPORT_THREAD_MESSAGE_CHARS: usize = 4_000;
const MAX_SUPPORT_THREAD_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_SUPPORT_THREAD_REQUEST_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_THREAD_MESSAGES_PER_RESPONSE: i64 = 100;
const MAX_SUPPORT_THREAD_AUTHORED_MESSAGES: i64 = 5_000;
const MAX_SUPPORT_THREAD_SYSTEM_MESSAGES: i64 = 1_000;
const SUPPORT_THREAD_POSTS_PER_MINUTE: usize = 30;
// Durable per-account rolling limits. These are intentionally generous for real
// troubleshooting while bounding the amount of customer work one account can
// enqueue for the support/devbox pipeline.
const MAX_CUSTOMER_REPORTS_PER_24_HOURS: i64 = 25;
const MAX_CUSTOMER_MESSAGES_PER_24_HOURS: i64 = 250;
const REDACTED_DIAGNOSTIC_VALUE: &str = "[REDACTED]";
const DEFAULT_LIST_LIMIT: i64 = 25;
const MAX_LIST_LIMIT: i64 = 100;
const BUG_REPORT_COOLDOWN: Duration = Duration::from_secs(10);

fn retry_after_seconds(duration: Duration) -> u64 {
    duration
        .as_secs()
        .saturating_add(u64::from(duration.subsec_nanos() > 0))
        .max(1)
}

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
    client_request_id: Option<String>,
    expected_user_id: Option<String>,
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
    expected_user_id: Option<String>,
    limit: Option<i64>,
    status: Option<String>,
    reporter_email: Option<String>,
    project_id: Option<String>,
    search: Option<String>,
    before_created_at: Option<String>,
    before_created_id: Option<String>,
    before_activity_at: Option<String>,
    before_activity_id: Option<String>,
    needs_response: Option<bool>,
    after_customer_activity_at: Option<String>,
    after_customer_activity_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBugReportRequest {
    status: Option<String>,
    priority: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    assignee: Option<Option<String>>,
    labels: Option<JsonValue>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    duplicate_of: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    github_issue_url: Option<Option<String>>,
    resolved_at: Option<String>,
    updated_at: Option<String>,
    metadata: Option<JsonValue>,
    expected_updated_at: Option<String>,
    expected_customer_last_message_at: Option<String>,
}

/// Distinguish an omitted PATCH field (preserve) from an explicit JSON null
/// (clear). Serde's ordinary nested Option handling otherwise maps both cases
/// to the outer None.
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
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
    activity_at: String,
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
    customer_last_message_at: Option<String>,
    support_last_message_at: Option<String>,
    customer_last_reviewed_at: Option<String>,
    needs_response: bool,
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
    activity_at: String,
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
    customer_last_message_at: Option<String>,
    support_last_message_at: Option<String>,
    customer_last_reviewed_at: Option<String>,
    needs_response: bool,
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
    reports: Vec<OperatorBugReportListItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorBugReportListItem {
    id: String,
    created_at: String,
    activity_at: String,
    updated_at: String,
    message: String,
    status: String,
    priority: String,
    assignee: Option<String>,
    labels: JsonValue,
    duplicate_of: Option<String>,
    github_issue_url: Option<String>,
    resolved_at: Option<String>,
    customer_last_message_at: Option<String>,
    support_last_message_at: Option<String>,
    customer_last_reviewed_at: Option<String>,
    needs_response: bool,
    reporter_kind: String,
    project_id: Option<String>,
    screenshot_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBugReportSummary {
    id: String,
    created_at: String,
    activity_at: String,
    updated_at: String,
    customer_last_message_at: Option<String>,
    support_last_message_at: Option<String>,
    resolved_at: Option<String>,
    has_unread_support_activity: bool,
    has_unread_resolution: bool,
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
            activity_at: report.activity_at,
            updated_at: report.updated_at,
            customer_last_message_at: report.customer_last_message_at,
            support_last_message_at: report.support_last_message_at,
            resolved_at: report.resolved_at,
            has_unread_support_activity: false,
            has_unread_resolution: false,
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
    has_more: bool,
    next_cursor: Option<CustomerBugReportListCursor>,
    unread_count: i64,
    unread_resolution_count: i64,
    unnotified_resolution_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum CustomerBugReportListCursor {
    Activity {
        #[serde(rename = "activityAt")]
        activity_at: String,
        id: String,
    },
    Created {
        #[serde(rename = "createdAt")]
        created_at: String,
        id: String,
    },
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
    activity_at: String,
    updated_at: String,
    customer_last_message_at: Option<String>,
    support_last_message_at: Option<String>,
    resolved_at: Option<String>,
    has_unread_support_activity: bool,
    has_unread_resolution: bool,
    message: String,
    details: Option<String>,
    status: String,
    project_id: Option<String>,
    screenshots: Vec<CustomerBugReportAttachment>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum BugReportDetailResponseView {
    Customer(CustomerBugReportDetailResponse),
    Operator(BugReportDetailResponse),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBugReportMessageRequest {
    body: String,
    client_request_id: Option<String>,
    customer_last_message_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportMessageResponse {
    id: String,
    author_type: String,
    body: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportMessagesResponse {
    messages: Vec<BugReportMessageResponse>,
    has_more: bool,
    next_cursor: Option<BugReportMessageListCursor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BugReportMessageListCursor {
    created_at: String,
    id: String,
}

#[derive(Debug, Default, Deserialize)]
struct ListBugReportMessagesQuery {
    limit: Option<i64>,
    before_created_at: Option<String>,
    before_message_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBugReportMessageResponse {
    message: BugReportMessageResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeSupportActivityRequest {
    seen_through: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeSupportActivityResponse {
    acknowledged_through: String,
    has_unread_support_activity: bool,
    has_unread_resolution: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResolutionAlertsResponse {
    claimed_count: i64,
    latest_report_id: Option<String>,
    latest_resolved_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResolutionAlertsRequest {
    expected_user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkBugReportMessagesReviewedRequest {
    customer_last_message_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkBugReportMessagesReviewedResponse {
    customer_last_reviewed_at: String,
    needs_response: bool,
}

pub(crate) fn router() -> Router<AppState> {
    let support = Router::new()
        .route(
            "/support/reports",
            post(post_support_report).get(list_support_reports),
        )
        .route("/support/reports/:bug_report_id", get(get_support_report))
        .route(
            "/support/reports/:bug_report_id/acknowledge",
            post(acknowledge_support_report_activity),
        )
        .route(
            "/support/resolution-alerts/claim",
            post(claim_support_resolution_alerts),
        )
        .route(
            "/support/reports/:bug_report_id/messages",
            get(list_support_report_messages).post(post_support_report_message),
        )
        .layer(DefaultBodyLimit::max(MAX_SUPPORT_REQUEST_BYTES));
    Router::new()
        .merge(support)
        .route("/bug-reports", post(post_bug_report).get(list_bug_reports))
        .route(
            "/bug-reports/:bug_report_id",
            get(get_bug_report).patch(patch_bug_report),
        )
        .route(
            "/bug-reports/:bug_report_id/triage",
            patch(patch_bug_report_triage),
        )
        .route(
            "/bug-reports/:bug_report_id/messages",
            get(list_operator_bug_report_messages),
        )
        .route(
            "/bug-reports/:bug_report_id/replies",
            post(post_operator_bug_report_reply),
        )
        .route(
            "/bug-reports/:bug_report_id/messages/reviewed",
            post(mark_operator_bug_report_messages_reviewed),
        )
        .layer(axum::middleware::from_fn(add_bug_report_no_store_header))
}

async fn add_bug_report_no_store_header(
    request: Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
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
                BUG_REPORT_COOLDOWN,
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many support report attempts. Try again in {}s.",
                    retry_after_seconds(limit.retry_after)
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
    post_bug_report_with_context(&state, context, true, body).await
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

async fn acknowledge_support_report_activity(
    State(state): State<AppState>,
    Path(bug_report_id_raw): Path<String>,
    request: Request,
) -> Result<Json<AcknowledgeSupportActivityResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, request.headers()).await?;
    let customer_user_id = require_user_session(&context)?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;
    let body_bytes = to_bytes(request.into_body(), 16 * 1024)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError::new(
                    "support acknowledgement request exceeds 16 KiB",
                )),
            )
        })?;
    let body = serde_json::from_slice::<AcknowledgeSupportActivityRequest>(&body_bytes)
        .map_err(|_| bad_request("support acknowledgement request must be valid JSON"))?;
    let seen_through = chrono::DateTime::parse_from_rfc3339(body.seen_through.trim())
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| bad_request("seenThrough must be a valid RFC3339 timestamp"))?;

    ensure_bug_report_tables(&state.pool).await?;
    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start support acknowledgement transaction: {error}"
        ))
    })?;
    let report = transaction
        .query_opt(
            "select status, resolved_at, support_last_message_at, customer_last_seen_support_at
               from bug_reports
              where id = $1 and user_id = $2
              for update",
            &[&bug_report_id, &customer_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load support report: {error}")))?;
    let Some(report) = report else {
        return Err(not_found("bug report not found"));
    };
    let current_support_activity = report
        .get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at")
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "support report does not have support activity to acknowledge",
                )),
            )
        })?;
    if seen_through > current_support_activity {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "seenThrough is newer than the report's current support activity",
            )),
        ));
    }
    let previous_seen =
        report.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_seen_support_at");
    let acknowledged_through = previous_seen
        .filter(|previous| previous >= &seen_through)
        .unwrap_or(seen_through);
    transaction
        .execute(
            "update bug_reports
                set customer_last_seen_support_at = $2,
                    customer_last_notified_resolution_at = case
                      when resolved_at is not null
                        and resolved_at <= $2
                        and (
                          customer_last_notified_resolution_at is null
                          or resolved_at > customer_last_notified_resolution_at
                        )
                      then resolved_at
                      else customer_last_notified_resolution_at
                    end
              where id = $1",
            &[&bug_report_id, &acknowledged_through],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to acknowledge support activity: {error}"))
        })?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize support acknowledgement: {error}"
        ))
    })?;

    let has_unread_support_activity = acknowledged_through < current_support_activity;
    let resolved_at = report.get::<_, Option<chrono::DateTime<Utc>>>("resolved_at");
    let has_unread_resolution = has_unread_resolution(
        &report.get::<_, String>("status"),
        resolved_at.as_ref(),
        Some(&acknowledged_through),
    );
    Ok(Json(AcknowledgeSupportActivityResponse {
        acknowledged_through: acknowledged_through.to_rfc3339(),
        has_unread_support_activity,
        has_unread_resolution,
    }))
}

async fn claim_support_resolution_alerts(
    State(state): State<AppState>,
    request: Request,
) -> Result<Json<ClaimResolutionAlertsResponse>, (StatusCode, Json<ApiError>)> {
    // Authenticate before buffering even this small control request. The parent
    // support router permits screenshot-sized requests for report creation, so
    // relying on its body limit here would expose a needlessly large pre-auth
    // JSON allocation/parsing surface.
    let context = authenticate_request(&state.config, request.headers()).await?;
    let customer_user_id = require_user_session(&context)?;
    let body_bytes = to_bytes(request.into_body(), 16 * 1024)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError::new("support alert claim request exceeds 16 KiB")),
            )
        })?;
    let body = serde_json::from_slice::<ClaimResolutionAlertsRequest>(&body_bytes)
        .map_err(|_| bad_request("support alert claim request must be valid JSON"))?;
    let expected_user_id = parse_uuid_optional(body.expected_user_id.as_deref(), "expectedUserId")?
        .ok_or_else(|| bad_request("expectedUserId is required"))?;
    if expected_user_id != customer_user_id {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "support alert session changed; refresh support and try again",
            )),
        ));
    }
    ensure_bug_report_tables(&state.pool).await?;
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    // A single conditional UPDATE is the cross-tab/cross-device claim. Under
    // PostgreSQL READ COMMITTED, concurrent contenders re-check the predicate
    // after the row lock; only one claimant receives each resolution row.
    let claimed = connection
        .query_one(
            "with claimed as (
              update bug_reports
                set customer_last_notified_resolution_at = resolved_at
              where user_id = $1
                and status = 'resolved'
                and resolved_at is not null
                and (
                  customer_last_seen_support_at is null
                  or resolved_at > customer_last_seen_support_at
                )
                and (
                  customer_last_notified_resolution_at is null
                  or resolved_at > customer_last_notified_resolution_at
                )
              returning id, resolved_at
            )
            select count(*)::bigint as claimed_count,
                   (array_agg(id order by resolved_at desc, id desc))[1] as latest_report_id,
                   max(resolved_at) as latest_resolved_at
              from claimed",
            &[&customer_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to claim resolution alerts: {error}")))?;
    let latest_report_id = claimed.get::<_, Option<Uuid>>("latest_report_id");
    let latest_resolved_at = claimed.get::<_, Option<chrono::DateTime<Utc>>>("latest_resolved_at");
    Ok(Json(ClaimResolutionAlertsResponse {
        claimed_count: claimed.get("claimed_count"),
        latest_report_id: latest_report_id.map(|id| id.to_string()),
        latest_resolved_at: latest_resolved_at.map(|resolved_at| resolved_at.to_rfc3339()),
    }))
}

async fn list_support_report_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bug_report_id_raw): Path<String>,
    Query(query): Query<ListBugReportMessagesQuery>,
) -> Result<Json<BugReportMessagesResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let viewer = require_user_session(&context)?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let exists = connection
        .query_opt(
            "select 1 from bug_reports where id = $1 and user_id = $2",
            &[&bug_report_id, &viewer],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load support report: {error}")))?
        .is_some();
    if !exists {
        return Err(not_found("bug report not found"));
    }
    Ok(Json(
        load_bug_report_messages(&connection, bug_report_id, query).await?,
    ))
}

async fn list_operator_bug_report_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bug_report_id_raw): Path<String>,
    Query(query): Query<ListBugReportMessagesQuery>,
) -> Result<Json<BugReportMessagesResponse>, (StatusCode, Json<ApiError>)> {
    require_bug_report_operator_access(&state, &headers).await?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let exists = connection
        .query_opt("select 1 from bug_reports where id = $1", &[&bug_report_id])
        .await
        .map_err(|error| internal_error(format!("failed to load bug report: {error}")))?
        .is_some();
    if !exists {
        return Err(not_found("bug report not found"));
    }
    Ok(Json(
        load_bug_report_messages(&connection, bug_report_id, query).await?,
    ))
}

async fn post_support_report_message(
    State(state): State<AppState>,
    Path(bug_report_id_raw): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<CreateBugReportMessageResponse>), (StatusCode, Json<ApiError>)> {
    // Authenticate and rate-limit before buffering even this small payload. The support
    // report router has a larger upload allowance for screenshots, so this endpoint must
    // enforce its own narrow wire limit.
    let context = authenticate_request(&state.config, request.headers()).await?;
    let customer_user_id = require_user_session(&context)?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;

    if !state.config.dev_mode {
        state
            .rate_limiter
            .enforce(
                format!("support-thread:user:{customer_user_id}"),
                SUPPORT_THREAD_POSTS_PER_MINUTE,
                Duration::from_secs(60),
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many support messages. Try again in {}s.",
                    retry_after_seconds(limit.retry_after)
                ))
            })?;
    }

    let request = parse_support_thread_message_request(request).await?;
    let (body, client_request_id) = validate_support_thread_message(request)?;
    let (created, message) = create_customer_visible_bug_report_message(
        &state.pool,
        bug_report_id,
        CustomerVisibleMessageAuthor::Customer(customer_user_id),
        body,
        client_request_id,
        None,
    )
    .await?;
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(CreateBugReportMessageResponse { message }),
    ))
}

async fn post_operator_bug_report_reply(
    State(state): State<AppState>,
    Path(bug_report_id_raw): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<CreateBugReportMessageResponse>), (StatusCode, Json<ApiError>)> {
    let context = require_bug_report_operator_access(&state, request.headers()).await?;
    let operator_user_id = require_user_session(&context)?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;
    let request = parse_support_thread_message_request(request).await?;
    let reviewed_customer_activity_at = parse_optional_rfc3339(
        request.customer_last_message_at.as_deref(),
        "customerLastMessageAt",
    )?;
    let (body, client_request_id) = validate_support_thread_message(request)?;
    if contains_sensitive_diagnostic_sentinel(&body) {
        return Err(bad_request(
            "support replies cannot contain credentials, tokens, private keys, or credentialed URLs",
        ));
    }
    let (created, message) = create_customer_visible_bug_report_message(
        &state.pool,
        bug_report_id,
        CustomerVisibleMessageAuthor::Support(Some(operator_user_id)),
        body,
        client_request_id,
        reviewed_customer_activity_at,
    )
    .await?;
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(CreateBugReportMessageResponse { message }),
    ))
}

async fn mark_operator_bug_report_messages_reviewed(
    State(state): State<AppState>,
    Path(bug_report_id_raw): Path<String>,
    request: Request,
) -> Result<Json<MarkBugReportMessagesReviewedResponse>, (StatusCode, Json<ApiError>)> {
    let context = require_bug_report_operator_access(&state, request.headers()).await?;
    let operator_user_id = require_user_session(&context)?;
    let bug_report_id = parse_bug_report_id(&bug_report_id_raw)?;
    let body_bytes = to_bytes(request.into_body(), 16 * 1024)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError::new("review cursor request exceeds 16 KiB")),
            )
        })?;
    let request = serde_json::from_slice::<MarkBugReportMessagesReviewedRequest>(&body_bytes)
        .map_err(|_| bad_request("review cursor request must be valid JSON"))?;
    let expected_customer_activity =
        chrono::DateTime::parse_from_rfc3339(request.customer_last_message_at.trim())
            .map(|value| value.with_timezone(&Utc))
            .map_err(|_| bad_request("customerLastMessageAt must be a valid RFC3339 timestamp"))?;

    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start support review transaction: {error}"
        ))
    })?;
    let report = transaction
        .query_opt(
            "select user_id, customer_last_message_at, customer_last_reviewed_at
               from bug_reports
              where id = $1
              for update",
            &[&bug_report_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load bug report: {error}")))?;
    let Some(report) = report else {
        return Err(not_found("bug report not found"));
    };
    if report.get::<_, Option<Uuid>>("user_id").is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "system bug reports do not have customer activity to review",
            )),
        ));
    }
    let current_customer_activity = report
        .get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at")
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "bug report does not have customer activity to review",
                )),
            )
        })?;
    if current_customer_activity != expected_customer_activity {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "customer activity changed; reload the report before marking it reviewed",
            )),
        ));
    }
    let current_reviewed_activity =
        report.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_reviewed_at");
    if current_reviewed_activity.as_ref() == Some(&expected_customer_activity) {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finish support review cursor replay: {error}"
            ))
        })?;
        return Ok(Json(MarkBugReportMessagesReviewedResponse {
            customer_last_reviewed_at: expected_customer_activity.to_rfc3339(),
            needs_response: false,
        }));
    }
    if current_reviewed_activity
        .as_ref()
        .is_some_and(|reviewed| reviewed > &expected_customer_activity)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "customer activity was already reviewed; reload the report",
            )),
        ));
    }

    transaction
        .execute(
            "update bug_reports
                set customer_last_reviewed_at = $2,
                    customer_last_reviewed_by = $3,
                    updated_at = greatest(
                        clock_timestamp(),
                        updated_at + interval '1 microsecond'
                    )
              where id = $1",
            &[
                &bug_report_id,
                &current_customer_activity,
                &operator_user_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to update support review cursor: {error}"))
        })?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize support review cursor: {error}"))
    })?;

    Ok(Json(MarkBugReportMessagesReviewedResponse {
        customer_last_reviewed_at: current_customer_activity.to_rfc3339(),
        needs_response: false,
    }))
}

async fn parse_support_thread_message_request(
    request: Request,
) -> Result<CreateBugReportMessageRequest, (StatusCode, Json<ApiError>)> {
    let body_bytes = to_bytes(request.into_body(), MAX_SUPPORT_THREAD_REQUEST_BYTES)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ApiError::new("support message request exceeds 64 KiB")),
            )
        })?;
    serde_json::from_slice(&body_bytes)
        .map_err(|_| bad_request("support message request must be valid JSON"))
}

async fn load_bug_report_messages(
    connection: &bb8::PooledConnection<'_, crate::config::PgConnectionManager>,
    bug_report_id: Uuid,
    query: ListBugReportMessagesQuery,
) -> Result<BugReportMessagesResponse, (StatusCode, Json<ApiError>)> {
    let limit = query
        .limit
        .unwrap_or(MAX_SUPPORT_THREAD_MESSAGES_PER_RESPONSE)
        .clamp(1, MAX_SUPPORT_THREAD_MESSAGES_PER_RESPONSE);
    let before_created_at =
        parse_optional_rfc3339(query.before_created_at.as_deref(), "before_created_at")?;
    let before_message_id =
        parse_uuid_optional(query.before_message_id.as_deref(), "before_message_id")?;
    if before_created_at.is_some() != before_message_id.is_some() {
        return Err(bad_request(
            "before_created_at and before_message_id must be provided together",
        ));
    }
    let fetch_limit = limit + 1;
    let mut rows = connection
        .query(
            "select id, author_type, body, created_at
               from bug_report_messages
              where bug_report_id = $1
                and (
                  $2::timestamptz is null
                  or created_at < $2
                  or (created_at = $2 and id < $3)
                )
              order by created_at desc, id desc
              limit $4",
            &[
                &bug_report_id,
                &before_created_at,
                &before_message_id,
                &fetch_limit,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load support report messages: {error}"))
        })?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    rows.reverse();
    let messages = rows
        .into_iter()
        .map(map_bug_report_message_row)
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        messages.first().map(|message| BugReportMessageListCursor {
            created_at: message.created_at.clone(),
            id: message.id.clone(),
        })
    } else {
        None
    };
    Ok(BugReportMessagesResponse {
        messages,
        has_more,
        next_cursor,
    })
}

fn map_bug_report_message_row(row: tokio_postgres::Row) -> BugReportMessageResponse {
    BugReportMessageResponse {
        id: row.get::<_, Uuid>("id").to_string(),
        author_type: row.get("author_type"),
        body: row.get("body"),
        created_at: row
            .get::<_, chrono::DateTime<Utc>>("created_at")
            .to_rfc3339(),
    }
}

#[derive(Clone, Copy)]
enum CustomerVisibleMessageAuthor {
    Customer(Uuid),
    Support(Option<Uuid>),
}

impl CustomerVisibleMessageAuthor {
    fn author_type(self) -> &'static str {
        match self {
            Self::Customer(_) => "customer",
            Self::Support(_) => "support",
        }
    }

    fn user_id(self) -> Option<Uuid> {
        match self {
            Self::Customer(user_id) => Some(user_id),
            Self::Support(user_id) => user_id,
        }
    }
}

async fn create_customer_visible_bug_report_message(
    pool: &PgPool,
    bug_report_id: Uuid,
    author: CustomerVisibleMessageAuthor,
    body: String,
    client_request_id: Option<Uuid>,
    reviewed_customer_activity_at: Option<chrono::DateTime<Utc>>,
) -> Result<(bool, BugReportMessageResponse), (StatusCode, Json<ApiError>)> {
    let mut connection = pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start support message transaction: {error}"
        ))
    })?;

    let report = match author {
        CustomerVisibleMessageAuthor::Customer(user_id) => {
            transaction
                .query_opt(
                    "select user_id, status, customer_last_message_at,
                            customer_last_reviewed_at
                   from bug_reports
                  where id = $1 and user_id = $2
                  for update",
                    &[&bug_report_id, &user_id],
                )
                .await
        }
        CustomerVisibleMessageAuthor::Support(_) => {
            transaction
                .query_opt(
                    "select user_id, status, customer_last_message_at,
                            customer_last_reviewed_at
                   from bug_reports
                  where id = $1
                  for update",
                    &[&bug_report_id],
                )
                .await
        }
    }
    .map_err(|error| internal_error(format!("failed to load bug report: {error}")))?;
    let Some(report) = report else {
        return Err(not_found("bug report not found"));
    };
    let reporter_user_id: Option<Uuid> = report.get("user_id");
    if reporter_user_id.is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "system bug reports do not have a customer-visible support thread",
            )),
        ));
    }
    let status: String = report.get("status");
    let current_customer_activity =
        report.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at");
    let current_reviewed_customer_activity =
        report.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_reviewed_at");
    let author_type = author.author_type();
    let author_user_id = author.user_id();

    if let Some(client_request_id) = client_request_id {
        if let Some(existing) = transaction
            .query_opt(
                "select id, author_type, author_user_id, body,
                        reviewed_customer_activity_at, created_at
                   from bug_report_messages
                  where bug_report_id = $1 and client_request_id = $2",
                &[&bug_report_id, &client_request_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load idempotent support message: {error}"
                ))
            })?
        {
            let existing_author_type: String = existing.get("author_type");
            let existing_author_user_id: Option<Uuid> = existing.get("author_user_id");
            let existing_body: String = existing.get("body");
            let existing_reviewed_customer_activity =
                existing.get::<_, Option<chrono::DateTime<Utc>>>("reviewed_customer_activity_at");
            if existing_author_type != author_type
                || existing_author_user_id != author_user_id
                || existing_body != body
                || existing_reviewed_customer_activity != reviewed_customer_activity_at
            {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "clientRequestId was already used for a different support message",
                    )),
                ));
            }
            let response = map_bug_report_message_row(existing);
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finish support message replay: {error}"))
            })?;
            return Ok((false, response));
        }
    }

    if let Some(expected_customer_activity) = reviewed_customer_activity_at.as_ref() {
        if current_customer_activity.as_ref() != Some(expected_customer_activity) {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "customer activity changed; reload the report before replying",
                )),
            ));
        }
        if current_reviewed_customer_activity
            .as_ref()
            .is_some_and(|reviewed| reviewed >= expected_customer_activity)
        {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "customer activity was already reviewed; reload the report before replying",
                )),
            ));
        }
    }

    if let CustomerVisibleMessageAuthor::Customer(user_id) = author {
        let user_key = format!("support-messages:{user_id}");
        transaction
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
                &[&user_key],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to reserve customer support message: {error}"
                ))
            })?;
        let messages_in_window = transaction
            .query_one(
                "select count(*)::bigint
                   from bug_report_messages
                  where author_type = 'customer'
                    and author_user_id = $1
                    and created_at >= clock_timestamp() - interval '24 hours'",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to check support message daily limit: {error}"
                ))
            })?
            .get::<_, i64>(0);
        if messages_in_window >= MAX_CUSTOMER_MESSAGES_PER_24_HOURS {
            return Err(too_many_requests(format!(
                "Customer support messages are limited to {MAX_CUSTOMER_MESSAGES_PER_24_HOURS} per 24 hours."
            )));
        }
    }

    let counts = transaction
        .query_one(
            "select count(*) filter (
                        where author_type in ('customer', 'support')
                    ) as authored_count,
                    count(*) filter (where author_type = 'system') as system_count
               from bug_report_messages
              where bug_report_id = $1",
            &[&bug_report_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to inspect support thread size: {error}"))
        })?;
    let authored_count = counts.get::<_, i64>("authored_count");
    let system_count = counts.get::<_, i64>("system_count");
    let visible_status_transition = (matches!(author, CustomerVisibleMessageAuthor::Support(_))
        && status == "open")
        || (matches!(author, CustomerVisibleMessageAuthor::Customer(_)) && status == "resolved");
    if authored_count >= MAX_SUPPORT_THREAD_AUTHORED_MESSAGES {
        return Err(too_many_requests(
            "This support thread has reached its message limit.",
        ));
    }
    let append_status_transition =
        visible_status_transition && system_count < MAX_SUPPORT_THREAD_SYSTEM_MESSAGES;

    if matches!(author, CustomerVisibleMessageAuthor::Support(_))
        && status == "open"
        && append_status_transition
    {
        insert_bug_report_system_message(
            &transaction,
            bug_report_id,
            author_user_id,
            "Support started investigating this report.",
        )
        .await?;
    }

    let message_id = Uuid::new_v4();
    let row = transaction
        .query_one(
            "insert into bug_report_messages (
                 id, bug_report_id, author_type, author_user_id, body, client_request_id,
                 reviewed_customer_activity_at, created_at
             ) values ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
             returning id, author_type, body, created_at",
            &[
                &message_id,
                &bug_report_id,
                &author_type,
                &author_user_id,
                &body,
                &client_request_id,
                &reviewed_customer_activity_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to create support message: {error}")))?;
    let message_created_at = row.get::<_, chrono::DateTime<Utc>>("created_at");
    let response = map_bug_report_message_row(row);

    match author {
        CustomerVisibleMessageAuthor::Customer(_) => {
            if status == "resolved" && append_status_transition {
                insert_bug_report_system_message(
                    &transaction,
                    bug_report_id,
                    None,
                    "This report was reopened after a customer follow-up.",
                )
                .await?;
            }
            transaction
                .execute(
                    "update bug_reports
                        set status = case when status = 'resolved' then 'open' else status end,
                            resolved_at = case when status = 'resolved' then null else resolved_at end,
                            customer_last_message_at = $2,
                            updated_at = greatest(
                                clock_timestamp(),
                                updated_at + interval '1 microsecond'
                            )
                      where id = $1",
                    &[&bug_report_id, &message_created_at],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to update support report activity: {error}"))
                })?;
        }
        CustomerVisibleMessageAuthor::Support(_) => {
            transaction
                .execute(
                    "update bug_reports
                        set status = case when status = 'open' then 'in_progress' else status end,
                            support_last_message_at = $2,
                            customer_last_reviewed_at = case
                                when $3::timestamptz is null then customer_last_reviewed_at
                                else $3
                            end,
                            customer_last_reviewed_by = case
                                when $3::timestamptz is null then customer_last_reviewed_by
                                else $4
                            end,
                            updated_at = greatest(
                                clock_timestamp(),
                                updated_at + interval '1 microsecond'
                            )
                      where id = $1",
                    &[
                        &bug_report_id,
                        &message_created_at,
                        &reviewed_customer_activity_at,
                        &author_user_id,
                    ],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to update support report activity: {error}"))
                })?;
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize support message: {error}")))?;
    Ok((true, response))
}

async fn insert_bug_report_system_message(
    transaction: &tokio_postgres::Transaction<'_>,
    bug_report_id: Uuid,
    author_user_id: Option<Uuid>,
    body: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let message_id = Uuid::new_v4();
    transaction
        .execute(
            "insert into bug_report_messages (
                 id, bug_report_id, author_type, author_user_id, body, created_at
             ) values ($1, $2, 'system', $3, $4, clock_timestamp())",
            &[&message_id, &bug_report_id, &author_user_id, &body],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to create support status message: {error}"))
        })?;
    Ok(())
}

fn validate_support_thread_message(
    request: CreateBugReportMessageRequest,
) -> Result<(String, Option<Uuid>), (StatusCode, Json<ApiError>)> {
    let body = request.body.trim().to_string();
    if body.is_empty() {
        return Err(bad_request("support message body is required"));
    }
    if body.chars().any(is_disallowed_support_message_character) {
        return Err(bad_request(
            "support message body contains disallowed control or bidirectional text characters",
        ));
    }
    if body.chars().count() > MAX_SUPPORT_THREAD_MESSAGE_CHARS {
        return Err(bad_request(format!(
            "support message body must be {MAX_SUPPORT_THREAD_MESSAGE_CHARS} characters or shorter"
        )));
    }
    if body.len() > MAX_SUPPORT_THREAD_MESSAGE_BYTES {
        return Err(bad_request(format!(
            "support message body must be {MAX_SUPPORT_THREAD_MESSAGE_BYTES} bytes or smaller"
        )));
    }
    let client_request_id =
        parse_uuid_optional(request.client_request_id.as_deref(), "clientRequestId")?;
    Ok((body, client_request_id))
}

fn is_disallowed_support_message_character(character: char) -> bool {
    matches!(
        character,
        '\u{0000}'..='\u{0008}'
            | '\u{000B}'..='\u{000C}'
            | '\u{000E}'..='\u{001F}'
            | '\u{007F}'..='\u{009F}'
            | '\u{061C}'
            | '\u{200E}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn parse_bug_report_id(raw: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::parse_str(raw.trim()).map_err(|_| bad_request("bug_report_id must be a valid UUID"))
}

fn parse_optional_rfc3339(
    raw: Option<&str>,
    field: &str,
) -> Result<Option<chrono::DateTime<Utc>>, (StatusCode, Json<ApiError>)> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| Some(value.with_timezone(&Utc)))
        .map_err(|_| bad_request(format!("{field} must be a valid RFC3339 timestamp")))
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
    let logs = redact_bug_report_diagnostics(normalize_logs(input.logs));
    let metadata = redact_bug_report_diagnostics(normalize_system_metadata(
        input.metadata,
        fingerprint.as_deref(),
    ));

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
                BUG_REPORT_COOLDOWN,
            )
            .await
            .map_err(|limit| {
                too_many_requests(format!(
                    "Too many bug report attempts. Try again in {}s.",
                    retry_after_seconds(limit.retry_after)
                ))
            })?;
    }
    let operator_submission = !mine_only
        && (is_bug_report_operator(&state, &context)
            || require_operator_access_for_context(&state, context.clone())
                .await
                .is_ok());
    let customer_submission = !context.is_service_role && !operator_submission;
    post_bug_report_with_context(&state, context, customer_submission, body).await
}

async fn post_bug_report_with_context(
    state: &AppState,
    context: RequestContext,
    customer_submission: bool,
    body: CreateBugReportRequest,
) -> Result<(StatusCode, Json<CreateBugReportResponse>), (StatusCode, Json<ApiError>)> {
    if customer_submission {
        let authenticated_user_id = require_user_session(&context)?;
        if let Some(expected_user_id) =
            parse_uuid_optional(body.expected_user_id.as_deref(), "expectedUserId")?
        {
            if expected_user_id != authenticated_user_id {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "support report session changed; reopen the report dialog and try again",
                    )),
                ));
            }
        }
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
    let client_request_id =
        parse_uuid_optional(body.client_request_id.as_deref(), "clientRequestId")?;
    let project_id = parse_uuid_optional(body.project_id.as_deref(), "projectId")?;
    let runtime_id = parse_uuid_optional(body.runtime_id.as_deref(), "runtimeId")?;
    let run_id = parse_uuid_optional(body.run_id.as_deref(), "runId")?;
    let conversation_id = parse_uuid_optional(body.conversation_id.as_deref(), "conversationId")?;
    let metadata = redact_bug_report_diagnostics(body.metadata.unwrap_or_else(|| json!({})));
    let logs = redact_bug_report_diagnostics(normalize_logs(
        body.logs.unwrap_or_else(|| JsonValue::Array(Vec::new())),
    ));
    let screenshots = decode_screenshots(body.screenshots.unwrap_or_default())?;
    if customer_submission {
        validate_customer_screenshots(&screenshots)?;
    }
    let requested_attachment_bytes = screenshots
        .iter()
        .map(|screenshot| screenshot.bytes.len() as i64)
        .sum::<i64>();
    let client_request_fingerprint = if customer_submission && client_request_id.is_some() {
        Some(customer_bug_report_request_fingerprint(
            &message,
            details.as_deref(),
            project_id,
            runtime_id,
            run_id,
            conversation_id,
            &metadata,
            &logs,
            &screenshots,
        )?)
    } else {
        None
    };
    let stored_client_request_id = if customer_submission {
        client_request_id
    } else {
        None
    };

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
            state,
            &transaction,
            &context,
            project_id,
            runtime_id,
            run_id,
            conversation_id,
        )
        .await?;
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
        if let Some(client_request_id) = client_request_id {
            if let Some(existing) = transaction
                .query_opt(
                    "select id, created_at, client_request_fingerprint
                       from bug_reports
                      where user_id = $1 and client_request_id = $2",
                    &[&user_id, &client_request_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load idempotent support report: {error}"))
                })?
            {
                let existing_fingerprint: Option<String> =
                    existing.get("client_request_fingerprint");
                if existing_fingerprint.as_deref() != client_request_fingerprint.as_deref() {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(ApiError::new(
                            "clientRequestId was already used for a different support report",
                        )),
                    ));
                }
                let report_id: Uuid = existing.get("id");
                let created_at: chrono::DateTime<Utc> = existing.get("created_at");
                transaction.commit().await.map_err(|error| {
                    internal_error(format!("failed to finish support report replay: {error}"))
                })?;
                return Ok((
                    StatusCode::OK,
                    Json(CreateBugReportResponse {
                        id: report_id.to_string(),
                        created_at: created_at.to_rfc3339(),
                    }),
                ));
            }
        }
        if requested_attachment_bytes > 0 {
            let attachment_bytes_in_window = transaction
                .query_one(
                    "select coalesce(sum(attachment.byte_size), 0)::bigint
                       from bug_report_attachments attachment
                       join bug_reports report on report.id = attachment.bug_report_id
                      where report.user_id = $1
                        and attachment.byte_size > 0
                        and attachment.created_at >= clock_timestamp() - interval '24 hours'",
                    &[&user_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to check support attachment daily limit: {error}"
                    ))
                })?
                .get::<_, i64>(0);
            if attachment_bytes_in_window.saturating_add(requested_attachment_bytes)
                > MAX_CUSTOMER_ATTACHMENT_BYTES_PER_24_HOURS
            {
                return Err(too_many_requests(format!(
                    "Support report attachments are limited to {MAX_CUSTOMER_ATTACHMENT_BYTES_PER_24_HOURS} bytes per 24 hours."
                )));
            }
        }
        let reports_in_window = transaction
            .query_one(
                "select count(*)::bigint
                   from bug_reports
                  where user_id = $1
                    and created_at >= clock_timestamp() - interval '24 hours'",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to check support report daily limit: {error}"
                ))
            })?
            .get::<_, i64>(0);
        if reports_in_window >= MAX_CUSTOMER_REPORTS_PER_24_HOURS {
            return Err(too_many_requests(format!(
                "Support reports are limited to {MAX_CUSTOMER_REPORTS_PER_24_HOURS} per 24 hours."
            )));
        }
        // Serialize accepted reports across endpoints and controller instances.
        // Use the database clock after taking the lock, not transaction-start
        // time or a controller's wall clock, for the ten-second spacing.
        let retry_after = transaction
            .query_one(
                "select greatest(0, ceil(extract(epoch from (
                            max(created_at) + $2::bigint * interval '1 second'
                            - clock_timestamp()
                        ))))::bigint
                   from bug_reports
                  where user_id = $1",
                &[&user_id, &(BUG_REPORT_COOLDOWN.as_secs() as i64)],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to check support report cooldown: {error}"))
            })?
            .get::<_, i64>(0);
        if retry_after > 0 {
            return Err(too_many_requests(format!(
                "Too many bug reports. Try again in {retry_after}s.",
            )));
        }
    }

    let report_id = Uuid::new_v4();
    let created_at = transaction
        .query_one(
            "insert into bug_reports (
                id, user_id, reporter_email, message, details, project_id, runtime_id, run_id,
                conversation_id, status, metadata, logs, customer_last_message_at, created_at,
                updated_at, client_request_id, client_request_fingerprint
             ) values (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, 'open', $10, $11,
                case when $2::uuid is null then null else statement_timestamp() end,
                statement_timestamp(), statement_timestamp(), $12, $13
             ) returning created_at",
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
                &stored_client_request_id,
                &client_request_fingerprint,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert bug report: {error}")))?
        .get::<_, chrono::DateTime<Utc>>(0);

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
    state: &AppState,
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
                "select provider, capabilities
                   from runtimes
                  where id = $1 and project_id = $2
                  limit 1",
                &[&runtime_id, &project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to validate bug report runtime: {error}"))
            })?;
        let Some(runtime) = runtime else {
            return Err(not_found("runtime not found"));
        };
        let provider: String = runtime.get("provider");
        let capabilities: JsonValue = runtime.get("capabilities");
        crate::runtime::ensure_self_hosted_runtime_access(
            state,
            &provider,
            &capabilities,
            context.user_id,
            context.is_service_role,
        )
        .map_err(|_| not_found("runtime not found"))?;
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
    if mine_only {
        let authenticated_user_id = require_user_session(&context)?;
        if let Some(expected_user_id) =
            parse_uuid_optional(query.expected_user_id.as_deref(), "expected_user_id")?
        {
            if expected_user_id != authenticated_user_id {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "support list session changed; refresh support and try again",
                    )),
                ));
            }
        }
    }

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
    let before_created_id =
        parse_uuid_optional(query.before_created_id.as_deref(), "before_created_id")?;
    if before_created_id.is_some() && before_created_at.is_none() {
        return Err(bad_request("before_created_id requires before_created_at"));
    }
    let after_customer_activity_at = query
        .after_customer_activity_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|parsed| parsed.with_timezone(&Utc))
                .map_err(|_| {
                    bad_request("after_customer_activity_at must be a valid RFC3339 timestamp")
                })
        })
        .transpose()?;
    let after_customer_activity_id = parse_uuid_optional(
        query.after_customer_activity_id.as_deref(),
        "after_customer_activity_id",
    )?;
    if after_customer_activity_id.is_some() != after_customer_activity_at.is_some() {
        return Err(bad_request(
            "after_customer_activity_at and after_customer_activity_id must be provided together",
        ));
    }
    if after_customer_activity_at.is_some() && query.needs_response != Some(true) {
        return Err(bad_request(
            "customer activity cursors require needs_response=true",
        ));
    }
    let before_activity_at =
        parse_optional_rfc3339(query.before_activity_at.as_deref(), "before_activity_at")?;
    let before_activity_id =
        parse_uuid_optional(query.before_activity_id.as_deref(), "before_activity_id")?;
    if before_activity_id.is_some() != before_activity_at.is_some() {
        return Err(bad_request(
            "before_activity_at and before_activity_id must be provided together",
        ));
    }
    if before_created_at.is_some() && before_activity_at.is_some() {
        return Err(bad_request(
            "before_created_at cannot be combined with an activity cursor",
        ));
    }
    let legacy_created_pagination = before_created_at.is_some();
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
        let fetch_limit = limit + 1;
        let mut rows = connection
            .query(
                "select *
                   from (
                        select br.id, br.created_at, br.updated_at,
                               br.customer_last_message_at, br.support_last_message_at,
                               br.customer_last_seen_support_at, br.resolved_at,
                               br.message, br.status, br.project_id,
                               greatest(
                                 br.created_at,
                                 coalesce(br.customer_last_message_at, br.created_at),
                                 coalesce(br.support_last_message_at, br.created_at)
                               ) as activity_at,
                               (select count(*)::bigint
                                  from bug_report_attachments bra
                                 where bra.bug_report_id = br.id) as screenshot_count
                          from bug_reports br
                         where br.user_id = $1
                           and ($3::text is null or br.status = $3)
                           and ($4::uuid is null or br.project_id = $4)
                           and (
                             $5::timestamptz is null
                             or br.created_at < $5
                             or ($10::uuid is not null and br.created_at = $5 and br.id < $10)
                           )
                           and (
                             $6::text is null
                             or br.message ilike ('%' || $6 || '%')
                             or coalesce(br.details, '') ilike ('%' || $6 || '%')
                           )
                   ) customer_reports
                  where (
                    $7::timestamptz is null
                    or activity_at < $7
                    or (activity_at = $7 and id < $8)
                  )
                  order by
                    case when $9 then created_at end desc,
                    case when $9 then id end desc,
                    case when not $9 then activity_at end desc,
                    case when not $9 then id end desc
                  limit $2",
                &[
                    &user_id,
                    &fetch_limit,
                    &status,
                    &project_id,
                    &before_created_at,
                    &search,
                    &before_activity_at,
                    &before_activity_id,
                    &legacy_created_pagination,
                    &before_created_id,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load support reports: {error}")))?;
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let unread_counts = connection
            .query_one(
                "select
                    count(*) filter (
                      where support_last_message_at is not null
                        and (
                          customer_last_seen_support_at is null
                          or support_last_message_at > customer_last_seen_support_at
                        )
                    )::bigint as unread_count,
                    count(*) filter (
                      where status = 'resolved'
                        and resolved_at is not null
                        and (
                          customer_last_seen_support_at is null
                          or resolved_at > customer_last_seen_support_at
                        )
                    )::bigint as unread_resolution_count,
                    count(*) filter (
                      where status = 'resolved'
                        and resolved_at is not null
                        and (
                          customer_last_seen_support_at is null
                          or resolved_at > customer_last_seen_support_at
                        )
                        and (
                          customer_last_notified_resolution_at is null
                          or resolved_at > customer_last_notified_resolution_at
                        )
                    )::bigint as unnotified_resolution_count
                   from bug_reports
                  where user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to count unread support activity: {error}"))
            })?;
        let reports = rows
            .into_iter()
            .map(|row| {
                let support_last_message_at =
                    row.get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at");
                let customer_last_seen_support_at =
                    row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_seen_support_at");
                let resolved_at = row.get::<_, Option<chrono::DateTime<Utc>>>("resolved_at");
                let has_unread_support_activity = has_unread_support_activity(
                    support_last_message_at.as_ref(),
                    customer_last_seen_support_at.as_ref(),
                );
                let status = row.get::<_, String>("status");
                let has_unread_resolution = has_unread_resolution(
                    &status,
                    resolved_at.as_ref(),
                    customer_last_seen_support_at.as_ref(),
                );
                CustomerBugReportSummary {
                    id: row.get::<_, Uuid>("id").to_string(),
                    created_at: row
                        .get::<_, chrono::DateTime<Utc>>("created_at")
                        .to_rfc3339(),
                    activity_at: row
                        .get::<_, chrono::DateTime<Utc>>("activity_at")
                        .to_rfc3339(),
                    updated_at: row
                        .get::<_, chrono::DateTime<Utc>>("updated_at")
                        .to_rfc3339(),
                    customer_last_message_at: row
                        .get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at")
                        .map(|value| value.to_rfc3339()),
                    support_last_message_at: support_last_message_at
                        .map(|value| value.to_rfc3339()),
                    has_unread_support_activity,
                    resolved_at: resolved_at.map(|value| value.to_rfc3339()),
                    has_unread_resolution,
                    message: row.get("message"),
                    status,
                    project_id: row
                        .get::<_, Option<Uuid>>("project_id")
                        .map(|value| value.to_string()),
                    screenshot_count: row.get("screenshot_count"),
                }
            })
            .collect::<Vec<_>>();
        let next_cursor = if has_more {
            reports.last().map(|report| {
                if legacy_created_pagination {
                    CustomerBugReportListCursor::Created {
                        created_at: report.created_at.clone(),
                        id: report.id.clone(),
                    }
                } else {
                    CustomerBugReportListCursor::Activity {
                        activity_at: report.activity_at.clone(),
                        id: report.id.clone(),
                    }
                }
            })
        } else {
            None
        };
        return Ok(Json(BugReportListResponseView::Customer(
            CustomerBugReportListResponse {
                reports,
                has_more,
                next_cursor,
                unread_count: unread_counts.get("unread_count"),
                unread_resolution_count: unread_counts.get("unread_resolution_count"),
                unnotified_resolution_count: unread_counts.get("unnotified_resolution_count"),
            },
        )));
    }

    let rows = connection
        .query(
            "select br.id, br.user_id, br.created_at, br.updated_at,
                        br.customer_last_message_at, br.support_last_message_at,
                        br.customer_last_reviewed_at, left(br.message, 500) as message,
                        br.status, br.priority,
                        br.assignee, br.labels, br.duplicate_of, br.github_issue_url,
                        br.resolved_at, br.project_id,
                        (select count(*)::bigint from bug_report_attachments bra where bra.bug_report_id = br.id) as screenshot_count
                   from bug_reports br
                  where ($2::text is null or br.status = $2)
                    and ($3::text is null or lower(coalesce(br.reporter_email, '')) = lower($3))
                    and ($4::uuid is null or br.project_id = $4)
                    and (
                      $5::timestamptz is null
                      or br.created_at < $5
                      or ($10::uuid is not null and br.created_at = $5 and br.id < $10)
                    )
                    and (
                      $6::text is null
                      or br.message ilike ('%' || $6 || '%')
                      or coalesce(br.details, '') ilike ('%' || $6 || '%')
                      or coalesce(br.reporter_email, '') ilike ('%' || $6 || '%')
                      or coalesce(br.project_id::text, '') ilike ('%' || $6 || '%')
                      or coalesce(br.conversation_id::text, '') ilike ('%' || $6 || '%')
                    )
                    and (
                      $7::boolean is null
                      or (
                        br.user_id is not null
                        and
                        br.customer_last_message_at is not null
                        and (
                          br.customer_last_reviewed_at is null
                          or br.customer_last_message_at > br.customer_last_reviewed_at
                        )
                      ) = $7
                    )
                    and (
                      $8::timestamptz is null
                      or br.customer_last_message_at > $8
                      or (
                        br.customer_last_message_at = $8
                        and br.id > $9
                      )
                    )
                  order by
                    case when $7 = true then br.customer_last_message_at end asc,
                    case when $7 = true then br.id end asc,
                    br.created_at desc,
                    br.id desc
                  limit $1",
            &[
                &limit,
                &status,
                &reporter_email,
                &project_id,
                &before_created_at,
                &search,
                &query.needs_response,
                &after_customer_activity_at,
                &after_customer_activity_id,
                &before_created_id,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load bug reports: {error}")))?;

    let reports = rows
        .into_iter()
        .map(map_operator_bug_report_list_row)
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
                "select id, user_id, created_at, updated_at, customer_last_message_at,
                        support_last_message_at, customer_last_seen_support_at, resolved_at,
                        message, details, status, project_id
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
        let support_last_message_at =
            row.get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at");
        let customer_last_seen_support_at =
            row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_seen_support_at");
        let resolved_at = row.get::<_, Option<chrono::DateTime<Utc>>>("resolved_at");
        let has_unread_support_activity = has_unread_support_activity(
            support_last_message_at.as_ref(),
            customer_last_seen_support_at.as_ref(),
        );
        let status = row.get::<_, String>("status");
        let has_unread_resolution = has_unread_resolution(
            &status,
            resolved_at.as_ref(),
            customer_last_seen_support_at.as_ref(),
        );
        return Ok(Json(BugReportDetailResponseView::Customer(
            CustomerBugReportDetailResponse {
                id: row.get::<_, Uuid>("id").to_string(),
                created_at: row
                    .get::<_, chrono::DateTime<Utc>>("created_at")
                    .to_rfc3339(),
                activity_at: customer_visible_activity_at(
                    row.get("created_at"),
                    row.get("customer_last_message_at"),
                    row.get("support_last_message_at"),
                )
                .to_rfc3339(),
                updated_at: row
                    .get::<_, chrono::DateTime<Utc>>("updated_at")
                    .to_rfc3339(),
                customer_last_message_at: row
                    .get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at")
                    .map(|value| value.to_rfc3339()),
                support_last_message_at: support_last_message_at.map(|value| value.to_rfc3339()),
                resolved_at: resolved_at.map(|value| value.to_rfc3339()),
                has_unread_support_activity,
                has_unread_resolution,
                message: row.get("message"),
                details: row.get("details"),
                status,
                project_id: row
                    .get::<_, Option<Uuid>>("project_id")
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

    let customer_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at");
    let support_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at");
    let customer_last_reviewed_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_reviewed_at");
    let needs_response = bug_report_needs_response(
        customer_last_message_at.as_ref(),
        customer_last_reviewed_at.as_ref(),
    );

    Ok(Json(BugReportDetailResponseView::Operator(
        BugReportDetailResponse {
            id: row.get::<_, Uuid>("id").to_string(),
            created_at: row
                .get::<_, chrono::DateTime<Utc>>("created_at")
                .to_rfc3339(),
            activity_at: customer_visible_activity_at(
                row.get("created_at"),
                customer_last_message_at,
                support_last_message_at,
            )
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
            customer_last_message_at: customer_last_message_at.map(|value| value.to_rfc3339()),
            support_last_message_at: support_last_message_at.map(|value| value.to_rfc3339()),
            customer_last_reviewed_at: customer_last_reviewed_at.map(|value| value.to_rfc3339()),
            needs_response,
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
    update_bug_report(state, headers, bug_report_id_raw, body, false).await
}

/// Guarded clients use a separate route so an older controller cannot silently
/// ignore concurrency fields on the legacy PATCH endpoint during rollout.
async fn patch_bug_report_triage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bug_report_id_raw): Path<String>,
    Json(body): Json<UpdateBugReportRequest>,
) -> Result<Json<BugReportSummary>, (StatusCode, Json<ApiError>)> {
    update_bug_report(state, headers, bug_report_id_raw, body, true).await
}

async fn update_bug_report(
    state: AppState,
    headers: HeaderMap,
    bug_report_id_raw: String,
    body: UpdateBugReportRequest,
    require_expected_version: bool,
) -> Result<Json<BugReportSummary>, (StatusCode, Json<ApiError>)> {
    let operator_context = require_bug_report_operator_access(&state, &headers).await?;
    ensure_bug_report_tables(&state.pool).await?;

    let bug_report_id = Uuid::parse_str(bug_report_id_raw.trim())
        .map_err(|_| bad_request("bug_report_id must be a valid UUID"))?;
    let duplicate_of = parse_uuid_optional(
        body.duplicate_of
            .as_ref()
            .and_then(|value| value.as_deref()),
        "duplicateOf",
    )?;
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
        .as_ref()
        .and_then(|value| value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let github_issue_url = body
        .github_issue_url
        .as_ref()
        .and_then(|value| value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    // Retain validation for legacy callers that still send resolvedAt, but the
    // resolution timestamp is controller-owned and derived only from status
    // transitions.
    let _legacy_resolved_at = body
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
    let expected_customer_last_message_at = parse_optional_rfc3339(
        body.expected_customer_last_message_at.as_deref(),
        "expectedCustomerLastMessageAt",
    )?;
    let expected_updated_at =
        parse_optional_rfc3339(body.expected_updated_at.as_deref(), "expectedUpdatedAt")?;
    if require_expected_version && expected_updated_at.is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "expectedUpdatedAt is required for guarded triage; reload the report before applying this update",
            )),
        ));
    }
    // Retain validation for legacy callers that still send updatedAt, but the
    // concurrency version is server-owned so every successful mutation advances it.
    let _legacy_updated_at = body
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|parsed| parsed.with_timezone(&Utc))
                .map_err(|_| bad_request("updatedAt must be a valid RFC3339 timestamp"))
        })
        .transpose()?;
    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to acquire database connection: {error}"))
    })?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start bug report update: {error}")))?;

    let existing_row = transaction
        .query_opt(
            "select * from bug_reports where id = $1 for update",
            &[&bug_report_id],
        )
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
    let owner_user_id: Option<Uuid> = existing_row.get("user_id");
    let current_customer_last_message_at =
        existing_row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at");
    let current_updated_at = existing_row.get::<_, chrono::DateTime<Utc>>("updated_at");
    if expected_updated_at
        .as_ref()
        .is_some_and(|expected| expected != &current_updated_at)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "bug report changed; reload it before applying this update",
            )),
        ));
    }

    let status_changed = status
        .as_deref()
        .map(|value| value != existing_status)
        .unwrap_or(false);
    let next_status = status.unwrap_or(existing_status);
    let visible_status_change = status_changed && owner_user_id.is_some();
    let append_visible_status_message = if visible_status_change {
        let system_message_count = transaction
            .query_one(
                "select count(*)::bigint
                   from bug_report_messages
                  where bug_report_id = $1 and author_type = 'system'",
                &[&bug_report_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to inspect support thread size: {error}"))
            })?
            .get::<_, i64>(0);
        system_message_count < MAX_SUPPORT_THREAD_SYSTEM_MESSAGES
    } else {
        false
    };
    let resolving_customer_report =
        status_changed && next_status == "resolved" && owner_user_id.is_some();
    let resolved_customer_activity_ack = if resolving_customer_report {
        let expected = expected_customer_last_message_at.ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "expectedCustomerLastMessageAt is required to resolve a customer report",
                )),
            )
        })?;
        if current_customer_last_message_at != Some(expected) {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "customer activity changed; reload the report before resolving it",
                )),
            ));
        }
        Some(expected)
    } else {
        None
    };
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
    let next_resolved_at = existing_resolved_at;
    let next_metadata = body.metadata.unwrap_or(existing_metadata);

    let row = transaction
        .query_opt(
            "with update_clock as (
                select greatest(
                    clock_timestamp(),
                    $14::timestamptz + interval '1 microsecond'
                ) as changed_at
             )
             update bug_reports
                set status = $2,
                    priority = $3,
                    assignee = $4,
                    labels = $5,
                    duplicate_of = $6,
                    github_issue_url = $7,
                    resolved_at = case
                        when $13 then case
                            when $2 = 'resolved' then update_clock.changed_at
                            else null
                        end
                        else $8
                    end,
                    updated_at = update_clock.changed_at,
                    metadata = $9,
                    support_last_message_at = case
                        when $10 then clock_timestamp()
                        else support_last_message_at
                    end,
                    customer_last_reviewed_at = case
                        when $11::timestamptz is not null then $11
                        else customer_last_reviewed_at
                    end,
                    customer_last_reviewed_by = case
                        when $11::timestamptz is not null then $12
                        else customer_last_reviewed_by
                    end
               from update_clock
              where bug_reports.id = $1
              returning bug_reports.*,
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
                &PgJson(&next_metadata),
                &visible_status_change,
                &resolved_customer_activity_ack,
                &operator_context.user_id,
                &status_changed,
                &current_updated_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update bug report: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("bug report not found"));
    };

    if append_visible_status_message {
        insert_bug_report_system_message(
            &transaction,
            bug_report_id,
            operator_context.user_id,
            customer_visible_status_message(&next_status),
        )
        .await?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize bug report update: {error}"))
    })?;

    Ok(Json(map_bug_report_summary_row(row)))
}

fn customer_visible_status_message(status: &str) -> &'static str {
    match status {
        "in_progress" => "Support started investigating this report.",
        "resolved" => "Support marked this report as resolved.",
        _ => "Support reopened this report.",
    }
}

fn map_operator_bug_report_list_row(row: tokio_postgres::Row) -> OperatorBugReportListItem {
    let created_at = row.get::<_, chrono::DateTime<Utc>>("created_at");
    let customer_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at");
    let support_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at");
    let customer_last_reviewed_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_reviewed_at");
    let reporter_user_id = row.get::<_, Option<Uuid>>("user_id");
    OperatorBugReportListItem {
        id: row.get::<_, Uuid>("id").to_string(),
        created_at: created_at.to_rfc3339(),
        activity_at: customer_visible_activity_at(
            created_at,
            customer_last_message_at,
            support_last_message_at,
        )
        .to_rfc3339(),
        updated_at: row
            .get::<_, chrono::DateTime<Utc>>("updated_at")
            .to_rfc3339(),
        message: row.get("message"),
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
        customer_last_message_at: customer_last_message_at.map(|value| value.to_rfc3339()),
        support_last_message_at: support_last_message_at.map(|value| value.to_rfc3339()),
        customer_last_reviewed_at: customer_last_reviewed_at.map(|value| value.to_rfc3339()),
        needs_response: bug_report_needs_response(
            customer_last_message_at.as_ref(),
            customer_last_reviewed_at.as_ref(),
        ),
        reporter_kind: if reporter_user_id.is_some() {
            "customer".to_string()
        } else {
            "system".to_string()
        },
        project_id: row
            .get::<_, Option<Uuid>>("project_id")
            .map(|value| value.to_string()),
        screenshot_count: row.get("screenshot_count"),
    }
}

fn map_bug_report_summary_row(row: tokio_postgres::Row) -> BugReportSummary {
    let created_at = row.get::<_, chrono::DateTime<Utc>>("created_at");
    let customer_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_message_at");
    let support_last_message_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("support_last_message_at");
    let customer_last_reviewed_at =
        row.get::<_, Option<chrono::DateTime<Utc>>>("customer_last_reviewed_at");
    let needs_response = bug_report_needs_response(
        customer_last_message_at.as_ref(),
        customer_last_reviewed_at.as_ref(),
    );
    BugReportSummary {
        id: row.get::<_, Uuid>("id").to_string(),
        created_at: created_at.to_rfc3339(),
        activity_at: customer_visible_activity_at(
            created_at,
            customer_last_message_at,
            support_last_message_at,
        )
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
        customer_last_message_at: customer_last_message_at.map(|value| value.to_rfc3339()),
        support_last_message_at: support_last_message_at.map(|value| value.to_rfc3339()),
        customer_last_reviewed_at: customer_last_reviewed_at.map(|value| value.to_rfc3339()),
        needs_response,
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

fn bug_report_needs_response(
    customer_last_message_at: Option<&chrono::DateTime<Utc>>,
    customer_last_reviewed_at: Option<&chrono::DateTime<Utc>>,
) -> bool {
    customer_last_message_at.is_some_and(|customer_activity| {
        customer_last_reviewed_at
            .map(|reviewed| customer_activity > reviewed)
            .unwrap_or(true)
    })
}

fn has_unread_support_activity(
    support_last_message_at: Option<&chrono::DateTime<Utc>>,
    customer_last_seen_support_at: Option<&chrono::DateTime<Utc>>,
) -> bool {
    support_last_message_at.is_some_and(|support_activity| {
        customer_last_seen_support_at
            .map(|seen| support_activity > seen)
            .unwrap_or(true)
    })
}

fn has_unread_resolution(
    status: &str,
    resolved_at: Option<&chrono::DateTime<Utc>>,
    customer_last_seen_support_at: Option<&chrono::DateTime<Utc>>,
) -> bool {
    status == "resolved"
        && resolved_at.is_some_and(|resolution| {
            customer_last_seen_support_at
                .map(|seen| resolution > seen)
                .unwrap_or(true)
        })
}

fn customer_visible_activity_at(
    created_at: chrono::DateTime<Utc>,
    customer_last_message_at: Option<chrono::DateTime<Utc>>,
    support_last_message_at: Option<chrono::DateTime<Utc>>,
) -> chrono::DateTime<Utc> {
    customer_last_message_at
        .into_iter()
        .chain(support_last_message_at)
        .fold(created_at, std::cmp::max)
}

#[derive(Debug)]
struct DecodedScreenshot {
    file_name: String,
    media_type: String,
    bytes: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
fn customer_bug_report_request_fingerprint(
    message: &str,
    details: Option<&str>,
    project_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    run_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    metadata: &JsonValue,
    logs: &JsonValue,
    screenshots: &[DecodedScreenshot],
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let attachments = screenshots
        .iter()
        .map(|screenshot| {
            json!({
                "fileName": screenshot.file_name,
                "mediaType": screenshot.media_type,
                "byteLength": screenshot.bytes.len(),
                "sha256": format!("{:x}", Sha256::digest(&screenshot.bytes)),
            })
        })
        .collect::<Vec<_>>();
    let canonical = json!({
        "version": 1,
        "message": message,
        "details": details,
        "projectId": project_id.map(|value| value.to_string()),
        "runtimeId": runtime_id.map(|value| value.to_string()),
        "runId": run_id.map(|value| value.to_string()),
        "conversationId": conversation_id.map(|value| value.to_string()),
        "metadata": metadata,
        "logs": logs,
        "screenshots": attachments,
    });
    let encoded =
        serde_json::to_vec(&canonicalize_json_for_fingerprint(&canonical)).map_err(|error| {
            internal_error(format!("failed to fingerprint support report: {error}"))
        })?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn canonicalize_json_for_fingerprint(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(entries) => {
            let mut entries = entries.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            JsonValue::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonicalize_json_for_fingerprint(value)))
                    .collect(),
            )
        }
        JsonValue::Array(entries) => JsonValue::Array(
            entries
                .iter()
                .map(canonicalize_json_for_fingerprint)
                .collect(),
        ),
        other => other.clone(),
    }
}

fn validate_customer_bug_report_request(
    request: &CreateBugReportRequest,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if request
        .message
        .chars()
        .any(is_disallowed_support_message_character)
    {
        return Err(bad_request(
            "support report message contains disallowed control or bidirectional text characters",
        ));
    }
    if request
        .details
        .as_deref()
        .is_some_and(|details| details.chars().any(is_disallowed_support_message_character))
    {
        return Err(bad_request(
            "support report details contain disallowed control or bidirectional text characters",
        ));
    }
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
            || file_name
                .chars()
                .any(is_disallowed_support_message_character)
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
        let Some((width, height)) =
            customer_image_dimensions(screenshot.media_type.as_str(), screenshot.bytes.as_slice())
        else {
            return Err(bad_request(
                "support report screenshots must have a readable PNG, JPEG, or WebP header matching mediaType",
            ));
        };
        let pixels = u64::from(width) * u64::from(height);
        if width > MAX_CUSTOMER_SCREENSHOT_DIMENSION
            || height > MAX_CUSTOMER_SCREENSHOT_DIMENSION
            || pixels > MAX_CUSTOMER_SCREENSHOT_PIXELS
        {
            return Err(bad_request(format!(
                "support report screenshots may be at most {MAX_CUSTOMER_SCREENSHOT_DIMENSION} pixels per side and {MAX_CUSTOMER_SCREENSHOT_PIXELS} pixels total"
            )));
        }
    }
    Ok(())
}

fn customer_image_dimensions(media_type: &str, bytes: &[u8]) -> Option<(u32, u32)> {
    match media_type {
        "image/png" => png_dimensions(bytes),
        "image/jpeg" => jpeg_dimensions(bytes),
        "image/webp" => webp_dimensions(bytes),
        _ => None,
    }
    .filter(|(width, height)| *width > 0 && *height > 0)
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 33
        || &bytes[..8] != PNG_SIGNATURE
        || u32::from_be_bytes(bytes[8..12].try_into().ok()?) != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return None;
    }
    let mut cursor = 2usize;
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor] != 0xff {
            cursor += 1;
        }
        while cursor < bytes.len() && bytes[cursor] == 0xff {
            cursor += 1;
        }
        let marker = *bytes.get(cursor)?;
        cursor += 1;
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let segment_length = usize::from(u16::from_be_bytes(
            bytes.get(cursor..cursor + 2)?.try_into().ok()?,
        ));
        if segment_length < 2 || cursor.checked_add(segment_length)? > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if segment_length < 7 {
                return None;
            }
            let height = u32::from(u16::from_be_bytes(
                bytes.get(cursor + 3..cursor + 5)?.try_into().ok()?,
            ));
            let width = u32::from(u16::from_be_bytes(
                bytes.get(cursor + 5..cursor + 7)?.try_into().ok()?,
            ));
            return Some((width, height));
        }
        cursor += segment_length;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let declared_end = usize::try_from(u32::from_le_bytes(bytes[4..8].try_into().ok()?))
        .ok()?
        .checked_add(8)?;
    if declared_end < 20 || declared_end > bytes.len() {
        return None;
    }
    let mut cursor = 12usize;
    while cursor.checked_add(8)? <= declared_end {
        let kind = bytes.get(cursor..cursor + 4)?;
        let size = usize::try_from(u32::from_le_bytes(
            bytes.get(cursor + 4..cursor + 8)?.try_into().ok()?,
        ))
        .ok()?;
        let payload_start = cursor + 8;
        let payload_end = payload_start.checked_add(size)?;
        if payload_end > declared_end {
            return None;
        }
        let payload = &bytes[payload_start..payload_end];
        let dimensions = match kind {
            b"VP8X" if payload.len() >= 10 => {
                let width = 1
                    + u32::from(payload[4])
                    + (u32::from(payload[5]) << 8)
                    + (u32::from(payload[6]) << 16);
                let height = 1
                    + u32::from(payload[7])
                    + (u32::from(payload[8]) << 8)
                    + (u32::from(payload[9]) << 16);
                Some((width, height))
            }
            b"VP8 " if payload.len() >= 10 && payload[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u32::from(u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff);
                let height = u32::from(u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff);
                Some((width, height))
            }
            b"VP8L" if payload.len() >= 5 && payload[0] == 0x2f => {
                let bits = u32::from_le_bytes([payload[1], payload[2], payload[3], payload[4]]);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            _ => None,
        };
        if dimensions.is_some() {
            return dimensions;
        }
        cursor = payload_end.checked_add(size % 2)?;
    }
    None
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

fn redact_bug_report_diagnostics(value: JsonValue) -> JsonValue {
    redact_bug_report_diagnostics_at_depth(value, 0)
}

fn redact_bug_report_diagnostics_at_depth(value: JsonValue, depth: usize) -> JsonValue {
    match value {
        JsonValue::Object(entries) => {
            let named_secret_value = entries
                .get("name")
                .or_else(|| entries.get("key"))
                .and_then(JsonValue::as_str)
                .map(is_sensitive_diagnostic_key)
                .unwrap_or(false);
            JsonValue::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| {
                        let redact = is_sensitive_diagnostic_key(&key)
                            || (named_secret_value
                                && matches!(
                                    normalize_diagnostic_key(&key).as_str(),
                                    "value" | "headervalue"
                                ));
                        if redact {
                            (
                                key,
                                JsonValue::String(REDACTED_DIAGNOSTIC_VALUE.to_string()),
                            )
                        } else {
                            (
                                key,
                                redact_bug_report_diagnostics_at_depth(value, depth + 1),
                            )
                        }
                    })
                    .collect(),
            )
        }
        JsonValue::Array(mut entries) => {
            if entries.len() == 2
                && entries
                    .first()
                    .and_then(JsonValue::as_str)
                    .is_some_and(is_sensitive_diagnostic_key)
            {
                entries[1] = JsonValue::String(REDACTED_DIAGNOSTIC_VALUE.to_string());
            }
            JsonValue::Array(
                entries
                    .into_iter()
                    .map(|value| redact_bug_report_diagnostics_at_depth(value, depth + 1))
                    .collect(),
            )
        }
        JsonValue::String(value) => {
            JsonValue::String(redact_diagnostic_string_at_depth(&value, depth))
        }
        other => other,
    }
}

fn normalize_diagnostic_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_sensitive_diagnostic_key(key: &str) -> bool {
    let key = normalize_diagnostic_key(key);
    matches!(
        key.as_str(),
        "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "secret"
            | "credentials"
            | "credential"
            | "apikey"
            | "privatekey"
            | "clientsecret"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "secretaccesskey"
            | "signingkey"
            | "signature"
            | "xamzcredential"
            | "xamzsignature"
            | "sas"
            | "sastoken"
    ) || key.ends_with("password")
        || key.ends_with("secret")
        || key.ends_with("token")
        || key.ends_with("apikey")
        || key.ends_with("privatekey")
        || key.ends_with("signature")
}

const MAX_STRINGIFIED_DIAGNOSTIC_DEPTH: usize = 8;

fn redact_diagnostic_string_at_depth(value: &str, depth: usize) -> String {
    let bounded = bounded_diagnostic_string(value);
    let trimmed = bounded.trim();
    if depth < MAX_STRINGIFIED_DIAGNOSTIC_DEPTH
        && trimmed
            .as_bytes()
            .first()
            .is_some_and(|byte| matches!(*byte, b'{' | b'['))
    {
        if let Ok(parsed @ (JsonValue::Object(_) | JsonValue::Array(_))) =
            serde_json::from_str::<JsonValue>(trimmed)
        {
            if let Ok(serialized) =
                serde_json::to_string(&redact_bug_report_diagnostics_at_depth(parsed, depth + 1))
            {
                return serialized;
            }
        }
    }

    let urls_sanitized = sanitize_diagnostic_urls(&bounded);
    let ranges = collect_sensitive_diagnostic_ranges(&urls_sanitized);
    apply_redaction_ranges(&urls_sanitized, ranges)
}

fn bounded_diagnostic_string(value: &str) -> String {
    if value.len() <= MAX_SUPPORT_LOGS_BYTES {
        return value.to_string();
    }
    let mut end = MAX_SUPPORT_LOGS_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[TRUNCATED]", &value[..end])
}

fn sanitize_diagnostic_urls(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;
    while let Some(start) = find_next_diagnostic_url(&lower, cursor) {
        let mut end = start;
        while end < value.len() && !is_url_terminator(value.as_bytes()[end]) {
            end += 1;
        }
        output.push_str(&value[cursor..start]);
        let candidate = &value[start..end];
        if let Ok(mut url) = reqwest::Url::parse(candidate) {
            let credentials_cleared =
                url.set_username("").is_ok() && url.set_password(None).is_ok();
            url.set_query(None);
            url.set_fragment(None);
            if credentials_cleared {
                output.push_str(url.as_str());
            } else {
                output.push_str(REDACTED_DIAGNOSTIC_VALUE);
            }
        } else {
            output.push_str(candidate);
        }
        cursor = end;
        if cursor >= value.len() {
            break;
        }
    }
    output.push_str(&value[cursor..]);
    output
}

fn find_next_diagnostic_url(lower: &str, from: usize) -> Option<usize> {
    let bytes = lower.as_bytes();
    let mut cursor = from;
    while cursor + 3 <= bytes.len() {
        let Some(offset) = lower[cursor..].find("://") else {
            return None;
        };
        let colon = cursor + offset;
        let mut start = colon;
        while start > from && is_uri_scheme_tail(bytes[start - 1]) {
            start -= 1;
        }
        if start < colon
            && bytes[start].is_ascii_alphabetic()
            && (start == 0 || !is_uri_scheme_tail(bytes[start - 1]))
        {
            return Some(start);
        }
        cursor = colon + 3;
    }
    None
}

fn is_uri_scheme_tail(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
}

fn is_url_terminator(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(
            byte,
            b'"' | b'\'' | b'<' | b'>' | b'(' | b')' | b'[' | b']' | b'{' | b'}'
        )
}

fn collect_sensitive_diagnostic_ranges(value: &str) -> Vec<(usize, usize)> {
    let lower = value.to_ascii_lowercase();
    let bytes = value.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut ranges = Vec::new();

    collect_secret_assignment_ranges(value, &mut ranges);
    collect_bearer_ranges(bytes, lower_bytes, &mut ranges);
    collect_private_key_ranges(&lower, &mut ranges);
    collect_jwt_ranges(bytes, &mut ranges);
    collect_known_credential_ranges(value, &lower, &mut ranges);
    ranges
}

fn collect_secret_assignment_ranges(value: &str, ranges: &mut Vec<(usize, usize)>) {
    let bytes = value.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if !is_diagnostic_key_byte(bytes[cursor])
            || (cursor > 0 && is_diagnostic_key_byte(bytes[cursor - 1]))
        {
            cursor += 1;
            continue;
        }
        let key_start = cursor;
        while cursor < bytes.len() && is_diagnostic_key_byte(bytes[cursor]) {
            cursor += 1;
        }
        let key_end = cursor;
        if key_end - key_start > 64 || !is_sensitive_diagnostic_key(&value[key_start..key_end]) {
            continue;
        }

        skip_ascii_whitespace(bytes, &mut cursor);
        if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            cursor += 1;
            skip_ascii_whitespace(bytes, &mut cursor);
        }
        if cursor >= bytes.len() || !matches!(bytes[cursor], b':' | b'=') {
            continue;
        }
        cursor += 1;
        skip_ascii_whitespace(bytes, &mut cursor);
        let quote = if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            let quote = Some(bytes[cursor]);
            cursor += 1;
            quote
        } else {
            None
        };
        let secret_start = cursor;
        let normalized_key = normalize_diagnostic_key(&value[key_start..key_end]);
        let header_value = matches!(
            normalized_key.as_str(),
            "authorization" | "proxyauthorization" | "cookie" | "setcookie"
        );
        while cursor < bytes.len()
            && if let Some(quote) = quote {
                bytes[cursor] != quote
            } else if header_value {
                !matches!(bytes[cursor], b'\n' | b'\r' | b',' | b'}' | b']')
            } else {
                !bytes[cursor].is_ascii_whitespace()
                    && !matches!(
                        bytes[cursor],
                        b'&' | b',' | b';' | b'"' | b'\'' | b'}' | b']'
                    )
            }
        {
            cursor += 1;
        }
        if cursor > secret_start {
            ranges.push((secret_start, cursor));
        }
    }
}

fn is_diagnostic_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn skip_ascii_whitespace(bytes: &[u8], cursor: &mut usize) {
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_whitespace() {
        *cursor += 1;
    }
}

fn collect_bearer_ranges(bytes: &[u8], lower: &[u8], ranges: &mut Vec<(usize, usize)>) {
    let marker = b"bearer";
    let mut cursor = 0usize;
    while cursor + marker.len() <= lower.len() {
        let Some(offset) = lower[cursor..]
            .windows(marker.len())
            .position(|window| window == marker)
        else {
            break;
        };
        let start = cursor + offset;
        let mut secret_start = start + marker.len();
        let left_boundary = start == 0 || !is_diagnostic_key_byte(lower[start - 1]);
        if left_boundary && secret_start < lower.len() && lower[secret_start].is_ascii_whitespace()
        {
            skip_ascii_whitespace(bytes, &mut secret_start);
            let mut end = secret_start;
            while end < bytes.len()
                && !bytes[end].is_ascii_whitespace()
                && !matches!(bytes[end], b'&' | b',' | b';' | b'"' | b'\'' | b'}' | b']')
            {
                end += 1;
            }
            if end > secret_start {
                ranges.push((secret_start, end));
            }
        }
        cursor = start + marker.len();
    }
}

fn collect_private_key_ranges(lower: &str, ranges: &mut Vec<(usize, usize)>) {
    let mut cursor = 0usize;
    while let Some(offset) = lower[cursor..].find("-----begin ") {
        let start = cursor + offset;
        let header_end = lower[start..]
            .find('\n')
            .map(|offset| start + offset)
            .unwrap_or(lower.len());
        if lower[start..header_end].contains("private key-----") {
            let end = lower[header_end..]
                .find("-----end ")
                .map(|offset| header_end + offset)
                .map(|footer_start| {
                    lower[footer_start..]
                        .find('\n')
                        .map(|offset| footer_start + offset + 1)
                        .unwrap_or(lower.len())
                })
                .unwrap_or(lower.len());
            ranges.push((start, end));
            cursor = end;
        } else {
            cursor = header_end.max(start + 1);
        }
    }
}

fn collect_jwt_ranges(bytes: &[u8], ranges: &mut Vec<(usize, usize)>) {
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if !is_base64url_or_dot(bytes[cursor])
            || (cursor > 0 && is_base64url_or_dot(bytes[cursor - 1]))
        {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < bytes.len() && is_base64url_or_dot(bytes[cursor]) {
            cursor += 1;
        }
        let candidate = &bytes[start..cursor];
        let segments = candidate.split(|byte| *byte == b'.').collect::<Vec<_>>();
        if candidate.len() >= 32
            && segments.len() == 3
            && segments.iter().all(|segment| segment.len() >= 8)
        {
            ranges.push((start, cursor));
        }
    }
}

fn is_base64url_or_dot(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

fn collect_known_credential_ranges(value: &str, lower: &str, ranges: &mut Vec<(usize, usize)>) {
    for (prefix, minimum_length) in [
        (concat!("github", "_pat_"), 20usize),
        (concat!("gh", "p_"), 20),
        (concat!("gh", "o_"), 20),
        ("ghu_", 20),
        ("ghs_", 20),
        ("ghr_", 20),
        ("sk-", 20),
        ("xoxb-", 20),
        ("xoxp-", 20),
        ("xoxa-", 20),
        ("xoxr-", 20),
        ("xoxs-", 20),
    ] {
        let mut cursor = 0usize;
        while let Some(offset) = lower[cursor..].find(prefix) {
            let start = cursor + offset;
            let mut end = start + prefix.len();
            while end < value.len() && is_credential_byte(value.as_bytes()[end]) {
                end += 1;
            }
            if end - start >= minimum_length {
                ranges.push((start, end));
            }
            cursor = start + prefix.len();
        }
    }

    let bytes = value.as_bytes();
    let mut cursor = 0usize;
    while cursor + 20 <= bytes.len() {
        if bytes[cursor..].starts_with(b"AKIA")
            && bytes[cursor..cursor + 20]
                .iter()
                .all(u8::is_ascii_alphanumeric)
        {
            ranges.push((cursor, cursor + 20));
            cursor += 20;
        } else {
            cursor += 1;
        }
    }
}

fn is_credential_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn apply_redaction_ranges(value: &str, mut ranges: Vec<(usize, usize)>) -> String {
    if ranges.is_empty() {
        return value.to_string();
    }
    ranges.sort_unstable();
    let mut merged = Vec::<(usize, usize)>::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some((_, previous_end)) = merged.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        merged.push((start, end));
    }

    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;
    for (start, end) in merged {
        if start >= value.len() || end <= start {
            continue;
        }
        output.push_str(&value[cursor..start]);
        output.push_str(REDACTED_DIAGNOSTIC_VALUE);
        cursor = end.min(value.len());
    }
    output.push_str(&value[cursor..]);
    output
}

fn contains_sensitive_diagnostic_sentinel(value: &str) -> bool {
    contains_sensitive_diagnostic_sentinel_at_depth(value, 0)
}

fn contains_sensitive_diagnostic_sentinel_at_depth(value: &str, depth: usize) -> bool {
    if !collect_sensitive_diagnostic_ranges(value).is_empty() || contains_credentialed_url(value) {
        return true;
    }
    let trimmed = value.trim();
    if depth >= MAX_STRINGIFIED_DIAGNOSTIC_DEPTH
        || !trimmed
            .as_bytes()
            .first()
            .is_some_and(|byte| matches!(*byte, b'{' | b'['))
    {
        return false;
    }
    serde_json::from_str::<JsonValue>(trimmed)
        .ok()
        .as_ref()
        .is_some_and(|parsed| contains_sensitive_diagnostic_json(parsed, depth + 1))
}

fn contains_sensitive_diagnostic_json(value: &JsonValue, depth: usize) -> bool {
    match value {
        JsonValue::Object(entries) => {
            let named_secret_value = entries
                .get("name")
                .or_else(|| entries.get("key"))
                .and_then(JsonValue::as_str)
                .is_some_and(is_sensitive_diagnostic_key);
            entries.iter().any(|(key, value)| {
                is_sensitive_diagnostic_key(key)
                    || (named_secret_value
                        && matches!(
                            normalize_diagnostic_key(key).as_str(),
                            "value" | "headervalue"
                        ))
                    || contains_sensitive_diagnostic_json(value, depth)
            })
        }
        JsonValue::Array(entries) => {
            (entries.len() == 2
                && entries
                    .first()
                    .and_then(JsonValue::as_str)
                    .is_some_and(is_sensitive_diagnostic_key))
                || entries
                    .iter()
                    .any(|entry| contains_sensitive_diagnostic_json(entry, depth))
        }
        JsonValue::String(value) => contains_sensitive_diagnostic_sentinel_at_depth(value, depth),
        _ => false,
    }
}

fn contains_credentialed_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(start) = find_next_diagnostic_url(&lower, cursor) {
        let mut end = start;
        while end < value.len() && !is_url_terminator(value.as_bytes()[end]) {
            end += 1;
        }
        if let Ok(url) = reqwest::Url::parse(&value[start..end]) {
            if !url.username().is_empty()
                || url.password().is_some()
                || url
                    .query_pairs()
                    .any(|(key, _)| is_sensitive_url_query_key(&key))
            {
                return true;
            }
        }
        cursor = end;
        if cursor >= value.len() {
            break;
        }
    }
    false
}

fn is_sensitive_url_query_key(key: &str) -> bool {
    let normalized = normalize_diagnostic_key(key);
    is_sensitive_diagnostic_key(key)
        || matches!(
            normalized.as_str(),
            "sig" | "code" | "credential" | "xgoogsignature"
        )
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
#[path = "bug_reports_rate_limit_tests.rs"]
mod rate_limit_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_diagnostic_jwt() -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;

        // Exercise the JWT-shaped redaction path without storing a token or
        // signing material in the repository. This signature is deliberately inert.
        format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#),
            URL_SAFE_NO_PAD.encode(br#"{"sub":"synthetic-diagnostic-fixture"}"#),
            URL_SAFE_NO_PAD.encode(b"invalid-test-signature"),
        )
    }

    fn synthetic_diagnostic_pem() -> String {
        let label = "PRIVATE KEY";
        format!("-----BEGIN {label}-----\nprivate-material\n-----END {label}-----")
    }

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
    fn diagnostic_redaction_recurses_through_secrets_headers_and_urls() {
        let redacted = redact_bug_report_diagnostics(json!({
            "pageUrl": "https://alice:password@instafy.dev/studio?access_token=secret#private",
            "authorization": "Bearer top-secret",
            "nested": {
                "githubToken": concat!("gh", "p_", "synthetic-secret"),
                "safeId": "runtime-123",
                "database": "postgresql://db-user:db-password@db.invalid/app?sslmode=require",
                "stringified": "{\"password\":\"nested-secret\",\"url\":\"https://bob:secret@example.invalid/path?sig=signed\"}",
                "headers": [
                    { "name": "Authorization", "value": "Bearer nested-secret" },
                    { "name": "Accept", "value": "application/json" },
                    ["Cookie", "session=opaque"],
                    ["x-api-key", "short-secret"]
                ]
            },
            "message": format!("password: colon-secret bearer inline-secret {}", synthetic_diagnostic_jwt()),
            "pem": format!("{}\nkept", synthetic_diagnostic_pem())
        }));

        assert_eq!(redacted["pageUrl"], "https://instafy.dev/studio");
        assert_eq!(redacted["authorization"], REDACTED_DIAGNOSTIC_VALUE);
        assert_eq!(redacted["nested"]["githubToken"], REDACTED_DIAGNOSTIC_VALUE);
        assert_eq!(redacted["nested"]["safeId"], "runtime-123");
        assert_eq!(
            redacted["nested"]["database"],
            "postgresql://db.invalid/app"
        );
        let stringified: JsonValue = serde_json::from_str(
            redacted["nested"]["stringified"]
                .as_str()
                .expect("stringified JSON should remain a string"),
        )
        .expect("redacted stringified JSON should remain valid");
        assert_eq!(stringified["password"], REDACTED_DIAGNOSTIC_VALUE);
        assert_eq!(stringified["url"], "https://example.invalid/path");
        assert_eq!(
            redacted["nested"]["headers"][0]["value"],
            REDACTED_DIAGNOSTIC_VALUE
        );
        assert_eq!(
            redacted["nested"]["headers"][1]["value"],
            "application/json"
        );
        assert_eq!(
            redacted["nested"]["headers"][2][1],
            REDACTED_DIAGNOSTIC_VALUE
        );
        assert_eq!(
            redacted["nested"]["headers"][3][1],
            REDACTED_DIAGNOSTIC_VALUE
        );
        let message = redacted["message"]
            .as_str()
            .expect("message should be text");
        assert!(!message.contains("colon-secret"));
        assert!(!message.contains("inline-secret"));
        assert!(!message.contains("eyJhbGci"));
        assert!(message.matches(REDACTED_DIAGNOSTIC_VALUE).count() >= 3);
        assert_eq!(redacted["pem"], "[REDACTED]kept");
    }

    #[test]
    fn diagnostic_secret_detection_fails_closed_for_public_support_replies() {
        let unsafe_jwt = synthetic_diagnostic_jwt();
        let unsafe_pem = synthetic_diagnostic_pem();
        for unsafe_body in [
            "Authorization: Bearer operator-secret",
            "password: hunter2",
            "postgresql://alice:secret@db.invalid/app",
            "nats://alice:secret@nats.invalid:4222/events",
            "mqtt://device:secret@broker.invalid/topic",
            "https://example.invalid/callback?code=oauth-secret",
            "https://example.invalid/blob?sig=signed-secret",
            unsafe_jwt.as_str(),
            unsafe_pem.as_str(),
            concat!("github", "_pat_", "abcdefghijklmnopqrstuvwxyz"),
            r#"[["Cookie","session=opaque"]]"#,
            r#"[["x-api-key","short-secret"]]"#,
            r#"{"headers":[{"name":"Authorization","value":"opaque"}]}"#,
        ] {
            assert!(
                contains_sensitive_diagnostic_sentinel(unsafe_body),
                "missed secret sentinel in {unsafe_body:?}"
            );
        }
        assert!(!contains_sensitive_diagnostic_sentinel(
            "Please open https://example.invalid/help?page=2 and tell us what you see."
        ));
    }

    #[test]
    fn support_thread_messages_enforce_character_byte_and_idempotency_id_limits() {
        let valid_id = Uuid::new_v4();
        let (body, parsed_id) = validate_support_thread_message(CreateBugReportMessageRequest {
            body: "  a useful follow-up  ".to_string(),
            client_request_id: Some(valid_id.to_string()),
            customer_last_message_at: None,
        })
        .expect("bounded follow-up should be valid");
        assert_eq!(body, "a useful follow-up");
        assert_eq!(parsed_id, Some(valid_id));

        let too_many_characters = validate_support_thread_message(CreateBugReportMessageRequest {
            body: "x".repeat(MAX_SUPPORT_THREAD_MESSAGE_CHARS + 1),
            client_request_id: None,
            customer_last_message_at: None,
        })
        .expect_err("character limit must be enforced");
        assert_eq!(too_many_characters.0, StatusCode::BAD_REQUEST);

        let too_many_bytes = validate_support_thread_message(CreateBugReportMessageRequest {
            body: "🙂".repeat((MAX_SUPPORT_THREAD_MESSAGE_BYTES / 4) + 1),
            client_request_id: None,
            customer_last_message_at: None,
        })
        .expect_err("UTF-8 byte limit must be enforced");
        assert_eq!(too_many_bytes.0, StatusCode::BAD_REQUEST);

        let invalid_id = validate_support_thread_message(CreateBugReportMessageRequest {
            body: "follow-up".to_string(),
            client_request_id: Some("not-a-uuid".to_string()),
            customer_last_message_at: None,
        })
        .expect_err("clientRequestId must be a UUID");
        assert_eq!(invalid_id.0, StatusCode::BAD_REQUEST);

        for disallowed in ['\u{0007}', '\u{0085}', '\u{202E}', '\u{2066}'] {
            let error = validate_support_thread_message(CreateBugReportMessageRequest {
                body: format!("safe{disallowed}spoofed"),
                client_request_id: None,
                customer_last_message_at: None,
            })
            .expect_err("control and bidi characters must be rejected");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
        }
        validate_support_thread_message(CreateBugReportMessageRequest {
            body: "line one\n\tline two".to_string(),
            client_request_id: None,
            customer_last_message_at: None,
        })
        .expect("normal newline and tab should remain valid");
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
    fn customer_image_headers_are_readable_and_dimension_bounded() {
        fn png_header(width: u32, height: u32) -> Vec<u8> {
            let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            bytes.extend_from_slice(&width.to_be_bytes());
            bytes.extend_from_slice(&height.to_be_bytes());
            bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
            bytes
        }

        fn jpeg_header(width: u16, height: u16) -> Vec<u8> {
            let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
            bytes.extend_from_slice(&height.to_be_bytes());
            bytes.extend_from_slice(&width.to_be_bytes());
            bytes.extend_from_slice(&[0x03, 0x01, 0x11, 0, 0x02, 0x11, 0, 0x03, 0x11, 0]);
            bytes
        }

        fn webp_vp8x_header(width: u32, height: u32) -> Vec<u8> {
            let mut payload = [0u8; 10];
            let width = width - 1;
            let height = height - 1;
            payload[4..7].copy_from_slice(&width.to_le_bytes()[..3]);
            payload[7..10].copy_from_slice(&height.to_le_bytes()[..3]);
            let mut bytes = b"RIFF".to_vec();
            bytes.extend_from_slice(&22u32.to_le_bytes());
            bytes.extend_from_slice(b"WEBPVP8X");
            bytes.extend_from_slice(&10u32.to_le_bytes());
            bytes.extend_from_slice(&payload);
            bytes
        }

        assert_eq!(png_dimensions(&png_header(640, 480)), Some((640, 480)));
        assert_eq!(jpeg_dimensions(&jpeg_header(640, 480)), Some((640, 480)));
        assert_eq!(
            webp_dimensions(&webp_vp8x_header(640, 480)),
            Some((640, 480))
        );
        for (media_type, bytes) in [
            ("image/png", png_header(1, 1)),
            ("image/jpeg", jpeg_header(1, 1)),
            ("image/webp", webp_vp8x_header(1, 1)),
        ] {
            validate_customer_screenshots(&[DecodedScreenshot {
                file_name: format!("shot.{}", media_type.rsplit('/').next().unwrap()),
                media_type: media_type.to_string(),
                bytes,
            }])
            .expect("readable bounded image header should pass");
        }

        for bytes in [
            png_header(MAX_CUSTOMER_SCREENSHOT_DIMENSION + 1, 1),
            png_header(6_000, 5_000),
        ] {
            let error = validate_customer_screenshots(&[DecodedScreenshot {
                file_name: "oversized.png".to_string(),
                media_type: "image/png".to_string(),
                bytes,
            }])
            .expect_err("oversized dimensions or pixel count must fail");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
        }

        let unreadable = validate_customer_screenshots(&[DecodedScreenshot {
            file_name: "truncated.webp".to_string(),
            media_type: "image/webp".to_string(),
            bytes: b"RIFF\0\0\0\0WEBP".to_vec(),
        }])
        .expect_err("truncated image headers must fail");
        assert_eq!(unreadable.0, StatusCode::BAD_REQUEST);

        for disallowed in ['\u{0007}', '\u{0085}', '\u{202E}', '\u{2066}'] {
            let error = validate_customer_screenshots(&[DecodedScreenshot {
                file_name: format!("safe{disallowed}spoofed.png"),
                media_type: "image/png".to_string(),
                bytes: png_header(1, 1),
            }])
            .expect_err("control and bidi characters in file names must be rejected");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
        }
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
    fn customer_unread_cursors_distinguish_support_activity_from_resolution_events() {
        let first = chrono::DateTime::parse_from_rfc3339("2026-09-05T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let second = chrono::DateTime::parse_from_rfc3339("2026-09-05T12:01:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert!(!has_unread_support_activity(None, None));
        assert!(has_unread_support_activity(Some(&first), None));
        assert!(!has_unread_support_activity(Some(&first), Some(&first)));
        assert!(has_unread_support_activity(Some(&second), Some(&first)));

        assert!(has_unread_resolution(
            "resolved",
            Some(&second),
            Some(&first)
        ));
        assert!(!has_unread_resolution(
            "resolved",
            Some(&first),
            Some(&first)
        ));
        assert!(!has_unread_resolution("open", Some(&second), Some(&first)));
        assert!(!has_unread_resolution("resolved", None, None));
    }

    #[test]
    fn customer_summary_projection_excludes_operator_and_diagnostic_fields() {
        let report = BugReportSummary {
            id: Uuid::new_v4().to_string(),
            created_at: Utc::now().to_rfc3339(),
            activity_at: Utc::now().to_rfc3339(),
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
            customer_last_message_at: None,
            support_last_message_at: None,
            customer_last_reviewed_at: None,
            needs_response: false,
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
    fn customer_report_cursors_keep_activity_and_legacy_creation_modes_distinct() {
        let report_id = Uuid::new_v4().to_string();
        let activity = serde_json::to_value(CustomerBugReportListCursor::Activity {
            activity_at: "2026-09-05T12:00:00Z".to_string(),
            id: report_id.clone(),
        })
        .expect("activity cursor should serialize");
        assert_eq!(
            activity,
            json!({ "activityAt": "2026-09-05T12:00:00Z", "id": report_id })
        );

        let created = serde_json::to_value(CustomerBugReportListCursor::Created {
            created_at: "2026-09-04T12:00:00Z".to_string(),
            id: report_id.clone(),
        })
        .expect("created cursor should serialize");
        assert_eq!(
            created,
            json!({ "createdAt": "2026-09-04T12:00:00Z", "id": report_id })
        );
    }

    #[test]
    fn bug_report_patch_distinguishes_omitted_and_explicitly_cleared_fields() {
        let omitted: UpdateBugReportRequest =
            serde_json::from_value(json!({})).expect("empty patch should deserialize");
        assert!(omitted.assignee.is_none());
        assert!(omitted.duplicate_of.is_none());
        assert!(omitted.github_issue_url.is_none());

        let cleared: UpdateBugReportRequest = serde_json::from_value(json!({
            "assignee": null,
            "duplicateOf": null,
            "githubIssueUrl": null
        }))
        .expect("nullable clears should deserialize");
        assert_eq!(cleared.assignee, Some(None));
        assert_eq!(cleared.duplicate_of, Some(None));
        assert_eq!(cleared.github_issue_url, Some(None));

        let assigned: UpdateBugReportRequest = serde_json::from_value(json!({
            "assignee": "support",
            "duplicateOf": "11111111-1111-4111-8111-111111111111",
            "githubIssueUrl": "https://github.com/instafy-dev/instafy/issues/1"
        }))
        .expect("nullable values should deserialize");
        assert_eq!(assigned.assignee, Some(Some("support".to_string())));
        assert!(assigned.duplicate_of.flatten().is_some());
        assert!(assigned.github_issue_url.flatten().is_some());
    }

    #[test]
    fn customer_upload_validation_rejects_unstructured_logs_and_fake_images() {
        let request = CreateBugReportRequest {
            message: "summary".to_string(),
            details: None,
            client_request_id: None,
            expected_user_id: None,
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

        for (message, details) in [
            ("summary\u{202e}spoofed", None),
            ("summary", Some("details\u{0007}spoofed")),
            ("summary", Some("details\u{0085}spoofed")),
        ] {
            let request = CreateBugReportRequest {
                message: message.to_string(),
                details: details.map(str::to_string),
                client_request_id: None,
                expected_user_id: None,
                project_id: None,
                runtime_id: None,
                run_id: None,
                conversation_id: None,
                metadata: None,
                logs: None,
                screenshots: None,
            };
            let control_error = validate_customer_bug_report_request(&request)
                .expect_err("initial customer report text must reject spoofing controls");
            assert_eq!(control_error.0, StatusCode::BAD_REQUEST);
        }

        let ordinary_whitespace = CreateBugReportRequest {
            message: "summary\nwith a second line\tand tab".to_string(),
            details: Some("details\r\nwith another line".to_string()),
            client_request_id: None,
            expected_user_id: None,
            project_id: None,
            runtime_id: None,
            run_id: None,
            conversation_id: None,
            metadata: None,
            logs: None,
            screenshots: None,
        };
        validate_customer_bug_report_request(&ordinary_whitespace)
            .expect("normal report newlines and tabs should remain valid");

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
