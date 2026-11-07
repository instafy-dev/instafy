use super::*;
use axum::body::Body;
use futures_util::stream;

fn search_reply() -> Value {
    json!({"output":"Found the source: https://example.org/source", "encrypted_output":"opaque:unchanged", "results":[{"type":"text_result","ref_id":"turn0search0","url":"https://example.org/source","future":{"preserved":true}}], "future_top_level":true})
}

struct Dropped(Arc<AtomicUsize>);
impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) async fn upstream_search_stub(
    State(stub): State<UpstreamStub>,
    headers: HeaderMap,
    AxumJson(payload): AxumJson<Value>,
) -> axum::response::Response {
    let bearer = record_upstream_request(&stub, &headers, &payload);
    assert_eq!(bearer, format!("Bearer {BYO_CHATGPT_STUB_TOKEN}"));
    assert_eq!(headers["chatgpt-account-id"], "chatgpt-account-stub");
    if let Some((status, body)) = next_canned_response(&stub) {
        return (status, AxumJson(body)).into_response();
    }
    if stub.hold_search_body.load(Ordering::SeqCst) {
        let chunks = stream::unfold(
            (
                0,
                stub.search_body_gate.clone(),
                Dropped(stub.search_body_dropped.clone()),
            ),
            |(step, gate, dropped)| async move {
                match step {
                    0 => Some((Ok::<_, std::io::Error>("{\"output\":"), (1, gate, dropped))),
                    1 => {
                        gate.notified().await;
                        Some((Ok("\"done\"}"), (2, gate, dropped)))
                    }
                    _ => None,
                }
            },
        );
        return Body::from_stream(chunks).into_response();
    }
    AxumJson(search_reply()).into_response()
}

fn grant(credential: Option<&str>, enabled: bool, bound: bool) -> String {
    let mut claims = json!({"aud":"proxy","iss":"runtime-controller","project_id":"11111111-1111-4111-8111-111111111111","runtime_id":"22222222-2222-4222-8222-222222222222","run_id":RUN_ID,"credential_id":credential,"native_web_search":enabled,"exp":chrono::Utc::now().timestamp()+300});
    if bound {
        claims["job_id"] = json!("77777777-7777-4777-8777-777777777777");
        claims["lease_attempt"] = json!(1);
    }
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(SIGNING_SECRET.as_bytes()),
    )
    .unwrap()
}
fn request() -> Value {
    json!({"id":"session-ref","model":"gpt-6-luna","commands":{"search_query":[{"q":"native contract","domains":["example.org"]}],"open":[{"ref_id":"turn0search0"}]},"settings":{"external_web_access":true,"filters":{"allowed_domains":["example.org"]}},"input":[{"role":"user","type":"message","content":[{"type":"input_text","text":"visible question"}]}],"max_output_tokens":8192})
}

