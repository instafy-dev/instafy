use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::FutureExt;
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet, KeyAlgorithm};
use jsonwebtoken::{Algorithm, DecodingKey};
use reqwest::Client;
use tokio::sync::{watch, Notify, RwLock};
use tokio::time::Instant;
use url::{Host, Url};

/// Upper bound on every JWKS fetch. The blocking one at startup runs on a
/// thread the config builder joins, and the refresher's run on its own task;
/// reqwest applies no default timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// How long an auth retry waits for the refresher to finish a fetch before it
/// answers with the key set the cache already holds.
pub const AUTH_REFRESH_WAIT: Duration = Duration::from_secs(2);

/// Stands in for "never" when a configured interval overflows an [`Instant`].
const FAR_FUTURE: Duration = Duration::from_secs(365 * 24 * 60 * 60);

const USER_AGENT: &str = "instafy-runtime-controller";

/// Where GoTrue serves its signing keys, below the Supabase project URL.
pub const SUPABASE_JWKS_PATH: &str = "/auth/v1/.well-known/jwks.json";

/// Deployment switches for [`SupabaseJwksUrl::resolve`].
#[derive(Clone, Copy, Debug, Default)]
pub struct JwksUrlPolicy {
    /// `DEV_MODE`: plain http to a loopback JWKS host is accepted.
    pub dev_mode: bool,
    /// `SUPABASE_JWKS_URL_ALLOW_OTHER_HOST`: fetch the key set from a host
    /// other than the Supabase project URL's, for deployments that reach the
    /// same Supabase Auth service under two names (a custom domain and the
    /// project domain, or a public and an internal gateway). Off by default
    /// because the key set decides which access tokens are accepted.
    pub allow_other_host: bool,
}

/// The Supabase JWKS endpoint, validated once when the configuration loads.
///
/// Whatever this endpoint serves decides which access tokens the controller
/// accepts, so a key set fetched from the wrong place, or over a connection
/// someone can intercept, lets them sign in as anyone. The loaders therefore
/// take only this type, and it only comes from [`SupabaseJwksUrl::resolve`]:
/// https (plain http only to a loopback host during local development), the
/// Supabase JWKS path under the project URL, no credentials, query or
/// fragment, and the project URL's host and port unless the operator opts in
/// to another host. Fetches also never follow redirects, so the request goes
/// to this URL and nowhere else.
#[derive(Clone, PartialEq, Eq)]
pub struct SupabaseJwksUrl(Url);

impl SupabaseJwksUrl {
    /// Validate `SUPABASE_JWKS_URL` (`configured`), or derive the endpoint
    /// from the Supabase project URL when it is unset. Errors name the
    /// variable and the rule, never the configured value, which may carry
    /// credentials.
    pub fn resolve(
        supabase_project_url: &str,
        configured: Option<&str>,
        policy: JwksUrlPolicy,
    ) -> Result<Self> {
        let project = Url::parse(supabase_project_url.trim())
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
            .ok_or_else(|| {
                anyhow!(
                    "the Supabase project URL (SUPABASE_PROJECT_URL or SUPABASE_URL) must be an \
                     absolute http or https URL"
                )
            })?;
        let jwks_path = format!(
            "{}{SUPABASE_JWKS_PATH}",
            project.path().trim_end_matches('/')
        );
        let (name, url) = match configured.map(str::trim).filter(|value| !value.is_empty()) {
            Some(raw) => (
                "SUPABASE_JWKS_URL",
                Url::parse(raw)
                    .map_err(|_| anyhow!("SUPABASE_JWKS_URL must be an absolute URL"))?,
            ),
            None => {
                let mut derived = project.clone();
                derived.set_path(&jwks_path);
                derived.set_query(None);
                derived.set_fragment(None);
                (
                    "the JWKS URL derived from the Supabase project URL",
                    derived,
                )
            }
        };

        if !url.username().is_empty() || url.password().is_some() {
            bail!("{name} must not contain credentials");
        }
        if url.query().is_some() || url.fragment().is_some() {
            bail!("{name} must not have a query string or fragment");
        }
        match url.scheme() {
            "https" => {}
            "http" if is_loopback(&url) && (policy.dev_mode || is_loopback(&project)) => {}
            _ => bail!(
                "{name} must use https; plain http is accepted only for a loopback host, under \
                 DEV_MODE or with a loopback Supabase project URL"
            ),
        }
        if url.path() != jwks_path {
            bail!(
                "{name} must be the Supabase JWKS endpoint, {SUPABASE_JWKS_PATH} under the \
                 Supabase project URL"
            );
        }
        let same_host = url.host() == project.host()
            && url.port_or_known_default() == project.port_or_known_default();
        if !same_host && !policy.allow_other_host {
            bail!(
                "{name} must be on the host and port of the Supabase project URL; set \
                 SUPABASE_JWKS_URL_ALLOW_OTHER_HOST=1 if this deployment serves Supabase Auth \
                 under another host"
            );
        }
        Ok(Self(url))
    }

