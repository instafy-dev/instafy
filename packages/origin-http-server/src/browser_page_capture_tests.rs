use std::io::Write as _;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value as JsonValue};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as TungMessage;

use super::*;

/// The page reader runtime-agent installs: both policy scripts, each wrapped
/// so it publishes its API on `globalThis` (see
/// `runtime_agent::shared_browser::sent_page_capture_script`).
fn policy_script() -> String {
    let wrap = |source: &str| {
        format!("(function (module, require) {{\n{source}\n}})(undefined, undefined);")
    };
    format!(
        "{}\n{}",
        wrap(include_str!("../../browser-action-policy/redaction.js")),
        wrap(include_str!("../../browser-action-policy/pageCapture.js")),
    )
}

/// What the fake page answers to the capture evaluation in its isolated world.
type Evaluate = Arc<dyn Fn(&str) -> JsonValue + Send + Sync>;

struct FakePage {
    /// The main-world answer to "is this document withheld?"; `None` fails it.
    withheld: Option<bool>,
    /// The loader id after the read; the page loaded anew when it differs.
    loader_after: &'static str,
    evaluate: Evaluate,
}

/// A CDP page target on loopback that answers the commands one capture sends
/// and records them.
async fn serve_fake_page(page: FakePage) -> (String, Arc<Mutex<Vec<JsonValue>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://{}/devtools/page/PAGE1",
        listener.local_addr().unwrap()
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let mut frame_trees = 0;
        while let Some(Ok(message)) = socket.next().await {
            let TungMessage::Text(text) = message else {
                continue;
            };
            let command: JsonValue = serde_json::from_str(&text).unwrap();
            recorded.lock().unwrap().push(command.clone());
            let id = command["id"].clone();
            let params = &command["params"];
            let reply = match command["method"].as_str().unwrap() {
                "Page.getFrameTree" => {
                    frame_trees += 1;
                    let loader = if frame_trees == 1 {
                        "LOADER1"
                    } else {
                        page.loader_after
                    };
                    json!({ "id": id, "result": { "frameTree": { "frame": { "id": "FRAME1", "loaderId": loader } } } })
                }
                "Page.createIsolatedWorld" => {
                    json!({ "id": id, "result": { "executionContextId": 7 } })
                }
                "Runtime.evaluate" if params.get("contextId").is_none() => match page.withheld {
                    Some(withheld) => {
                        json!({ "id": id, "result": { "result": { "type": "boolean", "value": withheld } } })
                    }
                    None => {
                        json!({ "id": id, "error": { "code": -32000, "message": "page said no" } })
                    }
                },
                "Runtime.evaluate" => {
                    let expression = params["expression"].as_str().unwrap().to_string();
                    let evaluate = page.evaluate.clone();
                    let value = tokio::task::spawn_blocking(move || evaluate(&expression))
                        .await
                        .unwrap();
                    json!({ "id": id, "result": { "result": { "type": "object", "value": value } } })
                }
                other => panic!("unexpected CDP command {other}"),
            };
            // An event first: the reader must wait for the answer to its own id.
            socket
                .send(TungMessage::Text(
                    json!({ "method": "Page.frameNavigated", "params": {} }).to_string(),
                ))
                .await
                .unwrap();
            socket
                .send(TungMessage::Text(reply.to_string()))
                .await
                .unwrap();
        }
    });
    (url, seen)
}

