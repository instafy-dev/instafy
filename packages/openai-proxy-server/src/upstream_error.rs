//! Typed upstream failures. Public responses never echo provider bodies, URLs or credentials.

use std::fmt;

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

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
}

impl UpstreamFailure {
    pub(crate) fn http_body(status: StatusCode, headers: &HeaderMap, body: &str) -> Self {
        // Quota exhaustion is not a rate limit that can recover within the same job.
        // Only a structured provider code qualifies; arbitrary body text never does.
        if status == StatusCode::TOO_MANY_REQUESTS
            && serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .as_ref()
                .is_some_and(|body| {
                    ["/error/code", "/error/type"].iter().any(|field| {
                        body.pointer(field).and_then(serde_json::Value::as_str)
                            == Some("insufficient_quota")
                    })
                })
        {
            return Self::Stream {
                code: Some("insufficient_quota".into()),
                message: "Upstream quota exhausted.".into(),
            };
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
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    pub retry_after: Option<HeaderValue>,
}

impl ErrorResponse {
    fn new(status: StatusCode, code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            status,
            code,
            message,
            retryable,
            retry_after: None,
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
                response.retry_after = retry_after.clone();
                response
            }
            UpstreamFailure::Stream { code, .. } => match code.as_deref() {
                Some("insufficient_quota") => ErrorResponse::new(
                    StatusCode::PAYMENT_REQUIRED,
                    "upstream_insufficient_quota",
                    "The upstream provider has no available quota.",
                    false,
                ),
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
    ErrorResponse::new(
        status,
        code,
        message,
        status.is_server_error()
            || matches!(
                status,
                StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
            ),
    )
}

fn normalized_retry_after(status: StatusCode, headers: &HeaderMap) -> Option<HeaderValue> {
    if !matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
    ) {
        return None;
    }
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
            .post("http://[invalid")
            .send()
            .await
            .unwrap_err();
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