    pub fn as_url(&self) -> &Url {
        &self.0
    }

    /// The endpoint of a Supabase project URL a test controls, validated as
    /// under DEV_MODE so a loopback test server over http is accepted.
    #[cfg(test)]
    pub(crate) fn for_test(supabase_project_url: &str) -> Self {
        Self::resolve(
            supabase_project_url,
            None,
            JwksUrlPolicy {
                dev_mode: true,
                allow_other_host: false,
            },
        )
        .expect("a valid test Supabase project URL")
    }
}

/// Validation removed any credentials, so the URL is safe to log.
impl fmt::Display for SupabaseJwksUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.as_str())
    }
}

impl fmt::Debug for SupabaseJwksUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SupabaseJwksUrl")
            .field(&self.0.as_str())
            .finish()
    }
}

/// `localhost` or a loopback address. Other names are not trusted to resolve
/// to this machine.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => {
            address.is_loopback()
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_loopback())
        }
        None => false,
    }
}

#[derive(Clone)]
pub struct SupabaseJwks {
    algorithm: Algorithm,
    keys: Arc<HashMap<String, Arc<DecodingKey>>>,
    default_key: Option<Arc<DecodingKey>>,
}

impl SupabaseJwks {
    /// Blocking load used once at startup.
    ///
    /// Bounded on purpose: this runs on a thread the config builder joins
    /// synchronously, so an unbounded fetch does not merely slow boot -- it
    /// hangs it, with no log line and no timeout to break the wait. reqwest
    /// applies no default timeout.
    ///
    /// The status check mirrors `load_async`. Without it a 5xx or an HTML
    /// error page is fed to the JSON parser, and the operator sees "failed to
    /// parse Supabase JWKS response" for what is really an upstream outage.
    pub fn load(jwks_url: &SupabaseJwksUrl) -> Result<Self> {
        let response = reqwest::blocking::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .context("failed to construct blocking HTTP client for JWKS fetch")?
            .get(jwks_url.as_url().clone())
            .send()
            .with_context(|| format!("failed to fetch Supabase JWKS from {}", jwks_url))?;

        let status = response.status();
        if !status.is_success() {
            bail!(
                "failed to fetch Supabase JWKS: status={} url={}",
                status,
                jwks_url
            );
        }

        let set: JwkSet = response
            .json()
            .context("failed to parse Supabase JWKS response")?;

        Self::from_jwk_set(set)
    }

