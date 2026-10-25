use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Context;
use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use chrono::Duration as ChronoDuration;
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;

use super::sessions::{
    capability_hash, forget_viewer_access, insert_preview_session, mint_capability_label,
    parse_viewer_host, preview_cookie_scope_warning, preview_domain_overlaps,
};
use super::*;
use crate::config::PreviewSettings;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::tunnels::{
    revoke_tunnels_for_scope, TunnelAssignment, TunnelBroker, TunnelBrokerCapabilities,
    TunnelProvider, TunnelRequestContext,
};

const HOOK_SECRET: &str = "preview-hook-secret";
const PREVIEW_BASE_URL: &str = "http://preview.localhost:8083";

fn preview_settings() -> PreviewSettings {
    PreviewSettings {
        base_url: Some(PREVIEW_BASE_URL.to_string()),
        ..PreviewSettings::default()
    }
}

#[test]
fn preview_ports_follow_the_denylist() {
    for port in [1024, 4173, 8080, 65535] {
        assert_eq!(validate_preview_port(port, &[]).ok(), Some(port as u16));
    }
    for port in [
        0, 80, 1023, 5900, 8789, 9222, 9223, 9225, 9226, 15900, 19223, 19225, 19226, 43127, 54332,
        65536, -1,
    ] {
        let error = validate_preview_port(port, &[]).expect_err("port must be refused");
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1 .0.code.as_deref(), Some("port_not_allowed"));
    }
    // PREVIEW_DENY_PORTS adds to the list; it never removes a built-in port.
    let settings = PreviewSettings::from_values(None, None, Some("4173, 8080 ,"), None);
    assert_eq!(settings.deny_ports, vec![4173, 8080]);
    assert!(settings.invalid_deny_ports.is_empty());
    assert!(validate_preview_port(4173, &settings.deny_ports).is_err());
    assert!(validate_preview_port(9222, &settings.deny_ports).is_err());
    assert!(validate_preview_port(4174, &settings.deny_ports).is_ok());
}

#[test]
fn an_entry_in_preview_deny_ports_that_is_not_a_port_stops_startup() {
    let settings = PreviewSettings::from_values(None, None, Some("4173, 9222x 70000;-1"), None);
    assert_eq!(settings.deny_ports, vec![4173]);
    assert_eq!(settings.invalid_deny_ports, vec!["9222x", "70000;-1"]);
    // Refused even with previews off: the typo is an operator's to fix.
    for previews in [
        settings.clone(),
        PreviewSettings {
            base_url: Some(PREVIEW_BASE_URL.to_string()),
            ..settings
        },
    ] {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "previews-deny-ports",
        );
        config.previews = previews;
        let error = check_preview_domain(&config).expect_err("bad entry refused");
        assert!(error.to_string().contains("PREVIEW_DENY_PORTS"), "{error}");
        assert!(error.to_string().contains("9222x"), "{error}");
    }
}

#[test]
fn an_unreadable_tunnel_domain_stops_startup_instead_of_skipping_the_overlap_check() {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "previews-tunnel-domain",
    );
    config.previews = PreviewSettings {
        domain: Some("previews.app".to_string()),
        tunnel_domain: Some("rt example".to_string()),
        ..PreviewSettings::default()
    };
    let error = check_preview_domain(&config).expect_err("unreadable TUNNEL_DOMAIN refused");
    assert!(error.to_string().contains("TUNNEL_DOMAIN"), "{error}");
}

#[test]
fn a_preview_domain_off_the_public_suffix_list_is_flagged_as_one_shared_cookie_scope() {
    for domain in [
        "previews.app",
        "preview.example.co.uk",
        "instafy-preview.dev",
    ] {
        for shared_with_tunnels in [false, true] {
            let warning =
                preview_cookie_scope_warning(domain, shared_with_tunnels).expect("warned");
            assert!(warning.contains("Public Suffix List"), "{warning}");
            assert!(warning.contains(domain), "{warning}");
            assert!(
                warning.contains("until it is, all users' sites share one cookie scope"),
                "{warning}"
            );
            assert_eq!(
                warning.contains("every public tunnel"),
                shared_with_tunnels,
                "{warning}"
            );
        }
    }
    // A listed suffix separates each viewer host, and local stacks are exempt.
    for domain in [
        "github.io",
        "co.uk",
        "localhost",
        "preview.localhost",
        "127.0.0.1",
    ] {
        for shared_with_tunnels in [false, true] {
            assert_eq!(
                preview_cookie_scope_warning(domain, shared_with_tunnels),
                None,
                "{domain}"
            );
        }
    }
}

#[test]
fn previews_may_share_the_tunnel_domain_as_one_user_content_domain() {
    let config = |preview: &str, tunnels: &str| {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "previews-shared-domain",
        );
        config.public_app_url = "https://studio.example.com".to_string();
        config._controller_external_url = Some("https://api.example.com".to_string());
        config.previews = PreviewSettings::from_values(None, Some(preview), None, Some(tunnels));
        config
    };
    for (preview, tunnels) in [
        ("usercontent.app", "usercontent.app"),
        ("UserContent.app.", "usercontent.app"),
        ("usercontent.app", "*.usercontent.app"),
        ("sites.usercontent.app", "sites.usercontent.app"),
        ("preview.localhost", "preview.localhost"),
    ] {
        assert!(
            check_preview_domain(&config(preview, tunnels)).is_ok(),
            "{preview} / {tunnels}"
        );
    }
    // Above, below or next to the tunnel domain is still refused, and so is a
    // shared domain that shares a cookie scope with Studio or the API.
    for (preview, tunnels, refused_by) in [
        ("p.usercontent.app", "usercontent.app", "TUNNEL_DOMAIN"),
        ("usercontent.app", "rt.usercontent.app", "TUNNEL_DOMAIN"),
        ("p.usercontent.app", "rt.usercontent.app", "TUNNEL_DOMAIN"),
        (
            "usercontent.example.com",
            "usercontent.example.com",
            "PUBLIC_APP_URL",
        ),
        ("example.com", "example.com", "PUBLIC_APP_URL"),
    ] {
        let error = check_preview_domain(&config(preview, tunnels)).expect_err("overlap refused");
        assert!(error.to_string().contains("cookie scope"), "{error}");
        assert!(error.to_string().contains(refused_by), "{error}");
    }
    let mut api_only = config("sites.api-host.net", "sites.api-host.net");
    api_only.public_app_url = "https://studio.example.com".to_string();
    api_only._controller_external_url = Some("https://controller.api-host.net".to_string());
    let error = check_preview_domain(&api_only).expect_err("next to the API refused");
    assert!(
        error.to_string().contains("CONTROLLER_EXTERNAL_URL"),
        "{error}"
    );
}

#[test]
fn a_preview_domain_must_not_share_a_cookie_scope_with_studio_the_api_or_tunnels() {
    for (preview, other) in [
        ("instafy.dev", "instafy.dev"),
        ("preview.instafy.dev", "instafy.dev"),
        ("instafy.dev", "studio.instafy.dev"),
        ("p.rt.example", "rt.example"),
        ("localhost", "localhost"),
        // Siblings under one registrable domain: a site on one can set
        // `Domain=example.com` cookies the other receives.
        ("preview.example.com", "studio.example.com"),
        ("p.preview.example.com", "api.example.com"),
        ("preview.example.co.uk", "studio.example.co.uk"),
    ] {
        assert!(
            preview_domain_overlaps(preview, other),
            "{preview} / {other}"
        );
    }
    for (preview, other) in [
        ("instafy-preview.app", "instafy.dev"),
        ("xinstafy.dev", "instafy.dev"),
        ("preview.localhost", "localhost"),
        ("preview.localhost", "127.0.0.1"),
        ("preview.localhost", "tunnel.localhost"),
        // A public suffix is not a shared parent.
        ("preview.co.uk", "studio.co.uk"),
        ("alice.github.io", "bob.github.io"),
        ("10.0.0.5", "10.1.0.5"),
    ] {
        assert!(
            !preview_domain_overlaps(preview, other),
            "{preview} / {other}"
        );
    }

    let config = |settings: PreviewSettings, api: Option<&str>| {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "previews-domain",
        );
        config.public_app_url = "https://studio.example.com".to_string();
        config._controller_external_url = api.map(str::to_string);
        config.previews = settings;
        config
    };
    let domain = |domain: &str, tunnels: Option<&str>| PreviewSettings {
        domain: Some(domain.to_string()),
        tunnel_domain: tunnels.map(str::to_string),
        ..PreviewSettings::default()
    };
    // Off is fine, and so is a separate domain.
    assert!(check_preview_domain(&config(PreviewSettings::default(), None)).is_ok());
    assert!(
        check_preview_domain(&config(domain("previews.app", Some("rt.example")), None)).is_ok()
    );
    // Under Studio, equal to the API host, under the tunnel domain: refused.
    for (settings, api) in [
        (domain("p.studio.example.com", None), None),
        (
            domain("api.example.com", None),
            Some("https://api.example.com"),
        ),
        (domain("preview.rt.example", Some("rt.example")), None),
        (domain("example.com", None), None),
        // Next to Studio, the API or the tunnel hosts: refused too.
        (domain("preview.example.com", None), None),
        (
            domain("preview.api-host.net", None),
            Some("https://controller.api-host.net"),
        ),
        (
            domain("preview.rt.example", Some("tunnel.rt.example")),
            None,
        ),
    ] {
        let error = check_preview_domain(&config(settings, api)).expect_err("overlap refused");
        assert!(error.to_string().contains("cookie scope"), "{error}");
    }
    // A value that is set but unusable is an error, not silently off.
    let error = check_preview_domain(&config(
        PreviewSettings {
            base_url: Some("ftp://preview.example".to_string()),
            ..PreviewSettings::default()
        },
        None,
    ))
    .expect_err("invalid origin refused");
    assert!(error.to_string().contains("PREVIEW_BASE_URL"), "{error}");
    // Only a bare origin, and plain http only on a loopback host: the label
    // in a viewer host is a capability.
    for base_url in [
        "http://preview.example.net",
        "https://user:secret@previews.app",
        "https://previews.app/?x=1",
        "https://previews.app/#x",
        "https://previews.app/sub",
    ] {
        let settings = PreviewSettings {
            base_url: Some(base_url.to_string()),
            ..PreviewSettings::default()
        };
        assert!(
            check_preview_domain(&config(settings.clone(), None)).is_err(),
            "{base_url}"
        );
        assert!(
            PreviewOrigin::from_settings(&settings).is_none(),
            "the gate refuses {base_url} too"
        );
    }
    for base_url in [
        "https://previews.app:8443",
        "http://preview.localhost:8083",
        "http://127.0.0.1:8083",
    ] {
        let settings = PreviewSettings {
            base_url: Some(base_url.to_string()),
            ..PreviewSettings::default()
        };
        assert!(
            check_preview_domain(&config(settings, None)).is_ok(),
            "{base_url}"
        );
    }
    // The local stack: Studio on localhost, viewers on preview.localhost.
    let mut local = config(preview_settings(), Some("http://localhost:8788"));
    local.public_app_url = "http://localhost:5174".to_string();
    assert!(check_preview_domain(&local).is_ok());
}

