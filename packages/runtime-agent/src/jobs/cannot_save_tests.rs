//! A turn that must write the space's files ends before its model runs when
//! the controller refuses its job the workspace lease (`turn_that_cannot_save`).
//! Here a whole hand-back job runs: the controller signs its workspace token
//! and then refuses it the lease, and every request its model would send goes
//! to an endpoint that records it.

use super::tests::{test_job_processor, test_lease_job, test_origin_settings};
use super::*;
use axum::extract::{OriginalUri, State};
use axum::response::IntoResponse;
use axum::{Json, Router, routing::get, routing::post};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_contracts::AccessTokenClaims;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

const KEY_ID: &str = "cannot-save-test";

/// What the controller and the model were asked.
#[derive(Default)]
struct Asked {
    leases: StdMutex<Vec<String>>,
    others: StdMutex<Vec<String>>,
}

/// A controller whose JWKS signs the job's workspace token and which refuses
/// that job the workspace lease, as it refused a hand-back sent with no write
/// intent. It also stands in for the model: the job's model requests go to
/// it (the runtime's proxy envelope), and it records every path it is asked
/// besides those two.
struct RefusingController {
    encoding_key: EncodingKey,
    url: reqwest::Url,
    asked: Arc<Asked>,
    server: tokio::task::JoinHandle<()>,
}