    pub fn from_jwk_set(set: JwkSet) -> Result<Self> {
        if set.keys.is_empty() {
            bail!("Supabase JWKS response did not contain any keys");
        }

        let mut keys: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        let mut algorithm: Option<Algorithm> = None;
        let mut default_key: Option<Arc<DecodingKey>> = None;

        for jwk in set.keys {
            let kid = jwk
                .common
                .key_id
                .clone()
                .unwrap_or_else(|| "default".to_string());

            let alg = match jwk.common.key_algorithm {
                Some(KeyAlgorithm::ES256) | None => Algorithm::ES256,
                Some(KeyAlgorithm::RS256) => Algorithm::RS256,
                Some(other) => {
                    bail!("Supabase JWKS reported unsupported algorithm {:?}", other)
                }
            };

            if let Some(existing_alg) = algorithm {
                if existing_alg != alg {
                    bail!(
                        "Supabase JWKS returned mixed algorithms (found both {:?} and {:?})",
                        existing_alg,
                        alg
                    );
                }
            } else {
                algorithm = Some(alg);
            }

            let decoding_key = match (&jwk.algorithm, alg) {
                (AlgorithmParameters::EllipticCurve(params), Algorithm::ES256) => {
                    let key = DecodingKey::from_ec_components(&params.x, &params.y)
                        .context("failed to construct EC decoding key from Supabase JWKS entry")?;
                    Arc::new(key)
                }
                (AlgorithmParameters::RSA(params), Algorithm::RS256) => {
                    let key = DecodingKey::from_rsa_components(&params.n, &params.e)
                        .context("failed to construct RSA decoding key from Supabase JWKS entry")?;
                    Arc::new(key)
                }
                _ => {
                    bail!(
                        "Supabase JWKS contained unsupported key parameters for algorithm {:?}",
                        alg
                    )
                }
            };

            if default_key.is_none() {
                default_key = Some(decoding_key.clone());
            }

            keys.insert(kid, decoding_key);
        }

        Ok(Self {
            algorithm: algorithm
                .ok_or_else(|| anyhow!("Supabase JWKS did not contain a usable algorithm"))?,
            keys: Arc::new(keys),
            default_key,
        })
    }

    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }

    pub fn decoding_key(&self, kid: Option<&str>) -> Option<Arc<DecodingKey>> {
        match kid {
            Some(kid) => {
                if let Some(key) = self.keys.get(kid).cloned() {
                    return Some(key);
                }
                // Supabase still uses HS256 for its GoTrue access tokens, but includes a `kid`
                // header that does not correspond to our shared-secret verifier. When we're in
                // HS256 mode, treat `kid` as advisory and fall back to the default key.
                if self.algorithm == Algorithm::HS256 {
                    return self.default_key.clone();
                }
                None
            }
            None => self.default_key.clone(),
        }
    }

    /// Build an HS256-only key set from a shared secret. Used for local Supabase CLI
    /// instances that still rely on the legacy secret signing flow.
    pub fn from_hmac_secret(secret: &str) -> Self {
        let key = Arc::new(DecodingKey::from_secret(secret.as_bytes()));
        let mut map = HashMap::new();
        map.insert("hmac".to_string(), key.clone());
        Self {
            algorithm: Algorithm::HS256,
            keys: Arc::new(map),
            default_key: Some(key),
        }
    }
}

/// The Supabase key set the auth path verifies access tokens against.
///
/// Requests never fetch keys. When a token names a key the cache does not
/// hold, the auth path signals the [`JwksRefresher`], which alone holds the
/// JWKS URL, and waits briefly for its fetch. Signals coalesce, and the
/// refresher fetches on demand at most once per configured interval, so
/// however many requests carry unknown key ids, the controller downloads only
/// the configured key set, and only at a rate the operator chose at startup.
#[derive(Clone)]
pub struct SupabaseJwksCache {
    shared: Arc<CacheShared>,
}

struct CacheShared {
    key_set: RwLock<SupabaseJwks>,
    refresher: watch::Sender<RefresherState>,
    /// Requests that found no usable key. A single stored permit, so any
    /// number of signals before the refresher looks amounts to one.
    wanted: Notify,
}

#[derive(Clone, Copy, Debug)]
struct RefresherState {
    /// A refresher task serves this cache. Without one nobody would answer a
    /// signal, so the auth path does not wait.
    running: bool,
    /// Fetches the refresher has finished, successful or not. Bumped only
    /// after a fetched key set has replaced the cached one.
    finished: u64,
    fetching: bool,
    /// The earliest a fetch that a signal asks for can start.
    on_demand_from: Option<Instant>,
    /// How long the auth path waits for a fetch it asked for.
    auth_wait: Duration,
}