/// Runs `expression` in Node against a minimal page: an address, a title and
/// rendered body text, with no elements to scan.
fn run_in_page(expression: &str, url: &str, title: &str, text: &str) -> JsonValue {
    let page = format!(
        "globalThis.location = {{ protocol: new URL({url}).protocol, href: {url} }};\n\
         globalThis.document = {{ title: {title}, body: {{ innerText: {text} }}, querySelectorAll: () => [] }};\n",
        url = serde_json::to_string(url).unwrap(),
        title = serde_json::to_string(title).unwrap(),
        text = serde_json::to_string(text).unwrap(),
    );
    let program = format!(
        "{page}const value = eval({});\nprocess.stdout.write(JSON.stringify(value === undefined ? null : value));\n",
        serde_json::to_string(expression).unwrap()
    );
    let mut child = Command::new("node")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(program.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn page_with(url: &'static str, title: &'static str, text: &'static str) -> Evaluate {
    Arc::new(move |expression| run_in_page(expression, url, title, text))
}

// Key-shaped samples are assembled from parts, so none is committed whole.
const KEY: &str = concat!("sk", "-proj-", "AbCdEfGhIjKlMnOp", "QrStUvWxYz0123456789");
const RANDOM_VALUE: &str = concat!("abc123DEF456", "ghi789JKL012mno345");

#[tokio::test]
async fn a_sent_page_is_masked_in_an_isolated_world_before_it_leaves_the_host() {
    let text: &'static str = Box::leak(
        format!("Your order\nTracking 1Z999AA10123456784\nDeploy hook: {KEY}\n\n\n\nThanks")
            .into_boxed_str(),
    );
    let (url, seen) = serve_fake_page(FakePage {
        withheld: Some(false),
        loader_after: "LOADER1",
        evaluate: page_with("https://shop.example/orders/42", "Order 42", text),
    })
    .await;
    let page = capture_page(&url, &policy_script()).await.expect("capture");

    assert!(!page.secret_screen);
    assert!(
        !page.text.contains(KEY),
        "the key never leaves the host: {}",
        page.text
    );
    assert!(page.text.contains("[redacted secret]"));
    assert!(page.text.contains("Tracking 1Z999AA10123456784"));
    assert!(page.text.contains("Deploy hook"));
    assert!(!page.text.contains("\n\n\n"), "blank runs collapse");
    assert_eq!(page.url, "https://shop.example/orders/42");
    assert_eq!(page.title, "Order 42");
    assert!(!page.truncated);

    let commands = seen.lock().unwrap().clone();
    let methods: Vec<&str> = commands
        .iter()
        .map(|command| command["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods,
        [
            "Page.getFrameTree",
            "Runtime.evaluate",
            "Page.createIsolatedWorld",
            "Runtime.evaluate",
            "Page.getFrameTree"
        ]
    );
    // Page scripts cannot reach the world the text is read and masked in.
    assert_eq!(commands[2]["params"]["frameId"], "FRAME1");
    assert_eq!(commands[3]["params"]["contextId"], 7);
    assert_eq!(commands[3]["params"]["userGesture"], false);
    // Only the withheld mark is read in the page's own world.
    assert!(commands[1]["params"]["expression"]
        .as_str()
        .unwrap()
        .contains("instafy.sharedBrowser.withheldDocument"));
}

#[tokio::test]
async fn a_secret_screen_or_a_withheld_page_sends_no_text() {
    // A credential page that shows a key-like value.
    let (url, _) = serve_fake_page(FakePage {
        withheld: Some(false),
        loader_after: "LOADER1",
        evaluate: page_with(
            "https://console.example/settings/api-keys",
            "API keys",
            Box::leak(format!("Production key\n{RANDOM_VALUE}").into_boxed_str()),
        ),
    })
    .await;
    let page = capture_page(&url, &policy_script()).await.expect("capture");
    assert!(page.secret_screen);
    assert_eq!((page.title.as_str(), page.text.as_str()), ("", ""));

    // An ordinary page the agent's controller marked withheld, and one whose
    // mark could not be read.
    for withheld in [Some(true), None] {
        let (url, seen) = serve_fake_page(FakePage {
            withheld,
            loader_after: "LOADER1",
            evaluate: page_with(
                "https://example.test/",
                "Plain page",
                "Nothing secret here.",
            ),
        })
        .await;
        let page = capture_page(&url, &policy_script()).await.expect("capture");
        assert!(page.secret_screen, "{withheld:?}");
        assert_eq!(page.text, "");
        let expression = seen.lock().unwrap()[3]["params"]["expression"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            expression.ends_with("withhold: true });\n})()"),
            "{withheld:?}"
        );
    }
}

#[tokio::test]
async fn a_page_that_changes_while_it_is_read_is_refused() {
    let (url, _) = serve_fake_page(FakePage {
        withheld: Some(false),
        loader_after: "LOADER2",
        evaluate: page_with("https://example.test/", "Page", "Text"),
    })
    .await;
    let error = capture_page(&url, &policy_script()).await.unwrap_err();
    assert!(matches!(error, OriginError::Conflict(_)), "{error:?}");
}

#[tokio::test]
async fn only_a_web_page_is_sent() {
    let (url, _) = serve_fake_page(FakePage {
        withheld: Some(false),
        loader_after: "LOADER1",
        evaluate: page_with("chrome://newtab/", "New Tab", ""),
    })
    .await;
    let error = capture_page(&url, &policy_script()).await.unwrap_err();
    assert!(matches!(error, OriginError::Conflict(_)), "{error:?}");
}

#[tokio::test]
async fn a_page_cannot_answer_for_the_reader() {
    // Whatever the isolated world returns is checked: unknown fields, text on a
    // withheld page, oversized values and non-web addresses are refused.
    let answers = [
        json!(null),
        json!({ "url": "https://example.test/", "title": "", "text": KEY, "secretScreen": false, "truncated": false, "raw": KEY }),
        json!({ "url": "https://example.test/", "title": "", "text": "leak", "secretScreen": true, "truncated": false }),
        json!({ "url": "https://example.test/", "title": "", "text": "x".repeat(MAX_TEXT_BYTES + 1), "secretScreen": false, "truncated": false }),
        json!({ "url": "javascript:alert(1)", "title": "", "text": "", "secretScreen": false, "truncated": false }),
    ];
    for answer in answers {
        let fixed = answer.clone();
        let (url, _) = serve_fake_page(FakePage {
            withheld: Some(false),
            loader_after: "LOADER1",
            evaluate: Arc::new(move |_| fixed.clone()),
        })
        .await;
        let error = capture_page(&url, "/* reader */").await.unwrap_err();
        assert!(
            matches!(error, OriginError::Unavailable(_)),
            "{answer}: {error:?}"
        );
    }
}

#[test]
fn the_reader_names_both_policy_modules() {
    let expression = capture_expression("/* reader */", false);
    assert!(expression.starts_with("/* reader */\n;"));
    assert!(expression.contains("globalThis.__instafyBrowserPageCapture"));
    assert!(expression.contains("globalThis.__instafyBrowserRedaction"));
    assert!(expression.contains("captureSentPage(redaction, { withhold: false })"));
}
