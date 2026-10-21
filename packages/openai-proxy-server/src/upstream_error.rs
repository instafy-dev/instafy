//! Typed upstream failures. Public responses never echo provider bodies, URLs or credentials.

use std::fmt;
use std::time::{Duration, SystemTime};

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

/// Delay a rate-limited client is told to wait when the provider gave no usable hint. It keeps
/// the client-side retry from landing in the same provider window without stalling a turn. It is
/// the `Retry-After` of a retryable 429 that had none, and the base wait of a streamed rate limit
/// without one (see [`stream_retry_delay`]).
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS: u64 = 5;
/// Bounds for a delay the proxy derives from x-ratelimit-reset-* headers. Those headers report
/// when a whole bucket refills, which can be minutes away, and the client sleeps for whatever
/// it is given. A zero reset would send the retry straight back into the exhausted window.
/// These bounds do not shorten the provider's explicit Retry-After.
const MIN_DERIVED_RETRY_AFTER_SECS: u64 = 1;
const MAX_DERIVED_RETRY_AFTER_SECS: u64 = 30;
/// The provider's error code that codex reads, in a `response.failed` event, as a retryable rate
/// limit. It waits the delay the message gives after "try again in" before it sends again.
const STREAM_RATE_LIMIT_CODE: &str = "rate_limit_exceeded";
/// Managed runtimes share one upstream key, so turns that hit the same limit get the same delay
/// and would all retry at the same instant. A streamed rate limit asks each to wait up to this
/// much longer, never shorter, within the 30 second bound. Longer provider waits are unchanged.
const STREAM_RATE_LIMIT_MAX_JITTER_PERCENT: u32 = 20;
/// Reset beyond which the exhausted bucket is not worth waiting for. A per-minute bucket is
/// completely full again within about a minute, while a daily requests or tokens limit reports
/// hours. The client's retries within a turn cover roughly five 30 second waits, so a bucket that
/// needs more than twice that to refill would only spend the turn's retries and then fail anyway.
const LONG_RATE_LIMIT_WINDOW_SECS: u64 = 5 * 60;
/// The OpenAI error `param` values that name a request's tool controls.
const TOOL_CONTROL_PARAMS: [&str; 2] = ["tool_choice", "tools"];
/// Most characters of a provider error code, type or param that a [`ProviderError`] keeps.
const MAX_PROVIDER_IDENTIFIER_CHARS: usize = 64;
/// Most characters of a provider error message that a [`ProviderError`] keeps for the log.
const MAX_PROVIDER_MESSAGE_CHARS: usize = 200;
/// A logged provider message masks every run of at least this many characters that could
/// belong to a key or token. API keys, access tokens and JWTs are longer; words and model ids
/// are shorter.
const MIN_MASKED_RUN_CHARS: usize = 32;