/// The cached key set and the number of refresher fetches that had finished
/// when it was read, which [`SupabaseJwksCache::wait_for_refresh`] compares
/// against.
pub struct JwksSnapshot {
    pub key_set: SupabaseJwks,
    pub generation: u64,
}

impl SupabaseJwksCache {
    pub fn new(key_set: SupabaseJwks) -> Self {
        let (refresher, _) = watch::channel(RefresherState {
            running: false,
            finished: 0,
            fetching: false,
            on_demand_from: None,
            auth_wait: AUTH_REFRESH_WAIT,
        });
        Self {
            shared: Arc::new(CacheShared {
                key_set: RwLock::new(key_set),
                refresher,
                wanted: Notify::new(),
            }),
        }
    }

    pub async fn snapshot(&self) -> JwksSnapshot {
        // Generation before keys, while the refresher replaces the keys before
        // it bumps the generation: the keys read here are never older than the
        // generation says, so a fetch that lands in between is not missed.
        let generation = self.shared.refresher.borrow().finished;
        let key_set = self.shared.key_set.read().await.clone();
        JwksSnapshot {
            key_set,
            generation,
        }
    }

    /// Ask the refresher for a fresh key set after a snapshot of `generation`
    /// had no key for a token, and wait, at most the refresher's auth wait,
    /// for a fetch to finish. True when one has finished since that snapshot,
    /// so the caller should look again. This never fetches.
    pub async fn wait_for_refresh(&self, generation: u64) -> bool {
        let mut refresher = self.shared.refresher.subscribe();
        let state = *refresher.borrow_and_update();
        if !state.running {
            return false;
        }
        if state.finished != generation {
            // A fetch finished after the snapshot was taken.
            return true;
        }
        self.shared.wanted.notify_one();
        let deadline = Instant::now() + state.auth_wait;
        if !state.fetching && state.on_demand_from.is_some_and(|from| from > deadline) {
            // The refresher is between fetches and may not start another in
            // time. The signal stands: it fetches when its interval allows,
            // and later requests see the result.
            return false;
        }
        let refreshed = match tokio::time::timeout_at(
            deadline,
            refresher.wait_for(|state| state.finished != generation || !state.running),
        )
        .await
        {
            Ok(Ok(state)) => state.finished != generation,
            _ => false,
        };
        refreshed
    }

    async fn replace(&self, key_set: SupabaseJwks) {
        *self.shared.key_set.write().await = key_set;
    }
}

impl fmt::Debug for SupabaseJwksCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = *self.shared.refresher.borrow();
        f.debug_struct("SupabaseJwksCache")
            .field("refresher_running", &state.running)
            .field("refreshes", &state.finished)
            .finish_non_exhaustive()
    }
}

/// How often the [`JwksRefresher`] fetches. Set once, from the startup
/// configuration; nothing a request carries changes it.
#[derive(Clone, Copy, Debug)]
pub struct JwksRefreshSchedule {
    /// Between routine fetches (`SUPABASE_JWKS_REFRESH_SECONDS`).
    pub periodic: Duration,
    /// Minimum time from the start of one fetch to the start of a fetch a
    /// request asks for (`SUPABASE_JWKS_ON_DEMAND_INTERVAL_SECONDS`).
    pub on_demand_interval: Duration,
    /// How long a request waits for the fetch it asked for.
    pub auth_wait: Duration,
}

impl JwksRefreshSchedule {
    pub fn new(periodic: Duration, on_demand_interval: Duration) -> Self {
        Self {
            periodic,
            on_demand_interval,
            auth_wait: AUTH_REFRESH_WAIT,
        }
    }
}

