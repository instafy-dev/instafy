//! Keeps device-local (loopback) HTTP traffic away from ambient proxies.
//!
//! Codex's MCP transport builds its HTTP clients with reqwest's default proxy handling, which
//! reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and, on macOS and Windows, the system proxy.
//! None of them exempts loopback on its own, so a Personal Browser turn would hand its bearer
//! token (and the MCP traffic) to whoever runs the proxy. runtime-agent therefore merges the
//! loopback hosts into `NO_PROXY`/`no_proxy` before anything reads the environment, and refuses
//! a Personal Browser turn whose control URL a proxy would still intercept.

use anyhow::{Context, Result, bail};
use hyper_util::client::proxy::matcher::Matcher;

/// Loopback hosts every proxy reader (reqwest, curl, Node) must reach directly.
pub const LOOPBACK_NO_PROXY_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

const NO_PROXY_ENV: &str = "NO_PROXY";
const NO_PROXY_LOWER_ENV: &str = "no_proxy";

/// `existing` plus each loopback host it does not already list, keeping its entries and order.
pub fn merge_loopback_no_proxy(existing: Option<&str>) -> String {
    let mut entries: Vec<&str> = existing
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    for host in LOOPBACK_NO_PROXY_HOSTS {
        if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(host)) {
            entries.push(host);
        }
    }
    entries.join(",")
}

/// The values to store in `NO_PROXY` and `no_proxy`. Each key keeps what its readers saw before:
/// reqwest reads `NO_PROXY` first and curl reads `no_proxy` first, each falling back to the other.
fn merged_no_proxy_values(upper: Option<&str>, lower: Option<&str>) -> (String, String) {
    (
        merge_loopback_no_proxy(upper.or(lower)),
        merge_loopback_no_proxy(lower.or(upper)),
    )
}

/// Adds the loopback hosts to this process's `NO_PROXY` and `no_proxy`, which Codex's HTTP
/// clients and every child process then inherit.
///
/// # Safety
///
/// Mutates the process environment, so it must run before the process starts other threads.
pub unsafe fn exempt_loopback_from_proxy_env() {
    let read = |key: &str| std::env::var_os(key).map(|value| value.to_string_lossy().into_owned());
    let (upper, lower) = merged_no_proxy_values(
        read(NO_PROXY_ENV).as_deref(),
        read(NO_PROXY_LOWER_ENV).as_deref(),
    );
    // SAFETY: the caller guarantees that no other thread reads or writes the environment.
    unsafe {
        std::env::set_var(NO_PROXY_ENV, upper);
        std::env::set_var(NO_PROXY_LOWER_ENV, lower);
    }
}

/// Fails when the proxy configuration Codex's HTTP clients read (environment, then the macOS or
/// Windows system proxy) would route `url` through a proxy.
pub fn ensure_no_proxy_intercepts(url: &str) -> Result<()> {
    ensure_matcher_does_not_intercept(&Matcher::from_system(), url)
}

fn ensure_matcher_does_not_intercept(matcher: &Matcher, url: &str) -> Result<()> {
    let uri: http::Uri = url
        .parse()
        .context("device-local endpoint is not a valid URI")?;
    if matcher.intercept(&uri).is_some() {
        bail!(
            "a proxy configured for this runtime (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY or the system proxy) would receive traffic for the device-local endpoint {}; add {} to NO_PROXY",
            uri.authority()
                .map(|authority| authority.as_str())
                .unwrap_or("<unknown>"),
            LOOPBACK_NO_PROXY_HOSTS.join(",")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const POISON: &str = "http://127.0.0.1:9";

    #[test]
    fn merge_keeps_existing_entries_and_adds_each_missing_loopback_host_once() {
        assert_eq!(merge_loopback_no_proxy(None), "localhost,127.0.0.1,::1");
        assert_eq!(merge_loopback_no_proxy(Some("")), "localhost,127.0.0.1,::1");
        assert_eq!(
            merge_loopback_no_proxy(Some(" corp.example , .internal ")),
            "corp.example,.internal,localhost,127.0.0.1,::1"
        );
        assert_eq!(
            merge_loopback_no_proxy(Some("LOCALHOST,127.0.0.1,corp.example")),
            "LOCALHOST,127.0.0.1,corp.example,::1"
        );
        let merged = merge_loopback_no_proxy(Some("corp.example"));
        assert_eq!(merge_loopback_no_proxy(Some(&merged)), merged);
    }

    #[test]
    fn each_no_proxy_key_keeps_what_its_readers_saw() {
        assert_eq!(
            merged_no_proxy_values(None, None),
            (
                "localhost,127.0.0.1,::1".to_string(),
                "localhost,127.0.0.1,::1".to_string()
            )
        );
        // Only the lowercase key was set: reqwest fell back to it, so NO_PROXY must keep it.
        assert_eq!(
            merged_no_proxy_values(None, Some("corp.example")).0,
            "corp.example,localhost,127.0.0.1,::1"
        );
        let (upper, lower) = merged_no_proxy_values(Some("a.example"), Some("b.example"));
        assert_eq!(upper, "a.example,localhost,127.0.0.1,::1");
        assert_eq!(lower, "b.example,localhost,127.0.0.1,::1");
    }

    #[test]
    fn guard_refuses_a_loopback_endpoint_an_ambient_proxy_would_receive() {
        let poisoned = Matcher::builder().http(POISON).https(POISON).build();
        for url in [
            "http://127.0.0.1:43127/mcp",
            "http://localhost:43127/mcp",
            "http://[::1]:43127/mcp",
        ] {
            let error = ensure_matcher_does_not_intercept(&poisoned, url)
                .expect_err("a proxied loopback endpoint must be refused")
                .to_string();
            assert!(error.contains("NO_PROXY"), "{error}");
            assert!(!error.contains("/mcp"), "{error}");
        }
    }

    #[test]
    fn guard_accepts_loopback_once_no_proxy_lists_it() {
        let merged = merge_loopback_no_proxy(Some("corp.example"));
        let matcher = Matcher::builder()
            .http(POISON)
            .https(POISON)
            .no(merged)
            .build();
        for url in [
            "http://127.0.0.1:43127/mcp",
            "https://localhost:43127/mcp",
            "http://[::1]:43127/mcp",
        ] {
            ensure_matcher_does_not_intercept(&matcher, url).expect(url);
        }
        // Anything outside the loopback list still goes through the proxy.
        assert!(ensure_matcher_does_not_intercept(&matcher, "http://127.0.0.2:43127/mcp").is_err());
        ensure_matcher_does_not_intercept(&Matcher::builder().build(), "http://127.0.0.2:1/mcp")
            .expect("no proxy configured");
    }
}