#[test]
fn preview_title_and_path_are_bounded() {
    assert_eq!(
        validate_preview_title("  Site preview ").unwrap(),
        "Site preview"
    );
    assert!(validate_preview_title("   ").is_err());
    assert!(validate_preview_title(&"x".repeat(121)).is_err());
    assert!(validate_preview_title("line\nbreak").is_err());

    assert_eq!(validate_preview_path(None).unwrap(), "/");
    assert_eq!(validate_preview_path(Some("/site/")).unwrap(), "/site/");
    for bad in [
        "site",
        "//evil.example/",
        "/a b",
        "/a#b",
        "/a\\b",
        "/\u{e9}",
    ] {
        assert!(validate_preview_path(Some(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn capability_labels_are_26_base32_characters_stored_only_as_hashes() {
    let label = mint_capability_label();
    assert_eq!(label.len(), 26);
    assert!(label
        .bytes()
        .all(|b| b"abcdefghijklmnopqrstuvwxyz234567".contains(&b)));
    assert_ne!(label, mint_capability_label());
    let hash = capability_hash(&label);
    assert_eq!(hash.len(), 64);
    assert!(!hash.contains(&label));
    assert_eq!(
        capability_hash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn viewer_urls_round_trip_and_reject_lookalikes() {
    let origin = PreviewOrigin::parse(Some(PREVIEW_BASE_URL), None).expect("origin");
    let tunnel = Uuid::new_v4();
    let label = mint_capability_label();
    let url = origin.viewer_url(&label, &tunnel, "/site/");
    assert_eq!(
        url,
        format!(
            "http://p-{label}--{}.preview.localhost:8083/site/",
            tunnel.simple()
        )
    );
    let parsed = url::Url::parse(&url).unwrap();
    assert_eq!(
        parse_viewer_host(parsed.host_str().unwrap()),
        Some((label.clone(), tunnel))
    );

    assert_eq!(origin.host_suffix(), "preview.localhost:8083");
    assert!(url.contains(&format!("{}.{}", tunnel.simple(), origin.host_suffix())));

    let hosted = PreviewOrigin::parse(None, Some("instafy-preview.app")).unwrap();
    assert_eq!(hosted.host_suffix(), "instafy-preview.app");
    assert_eq!(
        PreviewOrigin::parse(Some("https://preview.example:443"), None)
            .unwrap()
            .host_suffix(),
        "preview.example"
    );
    assert!(hosted
        .viewer_url(&label, &tunnel, "/")
        .starts_with("https://p-"));
    assert!(PreviewOrigin::parse(None, None).is_none());
    assert!(PreviewOrigin::parse(Some("ftp://preview.localhost"), None).is_none());

    let hex = tunnel.simple().to_string();
    for host in [
        format!("p-{}--{hex}.x", &label[..25]),
        format!("p-{}--{hex}.x", label.to_uppercase()),
        format!("p-{label}--{}.x", &hex[..31]),
        format!("q-{label}--{hex}.x"),
        format!("p-{label}-{hex}.x"),
        format!("p-{label}--{}.x", tunnel.hyphenated()),
    ] {
        assert_eq!(parse_viewer_host(&host), None, "{host}");
    }
}

#[test]
fn preview_card_is_the_contract_shape_without_any_url() {
    let job_id = Uuid::new_v4();
    let preview_id = Uuid::new_v4().to_string();
    let metadata =
        build_preview_card_metadata(Some(&job_id), &preview_id, "Site preview", 4173, "/");
    assert_eq!(
        metadata,
        json!({
            "source": "agent",
            "kind": "update",
            "jobId": job_id.to_string(),
            "messageType": "action_request",
            "details": {
                "messageType": "action_request",
                "details": {
                    "testId": "preview-ready-card",
                    "icon": "preview",
                    "overline": "Ready to preview",
                    "title": "Site preview",
                    "preview": { "previewId": preview_id, "port": 4173, "path": "/" },
                },
            },
        })
    );
    let text = metadata.to_string();
    assert!(!text.contains("href") && !text.contains("http") && !text.contains("url"));
    // Studio draws Open from `preview`; a stored action would be a button
    // that does nothing wherever `preview` is not understood.
    assert!(!text.contains("actions") && !text.contains("event"));
}

#[test]
fn a_preview_says_who_may_open_it_only_as_recorded() {
    let grant = |metadata: Value| PreviewGrant {
        record: RuntimeTunnelGrantRecord {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            runtime_id: Some(Uuid::new_v4()),
            runtime_lease_id: None,
            provider: "self_hosted".to_string(),
            tunnel_id: Uuid::new_v4().to_string(),
            hostname: "abc.rt.test".to_string(),
            url: "http://abc.rt.test".to_string(),
            status: "active".to_string(),
            expires_at: Utc::now(),
            metadata: Some(metadata),
        },
        created_at: Utc::now(),
    };
    let private = grant(json!({ (PREVIEW_TUNNEL_METADATA_KEY): { "visibility": "private" } }));
    let body = serde_json::to_value(private.response(None)).unwrap();
    assert_eq!(body["visibility"], "private");
    // No recorded visibility, no claim: the field is absent.
    let unrecorded = grant(json!({ (PREVIEW_TUNNEL_METADATA_KEY): {} }));
    let body = serde_json::to_value(unrecorded.response(None)).unwrap();
    assert!(body.get("visibility").is_none());
}

/// A broker that, like the real one, hands back the same tunnel for a
/// repeated idempotency key, and records what it was asked.
#[derive(Default)]
struct PreviewStubBroker {
    tunnels: StdMutex<HashMap<String, Uuid>>,
    requests: StdMutex<Vec<TunnelRequestContext>>,
    /// How many probes still find nothing listening, as right after the CLI
    /// spawned its rathole client.
    silent_probes: std::sync::atomic::AtomicUsize,
    probes: std::sync::atomic::AtomicUsize,
    /// What `GET /capabilities` answers; `None` is a broker that serves
    /// private previews on the fixture's domain.
    capabilities: StdMutex<Option<TunnelBrokerCapabilities>>,
    /// The status a new tunnel comes back with; `None` is "active". The real
    /// broker answers "issuing" and never says when the client connected.
    assignment_status: StdMutex<Option<String>>,
    /// What a probe that reaches the tunnel answers; `None` is a site's 200.
    probe_status: StdMutex<Option<u16>>,
    /// The broker cannot be asked: every probe errors.
    probe_fails: std::sync::atomic::AtomicBool,
    /// A probe of this tunnel never answers.
    probe_hangs_for: StdMutex<Option<String>>,
}

#[async_trait]
impl TunnelBroker for PreviewStubBroker {
    fn provider_kind(&self) -> TunnelProvider {
        TunnelProvider::SelfHosted
    }

    async fn request_tunnel(&self, ctx: TunnelRequestContext) -> anyhow::Result<TunnelAssignment> {
        let key = ctx.idempotency_key.clone().unwrap_or_default();
        let tunnel_id = *self
            .tunnels
            .lock()
            .unwrap()
            .entry(key)
            .or_insert_with(Uuid::new_v4);
        let expires_at = Utc::now() + ChronoDuration::seconds(ctx.expires_in_seconds.unwrap_or(60));
        self.requests.lock().unwrap().push(ctx);
        let hostname = format!("{tunnel_id}.rt.localhost");
        Ok(TunnelAssignment {
            provider: TunnelProvider::SelfHosted,
            tunnel_id: tunnel_id.to_string(),
            hostname: hostname.clone(),
            url: format!("https://{hostname}"),
            status: self
                .assignment_status
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "active".to_string()),
            credentials: json!({
                "provider": "self_hosted",
                "server": "rathole:2333",
                "hostname": hostname,
                "token": "preview-test-rathole-token",
                "service": format!("svc_{}", tunnel_id.simple()),
            }),
            expires_at,
            metadata: Some(json!({ "labels": { "kind": "preview" } })),
        })
    }

    async fn revoke_tunnel(
        &self,
        _tunnel_id: &str,
        _metadata: Option<&Value>,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    async fn capabilities(&self) -> TunnelBrokerCapabilities {
        self.capabilities
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(TunnelBrokerCapabilities {
                private_previews: true,
                preview_domain: Some("preview.localhost".to_string()),
            })
    }

    async fn probe_tunnel(&self, tunnel_id: &str, _path: &str) -> anyhow::Result<TunnelProbe> {
        use std::sync::atomic::Ordering;
        self.probes.fetch_add(1, Ordering::SeqCst);
        let hangs = self.probe_hangs_for.lock().unwrap().as_deref() == Some(tunnel_id);
        if hangs {
            std::future::pending::<()>().await;
        }
        if self.probe_fails.load(Ordering::SeqCst) {
            anyhow::bail!("the broker is unreachable");
        }
        let silent = self
            .silent_probes
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        Ok(if silent {
            TunnelProbe {
                listening: false,
                status: None,
            }
        } else {
            TunnelProbe {
                listening: true,
                status: Some(self.probe_status.lock().unwrap().unwrap_or(200)),
            }
        })
    }
}

impl PreviewStubBroker {
    /// Give `key` a new tunnel id, as the real broker does when it retires the
    /// key's tunnel (its hostname is under a domain it no longer serves).
    fn remint(&self, key: &str) -> Uuid {
        let tunnel_id = Uuid::new_v4();
        self.tunnels
            .lock()
            .unwrap()
            .insert(key.to_string(), tunnel_id);
        tunnel_id
    }
}

pub(super) struct Job {
    pub(super) token: String,
    pub(super) job_id: Uuid,
    pub(super) run_id: Uuid,
    pub(super) runtime_id: Uuid,
    pub(super) lease_id: Uuid,
}

/// A space with an owner (0), a builder (1), a viewer (2) and an outsider
/// (3), one public conversation, and the preview and tunnel routes.
pub(super) struct Fixture {
    pub(super) state: AppState,
    pub(super) app: Router,
    broker: Arc<PreviewStubBroker>,
    pub(super) org: Uuid,
    pub(super) project: Uuid,
    pub(super) conversation: Uuid,
    pub(super) users: [Uuid; 4],
    pub(super) tokens: [String; 4],
}

impl Fixture {
    pub(super) async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("preview HTTP tests").await?;
        let users = std::array::from_fn(|_| Uuid::new_v4());
        for user in &users {
            ensure_test_user(&pool, user).await?;
        }
        let org = Uuid::new_v4();
        let project = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        {
            let db = pool.get().await?;
            // The schema must come from the real migration.
            db.query_one("select count(*) from runtime_preview_sessions", &[])
                .await
                .context("runtime_preview_sessions migration is not applied")?;
            db.execute(
                "insert into organizations(id, slug, name) values($1, $2, 'Preview fixture')",
                &[&org, &format!("preview-fixture-{org}")],
            )
            .await?;
            db.execute(
                "insert into projects(id, org_id, owner_user_id, name, project_type, status)
                 values($1, $2, $3, 'Preview fixture', 'customer', 'active')",
                &[&project, &org, &users[0]],
            )
            .await?;
            db.execute(
                "insert into project_memberships(project_id, user_id, role)
                 values($1, $2, 'builder'), ($1, $3, 'viewer')",
                &[&project, &users[1], &users[2]],
            )
            .await?;
            db.execute(
                "insert into conversations(id, project_id, created_by, visibility, metadata, root_conversation_id)
                 values($1, $2, $3, 'public', '{}'::jsonb, $1)",
                &[&conversation, &project, &users[0]],
            )
            .await?;
        }
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "previews-http",
        );
        config.tunnel_broker_hook_secret = Some(HOOK_SECRET.to_string());
        config.previews = preview_settings();
        let mut tokens = std::array::from_fn(|_| String::new());
        for (index, user) in users.iter().enumerate() {
            tokens[index] = crate::auth::issue_controller_token(&config, user)
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
                .token;
        }
        let broker = Arc::new(PreviewStubBroker::default());
        let mut state = build_test_state(pool, config);
        state.tunnel_broker = Some(broker.clone());
        let app = router()
            .merge(crate::tunnels::router())
            .with_state(state.clone());
        Ok(Self {
            state,
            app,
            broker,
            org,
            project,
            conversation,
            users,
            tokens,
        })
    }

    pub(super) fn shared(&self) -> SharedDbFixture {
        SharedDbFixture {
            organizations: vec![self.org],
            projects: vec![self.project],
        }
    }

    pub(super) async fn delete_users(&self) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "delete from auth.users where id = any($1)",
                &[&self.users.to_vec()],
            )
            .await?;
        Ok(())
    }

    pub(super) async fn request(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_on(&self.app, token, method, path, body).await
    }

    pub(super) fn path(&self, suffix: &str) -> String {
        format!("/projects/{}/previews{suffix}", self.project)
    }

    /// A runtime with an active lease, or a second leased job on `on`.
    pub(super) async fn job(&self, on: Option<&Job>) -> anyhow::Result<Job> {
        let (runtime_id, lease_id) = match on {
            Some(job) => (job.runtime_id, job.lease_id),
            None => (Uuid::new_v4(), Uuid::new_v4()),
        };
        let run_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        if on.is_none() {
            db.execute(
                "insert into runtimes(id, project_id, provider, status) values($1, $2, 'default', 'running')",
                &[&runtime_id, &self.project],
            )
            .await?;
            db.execute(
                "insert into runtime_leases(id, project_id, runtime_id, status, launched_at)
                 values($1, $2, $3, 'active', now())",
                &[&lease_id, &self.project, &runtime_id],
            )
            .await?;
            db.execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
        }
        db.execute(
            "insert into runs(id, project_id, conversation_id, run_type, status)
             values($1, $2, $3, 'prompt', 'in_progress')",
            &[&run_id, &self.project, &self.conversation],
        )
        .await?;
        db.execute(
            "insert into agent_jobs(id, project_id, run_id, conversation_id, status, payload,
                                    leased_by_runtime_id, leased_at, lease_expires_at)
             values($1, $2, $3, $4, 'leased', $5, $6, now(), now() + interval '5 minutes')",
            &[
                &job_id,
                &self.project,
                &run_id,
                &self.conversation,
                &PgJson(json!({ "user_id": self.users[0] })),
                &runtime_id,
            ],
        )
        .await?;
        let token = mint_scoped_token(
            &self.state.config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: self.users[0].to_string(),
                project_id: self.project.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: vec![
                    "prompt.execute".to_string(),
                    "job.token.workspace-separated".to_string(),
                ],
                lease_id: Some(lease_id.to_string()),
                run_id: Some(run_id.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
        .token;
        Ok(Job {
            token,
            job_id,
            run_id,
            runtime_id,
            lease_id,
        })
    }

    pub(super) fn open_body(&self, job: &Job, port: i64) -> Value {
        json!({
            "runtimeId": job.runtime_id,
            "runtimeLeaseId": job.lease_id,
            "port": port,
            "path": "/",
            "title": "Site preview",
            "metadata": { "source": "instafy-cli" },
        })
    }

    pub(super) async fn open(&self, job: &Job) -> anyhow::Result<String> {
        let (status, body) = self
            .request(
                &job.token,
                "POST",
                &self.path(""),
                self.open_body(job, 4173),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Ok(body["previewId"].as_str().context("previewId")?.to_string())
    }

    pub(super) async fn grant_metadata(&self, preview_id: &str) -> anyhow::Result<Value> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from runtime_tunnel_grants where tunnel_id = $1",
                &[&preview_id],
            )
            .await?
            .get("metadata"))
    }

    /// Mint a viewer URL and return it with its label.
    pub(super) async fn view(
        &self,
        user: usize,
        preview_id: &str,
    ) -> anyhow::Result<(String, String)> {
        let (status, body) = self
            .request(
                &self.tokens[user],
                "POST",
                &self.path(&format!("/{preview_id}/view")),
                json!({}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["idleTimeoutSeconds"], json!(1800));
        let viewer_url = body["viewerUrl"].as_str().context("viewerUrl")?.to_string();
        let host = url::Url::parse(&viewer_url)?
            .host_str()
            .context("viewer host")?
            .to_string();
        let (label, tunnel) = parse_viewer_host(&host).context("viewer label")?;
        assert_eq!(tunnel.to_string(), preview_id);
        Ok((viewer_url, label))
    }

    pub(super) async fn hook(
        &self,
        bearer: &str,
        tunnel_id: &str,
        label: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tunnel-broker/hooks/preview-auth")
                    .header("authorization", format!("Bearer {bearer}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "tunnelId": tunnel_id, "capabilityHash": capability_hash(label) })
                            .to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(json!(null)),
        ))
    }

    /// A runtime machine token for `job`'s runtime and lease, minted for
    /// `subject` (the user the runtime acts for).
    pub(super) fn machine_token(&self, job: &Job, subject: Uuid) -> anyhow::Result<String> {
        Ok(mint_scoped_token(
            &self.state.config,
            ScopedTokenRequest {
                audience: job.runtime_id.to_string(),
                subject: subject.to_string(),
                project_id: self.project.to_string(),
                origin_id: None,
                runtime_id: Some(job.runtime_id.to_string()),
                protocol: None,
                scopes: crate::runtime::RUNTIME_TOKEN_REQUIRED_SCOPES
                    .iter()
                    .map(|scope| scope.to_string())
                    .collect(),
                lease_id: Some(job.lease_id.to_string()),
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
        .token)
    }

    /// Another conversation in the space, created by the owner.
    pub(super) async fn conversation(&self, visibility: &str) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        self.state
            .pool
            .get()
            .await?
            .execute(
                "insert into conversations(id, project_id, created_by, visibility, metadata, root_conversation_id)
                 values($1, $2, $3, $4, '{}'::jsonb, $1)",
                &[&id, &self.project, &self.users[0], &visibility],
            )
            .await?;
        Ok(id)
    }

    /// Open (or re-open) a preview on `job`'s runtime as `token`, with its
    /// card going to `conversation`.
    pub(super) async fn open_for(
        &self,
        token: &str,
        job: &Job,
        conversation: Uuid,
        port: i64,
        title: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let mut body = self.open_body(job, port);
        body["conversationId"] = json!(conversation);
        body["title"] = json!(title);
        self.request(token, "POST", &self.path(""), body).await
    }

    pub(super) async fn ready(&self, token: &str, preview_id: &str) -> anyhow::Result<Value> {
        let (status, body) = self
            .request(
                token,
                "POST",
                &self.path(&format!("/{preview_id}/ready")),
                json!({}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(body)
    }

    pub(super) async fn message_conversation(&self, message_id: &Value) -> anyhow::Result<Uuid> {
        let id = Uuid::parse_str(message_id.as_str().context("messageId")?)?;
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select conversation_id from conversation_messages where id = $1",
                &[&id],
            )
            .await?
            .get(0))
    }

    pub(super) async fn open_sessions(&self, preview_id: &str) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from runtime_preview_sessions
                 where tunnel_id = $1 and revoked_at is null",
                &[&preview_id],
            )
            .await?
            .get(0))
    }

    /// The same request against another app (another state).
    pub(super) async fn request_on(
        &self,
        app: &Router,
        token: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(if method == "GET" || body.is_null() {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(null)),
        ))
    }

    pub(super) async fn count_grants(&self) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from runtime_tunnel_grants where project_id = $1",
                &[&self.project],
            )
            .await?
            .get(0))
    }

    /// Set a session as last used `minutes` ago.
    pub(super) async fn age_session(&self, hash: &str, minutes: i32) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "update runtime_preview_sessions
                 set last_used_at = now() - make_interval(mins => $2)
                 where capability_hash = $1",
                &[&hash, &minutes],
            )
            .await?;
        Ok(())
    }

    pub(super) async fn idle_minutes(&self, hash: &str) -> anyhow::Result<f64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select (extract(epoch from now() - last_used_at) / 60)::float8
                 from runtime_preview_sessions where capability_hash = $1",
                &[&hash],
            )
            .await?
            .get::<_, Option<f64>>(0)
            .unwrap_or(99.0))
    }

    pub(super) async fn allowed(&self, preview_id: &str, label: &str) -> anyhow::Result<bool> {
        let (status, body) = self.hook(HOOK_SECRET, preview_id, label).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let allow = body["allow"].as_bool().context("allow")?;
        let ttl = body["ttlSeconds"].as_i64().context("ttlSeconds")?;
        if allow {
            assert!((1..=30).contains(&ttl), "ttl {ttl}");
        }
        Ok(allow)
    }
}

