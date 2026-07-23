use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, Response, StatusCode};
use axum::Extension;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use uuid::Uuid;

use crate::auth::{validated_claim_expiry, OriginClaims};

const DEFAULT_WEBRTC_SENDER_URL: &str = "http://127.0.0.1:9225";
const WEBRTC_OFFER_TIMEOUT: Duration = Duration::from_secs(12);
const WEBRTC_ANSWER_MAX_BYTES: usize = 256 * 1024;
const WEBRTC_ICE_SERVER_MAX_COUNT: usize = 8;
const WEBRTC_ICE_URLS_PER_SERVER_MAX_COUNT: usize = 4;
const WEBRTC_ICE_URL_MAX_BYTES: usize = 2048;
const WEBRTC_ICE_CREDENTIAL_MAX_BYTES: usize = 4096;
const BROWSER_WEBRTC_POLICY_HEADER: &str = "x-instafy-browser-webrtc-policy";
const BROWSER_WEBRTC_ICE_SERVERS_HEADER: &str = "x-instafy-browser-webrtc-ice-servers";
const WEBRTC_OFFER_EXPIRY_FIELD: &str = "expiresAtUnixSeconds";
const WEBRTC_OFFER_VIEWER_KEY_FIELD: &str = "viewerKey";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserWebRtcIceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebRtcCapabilities {
    pub ice_servers: Vec<BrowserWebRtcIceServer>,
    pub relay_only: bool,
}

pub fn capabilities() -> Option<BrowserWebRtcCapabilities> {
    if std::env::var("INSTAFY_BROWSER_WEBRTC_ENABLED")
        .ok()
        .as_deref()
        != Some("1")
    {
        return None;
    }

    let raw = std::env::var("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON").unwrap_or_default();
    let relay_only = std::env::var("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN")
        .ok()
        .as_deref()
        == Some("1");
    capabilities_from_values(&raw, relay_only)
}

pub fn capabilities_for_headers(headers: &HeaderMap) -> Option<BrowserWebRtcCapabilities> {
    let Some(policy) = headers
        .get(BROWSER_WEBRTC_POLICY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return capabilities();
    };

    match policy {
        "disabled" => None,
        "relay" => {
            if std::env::var("INSTAFY_BROWSER_WEBRTC_ENABLED")
                .ok()
                .as_deref()
                != Some("1")
            {
                return None;
            }
            let raw = headers
                .get(BROWSER_WEBRTC_ICE_SERVERS_HEADER)
                .and_then(|value| value.to_str().ok())?;
            capabilities_from_values(raw, true)
        }
        _ => None,
    }
}

fn capabilities_from_values(raw: &str, relay_only: bool) -> Option<BrowserWebRtcCapabilities> {
    let ice_servers = if raw.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str::<Vec<BrowserWebRtcIceServer>>(&raw)
            .ok()?
            .into_iter()
            .take(WEBRTC_ICE_SERVER_MAX_COUNT)
            .map(normalize_ice_server)
            .collect::<Option<Vec<_>>>()?
    };

    if relay_only
        && !ice_servers.iter().any(|server| {
            server.username.is_some()
                && server.credential.is_some()
                && server.urls.iter().any(|url| {
                    let lower = url.to_ascii_lowercase();
                    lower.starts_with("turn:") || lower.starts_with("turns:")
                })
        })
    {
        return None;
    }

    Some(BrowserWebRtcCapabilities {
        ice_servers,
        relay_only,
    })
}

fn normalize_ice_server(mut server: BrowserWebRtcIceServer) -> Option<BrowserWebRtcIceServer> {
    server.urls = server
        .urls
        .into_iter()
        .take(WEBRTC_ICE_URLS_PER_SERVER_MAX_COUNT)
        .map(|url| url.trim().to_string())
        .filter(|url| {
            !url.is_empty()
                && url.len() <= WEBRTC_ICE_URL_MAX_BYTES
                && ["stun:", "stuns:", "turn:", "turns:"]
                    .iter()
                    .any(|prefix| url.to_ascii_lowercase().starts_with(prefix))
        })
        .collect();
    if server.urls.is_empty() {
        return None;
    }
    let normalize_credential = |value: String| {
        let value = value.trim().to_string();
        (!value.is_empty() && value.len() <= WEBRTC_ICE_CREDENTIAL_MAX_BYTES).then_some(value)
    };
    server.username = server.username.and_then(normalize_credential);
    server.credential = server.credential.and_then(normalize_credential);
    Some(server)
}