/// The only code that fetches the key set after startup: one task, built at
/// startup from the validated URL in the configuration, that owns that URL
/// and its client. It fetches once when spawned, then on the periodic
/// schedule, and when a request signals through the [`SupabaseJwksCache`],
/// no sooner than the on-demand interval after its previous fetch began.
pub struct JwksRefresher {
    url: SupabaseJwksUrl,
    client: Client,
    cache: SupabaseJwksCache,
    schedule: JwksRefreshSchedule,
}

impl JwksRefresher {
    pub fn new(
        url: SupabaseJwksUrl,
        cache: SupabaseJwksCache,
        schedule: JwksRefreshSchedule,
    ) -> Result<Self> {
        let client = Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .context("failed to construct HTTP client for JWKS refresh")?;
        Ok(Self {
            url,
            client,
            cache,
            schedule,
        })
    }

    /// Start serving the cache. Spawn one refresher per cache.
    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        let auth_wait = self.schedule.auth_wait;
        self.cache.shared.refresher.send_modify(|state| {
            state.running = true;
            state.auth_wait = auth_wait;
        });
        // Owned by the task, so however it ends, even aborted before its
        // first poll, requests stop waiting for it.
        let running = RefresherRunning(self.cache.clone());
        tokio::spawn(async move {
            let _running = running;
            self.run().await
        })
    }

    async fn run(self) {
        let shared = &self.cache.shared;
        let mut reason = "startup";
        loop {
            // Every signal so far is answered by this fetch.
            let _ = shared.wanted.notified().now_or_never();
            let started = Instant::now();
            let on_demand_from = later(started, self.schedule.on_demand_interval);
            shared.refresher.send_modify(|state| {
                state.fetching = true;
                state.on_demand_from = Some(on_demand_from);
            });
            match self.fetch().await {
                Ok(key_set) => {
                    self.cache.replace(key_set).await;
                    tracing::debug!(reason, "Supabase JWKS refreshed");
                }
                Err(error) => {
                    tracing::warn!(%error, reason, "failed to refresh Supabase JWKS");
                }
            }
            shared.refresher.send_modify(|state| {
                state.fetching = false;
                state.finished += 1;
            });

            let periodic_at = later(Instant::now(), self.schedule.periodic);
            tokio::select! {
                () = tokio::time::sleep_until(periodic_at) => reason = "periodic",
                () = shared.wanted.notified() => {
                    // Signals until the fetch starts ride on this one.
                    tokio::time::sleep_until(on_demand_from.min(periodic_at)).await;
                    reason = "unknown key id";
                }
            }
        }
    }

    async fn fetch(&self) -> Result<SupabaseJwks> {
        let response = self
            .client
            .get(self.url.as_url().clone())
            .send()
            .await
            .with_context(|| format!("failed to fetch Supabase JWKS from {}", self.url))?;

        let status = response.status();
        if !status.is_success() {
            bail!(
                "failed to fetch Supabase JWKS: status={} url={}",
                status,
                self.url
            );
        }

        let set: JwkSet = response
            .json()
            .await
            .context("failed to parse Supabase JWKS response")?;

        SupabaseJwks::from_jwk_set(set)
    }
}

struct RefresherRunning(SupabaseJwksCache);

impl Drop for RefresherRunning {
    fn drop(&mut self) {
        self.0.shared.refresher.send_modify(|state| {
            state.running = false;
            state.fetching = false;
        });
    }
}

