//! Typed upstream failures. Public responses never echo provider bodies, URLs or credentials.

use std::fmt;
use std::time::{Duration, SystemTime};

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
use serde_json::{Value, json};
use uuid::Uuid;

/// Delay a rate-limited client is told to wait when the provider gave no usable hint. It keeps
/// the client-side retry from landing in the same provider window without stalling a turn.
/// Codex waits the same when a retryable 429 carries no Retry-After
/// (`INSTAFY_RETRYABLE_429_DEFAULT_DELAY` in codex/codex-rs/codex-api/src/api_bridge.rs), and
/// because this default always fills that gap, change both together.
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS: u64 = 5;
/// Bounds for a delay the proxy derives from x-ratelimit-reset-* headers. Those headers report
/// when a whole bucket refills, which can be minutes away, and the client sleeps for whatever
/// it is given. A zero reset would send the retry straight back into the exhausted window. A
/// streamed rate limit keeps its wait within the same bounds.
const MIN_DERIVED_RETRY_AFTER_SECS: u64 = 1;
const MAX_DERIVED_RETRY_AFTER_SECS: u64 = 30;
/// The provider's error code that codex reads, in a `response.failed` event, as a retryable rate
/// limit. It waits the delay the message gives after "try again in" before it sends again.
const STREAM_RATE_LIMIT_CODE: &str = "rate_limit_exceeded";
/// Managed runtimes share one upstream key, so turns that hit the same limit get the same delay
/// and would all retry at the same instant. A streamed rate limit asks each to wait up to this
/// much longer, never shorter, within the 30 second bound. Codex spread an HTTP 429's retry the
/// same way (`INSTAFY_RETRYABLE_429_MAX_JITTER_PERCENT` in codex-api/src/api_bridge.rs).
const STREAM_RATE_LIMIT_MAX_JITTER_PERCENT: u32 = 20;
/// Reset beyond which the exhausted bucket is not worth waiting for. A per-minute bucket is
/// completely full again within about a minute, while a daily requests or tokens limit reports
/// hours. The client's retries within a turn cover roughly five 30 second waits, so a bucket that
/// needs more than twice that to refill would only spend the turn's retries and then fail anyway.
const LONG_RATE_LIMIT_WINDOW_SECS: u64 = 5 * 60;

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
    /// A 429 whose exhausted rate-limit bucket refills later than LONG_RATE_LIMIT_WINDOW_SECS.
    RateLimitWindow {
        resets_in_secs: u64,
    },
}