fn browser_webrtc_viewer_key(
    project_id: &str,
    subject: &str,
    browser_session_id: Option<&str>,
) -> Option<String> {
    let browser_session_id = browser_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    // The sender is a bearer-less loopback service. Give it only a stable,
    // pseudonymous identity so it can admit one replacement peer for this
    // signed browser session without exposing the account or session values.
    let identity = format!("{project_id}\n{subject}\n{browser_session_id}");
    Some(Uuid::new_v5(&Uuid::NAMESPACE_URL, identity.as_bytes()).to_string())
}

pub async fn handle_offer(
    Extension(claims): Extension<OriginClaims>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    if validated_claim_expiry(&claims).is_err() {
        return response(StatusCode::UNAUTHORIZED, "WebRTC browser token expired");
    }
    let Some(viewer_key) = browser_webrtc_viewer_key(
        &claims.project_id,
        &claims.sub,
        claims.browser_session_id.as_deref(),
    ) else {
        return response(
            StatusCode::UNAUTHORIZED,
            "WebRTC browser session identity is missing",
        );
    };
    let Some(capabilities) = capabilities_for_headers(&headers) else {
        return response(
            StatusCode::NOT_FOUND,
            "WebRTC browser transport is disabled",
        );
    };

    let Some(url) = sender_offer_url() else {
        return response(
            StatusCode::SERVICE_UNAVAILABLE,
            "WebRTC browser sender is misconfigured",
        );
    };

    let mut offer = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(serde_json::Value::Object(offer)) => offer,
        _ => return response(StatusCode::BAD_REQUEST, "invalid WebRTC offer"),
    };
    offer.insert(
        "iceServers".to_string(),
        serde_json::to_value(capabilities.ice_servers).unwrap_or_default(),
    );
    offer.insert(
        "relayOnly".to_string(),
        serde_json::Value::Bool(capabilities.relay_only),
    );
    // Bind the otherwise bearer-less peer lifetime to the signed viewing
    // grant. The loopback sender rejects offers without this field and closes
    // the PeerConnection at this absolute deadline.
    offer.insert(
        WEBRTC_OFFER_EXPIRY_FIELD.to_string(),
        serde_json::Value::from(
            claims
                .exp
                .expect("validated WebRTC claims must carry an expiry"),
        ),
    );
    offer.insert(
        WEBRTC_OFFER_VIEWER_KEY_FIELD.to_string(),
        serde_json::Value::String(viewer_key),
    );

    let request = reqwest::Client::new()
        .post(url)
        .header(CONTENT_TYPE.as_str(), "application/json")
        .json(&offer);
    let upstream = match timeout(WEBRTC_OFFER_TIMEOUT, request.send()).await {
        Ok(Ok(upstream)) => upstream,
        Ok(Err(_)) => {
            return response(
                StatusCode::BAD_GATEWAY,
                "WebRTC browser sender is unavailable",
            )
        }
        Err(_) => {
            return response(
                StatusCode::GATEWAY_TIMEOUT,
                "WebRTC browser sender timed out",
            )
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/plain; charset=utf-8")
        .to_string();
    let bytes = match timeout(WEBRTC_OFFER_TIMEOUT, upstream.bytes()).await {
        Ok(Ok(bytes)) if bytes.len() <= WEBRTC_ANSWER_MAX_BYTES => bytes,
        Ok(Ok(_)) => {
            return response(
                StatusCode::BAD_GATEWAY,
                "WebRTC browser sender returned an oversized answer",
            )
        }
        _ => {
            return response(
                StatusCode::BAD_GATEWAY,
                "WebRTC browser sender returned an invalid answer",
            )
        }
    };

    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| response(StatusCode::INTERNAL_SERVER_ERROR, "response error"))
}

fn sender_offer_url() -> Option<Url> {
    let raw = std::env::var("INSTAFY_BROWSER_WEBRTC_SENDER_URL")
        .unwrap_or_else(|_| DEFAULT_WEBRTC_SENDER_URL.to_string());
    let mut url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?;
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return None;
    }
    url.set_path("/offer");
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

fn response(status: StatusCode, message: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message))
        .expect("static WebRTC response")
}

