//! One in-memory proxy grant shared by a leased Codex job and its native helpers.
//! Provider credentials and refresh tokens remain exclusively controller-owned.

use std::fmt;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use codex_login::{CodexAuth, ExternalAuth, ExternalAuthFuture, ExternalAuthRefreshContext};
use reqwest::Url;
use runtime_contracts::ProxyEnvelopePayload;
use serde::Deserialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::controller::{ControllerClient, LeaseJob, Registration};
use crate::job_cancel::JobCancelSignal;

const REFRESH_MARGIN_SECONDS: i64 = 60;

tokio::task_local! {
    static CURRENT: Option<Arc<JobProxyAuth>>;
}

/// A task-local avoids putting a runtime bearer in a model's environment or
/// sharing a sibling worker's credentials. Codex captures this before spawning
/// its own task, and then shares the source through its AuthManager.
pub fn current() -> Option<Arc<JobProxyAuth>> {
    CURRENT.try_with(Clone::clone).ok().flatten()
}

pub async fn scope<T>(
    auth: Option<Arc<JobProxyAuth>>,
    future: impl std::future::Future<Output = T>,
) -> T {
    CURRENT.scope(auth, future).await
}

pub(crate) fn for_job(
    client: Arc<ControllerClient>,
    registration: &Registration,
    job: &LeaseJob,
    cancel: Option<JobCancelSignal>,
) -> io::Result<(Option<Arc<JobProxyAuth>>, Option<JobProxyAuthGuard>)> {
    if job.proxy.is_some() || registration.proxy.is_some() {
        let (auth, guard) = JobProxyAuth::new(client, registration, job, cancel)?;
        Ok((Some(auth), Some(guard)))
    } else {
        Ok((None, None))
    }
}

/// Provider-local credentials outrank AuthManager. Remove those static paths
/// so every model request, including a native helper's, resolves the live grant.
pub(crate) fn bind_provider(
    provider: &mut codex_model_provider_info::ModelProviderInfo,
) -> io::Result<()> {
    if provider.aws.is_some() || provider.is_amazon_bedrock() {
        return Err(invalid_grant(
            "job-scoped proxy authentication requires an OpenAI-compatible provider",
        ));
    }
    provider.env_key = None;
    provider.env_key_instructions = None;
    provider.experimental_bearer_token = None;
    provider.auth = None;
    provider.requires_openai_auth = true;
    if let Some(headers) = provider.http_headers.as_mut() {
        headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
    }
    if let Some(headers) = provider.env_http_headers.as_mut() {
        headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
    }
    Ok(())
}

// Decoding here checks consistency, not authenticity. Only the controller may
// mint a grant and only the proxy verifies its signature. Never log these fields.
#[derive(Deserialize, PartialEq, Eq)]
struct GrantScope {
    aud: String,
    iss: String,
    sub: String,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    lease_attempt: i32,
    run_id: Option<Uuid>,
    credential_id: Option<Uuid>,
    agent_handle: Option<String>,
    agent_display_name: Option<String>,
    agent_description: Option<String>,
}

#[derive(Deserialize)]
struct GrantClaims {
    #[serde(flatten)]
    scope: GrantScope,
    exp: i64,
}

struct CachedGrant {
    token: String,
    expires_at: DateTime<Utc>,
}

pub struct JobProxyAuth {
    client: Arc<ControllerClient>,
    registration: Registration,
    job_id: Uuid,
    url: Url,
    scope: GrantScope,
    cached: Mutex<CachedGrant>,
    generation: AtomicU64,
    active: Arc<AtomicBool>,
    revoked: Arc<tokio::sync::Notify>,
    cancel_signal: Option<JobCancelSignal>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl fmt::Debug for JobProxyAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JobProxyAuth")
            .finish_non_exhaustive()
    }
}

/// Held by the parent job, never by a helper. Dropping the parent execution
/// future invalidates the shared source even if a helper retains its Arc.
pub struct JobProxyAuthGuard {
    active: Arc<AtomicBool>,
    revoked: Arc<tokio::sync::Notify>,
}

impl Drop for JobProxyAuthGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.revoked.notify_waiters();
    }
}

