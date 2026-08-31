use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Url;
use tokio::sync::{watch, Notify};
use uuid::Uuid;

pub const MAX_APPLY_MANIFEST_BYTES: usize = 16 * 1024 * 1024;

/// How long a rejected caller waits for a renewed controller token before it
/// gives up on this attempt. Short on purpose: the caller is a periodic loop,
/// so giving up just means retrying on the next tick.
pub const CONTROLLER_TOKEN_REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

/// The single live controller credential shared by the runtime agent and every
/// long-lived loop that talks to the controller on its behalf (issue #144).
///
/// Two directions of flow, both required to keep a 401 from becoming a
/// permanent outage:
///
/// * the owner (the runtime agent's registration/renewal path) calls
///   [`ControllerTokenStore::store`] on every successful registration, which
///   publishes the token and bumps a generation counter;
/// * a consumer rejected with 401 calls [`ControllerTokenStore::refresh_once`],
///   which asks the owner for a renewal and waits for the generation to move.
///
/// Consumers therefore never hold a token by value, and never need their own
/// renewal logic. Because every waiter wakes on the same generation bump, a
/// simultaneous 401 across many consumers collapses into one re-registration.
pub struct ControllerTokenStore {
    token: std::sync::RwLock<Option<String>>,
    /// Bumped once per successful refresh. Consumers wait on this rather than
    /// on the token value so an unchanged token still ends their wait.
    generation: watch::Sender<u64>,
    /// Consumer -> owner: "the credential I was handed was rejected".
    refresh_requested: Notify,
}

impl ControllerTokenStore {
    pub fn new(token: Option<String>) -> Self {
        Self {
            token: std::sync::RwLock::new(token),
            generation: watch::channel(0).0,
            refresh_requested: Notify::new(),
        }
    }

    pub fn current(&self) -> Option<String> {
        self.token
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Publish a freshly minted token and wake everyone waiting for one.
    pub fn store(&self, token: String) {
        *self
            .token
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(token);
        self.bump();
    }

    /// A refresh completed without producing a new token value (the controller
    /// did not mint one this round). Waiters must still be released — what they
    /// are waiting for is "a renewal happened", not "the string changed".
    pub fn note_refreshed(&self) {
        self.bump();
    }

    fn bump(&self) {
        self.generation.send_modify(|generation| *generation += 1);
    }

    pub fn generation(&self) -> u64 {
        *self.generation.borrow()
    }

    /// Owner side: resolves when some consumer reports a rejected credential.
    /// Requests raised while nobody is awaiting are not lost — one is buffered.
    pub async fn refresh_requested(&self) {
        self.refresh_requested.notified().await;
    }

    /// Consumer side: ask for a renewal and wait for it, at most once. Returns
    /// true when a newer credential landed within `timeout`.
    ///
    /// Subscribing before requesting is what makes this race-free: the receiver
    /// is marked as having seen the current generation, so a renewal that
    /// completes before the wait begins still resolves it.
    pub async fn refresh_once(&self, timeout: Duration) -> bool {
        let mut generation = self.generation.subscribe();
        self.refresh_requested.notify_one();
        tokio::time::timeout(timeout, generation.changed())
            .await
            .is_ok()
    }
}

impl std::fmt::Debug for ControllerTokenStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ControllerTokenStore")
            .field("generation", &self.generation())
            .field("has_token", &self.current().is_some())
            .finish()
    }
}

/// Live controller token shared with the embedding process (the runtime
/// agent): registration renewals write the freshest runtime token into this
/// handle, so long-lived loops here (the presence heartbeat) stop beating
/// with the spawn-time credential after it expires.
pub type SharedControllerToken = Arc<ControllerTokenStore>;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub project_id: Uuid,
    pub origin_id: Uuid,
    pub workspace_root: PathBuf,
    pub git_remote_url: Option<String>,
    pub git_remote_base_url: Option<String>,
    pub git_branch: String,
    pub git_remote_name: String,
    pub git_author_name: String,
    pub git_author_email: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub controller_base_url: Url,
    pub controller_internal_token: Option<String>,
    /// When set, controller-bound requests resolve their bearer from this
    /// handle at send time, falling back to `controller_internal_token`.
    pub controller_token_source: Option<SharedControllerToken>,
    pub jwks_url: Url,
    pub skip_auth: bool,
    pub enable_presence_heartbeat: bool,
    pub presence_interval: Duration,
    pub max_archive_bytes: u64,
    pub staging_base: Option<PathBuf>,
    pub multi_tenant: bool,
}