/// How an upstream request failed, as far as the answer the client gets goes. A failure the
/// provider described also carries what it said, as a [`ProviderError`] context
/// ([`provider_error`]).
#[derive(Debug)]
pub(crate) enum UpstreamFailure {
    Http {
        status: StatusCode,
        retry_after: Option<HeaderValue>,
        refreshable_auth: bool,
        /// Set only for a 400 whose provider error blames the tool controls
        /// ([`body_blames_tool_controls`]).
        blames_tool_controls: bool,
    },
    CredentialRefresh,
    InvalidResponse,
    /// A failure the provider named by its code: a failed stream, or a 429 whose code or type
    /// is `insufficient_quota`.
    Stream {
        code: Option<String>,
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
    /// The plan limit a provider error names by its code or its type.
    fn named_by(error: &ProviderError) -> Option<Self> {
        [Self::UsageLimitReached, Self::UsageNotIncluded]
            .into_iter()
            .find(|limit| error.names(limit.provider_code()))
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

/// Why a provider says it refused a request, read from the error object of its error body
/// ([`error_object`]): the object's `code`, `type` and `param` when they read as identifiers,
/// and its message ([`provider_message`]) on one line, cut to [`MAX_PROVIDER_MESSAGE_CHARS`]
/// and with every run of key- or token-like characters masked. A failed stream gives its code
/// and message the same way. The message is for the proxy's own log only; a client gets
/// [`ProviderError::reason`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct ProviderError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    /// The error's `type`.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) param: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

impl ProviderError {
    /// What `body`, a provider's error body, says, when it says anything the proxy reads.
    fn from_body(body: &Value) -> Option<Self> {
        let object = error_object(body);
        let identifier = |field: &str| {
            object
                .get(field)
                .and_then(Value::as_str)
                .and_then(provider_identifier)
        };
        Self {
            code: identifier("code"),
            kind: identifier("type"),
            param: identifier("param"),
            message: provider_message(body).and_then(loggable_provider_message),
        }
        .said_anything()
    }

    /// What a failed stream's error says: its code and message.
    fn from_stream(code: Option<&str>, message: Option<&str>) -> Option<Self> {
        Self {
            code: code.and_then(provider_identifier),
            message: message.and_then(loggable_provider_message),
            ..Self::default()
        }
        .said_anything()
    }

    fn said_anything(self) -> Option<Self> {
        (self != Self::default()).then_some(self)
    }

    /// The error's code, or its type when it has none.
    fn code_or_type(&self) -> Option<&str> {
        self.code.as_deref().or(self.kind.as_deref())
    }

    /// Whether the error's code or its type is `name`.
    fn names(&self, name: &str) -> bool {
        [self.code.as_deref(), self.kind.as_deref()].contains(&Some(name))
    }

    /// The reason a client may see: the provider's code, or its type when it has none, and the
    /// param it names. Identifiers only, never the provider's message, which can name the
    /// operator's account or echo the request.
    pub(crate) fn reason(&self) -> Option<String> {
        match (self.code_or_type(), self.param.as_deref()) {
            (Some(what), Some(param)) => Some(format!("{what}, param {param}")),
            (Some(what), None) => Some(what.to_string()),
            (None, Some(param)) => Some(format!("param {param}")),
            (None, None) => None,
        }
    }

    /// The error without its message, for a log line that does not quote the provider.
    pub(crate) fn without_message(&self) -> Self {
        Self {
            message: None,
            ..self.clone()
        }
    }
}

/// The identifiers and the message as the log keeps it, for an error chain that is printed,
/// as the `openai-proxy-server` command prints its own failure. A client never gets it.
impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the provider said")?;
        if let Some(reason) = self.reason() {
            write!(f, " {reason}")?;
        }
        if let Some(message) = &self.message {
            write!(f, ": {message}")?;
        }
        Ok(())
    }
}

/// The error object of a provider's error body: its `error`, else its `detail`, when that is
/// an object, else the body itself.
fn error_object(body: &Value) -> &Value {
    ["error", "detail"]
        .into_iter()
        .find_map(|field| body.get(field).filter(|value| value.is_object()))
        .unwrap_or(body)
}

/// The message of a provider's error body, as the provider wrote it: its error object's
/// `message`, else a `detail` or `error` string.
fn provider_message(body: &Value) -> Option<&str> {
    fn text<'v>(value: &'v Value, field: &str) -> Option<&'v str> {
        value.get(field).and_then(Value::as_str)
    }
    text(error_object(body), "message")
        .or_else(|| text(body, "detail"))
        .or_else(|| text(body, "error"))
}

/// Whether a 400 with `body`, whose provider error is `error`, blames the request's tool
/// controls: its error object's `param` is exactly `tool_choice` or `tools`, or, with no
/// `param` at all, the error has a code (or type) and its message, as the provider wrote it,
/// names the tool choice. A `param` that names anything else, or is not an identifier, never
/// does, whatever the message says.
fn body_blames_tool_controls(body: &Value, error: &ProviderError) -> bool {
    match error_object(body).get("param") {
        None | Some(Value::Null) => {
            error.code_or_type().is_some()
                && provider_message(body).is_some_and(|message| {
                    let message = message.to_ascii_lowercase();
                    message.contains("tool_choice") || message.contains("tool choice")
                })
        }
        Some(_) => error
            .param
            .as_deref()
            .is_some_and(|param| TOOL_CONTROL_PARAMS.contains(&param)),
    }
}

/// `value`, trimmed, when it reads as a provider identifier: a code such as `model_not_found`
/// or a param such as `input[3].content`, at most [`MAX_PROVIDER_IDENTIFIER_CHARS`] long.
fn provider_identifier(value: &str) -> Option<String> {
    let value = value.trim();
    let allowed = |ch: char| ch.is_ascii_alphanumeric() || "_-.:[]".contains(ch);
    (!value.is_empty()
        && value.chars().count() <= MAX_PROVIDER_IDENTIFIER_CHARS
        && value.chars().all(allowed))
    .then(|| value.to_string())
}

