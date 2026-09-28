//! Typed upstream failures. Public responses never echo provider bodies, URLs or credentials.

use std::fmt;

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

/// Delay a rate-limited client is told to wait when the provider gave no usable hint. It keeps
/// the single client-side retry from landing in the same provider window without stalling a turn.
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS: u64 = 2;
/// Bounds for a delay the proxy derives from x-ratelimit-reset-* headers. Those headers report
/// when a whole bucket refills, which can be minutes away, and the client sleeps for whatever
/// it is given. A zero reset would send the retry straight back into the exhausted window.
const MIN_DERIVED_RETRY_AFTER_SECS: u64 = 1;
const MAX_DERIVED_RETRY_AFTER_SECS: u64 = 30;
const RATE_LIMIT_RESET_HEADERS: [&str; 2] =
    ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"];

#[derive(Debug)]
pub(crate) enum UpstreamFailure {
    Http {
        status: StatusCode,
        retry_after: Option<HeaderValue>,
        refreshable_auth: bool,
    },
    CredentialRefresh,
    InvalidResponse,
    Stream {
        code: Option<String>,
        message: String,
    },
    PlanLimit {
        limit: PlanLimit,
        resets_at: Option<i64>,
    },
}

/// A ChatGPT plan window that is exhausted or does not cover the request. It resets in hours,
/// so unlike a rate limit, a retry within the same turn can only fail again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanLimit {
    UsageLimitReached,
    UsageNotIncluded,
}

impl PlanLimit {
    fn from_provider_code(code: &str) -> Option<Self> {
        match code {
            "usage_limit_reached" => Some(Self::UsageLimitReached),
            "usage_not_included" => Some(Self::UsageNotIncluded),
            _ => None,
        }
    }

    /// The provider's own error type, which the proxy passes on as `error.type`. Codex checks
    /// exactly these values in a 429 body and ends the turn with its usage-limit message
    /// instead of retrying or reporting a generic retry-limit failure.
    fn provider_code(self) -> &'static str {
        match self {
            Self::UsageLimitReached => "usage_limit_reached",
            Self::UsageNotIncluded => "usage_not_included",
        }
    }
}

impl UpstreamFailure {
    pub(crate) fn http_body(status: StatusCode, headers: &HeaderMap, body: &str) -> Self {
        if status == StatusCode::TOO_MANY_REQUESTS
            && let Ok(body) = serde_json::from_str::<serde_json::Value>(body)
        {
            // Only a structured provider code qualifies; arbitrary body text never does.
            let codes = ["/error/code", "/error/type"]
                .map(|field| body.pointer(field).and_then(serde_json::Value::as_str));
            // Quota exhaustion is not a rate limit that can recover within the same job.
            if codes.contains(&Some("insufficient_quota")) {
                return Self::Stream {
                    code: Some("insufficient_quota".into()),
                    message: "Upstream quota exhausted.".into(),
                };
            }
            if let Some(limit) = codes
                .into_iter()
                .flatten()
                .find_map(PlanLimit::from_provider_code)
            {
                return Self::PlanLimit {
                    limit,
                    // A validated reset time lets the client say when to try again. Nothing
                    // else from the provider body is passed on.
                    resets_at: body
                        .pointer("/error/resets_at")
                        .and_then(serde_json::Value::as_i64)
                        .filter(|seconds| *seconds > 0),
                };
            }
        }
        Self::http(
            status,
            headers,
            crate::auth::response_indicates_chatgpt_token_expired(status, body),
        )
    }

    pub(crate) fn http(status: StatusCode, headers: &HeaderMap, refreshable_auth: bool) -> Self {
        Self::Http {
            status,
            retry_after: normalized_retry_after(status, headers),
            refreshable_auth,
        }
    }
}

