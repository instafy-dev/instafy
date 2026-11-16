//! Native search for managed runs (`PROXY_MANAGED_NATIVE_WEB_SEARCH`): a
//! static ChatGPT login passes codex's request through, and an API key gets
//! OpenAI's hosted search through the search bridge. Every provider answer
//! here is a recorded fixture; nothing leaves the machine.

use super::native_search_tests::{grant, request};
use super::*;

/// A Responses API answer to one hosted search, as OpenAI documents it.
const WEB_SEARCH_ANSWER: &str = include_str!("../fixtures/responses_web_search.json");

fn web_search_answer() -> Value {
    serde_json::from_str(WEB_SEARCH_ANSWER).expect("fixture is JSON")
}

/// A managed run's search token: a run and no credential of its own.
fn managed_grant(enabled: bool, bound: bool) -> String {
    grant(None, enabled, bound)
}

/// Codex's `web.run` request for Luna: two queries, one holding the
/// person's e-mail address, a page to open, and the chat's tail, which
/// codex attaches and which also holds it.
fn luna_search() -> Value {
    json!({
        "id": "session-ref",
        "model": "gpt-6-luna",
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "My email is ana@example.com. How heavy is the Example Reader 7?"}]}],
        "commands": {
            "search_query": [
                {"q": "Example Reader 7 weight", "domains": ["example.com"]},
                {"q": "Example Reader 7 review ana@example.com"}
            ],
            "open": [{"ref_id": "turn0search0"}]
        },
        "settings": {"allowed_callers": ["direct"], "external_web_access": true},
        "max_output_tokens": 10000
    })
}

async fn spawn_search_stack(proxy: StackProxy<'_>, switch: Option<&str>) -> Result<Stack> {
    spawn_stack_with_settings(
        Some(MANAGED_STUB_KEY),
        Some(PINNED_MODEL),
        false,
        proxy,
        &[("PROXY_MANAGED_NATIVE_WEB_SEARCH", switch)],
    )
    .await
}

/// The bodies the model stub's Responses endpoint got.
fn responses_requests(upstream: &UpstreamStub) -> Vec<Value> {
    upstream
        .bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|body| body.get("commands").is_none())
        .cloned()
        .collect()
}