fn later(from: Instant, by: Duration) -> Instant {
    from.checked_add(by).unwrap_or_else(|| from + FAR_FUTURE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn startup_fetch_is_bounded() {
        // The blocking startup load runs on a thread the config builder joins
        // synchronously, so an unbounded fetch hangs boot rather than slowing
        // it. reqwest applies no default timeout, so this must be explicit.
        assert!(FETCH_TIMEOUT.as_secs() > 0);
        assert!(
            FETCH_TIMEOUT.as_secs() <= 30,
            "a startup fetch bound above 30s stops being a bound in practice"
        );
    }

    fn resolve(project: &str, configured: Option<&str>, dev_mode: bool) -> Result<String> {
        SupabaseJwksUrl::resolve(
            project,
            configured,
            JwksUrlPolicy {
                dev_mode,
                allow_other_host: false,
            },
        )
        .map(|url| url.to_string())
    }

    #[test]
    fn the_jwks_url_defaults_to_the_project_endpoint() {
        for dev_mode in [false, true] {
            assert_eq!(
                resolve("https://abc.supabase.co/", None, dev_mode).unwrap(),
                "https://abc.supabase.co/auth/v1/.well-known/jwks.json"
            );
            // The local Supabase CLI serves plain http on loopback.
            assert_eq!(
                resolve("http://127.0.0.1:54321", Some("  "), dev_mode).unwrap(),
                "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json"
            );
        }
        assert_eq!(
            resolve("https://example.test/supabase", None, false).unwrap(),
            "https://example.test/supabase/auth/v1/.well-known/jwks.json"
        );
        assert_eq!(
            resolve(
                "https://abc.supabase.co",
                Some(" https://abc.supabase.co:443/auth/v1/.well-known/jwks.json "),
                false
            )
            .unwrap(),
            "https://abc.supabase.co/auth/v1/.well-known/jwks.json"
        );
        assert_eq!(
            resolve(
                "http://localhost:54321",
                Some("http://localhost:54321/auth/v1/.well-known/jwks.json"),
                false
            )
            .unwrap(),
            "http://localhost:54321/auth/v1/.well-known/jwks.json"
        );
    }

    #[test]
    fn the_jwks_url_is_refused_unless_it_is_the_projects_https_endpoint() {
        const PROJECT: &str = "https://abc.supabase.co";
        let secret = "inert-jwks-url-secret";
        for (configured, rule) in [
            ("not a url", "must be an absolute URL"),
            ("/auth/v1/.well-known/jwks.json", "must be an absolute URL"),
            (
                "http://abc.supabase.co/auth/v1/.well-known/jwks.json",
                "must use https",
            ),
            (
                "ftp://abc.supabase.co/auth/v1/.well-known/jwks.json",
                "must use https",
            ),
            (
                "https://abc.supabase.co/auth/v1/other.json",
                "must be the Supabase JWKS endpoint",
            ),
            (
                "https://abc.supabase.co/auth/v1/.well-known/jwks.json/",
                "must be the Supabase JWKS endpoint",
            ),
            (
                "https://169.254.169.254/auth/v1/.well-known/jwks.json",
                "must be on the host and port of the Supabase project URL",
            ),
            (
                "https://abc.supabase.co.evil.test/auth/v1/.well-known/jwks.json",
                "must be on the host and port of the Supabase project URL",
            ),
            (
                "https://abc.supabase.co:8443/auth/v1/.well-known/jwks.json",
                "must be on the host and port of the Supabase project URL",
            ),
            (
                "https://user:inert-jwks-url-secret@abc.supabase.co/auth/v1/.well-known/jwks.json",
                "must not contain credentials",
            ),
            (
                "https://abc.supabase.co/auth/v1/.well-known/jwks.json?apikey=inert-jwks-url-secret",
                "must not have a query string or fragment",
            ),
            (
                "https://abc.supabase.co/auth/v1/.well-known/jwks.json#inert-jwks-url-secret",
                "must not have a query string or fragment",
            ),
        ] {
            let error = resolve(PROJECT, Some(configured), true)
                .expect_err(configured)
                .to_string();
            assert!(error.starts_with("SUPABASE_JWKS_URL "), "{error}");
            assert!(error.contains(rule), "{configured}: {error}");
            assert!(!error.contains(secret), "the error echoed the configured value");
            assert!(!error.contains("abc.supabase.co"), "the error echoed a URL");
        }
    }

    #[test]
    fn plain_http_is_only_for_loopback_development() {
        let jwks = |host: &str| format!("http://{host}/auth/v1/.well-known/jwks.json");
        // Loopback over http with a loopback project URL, in any mode.
        for host in ["127.0.0.1:54321", "localhost:54321", "[::1]:54321"] {
            let project = format!("http://{host}");
            for dev_mode in [false, true] {
                assert!(
                    resolve(&project, Some(&jwks(host)), dev_mode).is_ok(),
                    "{host}"
                );
            }
        }
        // A non-loopback host is never fetched over http, not even in DEV_MODE.
        for project in [
            "http://kong:8000",
            "http://10.0.0.5:8000",
            "http://supabase.local",
        ] {
            for dev_mode in [false, true] {
                let error = resolve(project, None, dev_mode)
                    .expect_err(project)
                    .to_string();
                assert!(
                    error.starts_with(
                        "the JWKS URL derived from the Supabase project URL must use https"
                    ),
                    "{error}"
                );
            }
        }
        // A loopback JWKS host for a remote project needs DEV_MODE and the opt-in.
        let loopback = jwks("127.0.0.1:9999");
        let policy = |dev_mode| JwksUrlPolicy {
            dev_mode,
            allow_other_host: true,
        };
        assert!(SupabaseJwksUrl::resolve(
            "https://abc.supabase.co",
            Some(&loopback),
            policy(false)
        )
        .is_err());
        assert!(
            SupabaseJwksUrl::resolve("https://abc.supabase.co", Some(&loopback), policy(true))
                .is_ok()
        );
    }

    #[test]
    fn another_jwks_host_needs_the_explicit_opt_in() {
        let other = "https://auth.example.test/auth/v1/.well-known/jwks.json";
        let error = resolve("https://abc.supabase.co", Some(other), false)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("SUPABASE_JWKS_URL_ALLOW_OTHER_HOST"),
            "{error}"
        );
        let allowed = SupabaseJwksUrl::resolve(
            "https://abc.supabase.co",
            Some(other),
            JwksUrlPolicy {
                dev_mode: false,
                allow_other_host: true,
            },
        )
        .expect("opted in");
        assert_eq!(allowed.as_url().as_str(), other);
        // The opt-in relaxes the host only: path and scheme rules still apply.
        for refused in [
            "https://auth.example.test/other",
            "http://auth.example.test/auth/v1/.well-known/jwks.json",
        ] {
            assert!(SupabaseJwksUrl::resolve(
                "https://abc.supabase.co",
                Some(refused),
                JwksUrlPolicy {
                    dev_mode: true,
                    allow_other_host: true,
                },
            )
            .is_err());
        }
    }

    #[test]
    fn a_malformed_project_url_is_refused() {
        for project in ["", "abc.supabase.co", "file:///etc/passwd", "https://"] {
            let error = resolve(project, None, true).expect_err(project).to_string();
            assert!(error.contains("Supabase project URL"), "{error}");
        }
    }

    /// A JWKS endpoint that redirects to another path on the same server,
    /// which counts the requests that follow the redirect.
    async fn spawn_redirecting_jwks_server() -> (
        SupabaseJwksUrl,
        Arc<std::sync::atomic::AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        use axum::response::Redirect;
        use axum::routing::get;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let followed = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new()
            .route(
                SUPABASE_JWKS_PATH,
                get(|| async { Redirect::temporary("/elsewhere/jwks.json") }),
            )
            .route(
                "/elsewhere/jwks.json",
                get({
                    let followed = followed.clone();
                    move || async move {
                        followed.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({ "keys": [] }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind redirect test server");
        let address = listener.local_addr().expect("redirect test server address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve redirect test server")
        });
        let url = SupabaseJwksUrl::for_test(&format!("http://127.0.0.1:{}", address.port()));
        (url, followed, server)
    }

    fn test_refresher(url: SupabaseJwksUrl) -> JwksRefresher {
        JwksRefresher::new(
            url,
            SupabaseJwksCache::new(SupabaseJwks::from_hmac_secret("inert-refresher-test")),
            JwksRefreshSchedule::new(Duration::from_secs(300), Duration::from_secs(30)),
        )
        .expect("build the refresher")
    }

    /// A redirect would send the fetch to a URL that was never validated.
    #[tokio::test]
    async fn refreshes_do_not_follow_redirects() {
        let (url, followed, server) = spawn_redirecting_jwks_server().await;
        let error = test_refresher(url)
            .fetch()
            .await
            .expect_err("a redirect is not a key set")
            .to_string();
        assert!(error.contains("status=307"), "{error}");
        assert_eq!(followed.load(std::sync::atomic::Ordering::SeqCst), 0);
        server.abort();
    }

    /// The blocking startup load uses its own client, so it needs its own
    /// proof that it stops at the redirect.
    #[tokio::test]
    async fn the_startup_load_does_not_follow_redirects() {
        let (url, followed, server) = spawn_redirecting_jwks_server().await;
        let error = tokio::task::spawn_blocking(move || SupabaseJwks::load(&url))
            .await
            .expect("join the blocking startup load")
            .expect_err("a redirect is not a key set")
            .to_string();
        assert!(error.contains("status=307"), "{error}");
        assert_eq!(followed.load(std::sync::atomic::Ordering::SeqCst), 0);
        server.abort();
    }

    /// The refresher's client gives up after ten seconds. The clock is
    /// paused, so the runtime jumps straight to the client's deadline while
    /// the server holds the connection open without answering; the virtual
    /// time that passes is the timeout.
    #[tokio::test(start_paused = true)]
    async fn refreshes_time_out_after_ten_seconds() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind silent test server");
        let address = listener.local_addr().expect("silent test server address");
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let (stream, _) = listener.accept().await.expect("accept");
                held.push(stream);
            }
        });
        let refresher = test_refresher(SupabaseJwksUrl::for_test(&format!(
            "http://127.0.0.1:{}",
            address.port()
        )));
        let started = Instant::now();
        let error = tokio::time::timeout(Duration::from_secs(60), refresher.fetch())
            .await
            .expect("the refresh must time out on its own, well before a minute")
            .expect_err("nothing answered");
        let elapsed = started.elapsed();
        assert!(
            error
                .chain()
                .filter_map(|cause| cause.downcast_ref::<reqwest::Error>())
                .any(reqwest::Error::is_timeout),
            "{error:#}"
        );
        assert!(
            elapsed >= Duration::from_secs(10) && elapsed < Duration::from_secs(11),
            "timed out after {elapsed:?}"
        );
        server.abort();
    }

    #[test]
    fn empty_key_set_is_rejected() {
        // Mid-rotation the endpoint can briefly serve zero keys. Accepting that
        // would install a key set that can verify nothing; rejecting it keeps
        // the previous good snapshot (on refresh) or trips the documented
        // startup fallback.
        let set = JwkSet { keys: vec![] };
        assert!(SupabaseJwks::from_jwk_set(set).is_err());
    }

    #[test]
    fn hs256_decoding_key_falls_back_when_kid_unknown() {
        let default_key = Arc::new(DecodingKey::from_secret(b"secret"));
        let mut map: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        map.insert("hmac".to_string(), default_key.clone());

        let jwks = SupabaseJwks {
            algorithm: Algorithm::HS256,
            keys: Arc::new(map),
            default_key: Some(default_key.clone()),
        };

        let resolved = jwks
            .decoding_key(Some("supabase-kid"))
            .expect("should resolve");
        assert!(Arc::ptr_eq(&resolved, &default_key));
    }

    #[test]
    fn rs256_decoding_key_does_not_fallback_when_kid_unknown() {
        let default_key = Arc::new(DecodingKey::from_secret(b"secret"));
        let mut map: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        map.insert("default".to_string(), default_key.clone());

        let jwks = SupabaseJwks {
            algorithm: Algorithm::RS256,
            keys: Arc::new(map),
            default_key: Some(default_key),
        };

        assert!(jwks.decoding_key(Some("unknown")).is_none());
    }
}

impl std::fmt::Debug for SupabaseJwks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let key_ids: Vec<&String> = self.keys.keys().collect();
        f.debug_struct("SupabaseJwks")
            .field("algorithm", &self.algorithm)
            .field("key_ids", &key_ids)
            .finish()
    }
}