impl fmt::Display for UpstreamFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, .. } => write!(f, "upstream returned {status}"),
            Self::CredentialRefresh => f.write_str("upstream credential refresh failed"),
            Self::InvalidResponse => f.write_str("invalid upstream response"),
            Self::Stream { code, message } => {
                write!(f, "backend stream reported error: {message}")?;
                if let Some(code) = code {
                    write!(f, " (code={code})")?;
                }
                Ok(())
            }
            Self::PlanLimit { limit, .. } => {
                write!(f, "upstream plan limit reached ({})", limit.provider_code())
            }
        }
    }
}

impl std::error::Error for UpstreamFailure {}

pub(crate) fn refreshable_auth(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<UpstreamFailure>(),
        Some(UpstreamFailure::Http {
            status: StatusCode::UNAUTHORIZED,
            refreshable_auth: true,
            ..
        })
    )
}

#[derive(Debug)]
pub(crate) struct ErrorResponse {
    pub status: StatusCode,
    /// The envelope's `error.type`. Always `upstream_error` except for a plan limit, which
    /// keeps the provider's type so clients can recognise it.
    pub error_type: &'static str,
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    pub retry_after: Option<HeaderValue>,
    /// Unix seconds at which a plan limit resets, when the provider said so.
    pub resets_at: Option<i64>,
}

impl ErrorResponse {
    fn new(status: StatusCode, code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            status,
            error_type: "upstream_error",
            code,
            message,
            retryable,
            retry_after: None,
            resets_at: None,
        }
    }
}

pub(crate) fn classify(error: &anyhow::Error) -> ErrorResponse {
    // Context markers are considered before their underlying request/JSON errors.
    if let Some(failure) = error.downcast_ref::<UpstreamFailure>() {
        return match failure {
            UpstreamFailure::CredentialRefresh => ErrorResponse::new(
                StatusCode::FAILED_DEPENDENCY,
                "upstream_credential_refresh_failed",
                "Upstream credentials could not be refreshed.",
                false,
            ),
            UpstreamFailure::InvalidResponse => ErrorResponse::new(
                StatusCode::BAD_GATEWAY,
                "upstream_invalid_response",
                "The upstream provider returned an invalid response.",
                true,
            ),
            UpstreamFailure::Http {
                status,
                retry_after,
                ..
            } => {
                let mut response = classify_http(*status);
                // A provider hint wins; otherwise keep the default classify_http chose.
                if retry_after.is_some() {
                    response.retry_after = retry_after.clone();
                }
                response
            }
            UpstreamFailure::PlanLimit { limit, resets_at } => plan_limit(*limit, *resets_at),
            UpstreamFailure::Stream { code, .. } => match code.as_deref() {
                Some("insufficient_quota") => ErrorResponse::new(
                    StatusCode::PAYMENT_REQUIRED,
                    "upstream_insufficient_quota",
                    "The upstream provider has no available quota.",
                    false,
                ),
                // An in-stream plan limit is as final as one reported by HTTP status.
                Some("usage_limit_reached") => plan_limit(PlanLimit::UsageLimitReached, None),
                Some("usage_not_included") => plan_limit(PlanLimit::UsageNotIncluded, None),
                Some("invalid_api_key" | "invalid_authentication") => {
                    classify_http(StatusCode::UNAUTHORIZED)
                }
                Some("permission_denied") => classify_http(StatusCode::FORBIDDEN),
                Some("invalid_request_error" | "context_length_exceeded" | "model_not_found") => {
                    classify_http(StatusCode::BAD_REQUEST)
                }
                Some("rate_limit_exceeded") => classify_http(StatusCode::TOO_MANY_REQUESTS),
                _ => ErrorResponse::new(
                    StatusCode::BAD_GATEWAY,
                    "upstream_stream_error",
                    "The upstream provider reported a stream failure.",
                    true,
                ),
            },
        };
    }
    for cause in error.chain() {
        if let Some(error) = cause.downcast_ref::<reqwest::Error>() {
            if error.is_builder() || error.is_redirect() {
                return ErrorResponse::new(
                    StatusCode::FAILED_DEPENDENCY,
                    "upstream_configuration_error",
                    "The upstream request configuration is invalid.",
                    false,
                );
            }
            if error.is_timeout() {
                return ErrorResponse::new(
                    StatusCode::GATEWAY_TIMEOUT,
                    "upstream_timeout",
                    "The upstream request timed out.",
                    true,
                );
            }
            if error.is_decode() {
                return ErrorResponse::new(
                    StatusCode::BAD_GATEWAY,
                    "upstream_invalid_response",
                    "The upstream provider returned an invalid response.",
                    true,
                );
            }
        }
    }
    // Native TLS errors can represent either certificate rejection or transient handshake
    // resets. Their public error chain does not portably distinguish these: retain a bounded
    // retry opportunity rather than guessing from the error's display text.
    ErrorResponse::new(
        StatusCode::BAD_GATEWAY,
        "upstream_transport_error",
        "The upstream request failed.",
        true,
    )
}