#[tokio::test]
#[serial]
async fn native_search_forwards_the_typed_contract_with_controller_owned_auth() -> Result<()> {
    let (addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;
    let token = grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, true);
    let response = reqwest::Client::new()
        .post(format!("http://{addr}/v1/alpha/search"))
        .bearer_auth(token)
        .header("ChatGPT-Account-Id", "spoofed-account")
        .header("x-upstream-url", "https://attacker.invalid")
        .json(&request())
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await?, search_reply());
    assert_eq!(*upstream.bodies.lock().unwrap(), vec![request()]);
    assert!(
        upstream.headers.lock().unwrap()[0]
            .get("x-upstream-url")
            .is_none()
    );
    assert_eq!(controller.leases.lock().unwrap().len(), 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn native_search_refuses_untrusted_or_wrong_account_lanes_before_provider_use() -> Result<()>
{
    for proxy in [
        StackProxy::Dynamic,
        StackProxy::Static { pinned_model: None },
        StackProxy::StaticChatGpt { pinned_model: None },
    ] {
        let (addr, controller, upstream, _env, _guards) =
            spawn_stack(Some(MANAGED_STUB_KEY), None, false, proxy).await?;
        for token in [
            grant(None, true, true),
            grant(Some(MANAGED_AI_CREDENTIAL_ID), true, true),
            grant(Some(BYO_CHATGPT_CREDENTIAL_ID), false, true),
            grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, false),
        ] {
            let (status, _) =
                post_through_proxy(addr, &token, "/v1/alpha/search", request()).await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
        let allowed = grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, true);
        for field in ["id", "model"] {
            for invalid in [Value::Null, json!(" "), json!(42)] {
                let mut payload = request();
                payload[field] = invalid;
                let (status, _) =
                    post_through_proxy(addr, &allowed, "/v1/alpha/search", payload).await?;
                assert_eq!(status, StatusCode::BAD_REQUEST);
            }
        }
        assert!(
            controller.leases.lock().unwrap().is_empty(),
            "non-capable grants and invalid requests must not acquire credentials"
        );
        let (status, _) = post_through_proxy(
            addr,
            &grant(Some(BYO_CREDENTIAL_ID), true, true),
            "/v1/alpha/search",
            request(),
        )
        .await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(upstream.bodies.lock().unwrap().is_empty());
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn native_search_redacts_provider_errors_and_refreshes_only_expired_auth_once() -> Result<()>
{
    let (addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(None, None, false).await?;
    let token = grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, true);
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        upstream.respond_next.lock().unwrap().push_back((
            status,
            json!({"error":{"message":"private-query private-account secret-token"}}),
        ));
        let before = upstream.bodies.lock().unwrap().len();
        let (got, body) = post_through_proxy(addr, &token, "/v1/alpha/search", request()).await?;
        assert_eq!(got, status);
        assert!(!body.contains("private-") && !body.contains("secret-token"));
        assert_eq!(
            upstream.bodies.lock().unwrap().len(),
            before + 1,
            "proxy must not silently retry"
        );
    }
    let expired = json!({"error":{"code":"token_expired","message":"Your authentication token has expired."}});
    upstream
        .respond_next
        .lock()
        .unwrap()
        .push_back((StatusCode::UNAUTHORIZED, expired.clone()));
    let (status, body) = post_through_proxy(addr, &token, "/v1/alpha/search", request()).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        controller.leases.lock().unwrap().len(),
        2,
        "initial lease plus one controller renewal"
    );
    upstream.respond_next.lock().unwrap().extend([
        (StatusCode::UNAUTHORIZED, expired.clone()),
        (StatusCode::UNAUTHORIZED, expired),
    ]);
    let before = upstream.bodies.lock().unwrap().len();
    let (status, _) = post_through_proxy(addr, &token, "/v1/alpha/search", request()).await?;
    assert!(!status.is_success());
    assert_eq!(upstream.bodies.lock().unwrap().len(), before + 2);
    Ok(())
}

#[tokio::test]
#[serial]
async fn native_search_bounds_bytes_and_cancels_upstream_when_caller_drops_body() -> Result<()> {
    let (addr, _controller, upstream, _env, _guards) =
        spawn_managed_stack(None, None, false).await?;
    let token = grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, true);
    {
        let _limit = EnvGuard::set("PROXY_MODEL_MAX_RESPONSE_BYTES", Some("32"));
        let (status, body) =
            post_through_proxy(addr, &token, "/v1/alpha/search", request()).await?;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("upstream_response_too_large"));
    }
    upstream.hold_search_body.store(true, Ordering::SeqCst);
    for (key, limit) in [
        ("PROXY_MODEL_MAX_RESPONSE_BYTES", "4"),
        ("PROXY_MODEL_READ_TIMEOUT_MS", "40"),
    ] {
        let _limit = EnvGuard::set(key, Some(limit));
        let before = upstream.search_body_dropped.load(Ordering::SeqCst);
        let attempts_before = upstream.bodies.lock().unwrap().len();
        // A rejected first chunk can close the response before headers flush.
        // Both that and a later body failure must bound the entire exchange.
        assert!(
            tokio::time::timeout(Duration::from_secs(2), async {
                reqwest::Client::new()
                    .post(format!("http://{addr}/v1/alpha/search"))
                    .bearer_auth(&token)
                    .json(&request())
                    .send()
                    .await?
                    .bytes()
                    .await
            })
            .await?
            .is_err()
        );
        assert_eq!(upstream.bodies.lock().unwrap().len(), attempts_before + 1);
        tokio::time::timeout(Duration::from_secs(2), async {
            while upstream.search_body_dropped.load(Ordering::SeqCst) <= before {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
    }
    let before = upstream.search_body_dropped.load(Ordering::SeqCst);
    let mut response = reqwest::Client::new()
        .post(format!("http://{addr}/v1/alpha/search"))
        .bearer_auth(&token)
        .json(&request())
        .send()
        .await?;
    assert!(response.chunk().await?.is_some());
    drop(response);
    tokio::time::timeout(Duration::from_secs(3), async {
        while upstream.search_body_dropped.load(Ordering::SeqCst) <= before {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}