/// `message` on one line, every run of at least [`MIN_MASKED_RUN_CHARS`] characters that could
/// belong to a key or token replaced with `[masked]`, cut to [`MAX_PROVIDER_MESSAGE_CHARS`].
fn loggable_provider_message(message: &str) -> Option<String> {
    let token_char = |ch: char| ch.is_ascii_alphanumeric() || "-_.+/=*".contains(ch);
    let mut line = String::new();
    let mut run = String::new();
    let end_run = |line: &mut String, run: &mut String| {
        if run.chars().count() >= MIN_MASKED_RUN_CHARS {
            line.push_str("[masked]");
        } else {
            line.push_str(run);
        }
        run.clear();
    };
    for ch in message.chars() {
        if token_char(ch) {
            run.push(ch);
            continue;
        }
        end_run(&mut line, &mut run);
        if ch.is_whitespace() || ch.is_control() {
            if !line.is_empty() && !line.ends_with(' ') {
                line.push(' ');
            }
        } else {
            line.push(ch);
        }
    }
    end_run(&mut line, &mut run);
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }
    let mut chars = line.chars();
    let kept = chars
        .by_ref()
        .take(MAX_PROVIDER_MESSAGE_CHARS)
        .collect::<String>();
    Some(if chars.next().is_some() {
        format!("{kept}…")
    } else {
        kept
    })
}

impl UpstreamFailure {
    /// The failure an HTTP error answer stands for, carrying what its body says
    /// ([`ProviderError`]). The body is read once, and only its error object's identifiers
    /// decide anything, never its text: a 429 whose code or type is `insufficient_quota` is
    /// quota exhaustion and one whose code or type names a plan limit is that limit, and a 400
    /// may blame the tool controls ([`body_blames_tool_controls`]).
    pub(crate) fn http_body(status: StatusCode, headers: &HeaderMap, body: &str) -> anyhow::Error {
        let refreshable_auth = crate::auth::response_indicates_chatgpt_token_expired(status, body);
        let body = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
        let said = ProviderError::from_body(&body);
        let said_in_429 = said
            .as_ref()
            .filter(|_| status == StatusCode::TOO_MANY_REQUESTS);
        let failure = if said_in_429.is_some_and(|said| said.names("insufficient_quota")) {
            // Quota exhaustion is not a rate limit that can recover within the same job.
            Self::Stream {
                code: Some("insufficient_quota".into()),
            }
        } else if let Some(limit) = said_in_429.and_then(PlanLimit::named_by) {
            Self::PlanLimit {
                limit,
                // A validated reset time lets the client say when to try again.
                resets_at: error_object(&body)
                    .get("resets_at")
                    .and_then(Value::as_i64)
                    .filter(|seconds| *seconds > 0),
            }
        } else {
            let mut failure = Self::http(status, headers, refreshable_auth);
            if let Self::Http {
                blames_tool_controls,
                ..
            } = &mut failure
            {
                *blames_tool_controls = status == StatusCode::BAD_REQUEST
                    && said
                        .as_ref()
                        .is_some_and(|said| body_blames_tool_controls(&body, said));
            }
            failure
        };
        failure.carrying(said)
    }

    /// The failure a `response.failed` event reports, carrying its code and message, when it
    /// gave them.
    pub(crate) fn stream(code: Option<&str>, message: Option<&str>) -> anyhow::Error {
        Self::Stream {
            code: code.map(str::to_string),
        }
        .carrying(ProviderError::from_stream(code, message))
    }

    /// This failure as an error, with what the provider said, if anything, as its context.
    fn carrying(self, said: Option<ProviderError>) -> anyhow::Error {
        let error = anyhow::Error::new(self);
        match said {
            Some(said) => error.context(said),
            None => error,
        }
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
            blames_tool_controls: false,
        }
    }
}

