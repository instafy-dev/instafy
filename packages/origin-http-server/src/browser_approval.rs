use std::collections::{HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::fmt::Write as FmtWrite;
use std::io::{Read, Write as IoWrite};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Json, Response};
use axum::Extension;
use cap_std::fs::Dir;
#[cfg(unix)]
use cap_std::fs::MetadataExt as CapMetadataExt;
#[cfg(unix)]
use cap_std::fs::PermissionsExt as CapPermissionsExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::{validated_claim_expiry, OriginClaims};
use crate::error::OriginError;
use crate::routes::AppState;
use crate::safe_fs::{
    create_new_private_options, open_workspace_root, read_nofollow_options, sync_dir,
};

pub(crate) const DEFAULT_AGENT_CONTROL_FILE: &str = "/run/instafy/browser/agent-control.json";
const DEFAULT_APPROVAL_DIR: &str = "/run/instafy/browser/approvals";
pub(crate) const AGENT_CONTROL_FILE_MAX_BYTES: u64 = 4 * 1024;
const APPROVAL_REQUEST_MAX_BYTES: u64 = 16 * 1024;
const APPROVAL_DECISION_MAX_BYTES: usize = 8 * 1024;
const APPROVAL_STATE_MAX_BYTES: u64 = 16 * 1024;
const APPROVAL_DIRECTORY_MODE: u32 = 0o700;
const APPROVAL_FILE_MODE: u32 = 0o600;
const PAGE_ID_MAX_BYTES: usize = 256;
const DISPLAY_NAME_MAX_BYTES: usize = 80;
const OPERATION_MAX_BYTES: usize = 64;
const LABEL_MAX_BYTES: usize = 240;
const ORIGIN_MAX_BYTES: usize = 512;
const MAX_APPROVED_ORIGINS: usize = 32;
const MAX_CONSUMED_APPROVALS: usize = 64;
const MAX_RECENT_DECISIONS: usize = 64;
const MAX_APPROVAL_LIFETIME_MS: u64 = 60_000;
const MIN_APPROVAL_LIFETIME_MS: u64 = 100;
const CLOCK_SKEW_MS: u64 = 1_000;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentControlMarker {
    pub(crate) version: u8,
    pub(crate) owner_id: String,
    pub(crate) run_id: String,
    pub(crate) initiator_user_id: String,
    pub(crate) browser_page_id: String,
    pub(crate) display_name: String,
    pub(crate) expires_at_ms: u64,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum AgentControlMarkerObservation {
    /// A well-formed marker remains authoritative until its owner explicitly
    /// removes it. Expiry is a liveness diagnostic and never yields human
    /// control by itself.
    Active(AgentControlMarker),
    Inactive,
    Unavailable(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ApprovalKind {
    Origin,
    Action,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApprovalOperation {
    ApproveOrigin,
    Navigate,
    Click,
    Type,
    FormSubmit,
    PressKey,
    PressEnter,
    PressSpace,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalDisplay {
    label: String,
    destination_origin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingApprovalRequest {
    version: u8,
    approval_id: String,
    kind: ApprovalKind,
    owner_id: String,
    run_id: String,
    initiator_user_id: String,
    browser_page_id: String,
    operation: ApprovalOperation,
    source_origin: Option<String>,
    destination_origin: Option<String>,
    destination_fingerprint: String,
    snapshot_id: Option<String>,
    target_fingerprint: Option<String>,
    payload_fingerprint: Option<String>,
    requested_at_ms: u64,
    expires_at_ms: u64,
    request_fingerprint: String,
    display: ApprovalDisplay,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalState {
    version: u8,
    owner_id: String,
    run_id: String,
    initiator_user_id: String,
    browser_page_id: String,
    approved_origins: Vec<String>,
    consumed_approval_ids: Vec<String>,
    // Additive policy grant; old state means the strict ask-every-action mode.
    #[serde(default, rename = "routineBrowsingAllowed")]
    _routine_browsing_allowed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ApprovalDecision {
    AllowOrigin,
    AllowRoutine,
    AllowOnce,
    Deny,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingApprovalQuery {
    runtime_id: String,
    browser_page_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalDecisionRequest {
    version: u8,
    runtime_id: String,
    owner_id: String,
    run_id: String,
    browser_page_id: String,
    approval_id: String,
    request_fingerprint: String,
    decision: ApprovalDecision,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingApproval {
    runtime_id: String,
    request: PendingApprovalRequest,
}

#[derive(Debug, Serialize)]
struct PendingApprovalEnvelope {
    pending: Option<PendingApproval>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalDecisionResponse {
    accepted: bool,
    approval_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredApprovalDecision<'a> {
    version: u8,
    approval_id: &'a str,
    request_fingerprint: &'a str,
    decision: ApprovalDecision,
    decided_by_user_id: &'a str,
    decided_at_ms: u64,
    expires_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintedApprovalRequest<'a> {
    version: u8,
    approval_id: &'a str,
    kind: ApprovalKind,
    owner_id: &'a str,
    run_id: &'a str,
    initiator_user_id: &'a str,
    browser_page_id: &'a str,
    operation: ApprovalOperation,
    source_origin: &'a Option<String>,
    destination_origin: &'a Option<String>,
    destination_fingerprint: &'a str,
    snapshot_id: &'a Option<String>,
    target_fingerprint: &'a Option<String>,
    payload_fingerprint: &'a Option<String>,
    requested_at_ms: u64,
    expires_at_ms: u64,
}

#[derive(Clone)]
pub(crate) struct BrowserApprovalBridge {
    marker_path: Arc<PathBuf>,
    approval_dir: Arc<PathBuf>,
    recent_decisions: Arc<Mutex<VecDeque<String>>>,
}

impl Default for BrowserApprovalBridge {
    fn default() -> Self {
        let marker_path = env_path(
            "INSTAFY_BROWSER_AGENT_CONTROL_FILE",
            DEFAULT_AGENT_CONTROL_FILE,
        );
        let approval_dir = env_path("INSTAFY_SHARED_BROWSER_APPROVAL_DIR", DEFAULT_APPROVAL_DIR);
        Self::new_with_paths(marker_path, approval_dir)
    }
}

impl BrowserApprovalBridge {
    fn new_with_paths(marker_path: PathBuf, approval_dir: PathBuf) -> Self {
        Self {
            marker_path: Arc::new(marker_path),
            approval_dir: Arc::new(approval_dir),
            recent_decisions: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(marker_path: PathBuf, approval_dir: PathBuf) -> Self {
        Self::new_with_paths(marker_path, approval_dir)
    }

    pub(crate) fn marker_path(&self) -> &Path {
        self.marker_path.as_ref()
    }

    pub(crate) async fn read_agent_control(&self) -> AgentControlMarkerObservation {
        read_agent_control_marker(self.marker_path()).await
    }

    async fn observe_pending(
        &self,
        claims: &OriginClaims,
        query: PendingApprovalQuery,
    ) -> Result<PendingApprovalEnvelope, OriginError> {
        let Some(marker) = self
            .authorized_live_marker(
                claims,
                &query.runtime_id,
                &query.browser_page_id,
                "browser.view",
            )
            .await?
        else {
            return Ok(PendingApprovalEnvelope { pending: None });
        };
        let approval_dir = self.open_required_approval_dir()?;
        let Some(request) = read_pending_request(&approval_dir)? else {
            return Ok(PendingApprovalEnvelope { pending: None });
        };
        validate_pending_request(&request, unix_time_millis()).map_err(|error| {
            OriginError::unavailable(format!(
                "pending Shared Browser approval is invalid: {error}"
            ))
        })?;
        require_request_marker_binding(&request, &marker)?;
        let consumed = read_consumed_approval_ids(&approval_dir, &marker)?;
        if consumed.contains(&request.approval_id) {
            return Ok(PendingApprovalEnvelope { pending: None });
        }

        // Re-read both fixed files immediately before returning. A caller can
        // never observe a request that was swapped onto another run/page after
        // the initial authorization check.
        let Some(current_marker) = self
            .authorized_live_marker(
                claims,
                &query.runtime_id,
                &query.browser_page_id,
                "browser.view",
            )
            .await?
        else {
            return Ok(PendingApprovalEnvelope { pending: None });
        };
        if !same_agent_authority(&current_marker, &marker) {
            return Err(OriginError::conflict(
                "Shared Browser approval authority changed while it was observed",
            ));
        }
        let current_request = read_pending_request(&approval_dir)?.ok_or_else(|| {
            OriginError::conflict("Shared Browser approval changed while it was observed")
        })?;
        if current_request != request {
            return Err(OriginError::conflict(
                "Shared Browser approval changed while it was observed",
            ));
        }
        validate_pending_request(&current_request, unix_time_millis()).map_err(|error| {
            OriginError::conflict(format!(
                "Shared Browser approval is no longer current: {error}"
            ))
        })?;
        if read_consumed_approval_ids(&approval_dir, &current_marker)?
            .contains(&current_request.approval_id)
        {
            return Ok(PendingApprovalEnvelope { pending: None });
        }
        match ensure_decision_slot_is_empty(&approval_dir) {
            Ok(()) => {}
            Err(OriginError::Conflict(_)) => {
                return Ok(PendingApprovalEnvelope { pending: None });
            }
            Err(error) => return Err(error),
        }

        Ok(PendingApprovalEnvelope {
            pending: Some(PendingApproval {
                runtime_id: query.runtime_id,
                request,
            }),
        })
    }

    async fn submit_decision(
        &self,
        claims: &OriginClaims,
        body: ApprovalDecisionRequest,
    ) -> Result<ApprovalDecisionResponse, OriginError> {
        // One origin process publishes one fixed decision slot. Hold this lock
        // through the final authority/request revalidation and atomic rename.
        let mut recent_decisions = self.recent_decisions.lock().await;
        let marker = self
            .authorized_live_marker(
                claims,
                &body.runtime_id,
                &body.browser_page_id,
                "browser.control",
            )
            .await?
            .ok_or_else(|| OriginError::not_found("pending browser approval not found"))?;
        if body.version != 1 {
            return Err(OriginError::bad_request(
                "Shared Browser approval decision version is invalid",
            ));
        }
        validate_canonical_uuid(&body.owner_id, "ownerId")?;
        validate_canonical_uuid(&body.run_id, "runId")?;
        validate_page_id(&body.browser_page_id)?;
        validate_canonical_uuid(&body.approval_id, "approvalId")?;
        validate_hex_64(&body.request_fingerprint, "requestFingerprint")?;
        let approval_dir = self.open_required_approval_dir()?;
        let request = read_pending_request(&approval_dir)?
            .ok_or_else(|| OriginError::not_found("pending browser approval not found"))?;
        validate_pending_request(&request, unix_time_millis()).map_err(|error| {
            OriginError::conflict(format!("Shared Browser approval is stale: {error}"))
        })?;
        require_request_marker_binding(&request, &marker)?;
        require_decision_request_binding(&body, &request, &marker)?;
        require_decision_kind(body.decision, request.kind)?;

        let consumed = read_consumed_approval_ids(&approval_dir, &marker)?;
        if consumed.contains(&request.approval_id)
            || recent_decisions.contains(&request.approval_id)
        {
            return Err(OriginError::conflict(
                "Shared Browser approval was already decided or consumed",
            ));
        }
        ensure_decision_slot_is_empty(&approval_dir)?;

        let current_marker = self
            .authorized_live_marker(
                claims,
                &body.runtime_id,
                &body.browser_page_id,
                "browser.control",
            )
            .await?
            .ok_or_else(|| OriginError::not_found("pending browser approval not found"))?;
        if !same_agent_authority(&current_marker, &marker) {
            return Err(OriginError::conflict(
                "Shared Browser approval authority changed before the decision",
            ));
        }
        let current_request = read_pending_request(&approval_dir)?
            .ok_or_else(|| OriginError::conflict("Shared Browser approval is no longer pending"))?;
        if current_request != request {
            return Err(OriginError::conflict(
                "Shared Browser approval changed before the decision",
            ));
        }
        validate_pending_request(&current_request, unix_time_millis()).map_err(|error| {
            OriginError::conflict(format!(
                "Shared Browser approval is no longer current: {error}"
            ))
        })?;
        ensure_decision_slot_is_empty(&approval_dir)?;

        let now = unix_time_millis();
        let decision = StoredApprovalDecision {
            version: 1,
            approval_id: &request.approval_id,
            request_fingerprint: &request.request_fingerprint,
            decision: body.decision,
            decided_by_user_id: &claims.sub,
            decided_at_ms: now,
            expires_at_ms: request.expires_at_ms,
        };
        write_decision_atomically(&approval_dir, &decision)?;
        recent_decisions.push_back(request.approval_id.clone());
        while recent_decisions.len() > MAX_RECENT_DECISIONS {
            recent_decisions.pop_front();
        }

        Ok(ApprovalDecisionResponse {
            accepted: true,
            approval_id: request.approval_id,
        })
    }

    async fn authorized_live_marker(
        &self,
        claims: &OriginClaims,
        runtime_id: &str,
        browser_page_id: &str,
        required_scope: &str,
    ) -> Result<Option<AgentControlMarker>, OriginError> {
        validated_claim_expiry(claims)?;
        if !claims.scopes.iter().any(|scope| scope == required_scope) {
            return Err(OriginError::unauthorized(format!(
                "{required_scope} is required for Shared Browser approval"
            )));
        }
        validate_canonical_uuid(runtime_id, "runtimeId")?;
        validate_page_id(browser_page_id)?;
        if claims.runtime_id.as_deref() != Some(runtime_id) {
            return Err(OriginError::unauthorized(
                "Shared Browser approval runtime does not match its signed token",
            ));
        }
        let marker = match self.read_agent_control().await {
            AgentControlMarkerObservation::Active(marker) => marker,
            AgentControlMarkerObservation::Inactive => return Ok(None),
            AgentControlMarkerObservation::Unavailable(error) => {
                return Err(OriginError::unavailable(format!(
                    "Shared Browser approval authority is unavailable: {error}"
                )))
            }
        };
        // Deliberately use exact strings rather than UUID equivalence. The
        // controller-authenticated subject must be the exact initiator bound
        // by runtime-agent, and teammates learn no request contents.
        if claims.sub != marker.initiator_user_id || browser_page_id != marker.browser_page_id {
            return Err(OriginError::not_found("pending browser approval not found"));
        }
        if marker.expires_at_ms <= unix_time_millis() {
            return Err(OriginError::conflict(
                "Shared Browser approval authority is stale",
            ));
        }
        Ok(Some(marker))
    }

    fn open_required_approval_dir(&self) -> Result<Dir, OriginError> {
        open_protected_directory(&self.approval_dir, true)
            .map_err(|error| {
                OriginError::unavailable(format!(
                    "Shared Browser approval storage is unavailable: {error}"
                ))
            })?
            .ok_or_else(|| {
                OriginError::unavailable("Shared Browser approval storage is unavailable")
            })
    }
}

pub(crate) async fn handle_pending_approval(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Query(query): Query<PendingApprovalQuery>,
) -> Result<Response, OriginError> {
    let payload = state
        .browser_collaboration
        .approval_bridge()
        .observe_pending(&claims, query)
        .await?;
    Ok(no_store_json(payload))
}

pub(crate) async fn handle_approval_decision(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Json(body): Json<ApprovalDecisionRequest>,
) -> Result<Response, OriginError> {
    let payload = state
        .browser_collaboration
        .approval_bridge()
        .submit_decision(&claims, body)
        .await?;
    Ok(no_store_json(payload))
}

pub(crate) async fn read_agent_control_marker(path: &Path) -> AgentControlMarkerObservation {
    let bytes = match read_protected_absolute_file(path, AGENT_CONTROL_FILE_MAX_BYTES, false) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return AgentControlMarkerObservation::Inactive,
        Err(error) => return AgentControlMarkerObservation::Unavailable(error),
    };
    let marker = match serde_json::from_slice::<AgentControlMarker>(&bytes) {
        Ok(marker) => marker,
        Err(_) => {
            return AgentControlMarkerObservation::Unavailable(
                "marker payload is invalid".to_string(),
            )
        }
    };
    if let Err(error) = validate_agent_control_marker(&marker) {
        return AgentControlMarkerObservation::Unavailable(error);
    }
    AgentControlMarkerObservation::Active(marker)
}

fn validate_agent_control_marker(marker: &AgentControlMarker) -> Result<(), String> {
    if marker.version != 2 {
        return Err("marker version is invalid".to_string());
    }
    validate_canonical_uuid_string(&marker.owner_id, "ownerId")?;
    validate_canonical_uuid_string(&marker.run_id, "runId")?;
    validate_canonical_uuid_string(&marker.initiator_user_id, "initiatorUserId")?;
    validate_page_id_string(&marker.browser_page_id)?;
    if marker.display_name.is_empty()
        || marker.display_name.as_bytes().len() > DISPLAY_NAME_MAX_BYTES
        || normalized_display_name(&marker.display_name) != marker.display_name
    {
        return Err("marker displayName is invalid".to_string());
    }
    if marker.expires_at_ms > JS_MAX_SAFE_INTEGER {
        return Err("marker expiresAtMs is invalid".to_string());
    }
    Ok(())
}

fn read_pending_request(dir: &Dir) -> Result<Option<PendingApprovalRequest>, OriginError> {
    let Some(bytes) =
        read_protected_child(dir, OsStr::new("request.json"), APPROVAL_REQUEST_MAX_BYTES).map_err(
            |error| {
                OriginError::unavailable(format!(
                    "Shared Browser approval request is unsafe: {error}"
                ))
            },
        )?
    else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| OriginError::unavailable("Shared Browser approval request is malformed"))
}

fn validate_pending_request(request: &PendingApprovalRequest, now: u64) -> Result<(), String> {
    if request.version != 1 {
        return Err("request version is invalid".to_string());
    }
    validate_canonical_uuid_string(&request.approval_id, "approvalId")?;
    validate_canonical_uuid_string(&request.owner_id, "ownerId")?;
    validate_canonical_uuid_string(&request.run_id, "runId")?;
    validate_canonical_uuid_string(&request.initiator_user_id, "initiatorUserId")?;
    validate_page_id_string(&request.browser_page_id)?;
    if request.operation.to_string().as_bytes().len() > OPERATION_MAX_BYTES {
        return Err("operation is too long".to_string());
    }
    validate_optional_origin_string(request.source_origin.as_deref(), "sourceOrigin")?;
    validate_optional_origin_string(request.destination_origin.as_deref(), "destinationOrigin")?;
    validate_hex_64_string(&request.destination_fingerprint, "destinationFingerprint")?;
    validate_optional_hex_64_string(request.snapshot_id.as_deref(), "snapshotId")?;
    validate_optional_hex_64_string(request.target_fingerprint.as_deref(), "targetFingerprint")?;
    validate_optional_hex_64_string(request.payload_fingerprint.as_deref(), "payloadFingerprint")?;
    validate_hex_64_string(&request.request_fingerprint, "requestFingerprint")?;
    if request.display.label.is_empty()
        || request.display.label.as_bytes().len() > LABEL_MAX_BYTES
        || normalized_display_name(&request.display.label) != request.display.label
        || request.display.destination_origin != request.destination_origin
    {
        return Err("request display is invalid".to_string());
    }
    if request.requested_at_ms > JS_MAX_SAFE_INTEGER
        || request.expires_at_ms > JS_MAX_SAFE_INTEGER
        || request.expires_at_ms <= request.requested_at_ms
        || request
            .expires_at_ms
            .saturating_sub(request.requested_at_ms)
            < MIN_APPROVAL_LIFETIME_MS
        || request
            .expires_at_ms
            .saturating_sub(request.requested_at_ms)
            > MAX_APPROVAL_LIFETIME_MS
        || request.requested_at_ms > now.saturating_add(CLOCK_SKEW_MS)
        || request.expires_at_ms <= now
    {
        return Err("request timing is stale or invalid".to_string());
    }
    validate_operation_shape(request)?;
    let expected_fingerprint = request_fingerprint(request)?;
    if request.request_fingerprint != expected_fingerprint {
        return Err("request fingerprint does not match its exact contents".to_string());
    }
    Ok(())
}

fn validate_operation_shape(request: &PendingApprovalRequest) -> Result<(), String> {
    let snapshot = request.snapshot_id.is_some();
    let target = request.target_fingerprint.is_some();
    let payload = request.payload_fingerprint.is_some();
    match (request.kind, request.operation) {
        (ApprovalKind::Origin, ApprovalOperation::ApproveOrigin)
            if request.source_origin.is_some()
                && request.source_origin == request.destination_origin
                && !snapshot
                && !target
                && !payload =>
        {
            Ok(())
        }
        (ApprovalKind::Action, ApprovalOperation::Navigate)
            if request.destination_origin.is_some() && !snapshot && !target && payload =>
        {
            Ok(())
        }
        (ApprovalKind::Action, ApprovalOperation::Click)
            if request.source_origin.is_some() && snapshot && target && payload =>
        {
            Ok(())
        }
        (ApprovalKind::Action, ApprovalOperation::Type | ApprovalOperation::PressKey)
            if request.source_origin.is_some()
                && request.destination_origin.is_none()
                && snapshot
                && target
                && payload =>
        {
            Ok(())
        }
        (
            ApprovalKind::Action,
            ApprovalOperation::FormSubmit
            | ApprovalOperation::PressEnter
            | ApprovalOperation::PressSpace,
        ) if request.source_origin.is_some()
            && request.destination_origin.is_some()
            && snapshot
            && target
            && payload =>
        {
            Ok(())
        }
        _ => Err("request kind, operation, and bindings are inconsistent".to_string()),
    }
}

fn request_fingerprint(request: &PendingApprovalRequest) -> Result<String, String> {
    let core = FingerprintedApprovalRequest {
        version: request.version,
        approval_id: &request.approval_id,
        kind: request.kind,
        owner_id: &request.owner_id,
        run_id: &request.run_id,
        initiator_user_id: &request.initiator_user_id,
        browser_page_id: &request.browser_page_id,
        operation: request.operation,
        source_origin: &request.source_origin,
        destination_origin: &request.destination_origin,
        destination_fingerprint: &request.destination_fingerprint,
        snapshot_id: &request.snapshot_id,
        target_fingerprint: &request.target_fingerprint,
        payload_fingerprint: &request.payload_fingerprint,
        requested_at_ms: request.requested_at_ms,
        expires_at_ms: request.expires_at_ms,
    };
    let bytes = serde_json::to_vec(&core)
        .map_err(|_| "request fingerprint input could not be serialized".to_string())?;
    Ok(sha256_hex(&bytes))
}

fn require_request_marker_binding(
    request: &PendingApprovalRequest,
    marker: &AgentControlMarker,
) -> Result<(), OriginError> {
    if request.owner_id != marker.owner_id
        || request.run_id != marker.run_id
        || request.initiator_user_id != marker.initiator_user_id
        || request.browser_page_id != marker.browser_page_id
    {
        return Err(OriginError::conflict(
            "Shared Browser approval request does not match current authority",
        ));
    }
    Ok(())
}

fn same_agent_authority(left: &AgentControlMarker, right: &AgentControlMarker) -> bool {
    left.owner_id == right.owner_id
        && left.run_id == right.run_id
        && left.initiator_user_id == right.initiator_user_id
        && left.browser_page_id == right.browser_page_id
}

fn require_decision_request_binding(
    body: &ApprovalDecisionRequest,
    request: &PendingApprovalRequest,
    marker: &AgentControlMarker,
) -> Result<(), OriginError> {
    if body.owner_id != marker.owner_id
        || body.run_id != marker.run_id
        || body.browser_page_id != marker.browser_page_id
        || body.approval_id != request.approval_id
        || body.request_fingerprint != request.request_fingerprint
    {
        return Err(OriginError::conflict(
            "Shared Browser approval decision does not match the pending request",
        ));
    }
    Ok(())
}

fn require_decision_kind(
    decision: ApprovalDecision,
    kind: ApprovalKind,
) -> Result<(), OriginError> {
    let allowed = matches!(decision, ApprovalDecision::Deny)
        || matches!(
            (decision, kind),
            (ApprovalDecision::AllowOrigin, ApprovalKind::Origin)
                | (ApprovalDecision::AllowRoutine, ApprovalKind::Origin)
                | (ApprovalDecision::AllowOnce, ApprovalKind::Action)
        );
    if !allowed {
        return Err(OriginError::bad_request(
            "Shared Browser approval decision does not match the request kind",
        ));
    }
    Ok(())
}

fn read_consumed_approval_ids(
    dir: &Dir,
    marker: &AgentControlMarker,
) -> Result<HashSet<String>, OriginError> {
    let Some(bytes) = read_protected_child(dir, OsStr::new("state.json"), APPROVAL_STATE_MAX_BYTES)
        .map_err(|error| {
            OriginError::unavailable(format!("Shared Browser approval state is unsafe: {error}"))
        })?
    else {
        return Ok(HashSet::new());
    };
    let state: ApprovalState = serde_json::from_slice(&bytes)
        .map_err(|_| OriginError::unavailable("Shared Browser approval state is malformed"))?;
    if state.version != 1
        || state.owner_id != marker.owner_id
        || state.run_id != marker.run_id
        || state.initiator_user_id != marker.initiator_user_id
        || state.browser_page_id != marker.browser_page_id
        || state.approved_origins.len() > MAX_APPROVED_ORIGINS
        || state.consumed_approval_ids.len() > MAX_CONSUMED_APPROVALS
    {
        return Err(OriginError::unavailable(
            "Shared Browser approval state does not match current authority",
        ));
    }
    let mut origins = HashSet::new();
    for origin in &state.approved_origins {
        validate_origin_string(origin, "approvedOrigin").map_err(OriginError::unavailable)?;
        if !origins.insert(origin) {
            return Err(OriginError::unavailable(
                "Shared Browser approval state contains duplicate origins",
            ));
        }
    }
    let mut consumed = HashSet::new();
    for approval_id in state.consumed_approval_ids {
        validate_canonical_uuid_string(&approval_id, "consumedApprovalId")
            .map_err(OriginError::unavailable)?;
        if !consumed.insert(approval_id) {
            return Err(OriginError::unavailable(
                "Shared Browser approval state contains duplicate decisions",
            ));
        }
    }
    Ok(consumed)
}

fn ensure_decision_slot_is_empty(dir: &Dir) -> Result<(), OriginError> {
    match dir.symlink_metadata(OsStr::new("decision.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(OriginError::unavailable(format!(
            "Shared Browser approval decision slot is unavailable: {error}"
        ))),
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => Err(OriginError::conflict(
            "Shared Browser approval already has a pending decision",
        )),
        Ok(_) => Err(OriginError::unavailable(
            "Shared Browser approval decision slot is unsafe",
        )),
    }
}

fn write_decision_atomically(
    dir: &Dir,
    decision: &StoredApprovalDecision<'_>,
) -> Result<(), OriginError> {
    let mut bytes = serde_json::to_vec(decision).map_err(|error| {
        OriginError::internal(format!(
            "failed to serialize Shared Browser decision: {error}"
        ))
    })?;
    bytes.push(b'\n');
    if bytes.len() > APPROVAL_DECISION_MAX_BYTES {
        return Err(OriginError::internal(
            "Shared Browser approval decision exceeded its fixed bound",
        ));
    }
    let temporary_name = OsString::from(format!(".instafy-approval-origin-{}", Uuid::new_v4()));
    let write_result = (|| -> Result<(), OriginError> {
        let mut temporary = dir
            .open_with(&temporary_name, &create_new_private_options())
            .map_err(|error| {
                OriginError::unavailable(format!(
                    "failed to create Shared Browser approval decision: {error}"
                ))
            })?;
        #[cfg(unix)]
        temporary
            .set_permissions(cap_std::fs::Permissions::from_mode(APPROVAL_FILE_MODE))
            .map_err(|error| {
                OriginError::unavailable(format!(
                    "failed to protect Shared Browser approval decision: {error}"
                ))
            })?;
        temporary.write_all(&bytes).map_err(|error| {
            OriginError::unavailable(format!(
                "failed to write Shared Browser approval decision: {error}"
            ))
        })?;
        temporary.sync_all().map_err(|error| {
            OriginError::unavailable(format!(
                "failed to sync Shared Browser approval decision: {error}"
            ))
        })?;
        drop(temporary);
        ensure_decision_slot_is_empty(dir)?;
        // A rename would replace a destination inserted after the emptiness
        // check. Linking the already-synced private inode into the fixed slot
        // is atomic and create-if-absent on every supported platform.
        match dir.hard_link(&temporary_name, dir, OsStr::new("decision.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure_decision_slot_is_empty(dir)?;
                return Err(OriginError::conflict(
                    "Shared Browser approval already has a pending decision",
                ));
            }
            Err(error) => {
                return Err(OriginError::unavailable(format!(
                    "failed to publish Shared Browser approval decision: {error}"
                )));
            }
        }
        // The fixed link is durable authority now. A best-effort removal can
        // safely leave only a protected, uniquely named sibling for startup
        // cleanup; it can never redirect or replace decision.json.
        let _ = dir.remove_file(&temporary_name);
        sync_dir(dir).map_err(|error| {
            OriginError::unavailable(format!(
                "failed to sync Shared Browser approval directory: {error}"
            ))
        })?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = dir.remove_file(&temporary_name);
    }
    write_result
}

fn read_protected_absolute_file(
    path: &Path,
    max_bytes: u64,
    require_parent_mode: bool,
) -> Result<Option<Vec<u8>>, String> {
    if !is_clean_absolute_path(path) {
        return Err("path must be a clean absolute path".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "path is missing its parent directory".to_string())?;
    let leaf = path
        .file_name()
        .ok_or_else(|| "path is missing its fixed filename".to_string())?;
    let Some(dir) = open_protected_directory(parent, require_parent_mode)? else {
        return Ok(None);
    };
    read_protected_child(&dir, leaf, max_bytes)
}

fn open_protected_directory(path: &Path, require_mode: bool) -> Result<Option<Dir>, String> {
    if !is_clean_absolute_path(path) {
        return Err("directory must be a clean absolute path".to_string());
    }
    let dir = match open_workspace_root(path) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("directory is unsafe: {error}")),
    };
    if require_mode {
        let metadata = dir
            .try_clone()
            .and_then(|dir| dir.into_std_file().metadata())
            .map_err(|error| format!("failed to inspect directory mode: {error}"))?;
        #[cfg(unix)]
        if metadata.permissions().mode() & 0o777 != APPROVAL_DIRECTORY_MODE {
            return Err("directory permissions are not 0700".to_string());
        }
    }
    Ok(Some(dir))
}

fn read_protected_child(
    dir: &Dir,
    leaf: &OsStr,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    let metadata = match dir.symlink_metadata(leaf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to inspect fixed file: {error}")),
    };
    if metadata.is_symlink() || !metadata.is_file() {
        return Err("fixed file must be a regular non-symlink file".to_string());
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err("fixed file size is outside its accepted bound".to_string());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != APPROVAL_FILE_MODE {
        return Err("fixed file permissions are not 0600".to_string());
    }
    let file = match dir.open_with(leaf, &read_nofollow_options()) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to open fixed file without following links: {error}"
            ))
        }
    };
    let opened = file
        .metadata()
        .map_err(|error| format!("failed to inspect opened fixed file: {error}"))?;
    if !opened.is_file() || opened.len() == 0 || opened.len() > max_bytes {
        return Err("opened fixed file changed or exceeded its bound".to_string());
    }
    #[cfg(unix)]
    if metadata.dev() != opened.dev()
        || metadata.ino() != opened.ino()
        || metadata.len() != opened.len()
        || metadata.mtime() != opened.mtime()
        || metadata.mtime_nsec() != opened.mtime_nsec()
        || metadata.ctime() != opened.ctime()
        || metadata.ctime_nsec() != opened.ctime_nsec()
    {
        return Err("fixed file changed while it was opened".to_string());
    }
    #[cfg(unix)]
    if opened.permissions().mode() & 0o777 != APPROVAL_FILE_MODE {
        return Err("opened fixed file permissions are not 0600".to_string());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    let mut bounded = file.take(max_bytes.saturating_add(1));
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read fixed file: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > max_bytes {
        return Err("fixed file payload is outside its accepted bound".to_string());
    }
    let finished = bounded
        .into_inner()
        .metadata()
        .map_err(|error| format!("failed to reinspect fixed file: {error}"))?;
    if !finished.is_file() || finished.len() != bytes.len() as u64 {
        return Err("fixed file changed while it was read".to_string());
    }
    #[cfg(unix)]
    if opened.dev() != finished.dev()
        || opened.ino() != finished.ino()
        || opened.mtime() != finished.mtime()
        || opened.mtime_nsec() != finished.mtime_nsec()
        || opened.ctime() != finished.ctime()
        || opened.ctime_nsec() != finished.ctime_nsec()
    {
        return Err("fixed file changed while it was read".to_string());
    }
    Ok(Some(bytes))
}

fn validate_canonical_uuid(value: &str, field: &str) -> Result<(), OriginError> {
    validate_canonical_uuid_string(value, field).map_err(OriginError::bad_request)
}

fn validate_canonical_uuid_string(value: &str, field: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| format!("{field} must be a UUID"))?;
    if parsed.to_string() != value {
        return Err(format!("{field} must be one canonical lowercase UUID"));
    }
    Ok(())
}

fn validate_page_id(value: &str) -> Result<(), OriginError> {
    validate_page_id_string(value).map_err(OriginError::bad_request)
}

fn validate_page_id_string(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.as_bytes().len() > PAGE_ID_MAX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("browserPageId must be one bounded CDP target id".to_string());
    }
    Ok(())
}

fn validate_hex_64(value: &str, field: &str) -> Result<(), OriginError> {
    validate_hex_64_string(value, field).map_err(OriginError::bad_request)
}

fn validate_optional_hex_64_string(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_hex_64_string(value, field)?;
    }
    Ok(())
}

fn validate_hex_64_string(value: &str, field: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{field} must be one lowercase SHA-256 fingerprint"));
    }
    Ok(())
}

fn validate_optional_origin_string(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_origin_string(value, field)?;
    }
    Ok(())
}

fn validate_origin_string(value: &str, field: &str) -> Result<(), String> {
    if value.as_bytes().len() > ORIGIN_MAX_BYTES {
        return Err(format!("{field} is too long"));
    }
    let url = reqwest::Url::parse(value).map_err(|_| format!("{field} is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin().ascii_serialization() != value
    {
        return Err(format!("{field} must be one normalized HTTP(S) origin"));
    }
    Ok(())
}

fn normalized_display_name(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn env_path(key: &str, fallback: &str) -> PathBuf {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn is_clean_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                Component::RootDir | Component::Prefix(_) | Component::Normal(_)
            )
        })
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn no_store_json(value: impl Serialize) -> Response {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    response
}

impl std::fmt::Display for ApprovalOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ApproveOrigin => "approve-origin",
            Self::Navigate => "navigate",
            Self::Click => "click",
            Self::Type => "type",
            Self::FormSubmit => "form-submit",
            Self::PressKey => "press-key",
            Self::PressEnter => "press-enter",
            Self::PressSpace => "press-space",
        })
    }
}

#[cfg(test)]
#[path = "browser_approval_tests.rs"]
mod tests;