#[cfg(test)]
mod tests {
    use super::*;

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn capabilities_require_explicit_enablement() {
        let _guard = ENV_LOCK.lock().expect("lock env");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ENABLED");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON");
        assert_eq!(capabilities(), None);
    }

    #[test]
    fn capabilities_parse_bounded_ice_servers() {
        let _guard = ENV_LOCK.lock().expect("lock env");
        std::env::set_var("INSTAFY_BROWSER_WEBRTC_ENABLED", "1");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN");
        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            r#"[{"urls":["turns:turn.example.test:5349","https://invalid.example"],"username":" user ","credential":" secret "}]"#,
        );

        let parsed = capabilities().expect("enabled capabilities");
        assert!(!parsed.relay_only);
        assert_eq!(parsed.ice_servers.len(), 1);
        assert_eq!(
            parsed.ice_servers[0].urls,
            vec!["turns:turn.example.test:5349"]
        );
        assert_eq!(parsed.ice_servers[0].username.as_deref(), Some("user"));
        assert_eq!(parsed.ice_servers[0].credential.as_deref(), Some("secret"));

        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ENABLED");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON");
    }

    #[test]
    fn capabilities_fail_closed_when_turn_is_required_but_missing() {
        let _guard = ENV_LOCK.lock().expect("lock env");
        std::env::set_var("INSTAFY_BROWSER_WEBRTC_ENABLED", "1");
        std::env::set_var("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN", "1");
        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            r#"[{"urls":["stun:stun.example.test:3478"]}]"#,
        );

        assert_eq!(capabilities(), None);

        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            r#"[{"urls":["turns:turn.example.test:5349"],"username":"ephemeral","credential":"secret"}]"#,
        );
        assert!(capabilities().is_some());
        assert!(capabilities().expect("TURN capabilities").relay_only);

        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ENABLED");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON");
    }

    #[test]
    fn controller_policy_refreshes_credentials_and_enforces_the_project_gate() {
        let _guard = ENV_LOCK.lock().expect("lock env");
        std::env::set_var("INSTAFY_BROWSER_WEBRTC_ENABLED", "1");
        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            r#"[{"urls":["turns:stale.example.test:443"],"username":"stale","credential":"stale"}]"#,
        );

        let mut headers = HeaderMap::new();
        headers.insert(BROWSER_WEBRTC_POLICY_HEADER, "relay".parse().unwrap());
        headers.insert(
            BROWSER_WEBRTC_ICE_SERVERS_HEADER,
            r#"[{"urls":["TURNS:turn.example.test:443"],"username":"fresh","credential":"derived"}]"#
                .parse()
                .unwrap(),
        );
        let refreshed = capabilities_for_headers(&headers).expect("refreshed capabilities");
        assert!(refreshed.relay_only);
        assert_eq!(refreshed.ice_servers[0].username.as_deref(), Some("fresh"));

        headers.insert(BROWSER_WEBRTC_POLICY_HEADER, "disabled".parse().unwrap());
        assert_eq!(capabilities_for_headers(&headers), None);

        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ENABLED");
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON");
    }

    #[test]
    fn viewer_key_is_stable_per_signed_browser_session_and_hides_raw_identity() {
        let first = browser_webrtc_viewer_key("project-a", "user-a", Some("session-a"))
            .expect("viewer key");
        assert_eq!(
            browser_webrtc_viewer_key("project-a", "user-a", Some("session-a")),
            Some(first.clone())
        );
        assert_ne!(
            browser_webrtc_viewer_key("project-a", "user-a", Some("session-b")),
            Some(first.clone())
        );
        assert!(!first.contains("user-a"));
        assert!(!first.contains("session-a"));
        assert_eq!(browser_webrtc_viewer_key("project-a", "user-a", None), None);
        assert_eq!(
            browser_webrtc_viewer_key("project-a", "user-a", Some("  ")),
            None
        );
    }

    #[test]
    fn sender_url_is_forced_to_loopback_offer_path() {
        let _guard = ENV_LOCK.lock().expect("lock env");
        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_SENDER_URL",
            "http://localhost:9123/ignored?token=secret",
        );
        assert_eq!(
            sender_offer_url().map(|url| url.to_string()).as_deref(),
            Some("http://localhost:9123/offer")
        );

        std::env::set_var(
            "INSTAFY_BROWSER_WEBRTC_SENDER_URL",
            "https://public.example.test",
        );
        assert_eq!(sender_offer_url(), None);
        std::env::remove_var("INSTAFY_BROWSER_WEBRTC_SENDER_URL");
    }
}
