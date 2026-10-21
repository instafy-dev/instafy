pub mod auth;
pub mod client;
mod context_controls;
pub mod controller_client;
mod controller_credential_source;
pub mod controller_integration;
pub mod credential_lease;
mod incomplete_response;
pub mod proxy;
pub mod proxy_auth;
mod upstream_error;
mod usage;

use std::fmt::Arguments;

use chrono::{DateTime, SecondsFormat, Utc};

/// Writes one line of the proxy's log to stderr, as `format!` formats its arguments, after the
/// time it was written and `[proxy]`, so that every line says when it happened.
#[macro_export]
macro_rules! proxy_log {
    ($($arg:tt)*) => {
        $crate::write_log_line(::std::format_args!($($arg)*))
    };
}

#[doc(hidden)]
pub fn write_log_line(message: Arguments<'_>) {
    eprintln!("{}", log_line(Utc::now(), message));
}

/// A log line: the UTC time to the millisecond (RFC 3339), `[proxy]` and the message.
fn log_line(now: DateTime<Utc>, message: Arguments<'_>) -> String {
    format!(
        "{} [proxy] {message}",
        now.to_rfc3339_opts(SecondsFormat::Millis, true)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_line_starts_with_its_time_in_utc_to_the_millisecond() {
        let now = DateTime::parse_from_rfc3339("2026-10-20T17:04:14.123456+02:00")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            log_line(now, format_args!("upstream request {}", 1)),
            "2026-10-20T15:04:14.123Z [proxy] upstream request 1"
        );
    }
}