/// A ChatGPT plan limit. Unlike a rate limit, a retry within the same turn can only fail again:
/// a spent usage window reopens only when the plan's window rolls over, hours or days later,
/// and usage the plan does not include never becomes available by waiting.
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
        let retry_after = match status {
            // A valid provider Retry-After is forwarded without a bound; only a delay the proxy
            // derives is clamped.
            StatusCode::TOO_MANY_REQUESTS => match forwarded_retry_after(headers) {
                Some(retry_after) => Some(retry_after),
                None => match limiting_bucket_reset(headers) {
                    Some(reset) if reset.identified && reset.secs > LONG_RATE_LIMIT_WINDOW_SECS => {
                        return Self::RateLimitWindow {
                            resets_in_secs: reset.secs,
                        };
                    }
                    reset => reset.map(|reset| {
                        HeaderValue::from(
                            reset
                                .secs
                                .clamp(MIN_DERIVED_RETRY_AFTER_SECS, MAX_DERIVED_RETRY_AFTER_SECS),
                        )
                    }),
                },
            },
            StatusCode::SERVICE_UNAVAILABLE => forwarded_retry_after(headers),
            _ => None,
        };
        Self::Http {
            status,
            retry_after,
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
            Self::RateLimitWindow { resets_in_secs } => {
                write!(f, "upstream rate limit window resets in {resets_in_secs}s")
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

    /// For a transient upstream rate limit, the `error` of the `response.failed` event a
    /// streaming Responses request gets instead of an HTTP 429: code `rate_limit_exceeded`, and a
    /// message that ends "Please try again in {d}s.", which codex retries after `d` seconds
    /// within its stream retry budget. Upstream codex does not retry an HTTP 429 by itself (only
    /// the pinned fork's own patch does), so the stream is what keeps a short rate limit from
    /// ending the turn. `d` is the Retry-After this
    /// response carries, the provider's own or the one the proxy derived, or 5 seconds, clamped
    /// to 1-30 seconds and spread by up to 20% (see [`stream_retry_delay`]). The message keeps
    /// this response's own words and code, which the Studio and the runtime match on.
    ///
    /// `None` for every other failure, a plan limit and a rate limit window too long to wait out
    /// among them: those stay the HTTP error they are today.
    pub(crate) fn stream_rate_limit_error(&self, now: SystemTime, jitter: f64) -> Option<Value> {
        if self.status != StatusCode::TOO_MANY_REQUESTS
            || self.code != "upstream_rate_limit"
            || !self.retryable
        {
            return None;
        }
        let delay = stream_retry_delay(self.retry_after.as_ref(), now, jitter);
        Some(json!({
            "code": STREAM_RATE_LIMIT_CODE,
            "message": format!(
                "{} ({}, {}). Please try again in {}s.",
                self.message.trim_end_matches('.'),
                self.code,
                self.status.as_u16(),
                format_delay_seconds(delay),
            ),
        }))
    }
}

/// The wait a streamed rate limit asks for. The Retry-After, whole seconds or an HTTP date, is
/// clamped to 1-30 seconds; without a readable one the wait is 5 seconds. `jitter`, a sample
/// from [0, 1], then spreads it by up to 20% so runtimes sharing a key do not all retry at once:
/// below the 30 second bound the spread only lengthens the wait, into the room left under the
/// bound; a Retry-After of 30 seconds or more is already cut short, so its spread goes below the
/// bound instead of pinning every retry to exactly 30 seconds. This is how codex spread an HTTP
/// 429's retry (`instafy_retryable_429_delay` in codex-api/src/api_bridge.rs).
fn stream_retry_delay(retry_after: Option<&HeaderValue>, now: SystemTime, jitter: f64) -> Duration {
    let asked = retry_after
        .and_then(|value| retry_after_delay(value, now))
        .unwrap_or(Duration::from_secs(DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS));
    let max = Duration::from_secs(MAX_DERIVED_RETRY_AFTER_SECS);
    let requested = asked.clamp(Duration::from_secs(MIN_DERIVED_RETRY_AFTER_SECS), max);
    let jitter = if jitter.is_finite() {
        jitter.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let max_spread = requested * STREAM_RATE_LIMIT_MAX_JITTER_PERCENT / 100;
    if asked >= max {
        return max - max_spread.mul_f64(jitter);
    }
    let room = max_spread.min(max - requested);
    requested + room.mul_f64(jitter)
}

/// A Retry-After the proxy forwards or derives, whole seconds or an HTTP date, as a delay from
/// `now`. A date already past is no delay, and a partial second rounds up.
fn retry_after_delay(value: &HeaderValue, now: SystemTime) -> Option<Duration> {
    let value = value.to_str().ok()?.trim();
    if !value.is_empty() && value.bytes().all(|ch| ch.is_ascii_digit()) {
        return value.parse::<u64>().ok().map(Duration::from_secs);
    }
    let delay = httpdate::parse_http_date(value)
        .ok()?
        .duration_since(now)
        .unwrap_or(Duration::ZERO);
    Some(Duration::from_secs(
        delay.as_secs() + u64::from(delay.subsec_nanos() > 0),
    ))
}

/// `delay` in seconds, to the millisecond, the way codex reads it back from "try again in
/// {d}s" (a number of seconds with an optional fraction): whole seconds without a fraction, and
/// a fraction without trailing zeros. Codex then waits exactly the delay the message states.
fn format_delay_seconds(delay: Duration) -> String {
    let millis = (delay.as_secs_f64() * 1000.0).round() as u64;
    let (secs, millis) = (millis / 1000, millis % 1000);
    if millis == 0 {
        return secs.to_string();
    }
    format!("{secs}.{millis:03}")
        .trim_end_matches('0')
        .to_string()
}

/// A uniform sample from [0, 1] for spreading retries. The leading bytes of a v4 UUID are
/// random, and the proxy already makes v4 UUIDs, so the spread needs no new dependency.
pub(crate) fn retry_jitter_sample() -> f64 {
    let bytes = Uuid::new_v4().into_bytes();
    let sample = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    f64::from(sample) / f64::from(u32::MAX)
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
            // Still a rate limit to the client, which words it as one, but with no retry: every
            // retry the client could make would land inside the same exhausted window.
            UpstreamFailure::RateLimitWindow { .. } => {
                let mut response = classify_http(StatusCode::TOO_MANY_REQUESTS);
                response.retryable = false;
                response.retry_after = None;
                response
            }
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
/// no wait within the turn can lift it, and a client that retried would only spend its retry
/// budget and then report a generic rate limit instead of the plan limit.
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

/// When the rate-limit bucket behind a 429 is completely full again, in whole seconds.
struct BucketReset {
    secs: u64,
    /// Whether x-ratelimit-remaining-* showed a bucket at zero. Otherwise the later reset is
    /// only a safe wait, not proof that the slower bucket is the one that refused.
    identified: bool,
}

/// OpenAI often answers a rate limit without Retry-After but reports, per bucket, how much is
/// left and when the bucket is full again. A bucket whose remaining count is zero refused the
/// request; when both are zero, the later reset is the first moment either could succeed. A
/// tokens bucket with some room left can still refuse a large request, so a count above zero,
/// or no count at all, proves nothing, and the later of the two resets covers whichever limit
/// was hit.
fn limiting_bucket_reset(headers: &HeaderMap) -> Option<BucketReset> {
    let header = |name: &str| headers.get(name)?.to_str().ok();
    let reset = |name: &str| header(name).and_then(reset_duration_secs);
    let exhausted =
        |name: &str| header(name).and_then(|value| value.trim().parse::<u64>().ok()) == Some(0);
    let requests = reset("x-ratelimit-reset-requests");
    let tokens = reset("x-ratelimit-reset-tokens");
    let (secs, identified) = match (
        exhausted("x-ratelimit-remaining-requests"),
        exhausted("x-ratelimit-remaining-tokens"),
    ) {
        (true, true) => (requests.max(tokens), true),
        (true, false) => (requests, true),
        (false, true) => (tokens, true),
        (false, false) => (requests.max(tokens), false),
    };
    Some(BucketReset {
        secs: secs?,
        identified,
    })
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

    fn http_retry_after(status: StatusCode, headers: &HeaderMap) -> Option<String> {
        match UpstreamFailure::http(status, headers, false) {
            UpstreamFailure::Http { retry_after, .. } => {
                retry_after.map(|value| value.to_str().unwrap().to_owned())
            }
            other => panic!("unexpected failure: {other:?}"),
        }
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
                http_retry_after(StatusCode::TOO_MANY_REQUESTS, &headers).as_deref(),
                expected
            );
            assert!(http_retry_after(StatusCode::UNAUTHORIZED, &headers).is_none());
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

    fn classify_headers(
        status: StatusCode,
        pairs: &[(&'static str, &'static str)],
    ) -> ErrorResponse {
        let mut headers = HeaderMap::new();
        for &(name, value) in pairs {
            headers.insert(name, HeaderValue::from_static(value));
        }
        classify(&UpstreamFailure::http_body(status, &headers, "{}").into())
    }

    #[test]
    fn rate_limit_without_retry_after_derives_a_bounded_delay() {
        let retry_after = |status, pairs: &[(&'static str, &'static str)]| {
            classify_headers(status, pairs)
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
            (&[("retry-after", "private-credential")], "5"),
            (&[("x-ratelimit-reset-tokens", "soon")], "5"),
            (&[], "5"),
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
    fn rate_limit_delay_follows_the_bucket_that_ran_out() {
        let retry_after = |pairs: &[(&'static str, &'static str)]| {
            let response = classify_headers(StatusCode::TOO_MANY_REQUESTS, pairs);
            assert!(response.retryable, "{pairs:?}");
            response
                .retry_after
                .map(|value| value.to_str().unwrap().to_owned())
        };
        let resets = [
            ("x-ratelimit-reset-requests", "8s"),
            ("x-ratelimit-reset-tokens", "20s"),
        ];
        let with = |remaining: &[(&'static str, &'static str)]| [&resets[..], remaining].concat();
        for (pairs, expected) in [
            // Requests are left, so the tokens bucket refused, even when its reset is shorter.
            (
                vec![
                    ("x-ratelimit-remaining-requests", "12"),
                    ("x-ratelimit-remaining-tokens", "0"),
                    ("x-ratelimit-reset-requests", "20s"),
                    ("x-ratelimit-reset-tokens", "6s"),
                ],
                "6",
            ),
            // The tokens bucket alone at zero is identified without a requests count.
            (
                vec![
                    ("x-ratelimit-remaining-tokens", "0"),
                    ("x-ratelimit-reset-requests", "20s"),
                    ("x-ratelimit-reset-tokens", "6s"),
                ],
                "6",
            ),
            (
                with(&[
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-remaining-tokens", "5000"),
                ]),
                "8",
            ),
            (with(&[("x-ratelimit-remaining-requests", "0")]), "8"),
            (
                with(&[
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-remaining-tokens", "0"),
                ]),
                "20",
            ),
            // With no bucket at zero, the later reset covers either one. A tokens bucket with
            // room left can still refuse a large request, so it is not trusted on its own.
            (resets.to_vec(), "20"),
            (with(&[("x-ratelimit-remaining-requests", "3")]), "20"),
            (
                vec![
                    ("x-ratelimit-remaining-requests", "12"),
                    ("x-ratelimit-remaining-tokens", "5000"),
                    ("x-ratelimit-reset-requests", "20s"),
                    ("x-ratelimit-reset-tokens", "6s"),
                ],
                "20",
            ),
            (with(&[("x-ratelimit-remaining-requests", "many")]), "20"),
            (with(&[("x-ratelimit-remaining-requests", "-1")]), "20"),
            // An exhausted bucket with no readable reset gets the default, not the other reset.
            (
                vec![
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-reset-tokens", "20s"),
                ],
                "5",
            ),
            // A reset of up to five minutes is still waited out, bounded to the longest delay.
            (
                vec![
                    ("x-ratelimit-remaining-requests", "12"),
                    ("x-ratelimit-remaining-tokens", "0"),
                    ("x-ratelimit-reset-tokens", "5m0s"),
                ],
                "30",
            ),
        ] {
            assert_eq!(retry_after(&pairs).as_deref(), Some(expected), "{pairs:?}");
        }
    }

    #[test]
    fn rate_limit_window_longer_than_five_minutes_is_not_retried() {
        for pairs in [
            &[
                ("x-ratelimit-remaining-requests", "0"),
                ("x-ratelimit-remaining-tokens", "5000"),
                ("x-ratelimit-reset-requests", "13h20m0s"),
                ("x-ratelimit-reset-tokens", "6s"),
            ][..],
            &[
                ("x-ratelimit-remaining-requests", "12"),
                ("x-ratelimit-remaining-tokens", "0"),
                ("x-ratelimit-reset-requests", "1s"),
                ("x-ratelimit-reset-tokens", "13h20m0s"),
            ],
            &[
                ("x-ratelimit-remaining-requests", "0"),
                ("x-ratelimit-remaining-tokens", "0"),
                ("x-ratelimit-reset-requests", "6s"),
                ("x-ratelimit-reset-tokens", "5m1s"),
            ],
            &[
                ("x-ratelimit-remaining-tokens", "0"),
                ("x-ratelimit-reset-tokens", "45m0s"),
            ],
            // Pinned on purpose: the 6m0s tokens reset from OpenAI's documentation example ends
            // the turn. A per-minute tokens bucket is full again within about a minute, so a reset
            // this long means a longer window such as a daily token limit.
            &[
                ("x-ratelimit-remaining-requests", "12"),
                ("x-ratelimit-remaining-tokens", "0"),
                ("x-ratelimit-reset-tokens", "6m0s"),
            ],
        ] {
            let response = classify_headers(StatusCode::TOO_MANY_REQUESTS, pairs);
            assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS, "{pairs:?}");
            assert_eq!(response.error_type, "upstream_error", "{pairs:?}");
            assert_eq!(response.code, "upstream_rate_limit", "{pairs:?}");
            assert!(!response.retryable, "{pairs:?}");
            assert!(response.retry_after.is_none(), "{pairs:?}");
        }
        for (pairs, expected) in [
            // A window of exactly five minutes is not longer than the horizon.
            (
                &[
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-reset-requests", "5m0s"),
                ][..],
                "30",
            ),
            // No bucket is at zero, so a daily bucket's long reset proves nothing.
            (
                &[
                    ("x-ratelimit-remaining-requests", "400"),
                    ("x-ratelimit-remaining-tokens", "5000"),
                    ("x-ratelimit-reset-requests", "13h20m0s"),
                    ("x-ratelimit-reset-tokens", "20s"),
                ],
                "30",
            ),
            // The long window belongs to a bucket that still has room.
            (
                &[
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-remaining-tokens", "5000"),
                    ("x-ratelimit-reset-requests", "6s"),
                    ("x-ratelimit-reset-tokens", "13h20m0s"),
                ],
                "6",
            ),
            // Without remaining counts nothing shows that the long bucket is the empty one.
            (&[("x-ratelimit-reset-requests", "13h20m0s")], "30"),
            // The provider's own Retry-After is forwarded as sent.
            (
                &[
                    ("retry-after", "7"),
                    ("x-ratelimit-remaining-requests", "0"),
                    ("x-ratelimit-reset-requests", "13h20m0s"),
                ],
                "7",
            ),
        ] {
            let response = classify_headers(StatusCode::TOO_MANY_REQUESTS, pairs);
            assert!(response.retryable, "{pairs:?}");
            assert_eq!(
                response
                    .retry_after
                    .map(|value| value.to_str().unwrap().to_owned())
                    .as_deref(),
                Some(expected),
                "{pairs:?}"
            );
        }
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
        assert_eq!(limited.retry_after.unwrap(), "5");
        let quota = stream("insufficient_quota");
        assert_eq!(quota.status, StatusCode::PAYMENT_REQUIRED);
        assert!(quota.retry_after.is_none());
    }

    /// The delay a streamed rate limit's message states, as codex reads it back: the number
    /// after "try again in", in seconds.
    fn stated_delay(error: &Value) -> String {
        let message = error["message"].as_str().expect("message");
        let prefix = "The upstream provider rate limit was reached (upstream_rate_limit, 429). \
                      Please try again in ";
        message
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix("s."))
            .unwrap_or_else(|| panic!("unexpected message: {message}"))
            .to_owned()
    }

    #[test]
    fn a_transient_rate_limit_streams_as_rate_limit_exceeded_with_its_wait() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let error = classify_headers(StatusCode::TOO_MANY_REQUESTS, &[("retry-after", "7")])
            .stream_rate_limit_error(now, 0.0)
            .expect("a transient rate limit streams");
        assert_eq!(
            error,
            json!({
                "code": "rate_limit_exceeded",
                "message": "The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 7s.",
            })
        );
        // The Studio and the runtime recognise the proxy's rate limit by these words.
        let message = error["message"].as_str().unwrap();
        assert!(message.contains("upstream_rate_limit"));
        assert!(message.contains("rate limit was reached"));
    }

    #[test]
    fn a_streamed_rate_limit_wait_is_clamped_defaulted_and_spread_upwards() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_400);
        let date =
            |secs: u64| httpdate::fmt_http_date(SystemTime::UNIX_EPOCH + Duration::from_secs(secs));
        let in_ten_seconds = date(1_700_000_010);
        let passed = date(1_699_999_000);
        let delay = |pairs: &[(&'static str, &str)], jitter: f64| {
            let mut headers = HeaderMap::new();
            for &(name, value) in pairs {
                headers.insert(name, HeaderValue::from_str(value).unwrap());
            }
            let classified = classify(
                &UpstreamFailure::http_body(StatusCode::TOO_MANY_REQUESTS, &headers, "{}").into(),
            );
            stated_delay(&classified.stream_rate_limit_error(now, jitter).unwrap())
        };
        for (pairs, jitter, expected) in [
            // The provider's Retry-After, spread by up to 20%.
            (&[("retry-after", "7")][..], 0.0, "7"),
            (&[("retry-after", "7")], 0.5, "7.7"),
            (&[("retry-after", "7")], 1.0, "8.4"),
            // No usable hint: 5 seconds.
            (&[], 0.0, "5"),
            (&[], 1.0, "6"),
            (&[("retry-after", "private-credential")], 1.0, "6"),
            // A delay the proxy derived from the bucket that ran out.
            (&[("x-ratelimit-reset-tokens", "6s")], 1.0, "7.2"),
            // Clamped to at least a second.
            (&[("retry-after", "0")], 0.0, "1"),
            (&[("retry-after", "0")], 1.0, "1.2"),
            (&[("retry-after", passed.as_str())], 0.25, "1.05"),
            // An HTTP date is a wait from now, a partial second rounded up.
            (&[("retry-after", in_ten_seconds.as_str())], 0.0, "10"),
            // The spread never takes a wait past 30 seconds.
            (&[("retry-after", "29")], 0.5, "29.5"),
            (&[("retry-after", "29")], 1.0, "30"),
            // A wait of 30 seconds or more is cut to 30 and spreads below it.
            (&[("retry-after", "30")], 0.0, "30"),
            (&[("retry-after", "120")], 0.0, "30"),
            (&[("retry-after", "120")], 0.5, "27"),
            (&[("retry-after", "120")], 1.0, "24"),
            // A sample outside [0, 1] is held to it.
            (&[("retry-after", "7")], -1.0, "7"),
            (&[("retry-after", "7")], 2.0, "8.4"),
            (&[("retry-after", "7")], f64::NAN, "7"),
            // Rounded to the millisecond, as codex reads it back.
            (&[("retry-after", "7")], 1.0 / 3.0, "7.467"),
        ] {
            assert_eq!(delay(pairs, jitter), expected, "{pairs:?} {jitter}");
        }
        // A rate limit reported inside the upstream stream carries no headers.
        let stream = classify(
            &UpstreamFailure::Stream {
                code: Some("rate_limit_exceeded".into()),
                message: "private-token".into(),
            }
            .into(),
        );
        let error = stream.stream_rate_limit_error(now, 0.0).unwrap();
        assert_eq!(stated_delay(&error), "5");
        assert!(!error.to_string().contains("private-token"), "{error}");
    }

    #[test]
    fn a_streamed_rate_limit_wait_stays_within_its_spread_for_any_sample() {
        let now = SystemTime::UNIX_EPOCH;
        for (retry_after, low, high) in [
            ("1", 1.0, 1.2),
            ("5", 5.0, 6.0),
            ("26", 26.0, 30.0),
            ("600", 24.0, 30.0),
        ] {
            let classified = classify_headers(
                StatusCode::TOO_MANY_REQUESTS,
                &[("retry-after", retry_after)],
            );
            for _ in 0..500 {
                let sample = retry_jitter_sample();
                assert!((0.0..=1.0).contains(&sample), "{sample}");
                let error = classified.stream_rate_limit_error(now, sample).unwrap();
                let stated = stated_delay(&error);
                // Codex parses the stated number back into the wait it sleeps.
                let seconds = stated.parse::<f64>().expect("a number of seconds");
                assert!(
                    (low..=high).contains(&seconds),
                    "{retry_after}: {stated} not within {low}..={high}"
                );
                let (_, fraction) = stated.split_once('.').unwrap_or((stated.as_str(), ""));
                assert!(fraction.len() <= 3 && !fraction.ends_with('0'), "{stated}");
            }
        }
    }

    #[test]
    fn only_a_transient_rate_limit_streams() {
        let now = SystemTime::UNIX_EPOCH;
        let mut plan_headers = HeaderMap::new();
        plan_headers.insert(RETRY_AFTER, HeaderValue::from_static("7"));
        for failure in [
            // A plan limit stays the terminal HTTP 429 it is today.
            UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &plan_headers,
                r#"{"error":{"type":"usage_limit_reached","resets_at":1900000000}}"#,
            ),
            UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &plan_headers,
                r#"{"error":{"type":"usage_not_included"}}"#,
            ),
            UpstreamFailure::Stream {
                code: Some("usage_limit_reached".into()),
                message: "private-token".into(),
            },
            // So does a window too long to wait out, and quota exhaustion.
            UpstreamFailure::RateLimitWindow {
                resets_in_secs: 3_600,
            },
            UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                r#"{"error":{"code":"insufficient_quota"}}"#,
            ),
            UpstreamFailure::http(StatusCode::SERVICE_UNAVAILABLE, &plan_headers, false),
            UpstreamFailure::http(StatusCode::UNAUTHORIZED, &HeaderMap::new(), false),
            UpstreamFailure::InvalidResponse,
        ] {
            let classified = classify(&anyhow::Error::new(failure));
            assert!(
                classified.stream_rate_limit_error(now, 0.5).is_none(),
                "{:?}",
                classified.code
            );
        }
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