impl fmt::Display for UpstreamFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, .. } => write!(f, "upstream returned {status}"),
            Self::CredentialRefresh => f.write_str("upstream credential refresh failed"),
            Self::InvalidResponse => f.write_str("invalid upstream response"),
            Self::Stream { code } => {
                f.write_str("upstream reported a failure")?;
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

/// What the provider said about the failure `error` carries, when it said anything the proxy
/// reads: an HTTP rejection's error body ([`UpstreamFailure::http_body`]) or a failed stream's
/// code and message ([`UpstreamFailure::stream`]).
pub(crate) fn provider_error(error: &anyhow::Error) -> Option<&ProviderError> {
    error.downcast_ref::<ProviderError>()
}

/// What the provider said, when `error` is a 400 whose provider error blames the tool
/// controls ([`body_blames_tool_controls`]).
pub(crate) fn tool_control_rejection(error: &anyhow::Error) -> Option<&ProviderError> {
    match error.downcast_ref::<UpstreamFailure>()? {
        UpstreamFailure::Http {
            blames_tool_controls: true,
            ..
        } => provider_error(error),
        _ => None,
    }
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
    /// within its stream retry budget. Codex does not retry an HTTP 429 by itself (its
    /// `retry_429` is off for every provider), so the stream is what keeps a short rate limit from
    /// ending the turn. `d` preserves the Retry-After this response carries, with a minimum
    /// of one second and upward-only jitter for short waits (see [`stream_retry_delay`]).
    /// Without a usable hint the wait is 5 seconds. The message keeps
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
        let seconds = format_delay_seconds(delay);
        // Codex parses this number as f64 and creates a monotonic deadline. If that cannot
        // represent the provider's whole-second minimum, retain HTTP 429 and Retry-After
        // instead of losing the hint and causing an early retry.
        let client_delay = Duration::try_from_secs_f64(seconds.parse().ok()?).ok()?;
        if client_delay < Duration::from_secs(delay.as_secs())
            || std::time::Instant::now()
                .checked_add(client_delay)
                .is_none()
        {
            return None;
        }
        Some(json!({
            "code": STREAM_RATE_LIMIT_CODE,
            "message": format!(
                "{} ({}, {}). Please try again in {}s.",
                self.message.trim_end_matches('.'),
                self.code,
                self.status.as_u16(),
                seconds,
            ),
        }))
    }
}