/// A plan limit keeps the rate-limit status but is not retryable and carries no Retry-After:
/// the window resets in hours, and a client that retried would only spend its retry budget and
/// then report a generic rate limit instead of the plan limit.
fn plan_limit(limit: PlanLimit, resets_at: Option<i64>) -> ErrorResponse {
    let (code, message) = match limit {
        PlanLimit::UsageLimitReached => (
            "upstream_usage_limit_reached",
            "The upstream plan usage limit was reached.",
        ),
        PlanLimit::UsageNotIncluded => (
            "upstream_usage_not_included",
            "The upstream plan does not include this usage.",
        ),
    };
    let mut response = ErrorResponse::new(StatusCode::TOO_MANY_REQUESTS, code, message, false);
    response.error_type = limit.provider_code();
    response.resets_at = resets_at;
    response
}

fn classify_http(status: StatusCode) -> ErrorResponse {
    let (code, message) = match status {
        StatusCode::UNAUTHORIZED => (
            "upstream_authentication_error",
            "The upstream provider rejected authentication.",
        ),
        StatusCode::FORBIDDEN => (
            "upstream_access_denied",
            "The upstream provider denied access.",
        ),
        StatusCode::TOO_MANY_REQUESTS => (
            "upstream_rate_limit",
            "The upstream provider rate limit was reached.",
        ),
        _ => (
            "upstream_http_error",
            "The upstream provider rejected the request.",
        ),
    };
    if !(status.is_client_error() || status.is_server_error()) {
        return ErrorResponse::new(
            StatusCode::BAD_GATEWAY,
            "upstream_invalid_response",
            "The upstream provider returned an unexpected HTTP status.",
            true,
        );
    }
    let mut response = ErrorResponse::new(
        status,
        code,
        message,
        status.is_server_error()
            || matches!(
                status,
                StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
            ),
    );
    // The proxy never retries a rate limit itself, so every 429 tells the client how long to
    // wait. This also covers an in-stream rate_limit_exceeded, which carries no headers.
    if status == StatusCode::TOO_MANY_REQUESTS {
        response.retry_after = Some(HeaderValue::from(DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS));
    }
    response
}

fn normalized_retry_after(status: StatusCode, headers: &HeaderMap) -> Option<HeaderValue> {
    match status {
        StatusCode::TOO_MANY_REQUESTS => {
            forwarded_retry_after(headers).or_else(|| rate_limit_reset_retry_after(headers))
        }
        StatusCode::SERVICE_UNAVAILABLE => forwarded_retry_after(headers),
        _ => None,
    }
}

fn forwarded_retry_after(headers: &HeaderMap) -> Option<HeaderValue> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if value.len() > 128 || value.is_empty() {
        return None;
    }
    let normalized = if value.bytes().all(|ch| ch.is_ascii_digit()) {
        value.parse::<u64>().ok()?.to_string()
    } else {
        httpdate::fmt_http_date(httpdate::parse_http_date(value).ok()?)
    };
    HeaderValue::from_str(&normalized).ok()
}

