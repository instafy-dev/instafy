//! The gateway's HTTP routes. Browser and flush routes are never mounted:
//! the gateway has no browser and no working copy to flush.
//!
//! Reads take `?rev=<commit>` or `?ref=<recovery or salvage ref>` (not
//! both) and otherwise show canonical `main`. Every read that looked at a
//! commit answers with `X-Instafy-Rev` naming it (for `?ref=`, the ref's
//! own id), errors included, and without the header when the space has no
//! `main` yet. A path is `not_found` only when the commit's tree has no
//! entry there; a link, a submodule or a reserved path is
//! `unsupported_entry`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower_http::cors::{Any, CorsLayer};
use tracing::warn;
use uuid::Uuid;

use super::answers::recovery_ref_moved;
use super::cache::{
    canonical_unreachable, disk_full, fetch_failure, FetchFailure, Freshness, MirrorCache,
    MirrorLease, RETRY_AFTER_SECONDS,
};
use super::read::{self, EntriesRead, FileRead};
use super::{recovery, write};
use crate::apply::normalize_relative_path;
use crate::auth::{OriginClaims, WORKSPACE_IMPORT_SCOPE};
use crate::error::OriginError;
use crate::git::{DirtyPathEntry, DirtyPathGroup, GitHistoryEntry};
use crate::paths::is_reserved_path;
use crate::recovery_view::{
    fetch_refs, parse_rev, remote_tip, Absence, FetchedRef, RecoveryRef, ViewError,
    MAX_HISTORY_PAGE,
};
use crate::route_auth::{self, OriginAccessToken, RouteAuth};
use crate::routes::{
    apply_raw_security_headers, mime_type_for_path, FileContentResponse, INSTAFY_BLOB_HEADER,
};
use crate::workspace_git::WorkspaceGit;

/// The header naming the commit a read looked at.
pub(crate) const INSTAFY_REV_HEADER: &str = "x-instafy-rev";

/// How many writes (uploads, reverts, restores) are read, staged and built
/// at once, across all spaces. A slot is let go while the write waits on
/// canonical (a fetch) and for good before the push, which may wait on a
/// slow shard for minutes.
const APPLY_SLOTS: usize = 4;
/// Imports have slots of their own, so a person's save never waits behind
/// one (an import stages and hashes up to thousands of files).
const IMPORT_SLOTS: usize = 2;
/// How long a write waits for a slot before it is told to try again.
const ADMISSION_WAIT: Duration = Duration::from_secs(10);
/// How long an import waits for one: imports are background work, whose
/// controller retries a busy answer, so they wait longer than a person.
const IMPORT_ADMISSION_WAIT: Duration = Duration::from_secs(60);

/// How long a `?ref=` read may spend listing and fetching the ref.
pub(super) const REF_FETCH_DEADLINE: Duration = Duration::from_secs(60);

/// Everything a gateway request needs.
#[derive(Clone)]
pub(crate) struct HostedState {
    pub(crate) auth: RouteAuth,
    pub(crate) cache: Arc<MirrorCache>,
    /// Admission for uploads and the writes that build trees.
    pub(crate) apply_slots: Arc<Semaphore>,
    /// Admission for imports (tokens with `workspace.import`).
    pub(crate) import_slots: Arc<Semaphore>,
    /// How long a write waits for a slot.
    pub(crate) admission_wait: Duration,
    /// How long an import waits for one.
    pub(crate) import_admission_wait: Duration,
}

impl HostedState {
    pub(crate) fn new(auth: RouteAuth, cache: Arc<MirrorCache>) -> Self {
        Self {
            auth,
            cache,
            apply_slots: Arc::new(Semaphore::new(APPLY_SLOTS)),
            import_slots: Arc::new(Semaphore::new(IMPORT_SLOTS)),
            admission_wait: ADMISSION_WAIT,
            import_admission_wait: IMPORT_ADMISSION_WAIT,
        }
    }

    /// A shorter wait for a slot (saves and imports alike), for tests.
    #[cfg(test)]
    pub(crate) fn with_admission_wait(mut self, wait: Duration) -> Self {
        self.admission_wait = wait;
        self.import_admission_wait = wait;
        self
    }

    fn gateway_email(&self) -> String {
        self.auth.config.git_author_email.clone()
    }
}

