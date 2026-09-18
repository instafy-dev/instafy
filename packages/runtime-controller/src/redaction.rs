//! Shared redaction primitives for anything that can reach a log line.
//!
//! Two things live here:
//!
//! 1. The canonical sensitive-key deny list (`is_sensitive_diagnostic_key`),
//!    which used to be private to `bug_reports`. A deny list that exists in two
//!    places drifts, so both the bug-report diagnostics walker and the header
//!    `Debug` impl below share this one.
//! 2. `RedactedHeaders`, a drop-in replacement for `HeaderMap` in handler
//!    signatures whose `Debug` impl masks the values behind sensitive header
//!    names and prints every other header verbatim.
//!
//! The motivation for (2) is structural. `#[instrument]` records every
//! un-skipped argument by `Debug`, so a handler that takes a bare `HeaderMap`
//! and forgets to list it in `skip(...)` writes the caller's `Authorization`
//! header into the span at INFO level, on every request. Patching the skip list
//! fixes the sites that are wrong today and leaves the trap armed for the next
//! handler. Making the type unloggable instead follows the precedent already
//! set by `CredentialEncryptionKey` (config.rs) and `BrowserTurnRestConfig`
//! (browser_turn.rs): redact in the type, not at the call site.

use std::fmt;
use std::ops::Deref;

use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;

pub(crate) const REDACTED_DIAGNOSTIC_VALUE: &str = "[REDACTED]";

pub(crate) fn normalize_diagnostic_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn is_sensitive_diagnostic_key(key: &str) -> bool {
    let key = normalize_diagnostic_key(key);
    matches!(
        key.as_str(),
        "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "secret"
            | "credentials"
            | "credential"
            | "apikey"
            | "privatekey"
            | "clientsecret"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "secretaccesskey"
            | "signingkey"
            | "signature"
            | "xamzcredential"
            | "xamzsignature"
            | "sas"
            | "sastoken"
    ) || key.ends_with("password")
        || key.ends_with("secret")
        || key.ends_with("token")
        || key.ends_with("apikey")
        || key.ends_with("privatekey")
        || key.ends_with("signature")
}

/// A request's headers, safe to leave un-skipped in an `#[instrument]` span.
///
/// Drops into a handler signature exactly where `headers: HeaderMap` sat, and
/// derefs to `HeaderMap` so existing call sites such as
/// `authenticate_request(&state.config, &headers)` compile unchanged. The only
/// difference is `Debug`: values behind sensitive header names print as
/// `[REDACTED]`, and everything else prints as it always did.
#[derive(Clone)]
pub(crate) struct RedactedHeaders(HeaderMap);

impl RedactedHeaders {
    #[cfg(test)]
    pub(crate) fn new(headers: HeaderMap) -> Self {
        Self(headers)
    }
}

impl Deref for RedactedHeaders {
    type Target = HeaderMap;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl fmt::Debug for RedactedHeaders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut map = formatter.debug_map();
        for (name, value) in self.0.iter() {
            if is_sensitive_diagnostic_key(name.as_str()) {
                map.entry(&name.as_str(), &REDACTED_DIAGNOSTIC_VALUE);
            } else {
                map.entry(&name.as_str(), value);
            }
        }
        map.finish()
    }
}