impl ServerConfig {
    /// The bearer for controller-bound requests, resolved at call time: the
    /// live shared token when a source is wired (and non-empty), else the
    /// static spawn-time token.
    pub fn current_controller_token(&self) -> Option<String> {
        if let Some(source) = &self.controller_token_source {
            let live = source.current();
            if live
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty())
            {
                return live;
            }
        }
        self.controller_internal_token.clone()
    }

    /// Ask the credential owner to renew the controller token after a request
    /// of ours was rejected, and wait (briefly, once) for the renewal to land.
    ///
    /// `false` means no fresher credential arrived — the caller must give up on
    /// this attempt rather than retry, so a permanently dead credential costs
    /// one extra request per loop tick instead of spinning.
    pub async fn refresh_controller_token(&self, timeout: Duration) -> bool {
        match &self.controller_token_source {
            Some(source) => source.refresh_once(timeout).await,
            // No live source wired: the static spawn-time token is all there
            // is, so retrying it would be pointless.
            None => false,
        }
    }

    pub fn staging_root_for_workspace(&self, workspace_root: &Path) -> PathBuf {
        if let Some(custom) = &self.staging_base {
            return custom.clone();
        }
        workspace_root
            .join(".instafy")
            .join("origin-staging")
            .join(self.origin_id.to_string())
    }

    pub fn canonical_workspace_root(&self) -> Result<PathBuf> {
        canonicalize(&self.workspace_root)
    }

    pub fn workspace_root_for_project(&self, project_id: Uuid) -> PathBuf {
        if self.multi_tenant {
            self.workspace_root.join(project_id.to_string())
        } else {
            self.workspace_root.clone()
        }
    }

    pub fn git_remote_url_for_project(&self, project_id: Uuid) -> Option<String> {
        if let Some(url) = self.git_remote_url.as_deref() {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(base) = self.git_remote_base_url.as_deref() {
            let trimmed = base.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return Some(format!("{trimmed}/{}.git", project_id));
            }
        }
        None
    }

    pub fn controller_commit_receipt_url(&self) -> Result<Url> {
        let mut url = self.controller_base_url.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("controller base url missing path segments"))?
            .extend(["commit", "receipt"]);
        Ok(url)
    }

    pub fn controller_presence_url(&self) -> Result<Url> {
        if self.multi_tenant {
            anyhow::bail!("presence beats are not supported in multi-tenant mode");
        }
        let mut url = self.controller_base_url.clone();
        // Prefer project-scoped presence beats to avoid ambiguous routing and 404s
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("controller base url missing path segments"))?
            .extend([
                "projects",
                &self.project_id.to_string(),
                "origin",
                "presence",
                "beat",
            ]);
        Ok(url)
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path).with_context(|| format!("failed to canonicalize {:?}", path))
}

#[cfg(test)]
mod controller_token_store_tests {
    use super::*;

    const IMMEDIATE: Duration = Duration::from_millis(50);

    #[test]
    fn store_publishes_the_new_token_to_existing_holders() {
        let store = Arc::new(ControllerTokenStore::new(Some("spawn-time".into())));
        let consumer = store.clone();
        assert_eq!(consumer.current().as_deref(), Some("spawn-time"));

        store.store("renewed".into());

        // The consumer held the handle across the renewal, not the string.
        assert_eq!(consumer.current().as_deref(), Some("renewed"));
    }

    #[tokio::test]
    async fn refresh_once_resolves_when_the_owner_publishes_a_renewal() {
        let store = Arc::new(ControllerTokenStore::new(Some("stale".into())));
        let owner = store.clone();
        tokio::spawn(async move {
            owner.refresh_requested().await;
            owner.store("renewed".into());
        });

        assert!(store.refresh_once(Duration::from_secs(5)).await);
        assert_eq!(store.current().as_deref(), Some("renewed"));
    }