impl JobProxyAuth {
    pub fn new(
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        cancel_signal: Option<JobCancelSignal>,
    ) -> io::Result<(Arc<Self>, JobProxyAuthGuard)> {
        Self::with_clock(client, registration, job, cancel_signal, Arc::new(Utc::now))
    }

    fn with_clock(
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        cancel_signal: Option<JobCancelSignal>,
        clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ) -> io::Result<(Arc<Self>, JobProxyAuthGuard)> {
        let envelope = job
            .proxy
            .as_ref()
            .ok_or_else(|| invalid_grant("job is missing its scoped proxy grant"))?;
        let (url, claims, cached) = parse_grant(envelope)?;
        if claims.scope.aud != "proxy"
            || claims.scope.iss != "runtime-controller"
            || claims.scope.sub
                != format!(
                    "proxy:{}:{}",
                    claims.scope.project_id, registration.runtime_id
                )
            || Some(claims.scope.project_id) != job.project_id
            || claims.scope.runtime_id != registration.runtime_id
            || claims.scope.job_id != job.id
            || claims.scope.lease_attempt != job.lease_attempts
            || claims.scope.lease_attempt <= 0
            || claims.scope.run_id != job.run_id
            || claims.scope.credential_id != job.credential_id
        {
            return Err(invalid_grant(
                "job proxy grant scope does not match its lease",
            ));
        }
        let active = Arc::new(AtomicBool::new(true));
        let revoked = Arc::new(tokio::sync::Notify::new());
        let auth = Arc::new(Self {
            client,
            registration: registration.clone(),
            job_id: job.id,
            url,
            scope: claims.scope,
            cached: Mutex::new(cached),
            generation: AtomicU64::new(0),
            active: active.clone(),
            revoked: revoked.clone(),
            cancel_signal,
            clock,
        });
        Ok((auth, JobProxyAuthGuard { active, revoked }))
    }

    fn ensure_active(&self) -> io::Result<()> {
        if !self.active.load(Ordering::SeqCst)
            || self
                .cancel_signal
                .as_ref()
                .is_some_and(JobCancelSignal::is_canceled)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "job proxy grant is no longer active",
            ));
        }
        Ok(())
    }

    /// Direct HTTP workers use the same renewable source as native Codex.
    pub async fn token(&self) -> io::Result<String> {
        self.current_auth(false).await?.get_token()
    }

    /// An isolated child cannot renew. Mint its bounded capability immediately
    /// before spawn instead of handing it a nearly-expired cached grant.
    pub async fn fresh_token(&self) -> io::Result<String> {
        self.current_auth(true).await?.get_token()
    }

    async fn while_active<T>(&self, future: impl std::future::Future<Output = T>) -> io::Result<T> {
        let revoked = self.revoked.notified();
        tokio::pin!(revoked);
        revoked.as_mut().enable();
        self.ensure_active()?;
        let cancelled = async {
            match &self.cancel_signal {
                Some(signal) => signal.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            biased;
            _ = revoked => Err(io::Error::new(io::ErrorKind::PermissionDenied, "job proxy grant is no longer active")),
            _ = cancelled => Err(io::Error::new(io::ErrorKind::PermissionDenied, "job proxy grant is no longer active")),
            result = future => Ok(result),
        }
    }

    async fn current_auth(&self, force_refresh: bool) -> io::Result<CodexAuth> {
        self.ensure_active()?;
        // Overlapping refresh callbacks share a renewal. AuthManager may
        // serialize callbacks before reaching us; each Codex request still has
        // its own bounded UnauthorizedRecovery, not a global helper retry cap.
        let observed_generation = self.generation.load(Ordering::SeqCst);
        let mut cached = self.while_active(self.cached.lock()).await?;
        self.ensure_active()?;
        let now = (self.clock)();
        let needs_refresh = cached.expires_at
            <= now + chrono::Duration::seconds(REFRESH_MARGIN_SECONDS)
            || (force_refresh && observed_generation == self.generation.load(Ordering::SeqCst));
        if needs_refresh {
            let renewal = self.client.renew_job_proxy_token(
                &self.registration,
                self.job_id,
                self.scope.lease_attempt,
            );
            let refreshed = self.while_active(renewal).await?;
            self.ensure_active()?;
            let replacement = refreshed
                .map_err(|error| io::Error::other(error.to_string()))
                .and_then(|envelope| {
                    let (url, claims, grant) = parse_grant(&envelope)?;
                    if url != self.url || claims.scope != self.scope {
                        return Err(invalid_grant(
                            "renewed job proxy grant changed its boundary",
                        ));
                    }
                    if grant.expires_at <= (self.clock)() {
                        return Err(invalid_grant("renewed job proxy grant is expired"));
                    }
                    Ok(grant)
                });
            match replacement {
                Ok(grant) => {
                    *cached = grant;
                    self.generation.fetch_add(1, Ordering::SeqCst);
                }
                Err(error) => {
                    // A failed renewal must not fall back to an older cached
                    // key or independently retry from every native helper.
                    self.active.store(false, Ordering::SeqCst);
                    self.revoked.notify_waiters();
                    cached.token.clear();
                    if let Some(signal) = &self.cancel_signal {
                        signal.cancel();
                    }
                    return Err(error);
                }
            }
        }
        self.ensure_active()?;
        if cached.expires_at <= (self.clock)() {
            return Err(invalid_grant("job proxy grant is expired"));
        }
        Ok(CodexAuth::from_api_key(&cached.token))
    }
}

