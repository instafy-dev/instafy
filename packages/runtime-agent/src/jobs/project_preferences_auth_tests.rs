use super::tests::{test_job_processor, test_lease_job, test_registration_with_proxy};
use super::*;
use axum::{Json, Router, routing::get};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_contracts::AccessTokenClaims;

struct SignedControllerFixture {
    encoding_key: EncodingKey,
    jwks_url: reqwest::Url,
    server: tokio::task::JoinHandle<()>,
}

impl SignedControllerFixture {
    async fn start() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .expect("generate disposable controller signing key");
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse signing key");
        let jwks = json!({ "keys": [{
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "kid": "project-preferences-test", "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        }] });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind disposable JWKS server");
        let address = listener.local_addr().expect("JWKS address");
        let app = Router::new().route(
            "/jwks",
            get(move || {
                let jwks = jwks.clone();
                async move { Json(jwks) }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve JWKS");
        });
        Self {
            encoding_key: EncodingKey::from_ed_der(pkcs8.as_ref()),
            jwks_url: reqwest::Url::parse(&format!("http://{address}/jwks")).unwrap(),
            server,
        }
    }

    fn token(&self, project: Uuid, runtime: Uuid, run: Uuid, subject: &str) -> String {
        let issued_at = Utc::now().timestamp();
        let claims = AccessTokenClaims {
            aud: runtime.to_string(),
            sub: subject.to_string(),
            project_id: project.to_string(),
            origin_id: None,
            runtime_id: Some(runtime.to_string()),
            protocol: None,
            scopes: vec!["prompt.execute".to_string()],
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
        header.kid = Some("project-preferences-test".to_string());
        jsonwebtoken::encode(&header, &claims, &self.encoding_key).expect("sign controller token")
    }
}

impl Drop for SignedControllerFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn project_preferences_reject_wrong_project_before_direct_worker_workspace_access() {
    let fixture = SignedControllerFixture::start().await;
    let temp = tempfile::tempdir().expect("temporary workspaces");
    let mut processor = test_job_processor(temp.path());
    processor.controller_tokens = ControllerTokenVerifier::new(fixture.jwks_url.clone());
    let mut registration = test_registration_with_proxy();
    // Scope rejection must precede even proxy setup, so this cannot contact a model.
    registration.proxy = None;
    let mut job = test_lease_job(
        Some("apply"),
        json!({ "prompt_text": "Review my project." }),
    );
    let run = Uuid::new_v4();
    job.run_id = Some(run);
    job.controller_token = Some(fixture.token(
        Uuid::new_v4(),
        registration.runtime_id,
        run,
        "user:authorized-in-other-project",
    ));
    let workspace = processor
        .config
        .project_workspace_dir(&job.project_id.unwrap());

    let error = processor
        .run_parallel_direct_write_scoped_worker_job(&registration, &job, None, None)
        .await
        .err()
        .expect("mismatched signed scope must fail");

    assert_eq!(error.to_string(), "controller token project scope mismatch");
    assert!(
        !workspace.exists(),
        "scope rejection must precede workspace preparation"
    );
}

#[tokio::test]
async fn project_preferences_are_shared_by_verified_project_members_without_env_mutation() {
    const CHILD_MARKER: &str = "INSTAFY_PROJECT_PREFERENCES_AUTH_TEST_CHILD";
    const TEST_NAME: &str = "jobs::project_preferences_auth_tests::project_preferences_are_shared_by_verified_project_members_without_env_mutation";
    // As in the existing controller guard test, isolate assertions about global
    // credentials from unrelated tests that mutate their process environment.
    if env::var_os(CHILD_MARKER).is_none() {
        let output = std::process::Command::new(env::current_exe().expect("test executable"))
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD_MARKER, "1")
            .env("CONTROLLER_ACCESS_TOKEN", "unrelated-controller-token")
            .env("CODEX_API_KEY", "unrelated-proxy-token")
            .output()
            .expect("run isolated claims verification test");
        assert!(
            output.status.success(),
            "isolated auth test failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let fixture = SignedControllerFixture::start().await;
    let temp = tempfile::tempdir().expect("temporary workspaces");
    let mut processor = test_job_processor(temp.path());
    processor.controller_tokens = ControllerTokenVerifier::new(fixture.jwks_url.clone());
    let registration = test_registration_with_proxy();
    let mut job = test_lease_job(
        Some("apply"),
        json!({ "prompt_text": "Explain the project." }),
    );
    let project = job.project_id.unwrap();
    let run = Uuid::new_v4();
    job.run_id = Some(run);
    let workspace = processor
        .prepare_workspace(&project)
        .expect("shared workspace");
    fs::write(
        workspace.join("INSTAFY.md"),
        "## Project preferences\nShared default: keep explanations concise.\n",
    )
    .expect("shared preference");

    for subject in ["user:first-project-member", "user:second-project-member"] {
        job.controller_token = Some(fixture.token(project, registration.runtime_id, run, subject));
        let claims = processor
            .verified_controller_claims(&registration, &job)
            .await
            .expect("verify signed project scope")
            .expect("controller claims");
        assert_eq!(claims.sub, subject);
        let (prompt, _, _) = processor
            .build_prompt_with_text(
                &project,
                &job,
                &workspace,
                "Explain the project.",
                false,
                None,
                &[],
                None,
                None,
            )
            .expect("project-scoped prompt");
        assert!(prompt.contains("Shared default: keep explanations concise."));
    }
    assert_eq!(
        env::var("CONTROLLER_ACCESS_TOKEN").as_deref(),
        Ok("unrelated-controller-token")
    );
    assert_eq!(
        env::var("CODEX_API_KEY").as_deref(),
        Ok("unrelated-proxy-token")
    );
}