pub(crate) fn router(state: HostedState) -> Router {
    let cors_layer = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .expose_headers([
            HeaderName::from_static(INSTAFY_REV_HEADER),
            HeaderName::from_static(INSTAFY_BLOB_HEADER),
            axum::http::header::RETRY_AFTER,
        ]);

    let read_routes = Router::new()
        .route("/entries", get(handle_entries))
        .route("/files/*path", get(handle_file))
        .route("/raw/*path", get(handle_raw))
        .route("/git/status", get(handle_git_status))
        .route("/git/diff", get(handle_git_diff))
        .route("/git/history", get(handle_git_history))
        .route("/git/history/review", get(handle_git_history_review))
        .route("/git/recovery", get(handle_git_recovery))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_read,
        ));

    let admitted_routes = Router::new()
        .route(
            "/apply",
            post(write::handle_apply).layer(DefaultBodyLimit::disable()),
        )
        .route("/apply-json", post(write::handle_apply_json))
        .route("/git/revert-commit", post(write::handle_git_revert_commit))
        .route("/git/recovery/restore", post(recovery::handle_restore))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            limit_apply_concurrency,
        ));

    let write_routes = Router::new()
        .merge(admitted_routes)
        .route("/apply/status", post(write::handle_apply_status))
        .route("/git/sync", post(handle_git_sync))
        .route("/git/revert", post(handle_git_revert))
        .route("/git/recovery/dismiss", post(recovery::handle_dismiss))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_write,
        ));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(read_routes)
        .merge(write_routes)
        // The server-wide RequestBodyLimitLayer bounds uploads.
        .layer(DefaultBodyLimit::disable())
        .layer(cors_layer)
        .with_state(state)
}

async fn require_read(
    State(state): State<HostedState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    route_auth::authorize_and_continue(&state.auth, request, next, &["fs.read"]).await
}

async fn require_write(
    State(state): State<HostedState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    route_auth::authorize_and_continue(&state.auth, request, next, &["fs.write"]).await
}

/// A write's admission slot. It covers reading and staging the upload and
/// building the change (the CPU and disk work on this server). It is let
/// go while the write waits on canonical (a fetch of `main` or of a ref,
/// [`Admission::pause`]) and taken again after ([`Admission::resume`]), so
/// a slow fetch, such as a space's first clone, never keeps other writes
/// out. It is let go for good before the push to canonical
/// ([`Admission::release`]) or when the request ends, whichever comes
/// first. Work the request started keeps it until then, also when the
/// client is gone.
#[derive(Clone)]
pub(crate) struct Admission(Arc<std::sync::Mutex<AdmissionSlot>>);

struct AdmissionSlot {
    permit: Option<OwnedSemaphorePermit>,
    /// The pool the slot comes from and how long it is waited for.
    pool: Arc<Semaphore>,
    wait: Duration,
    /// Let go for good.
    ended: bool,
}