#[tokio::test]
#[serial]
async fn managed_search_stays_off_until_the_proxy_switch_is_on() -> Result<()> {
    for proxy in [
        StackProxy::Dynamic,
        StackProxy::Static { pinned_model: None },
        StackProxy::StaticChatGpt { pinned_model: None },
    ] {
        for switch in [None, Some("0"), Some("off")] {
            let (addr, controller, upstream, _env, _guards) =
                spawn_search_stack(proxy, switch).await?;
            let (status, body) = post_through_proxy(
                addr,
                &managed_grant(true, true),
                "/v1/alpha/search",
                luna_search(),
            )
            .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert!(body.contains("native_web_search_unavailable"), "{body}");
            assert!(controller.leases.lock().unwrap().is_empty());
            assert!(upstream.bodies.lock().unwrap().is_empty());
        }
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_search_on_an_api_key_runs_hosted_search_on_the_platform_key() -> Result<()> {
    let (addr, controller, upstream, _env, _guards) =
        spawn_search_stack(StackProxy::Dynamic, Some("1")).await?;
    upstream.respond_next.lock().unwrap().extend([
        (StatusCode::OK, web_search_answer()),
        (StatusCode::OK, web_search_answer()),
    ]);
    let (status, body) = post_through_proxy(
        addr,
        &managed_grant(true, true),
        "/v1/alpha/search",
        luna_search(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Codex's SearchResponse (codex-rs/codex-api/src/search.rs): `output`, a
    // string, `encrypted_output`, and `results`, a list.
    let answer: Value = serde_json::from_str(&body)?;
    let mut fields = answer
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    fields.sort();
    assert_eq!(fields, ["encrypted_output", "output", "results"]);
    assert_eq!(answer["encrypted_output"], Value::Null);
    let output = answer["output"].as_str().expect("output is text");
    for told in [
        "2 queries sent to the search provider.",
        "Query 1: \"Example Reader 7 weight\"\n<untrusted_page_content viewer=\"provider search\" read_at=\"",
        "The Example Reader 7 weighs 174 g",
        "- Example Reader 7 | Example Store: https://www.example.com/readers/reader-7?utm_source=openai",
        "Query 2: \"Example Reader 7 review\"\nRemoved before searching: an e-mail address.",
        "Not run here: open.",
    ] {
        assert!(output.contains(told), "{told}\n---\n{output}");
    }
    assert_eq!(
        answer["results"],
        json!([
            {"type": "text_result", "url": "https://www.example.com/readers/reader-7?utm_source=openai", "title": "Example Reader 7 | Example Store"},
            {"type": "text_result", "url": "https://reviews.example.org/reader-7-review?utm_source=openai", "title": "Example Reader 7 review"},
        ])
    );

    // One hosted search per query, on the platform key, as the pinned
    // model, bounded to one search call, with only the cleaned query.
    let sent = responses_requests(&upstream);
    assert_eq!(sent.len(), 2);
    assert_eq!(
        *upstream.bearers.lock().unwrap(),
        vec![format!("Bearer {MANAGED_STUB_KEY}"); 2]
    );
    let mut queries = Vec::new();
    for body in &sent {
        assert_eq!(body["model"], PINNED_MODEL);
        assert_eq!(body["tool_choice"], "required");
        assert_eq!(body["max_tool_calls"], 1);
        assert_eq!(body["store"], false);
        assert_eq!(body["reasoning"], json!({"effort": "low"}));
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        let text = body["input"][0]["content"][0]["text"].as_str().unwrap();
        let tools = if text == "Example Reader 7 weight" {
            json!([{"type": "web_search", "filters": {"allowed_domains": ["example.com"]}}])
        } else {
            json!([{"type": "web_search"}])
        };
        assert_eq!(body["tools"], tools, "{text}");
        assert!(!body.to_string().contains("ana@example.com"));
        assert!(!body.to_string().contains("My email"));
        queries.push(text.to_string());
    }
    queries.sort();
    assert_eq!(
        queries,
        ["Example Reader 7 review", "Example Reader 7 weight"]
    );
    // Nothing went to a ChatGPT search endpoint, and the platform credential
    // was leased once.
    assert_eq!(
        controller
            .leases
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        [MANAGED_AI_CREDENTIAL_ID]
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_search_on_a_static_chatgpt_login_searches_each_clean_query_as_the_pinned_model()
-> Result<()> {
    let (addr, controller, upstream, _env, _guards) = spawn_search_stack(
        StackProxy::StaticChatGpt {
            pinned_model: Some(PINNED_MODEL),
        },
        Some("on"),
    )
    .await?;
    let mut asked = luna_search();
    asked["model"] = json!("gpt-5.6-sol");
    let (status, body) =
        post_through_proxy(addr, &managed_grant(true, true), "/v1/alpha/search", asked).await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // One search a query on the login's own search endpoint, as the pinned
    // model, with only the cleaned query: not the chat's recent messages,
    // and no page to open.
    let mut sent = upstream.bodies.lock().unwrap().clone();
    sent.sort_by_key(|body| body["commands"]["search_query"][0]["q"].to_string());
    let settings = json!({"allowed_callers": ["direct"], "external_web_access": true});
    assert_eq!(
        sent,
        vec![
            json!({"id": "session-ref", "model": PINNED_MODEL, "commands": {"search_query": [{"q": "Example Reader 7 review"}]}, "settings": settings, "max_output_tokens": 8192}),
            json!({"id": "session-ref", "model": PINNED_MODEL, "commands": {"search_query": [{"q": "Example Reader 7 weight", "domains": ["example.com"]}]}, "settings": settings, "max_output_tokens": 8192}),
        ]
    );
    assert_eq!(
        *upstream.bearers.lock().unwrap(),
        vec![format!("Bearer {MANAGED_STUB_KEY}"); 2]
    );
    assert!(controller.leases.lock().unwrap().is_empty());

    // What the login's search wrote comes back inside the wrapper, with what
    // was removed and what was not run.
    let answer: Value = serde_json::from_str(&body)?;
    let output = answer["output"].as_str().expect("output is text");
    for told in [
        "2 queries sent to the search provider.",
        "Query 1: \"Example Reader 7 weight\"\n<untrusted_page_content viewer=\"provider search\" read_at=\"",
        "Found the source: https://example.org/source",
        "Query 2: \"Example Reader 7 review\"\nRemoved before searching: an e-mail address.",
        "Not run here: open.",
    ] {
        assert!(output.contains(told), "{told}\n---\n{output}");
    }
    assert_eq!(output.matches("</untrusted_page_content>").count(), 2);
    assert!(!output.contains("ana@example.com"));
    assert_eq!(answer["encrypted_output"], Value::Null);
    assert_eq!(
        answer["results"],
        json!([{"type": "text_result", "url": "https://example.org/source", "title": null}])
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_search_needs_the_job_grant_and_leaves_own_credentials_as_they_are() -> Result<()> {
    let (addr, _controller, upstream, _env, _guards) =
        spawn_search_stack(StackProxy::Dynamic, Some("1")).await?;
    for token in [
        managed_grant(false, true),
        managed_grant(true, false),
        // A person's own API key gets no search, switch or not.
        grant(Some(BYO_CREDENTIAL_ID), true, true),
    ] {
        let (status, body) =
            post_through_proxy(addr, &token, "/v1/alpha/search", luna_search()).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    assert!(upstream.bodies.lock().unwrap().is_empty());
    // A person's own ChatGPT login still passes through unchanged.
    let (status, body) = post_through_proxy(
        addr,
        &grant(Some(BYO_CHATGPT_CREDENTIAL_ID), true, true),
        "/v1/alpha/search",
        request(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(*upstream.bodies.lock().unwrap(), vec![request()]);
    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_search_sends_no_query_that_looks_like_a_key() -> Result<()> {
    for proxy in [
        StackProxy::Dynamic,
        StackProxy::StaticChatGpt {
            pinned_model: Some(PINNED_MODEL),
        },
    ] {
        sends_no_query_that_looks_like_a_key(proxy).await?;
    }
    Ok(())
}

async fn sends_no_query_that_looks_like_a_key(proxy: StackProxy<'_>) -> Result<()> {
    let (addr, _controller, upstream, _env, _guards) = spawn_search_stack(proxy, Some("1")).await?;
    let mut asked = luna_search();
    asked["commands"]["search_query"] = json!([
        {"q": "password: hunter2"},
        {"q": format!("lisbon {MANAGED_STUB_KEY} trams")},
    ]);
    let (status, body) =
        post_through_proxy(addr, &managed_grant(true, true), "/v1/alpha/search", asked).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body)?;
    let output = answer["output"].as_str().unwrap();
    assert!(
        output.starts_with("Web search: nothing was searched."),
        "{output}"
    );
    for number in [1, 2] {
        assert!(output.contains(&format!(
            "Query {number} was not searched. This query looks like it holds a key or a password, so it was not sent."
        )));
    }
    assert!(!output.contains(MANAGED_STUB_KEY) && !output.contains("hunter2"));
    assert_eq!(answer["results"], json!([]));
    assert!(upstream.bodies.lock().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_search_failures_are_redacted_told_and_never_retried() -> Result<()> {
    let (addr, _controller, upstream, _env, _guards) =
        spawn_search_stack(StackProxy::Dynamic, Some("1")).await?;
    let private =
        json!({"error": {"code": "rate_limit_exceeded", "message": "private-query secret-token"}});
    // Every search failed: the route answers with the failure, redacted.
    upstream.respond_next.lock().unwrap().extend([
        (StatusCode::TOO_MANY_REQUESTS, private.clone()),
        (StatusCode::TOO_MANY_REQUESTS, private.clone()),
    ]);
    let (status, body) = post_through_proxy(
        addr,
        &managed_grant(true, true),
        "/v1/alpha/search",
        luna_search(),
    )
    .await?;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(
        !body.contains("private-query") && !body.contains("secret-token"),
        "{body}"
    );
    assert_eq!(responses_requests(&upstream).len(), 2, "no retry");

    // One failed among two: the other's answer comes back, and the failure
    // is told.
    upstream.respond_next.lock().unwrap().extend([
        (StatusCode::INTERNAL_SERVER_ERROR, private),
        (StatusCode::OK, web_search_answer()),
    ]);
    let (status, body) = post_through_proxy(
        addr,
        &managed_grant(true, true),
        "/v1/alpha/search",
        luna_search(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let output = serde_json::from_str::<Value>(&body)?["output"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        output
            .matches("the search failed, so nothing came back for it.")
            .count(),
        1
    );
    assert_eq!(output.matches("</untrusted_page_content>").count(), 1);
    assert!(!output.contains("private-query"));
    assert_eq!(responses_requests(&upstream).len(), 4, "no retry");
    Ok(())
}

#[tokio::test]
#[serial]
async fn the_search_probe_runs_one_hosted_search_and_never_prints_the_key() -> Result<()> {
    let upstream = UpstreamStub::default();
    let (upstream_addr, _upstream_guard) = spawn_router(
        Router::new()
            .route(UPSTREAM_RESPONSES_PATH, post(upstream_responses_stub))
            .with_state(upstream.clone()),
    )
    .await?;
    let endpoint = format!("http://{upstream_addr}{UPSTREAM_RESPONSES_PATH}");
    let _env = [
        EnvGuard::set("OPENAI_API_KEY", Some(MANAGED_STUB_KEY)),
        EnvGuard::set("CODEX_OPENAI_ENDPOINT", Some(&endpoint)),
        EnvGuard::set("PROXY_MANAGED_WEB_SEARCH_MODEL", None),
        EnvGuard::set("PROXY_PINNED_MODEL", Some(PINNED_MODEL)),
        EnvGuard::set("MANAGED_AI_MODEL_ID", None),
    ];
    let probe = openai_proxy_server::search_bridge::search_probe;

    upstream
        .respond_next
        .lock()
        .unwrap()
        .push_back((StatusCode::OK, web_search_answer()));
    assert_eq!(probe(&[]).await, (0, format!("ok model={PINNED_MODEL}")));
    let sent = upstream.bodies.lock().unwrap()[0].clone();
    assert_eq!(sent["model"], PINNED_MODEL);
    assert_eq!(sent["tools"], json!([{"type": "web_search"}]));
    assert_eq!(sent["max_tool_calls"], 1);
    assert_eq!(
        *upstream.bearers.lock().unwrap(),
        vec![format!("Bearer {MANAGED_STUB_KEY}")]
    );

    // A refusal names its status and code, never its message or the key.
    upstream.respond_next.lock().unwrap().push_back((
        StatusCode::UNAUTHORIZED,
        json!({"error": {"code": "invalid_api_key", "message": format!("Incorrect API key provided: {MANAGED_STUB_KEY}")}}),
    ));
    let (code, line) = probe(&["--model".into(), "gpt-5.6-luna".into()]).await;
    assert_eq!(
        (code, line.as_str()),
        (1, "fail model=gpt-5.6-luna reason=http_401_invalid_api_key")
    );
    // An answer with no search in it is no proof of search.
    let mut no_search = web_search_answer();
    no_search.as_object_mut().unwrap().remove("tool_usage");
    no_search["output"].as_array_mut().unwrap().remove(1);
    upstream
        .respond_next
        .lock()
        .unwrap()
        .push_back((StatusCode::OK, no_search));
    assert_eq!(
        probe(&[]).await,
        (1, format!("fail model={PINNED_MODEL} reason=no_search"))
    );
    assert_eq!(
        probe(&["--speed".into()]).await,
        (2, "fail model=none reason=usage".to_string())
    );
    let _no_model = [
        EnvGuard::set("PROXY_PINNED_MODEL", None),
        EnvGuard::set("OPENAI_API_KEY", None),
    ];
    assert_eq!(
        probe(&[]).await,
        (2, "fail model=none reason=no_model".to_string())
    );
    assert_eq!(upstream.bodies.lock().unwrap().len(), 3);
    Ok(())
}