    /// A renewal that mints no new token value must still release waiters,
    /// otherwise a rejected consumer waits out its whole timeout for a string
    /// that is never going to change.
    #[tokio::test]
    async fn refresh_once_resolves_on_a_renewal_without_a_new_token() {
        let store = Arc::new(ControllerTokenStore::new(Some("unchanged".into())));
        let owner = store.clone();
        tokio::spawn(async move {
            owner.refresh_requested().await;
            owner.note_refreshed();
        });

        assert!(store.refresh_once(Duration::from_secs(5)).await);
        assert_eq!(store.current().as_deref(), Some("unchanged"));
    }

    /// Nothing is listening, so the consumer must give up instead of hanging or
    /// spinning: this is what bounds the 401 path to one retry per loop tick.
    #[tokio::test]
    async fn refresh_once_gives_up_when_no_owner_answers() {
        let store = ControllerTokenStore::new(Some("stale".into()));
        assert!(!store.refresh_once(IMMEDIATE).await);
    }

    /// One registration must satisfy every consumer that was rejected at the
    /// same moment — that is what keeps a fleet of 401s from becoming a fleet
    /// of register calls.
    #[tokio::test]
    async fn one_renewal_releases_every_waiting_consumer() {
        let store = Arc::new(ControllerTokenStore::new(Some("stale".into())));
        let owner = store.clone();
        let registrations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = registrations.clone();
        tokio::spawn(async move {
            owner.refresh_requested().await;
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            owner.store("renewed".into());
        });

        let waiters = (0..4)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(async move { store.refresh_once(Duration::from_secs(5)).await })
            })
            .collect::<Vec<_>>();

        for waiter in waiters {
            assert!(waiter.await.expect("waiter completes"));
        }
        assert_eq!(registrations.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// A request raised while the owner is busy elsewhere is buffered, not
    /// dropped — otherwise a 401 could be silently ignored.
    #[tokio::test]
    async fn a_refresh_request_raised_before_the_owner_waits_is_not_lost() {
        let store = Arc::new(ControllerTokenStore::new(Some("stale".into())));
        let consumer = store.clone();
        tokio::spawn(async move {
            let _ = consumer.refresh_once(Duration::from_secs(5)).await;
        });
        tokio::time::sleep(IMMEDIATE).await;

        tokio::time::timeout(Duration::from_secs(5), store.refresh_requested())
            .await
            .expect("the owner still observes the buffered request");
    }

    #[test]
    fn current_controller_token_prefers_the_live_source_over_the_static_token() {
        let store = Arc::new(ControllerTokenStore::new(Some("live".into())));
        let mut config = test_config();
        config.controller_internal_token = Some("spawn-time".into());
        config.controller_token_source = Some(store.clone());

        assert_eq!(config.current_controller_token().as_deref(), Some("live"));

        store.store("renewed".into());
        assert_eq!(
            config.current_controller_token().as_deref(),
            Some("renewed")
        );
    }

    #[test]
    fn current_controller_token_falls_back_when_the_source_is_empty() {
        let mut config = test_config();
        config.controller_internal_token = Some("spawn-time".into());
        config.controller_token_source = Some(Arc::new(ControllerTokenStore::new(None)));

        assert_eq!(
            config.current_controller_token().as_deref(),
            Some("spawn-time")
        );
    }

    #[tokio::test]
    async fn refresh_controller_token_is_a_no_op_without_a_live_source() {
        let mut config = test_config();
        config.controller_internal_token = Some("spawn-time".into());
        config.controller_token_source = None;

        assert!(!config.refresh_controller_token(IMMEDIATE).await);
    }

    fn test_config() -> ServerConfig {
        ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: PathBuf::from("/tmp"),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "Instafy".into(),
            git_author_email: "instafy@example.invalid".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().expect("base url"),
            controller_internal_token: None,
            controller_token_source: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().expect("jwks url"),
            skip_auth: false,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 1024,
            staging_base: None,
            multi_tenant: false,
        }
    }
}