impl Admission {
    fn new(permit: OwnedSemaphorePermit, pool: Arc<Semaphore>, wait: Duration) -> Self {
        Self(Arc::new(std::sync::Mutex::new(AdmissionSlot {
            permit: Some(permit),
            pool,
            wait,
            ended: false,
        })))
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, AdmissionSlot> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Let the slot go for good (again: nothing).
    pub(crate) fn release(&self) {
        let mut slot = self.slot();
        slot.ended = true;
        slot.permit = None;
    }

    /// Let the slot go while the write waits on canonical; [`Self::resume`]
    /// takes one again.
    pub(crate) fn pause(&self) {
        self.slot().permit = None;
    }

    /// Take a slot again after [`Self::pause`], waiting at most as long as
    /// admission does (then 503 `writes_busy`). Nothing to do once the slot
    /// was let go for good.
    pub(crate) async fn resume(&self) -> Result<(), OriginError> {
        let (pool, wait) = {
            let slot = self.slot();
            if slot.ended || slot.permit.is_some() {
                return Ok(());
            }
            (slot.pool.clone(), slot.wait)
        };
        let permit = acquire_slot(pool, wait).await?;
        let mut slot = self.slot();
        if !slot.ended {
            slot.permit = Some(permit);
        }
        Ok(())
    }

    /// `work` (waiting on canonical) without the slot, then the slot again.
    pub(crate) async fn paused<T>(
        &self,
        work: impl std::future::Future<Output = Result<T, OriginError>>,
    ) -> Result<T, OriginError> {
        self.pause();
        let value = work.await?;
        self.resume().await?;
        Ok(value)
    }
}

/// A slot of `pool`, waited for at most `wait` (then 503 `writes_busy`).
async fn acquire_slot(
    pool: Arc<Semaphore>,
    wait: Duration,
) -> Result<OwnedSemaphorePermit, OriginError> {
    match tokio::time::timeout(wait, pool.acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err(OriginError::unavailable("apply admission is unavailable")),
        Err(_) => Err(writes_busy()),
    }
}

/// 503: every write slot stayed taken for the admission wait.
pub(super) fn writes_busy() -> OriginError {
    OriginError::retry_later(
        "writes_busy",
        "the server is busy saving other changes; try again in a moment",
        RETRY_AFTER_SECONDS,
    )
}

/// Admit a write: a slot from the import pool for an import token (waited
/// for at most [`IMPORT_ADMISSION_WAIT`]), from the save pool otherwise (at
/// most [`ADMISSION_WAIT`]); then 503 `writes_busy` with `Retry-After`.
async fn limit_apply_concurrency(
    State(state): State<HostedState>,
    mut request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    let import = request
        .extensions()
        .get::<OriginClaims>()
        .is_some_and(|claims| claims.has_scope(WORKSPACE_IMPORT_SCOPE));
    let (pool, wait) = if import {
        (state.import_slots.clone(), state.import_admission_wait)
    } else {
        (state.apply_slots.clone(), state.admission_wait)
    };
    let permit = acquire_slot(pool.clone(), wait).await?;
    let admission = Admission::new(permit, pool, wait);
    request.extensions_mut().insert(admission.clone());
    let response = next.run(request).await;
    admission.release();
    Ok(response)
}

pub(super) fn project_of(state: &HostedState, claims: &OriginClaims) -> Result<Uuid, OriginError> {
    route_auth::project_id_for_claims(&state.auth.config, claims)
}

pub(super) fn caller_token(token: &OriginAccessToken) -> Option<&str> {
    Some(token.token.trim()).filter(|token| !token.is_empty())
}

/// Blocking git work on `lease`'s mirror (created empty when missing) for
/// a request whose bearer is `token`. A failure that says the mirror is
/// damaged on this server's disk throws it away, starts making it again in
/// the background and is answered 503 `mirror_reset`
/// ([`MirrorCache::checked`]).
pub(super) async fn on_mirror<T: Send + 'static>(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    work: impl FnOnce(&std::path::Path) -> Result<T, OriginError> + Send + 'static,
) -> Result<T, OriginError> {
    let cache = state.cache.clone();
    let mirror = lease.mirror();
    let token = token.map(str::to_string);
    blocking(move || {
        let resets = mirror.resets();
        let result = cache.ensure_mirror(&mirror).and_then(|dir| work(&dir));
        cache.checked(&mirror, resets, token.as_deref(), result)
    })
    .await
}

/// Run blocking git work for a request.
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, OriginError> + Send + 'static,
) -> Result<T, OriginError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| OriginError::internal(format!("git task failed: {error}")))?
}

pub(super) fn coded(status: StatusCode, code: &'static str, message: &str) -> OriginError {
    OriginError::with_report(status, code, message, serde_json::json!({}))
}

/// `response` with `X-Instafy-Rev` naming `rev`, when there is one.
fn with_rev(mut response: Response, rev: Option<&str>) -> Response {
    if let Some(value) = rev.and_then(|rev| HeaderValue::from_str(rev).ok()) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(INSTAFY_REV_HEADER), value);
    }
    response
}

fn with_blob(mut response: Response, blob: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(blob) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(INSTAFY_BLOB_HEADER), value);
    }
    response
}

/// The 404 for a path a read showed nothing at.
fn missing(absence: Absence) -> OriginError {
    match absence {
        Absence::Absent => coded(StatusCode::NOT_FOUND, "not_found", "path not found"),
        Absence::Directory => coded(
            StatusCode::NOT_FOUND,
            "unsupported_entry",
            "this path is a folder, not a file",
        ),
        Absence::Hidden => coded(
            StatusCode::NOT_FOUND,
            "unsupported_entry",
            "this path is a link, a submodule or a reserved path, which cannot be read here",
        ),
    }
}