#[async_trait]
impl<S> FromRequestParts<S> for RedactedHeaders
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(HeaderMap::from_request_parts(parts, state).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use axum::http::HeaderValue;
    use tracing::instrument;
    use tracing_subscriber::fmt::MakeWriter;

    // Deliberately fabricated. Never copy a value out of a captured log into a
    // fixture; the point of the assertion is that this exact string is absent
    // from the rendered span, so it only has to be unmistakable and fake.
    const FAKE_BEARER: &str = "Bearer not-a-real-token-abcdefghijklmnop";

    #[derive(Clone, Default)]
    struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

    impl CapturedLogs {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().expect("log buffer poisoned")).into_owned()
        }
    }

    impl Write for CapturedLogs {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("log buffer poisoned")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for CapturedLogs {
        type Writer = CapturedLogs;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn lease_like_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert("authorization", HeaderValue::from_static(FAKE_BEARER));
        headers.insert("accept", HeaderValue::from_static("*/*"));
        headers.insert("host", HeaderValue::from_static("controller.example.test"));
        headers.insert("content-length", HeaderValue::from_static("289"));
        headers.insert("x-request-id", HeaderValue::from_static("req-1234"));
        headers
    }

    /// Mirrors the shape of `agent::agent_lease`: an instrumented async handler
    /// that skips state and payload but leaves `headers` in the span, so the
    /// header map is `Debug`-formatted as a span field exactly as it is in
    /// production.
    #[instrument(skip(state, payload))]
    async fn lease_like_handler(state: &str, headers: RedactedHeaders, payload: &str) {
        let _ = (state, payload);
        let runtime_id = "11111111-1111-4111-8111-111111111111";
        let project_id = "22222222-2222-4222-8222-222222222222";
        tracing::info!(runtime_id, project_id, "agent lease request");
    }

    fn capture_lease_span() -> String {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("current thread runtime");
        let logs = CapturedLogs::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(logs.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            runtime.block_on(lease_like_handler(
                "state-is-skipped",
                RedactedHeaders::new(lease_like_headers()),
                "payload-is-skipped",
            ));
        });

        logs.contents()
    }

    #[test]
    fn lease_span_does_not_log_the_bearer_token() {
        let output = capture_lease_span();

        assert!(
            !output.contains(FAKE_BEARER),
            "bearer value leaked into the span output"
        );
        assert!(
            !output.contains("not-a-real-token"),
            "a fragment of the bearer value leaked into the span output"
        );
        assert!(
            output.contains(REDACTED_DIAGNOSTIC_VALUE),
            "authorization header was dropped instead of redacted: {output}"
        );
    }

    #[test]
    fn lease_span_keeps_the_fields_an_operator_needs() {
        let output = capture_lease_span();

        // The span itself still carries the header map, and every
        // non-sensitive header still prints in full.
        assert!(output.contains("lease_like_handler{headers="), "{output}");
        assert!(output.contains("application/json"), "{output}");
        assert!(output.contains("controller.example.test"), "{output}");
        assert!(output.contains("content-length"), "{output}");
        assert!(output.contains("req-1234"), "{output}");

        // And the correlation fields the next outage is debugged with.
        assert!(output.contains("agent lease request"), "{output}");
        assert!(
            output.contains("11111111-1111-4111-8111-111111111111"),
            "{output}"
        );
        assert!(
            output.contains("22222222-2222-4222-8222-222222222222"),
            "{output}"
        );
    }

    #[test]
    fn debug_redacts_sensitive_header_names_and_keeps_the_rest() {
        let headers = RedactedHeaders::new(lease_like_headers());
        let rendered = format!("{headers:?}");

        assert!(!rendered.contains(FAKE_BEARER), "{rendered}");
        assert!(
            rendered.contains("\"authorization\": \"[REDACTED]\""),
            "{rendered}"
        );
        assert!(
            rendered.contains("\"content-type\": \"application/json\""),
            "{rendered}"
        );
        assert!(
            rendered.contains("\"x-request-id\": \"req-1234\""),
            "{rendered}"
        );
    }

    #[test]
    fn deny_list_covers_the_header_names_that_carry_credentials() {
        for name in [
            "authorization",
            "Authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-runtime-token",
            "x-amz-signature",
        ] {
            assert!(
                is_sensitive_diagnostic_key(name),
                "expected {name} to be treated as sensitive"
            );
        }

        for name in [
            "content-type",
            "content-length",
            "host",
            "accept",
            "user-agent",
            "x-request-id",
        ] {
            assert!(
                !is_sensitive_diagnostic_key(name),
                "expected {name} to stay readable"
            );
        }
    }

    // ---------------------------------------------------------------------
    // Source guard: the thing that stops the next one.
    // ---------------------------------------------------------------------

    fn rust_sources(directory: &Path, found: &mut Vec<PathBuf>) {
        let entries = std::fs::read_dir(directory).expect("read source directory");
        for entry in entries {
            let path = entry.expect("read directory entry").path();
            if path.is_dir() {
                rust_sources(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }

    /// Splits a parameter list at top-level commas, ignoring commas nested in
    /// generics, tuples or slices.
    fn split_parameters(parameters: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut depth = 0i32;
        let mut current = String::new();
        for character in parameters.chars() {
            match character {
                '<' | '(' | '[' => {
                    depth += 1;
                    current.push(character);
                }
                '>' | ')' | ']' => {
                    depth -= 1;
                    current.push(character);
                }
                ',' if depth == 0 => {
                    out.push(current.trim().to_string());
                    current = String::new();
                }
                _ => current.push(character),
            }
        }
        if !current.trim().is_empty() {
            out.push(current.trim().to_string());
        }
        out
    }

    /// Splits `name: Type` at the binding colon, skipping the `::` of a path.
    /// `axum::Json(payload): axum::Json<T>` must split at the colon after the
    /// closing paren, not at the first colon of `axum::`.
    fn split_name_and_type(parameter: &str) -> Option<(String, String)> {
        let bytes = parameter.as_bytes();
        let mut depth = 0i32;
        let mut index = 0usize;
        while index < bytes.len() {
            match bytes[index] {
                b'<' | b'(' | b'[' => depth += 1,
                b'>' | b')' | b']' => depth -= 1,
                b':' if depth == 0 => {
                    if bytes.get(index + 1) == Some(&b':') {
                        index += 2;
                        continue;
                    }
                    return Some((
                        parameter[..index].trim().to_string(),
                        parameter[index + 1..].trim().to_string(),
                    ));
                }
                _ => {}
            }
            index += 1;
        }
        None
    }

    fn balanced_span(text: &str, open: char, close: char) -> Option<(usize, usize)> {
        let start = text.find(open)?;
        let mut depth = 0i32;
        for (offset, character) in text[start..].char_indices() {
            if character == open {
                depth += 1;
            } else if character == close {
                depth -= 1;
                if depth == 0 {
                    return Some((start, start + offset));
                }
            }
        }
        None
    }

    /// Walks every `#[instrument]` attribute in this crate and fails if one of
    /// them leaves a bare `HeaderMap` parameter un-skipped.
    ///
    /// This is the backstop for the `RedactedHeaders` newtype. The newtype
    /// makes a forgotten `skip(headers)` harmless; this test makes a forgotten
    /// `RedactedHeaders` loud. A handler may still take a raw `HeaderMap` as
    /// long as the span cannot carry it.
    #[test]
    fn no_instrumented_handler_can_log_a_raw_header_map() {
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_sources(&source_root, &mut files);
        assert!(!files.is_empty(), "found no sources under {source_root:?}");

        let mut offenders = Vec::new();
        let mut inspected = 0usize;
        let mut header_parameters_seen = 0usize;

        for file in &files {
            let source = std::fs::read_to_string(file).expect("read source file");
            let mut cursor = 0usize;

            while let Some(relative) = source[cursor..].find("#[instrument") {
                let attribute_start = cursor + relative;
                inspected += 1;
                cursor = attribute_start + "#[instrument".len();

                let tail = &source[attribute_start..];
                let Some((_, attribute_end)) = balanced_span(tail, '[', ']') else {
                    continue;
                };
                let attribute = &tail[..=attribute_end];

                // The signature runs from the end of the attribute to the
                // opening brace of the function body.
                let after_attribute = &tail[attribute_end + 1..];
                let Some(body_start) = after_attribute.find('{') else {
                    continue;
                };
                let signature = &after_attribute[..body_start];
                // Anchor on the paren that follows `fn <name>`. Taking the
                // first paren in the signature instead would find the one in
                // `pub(crate)` and silently parse the parameter list as
                // "crate", which makes this whole guard pass vacuously.
                let Some(fn_offset) = signature.find("fn ") else {
                    continue;
                };
                let declaration = &signature[fn_offset..];
                let Some((parameters_start, parameters_end)) = balanced_span(declaration, '(', ')')
                else {
                    continue;
                };
                let parameters = &declaration[parameters_start + 1..parameters_end];

                if attribute.contains("skip_all") {
                    continue;
                }

                for parameter in split_parameters(parameters) {
                    let Some((name, type_name)) = split_name_and_type(&parameter) else {
                        continue;
                    };

                    // Only a bare `HeaderMap` is dangerous. `RedactedHeaders`
                    // has a Debug impl that masks credentials, so it is allowed
                    // to stay in the span.
                    let is_raw_header_map = type_name == "HeaderMap"
                        || type_name.ends_with("::HeaderMap")
                        || type_name == "&HeaderMap"
                        || type_name.ends_with("::HeaderMap>");
                    if !is_raw_header_map {
                        continue;
                    }
                    header_parameters_seen += 1;

                    let skipped = attribute
                        .split_once("skip(")
                        .and_then(|(_, rest)| rest.split_once(')'))
                        .is_some_and(|(list, _)| list.split(',').any(|entry| entry.trim() == name));

                    if !skipped {
                        let line = source[..attribute_start].lines().count() + 1;
                        offenders.push(format!(
                            "{}:{line} instrumented function takes `{name}: {type_name}` \
                             without skipping it; use RedactedHeaders or add it to skip(...)",
                            file.display()
                        ));
                    }
                }
            }
        }

        assert!(inspected > 0, "scanner matched no #[instrument] attributes");
        // An earlier version of this scanner anchored on the first `(` in the
        // signature, found the one in `pub(crate)`, and parsed every parameter
        // list as "crate". It passed while agent.rs was actively leaking. This
        // assertion fails loudly if the parser ever stops reaching parameters
        // again, instead of passing vacuously.
        assert!(
            header_parameters_seen >= 10,
            "scanner reached only {header_parameters_seen} HeaderMap parameters across \
             {inspected} instrumented functions; the signature parser is broken"
        );
        assert!(
            offenders.is_empty(),
            "instrumented handlers can log raw header maps:\n{}",
            offenders.join("\n")
        );
    }
}