/// OpenAI often answers a rate limit without Retry-After but reports when its request and
/// token buckets reset. Waiting for the later of the two covers whichever limit was hit.
fn rate_limit_reset_retry_after(headers: &HeaderMap) -> Option<HeaderValue> {
    let seconds = RATE_LIMIT_RESET_HEADERS
        .iter()
        .filter_map(|name| headers.get(*name)?.to_str().ok())
        .filter_map(reset_duration_secs)
        .max()?;
    Some(HeaderValue::from(seconds.clamp(
        MIN_DERIVED_RETRY_AFTER_SECS,
        MAX_DERIVED_RETRY_AFTER_SECS,
    )))
}

/// Parses the duration strings OpenAI sends in x-ratelimit-reset-* headers, such as "6s",
/// "1m2.5s" or "120ms", into whole seconds rounded up. Anything else is ignored rather than
/// guessed at, so a bare number or an unknown unit falls back to the default delay.
fn reset_duration_secs(value: &str) -> Option<u64> {
    let mut rest = value.trim();
    if rest.is_empty() || rest.len() > 32 {
        return None;
    }
    let mut total_ms = 0f64;
    while !rest.is_empty() {
        let number_end = rest
            .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
            .unwrap_or(rest.len());
        let number = rest[..number_end].parse::<f64>().ok()?;
        rest = &rest[number_end..];
        let unit_end = rest
            .find(|ch: char| ch.is_ascii_digit() || ch == '.')
            .unwrap_or(rest.len());
        let unit_ms = match &rest[..unit_end] {
            "h" => 3_600_000.0,
            "m" => 60_000.0,
            "s" => 1_000.0,
            "ms" => 1.0,
            _ => return None,
        };
        rest = &rest[unit_end..];
        total_ms += number * unit_ms;
    }
    // Float to integer casts saturate, and the caller clamps the result anyway.
    Some((total_ms / 1_000.0).ceil() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_requires_a_typed_unauthorized_response() {
        assert!(!refreshable_auth(&anyhow::anyhow!(
            "token_expired controller credential lease renewal failed"
        )));
        let error = anyhow::Error::new(UpstreamFailure::http(
            StatusCode::UNAUTHORIZED,
            &HeaderMap::new(),
            true,
        ));
        assert!(refreshable_auth(&error.context("request context")));
    }

    #[test]
    fn retry_after_only_forwards_valid_retry_instructions() {
        let mut headers = HeaderMap::new();
        for (raw, expected) in [
            ("00012", Some("12")),
            (
                "Wed, 21 Oct 2015 07:28:00 GMT",
                Some("Wed, 21 Oct 2015 07:28:00 GMT"),
            ),
            ("private-credential", None),
            ("-1", None),
            ("18446744073709551616", None),
        ] {
            headers.insert(RETRY_AFTER, HeaderValue::from_str(raw).unwrap());
            assert_eq!(
                normalized_retry_after(StatusCode::TOO_MANY_REQUESTS, &headers)
                    .as_ref()
                    .and_then(|v| v.to_str().ok()),
                expected
            );
            assert!(normalized_retry_after(StatusCode::UNAUTHORIZED, &headers).is_none());
        }
    }

    #[test]
    fn rate_limit_reset_durations_parse_to_whole_seconds() {
        for (raw, expected) in [
            ("6s", Some(6)),
            (" 6m0s ", Some(360)),
            ("1m2.5s", Some(63)),
            ("120ms", Some(1)),
            ("1000ms", Some(1)),
            ("1h", Some(3600)),
            ("0s", Some(0)),
            ("", None),
            ("6", None),
            ("-1s", None),
            ("1.2.3s", None),
            ("6x", None),
            ("s", None),
            ("1e3s", None),
        ] {
            assert_eq!(reset_duration_secs(raw), expected, "{raw:?}");
        }
    }

    #[test]
    fn rate_limit_without_retry_after_derives_a_bounded_delay() {
        let retry_after = |status, pairs: &[(&'static str, &'static str)]| {
            let mut headers = HeaderMap::new();
            for &(name, value) in pairs {
                headers.insert(name, HeaderValue::from_static(value));
            }
            classify(&UpstreamFailure::http_body(status, &headers, "{}").into())
                .retry_after
                .map(|value| value.to_str().unwrap().to_owned())
        };
        let too_many = StatusCode::TOO_MANY_REQUESTS;
        for (pairs, expected) in [
            (
                &[("retry-after", "7"), ("x-ratelimit-reset-tokens", "6s")][..],
                "7",
            ),
            (&[("x-ratelimit-reset-tokens", "6s")], "6"),
            (
                &[
                    ("x-ratelimit-reset-requests", "120ms"),
                    ("x-ratelimit-reset-tokens", "2.5s"),
                ],
                "3",
            ),
            (&[("x-ratelimit-reset-requests", "4s")], "4"),
            (&[("x-ratelimit-reset-tokens", "1m2.5s")], "30"),
            (&[("x-ratelimit-reset-tokens", "0s")], "1"),
            (&[("retry-after", "private-credential")], "2"),
            (&[("x-ratelimit-reset-tokens", "soon")], "2"),
            (&[], "2"),
        ] {
            assert_eq!(
                retry_after(too_many, pairs).as_deref(),
                Some(expected),
                "{pairs:?}"
            );
        }
        // Reset headers describe rate limits only; a 503 keeps forwarding just Retry-After.
        assert_eq!(
            retry_after(
                StatusCode::SERVICE_UNAVAILABLE,
                &[("x-ratelimit-reset-tokens", "6s")]
            ),
            None
        );
    }

    #[test]
    fn stream_rate_limit_gets_the_default_delay_but_quota_exhaustion_does_not() {
        let stream = |code: &str| {
            classify(
                &UpstreamFailure::Stream {
                    code: Some(code.into()),
                    message: "private-token".into(),
                }
                .into(),
            )
        };
        let limited = stream("rate_limit_exceeded");
        assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.retry_after.unwrap(), "2");
        let quota = stream("insufficient_quota");
        assert_eq!(quota.status, StatusCode::PAYMENT_REQUIRED);
        assert!(quota.retry_after.is_none());
    }

    #[test]
    fn plan_limit_is_a_terminal_rate_limit_with_the_provider_type() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("7"));
        headers.insert("x-ratelimit-reset-tokens", HeaderValue::from_static("6s"));
        for (body, error_type, code, resets_at) in [
            (
                r#"{"error":{"type":"usage_limit_reached","message":"private-token","plan_type":"plus","resets_at":1900000000}}"#,
                "usage_limit_reached",
                "upstream_usage_limit_reached",
                Some(1_900_000_000),
            ),
            (
                r#"{"error":{"code":"usage_limit_reached","resets_at":-5}}"#,
                "usage_limit_reached",
                "upstream_usage_limit_reached",
                None,
            ),
            (
                r#"{"error":{"type":"usage_not_included","resets_at":"private-token"}}"#,
                "usage_not_included",
                "upstream_usage_not_included",
                None,
            ),
        ] {
            let classified = classify(
                &UpstreamFailure::http_body(StatusCode::TOO_MANY_REQUESTS, &headers, body).into(),
            );
            assert_eq!(classified.status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            assert_eq!(classified.error_type, error_type, "{body}");
            assert_eq!(classified.code, code, "{body}");
            assert!(!classified.retryable, "{body}");
            assert!(classified.retry_after.is_none(), "{body}");
            assert_eq!(classified.resets_at, resets_at, "{body}");
        }
        // Quota exhaustion keeps its 402 even when a plan code is also present.
        let quota = classify(
            &UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                r#"{"error":{"type":"usage_limit_reached","code":"insufficient_quota"}}"#,
            )
            .into(),
        );
        assert_eq!(quota.status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(quota.error_type, "upstream_error");
        // A plan code in free text, or on another status, is not a plan limit.
        let text = classify(
            &UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                r#"{"error":{"message":"usage_limit_reached"}}"#,
            )
            .into(),
        );
        assert!(text.retryable);
        assert_eq!(text.error_type, "upstream_error");
        assert_eq!(text.code, "upstream_rate_limit");
        let forbidden = classify(
            &UpstreamFailure::http_body(
                StatusCode::FORBIDDEN,
                &HeaderMap::new(),
                r#"{"error":{"type":"usage_not_included"}}"#,
            )
            .into(),
        );
        assert_eq!(forbidden.error_type, "upstream_error");
        assert_eq!(forbidden.code, "upstream_access_denied");
        for (code, error_type) in [
            ("usage_limit_reached", "upstream_usage_limit_reached"),
            ("usage_not_included", "upstream_usage_not_included"),
        ] {
            let stream = classify(
                &UpstreamFailure::Stream {
                    code: Some(code.into()),
                    message: "private-token".into(),
                }
                .into(),
            );
            assert_eq!(stream.status, StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(stream.error_type, code);
            assert_eq!(stream.code, error_type);
            assert!(!stream.retryable);
            assert!(stream.retry_after.is_none());
            assert!(stream.resets_at.is_none());
        }
    }

    #[test]
    fn opaque_tls_is_not_assumed_terminal() {
        let tls_error = native_tls::Certificate::from_der(b"invalid certificate")
            .err()
            .expect("invalid certificate");
        let classified = classify(&anyhow::Error::new(tls_error).context("failed TLS handshake"));
        assert_eq!(classified.status, StatusCode::BAD_GATEWAY);
        assert!(classified.retryable);
    }

    #[tokio::test]
    async fn malformed_request_configuration_is_terminal() {
        let error = reqwest::Client::new()
            .post("https://[invalid")
            .send()
            .await
            .unwrap_err();
        assert!(error.is_builder());
        let classified = classify(&error.into());
        assert_eq!(classified.status, StatusCode::FAILED_DEPENDENCY);
        assert!(!classified.retryable);
    }

    #[tokio::test]
    async fn timeout_and_redirect_have_distinct_typed_classification() {
        use axum::{Router, routing::post};
        use std::time::Duration;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/slow",
                post(|| async {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    "late"
                }),
            )
            .route(
                "/redirect",
                post(|| async { (StatusCode::TEMPORARY_REDIRECT, [("location", "/redirect")]) }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let timeout = reqwest::Client::builder()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap()
            .post(format!("{base}/slow"))
            .send()
            .await
            .unwrap_err();
        let response = classify(&anyhow::Error::new(timeout).context("request failed"));
        assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(response.code, "upstream_timeout");
        assert!(response.retryable);
        let redirect = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(1))
            .build()
            .unwrap()
            .post(format!("{base}/redirect"))
            .send()
            .await
            .unwrap_err();
        let response = classify(&redirect.into());
        assert_eq!(response.status, StatusCode::FAILED_DEPENDENCY);
        assert_eq!(response.code, "upstream_configuration_error");
        assert!(!response.retryable);
        server.abort();
    }

    #[test]
    fn provider_text_does_not_classify_quota_or_credential_failure() {
        let error = UpstreamFailure::http_body(
            StatusCode::TOO_MANY_REQUESTS,
            &HeaderMap::new(),
            r#"{"error":{"message":"insufficient_quota controller credential lease renewal failed"}}"#,
        );
        let classified = classify(&error.into());
        assert_eq!(classified.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(classified.retryable);
        let classified = classify(&anyhow::anyhow!(
            "controller credential lease renewal failed token_expired"
        ));
        assert_eq!(classified.status, StatusCode::BAD_GATEWAY);
        assert!(classified.retryable);
    }
}