impl ExternalAuth for JobProxyAuth {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(self.current_auth(false))
    }

    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(self.current_auth(true))
    }
}

fn invalid_grant(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn parse_grant(envelope: &ProxyEnvelopePayload) -> io::Result<(Url, GrantClaims, CachedGrant)> {
    if envelope.token.len() > 16 * 1024 {
        return Err(invalid_grant("invalid job proxy grant"));
    }
    let url = Url::parse(&envelope.url).map_err(|_| invalid_grant("invalid job proxy URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_grant("invalid job proxy URL"));
    }
    let expires_at = envelope
        .expires_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .ok_or_else(|| invalid_grant("job proxy grant is missing a valid expiry"))?;
    let mut parts = envelope.token.split('.');
    let header = parts.next().unwrap_or_default();
    let payload = parts.next().unwrap_or_default();
    let signature = parts.next().unwrap_or_default();
    if header.is_empty() || payload.is_empty() || signature.is_empty() || parts.next().is_some() {
        return Err(invalid_grant("invalid job proxy grant"));
    }
    let claims: GrantClaims = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| invalid_grant("invalid job proxy grant"))?;
    if claims.exp != expires_at.timestamp() {
        return Err(invalid_grant(
            "job proxy grant expiry does not match its token",
        ));
    }
    // JWT exp has whole-second precision; never use envelope fractional seconds
    // to extend the usable lifetime of the signed token.
    let expires_at = DateTime::from_timestamp(claims.exp, 0)
        .ok_or_else(|| invalid_grant("invalid job proxy grant expiry"))?;
    Ok((
        url,
        claims,
        CachedGrant {
            token: envelope.token.clone(),
            expires_at,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use axum::body::Bytes;
    use axum::extract::{Path, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use codex_login::ExternalAuthRefreshReason;
    use serde_json::{Value, json};
    use tokio::sync::Notify;

    use crate::controller::proxy_test_client;

    struct MockController {
        reply: StdMutex<(StatusCode, Value)>,
        requests: StdMutex<Vec<(String, String, Value)>>,
        probe_headers: StdMutex<Vec<String>>,
        hold: AtomicBool,
        started: Notify,
        release: Notify,
    }

    async fn renew(
        State(mock): State<Arc<MockController>>,
        Path(job_id): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> axum::response::Response {
        mock.requests.lock().unwrap().push((
            job_id,
            headers["authorization"].to_str().unwrap().to_owned(),
            serde_json::from_slice(&body).unwrap(),
        ));
        mock.started.notify_one();
        if mock.hold.load(Ordering::SeqCst) {
            mock.release.notified().await;
        }
        // Give simultaneously-polled helper futures a real in-flight request
        // to coalesce around, without model calls or wall-clock TTL waits.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let (status, body) = mock.reply.lock().unwrap().clone();
        (status, axum::Json(body)).into_response()
    }

    async fn auth_header_probe(
        State(mock): State<Arc<MockController>>,
        headers: HeaderMap,
    ) -> StatusCode {
        let bearer = headers["authorization"].to_str().unwrap().to_owned();
        mock.probe_headers.lock().unwrap().push(bearer.clone());
        let reply = mock.reply.lock().unwrap();
        if reply.1["token"]
            .as_str()
            .map(|token| format!("Bearer {token}"))
            == Some(bearer)
        {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        }
    }

    struct Fixture {
        auth: Arc<JobProxyAuth>,
        guard: Option<JobProxyAuthGuard>,
        clock: Arc<StdMutex<DateTime<Utc>>>,
        mock: Arc<MockController>,
        job: LeaseJob,
        registration: Registration,
        signal: JobCancelSignal,
        server: tokio::task::JoinHandle<()>,
    }

    impl Fixture {
        async fn new() -> Self {
            let mock = Arc::new(MockController {
                reply: StdMutex::new((StatusCode::OK, Value::Null)),
                requests: StdMutex::new(Vec::new()),
                probe_headers: StdMutex::new(Vec::new()),
                hold: AtomicBool::new(false),
                started: Notify::new(),
                release: Notify::new(),
            });
            let app = axum::Router::new()
                .route("/agent/jobs/:job_id/proxy-token", post(renew))
                .route("/auth-header-probe", post(auth_header_probe))
                .with_state(mock.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url =
                Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let (client, registration) = proxy_test_client(base_url);
            let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
            let clock = Arc::new(StdMutex::new(now));
            let mut job: LeaseJob = serde_json::from_value(json!({
                "id": Uuid::new_v4(),
                "project_id": Uuid::new_v4(),
                "run_id": Uuid::new_v4(),
                "credential_id": Uuid::new_v4(),
                "lease_attempts": 1,
            }))
            .unwrap();
            let initial = envelope(
                &job,
                registration.runtime_id,
                now + chrono::Duration::seconds(1800),
            );
            job.proxy = Some(initial.clone());
            *mock.reply.lock().unwrap() = (StatusCode::OK, serde_json::to_value(initial).unwrap());
            let signal = JobCancelSignal::new();
            let (auth, guard) = JobProxyAuth::with_clock(
                Arc::new(client),
                &registration,
                &job,
                Some(signal.clone()),
                {
                    let clock = clock.clone();
                    Arc::new(move || *clock.lock().unwrap())
                },
            )
            .unwrap();
            Self {
                auth,
                guard: Some(guard),
                clock,
                mock,
                job,
                registration,
                signal,
                server,
            }
        }

        fn advance(&self, seconds: i64) {
            *self.clock.lock().unwrap() += chrono::Duration::seconds(seconds);
        }

        fn replacement(&self) -> ProxyEnvelopePayload {
            envelope(
                &self.job,
                self.registration.runtime_id,
                *self.clock.lock().unwrap() + chrono::Duration::seconds(1800),
            )
        }

        fn reply(&self, grant: ProxyEnvelopePayload) {
            *self.mock.reply.lock().unwrap() =
                (StatusCode::OK, serde_json::to_value(grant).unwrap());
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    // Inert, intentionally unsigned fixture. The consistency reader is not a
    // signature verifier, and these tokens never reach a model or proxy.
    fn envelope(job: &LeaseJob, runtime_id: Uuid, expires: DateTime<Utc>) -> ProxyEnvelopePayload {
        let payload = json!({
            "aud": "proxy",
            "iss": "runtime-controller",
            "sub": format!("proxy:{}:{runtime_id}", job.project_id.unwrap()),
            "project_id": job.project_id,
            "runtime_id": runtime_id,
            "job_id": job.id,
            "lease_attempt": job.lease_attempts,
            "run_id": job.run_id,
            "credential_id": job.credential_id,
            "agent_handle": "test-reviewer",
            "agent_display_name": "Test Reviewer",
            "agent_description": "Inert job proxy renewal fixture",
            "exp": expires.timestamp(),
        });
        ProxyEnvelopePayload {
            url: "https://proxy.example.invalid/v1".into(),
            token: format!(
                "e30.{}.inert-test-signature",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
            ),
            expires_at: Some(expires.to_rfc3339()),
        }
    }

    fn change_claim(grant: &mut ProxyEnvelopePayload, key: &str, value: Value) {
        let encoded = grant.token.split('.').nth(1).unwrap();
        let mut payload: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        payload[key] = value;
        grant.token = format!(
            "e30.{}.inert-test-signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
    }

    fn unauthorized() -> ExternalAuthRefreshContext {
        ExternalAuthRefreshContext {
            reason: ExternalAuthRefreshReason::Unauthorized,
            previous_account_id: None,
        }
    }

    #[tokio::test]
    async fn initial_grant_is_cached_and_debug_is_redacted() {
        let fixture = Fixture::new().await;
        assert_eq!(
            fixture.auth.resolve().await.unwrap().api_key(),
            Some(fixture.job.proxy.as_ref().unwrap().token.as_str())
        );
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 0);
        let debug = format!("{:?}", fixture.auth);
        assert!(!debug.contains(&fixture.job.proxy.as_ref().unwrap().token));
        assert!(!debug.contains("test-spawn-time-agent"));
        assert!(!debug.contains("proxy.example.invalid"));
    }

    #[tokio::test]
    async fn helpers_share_one_renewal_after_more_than_thirty_minutes() {
        let fixture = Fixture::new().await;
        fixture.advance(1900);
        let replacement = fixture.replacement();
        fixture.reply(replacement.clone());
        let results = futures_util::future::join_all((0..8).map(|_| fixture.auth.resolve())).await;
        for result in results {
            assert_eq!(result.unwrap().api_key(), Some(replacement.token.as_str()));
        }
        assert_eq!(
            *fixture.mock.requests.lock().unwrap(),
            [(
                fixture.job.id.to_string(),
                "Bearer test-spawn-time-agent".into(),
                json!({"lease_attempt": 1})
            )]
        );
    }

    #[tokio::test]
    async fn refreshes_before_expiry_and_coalesces_overlapping_unauthorized_callbacks() {
        let fixture = Fixture::new().await;
        fixture.advance(1740);
        let replacement = fixture.replacement();
        fixture.reply(replacement.clone());
        assert_eq!(
            fixture.auth.resolve().await.unwrap().api_key(),
            Some(replacement.token.as_str())
        );
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 1);
        fixture.advance(1);
        let next = fixture.replacement();
        fixture.reply(next.clone());
        let results =
            futures_util::future::join_all((0..8).map(|_| fixture.auth.refresh(unauthorized())))
                .await;
        for result in results {
            assert_eq!(result.unwrap().api_key(), Some(next.token.as_str()));
        }
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn auth_manager_retries_once_with_new_grant_then_clears_shared_auth_on_rejection() {
        let fixture = Fixture::new().await;
        let manager = codex_login::AuthManager::from_auth_for_testing(CodexAuth::from_api_key(
            "inert-fallback-must-not-be-used",
        ));
        manager
            .set_external_auth(fixture.auth.clone())
            .await
            .unwrap();
        let helper_manager = manager.clone();
        let initial = fixture.job.proxy.as_ref().unwrap().token.clone();
        assert_eq!(
            manager.auth().await.unwrap().api_key(),
            Some(initial.as_str())
        );

        fixture.advance(1);
        let replacement = fixture.replacement();
        fixture.reply(replacement.clone());
        let probe_url = fixture
            .registration
            .lease_url
            .join("/auth-header-probe")
            .unwrap();
        let http = reqwest::Client::new();
        // This loopback service only checks inert Authorization headers. It is
        // not a model endpoint or a claim of full Codex network integration.
        let first = http
            .post(probe_url.clone())
            .bearer_auth(manager.auth().await.unwrap().get_token().unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(first.status().as_u16(), 401);
        let mut recovery = manager.unauthorized_recovery();
        assert!(recovery.has_next());
        assert_eq!(recovery.step_name(), "external_refresh");
        recovery.next().await.unwrap();
        assert!(!recovery.has_next());
        assert_eq!(recovery.unavailable_reason(), "recovery_exhausted");
        let second = http
            .post(probe_url)
            .bearer_auth(helper_manager.auth().await.unwrap().get_token().unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(second.status().as_u16(), 200);
        assert!(recovery.next().await.is_err());
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 1);
        assert_eq!(
            *fixture.mock.probe_headers.lock().unwrap(),
            [
                format!("Bearer {initial}"),
                format!("Bearer {}", replacement.token)
            ]
        );
        assert_eq!(
            manager.auth_cached().unwrap().api_key(),
            Some(replacement.token.as_str())
        );

        fixture.advance(1800);
        *fixture.mock.reply.lock().unwrap() = (
            StatusCode::CONFLICT,
            json!({"message": "inert-revoked-lease"}),
        );
        assert!(helper_manager.auth().await.is_none());
        assert!(manager.auth_cached().is_none());
        assert!(fixture.signal.is_canceled());
        assert!(fixture.auth.cached.lock().await.token.is_empty());
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn parent_drop_and_cancellation_revoke_cached_grants_without_a_request() {
        for cancel in [false, true] {
            let mut fixture = Fixture::new().await;
            let helper = fixture.auth.clone();
            if cancel {
                fixture.signal.cancel();
            } else {
                drop(fixture.guard.take());
            }
            assert_eq!(
                helper.resolve().await.unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
            assert!(helper.refresh(unauthorized()).await.is_err());
            assert_eq!(fixture.mock.requests.lock().unwrap().len(), 0);
        }
    }

    #[tokio::test]
    async fn cancellation_or_parent_drop_during_renewal_cannot_install_a_new_grant() {
        for cancel in [false, true] {
            let mut fixture = Fixture::new().await;
            fixture.advance(1900);
            let replacement = fixture.replacement();
            fixture.reply(replacement.clone());
            fixture.mock.hold.store(true, Ordering::SeqCst);
            let pending = {
                let helper = fixture.auth.clone();
                tokio::spawn(async move { helper.resolve().await })
            };
            fixture.mock.started.notified().await;
            if cancel {
                fixture.signal.cancel();
            } else {
                drop(fixture.guard.take());
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(250), pending)
                    .await
                    .expect("revocation must cancel an in-flight renewal without its response")
                    .unwrap()
                    .is_err()
            );
            fixture.mock.release.notify_one();
            assert!(fixture.auth.resolve().await.is_err());
            assert_ne!(fixture.auth.cached.lock().await.token, replacement.token);
            assert_eq!(fixture.mock.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn controller_rejection_clears_grant_and_cancels_all_helpers() {
        for status in [
            StatusCode::CONFLICT,
            StatusCode::NOT_FOUND,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let fixture = Fixture::new().await;
            fixture.advance(1740);
            *fixture.mock.reply.lock().unwrap() =
                (status, json!({"message": "never-log-this-token-body"}));
            let error = fixture.auth.resolve().await.unwrap_err();
            assert!(!format!("{error:?} {error}").contains("never-log-this"));
            assert!(fixture.signal.is_canceled());
            assert!(fixture.auth.cached.lock().await.token.is_empty());
            assert!(fixture.auth.resolve().await.is_err());
            assert!(fixture.auth.refresh(unauthorized()).await.is_err());
            assert_eq!(fixture.mock.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn renewal_rejects_scope_identity_and_url_changes() {
        for key in [
            "aud",
            "iss",
            "sub",
            "project_id",
            "runtime_id",
            "job_id",
            "lease_attempt",
            "run_id",
            "credential_id",
            "agent_handle",
            "agent_display_name",
            "agent_description",
            "url",
        ] {
            let fixture = Fixture::new().await;
            fixture.advance(1740);
            let mut replacement = fixture.replacement();
            if key == "url" {
                replacement.url = "https://different.example.invalid/v1".into();
            } else if key == "lease_attempt" {
                change_claim(&mut replacement, key, json!(2));
            } else {
                change_claim(&mut replacement, key, json!(Uuid::new_v4().to_string()));
            }
            fixture.reply(replacement);
            assert!(
                fixture.auth.resolve().await.is_err(),
                "accepted changed {key}"
            );
            assert!(fixture.signal.is_canceled());
        }
    }

    #[tokio::test]
    async fn renewal_rejects_missing_invalid_and_expired_expiry() {
        for invalid in ["missing", "invalid", "expired", "mismatch"] {
            let fixture = Fixture::new().await;
            fixture.advance(1900);
            let mut replacement = fixture.replacement();
            match invalid {
                "missing" => replacement.expires_at = None,
                "invalid" => replacement.expires_at = Some("not-a-time".into()),
                "expired" => replacement = fixture.job.proxy.as_ref().unwrap().clone(),
                "mismatch" => change_claim(&mut replacement, "exp", json!(1)),
                _ => unreachable!(),
            }
            fixture.reply(replacement);
            assert!(
                fixture.auth.resolve().await.is_err(),
                "accepted {invalid} expiry"
            );
            assert!(fixture.signal.is_canceled());
        }
    }

    #[tokio::test]
    async fn initial_grant_must_be_job_scoped() {
        let fixture = Fixture::new().await;
        for field in [
            "project",
            "runtime",
            "job",
            "attempt",
            "run",
            "credential",
            "missing",
        ] {
            let mut job = fixture.job.clone();
            let mut registration = fixture.registration.clone();
            match field {
                "project" => job.project_id = Some(Uuid::new_v4()),
                "runtime" => registration.runtime_id = Uuid::new_v4(),
                "job" => job.id = Uuid::new_v4(),
                "attempt" => job.lease_attempts += 1,
                "run" => job.run_id = Some(Uuid::new_v4()),
                "credential" => job.credential_id = Some(Uuid::new_v4()),
                "missing" => {
                    registration.proxy = job.proxy.take();
                }
                _ => unreachable!(),
            }
            assert!(
                JobProxyAuth::new(fixture.auth.client.clone(), &registration, &job, None).is_err()
            );
        }
    }

    #[tokio::test]
    async fn direct_request_scope_uses_the_renewed_grant_and_does_not_leak_to_other_jobs() {
        let fixture = Fixture::new().await;
        fixture.advance(1900);
        let replacement = fixture.replacement();
        fixture.reply(replacement.clone());
        assert!(current().is_none());
        let token = scope(Some(fixture.auth.clone()), async {
            current().expect("job scope").token().await.unwrap()
        })
        .await;
        assert_eq!(token, replacement.token);
        assert!(current().is_none());
        fixture.signal.cancel();
        assert!(
            scope(Some(fixture.auth.clone()), async {
                current().unwrap().token().await
            })
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn isolated_child_gets_a_fresh_grant_even_before_the_refresh_margin() {
        let fixture = Fixture::new().await;
        fixture.advance(1200);
        let replacement = fixture.replacement();
        fixture.reply(replacement.clone());
        assert_eq!(
            fixture.auth.token().await.unwrap(),
            fixture.job.proxy.as_ref().unwrap().token
        );
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 0);
        assert_eq!(fixture.auth.fresh_token().await.unwrap(), replacement.token);
        assert_eq!(fixture.mock.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn job_proxy_auth_removes_static_provider_credentials_without_changing_route() {
        let mut provider: codex_model_provider_info::ModelProviderInfo = serde_json::from_value(json!({
            "name": "instafy-proxy", "base_url": "https://proxy.example.invalid/v1",
            "env_key": "INERT_STATIC_PROXY_TOKEN", "experimental_bearer_token": "inert-stale-token",
            "auth": {"command": "must-never-run"},
            "http_headers": {"aUtHoRiZaTiOn": "Bearer inert-stale-token", "x-test": "preserve"},
            "env_http_headers": {"AUTHORIZATION": "INERT_STATIC_PROXY_TOKEN"}
        })).unwrap();
        bind_provider(&mut provider).unwrap();
        provider.validate().unwrap();
        assert!(provider.api_key().unwrap().is_none());
        assert!(provider.experimental_bearer_token.is_none());
        assert!(provider.auth.is_none());
        assert!(provider.requires_openai_auth);
        let api_provider = provider.to_api_provider(None).unwrap();
        assert_eq!(api_provider.base_url, "https://proxy.example.invalid/v1");
        assert!(!api_provider.headers.contains_key("authorization"));
        assert_eq!(api_provider.headers.get("x-test").unwrap(), "preserve");
    }
}