pub(super) async fn run(
    test: impl FnOnce(Arc<Fixture>) -> futures_util::future::BoxFuture<'static, anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let fixture = Arc::new(Fixture::new().await?);
    let result = with_shared_db_fixture(fixture.shared(), test(fixture.clone())).await;
    let users = fixture.delete_users().await;
    result.and(users)
}

#[tokio::test]
async fn preview_create_binds_the_job_and_refuses_other_runtimes_ports_and_readers(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let other = f.job(None).await?;

            for body in [
                json!({ "runtimeId": other.runtime_id, "runtimeLeaseId": job.lease_id }),
                json!({ "runtimeId": job.runtime_id, "runtimeLeaseId": other.lease_id }),
            ] {
                let mut request = f.open_body(&job, 4173);
                request["runtimeId"] = body["runtimeId"].clone();
                request["runtimeLeaseId"] = body["runtimeLeaseId"].clone();
                let (status, result) = f.request(&job.token, "POST", &f.path(""), request).await?;
                assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            }

            for port in [9222, 80] {
                let (status, result) = f
                    .request(&job.token, "POST", &f.path(""), f.open_body(&job, port))
                    .await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
                assert_eq!(result["code"], "port_not_allowed");
            }

            // A read-only member cannot open one, even naming the conversation.
            let mut human = f.open_body(&job, 4173);
            human["conversationId"] = json!(f.conversation);
            let (status, result) = f
                .request(&f.tokens[2], "POST", &f.path(""), human.clone())
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            // A writer must name the conversation.
            let mut no_conversation = human.clone();
            no_conversation
                .as_object_mut()
                .unwrap()
                .remove("conversationId");
            let (status, _) = f
                .request(&f.tokens[1], "POST", &f.path(""), no_conversation)
                .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);

            let mut forged = f.open_body(&job, 4173);
            forged["metadata"][ACTIVE_JOB_TUNNEL_METADATA_KEY] =
                json!({ "jobId": other.job_id, "runId": other.run_id });
            forged["metadata"][PREVIEW_TUNNEL_METADATA_KEY] = json!({ "path": "@evil.example" });
            let (status, created) = f.request(&job.token, "POST", &f.path(""), forged).await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"].as_str().context("previewId")?;
            assert_eq!(created["credentials"]["localPort"], json!(4173));
            assert!(created["credentials"]["token"].is_string());
            // The runtime pins tokenless preview sites to this domain.
            assert_eq!(created["viewerHostSuffix"], json!("preview.localhost:8083"));
            // A bound site in the preview talks only to the Studio that frames it.
            assert_eq!(
                created["studioOrigin"],
                json!(f.state.config.public_app_url)
            );

            let metadata = f.grant_metadata(preview_id).await?;
            let preview = &metadata[PREVIEW_TUNNEL_METADATA_KEY];
            assert_eq!(preview["visibility"], "private");
            assert_eq!(preview["path"], "/");
            assert_eq!(metadata["localPort"], json!(4173));
            assert_eq!(preview["title"], "Site preview");
            assert_eq!(metadata["source"], "instafy-cli");
            assert_eq!(preview["messageIds"], json!({}));
            // Ordinary metadata names stay free: the preview owns one key.
            for key in [
                "kind",
                "visibility",
                "path",
                "title",
                "messageIds",
                "tunnelKey",
            ] {
                assert!(metadata.get(key).is_none(), "{key} at the top level");
            }
            let marker = &metadata[ACTIVE_JOB_TUNNEL_METADATA_KEY];
            assert_eq!(marker["jobId"], json!(job.job_id));
            assert_eq!(marker["runId"], json!(job.run_id));
            assert_eq!(marker["runtimeId"], json!(job.runtime_id));
            assert_eq!(marker["runtimeLeaseId"], json!(job.lease_id));

            let request = f
                .broker
                .requests
                .lock()
                .unwrap()
                .last()
                .cloned()
                .context("broker request")?;
            // One key per runtime and port, not per lease: opening it again
            // on the runtime's next lease keeps the preview id its cards name.
            assert_eq!(
                request.idempotency_key.as_deref(),
                Some(format!("preview:{}:4173", job.runtime_id).as_str())
            );
            assert_eq!(
                preview["tunnelKey"],
                json!(format!("preview:{}:4173", job.runtime_id))
            );
            assert_eq!(request.expires_in_seconds, Some(43_200));
            assert_eq!(
                request.labels,
                Some(json!({ "kind": "preview", "visibility": "private" }))
            );

            // A writer may open one for a conversation they can write in.
            let mut writer = f.open_body(&job, 4174);
            writer["conversationId"] = json!(f.conversation);
            let (status, result) = f.request(&f.tokens[1], "POST", &f.path(""), writer).await?;
            assert_eq!(status, StatusCode::CREATED, "{result}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn one_runtime_holds_a_bounded_number_of_previews() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let open = |port: i64| {
                let f = f.clone();
                let token = job.token.clone();
                let body = f.open_body(&job, port);
                async move { f.request(&token, "POST", &f.path(""), body).await }
            };
            for index in 0..PREVIEWS_PER_RUNTIME {
                let (status, body) = open(5000 + index).await?;
                assert_eq!(status, StatusCode::CREATED, "{body}");
            }
            let (status, body) = open(6000).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            assert!(body.to_string().contains("Close one first"), "{body}");
            // Re-opening one of its own ports still works.
            let (status, body) = open(5000).await?;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            // Another runtime has its own allowance.
            let other = f.job(None).await?;
            let (status, body) = f
                .request(&other.token, "POST", &f.path(""), f.open_body(&other, 6000))
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn preview_ready_writes_one_card_per_run_and_publishes_it() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let mut events = f.state.events.subscribe();
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let ready_path = f.path(&format!("/{preview_id}/ready"));

            let (status, ready) = f
                .request(&job.token, "POST", &ready_path, json!({}))
                .await?;
            assert_eq!(status, StatusCode::OK, "{ready}");
            assert_eq!(ready["health"], json!({ "listening": true, "status": 200 }));
            let message_id = ready["messageId"]
                .as_str()
                .context("messageId")?
                .to_string();

            let event = loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                    .await??;
                if event.kind == "conversation.message_created" {
                    break event;
                }
            };
            assert_eq!(event.data["id"], json!(message_id));
            assert_eq!(event.conversation_id, Some(f.conversation));

            let (status, again) = f
                .request(&job.token, "POST", &ready_path, json!({}))
                .await?;
            assert_eq!(status, StatusCode::OK, "{again}");
            assert_eq!(again["messageId"], json!(message_id), "one card per run");

            let db = f.state.pool.get().await?;
            let rows = db
                .query(
                    "select id, role, content, run_id, metadata from conversation_messages
                     where conversation_id = $1
                       and metadata->'details'->'details'->'preview'->>'previewId' = $2",
                    &[&f.conversation, &preview_id],
                )
                .await?;
            assert_eq!(rows.len(), 1);
            let row = &rows[0];
            assert_eq!(row.get::<_, String>("role"), "assistant");
            assert_eq!(
                row.get::<_, String>("content"),
                "Site preview is ready to preview."
            );
            assert_eq!(row.get::<_, Option<Uuid>>("run_id"), Some(job.run_id));
            let metadata: Value = row.get("metadata");
            assert_eq!(metadata["messageType"], "action_request");
            assert_eq!(metadata["jobId"], json!(job.job_id.to_string()));
            assert_eq!(
                metadata["details"]["details"]["preview"],
                json!({ "previewId": preview_id, "port": 4173, "path": "/" })
            );
            let text = metadata.to_string();
            assert!(!text.contains("href") && !text.contains("http"), "{text}");
            drop(db);

            // The next run re-opens the same port: same tunnel, its own card,
            // and the first run's card survives in messageIds.
            let next = f.job(Some(&job)).await?;
            assert_eq!(f.open(&next).await?, preview_id);
            let (status, result) = f
                .request(&job.token, "POST", &ready_path, json!({}))
                .await?;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "the first job no longer owns it: {result}"
            );
            let (status, second) = f
                .request(&next.token, "POST", &ready_path, json!({}))
                .await?;
            assert_eq!(status, StatusCode::OK, "{second}");
            assert_ne!(second["messageId"], json!(message_id));
            let metadata = f.grant_metadata(&preview_id).await?;
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"][job.run_id.to_string()],
                json!(message_id)
            );
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"][next.run_id.to_string()],
                second["messageId"]
            );

            let (status, preview) = f
                .request(
                    &f.tokens[2],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["previewId"], json!(preview_id));
            assert_eq!(preview["port"], json!(4173));
            assert_eq!(preview["status"], "active");
            assert_eq!(preview["health"]["listening"], json!(true));
            assert_eq!(preview["messageId"], second["messageId"]);
            let (status, list) = f
                .request(&next.token, "GET", &f.path(""), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::OK, "{list}");
            assert_eq!(list.as_array().map(Vec::len), Some(1));
            assert!(list[0].get("health").is_none());
            let (status, _) = f
                .request(&f.tokens[3], "GET", &f.path(""), Value::Null)
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn preview_view_mints_bounded_sessions_for_members_who_can_see_the_runtime(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;

            let (viewer_url, label) = f.view(0, &preview_id).await?;
            assert!(viewer_url.starts_with("http://p-"));
            assert!(viewer_url.ends_with(&format!(
                "--{}.preview.localhost:8083/",
                Uuid::parse_str(&preview_id)?.simple()
            )));
            let stored: Vec<String> = f
                .state
                .pool
                .get()
                .await?
                .query(
                    "select capability_hash from runtime_preview_sessions where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            assert_eq!(stored, vec![capability_hash(&label)], "only the hash is stored");

            let (status, _) = f
                .request(&f.tokens[3], "POST", &f.path(&format!("/{preview_id}/view")), json!({}))
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "a non-member cannot open it");

            // At most five live sessions per user and preview; the oldest goes.
            let mut labels = Vec::new();
            for _ in 0..6 {
                labels.push(f.view(2, &preview_id).await?.1);
            }
            let live: i64 = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select count(*) from runtime_preview_sessions
                     where tunnel_id = $1 and user_id = $2 and revoked_at is null",
                    &[&preview_id, &f.users[2]],
                )
                .await?
                .get(0);
            assert_eq!(live, 5);
            assert!(!f.allowed(&preview_id, &labels[0]).await?);
            assert!(f.allowed(&preview_id, &labels[5]).await?);

            // Another user's private runtime is invisible, so its preview is too.
            let private_runtime = Uuid::new_v4();
            let private_tunnel = Uuid::new_v4().to_string();
            {
                let db = f.state.pool.get().await?;
                db.execute(
                    "insert into runtimes(id, project_id, provider, status, capabilities)
                     values($1, $2, 'default', 'running', $3)",
                    &[
                        &private_runtime,
                        &f.project,
                        &json!({ "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": f.users[1] } }),
                    ],
                )
                .await?;
                db.execute(
                    "insert into runtime_tunnel_grants
                       (project_id, runtime_id, provider, tunnel_id, hostname, url, status, expires_at, metadata)
                     values($1, $2, 'self_hosted', $3, 'private.rt.localhost', 'https://private.rt.localhost',
                            'active', now() + interval '1 hour', $4)",
                    &[
                        &f.project,
                        &private_runtime,
                        &private_tunnel,
                        &json!({
                            "localPort": 4173,
                            (PREVIEW_TUNNEL_METADATA_KEY): { "visibility": "private", "path": "/", "title": "Mine" },
                        }),
                    ],
                )
                .await?;
            }
            let (status, result) = f
                .request(&f.tokens[0], "POST", &f.path(&format!("/{private_tunnel}/view")), json!({}))
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            let (_, private_label) = f.view(1, &private_tunnel).await?;
            assert!(f.allowed(&private_tunnel, &private_label).await?);
            let (status, previews) = f.request(&f.tokens[0], "GET", &f.path(""), Value::Null).await?;
            assert_eq!(status, StatusCode::OK);
            assert!(!previews.to_string().contains(&private_tunnel));

            // The pane revokes its own session when its tab closes.
            let (status, _) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &f.path(&format!("/{preview_id}/view/revoke")),
                    json!({ "viewerUrl": viewer_url }),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert!(!f.allowed(&preview_id, &label).await?);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn preview_auth_hook_denies_every_stale_or_foreign_capability() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let other_preview = {
                let other = f.job(None).await?;
                f.open(&other).await?
            };
            let (_, label) = f.view(2, &preview_id).await?;

            let (status, _) = f.hook("wrong-secret", &preview_id, &label).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(f.allowed(&preview_id, &label).await?);
            // The broker may name the tunnel by its simple hex.
            let simple = Uuid::parse_str(&preview_id)?.simple().to_string();
            assert!(f.allowed(&simple, &label).await?);

            assert!(!f.allowed(&other_preview, &label).await?, "wrong tunnel");
            assert!(
                !f.allowed(&preview_id, &mint_capability_label()).await?,
                "unknown label"
            );

            let db = f.state.pool.get().await?;
            let hash = capability_hash(&label);
            db.execute(
                "update runtime_preview_sessions set last_used_at = now() - interval '31 minutes'
                 where capability_hash = $1",
                &[&hash],
            )
            .await?;
            assert!(!f.allowed(&preview_id, &label).await?, "idle");
            db.execute(
                "update runtime_preview_sessions
                 set last_used_at = now(), created_at = now() - interval '13 hours'
                 where capability_hash = $1",
                &[&hash],
            )
            .await?;
            assert!(!f.allowed(&preview_id, &label).await?, "expired");

            let (_, fresh) = f.view(2, &preview_id).await?;
            assert!(f.allowed(&preview_id, &fresh).await?);
            db.execute(
                "update runtime_tunnel_grants set expires_at = now() - interval '1 second'
                 where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            assert!(!f.allowed(&preview_id, &fresh).await?, "grant expired");
            db.execute(
                "update runtime_tunnel_grants set expires_at = now() + interval '1 hour'
                 where tunnel_id = $1",
                &[&preview_id],
            )
            .await?;
            assert!(f.allowed(&preview_id, &fresh).await?);

            db.execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&f.project, &f.users[2]],
            )
            .await?;
            // The broker's own cache and this one together stay within 30 s;
            // skip the wait by dropping this node's entry.
            forget_viewer_access(&f.users[2], &f.project);
            assert!(!f.allowed(&preview_id, &fresh).await?, "removed member");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn preview_grant_revocation_ends_its_sessions() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let (_, label) = f.view(0, &preview_id).await?;
            assert!(f.allowed(&preview_id, &label).await?);

            // Runtime stop and the sweeps revoke through this helper.
            let revoked = revoke_tunnels_for_scope(
                &f.state,
                &f.project,
                Some(&job.runtime_id),
                None,
                "test.runtime_stop",
            )
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
            assert_eq!(revoked, 1);
            let db = f.state.pool.get().await?;
            let status: String = db
                .query_one(
                    "select status from runtime_tunnel_grants where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(status, "revoked");
            let open_sessions: i64 = db
                .query_one(
                    "select count(*) from runtime_preview_sessions
                     where tunnel_id = $1 and revoked_at is null",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(open_sessions, 0);
            assert!(!f.allowed(&preview_id, &label).await?);
            let (status, _) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &f.path(&format!("/{preview_id}/view")),
                    json!({}),
                )
                .await?;
            assert_eq!(
                status,
                StatusCode::CONFLICT,
                "a stopped preview cannot be opened"
            );

            // Close by any job on the runtime: re-open, view, close.
            let next = f.job(Some(&job)).await?;
            assert_eq!(f.open(&next).await?, preview_id);
            let (_, label) = f.view(0, &preview_id).await?;
            let other = f.job(None).await?;
            let close = f.path(&format!("/{preview_id}/close"));
            let (status, _) = f.request(&other.token, "POST", &close, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "a job on another runtime");
            let (status, _) = f.request(&f.tokens[2], "POST", &close, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "a read-only member");
            let (status, _) = f.request(&next.token, "POST", &close, json!({})).await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert!(!f.allowed(&preview_id, &label).await?);
            let (status, preview) = f
                .request(
                    &f.tokens[0],
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(preview["status"], "revoked");
            assert_eq!(preview["health"], Value::Null);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_later_job_on_the_runtime_stops_a_tunnel_an_earlier_job_started() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let request_path = format!("/projects/{}/tunnels/request", f.project);
            // Each purpose is its own broker tunnel.
            let start = |token: String, job: &Job, purpose: &str, port: u16| {
                let f = f.clone();
                let path = request_path.clone();
                let body = json!({
                    "runtimeId": job.runtime_id,
                    "runtimeLeaseId": job.lease_id,
                    "purpose": purpose,
                    "localPort": port,
                    "metadata": { "source": "instafy-cli", "localPort": port },
                });
                async move {
                    let (status, tunnel) = f.request(&token, "POST", &path, body).await?;
                    assert_eq!(status, StatusCode::OK, "{tunnel}");
                    anyhow::Ok(tunnel["tunnelId"].as_str().context("tunnelId")?.to_string())
                }
            };
            let revoke = |token: String, tunnel_id: String| {
                let f = f.clone();
                async move {
                    let path = format!("/projects/{}/tunnels/{tunnel_id}/revoke", f.project);
                    let (status, _) = f.request(&token, "POST", &path, json!({})).await?;
                    anyhow::Ok(status)
                }
            };

            let first_turn = f.job(None).await?;
            let tunnel_id = start(first_turn.token.clone(), &first_turn, "web", 5000).await?;
            // The runtime's own tunnel carries no agent job marker.
            let machine = f.machine_token(&first_turn, f.users[0])?;
            let machine_tunnel = start(machine, &first_turn, "api", 5001).await?;
            assert_ne!(machine_tunnel, tunnel_id);

            // The next turn is a new job and run on the same runtime.
            let later_turn = f.job(Some(&first_turn)).await?;
            assert_ne!(later_turn.job_id, first_turn.job_id);
            assert_ne!(later_turn.run_id, first_turn.run_id);
            let other_runtime = f.job(None).await?;

            assert_eq!(
                revoke(other_runtime.token.clone(), tunnel_id.clone()).await?,
                StatusCode::UNAUTHORIZED,
                "a job on another runtime"
            );
            assert_eq!(
                revoke(f.tokens[2].clone(), tunnel_id.clone()).await?,
                StatusCode::FORBIDDEN,
                "a read-only member"
            );
            assert_eq!(
                revoke(later_turn.token.clone(), machine_tunnel.clone()).await?,
                StatusCode::FORBIDDEN,
                "a tunnel no agent job started"
            );
            assert_ne!(f.grant_status(&tunnel_id).await?, "revoked");
            assert_ne!(f.grant_status(&machine_tunnel).await?, "revoked");

            assert_eq!(
                revoke(later_turn.token.clone(), tunnel_id.clone()).await?,
                StatusCode::OK,
                "a later turn on the same runtime"
            );
            assert_eq!(f.grant_status(&tunnel_id).await?, "revoked");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_session_is_not_stored_for_a_preview_revoked_after_the_open_check() -> anyhow::Result<()>
{
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            // The revoke lands between the Open's own check and its insert.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants set status = 'revoked' where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?;
            let label = mint_capability_label();
            let result = insert_preview_session(
                &f.state.pool,
                &capability_hash(&label),
                &preview_id,
                &f.project,
                &f.users[0],
                false,
            )
            .await;
            let Err((status, _)) = result else {
                anyhow::bail!("a session was stored for a revoked preview");
            };
            assert_eq!(status, StatusCode::CONFLICT);
            let stored: i64 = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select count(*) from runtime_preview_sessions where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(stored, 0);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn the_tunnel_status_route_cannot_reopen_a_closed_preview() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let (_, label) = f.view(0, &preview_id).await?;
            let close = f.path(&format!("/{preview_id}/close"));
            let (status, _) = f.request(&job.token, "POST", &close, json!({})).await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            // A session the revoke missed, as a race could leave.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_preview_sessions set revoked_at = null
                     where capability_hash = $1",
                    &[&capability_hash(&label)],
                )
                .await?;
            let machine = f.machine_token(&job, f.users[0])?;
            let status_path = format!("/projects/{}/tunnels/{preview_id}/status", f.project);
            for value in ["active", "issuing", "something-else"] {
                let (status, result) = f
                    .request(&machine, "POST", &status_path, json!({ "status": value }))
                    .await?;
                assert_eq!(status, StatusCode::CONFLICT, "{value}: {result}");
            }
            let stored: String = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select status from runtime_tunnel_grants where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(stored, "revoked");
            assert!(!f.allowed(&preview_id, &label).await?);
            // Moving it between stopped states is still fine.
            let (status, result) = f
                .request(
                    &machine,
                    "POST",
                    &status_path,
                    json!({ "status": "expired" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn tunnel_acl_hook_skips_the_credit_burn_for_private_previews() -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let mut state = fixture.state.clone();
    state.config.tunnel_credit_burn_amount = 4;
    let app = crate::tunnels::router().with_state(state);
    let shared = fixture.shared();
    let project = fixture.project;
    let result = with_shared_db_fixture(shared, async move {
        let acl = |metadata: Value| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/tunnel-broker/hooks/acl")
                            .header("authorization", format!("Bearer {HOOK_SECRET}"))
                            .header("content-type", "application/json")
                            .body(Body::from(
                                json!({
                                    "intent": "create_tunnel",
                                    "project_id": project,
                                    "metadata": metadata,
                                })
                                .to_string(),
                            ))?,
                    )
                    .await?;
                let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
                anyhow::Ok(serde_json::from_slice::<Value>(&bytes)?)
            }
        };
        // Without an idempotency key a billed tunnel is refused, which shows
        // the burn would apply; a private preview passes without one.
        let public = acl(json!({ "kind": "tunnel", "visibility": "public" })).await?;
        assert_eq!(public["allowed"], json!(false), "{public}");
        for metadata in [
            json!({ "kind": "preview", "visibility": "private" }),
            json!({ "labels": { "kind": "preview", "visibility": "private" } }),
        ] {
            let private = acl(metadata).await?;
            assert_eq!(private["allowed"], json!(true), "{private}");
        }
        Ok(())
    })
    .await;
    result.and(fixture.delete_users().await)
}

#[tokio::test]
async fn preview_cards_follow_the_conversation_title_and_reopen() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let writer = f.tokens[1].clone();
            let (status, created) = f
                .open_for(&writer, &job, f.conversation, 4180, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            let first = f.ready(&writer, &preview_id).await?["messageId"].clone();
            assert_eq!(f.message_conversation(&first).await?, f.conversation);

            // The same port opened for another conversation gets a card there.
            let other = f.conversation("public").await?;
            let (status, again) = f
                .open_for(&writer, &job, other, 4180, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{again}");
            assert_eq!(again["previewId"], json!(preview_id));
            let second = f.ready(&writer, &preview_id).await?["messageId"].clone();
            assert_ne!(second, first);
            assert_eq!(f.message_conversation(&second).await?, other);
            assert_eq!(f.ready(&writer, &preview_id).await?["messageId"], second);
            let metadata = f.grant_metadata(&preview_id).await?;
            assert_eq!(metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageId"], second);
            assert_eq!(
                metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"]
                    [format!("manual:{}", f.conversation)],
                first
            );

            // Re-opening with the same title keeps the cards and the latest one.
            f.open_for(&writer, &job, other, 4180, "Site preview")
                .await?;
            let metadata = f.grant_metadata(&preview_id).await?;
            assert_eq!(metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageId"], second);
            assert_eq!(f.ready(&writer, &preview_id).await?["messageId"], second);

            // A new title is a new card, as is a re-open after close.
            f.open_for(&writer, &job, other, 4180, "Site preview v2")
                .await?;
            let renamed = f.ready(&writer, &preview_id).await?["messageId"].clone();
            assert_ne!(renamed, second);
            let close = f.path(&format!("/{preview_id}/close"));
            let (status, _) = f.request(&writer, "POST", &close, json!({})).await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            f.open_for(&writer, &job, other, 4180, "Site preview v2")
                .await?;
            let reopened = f.ready(&writer, &preview_id).await?["messageId"].clone();
            assert_ne!(reopened, renamed);
            let (status, preview) = f
                .request(
                    &writer,
                    "GET",
                    &f.path(&format!("/{preview_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["title"], "Site preview v2");
            assert_eq!(preview["messageId"], reopened);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn runtime_tokens_post_cards_only_where_their_user_may_read() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let private = f.conversation("private").await?;
            let outsider = f.machine_token(&job, f.users[3])?;
            let (status, result) = f
                .open_for(&outsider, &job, private, 4181, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            let service = f.machine_token(&job, Uuid::new_v4())?;
            let (status, result) = f
                .open_for(&service, &job, private, 4181, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            // A shared conversation is fine for any runtime token.
            let (status, result) = f
                .open_for(&service, &job, f.conversation, 4182, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{result}");

            let owner = f.machine_token(&job, f.users[0])?;
            let (status, created) = f
                .open_for(&owner, &job, private, 4181, "Site preview")
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"].as_str().context("previewId")?;
            let card = f.ready(&owner, preview_id).await?["messageId"].clone();
            assert_eq!(f.message_conversation(&card).await?, private);

            // A leased runtime's token names the controller's service user,
            // which is no person: even when that user could read the private
            // conversation, the token may only post into shared ones.
            let mut state = f.state.clone();
            state.config.service_runtime_user_id = Some(f.users[0]);
            let app = router().merge(crate::tunnels::router()).with_state(state);
            let mut body = f.open_body(&job, 4183);
            body["conversationId"] = json!(private);
            let (status, result) = f
                .request_on(&app, &owner, "POST", &f.path(""), body.clone())
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
            body["conversationId"] = json!(f.conversation);
            let (status, result) = f
                .request_on(&app, &owner, "POST", &f.path(""), body)
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{result}");
            Ok(())
        })
    })
    .await
}

#[test]
fn a_runtime_token_with_the_controller_service_subject_acts_for_nobody() {
    let person = Uuid::new_v4();
    let service = Uuid::new_v4();
    assert_eq!(
        machine_subject_user_id(&person.to_string(), Some(service)),
        Some(person)
    );
    assert_eq!(
        machine_subject_user_id(&service.to_string(), Some(service)),
        None
    );
    assert_eq!(machine_subject_user_id("runtime.service", None), None);
    assert_eq!(machine_subject_user_id("not-a-uuid", None), None);
}

#[tokio::test]
async fn preview_ready_waits_for_a_starting_client_and_reload_reads_fresh_health(
) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering;
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            f.broker.silent_probes.store(2, Ordering::SeqCst);
            let before = f.broker.probes.load(Ordering::SeqCst);
            let ready = f.ready(&job.token, &preview_id).await?;
            assert_eq!(ready["health"], json!({ "listening": true, "status": 200 }));
            assert_eq!(f.broker.probes.load(Ordering::SeqCst) - before, 3);

            // A cached answer serves ordinary reads; Reload asks again.
            f.broker.silent_probes.store(1, Ordering::SeqCst);
            let get = |fresh: bool| {
                let path = f.path(&format!(
                    "/{preview_id}{}",
                    if fresh { "?fresh=1" } else { "" }
                ));
                let token = f.tokens[0].clone();
                let f = f.clone();
                async move { f.request(&token, "GET", &path, Value::Null).await }
            };
            let (_, cached) = get(false).await?;
            assert_eq!(cached["health"]["listening"], json!(true));
            let (_, fresh) = get(true).await?;
            assert_eq!(fresh["health"]["listening"], json!(false));
            Ok(())
        })
    })
    .await
}

impl Fixture {
    async fn grant_status(&self, preview_id: &str) -> anyhow::Result<String> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select status from runtime_tunnel_grants where tunnel_id = $1 and project_id = $2",
                &[&preview_id, &self.project],
            )
            .await?
            .get(0))
    }
}