/// Preserve Retry-After seconds or an HTTP date as a minimum, using 5 seconds without a readable
/// hint and at least one second for zero/past hints. Derived hints are already bounded during
/// classification. `jitter`, a sample from [0, 1], only lengthens waits below 30 seconds, by up
/// to 20% within that bound. Longer provider waits are unchanged; the runtime owns cancellation
/// and its overall deadline, rather than asking the provider again before its stated wait.
fn stream_retry_delay(retry_after: Option<&HeaderValue>, now: SystemTime, jitter: f64) -> Duration {
    let asked = retry_after
        .and_then(|value| retry_after_delay(value, now))
        .unwrap_or(Duration::from_secs(DEFAULT_RATE_LIMIT_RETRY_AFTER_SECS));
    let max = Duration::from_secs(MAX_DERIVED_RETRY_AFTER_SECS);
    let requested = asked.max(Duration::from_secs(MIN_DERIVED_RETRY_AFTER_SECS));
    if requested >= max {
        return requested;
    }
    let jitter = if jitter.is_finite() {
        jitter.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let max_spread = requested * STREAM_RATE_LIMIT_MAX_JITTER_PERCENT / 100;
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
    let millis = (delay.as_nanos() + 500_000) / 1_000_000;
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
            UpstreamFailure::Stream { code } => match code.as_deref() {
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
        classify(&UpstreamFailure::http_body(status, &headers, "{}"))
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
        let stream =
            |code: &str| classify(&UpstreamFailure::stream(Some(code), Some("private-token")));
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
    fn a_streamed_rate_limit_never_shortens_the_provider_wait() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_400);
        let date =
            httpdate::fmt_http_date(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_169));
        for retry_after in ["169", date.as_str()] {
            let mut headers = HeaderMap::new();
            headers.insert(RETRY_AFTER, HeaderValue::from_str(retry_after).unwrap());
            let classified = classify(&UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                "{}",
            ));
            for jitter in [0.0, 0.5, 1.0] {
                let error = classified.stream_rate_limit_error(now, jitter).unwrap();
                assert_eq!(stated_delay(&error), "169", "{retry_after}, {jitter}");
            }
        }
    }

    #[test]
    fn a_streamed_rate_limit_wait_is_defaulted_and_spread_only_upwards() {
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
            let classified = classify(&UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                "{}",
            ));
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
            // A provider wait of 30 seconds or more is never shortened.
            (&[("retry-after", "30")], 0.0, "30"),
            (&[("retry-after", "30")], 1.0, "30"),
            (&[("retry-after", "31")], 1.0, "31"),
            (&[("retry-after", "120")], 0.0, "120"),
            (&[("retry-after", "120")], 0.5, "120"),
            (&[("retry-after", "120")], 1.0, "120"),
            // Derived waits retain their existing bound.
            (&[("x-ratelimit-reset-tokens", "120s")], 1.0, "30"),
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
        let stream = classify(&UpstreamFailure::stream(
            Some("rate_limit_exceeded"),
            Some("private-token"),
        ));
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
            ("169", 169.0, 169.0),
            ("600", 600.0, 600.0),
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
    fn an_unrepresentable_stream_wait_keeps_the_http_retry_after() {
        let retry_after = u64::MAX.to_string();
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_str(&retry_after).unwrap());
        let classified = classify(&UpstreamFailure::http_body(
            StatusCode::TOO_MANY_REQUESTS,
            &headers,
            "{}",
        ));
        assert!(
            classified
                .stream_rate_limit_error(SystemTime::UNIX_EPOCH, 1.0)
                .is_none()
        );
        assert_eq!(classified.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            classified.retry_after.as_ref().unwrap().to_str().unwrap(),
            retry_after
        );
        assert_eq!(
            format_delay_seconds(Duration::from_secs(u64::MAX)),
            retry_after
        );
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
            UpstreamFailure::stream(Some("usage_limit_reached"), Some("private-token")),
            // So does a window too long to wait out, and quota exhaustion.
            UpstreamFailure::RateLimitWindow {
                resets_in_secs: 3_600,
            }
            .into(),
            UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                r#"{"error":{"code":"insufficient_quota"}}"#,
            ),
            UpstreamFailure::http(StatusCode::SERVICE_UNAVAILABLE, &plan_headers, false).into(),
            UpstreamFailure::http(StatusCode::UNAUTHORIZED, &HeaderMap::new(), false).into(),
            UpstreamFailure::InvalidResponse.into(),
        ] {
            let classified = classify(&failure);
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
            let classified = classify(&UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                body,
            ));
            assert_eq!(classified.status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            assert_eq!(classified.error_type, error_type, "{body}");
            assert_eq!(classified.code, code, "{body}");
            assert!(!classified.retryable, "{body}");
            assert!(classified.retry_after.is_none(), "{body}");
            assert_eq!(classified.resets_at, resets_at, "{body}");
        }
        // Quota exhaustion keeps its 402 even when a plan code is also present.
        let quota = classify(&UpstreamFailure::http_body(
            StatusCode::TOO_MANY_REQUESTS,
            &headers,
            r#"{"error":{"type":"usage_limit_reached","code":"insufficient_quota"}}"#,
        ));
        assert_eq!(quota.status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(quota.error_type, "upstream_error");
        // A plan code in free text, or on another status, is not a plan limit.
        let text = classify(&UpstreamFailure::http_body(
            StatusCode::TOO_MANY_REQUESTS,
            &HeaderMap::new(),
            r#"{"error":{"message":"usage_limit_reached"}}"#,
        ));
        assert!(text.retryable);
        assert_eq!(text.error_type, "upstream_error");
        assert_eq!(text.code, "upstream_rate_limit");
        let forbidden = classify(&UpstreamFailure::http_body(
            StatusCode::FORBIDDEN,
            &HeaderMap::new(),
            r#"{"error":{"type":"usage_not_included"}}"#,
        ));
        assert_eq!(forbidden.error_type, "upstream_error");
        assert_eq!(forbidden.code, "upstream_access_denied");
        for (code, error_type) in [
            ("usage_limit_reached", "upstream_usage_limit_reached"),
            ("usage_not_included", "upstream_usage_not_included"),
        ] {
            let stream = classify(&UpstreamFailure::stream(Some(code), Some("private-token")));
            assert_eq!(stream.status, StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(stream.error_type, code);
            assert_eq!(stream.code, error_type);
            assert!(!stream.retryable);
            assert!(stream.retry_after.is_none());
            assert!(stream.resets_at.is_none());
        }
    }

    #[test]
    fn only_a_400_that_blames_the_tool_controls_is_a_tool_control_rejection() {
        let rejection = |status: StatusCode, body: &str| {
            let error = UpstreamFailure::http_body(status, &HeaderMap::new(), body)
                .context("request context");
            tool_control_rejection(&error).map(ProviderError::without_message)
        };
        let bad_request = |body: &str| rejection(StatusCode::BAD_REQUEST, body);
        // What the fallback line logs: the provider error, without its message.
        let said = |code: Option<&str>, kind: Option<&str>, param: Option<&str>| {
            Some(ProviderError {
                code: code.map(str::to_string),
                kind: kind.map(str::to_string),
                param: param.map(str::to_string),
                message: None,
            })
        };
        let long_code = "c".repeat(80);
        for (body, expected) in [
            (
                r#"{"error":{"message":"private-token","type":"invalid_request_error","param":"tool_choice","code":null}}"#.to_string(),
                said(None, Some("invalid_request_error"), Some("tool_choice")),
            ),
            (
                r#"{"error":{"message":"private-token","type":"invalid_request_error","param":"tools","code":"missing_required_parameter"}}"#.to_string(),
                said(Some("missing_required_parameter"), Some("invalid_request_error"), Some("tools")),
            ),
            // With no param, a code and a message that names the tool choice.
            (
                r#"{"error":{"message":"Invalid value for 'tool_choice': private-token","param":null,"code":"invalid_value"}}"#.to_string(),
                said(Some("invalid_value"), None, None),
            ),
            (
                r#"{"error":{"message":"Tool choice 'required' needs tools. private-token","type":"invalid_request_error"}}"#.to_string(),
                said(None, Some("invalid_request_error"), None),
            ),
            // The message is read as the provider wrote it, before the log masks or cuts it.
            (
                json!({ "error": {
                    "message": "Invalid 'function.tool_choice_override_for_this_request'.",
                    "code": "invalid_value"
                } })
                .to_string(),
                said(Some("invalid_value"), None, None),
            ),
            (
                json!({ "error": {
                    "message": format!("{} tool choice", "word ".repeat(60)),
                    "code": "invalid_value"
                } })
                .to_string(),
                said(Some("invalid_value"), None, None),
            ),
            // A code too long to read as an identifier is left out; the param still blames
            // the tool choice.
            (
                format!(r#"{{"error":{{"param":"tool_choice","code":"{long_code}"}}}}"#),
                said(None, None, Some("tool_choice")),
            ),
            // The error object is the one every provider error is read from: a `detail`
            // object, or the body itself.
            (
                r#"{"detail":{"param":"tool_choice","code":"invalid_value"}}"#.to_string(),
                said(Some("invalid_value"), None, Some("tool_choice")),
            ),
            (
                r#"{"message":"tool_choice","param":"tool_choice"}"#.to_string(),
                said(None, None, Some("tool_choice")),
            ),
        ] {
            assert_eq!(bad_request(&body), expected, "{body}");
        }

        for body in [
            // Another parameter is to blame, whatever the message says.
            r#"{"error":{"message":"tool_choice","type":"invalid_request_error","param":"input","code":"invalid_value"}}"#,
            r#"{"error":{"message":"Invalid tools","type":"invalid_request_error","param":"tools[0].name"}}"#,
            r#"{"error":{"message":"tool_choice","type":"invalid_request_error","param":"TOOL_CHOICE"}}"#,
            r#"{"error":{"message":"tool_choice","type":"invalid_request_error","param":1}}"#,
            r#"{"error":{"message":"tool_choice","type":"invalid_request_error","param":"tool choice"}}"#,
            // No param, and either no code or a message that names no tool choice.
            r#"{"error":{"message":"Invalid value for 'tool_choice'.","param":null,"code":null}}"#,
            r#"{"error":{"message":"Invalid value for 'tools'.","type":"invalid_request_error"}}"#,
            r#"{"error":{"message":"The model does not exist.","code":"model_not_found"}}"#,
            // A string `detail` or `error`, which has no code, and a body that is no JSON.
            r#"{"detail":"Unsupported parameter: tool_choice"}"#,
            r#"{"error":"tool_choice"}"#,
            "tool_choice",
            "",
        ] {
            assert_eq!(bad_request(body), None, "{body}");
        }

        // Only a 400: any other status is classified as before.
        let blames_tool_choice = r#"{"error":{"message":"tool_choice","type":"invalid_request_error","param":"tool_choice"}}"#;
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::UNPROCESSABLE_ENTITY,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert_eq!(rejection(status, blames_tool_choice), None, "{status}");
        }
        assert_eq!(
            tool_control_rejection(&anyhow::anyhow!("tool_choice")),
            None,
            "an error that is not an upstream HTTP failure"
        );

        // The 400 still reaches the client as the terminal rejection it was.
        let classified = classify(&UpstreamFailure::http_body(
            StatusCode::BAD_REQUEST,
            &HeaderMap::new(),
            blames_tool_choice,
        ));
        assert_eq!(classified.status, StatusCode::BAD_REQUEST);
        assert_eq!(classified.code, "upstream_http_error");
        assert!(!classified.retryable);
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
        let classified = classify(&error);
        assert_eq!(classified.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(classified.retryable);
        let classified = classify(&anyhow::anyhow!(
            "controller credential lease renewal failed token_expired"
        ));
        assert_eq!(classified.status, StatusCode::BAD_GATEWAY);
        assert!(classified.retryable);
    }

    fn provider_error_of(status: StatusCode, body: &str) -> Option<ProviderError> {
        provider_error_with(status, &HeaderMap::new(), body)
    }

    fn provider_error_with(
        status: StatusCode,
        headers: &HeaderMap,
        body: &str,
    ) -> Option<ProviderError> {
        provider_error(
            &UpstreamFailure::http_body(status, headers, body).context("request context"),
        )
        .cloned()
    }

    #[test]
    fn a_provider_error_keeps_identifiers_and_a_short_masked_message() {
        let error =
            |code: Option<&str>, kind: Option<&str>, param: Option<&str>, message: Option<&str>| {
                Some(ProviderError {
                    code: code.map(str::to_string),
                    kind: kind.map(str::to_string),
                    param: param.map(str::to_string),
                    message: message.map(str::to_string),
                })
            };
        let token = format!("sk-proj-{}", "a1".repeat(40));
        let jwt = format!(
            "eyJ{}.eyJ{}.{}",
            "h".repeat(20),
            "p".repeat(40),
            "s".repeat(30)
        );
        for (body, expected) in [
            // OpenAI's shape, with a key and a token in a two-line message.
            (
                json!({ "error": {
                    "message": format!("Incorrect API key provided: {token}.\nBearer {jwt} refused."),
                    "type": "invalid_request_error",
                    "param": null,
                    "code": "invalid_api_key"
                } })
                .to_string(),
                error(
                    Some("invalid_api_key"),
                    Some("invalid_request_error"),
                    None,
                    Some("Incorrect API key provided: [masked] Bearer [masked] refused."),
                ),
            ),
            (
                json!({ "error": {
                    "message": "Invalid 'input[3].content': string too long.",
                    "type": "invalid_request_error",
                    "param": "input[3].content",
                    "code": "string_above_max_length"
                } })
                .to_string(),
                error(
                    Some("string_above_max_length"),
                    Some("invalid_request_error"),
                    Some("input[3].content"),
                    Some("Invalid 'input[3].content': string too long."),
                ),
            ),
            // The ChatGPT Codex endpoint's `detail`, as a string or an object.
            (
                r#"{"detail":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}"#.to_string(),
                error(None, None, None, Some("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")),
            ),
            (
                r#"{"detail":{"code":"unsupported_model","message":"Not supported."}}"#.to_string(),
                error(Some("unsupported_model"), None, None, Some("Not supported.")),
            ),
            // A top-level error, and an error that is only a string.
            (
                r#"{"code":"bad_gateway","message":"Try again."}"#.to_string(),
                error(Some("bad_gateway"), None, None, Some("Try again.")),
            ),
            (
                r#"{"error":"model unavailable"}"#.to_string(),
                error(None, None, None, Some("model unavailable")),
            ),
            // What does not read as an identifier is left out.
            (
                json!({ "error": {
                    "code": "not an identifier",
                    "type": "x".repeat(65),
                    "param": 3,
                    "message": "   "
                } })
                .to_string(),
                None,
            ),
            // A body that says nothing the proxy reads.
            ("{}".to_string(), None),
            (r#"{"error":{}}"#.to_string(), None),
            ("<html>Bad Request</html>".to_string(), None),
            (String::new(), None),
        ] {
            assert_eq!(provider_error_of(StatusCode::BAD_REQUEST, &body), expected, "{body}");
        }

        // A long message is cut, after it is masked.
        let long = json!({ "error": { "message": format!("{} {token}", "word ".repeat(60)) } })
            .to_string();
        let message = provider_error_of(StatusCode::BAD_REQUEST, &long)
            .and_then(|error| error.message)
            .unwrap();
        assert_eq!(
            message.chars().count(),
            MAX_PROVIDER_MESSAGE_CHARS + 1,
            "{message}"
        );
        assert!(
            message.ends_with('…') && !message.contains("sk-proj"),
            "{message}"
        );

        // A failed stream's code and message, as the stream gave them, and nothing in place
        // of a message it did not give.
        let stream = |code: Option<&str>, message: Option<&str>| {
            provider_error(&UpstreamFailure::stream(code, message)).cloned()
        };
        assert_eq!(
            stream(
                Some("context_length_exceeded"),
                Some(&format!("Input too long for {token}"))
            ),
            error(
                Some("context_length_exceeded"),
                None,
                None,
                Some("Input too long for [masked]")
            ),
        );
        assert_eq!(
            stream(Some("server_error"), None),
            error(Some("server_error"), None, None, None)
        );
        assert_eq!(stream(None, None), None);
        // A failure the provider said nothing about.
        assert_eq!(provider_error(&anyhow::anyhow!("model_not_found")), None);
        assert_eq!(
            provider_error(&anyhow::Error::new(UpstreamFailure::InvalidResponse)),
            None
        );
    }

    #[test]
    fn every_refusal_built_from_a_body_keeps_what_the_provider_said() {
        let said = |code: Option<&str>, kind: Option<&str>, message: &str| {
            Some(ProviderError {
                code: code.map(str::to_string),
                kind: kind.map(str::to_string),
                param: None,
                message: Some(message.to_string()),
            })
        };
        let classified_as = |status: StatusCode, headers: &HeaderMap, body: &str| {
            let error = UpstreamFailure::http_body(status, headers, body);
            let classified = classify(&error);
            (classified.code, provider_error(&error).cloned())
        };
        // Quota exhaustion: the provider's own message, not words of the proxy's.
        let quota = json!({ "error": {
            "message": "You exceeded your current quota.",
            "type": "insufficient_quota",
            "code": "insufficient_quota"
        } });
        assert_eq!(
            classified_as(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                &quota.to_string()
            ),
            (
                "upstream_insufficient_quota",
                said(
                    Some("insufficient_quota"),
                    Some("insufficient_quota"),
                    "You exceeded your current quota."
                )
            )
        );
        // A plan limit, read from a `detail` object as from an `error` one.
        for body in [
            json!({ "error": { "type": "usage_limit_reached", "message": "The usage limit has been reached.", "resets_at": 1_900_000_000 } }),
            json!({ "detail": { "type": "usage_limit_reached", "message": "The usage limit has been reached.", "resets_at": 1_900_000_000 } }),
        ] {
            let error = UpstreamFailure::http_body(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                &body.to_string(),
            );
            let classified = classify(&error);
            assert_eq!(classified.code, "upstream_usage_limit_reached", "{body}");
            assert_eq!(classified.resets_at, Some(1_900_000_000), "{body}");
            assert_eq!(
                provider_error(&error).cloned(),
                said(
                    None,
                    Some("usage_limit_reached"),
                    "The usage limit has been reached."
                ),
                "{body}"
            );
        }
        // A bucket that needs hours to refill, such as a daily requests limit.
        let mut daily = HeaderMap::new();
        for (name, value) in [
            ("x-ratelimit-remaining-requests", "0"),
            ("x-ratelimit-reset-requests", "6h0m0s"),
        ] {
            daily.insert(name, HeaderValue::from_static(value));
        }
        let per_day = json!({ "error": {
            "message": "Rate limit reached for requests per day (RPD).",
            "type": "requests",
            "code": "rate_limit_exceeded"
        } });
        let error =
            UpstreamFailure::http_body(StatusCode::TOO_MANY_REQUESTS, &daily, &per_day.to_string());
        assert!(matches!(
            error.downcast_ref::<UpstreamFailure>(),
            Some(UpstreamFailure::RateLimitWindow {
                resets_in_secs: 21_600
            })
        ));
        assert_eq!(
            provider_error(&error)
                .and_then(ProviderError::reason)
                .as_deref(),
            Some("rate_limit_exceeded")
        );
        assert_eq!(
            provider_error_with(StatusCode::TOO_MANY_REQUESTS, &daily, &per_day.to_string()),
            said(
                Some("rate_limit_exceeded"),
                Some("requests"),
                "Rate limit reached for requests per day (RPD)."
            )
        );
    }

    #[test]
    fn a_client_gets_only_the_provider_code_and_param() {
        let reason = |code: Option<&str>, kind: Option<&str>, param: Option<&str>| {
            ProviderError {
                code: code.map(str::to_string),
                kind: kind.map(str::to_string),
                param: param.map(str::to_string),
                message: Some("The model does not exist in organization org-private.".into()),
            }
            .reason()
        };
        assert_eq!(
            reason(
                Some("model_not_found"),
                Some("invalid_request_error"),
                Some("model")
            )
            .as_deref(),
            Some("model_not_found, param model")
        );
        // The type stands in for a missing code.
        assert_eq!(
            reason(None, Some("invalid_request_error"), Some("tool_choice")).as_deref(),
            Some("invalid_request_error, param tool_choice")
        );
        assert_eq!(
            reason(None, None, Some("model")).as_deref(),
            Some("param model")
        );
        assert_eq!(
            reason(Some("server_error"), None, None).as_deref(),
            Some("server_error")
        );
        // A message alone gives no reason: it never reaches a client.
        assert_eq!(reason(None, None, None), None);
    }
}