/// A `?ref=` read that could not reach canonical is a 502, like a fetch.
/// One that failed on the mirror at `dir` itself (damaged on this server's
/// disk, as a look at the mirror confirms) keeps git's words, so
/// [`on_mirror`] makes the mirror again.
pub(super) fn ref_error(dir: &std::path::Path, error: ViewError) -> OriginError {
    match error {
        ViewError::Git(error) => {
            let text = format!("{error:#}");
            match fetch_failure(dir, &text) {
                Some(FetchFailure::Damaged) => return OriginError::internal(text),
                Some(FetchFailure::DiskFull) => return disk_full(),
                None => {}
            }
            warn!(error = %text, "fetching a recovery ref failed");
            canonical_unreachable()
        }
        other => other.into(),
    }
}

/// What a read looks at: the commit, and the id `X-Instafy-Rev` names.
struct Target {
    commit: Option<String>,
    served: Option<String>,
}

/// `main`, a commit (`rev`) or the tip of a recovery or salvage ref
/// (`ref`), fetching what is needed. Empty values count as absent.
async fn read_target(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    rev: Option<&str>,
    reference: Option<&str>,
) -> Result<Target, OriginError> {
    let rev = rev.filter(|value| !value.is_empty());
    let reference = reference.filter(|value| !value.is_empty());
    match (rev, reference) {
        (Some(_), Some(_)) => Err(ViewError::RevAndRef.into()),
        (Some(rev), None) => {
            let commit = resolve_rev(state, lease, token, rev).await?;
            Ok(Target {
                commit: Some(commit.clone()),
                served: Some(commit),
            })
        }
        (None, Some(reference)) => {
            let fetched = resolve_ref(state, lease, token, reference).await?;
            Ok(Target {
                commit: Some(fetched.commit),
                served: Some(fetched.tip),
            })
        }
        (None, None) => {
            let main = state
                .cache
                .resolve_main(lease, Freshness::Coalesced, token)
                .await?;
            Ok(Target {
                commit: main.clone(),
                served: main,
            })
        }
    }
}

/// A full commit id that `main` (or a branch) reaches, fetching `main`
/// once when it is not here yet; otherwise 404 `rev_not_found`.
///
/// The fetch is one that starts after the request arrived (shared with
/// every other request waiting for one): a fetch that finished just before
/// cannot hold a commit saved after it, and a client that names a commit
/// usually just learned of it.
pub(super) async fn resolve_rev(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    rev: &str,
) -> Result<String, OriginError> {
    find_rev(state, lease, token, rev, false).await
}

/// [`resolve_rev`] for diff and review, which a chat card asks once per
/// file: a commit the space did not have after a fetch is remembered for
/// [`super::cache::MISSING_REV_MEMORY`] and answered `rev_not_found`
/// meanwhile without fetching again.
async fn resolve_reviewed_rev(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    rev: &str,
) -> Result<String, OriginError> {
    find_rev(state, lease, token, rev, true).await
}

async fn find_rev(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    rev: &str,
    remember_missing: bool,
) -> Result<String, OriginError> {
    let rev = parse_rev(rev)?;
    if readable_here(state, lease, token, &rev).await? {
        return Ok(rev);
    }
    let project = lease.project();
    if remember_missing && state.cache.recently_missing(project, &rev) {
        return Err(ViewError::RevNotFound.into());
    }
    state
        .cache
        .resolve_main(lease, Freshness::Fresh, token)
        .await?;
    if readable_here(state, lease, token, &rev).await? {
        return Ok(rev);
    }
    if remember_missing {
        state.cache.note_missing(project, &rev);
    }
    Err(ViewError::RevNotFound.into())
}

async fn readable_here(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    rev: &str,
) -> Result<bool, OriginError> {
    let rev = rev.to_string();
    on_mirror(state, lease, token, move |dir| {
        Ok(read::readable(&WorkspaceGit::bare(dir, None), &rev)?)
    })
    .await
}