/// The next `tunnel.status_updated` saying this preview became active.
fn active_event(
    events: &mut tokio::sync::broadcast::Receiver<crate::state::ControllerEvent>,
    preview_id: &str,
) -> anyhow::Result<()> {
    loop {
        let event = events.try_recv().context("tunnel.status_updated")?;
        if event.kind == "tunnel.status_updated" && event.data["tunnelId"] == json!(preview_id) {
            assert_eq!(event.data["status"], "active", "{}", event.data);
            return Ok(());
        }
    }
}

#[tokio::test]
async fn an_issuing_preview_becomes_active_when_ready_sees_its_site() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            *f.broker.assignment_status.lock().unwrap() = Some("issuing".to_string());
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            assert_eq!(f.grant_status(&preview_id).await?, "issuing");

            let mut events = f.state.events.subscribe();
            let ready = f.ready(&job.token, &preview_id).await?;
            assert_eq!(ready["health"], json!({ "listening": true, "status": 200 }));
            assert_eq!(f.grant_status(&preview_id).await?, "active");
            active_event(&mut events, &preview_id)?;

            // What the card reads: active and answering, so Live.
            let path = f.path(&format!("/{preview_id}"));
            let (status, preview) = f.request(&f.tokens[0], "GET", &path, Value::Null).await?;
            assert_eq!(status, StatusCode::OK, "{preview}");
            assert_eq!(preview["status"], "active", "{preview}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn listing_tunnels_makes_an_issuing_public_tunnel_active_once_its_site_answers(
) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering;
    run(|f| {
        Box::pin(async move {
            *f.broker.assignment_status.lock().unwrap() = Some("issuing".to_string());
            let job = f.job(None).await?;
            let (status, tunnel) = f
                .request(
                    &job.token,
                    "POST",
                    &format!("/projects/{}/tunnels/request", f.project),
                    json!({
                        "runtimeId": job.runtime_id,
                        "runtimeLeaseId": job.lease_id,
                        "purpose": "web",
                        "localPort": 5000,
                        "metadata": { "source": "instafy-cli", "localPort": 5000 },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{tunnel}");
            let tunnel_id = tunnel["tunnelId"].as_str().context("tunnelId")?.to_string();
            assert_eq!(f.grant_status(&tunnel_id).await?, "issuing");
            let list_path = format!("/projects/{}/tunnels", f.project);
            let listed = |f: Arc<Fixture>, id: String| {
                let path = list_path.clone();
                async move {
                    let (status, list) = f.request(&f.tokens[0], "GET", &path, Value::Null).await?;
                    assert_eq!(status, StatusCode::OK, "{list}");
                    let grant = list["grants"]
                        .as_array()
                        .and_then(|grants| {
                            grants.iter().find(|grant| grant["tunnelId"] == json!(id))
                        })
                        .cloned()
                        .context("listed grant")?;
                    anyhow::Ok(grant["status"].as_str().context("status")?.to_string())
                }
            };
            crate::tunnels::forget_issuing_tunnel_probes();

            // The client has not connected yet: nothing answers, so it stays issuing.
            f.broker.silent_probes.store(1, Ordering::SeqCst);
            let probes = f.broker.probes.load(Ordering::SeqCst);
            assert_eq!(listed(f.clone(), tunnel_id.clone()).await?, "issuing");
            assert_eq!(f.broker.probes.load(Ordering::SeqCst) - probes, 1);
            assert_eq!(f.grant_status(&tunnel_id).await?, "issuing");
            // A listing polled right after does not ask again.
            assert_eq!(listed(f.clone(), tunnel_id.clone()).await?, "issuing");
            assert_eq!(f.broker.probes.load(Ordering::SeqCst) - probes, 1);

            // Once the site answers through the tunnel, the grant says so.
            crate::tunnels::forget_issuing_tunnel_probes();
            let mut events = f.state.events.subscribe();
            assert_eq!(listed(f.clone(), tunnel_id.clone()).await?, "active");
            assert_eq!(f.grant_status(&tunnel_id).await?, "active");
            active_event(&mut events, &tunnel_id)?;
            // An active grant is not probed again.
            crate::tunnels::forget_issuing_tunnel_probes();
            let probes = f.broker.probes.load(Ordering::SeqCst);
            assert_eq!(listed(f.clone(), tunnel_id.clone()).await?, "active");
            assert_eq!(f.broker.probes.load(Ordering::SeqCst), probes);

            // A preview proves itself on its own routes; the listing leaves it be.
            let preview_id = f.open(&job).await?;
            assert_eq!(f.grant_status(&preview_id).await?, "issuing");
            crate::tunnels::forget_issuing_tunnel_probes();
            let probes = f.broker.probes.load(Ordering::SeqCst);
            assert_eq!(listed(f.clone(), preview_id.clone()).await?, "issuing");
            assert_eq!(f.broker.probes.load(Ordering::SeqCst), probes);

            // A grant past its expiry is listed as expired, not as still running.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants set expires_at = now() - interval '1 minute'
                     where tunnel_id = $1",
                    &[&tunnel_id],
                )
                .await?;
            assert_eq!(listed(f.clone(), tunnel_id.clone()).await?, "expired");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_tunnel_probe_that_never_answers_does_not_hold_back_the_others() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            *f.broker.assignment_status.lock().unwrap() = Some("issuing".to_string());
            let job = f.job(None).await?;
            let start = |purpose: &'static str, port: u16| {
                let f = f.clone();
                let token = job.token.clone();
                let body = json!({
                    "runtimeId": job.runtime_id,
                    "runtimeLeaseId": job.lease_id,
                    "purpose": purpose,
                    "localPort": port,
                    "metadata": { "source": "instafy-cli", "localPort": port },
                });
                async move {
                    let path = format!("/projects/{}/tunnels/request", f.project);
                    let (status, tunnel) = f.request(&token, "POST", &path, body).await?;
                    assert_eq!(status, StatusCode::OK, "{tunnel}");
                    anyhow::Ok(tunnel["tunnelId"].as_str().context("tunnelId")?.to_string())
                }
            };
            let stuck = start("web", 5000).await?;
            let answering = start("api", 5001).await?;
            assert_ne!(stuck, answering);
            *f.broker.probe_hangs_for.lock().unwrap() = Some(stuck.clone());
            crate::tunnels::forget_issuing_tunnel_probes();

            let started = std::time::Instant::now();
            let path = format!("/projects/{}/tunnels", f.project);
            let (status, list) = f.request(&f.tokens[0], "GET", &path, Value::Null).await?;
            assert_eq!(status, StatusCode::OK, "{list}");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "the listing waited on the stuck probe"
            );
            let listed = |id: &str| {
                list["grants"]
                    .as_array()
                    .and_then(|grants| grants.iter().find(|grant| grant["tunnelId"] == json!(id)))
                    .and_then(|grant| grant["status"].as_str())
                    .map(str::to_string)
            };
            assert_eq!(listed(&stuck).as_deref(), Some("issuing"));
            assert_eq!(listed(&answering).as_deref(), Some("active"));
            assert_eq!(f.grant_status(&stuck).await?, "issuing");
            assert_eq!(f.grant_status(&answering).await?, "active");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn an_issuing_preview_becomes_active_on_a_read_only_once_its_site_answers(
) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering;
    run(|f| {
        Box::pin(async move {
            *f.broker.assignment_status.lock().unwrap() = Some("issuing".to_string());
            let job = f.job(None).await?;
            // `ready` is never called: only the pane or card reads the preview.
            let preview_id = f.open(&job).await?;
            let path = f.path(&format!("/{preview_id}?fresh=1"));
            let read = |f: Arc<Fixture>, path: String| async move {
                let (status, preview) = f.request(&f.tokens[0], "GET", &path, Value::Null).await?;
                assert_eq!(status, StatusCode::OK, "{preview}");
                anyhow::Ok(preview)
            };

            // Nothing listening yet, then the broker's 502 for a site that is
            // down behind it: neither proves the site, so the record stays.
            f.broker.silent_probes.store(1, Ordering::SeqCst);
            let preview = read(f.clone(), path.clone()).await?;
            assert_eq!(preview["health"]["listening"], json!(false));
            assert_eq!(preview["status"], "issuing", "{preview}");
            *f.broker.probe_status.lock().unwrap() = Some(502);
            let preview = read(f.clone(), path.clone()).await?;
            assert_eq!(preview["status"], "issuing", "{preview}");
            assert_eq!(f.grant_status(&preview_id).await?, "issuing");

            // The site answers: the record says active, and Studio hears it.
            *f.broker.probe_status.lock().unwrap() = None;
            let mut events = f.state.events.subscribe();
            let preview = read(f.clone(), path.clone()).await?;
            assert_eq!(
                preview["health"],
                json!({ "listening": true, "status": 200 })
            );
            assert_eq!(preview["status"], "active", "{preview}");
            assert_eq!(f.grant_status(&preview_id).await?, "active");
            active_event(&mut events, &preview_id)?;

            // A closed preview is never brought back by a probe.
            let (status, body) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &f.path(&format!("/{preview_id}/close")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
            let record =
                load_runtime_tunnel_grant_by_tunnel_id(&f.state.pool, &f.project, &preview_id)
                    .await
                    .map_err(|(_, error)| anyhow::anyhow!(error.0.message))?
                    .context("grant")?;
            let mut issuing = record.clone();
            issuing.status = "issuing".to_string();
            assert!(
                crate::tunnels::mark_issuing_tunnel_active(&f.state, &issuing)
                    .await
                    .map_err(|(_, error)| anyhow::anyhow!(error.0.message))?
                    .is_none()
            );
            assert_ne!(f.grant_status(&preview_id).await?, "active");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn preview_metadata_cannot_be_forged_or_dropped_through_the_tunnel_routes(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            // An ordinary tunnel cannot pass itself off as a private preview,
            // nor claim another job. Ordinary metadata names stay free.
            let (status, tunnel) = f
                .request(
                    &job.token,
                    "POST",
                    &format!("/projects/{}/tunnels/request", f.project),
                    json!({
                        "runtimeId": job.runtime_id,
                        "runtimeLeaseId": job.lease_id,
                        "purpose": "web",
                        "localPort": 5000,
                        "metadata": {
                            "source": "instafy-cli",
                            "localPort": 5000,
                            "kind": "preview",
                            "title": "My tunnel",
                            (PREVIEW_TUNNEL_METADATA_KEY): {
                                "visibility": "private",
                                "path": "@attacker.example/x",
                                "conversationId": f.conversation,
                                "tunnelKey": "preview:someone-else",
                                "serve": { "argv": ["sh", "-c", "evil"], "cwd": "." },
                                "closedAt": "2026-01-01T00:00:00Z",
                                "wokeAt": "2026-01-01T00:00:00Z",
                            },
                        },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{tunnel}");
            let forged = tunnel["tunnelId"].as_str().context("tunnelId")?.to_string();
            let metadata = f.grant_metadata(&forged).await?;
            assert!(
                metadata.get(PREVIEW_TUNNEL_METADATA_KEY).is_none(),
                "{metadata}"
            );
            assert_eq!(metadata["title"], "My tunnel");
            assert_eq!(metadata["kind"], "preview");
            let job_marker = metadata[ACTIVE_JOB_TUNNEL_METADATA_KEY].clone();
            assert_eq!(job_marker["jobId"], json!(job.job_id));
            let is_listed = |list: &Value, id: &str| {
                list.as_array()
                    .is_some_and(|items| items.iter().any(|item| item["previewId"] == json!(id)))
            };
            let view_forged = f.path(&format!("/{forged}/view"));
            let (status, _) = f
                .request(&f.tokens[0], "POST", &view_forged, json!({}))
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND);

            // A status update or a revoke can neither make an ordinary grant
            // a preview nor move it to another job.
            let machine = f.machine_token(&job, f.users[0])?;
            let status_path = format!("/projects/{}/tunnels/{forged}/status", f.project);
            let (status, result) = f
                .request(
                    &machine,
                    "POST",
                    &status_path,
                    json!({
                        "status": "active",
                        "metadata": {
                            "note": "kept",
                            (PREVIEW_TUNNEL_METADATA_KEY): {
                                "visibility": "private",
                                "path": "/",
                                "title": "Fake",
                                "messageIds": {},
                            },
                            (ACTIVE_JOB_TUNNEL_METADATA_KEY): { "jobId": Uuid::new_v4() },
                        },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            let metadata = f.grant_metadata(&forged).await?;
            assert!(
                metadata.get(PREVIEW_TUNNEL_METADATA_KEY).is_none(),
                "{metadata}"
            );
            assert_eq!(metadata["note"], "kept");
            assert_eq!(metadata[ACTIVE_JOB_TUNNEL_METADATA_KEY], job_marker);
            let (status, list) = f.request(&f.tokens[0], "GET", &f.path(""), json!({})).await?;
            assert_eq!(status, StatusCode::OK, "{list}");
            assert!(!is_listed(&list, &forged), "{list}");
            let (status, _) = f
                .request(&f.tokens[0], "POST", &view_forged, json!({}))
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND);
            let (status, result) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &format!("/projects/{}/tunnels/{forged}/revoke", f.project),
                    json!({ "metadata": {
                        (PREVIEW_TUNNEL_METADATA_KEY): { "visibility": "private" },
                        (ACTIVE_JOB_TUNNEL_METADATA_KEY): null,
                    } }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            let metadata = f.grant_metadata(&forged).await?;
            assert!(
                metadata.get(PREVIEW_TUNNEL_METADATA_KEY).is_none(),
                "{metadata}"
            );
            assert_eq!(metadata[ACTIVE_JOB_TUNNEL_METADATA_KEY], job_marker);

            // A revoke override cannot drop the preview object and so skip
            // the sessions.
            let preview_id = f.open(&job).await?;
            let (_, label) = f.view(0, &preview_id).await?;
            let (status, result) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &format!("/projects/{}/tunnels/{preview_id}/revoke", f.project),
                    json!({ "metadata": { (PREVIEW_TUNNEL_METADATA_KEY): null } }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            assert!(f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY].is_object());
            assert_eq!(f.open_sessions(&preview_id).await?, 0);

            // Neither can a status update, and a re-open of the same tunnel
            // does not bring back a capability minted before it stopped.
            let next = f.job(Some(&job)).await?;
            assert_eq!(f.open(&next).await?, preview_id);
            let (_, stale) = f.view(2, &preview_id).await?;
            assert!(f.allowed(&preview_id, &stale).await?);
            let machine = f.machine_token(&next, f.users[0])?;
            let (status, result) = f
                .request(
                    &machine,
                    "POST",
                    &format!("/projects/{}/tunnels/{preview_id}/status", f.project),
                    json!({ "status": "revoked", "metadata": { (PREVIEW_TUNNEL_METADATA_KEY): {} } }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{result}");
            assert_eq!(
                f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY]["visibility"],
                "private"
            );
            assert_eq!(f.open_sessions(&preview_id).await?, 0);
            // Even a session the status path missed ends on re-open.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_preview_sessions set revoked_at = null
                     where capability_hash = $1",
                    &[&capability_hash(&stale)],
                )
                .await?;
            assert_eq!(f.open(&next).await?, preview_id);
            assert!(!f.allowed(&preview_id, &stale).await?);
            assert!(!f.allowed(&preview_id, &label).await?);
            let (_, fresh) = f.view(2, &preview_id).await?;
            assert!(f.allowed(&preview_id, &fresh).await?);
            Ok(())
        })
    })
    .await
}

/// Waking a stopped preview, its agent channel and viewing as activity.
#[path = "wake_tests.rs"]
mod wake_tests;

#[tokio::test]
async fn every_preview_route_fails_closed_when_previews_are_off_or_the_broker_cannot_serve_them(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let (viewer_url, label) = f.view(0, &preview_id).await?;
            let requests_before = f.broker.requests.lock().unwrap().len();
            let grants_before = f.count_grants().await?;

            let unconfigured = {
                let mut state = f.state.clone();
                state.config.previews = PreviewSettings::default();
                state
            };
            let no_broker = {
                let mut state = f.state.clone();
                state.tunnel_broker = None;
                state
            };
            // Without the hook secret the broker cannot ask about viewers,
            // so a minted viewer URL could never open.
            let no_hook_secret = {
                let mut state = f.state.clone();
                state.config.tunnel_broker_hook_secret = None;
                state
            };
            let old_broker = {
                let broker = Arc::new(PreviewStubBroker::default());
                *broker.capabilities.lock().unwrap() = Some(TunnelBrokerCapabilities::default());
                let mut state = f.state.clone();
                state.tunnel_broker = Some(broker);
                state
            };
            let other_domain = {
                let broker = Arc::new(PreviewStubBroker::default());
                *broker.capabilities.lock().unwrap() = Some(TunnelBrokerCapabilities {
                    private_previews: true,
                    preview_domain: Some("previews.example".to_string()),
                });
                let mut state = f.state.clone();
                state.tunnel_broker = Some(broker);
                state
            };

            let one = f.path(&format!("/{preview_id}"));
            let mut open = f.open_body(&job, 4190);
            open["conversationId"] = json!(f.conversation);
            let calls = [
                (job.token.clone(), "POST", f.path(""), open),
                (f.tokens[0].clone(), "GET", f.path(""), Value::Null),
                (f.tokens[0].clone(), "GET", one.clone(), Value::Null),
                (job.token.clone(), "POST", format!("{one}/ready"), json!({})),
                (
                    f.tokens[0].clone(),
                    "POST",
                    format!("{one}/view"),
                    json!({}),
                ),
                (
                    f.tokens[0].clone(),
                    "POST",
                    format!("{one}/view/heartbeat"),
                    json!({ "viewerUrl": viewer_url }),
                ),
                (
                    f.tokens[0].clone(),
                    "POST",
                    format!("{one}/view/revoke"),
                    json!({ "viewerUrl": viewer_url }),
                ),
                (job.token.clone(), "POST", format!("{one}/close"), json!({})),
                (
                    f.tokens[0].clone(),
                    "POST",
                    format!("{one}/follow"),
                    json!({ "op": "present" }),
                ),
                (
                    f.tokens[0].clone(),
                    "GET",
                    format!("{one}/follow"),
                    Value::Null,
                ),
                (
                    f.tokens[0].clone(),
                    "GET",
                    format!("{one}/follow/stream"),
                    Value::Null,
                ),
                (
                    f.tokens[0].clone(),
                    "POST",
                    format!("{one}/wake"),
                    json!({}),
                ),
                (
                    HOOK_SECRET.to_string(),
                    "POST",
                    "/tunnel-broker/hooks/preview-auth".to_string(),
                    json!({ "tunnelId": preview_id, "capabilityHash": capability_hash(&label) }),
                ),
            ];
            for (name, state) in [
                ("unconfigured", unconfigured),
                ("no broker", no_broker),
                ("no hook secret", no_hook_secret),
                ("a broker without private previews", old_broker),
                ("a broker serving another domain", other_domain),
            ] {
                let app = router().with_state(state);
                for (token, method, path, body) in &calls {
                    let (status, result) = f
                        .request_on(&app, token, method, path, body.clone())
                        .await?;
                    assert_eq!(
                        status,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "{name}: {method} {path}: {result}"
                    );
                    // The hook itself refuses first when it has no secret to
                    // check the bearer against.
                    let hook_without_secret =
                        name == "no hook secret" && path.starts_with("/tunnel-broker/");
                    if !hook_without_secret {
                        assert_eq!(result["code"], "previews_unavailable", "{name}: {path}");
                    }
                }
            }
            // Nothing reached the broker or the database.
            assert_eq!(f.broker.requests.lock().unwrap().len(), requests_before);
            assert_eq!(f.count_grants().await?, grants_before);
            assert_eq!(f.open_sessions(&preview_id).await?, 1);
            let cards: i64 = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select count(*) from conversation_messages
                     where conversation_id = $1
                       and metadata->'details'->'details' ? 'preview'",
                    &[&f.conversation],
                )
                .await?
                .get(0);
            assert_eq!(cards, 0, "no card was written");
            let wakes: i64 = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select count(*) from runtime_preview_wakes where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?
                .get(0);
            assert_eq!(wakes, 0, "no wake was recorded");
            // Configured again, the same session still works.
            assert!(f.allowed(&preview_id, &label).await?);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_pane_session_lives_on_its_heartbeat_and_a_tab_session_on_its_own_use(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let (viewer_url, label) = f.view(2, &preview_id).await?;
            let hash = capability_hash(&label);
            let db = f.state.pool.get().await?;

            // Requests through the preview (the broker's hook) do not keep a
            // pane's session alive: the label travels in the page's Origin to
            // every third party the site calls, so traffic is not proof that
            // the member is still looking.
            f.age_session(&hash, 2).await?;
            assert!(f.allowed(&preview_id, &label).await?);
            assert!(f.idle_minutes(&hash).await? >= 1.9, "the hook only checks");
            f.age_session(&hash, 31).await?;
            assert!(
                !f.allowed(&preview_id, &label).await?,
                "a pane session whose pane stopped beating idles out, traffic or not"
            );
            f.age_session(&hash, 2).await?;

            // A session for a separate tab has no heartbeat, so its own
            // traffic keeps it alive.
            let (status, tab) = f
                .request(
                    &f.tokens[2],
                    "POST",
                    &f.path(&format!("/{preview_id}/view?tab=true")),
                    json!({}),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{tab}");
            let tab_host = url::Url::parse(tab["viewerUrl"].as_str().context("viewerUrl")?)?
                .host_str()
                .context("host")?
                .to_string();
            let (tab_label, _) = parse_viewer_host(&tab_host).context("tab label")?;
            let tab_hash = capability_hash(&tab_label);
            f.age_session(&tab_hash, 2).await?;
            assert!(f.allowed(&preview_id, &tab_label).await?);
            assert!(
                f.idle_minutes(&tab_hash).await? < 1.0,
                "a tab session is kept by use"
            );

            // The open pane's heartbeat is what keeps its session.
            let heartbeat = f.path(&format!("/{preview_id}/view/heartbeat"));
            let beat = |user: usize, url: String| {
                let heartbeat = heartbeat.clone();
                let f = f.clone();
                async move {
                    let (status, _) = f
                        .request(
                            &f.tokens[user],
                            "POST",
                            &heartbeat,
                            json!({ "viewerUrl": url }),
                        )
                        .await?;
                    anyhow::Ok(status)
                }
            };
            f.age_session(&hash, 29).await?;
            assert_eq!(beat(2, viewer_url.clone()).await?, StatusCode::NO_CONTENT);
            assert!(f.idle_minutes(&hash).await? < 1.0, "the heartbeat keeps it");
            assert!(f.allowed(&preview_id, &label).await?);

            // Someone else's session, or a revoked one, is gone (410).
            assert_eq!(beat(0, viewer_url.clone()).await?, StatusCode::GONE);
            let (status, _) = f
                .request(
                    &f.tokens[2],
                    "POST",
                    &f.path(&format!("/{preview_id}/view/revoke")),
                    json!({ "viewerUrl": viewer_url }),
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert_eq!(beat(2, viewer_url.clone()).await?, StatusCode::GONE);

            // A member removed from the space loses the heartbeat, and with it
            // the session.
            let (member_url, member_label) = f.view(2, &preview_id).await?;
            f.age_session(&capability_hash(&member_label), 2).await?;
            db.execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&f.project, &f.users[2]],
            )
            .await?;
            forget_viewer_access(&f.users[2], &f.project);
            assert_eq!(
                beat(2, member_url).await?,
                StatusCode::GONE,
                "removed member"
            );
            let revoked: bool = db
                .query_one(
                    "select revoked_at is not null from runtime_preview_sessions
                     where capability_hash = $1",
                    &[&capability_hash(&member_label)],
                )
                .await?
                .get(0);
            assert!(revoked, "the removed member's session is revoked");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn viewer_urls_are_minted_at_most_twenty_a_minute_per_person_and_preview(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let view = f.path(&format!("/{preview_id}/view"));
            for _ in 0..20 {
                let (status, body) = f.request(&f.tokens[0], "POST", &view, json!({})).await?;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            let (status, body) = f.request(&f.tokens[0], "POST", &view, json!({})).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            // Another spelling of the same id shares the allowance.
            let parsed = Uuid::parse_str(&preview_id)?;
            for spelling in [
                preview_id.to_ascii_uppercase(),
                parsed.simple().to_string(),
                format!("%7B{preview_id}%7D"),
                parsed.urn().to_string(),
            ] {
                let path = f.path(&format!("/{spelling}/view"));
                let (status, body) = f.request(&f.tokens[0], "POST", &path, json!({})).await?;
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{spelling}: {body}");
            }
            // Another person has their own allowance.
            let (status, body) = f.request(&f.tokens[1], "POST", &view, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn the_retention_prune_deletes_sessions_nobody_can_use() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let mut hashes = Vec::new();
            for _ in 0..4 {
                hashes.push(capability_hash(&f.view(0, &preview_id).await?.1));
            }
            let db = f.state.pool.get().await?;
            // Past the 12 h maximum plus an hour, revoked over an hour ago,
            // revoked just now, and live.
            db.execute(
                "update runtime_preview_sessions set created_at = now() - interval '14 hours'
                 where capability_hash = $1",
                &[&hashes[0]],
            )
            .await?;
            db.execute(
                "update runtime_preview_sessions set revoked_at = now() - interval '2 hours'
                 where capability_hash = $1",
                &[&hashes[1]],
            )
            .await?;
            db.execute(
                "update runtime_preview_sessions set revoked_at = now()
                 where capability_hash = $1",
                &[&hashes[2]],
            )
            .await?;
            let pruned = prune_preview_sessions(&f.state.pool).await?;
            assert!(pruned >= 2, "{pruned}");
            let left: Vec<String> = db
                .query(
                    "select capability_hash from runtime_preview_sessions
                     where tunnel_id = $1 order by capability_hash",
                    &[&preview_id],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            let mut kept = vec![hashes[2].clone(), hashes[3].clone()];
            kept.sort();
            assert_eq!(left, kept);
            Ok(())
        })
    })
    .await
}

/// A grant row as the supersede and broker-revocation tests read it.
struct GrantRow {
    status: String,
    expires_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    metadata: Value,
}

impl Fixture {
    async fn grant_row(&self, tunnel_id: &str) -> anyhow::Result<GrantRow> {
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select status, expires_at, updated_at, metadata
                 from runtime_tunnel_grants where tunnel_id = $1",
                &[&tunnel_id],
            )
            .await?;
        Ok(GrantRow {
            status: row.get("status"),
            expires_at: row.get("expires_at"),
            updated_at: row.get("updated_at"),
            metadata: row.get("metadata"),
        })
    }

    /// `POST /tunnel-broker/hooks/events` as the broker sends it.
    async fn broker_event(&self, payload: Value) -> anyhow::Result<StatusCode> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tunnel-broker/hooks/events")
                    .header("authorization", format!("Bearer {HOOK_SECRET}"))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))?,
            )
            .await?;
        Ok(response.status())
    }

    /// The broker's `tunnel.revoked` event for `tunnel_id` with the expiry the
    /// broker row had when it was revoked.
    fn revoked_event(&self, project: Uuid, tunnel_id: &str, expires_at: DateTime<Utc>) -> Value {
        json!({
            "kind": "tunnel.revoked",
            "project_id": project,
            "data": {
                "tunnel_id": tunnel_id,
                "hostname": format!("{tunnel_id}.rt.localhost"),
                "status": "revoked",
                "token": "",
                "expires_at": expires_at.to_rfc3339(),
                "metadata": { "labels": { "kind": "preview", "visibility": "private" } },
            },
        })
    }
}

/// The grant revocations published since `events` subscribed, by tunnel id.
fn drain_grant_revocations(
    events: &mut tokio::sync::broadcast::Receiver<crate::state::ControllerEvent>,
) -> Vec<String> {
    let mut revoked = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.kind == "tunnel.grant_revoked" {
            revoked.push(
                event.data["tunnelId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        }
    }
    revoked
}

#[test]
fn a_broker_revocation_is_read_only_with_its_tunnel_and_expiry() {
    let tunnel_id = Uuid::new_v4();
    let expires_at = "2026-10-24T20:00:00.123456Z";
    let read = crate::tunnels::BrokerRevokedTunnel::from_event_data(&json!({
        "tunnel_id": tunnel_id.simple().to_string(),
        "expires_at": expires_at,
    }))
    .expect("read");
    assert_eq!(read.tunnel_id, tunnel_id.hyphenated().to_string());
    assert_eq!(
        read.expires_at.to_rfc3339(),
        "2026-10-24T20:00:00.123456+00:00"
    );
    for data in [
        json!({ "tunnel_id": tunnel_id }),
        json!({ "expires_at": expires_at }),
        json!({ "tunnel_id": "not-a-tunnel", "expires_at": expires_at }),
        json!({ "tunnel_id": tunnel_id, "expires_at": "tomorrow" }),
        json!(null),
    ] {
        assert!(
            crate::tunnels::BrokerRevokedTunnel::from_event_data(&data).is_none(),
            "{data}"
        );
    }
}

#[test]
fn a_successor_forgets_only_the_cards_of_the_grant_it_replaced() {
    let mut metadata = json!({
        (PREVIEW_TUNNEL_METADATA_KEY): {
            "messageIds": { "run-a": "card-a", "run-b": "card-b" },
            "messageId": "card-a",
            "title": "Site preview",
        },
    });
    assert!(!forget_preview_cards(
        Some(&mut metadata),
        &["card-z".to_string()]
    ));
    assert!(forget_preview_cards(
        Some(&mut metadata),
        &["card-a".to_string()]
    ));
    assert_eq!(
        metadata[PREVIEW_TUNNEL_METADATA_KEY],
        json!({ "messageIds": { "run-b": "card-b" }, "title": "Site preview" })
    );
    assert_eq!(
        preview_card_ids(Some(&metadata)),
        vec!["card-b".to_string()]
    );
    assert!(!forget_preview_cards(None, &["card-b".to_string()]));
    assert!(!forget_preview_cards(
        Some(&mut json!({})),
        &["card-b".to_string()]
    ));
}

#[tokio::test]
async fn a_reopen_that_gets_another_tunnel_closes_the_grant_it_replaced() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let old_id = f.open(&job).await?;
            let old_card = f.ready(&job.token, &old_id).await?["messageId"].clone();
            let (_, label) = f.view(0, &old_id).await?;
            assert!(f.allowed(&old_id, &label).await?);
            // Another port of the same runtime and a preview on another
            // runtime: neither is replaced.
            let (status, other_port) = f
                .request(&job.token, "POST", &f.path(""), f.open_body(&job, 4174))
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{other_port}");
            let other_port = other_port["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            let elsewhere_job = f.job(None).await?;
            let elsewhere = f.open(&elsewhere_job).await?;

            // The broker retires the key's tunnel and mints another one.
            let key = preview_tunnel_key(&job.runtime_id, 4173);
            let minted = f.broker.remint(&key);
            let mut events = f.state.events.subscribe();
            let next = f.job(Some(&job)).await?;
            let new_id = f.open(&next).await?;
            assert_eq!(new_id, minted.to_string());
            assert_ne!(new_id, old_id);

            let old = f.grant_row(&old_id).await?;
            assert_eq!(old.status, "revoked");
            let preview = &old.metadata[PREVIEW_TUNNEL_METADATA_KEY];
            assert!(preview["closedAt"].is_string(), "{preview}");
            assert_eq!(preview["supersededBy"], json!(new_id));
            assert_eq!(f.open_sessions(&old_id).await?, 0);
            assert!(!f.allowed(&old_id, &label).await?);
            assert_eq!(drain_grant_revocations(&mut events), vec![old_id.clone()]);
            let (status, body) = f
                .request(
                    &f.tokens[0],
                    "GET",
                    &f.path(&format!("/{old_id}")),
                    Value::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["status"], "revoked");
            assert_eq!(body["restartable"], json!(false));

            // The new grant is the preview now, with a card of its own.
            let new = f.grant_row(&new_id).await?;
            assert_eq!(new.status, "active");
            assert_eq!(
                new.metadata[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"],
                json!({})
            );
            let new_card = f.ready(&next.token, &new_id).await?["messageId"].clone();
            assert_ne!(new_card, old_card);

            // Opening again changes nothing more.
            let closed_at = preview["closedAt"].clone();
            let again = f.job(Some(&job)).await?;
            assert_eq!(f.open(&again).await?, new_id);
            let old_again = f.grant_row(&old_id).await?;
            assert_eq!(old_again.updated_at, old.updated_at);
            assert_eq!(
                old_again.metadata[PREVIEW_TUNNEL_METADATA_KEY]["closedAt"],
                closed_at
            );
            assert!(drain_grant_revocations(&mut events).is_empty());

            for untouched in [&other_port, &elsewhere] {
                let grant = f.grant_row(untouched).await?;
                assert_eq!(grant.status, "active", "{untouched}");
                assert!(grant.metadata[PREVIEW_TUNNEL_METADATA_KEY]
                    .get("closedAt")
                    .is_none());
            }
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_wake_that_gets_another_tunnel_leaves_the_old_cards_behind() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let old_id = f.open(&job).await?;
            let old_card = f.ready(&job.token, &old_id).await?["messageId"].clone();
            let key = preview_tunnel_key(&job.runtime_id, 4173);
            let minted = f.broker.remint(&key);

            // A wake reconnects with the preview's stored metadata, cards and all.
            let stored = f.grant_metadata(&old_id).await?;
            let reopened = request_runtime_tunnel_with_overrides(
                &f.state,
                &f.project,
                Some(&job.runtime_id),
                Some(&job.lease_id),
                Some(stored),
                preview_tunnel_overrides(key.clone()),
            )
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
            assert_eq!(reopened.tunnel_id, minted.to_string());
            let copied = f.grant_metadata(&reopened.tunnel_id).await?;
            assert_eq!(
                copied[PREVIEW_TUNNEL_METADATA_KEY]["messageId"], old_card,
                "the wake copied the old card"
            );

            retire_previews_superseded_by(&f.state, &f.project, &key, &reopened.tunnel_id).await;
            let old = f.grant_row(&old_id).await?;
            assert_eq!(old.status, "revoked");
            assert!(old.metadata[PREVIEW_TUNNEL_METADATA_KEY]["closedAt"].is_string());
            let new = f.grant_metadata(&reopened.tunnel_id).await?;
            assert_eq!(new[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"], json!({}));
            assert!(new[PREVIEW_TUNNEL_METADATA_KEY].get("messageId").is_none());
            // So the new preview's first ready writes its own card.
            let next = f.job(Some(&job)).await?;
            assert_eq!(f.open(&next).await?, reopened.tunnel_id);
            let card = f.ready(&next.token, &reopened.tunnel_id).await?["messageId"].clone();
            assert_ne!(card, old_card);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_late_retirement_for_an_older_issue_leaves_the_newer_preview_open() -> anyhow::Result<()>
{
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let old_id = f.open(&job).await?;
            let key = preview_tunnel_key(&job.runtime_id, 4173);
            f.broker.remint(&key);
            let next = f.job(Some(&job)).await?;
            let new_id = f.open(&next).await?;
            assert_ne!(new_id, old_id);
            let new_before = f.grant_row(&new_id).await?;

            // An open or a wake that got the older issue of the key before
            // the broker replaced it, whose retirement only runs now.
            let mut events = f.state.events.subscribe();
            retire_previews_superseded_by(&f.state, &f.project, &key, &old_id).await;

            let new = f.grant_row(&new_id).await?;
            assert_eq!(new.status, "active");
            assert!(new.metadata[PREVIEW_TUNNEL_METADATA_KEY]
                .get("closedAt")
                .is_none());
            assert_eq!(new.updated_at, new_before.updated_at);
            assert!(drain_grant_revocations(&mut events).is_empty());
            let old = f.grant_row(&old_id).await?;
            assert_eq!(
                old.metadata[PREVIEW_TUNNEL_METADATA_KEY]["supersededBy"],
                json!(new_id)
            );
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_wake_that_lands_after_the_open_closed_its_grant_still_leaves_the_old_cards_behind(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let old_id = f.open(&job).await?;
            let old_card = f.ready(&job.token, &old_id).await?["messageId"].clone();
            let stored = f.grant_metadata(&old_id).await?;
            let key = preview_tunnel_key(&job.runtime_id, 4173);
            f.broker.remint(&key);

            // An open gets the new tunnel and closes the old grant first.
            let next = f.job(Some(&job)).await?;
            let new_id = f.open(&next).await?;
            assert!(
                f.grant_row(&old_id).await?.metadata[PREVIEW_TUNNEL_METADATA_KEY]["closedAt"]
                    .is_string()
            );

            // A wake claimed before that close reconnects with the old
            // grant's stored metadata, cards and all, onto the new tunnel.
            let reopened = request_runtime_tunnel_with_overrides(
                &f.state,
                &f.project,
                Some(&job.runtime_id),
                Some(&job.lease_id),
                Some(stored),
                preview_tunnel_overrides(key.clone()),
            )
            .await
            .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
            assert_eq!(reopened.tunnel_id, new_id);
            assert_eq!(
                f.grant_metadata(&new_id).await?[PREVIEW_TUNNEL_METADATA_KEY]["messageId"],
                old_card,
                "the wake copied the old card"
            );

            // Nothing is left to close, but the old cards are still dropped.
            retire_previews_superseded_by(&f.state, &f.project, &key, &new_id).await;
            let new = f.grant_metadata(&new_id).await?;
            assert!(new[PREVIEW_TUNNEL_METADATA_KEY].get("messageId").is_none());
            let ids = new[PREVIEW_TUNNEL_METADATA_KEY]["messageIds"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            assert!(ids.values().all(|id| *id != old_card), "{ids:?}");
            // The wake also brought the old job's marker back; the next open
            // writes the preview's own metadata again, and its ready a card.
            let again = f.job(Some(&job)).await?;
            assert_eq!(f.open(&again).await?, new_id);
            let card = f.ready(&again.token, &new_id).await?["messageId"].clone();
            assert_ne!(card, old_card);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_broker_revocation_event_stops_only_the_issue_of_the_grant_it_names() -> anyhow::Result<()>
{
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let (_, label) = f.view(0, &preview_id).await?;
            let (status, other) = f
                .request(&job.token, "POST", &f.path(""), f.open_body(&job, 4174))
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{other}");
            let other = other["previewId"].as_str().context("previewId")?.to_string();
            let issued = f.grant_row(&preview_id).await?;
            let other_before = f.grant_row(&other).await?;

            // Unknown tunnels, other projects and events that cannot name
            // the issue they are about change nothing.
            let mut events = f.state.events.subscribe();
            for event in [
                f.revoked_event(f.project, &Uuid::new_v4().to_string(), issued.expires_at),
                f.revoked_event(Uuid::new_v4(), &preview_id, issued.expires_at),
                json!({
                    "kind": "tunnel.revoked",
                    "project_id": f.project,
                    "data": { "tunnel_id": preview_id },
                }),
                json!({
                    "kind": "tunnel.expired",
                    "project_id": f.project,
                    "data": { "tunnel_id": preview_id, "expires_at": issued.expires_at.to_rfc3339() },
                }),
            ] {
                assert_eq!(f.broker_event(event).await?, StatusCode::OK);
            }
            assert_eq!(f.grant_row(&preview_id).await?.status, "active");
            assert!(f.allowed(&preview_id, &label).await?);
            assert!(drain_grant_revocations(&mut events).is_empty());

            // The revocation of this issue stops the grant, as a runtime stop does.
            let revoked = f.revoked_event(f.project, &preview_id, issued.expires_at);
            assert_eq!(f.broker_event(revoked.clone()).await?, StatusCode::OK);
            let stopped = f.grant_row(&preview_id).await?;
            assert_eq!(stopped.status, "revoked");
            assert_eq!(f.open_sessions(&preview_id).await?, 0);
            assert!(!f.allowed(&preview_id, &label).await?);
            assert!(
                stopped.metadata[PREVIEW_TUNNEL_METADATA_KEY]
                    .get("closedAt")
                    .is_none(),
                "stopped, not closed: it may be opened again"
            );
            assert_eq!(drain_grant_revocations(&mut events), vec![preview_id.clone()]);

            // A duplicate is a no-op.
            assert_eq!(f.broker_event(revoked.clone()).await?, StatusCode::OK);
            assert_eq!(f.grant_row(&preview_id).await?.updated_at, stopped.updated_at);
            assert!(drain_grant_revocations(&mut events).is_empty());

            // Re-opened, the broker refreshes the same tunnel with a later
            // expiry. The old revocation arriving late leaves it serving.
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let next = f.job(Some(&job)).await?;
            assert_eq!(f.open(&next).await?, preview_id);
            let reopened = f.grant_row(&preview_id).await?;
            assert_eq!(reopened.status, "active");
            assert!(reopened.expires_at > issued.expires_at);
            assert_eq!(f.broker_event(revoked).await?, StatusCode::OK);
            assert_eq!(f.grant_row(&preview_id).await?.status, "active");
            assert!(drain_grant_revocations(&mut events).is_empty());

            let other_after = f.grant_row(&other).await?;
            assert_eq!(other_after.status, "active");
            assert_eq!(other_after.updated_at, other_before.updated_at);
            Ok(())
        })
    })
    .await
}