impl RefusingController {
    async fn start() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .expect("generate disposable controller signing key");
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse signing key");
        let jwks = json!({ "keys": [{
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "kid": KEY_ID, "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        }] });
        let asked = Arc::new(Asked::default());
        let app = Router::new()
            .route(
                "/.well-known/jwks.json",
                get(move || {
                    let jwks = jwks.clone();
                    async move { Json(jwks) }
                }),
            )
            .route(
                "/lease/acquire",
                post(|State(asked): State<Arc<Asked>>, body: String| async move {
                    asked.leases.lock().unwrap().push(body);
                    (
                        axum::http::StatusCode::FORBIDDEN,
                        Json(
                            json!({ "message": "this job is not allowed to write the workspace" }),
                        ),
                    )
                }),
            )
            .fallback(
                |State(asked): State<Arc<Asked>>, OriginalUri(uri): OriginalUri| async move {
                    asked.others.lock().unwrap().push(uri.path().to_string());
                    (
                        axum::http::StatusCode::UNAUTHORIZED,
                        Json(json!({ "error": { "message": "nothing answers here" } })),
                    )
                        .into_response()
                },
            )
            .with_state(Arc::clone(&asked));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the disposable controller");
        let address = listener.local_addr().expect("controller address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve the controller");
        });
        Self {
            encoding_key: EncodingKey::from_ed_der(pkcs8.as_ref()),
            url: reqwest::Url::parse(&format!("http://{address}/")).unwrap(),
            asked,
            server,
        }
    }

    /// A workspace token for `run` of `project` on `runtime`, with the scopes
    /// a job that may write is leased with.
    fn workspace_token(&self, project: Uuid, runtime: Uuid, run: Uuid) -> String {
        let issued_at = Utc::now().timestamp();
        let claims = AccessTokenClaims {
            aud: runtime.to_string(),
            sub: "job:cannot-save".to_string(),
            project_id: project.to_string(),
            origin_id: None,
            runtime_id: Some(runtime.to_string()),
            protocol: None,
            scopes: vec![
                WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
                ORIGIN_TOKEN_MINT_SCOPE.to_string(),
            ],
            lease_id: None,
            runtime_generation: None,
            run_id: Some(run.to_string()),
            iat: issued_at,
            exp: issued_at + 300,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(KEY_ID.to_string());
        jsonwebtoken::encode(&header, &claims, &self.encoding_key)
            .expect("sign the workspace token")
    }
}

impl Drop for RefusingController {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// A hand-back builds what the person asked, so it must write the space's
/// files. Its job may not save them: the refresh before the turn was refused
/// the workspace lease. The job ends with the plain notice and the refresh's
/// record before any request reaches its model, rather than a run that makes
/// the page and loses it at the save.
#[test]
fn a_hand_back_whose_lease_is_refused_ends_before_its_model_runs() {
    // `run_apply_job` needs a runtime-sized stack, as in production.
    const STACK_SIZE: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .stack_size(STACK_SIZE)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK_SIZE)
                .build()
                .unwrap()
                .block_on(hand_back_whose_lease_is_refused())
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn hand_back_whose_lease_is_refused() {
    let controller = RefusingController::start().await;
    let tmp = tempfile::tempdir().expect("temp dir");
    let base = test_job_processor(tmp.path());
    let mut config = (*base.config).clone();
    config.controller_base_url = controller.url.clone();
    config.controller_jwks_url = controller.url.join("/.well-known/jwks.json").unwrap();
    config.origin = Some(test_origin_settings(Some("http://127.0.0.1:9/project.git")));
    let processor = JobProcessor::new(Arc::new(config));
    let refreshed = Arc::new(AtomicUsize::new(0));
    let refreshes = Arc::clone(&refreshed);
    processor.set_local_origin_sync(Some(LocalOriginSync {
        origin_id: Uuid::new_v4(),
        endpoint: "http://127.0.0.1:9".to_string(),
        read_only_refresh: Some(crate::origin::ReadOnlyRefresh::new(move || {
            refreshes.fetch_add(1, Ordering::SeqCst);
            async move { Ok(json!({ "rev": "main", "checkoutMoved": false })) }
        })),
        working_state: None,
    }));

    let mut registration = super::tests::test_registration_with_proxy();
    // The model's requests would go here, and be recorded.
    registration.proxy = Some(ProxyEnvelopePayload {
        url: controller.url.as_str().trim_end_matches('/').to_string(),
        token: "inert-model-token".to_string(),
        expires_at: None,
    });
    let request = "Put the opening hours on a small page I can share.";
    let mut job = test_lease_job(
        Some("feature"),
        json!({
            "prompt_text": "Continue building with what the browser turn found.",
            "metadata": {
                "writeIntent": true,
                "browserHandBack": {
                    "version": 1,
                    "verified": true,
                    "buildRequest": true,
                    "browserJobId": Uuid::new_v4(),
                    "cardJobId": Uuid::new_v4(),
                    "viewer": "Instafy's browser in the workspace",
                    "request": request,
                    "personRequest": request,
                    "reply": "",
                    "findings": [],
                },
            },
        }),
    );
    let run = Uuid::new_v4();
    job.run_id = Some(run);
    job.conversation_id = Some(Uuid::new_v4());
    job.workspace_token =
        Some(controller.workspace_token(job.project_id.unwrap(), registration.runtime_id, run));
    job.workspace_token_scopes = Some(vec![
        WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
        ORIGIN_TOKEN_MINT_SCOPE.to_string(),
    ]);

    let error = tokio::time::timeout(
        Duration::from_secs(60),
        processor.run_apply_job(&registration, &job, true, None, None, None),
    )
    .await
    .expect("the job ends")
    .err()
    .expect("a turn that must write where it may not save fails");

    assert_eq!(
        extract_job_failure_message(&error),
        Some(CANNOT_SAVE_BEFORE_TURN_FAILURE),
        "{error:#}"
    );
    let artifacts = extract_job_failure_artifacts(&error).expect("the refresh's record");
    assert!(
        artifacts
            .iter()
            .any(|artifact| artifact["kind"] == "origin/refresh"
                && artifact["metadata"]["mode"] == "read_only"),
        "{artifacts:?}"
    );
    assert_eq!(controller.asked.leases.lock().unwrap().len(), 1);
    assert_eq!(refreshed.load(Ordering::SeqCst), 1);
    assert_eq!(
        *controller.asked.others.lock().unwrap(),
        Vec::<String>::new(),
        "nothing reached the model"
    );
}