/// A recovery or salvage ref, read on canonical by exactly its name and
/// fetched: its own id (`tip`) and its commit. A ref canonical does not
/// have is 404 `rev_not_found`.
async fn resolve_ref(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    reference: &str,
) -> Result<FetchedRef, OriginError> {
    let reference = RecoveryRef::parse(reference)?;
    fetch_ref(state, lease, token, reference)
        .await?
        .ok_or_else(|| ViewError::RefNotFound.into())
}

/// [`resolve_ref`] for a ref already parsed; `None` when canonical does
/// not have it (any more).
pub(super) async fn fetch_ref(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    reference: RecoveryRef,
) -> Result<Option<FetchedRef>, OriginError> {
    let project = lease.project();
    let git_token = state.cache.read_token(project, token).await?;
    let url = state.cache.remote_url(project)?;
    let cache = state.cache.clone();
    let mirror_project = project;
    on_mirror(state, lease, token, move |dir| {
        let git = WorkspaceGit::bare(dir, git_token.as_deref())
            .with_network_deadline(Instant::now() + REF_FETCH_DEADLINE);
        let reference = RecoveryRef::validate(&git, reference.as_str())?;
        let Some(tip) =
            remote_tip(&git, &url, &reference).map_err(|error| ref_error(dir, error))?
        else {
            return Ok(None);
        };
        let fetched =
            fetch_refs(&git, &url, &[(reference, tip)]).map_err(|error| ref_error(dir, error));
        cache.size_changed(mirror_project);
        Ok(fetched?.fetched.pop())
    })
    .await
}

/// A path from a query or a route, in the one form reads accept.
fn normalized_path(path: &str) -> Result<String, OriginError> {
    normalize_relative_path(path).ok_or_else(|| ViewError::InvalidPath.into())
}

#[derive(Debug, Deserialize)]
struct EntriesQuery {
    path: Option<String>,
    rev: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AtQuery {
    rev: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

async fn handle_entries(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Query(query): Query<EntriesQuery>,
) -> Result<Response, OriginError> {
    let project = project_of(&state, &claims)?;
    let path = match query.path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => Some(normalized_path(path)?),
        _ => None,
    };
    let lease = state.cache.lease(project);
    let target = read_target(
        &state,
        &lease,
        caller_token(&token),
        query.rev.as_deref(),
        query.reference.as_deref(),
    )
    .await?;
    let commit = target.commit.clone();
    let read = on_mirror(&state, &lease, caller_token(&token), move |dir| {
        Ok(read::entries(
            &WorkspaceGit::bare(dir, None),
            commit.as_deref(),
            path.as_deref(),
        )?)
    })
    .await?;
    let response = match read {
        EntriesRead::Listed(entries) => Json(entries).into_response(),
        EntriesRead::Missing(absence) => missing(absence).into_response(),
    };
    Ok(with_rev(response, target.served.as_deref()))
}

/// A file read: the normalized path, the blob (or the error that came after
/// the commit was found, which still carries `X-Instafy-Rev`), and the id
/// that header names.
type FileOutcome = (
    String,
    Result<(String, Vec<u8>), OriginError>,
    Option<String>,
);

async fn read_file(
    state: &HostedState,
    claims: &OriginClaims,
    token: &OriginAccessToken,
    path: &str,
    query: &AtQuery,
) -> Result<FileOutcome, OriginError> {
    let project = project_of(state, claims)?;
    let path = normalized_path(path)?;
    let lease = state.cache.lease(project);
    let target = read_target(
        state,
        &lease,
        caller_token(token),
        query.rev.as_deref(),
        query.reference.as_deref(),
    )
    .await?;
    let commit = target.commit.clone();
    let read_path = path.clone();
    let read = on_mirror(state, &lease, caller_token(token), move |dir| {
        Ok(read::file(
            &WorkspaceGit::bare(dir, None),
            commit.as_deref(),
            &read_path,
        )?)
    })
    .await?;
    let outcome = match read {
        FileRead::Found { oid, data } => Ok((oid, data)),
        FileRead::TooLarge => Err(coded(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "this file is too large to read here",
        )),
        FileRead::Missing(absence) => Err(missing(absence)),
    };
    Ok((path, outcome, target.served))
}

async fn handle_file(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<AtQuery>,
) -> Result<Response, OriginError> {
    let (path, outcome, served) = read_file(&state, &claims, &token, &path, &query).await?;
    let response = match outcome {
        Ok((oid, data)) => {
            let response = Json(FileContentResponse {
                encoding: "base64".to_string(),
                content_base64: BASE64_STANDARD.encode(&data),
                size: data.len() as u64,
                mime_type: mime_type_for_path(&path),
                modified: None,
                path,
            })
            .into_response();
            with_blob(response, &oid)
        }
        Err(error) => error.into_response(),
    };
    Ok(with_rev(response, served.as_deref()))
}

async fn handle_raw(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<AtQuery>,
) -> Result<Response, OriginError> {
    let (path, outcome, served) = read_file(&state, &claims, &token, &path, &query).await?;
    let response = match outcome {
        Ok((oid, data)) => {
            let mut response = Response::new(Body::from(data));
            let mime = mime_type_for_path(&path);
            if let Some(value) = mime.as_deref().and_then(|mime| mime.parse().ok()) {
                response
                    .headers_mut()
                    .insert(axum::http::header::CONTENT_TYPE, value);
            }
            apply_raw_security_headers(&mut response, &path, mime.as_deref());
            with_blob(response, &oid)
        }
        Err(error) => error.into_response(),
    };
    Ok(with_rev(response, served.as_deref()))
}

#[derive(Debug, Deserialize)]
struct StatusQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

/// The single-tenant status shape: the gateway keeps no working copy, so
/// nothing is ever unsaved here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    supported: bool,
    dirty_count: usize,
    dirty_paths: Vec<DirtyPathEntry>,
    dirty_groups: Vec<DirtyPathGroup>,
    page_offset: usize,
    page_limit: usize,
    has_more_files: bool,
    stateless: bool,
}

/// No git call and no fetch: the answer is the same for every space.
async fn handle_git_status(Query(query): Query<StatusQuery>) -> Json<StatusResponse> {
    Json(StatusResponse {
        supported: true,
        dirty_count: 0,
        dirty_paths: Vec::new(),
        dirty_groups: Vec::new(),
        page_offset: query.offset.unwrap_or(0),
        page_limit: query.limit.unwrap_or(100).clamp(1, 200),
        has_more_files: false,
        stateless: true,
    })
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    limit: Option<usize>,
    skip: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryResponse {
    supported: bool,
    entries: Vec<GitHistoryEntry>,
    branch: &'static str,
    head_ref: &'static str,
    has_more: bool,
}

async fn handle_git_history(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Query(query): Query<HistoryQuery>,
) -> Result<Response, OriginError> {
    let project = project_of(&state, &claims)?;
    let limit = query.limit.unwrap_or(8).clamp(1, MAX_HISTORY_PAGE);
    let skip = query.skip.unwrap_or(0);
    let lease = state.cache.lease(project);
    let main = state
        .cache
        .resolve_main(&lease, Freshness::Coalesced, caller_token(&token))
        .await?;
    let Some(head) = main else {
        return Ok(Json(HistoryResponse {
            supported: true,
            entries: Vec::new(),
            branch: "main",
            head_ref: "main",
            has_more: false,
        })
        .into_response());
    };
    let gateway_email = state.gateway_email();
    let read_head = head.clone();
    let (entries, has_more) = on_mirror(&state, &lease, caller_token(&token), move |dir| {
        Ok(read::history(
            &WorkspaceGit::bare(dir, None),
            &read_head,
            limit,
            skip,
            &gateway_email,
        )?)
    })
    .await?;
    let response = Json(HistoryResponse {
        supported: true,
        entries,
        branch: "main",
        head_ref: "main",
        has_more,
    })
    .into_response();
    Ok(with_rev(response, Some(&head)))
}

#[derive(Debug, Deserialize)]
struct ReviewQuery {
    commit: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewResponse {
    supported: bool,
    commit: Option<String>,
    entries: Vec<DirtyPathEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

/// The code of a commit or ref this space does not have.
const REV_NOT_FOUND: &str = "rev_not_found";

/// Whether `error` says the commit or ref asked for is not here.
fn is_rev_not_found(error: &OriginError) -> bool {
    matches!(error, OriginError::WithReport { code, .. } if *code == REV_NOT_FOUND)
}

/// What review and diff say about a commit (or ref) this space does not
/// have: an answer in their usual shape with `error` and `code`, as the
/// earlier gateway gave. Clients read any 404 on these two routes as "this
/// space has no version tracking".
const REV_NOT_FOUND_MESSAGE: &str = "that version is not in this space's saved history";

/// The commit a review or diff names: with `ref`, the ref's commit, and a
/// `commit` that names neither the ref's id nor its commit means the ref
/// moved since the client listed it (409 `recovery_ref_moved`); without,
/// a commit `main` reaches.
async fn reviewed_commit(
    state: &HostedState,
    lease: &MirrorLease,
    token: Option<&str>,
    commit: Option<&str>,
    reference: Option<&str>,
) -> Result<Option<String>, OriginError> {
    let commit = commit.filter(|value| !value.is_empty());
    match reference.filter(|value| !value.is_empty()) {
        Some(reference) => {
            let requested = commit.map(parse_rev).transpose()?;
            let fetched = resolve_ref(state, lease, token, reference).await?;
            if let Some(requested) = requested {
                if requested != fetched.tip && requested != fetched.commit {
                    return Err(recovery_ref_moved(Some(&fetched.tip)));
                }
            }
            Ok(Some(fetched.commit))
        }
        None => match commit {
            Some(commit) => Ok(Some(
                resolve_reviewed_rev(state, lease, token, commit).await?,
            )),
            None => Ok(None),
        },
    }
}

async fn handle_git_history_review(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<ReviewResponse>, OriginError> {
    let project = project_of(&state, &claims)?;
    let requested = query
        .commit
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(requested) = requested else {
        return Ok(Json(ReviewResponse {
            supported: true,
            commit: None,
            entries: Vec::new(),
            parent_count: None,
            error: Some("missing commit".to_string()),
            code: None,
        }));
    };
    let lease = state.cache.lease(project);
    let commit = match reviewed_commit(
        &state,
        &lease,
        caller_token(&token),
        Some(requested),
        query.reference.as_deref(),
    )
    .await
    {
        Ok(commit) => commit.ok_or_else(|| OriginError::from(ViewError::InvalidRev))?,
        Err(error) if is_rev_not_found(&error) => {
            return Ok(Json(ReviewResponse {
                supported: true,
                commit: Some(requested.to_ascii_lowercase()),
                entries: Vec::new(),
                parent_count: None,
                error: Some(REV_NOT_FOUND_MESSAGE.to_string()),
                code: Some(REV_NOT_FOUND),
            }))
        }
        Err(error) => return Err(error),
    };
    let (entries, parents) = on_mirror(&state, &lease, caller_token(&token), move |dir| {
        Ok(read::review(&WorkspaceGit::bare(dir, None), &commit)?)
    })
    .await?;
    Ok(Json(ReviewResponse {
        supported: true,
        commit: Some(requested.to_ascii_lowercase()),
        entries,
        parent_count: Some(parents),
        error: None,
        code: None,
    }))
}

#[derive(Debug, Deserialize)]
struct DiffQuery {
    path: Option<String>,
    commit: Option<String>,
    base: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResponse {
    supported: bool,
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    diff: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

async fn handle_git_diff(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<DiffResponse>, OriginError> {
    let project = project_of(&state, &claims)?;
    let requested = query
        .commit
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let path = match query.path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => normalized_path(path)?,
        _ => {
            return Ok(Json(DiffResponse {
                supported: true,
                path: None,
                commit: requested,
                diff: String::new(),
                truncated: None,
                error: None,
                code: None,
            }))
        }
    };
    if is_reserved_path(&path) {
        return Err(coded(
            StatusCode::NOT_FOUND,
            "unsupported_entry",
            "this path is reserved and cannot be read here",
        ));
    }
    let token = caller_token(&token);
    let lease = state.cache.lease(project);
    let commit = match reviewed_commit(
        &state,
        &lease,
        token,
        requested.as_deref(),
        query.reference.as_deref(),
    )
    .await
    {
        Ok(commit) => commit,
        Err(error) if is_rev_not_found(&error) => {
            return Ok(Json(DiffResponse {
                supported: true,
                path: Some(path),
                commit: requested,
                diff: String::new(),
                truncated: None,
                error: Some(REV_NOT_FOUND_MESSAGE.to_string()),
                code: Some(REV_NOT_FOUND),
            }))
        }
        Err(error) => return Err(error),
    };
    // A base this space does not have is left out: the change is shown
    // against the commit's first parent instead, as the earlier gateway
    // did.
    let base = match query.base.as_deref().map(str::trim) {
        Some(base) if !base.is_empty() => {
            match resolve_reviewed_rev(&state, &lease, token, base).await {
                Ok(base) => Some(base),
                Err(error) if is_rev_not_found(&error) => None,
                Err(error) => return Err(error),
            }
        }
        _ => None,
    };
    let main = if commit.is_none() {
        state
            .cache
            .resolve_main(&lease, Freshness::Coalesced, token)
            .await?
    } else {
        None
    };
    let diff_path = path.clone();
    let (diff, truncated) = on_mirror(&state, &lease, token, move |dir| {
        Ok(read::diff(
            &WorkspaceGit::bare(dir, None),
            base.as_deref(),
            commit.as_deref(),
            main.as_deref(),
            &diff_path,
        )?)
    })
    .await?;
    Ok(Json(DiffResponse {
        supported: true,
        path: Some(path),
        commit: requested,
        diff,
        truncated: truncated.then_some(true),
        error: None,
        code: None,
    }))
}

async fn handle_git_recovery(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
) -> Result<Response, OriginError> {
    let project = project_of(&state, &claims)?;
    let token = caller_token(&token);
    let lease = state.cache.lease(project);
    let main = state
        .cache
        .resolve_main(&lease, Freshness::Coalesced, token)
        .await?;
    let git_token = state.cache.read_token(project, token).await?;
    let url = state.cache.remote_url(project)?;
    let cache = state.cache.clone();
    let gateway_email = state.gateway_email();
    let list_main = main.clone();
    let entries = on_mirror(&state, &lease, token, move |dir| {
        let git = WorkspaceGit::bare(dir, git_token.as_deref())
            .with_network_deadline(Instant::now() + REF_FETCH_DEADLINE);
        let listed = read::recovery_list(&git, &url, list_main.as_deref(), &gateway_email);
        cache.size_changed(project);
        listed.map_err(|error| ref_error(dir, error))
    })
    .await?;
    let response = Json(serde_json::json!({
        "supported": true,
        "entries": entries,
    }))
    .into_response();
    Ok(with_rev(response, main.as_deref()))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest {
    expected_rev: Option<String>,
    mode: Option<String>,
}

/// Saves are commits on `main` already, so there is nothing to sync:
/// `{expectedRev}` checks that a commit is on `main` (an import's resume
/// relies on it), and anything else answers with `main`.
async fn handle_git_sync(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    let request: SyncRequest = if body.iter().all(u8::is_ascii_whitespace) {
        SyncRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|error| OriginError::bad_request(format!("invalid sync request: {error}")))?
    };
    if request
        .mode
        .as_deref()
        .is_some_and(|mode| mode.trim().eq_ignore_ascii_case("refresh"))
    {
        return Err(coded(
            StatusCode::BAD_REQUEST,
            "not_supported",
            "a cloud space has no working copy to refresh",
        ));
    }
    let expected = request
        .expected_rev
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_rev)
        .transpose()?;
    let lease = state.cache.lease(project);
    let main = state
        .cache
        .resolve_main(&lease, Freshness::Fresh, caller_token(&token))
        .await?;
    let Some(expected) = expected else {
        return Ok(Json(serde_json::json!({
            "rev": main,
            "baseRev": main,
            "committed": false,
        })));
    };
    let on_main = match main.clone() {
        Some(head) => {
            let rev = expected.clone();
            on_mirror(&state, &lease, caller_token(&token), move |dir| {
                Ok(read::on_main(&WorkspaceGit::bare(dir, None), &rev, &head)?)
            })
            .await?
        }
        None => false,
    };
    if !on_main {
        return Err(OriginError::with_report(
            StatusCode::CONFLICT,
            "rev_not_on_main",
            "that version is not part of the saved history",
            serde_json::json!({ "head": main }),
        ));
    }
    Ok(Json(serde_json::json!({ "rev": main, "baseRev": main })))
}

/// Discarding working-copy changes: a cloud space has none.
async fn handle_git_revert() -> OriginError {
    coded(
        StatusCode::BAD_REQUEST,
        "not_supported",
        "discarding changes is not available on a cloud space",
    )
}
