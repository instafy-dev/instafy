//! Traefik forwardAuth for private preview tunnels.
//!
//! A preview host is `p-<label>--<tunnel hex>.<PREVIEW_DOMAIN>`: the 26-char base32 label is
//! the capability, minted by the controller and stored there only as `sha256(label)`. The
//! broker never decides access itself; it asks the controller hook and caches the answer
//! briefly, so revocation reaches open panes within the allow TTL.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;
use uuid::Uuid;

use crate::{
    hooks::{check_preview_auth, PreviewAuthDecision, PreviewAuthRequest},
    state::AppState,
};

const LABEL_LEN: usize = 26;
const TUNNEL_HEX_LEN: usize = 32;
/// The controller also caps `ttlSeconds` at 30; the broker enforces it regardless.
const MAX_ALLOW_TTL: Duration = Duration::from_secs(30);
const DENY_TTL: Duration = Duration::from_secs(5);
const ALLOW_CAPACITY: usize = 4096;
/// Denials live in their own, smaller map, so a flood of made-up labels can only evict other
/// denials and never pushes a member's allow back onto the hook.
const DENY_CAPACITY: usize = 1024;
/// Hook calls per tunnel: a burst, then a steady rate. Anyone who knows a tunnel's hex can
/// send fresh labels, and each one is a controller call and a database query.
const MISS_BURST: f64 = 60.0;
const MISS_PER_SECOND: f64 = 10.0;
const MISS_BUCKETS_CAPACITY: usize = 4096;
/// A key the hook allowed this recently is re-asked outside the tunnel's miss budget when its
/// cached allow expires. Only the hook can put a key here, so a flood of made-up labels (anyone
/// who knows the tunnel's hex can send them) cannot lock members out once their 30 s allow
/// lapses. The hook is still asked every time, so revocation keeps its delay.
const KNOWN_KEY_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewHost {
    pub label: String,
    pub tunnel_id: Uuid,
}

/// Parses an `X-Forwarded-Host` value. Hostnames are case-insensitive, so the host is folded
/// to lowercase first; anything that is not exactly a capability host on `domain` is `None`.
pub(crate) fn parse_preview_host(raw: &str, domain: &str) -> Option<PreviewHost> {
    let host = raw.trim().to_ascii_lowercase();
    let host = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host.as_str(),
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    let rest = host
        .strip_suffix(domain)?
        .strip_suffix('.')?
        .strip_prefix("p-")?;
    let (label, tunnel_hex) = rest.split_once("--")?;
    let label_ok = label.len() == LABEL_LEN
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    let hex_ok = tunnel_hex.len() == TUNNEL_HEX_LEN
        && tunnel_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !label_ok || !hex_ok {
        return None;
    }
    Some(PreviewHost {
        label: label.to_string(),
        tunnel_id: Uuid::try_parse(tunnel_hex).ok()?,
    })
}

/// Lowercase hex sha256 of the label, matching the controller's stored `capability_hash`.
pub(crate) fn capability_hash(label: &str) -> String {
    hex::encode(Sha256::digest(label.as_bytes()))
}

type DecisionKey = (Uuid, String);
/// The hook's answer for one key, shared by every request that missed the cache while it was
/// being asked. `None` means the hook could not be asked or the tunnel was over its miss limit.
type InFlight = Arc<OnceCell<Option<PreviewAuthDecision>>>;

/// Bounded allow and deny caches keyed by (tunnel, capability hash), plus what keeps cache
/// misses cheap: one hook call at a time per key, and a miss budget per tunnel. When a map is
/// full it drops expired entries, then the least recently used one.
pub(crate) struct DecisionCache {
    allows: Mutex<HashMap<DecisionKey, CachedDecision>>,
    denies: Mutex<HashMap<DecisionKey, CachedDecision>>,
    in_flight: Mutex<HashMap<DecisionKey, InFlight>>,
    misses: Mutex<HashMap<Uuid, MissBucket>>,
    /// Keys the hook allowed, and when it last did.
    known: Mutex<HashMap<DecisionKey, Instant>>,
    allow_capacity: usize,
    deny_capacity: usize,
}

struct CachedDecision {
    expires_at: Instant,
    last_used: Instant,
}

struct MissBucket {
    tokens: f64,
    refilled_at: Instant,
}

impl DecisionCache {
    pub(crate) fn new() -> Self {
        Self::with_capacity(ALLOW_CAPACITY, DENY_CAPACITY)
    }

    fn with_capacity(allow_capacity: usize, deny_capacity: usize) -> Self {
        Self {
            allows: Mutex::new(HashMap::new()),
            denies: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            misses: Mutex::new(HashMap::new()),
            known: Mutex::new(HashMap::new()),
            allow_capacity: allow_capacity.max(1),
            deny_capacity: deny_capacity.max(1),
        }
    }

    fn get(&self, key: &DecisionKey, now: Instant) -> Option<bool> {
        if Self::lookup(&self.allows, key, now) {
            return Some(true);
        }
        Self::lookup(&self.denies, key, now).then_some(false)
    }

    fn lookup(
        map: &Mutex<HashMap<DecisionKey, CachedDecision>>,
        key: &DecisionKey,
        now: Instant,
    ) -> bool {
        let mut entries = map.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get_mut(key) else {
            return false;
        };
        if entry.expires_at <= now {
            entries.remove(key);
            return false;
        }
        entry.last_used = now;
        true
    }

    /// Allows live for the hook's `ttlSeconds` (at most 30 s), denials for 5 s.
    fn record(&self, key: DecisionKey, decision: PreviewAuthDecision, now: Instant) {
        let (ttl, map, capacity) = if decision.allow {
            (
                Duration::from_secs(decision.ttl_seconds.max(0) as u64).min(MAX_ALLOW_TTL),
                &self.allows,
                self.allow_capacity,
            )
        } else {
            (DENY_TTL, &self.denies, self.deny_capacity)
        };
        {
            let mut known = self.known.lock().unwrap_or_else(|e| e.into_inner());
            if decision.allow {
                if known.len() >= self.allow_capacity && !known.contains_key(&key) {
                    known.retain(|_, at| now.duration_since(*at) < KNOWN_KEY_WINDOW);
                    if known.len() >= self.allow_capacity {
                        let oldest = known
                            .iter()
                            .min_by_key(|(_, at)| **at)
                            .map(|(k, _)| k.clone());
                        if let Some(oldest) = oldest {
                            known.remove(&oldest);
                        }
                    }
                }
                known.insert(key.clone(), now);
            } else {
                known.remove(&key);
            }
        }
        // A key is in at most one map: the newest answer wins.
        let other = if decision.allow {
            &self.denies
        } else {
            &self.allows
        };
        other.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        if ttl.is_zero() {
            map.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            return;
        }
        let mut entries = map.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= capacity && !entries.contains_key(&key) {
            entries.retain(|_, entry| entry.expires_at > now);
            if entries.len() >= capacity {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    entries.remove(&oldest);
                }
            }
        }
        entries.insert(
            key,
            CachedDecision {
                expires_at: now + ttl,
                last_used: now,
            },
        );
    }

    /// The shared lookup for `key`, created by the first request that misses.
    fn join(&self, key: &DecisionKey) -> InFlight {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        in_flight.entry(key.clone()).or_default().clone()
    }

    /// Forget a finished lookup, unless a newer one already replaced it.
    fn leave(&self, key: &DecisionKey, lookup: &InFlight) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if in_flight
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, lookup))
        {
            in_flight.remove(key);
        }
    }

    /// Whether the hook allowed `key` within [`KNOWN_KEY_WINDOW`].
    fn recently_allowed(&self, key: &DecisionKey, now: Instant) -> bool {
        let known = self.known.lock().unwrap_or_else(|e| e.into_inner());
        known
            .get(key)
            .is_some_and(|at| now.duration_since(*at) < KNOWN_KEY_WINDOW)
    }

    /// Spend one of the tunnel's hook calls; `false` once its burst is used up.
    fn admit_miss(&self, tunnel_id: Uuid, now: Instant) -> bool {
        let mut buckets = self.misses.lock().unwrap_or_else(|e| e.into_inner());
        if buckets.len() >= MISS_BUCKETS_CAPACITY && !buckets.contains_key(&tunnel_id) {
            // Buckets that refilled completely carry no state worth keeping.
            let full_after = Duration::from_secs_f64(MISS_BURST / MISS_PER_SECOND);
            buckets.retain(|_, bucket| now.duration_since(bucket.refilled_at) < full_after);
            if buckets.len() >= MISS_BUCKETS_CAPACITY {
                return false;
            }
        }
        let bucket = buckets.entry(tunnel_id).or_insert(MissBucket {
            tokens: MISS_BURST,
            refilled_at: now,
        });
        let elapsed = now.duration_since(bucket.refilled_at).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * MISS_PER_SECOND).min(MISS_BURST);
        bucket.refilled_at = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }
}

/// `GET /preview-auth`: 200 lets Traefik forward the request; anything else is sent to the
/// browser as is.
pub async fn preview_auth(State(state): State<AppState>, headers: HeaderMap) -> Response {
    // A service worker would keep serving the site after the capability is revoked.
    if is_service_worker_script(&headers) {
        return plain(
            StatusCode::FORBIDDEN,
            "Service workers are disabled in previews.",
        );
    }

    let Some(preview) = state.config().preview.as_ref() else {
        return denied();
    };
    let Some(host) = headers
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_preview_host(value, &preview.domain))
    else {
        return denied();
    };
    let Some(hook) = state.config().preview_auth_hook.as_ref() else {
        return denied();
    };

    let key = (host.tunnel_id, capability_hash(&host.label));
    let cache = state.preview_auth_cache();
    if let Some(allow) = cache.get(&key, Instant::now()) {
        return decision_response(allow);
    }

    // A page load misses for every asset at once; they all wait on one hook call.
    let lookup = cache.join(&key);
    let decision = *lookup
        .get_or_init(|| async {
            let now = Instant::now();
            if !cache.recently_allowed(&key, now) && !cache.admit_miss(key.0, now) {
                tracing::warn!(tunnel_id = %key.0, "preview auth misses over the tunnel's limit; denying");
                return None;
            }
            let request = PreviewAuthRequest {
                tunnel_id: key.0,
                capability_hash: key.1.clone(),
            };
            match check_preview_auth(state.http(), hook, &request).await {
                Ok(decision) => {
                    cache.record(key.clone(), decision, Instant::now());
                    Some(decision)
                }
                Err(error) => {
                    // Not cached, so access resumes as soon as the controller answers again.
                    tracing::warn!(tunnel_id = %request.tunnel_id, ?error, "preview auth hook failed; denying");
                    None
                }
            }
        })
        .await;
    cache.leave(&key, &lookup);
    decision_response(decision.is_some_and(|decision| decision.allow))
}

/// `GET /preview-error/:status`: the page Traefik's errors middleware shows for 502-504.
pub async fn preview_error(Path(status): Path<String>) -> Response {
    let Some(status) = status
        .parse::<u16>()
        .ok()
        .filter(|code| (400..=599).contains(code))
        .and_then(|code| StatusCode::from_u16(code).ok())
    else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    match status.as_u16() {
        401 => denied(),
        502..=504 => preview_page(
            status,
            "This preview is not responding.",
            "The site in your space stopped answering. Start it again, then reload this page.",
        ),
        _ => preview_page(
            status,
            "This preview is unavailable.",
            "Open it again from Instafy Studio.",
        ),
    }
}

fn is_service_worker_script(headers: &HeaderMap) -> bool {
    headers
        .get("service-worker")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("script"))
}

fn decision_response(allow: bool) -> Response {
    if allow {
        let mut response = Response::new(Body::empty());
        no_store(&mut response);
        response
    } else {
        denied()
    }
}

/// A label the controller does not accept: never minted, revoked, idle too long, or held by
/// someone who is no longer a member. The page cannot tell which, so it names both.
fn denied() -> Response {
    preview_page(
        StatusCode::UNAUTHORIZED,
        "This preview link has expired or is private.",
        "Open it again from its card in Instafy.",
    )
}

/// A static page that also tells the Studio pane what happened. The status is always a
/// validated number, so nothing request-controlled reaches the markup.
fn preview_page(status: StatusCode, heading: &str, detail: &str) -> Response {
    let code = status.as_u16();
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{heading}</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #FFFFFF; color: #0F172A; font: 16px/1.5 Arial, Helvetica, sans-serif; }}
main {{ box-sizing: border-box; width: 100%; max-width: 28rem; padding: 2rem 1.5rem; text-align: center; }}
h1 {{ margin: 0 0 0.5rem; font-size: 1.25rem; }}
p {{ margin: 0; color: #475569; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #141414; color: #E5E5E5; }} p {{ color: #A3A3A3; }} }}
</style>
</head>
<body>
<main><h1>{heading}</h1><p>{detail}</p></main>
<script>try {{ parent.postMessage({{ type: "instafy-preview", status: {code} }}, "*"); }} catch (e) {{}}</script>
</body>
</html>
"#
    );
    let mut response = Response::new(Body::from(html));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        ),
    );
    page_headers(&mut response);
    response
}

fn plain(status: StatusCode, message: &'static str) -> Response {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    page_headers(&mut response);
    response
}

/// Denials skip the headers middleware, so they carry the same privacy headers themselves.
fn page_headers(response: &mut Response) {
    no_store(response);
    let headers = response.headers_mut();
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex"));
}

fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{test_broker_config, HookConfig};
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LABEL: &str = "abcdefghijklmnopqrstuvwxyz";
    const HEX: &str = "0123456789abcdef0123456789abcdef";

    fn host(label: &str, hex: &str, domain: &str) -> String {
        format!("p-{label}--{hex}.{domain}")
    }

    #[test]
    fn parses_capability_hosts() {
        let parsed =
            parse_preview_host(&host(LABEL, HEX, "preview.localhost"), "preview.localhost")
                .expect("valid host");
        assert_eq!(parsed.label, LABEL);
        assert_eq!(parsed.tunnel_id, Uuid::parse_str(HEX).unwrap());

        let with_port = format!(
            "{}:8083",
            host("234567abcdefghijklmnopqrst", HEX, "preview.localhost")
        );
        assert!(parse_preview_host(&with_port, "preview.localhost").is_some());
        let fqdn = format!("{}.", host(LABEL, HEX, "preview.localhost"));
        assert!(parse_preview_host(&fqdn, "preview.localhost").is_some());
    }

    #[test]
    fn folds_uppercase_hosts_to_the_same_capability() {
        let upper = host(LABEL, HEX, "preview.localhost").to_ascii_uppercase();
        let parsed = parse_preview_host(&upper, "preview.localhost").expect("case-insensitive");
        assert_eq!(parsed.label, LABEL);
        assert_eq!(capability_hash(&parsed.label), capability_hash(LABEL));
    }

    #[test]
    fn rejects_bad_labels() {
        let domain = "preview.localhost";
        for label in [
            "abcdefghijklmnopqrstuvwxy",   // 25 chars
            "abcdefghijklmnopqrstuvwxyza", // 27 chars
            "abcdefghijklmnopqrstuvwxy1",  // 1 is not base32
            "abcdefghijklmnopqrstuvwxy8",  // 8 is not base32
            "abcdefghijklmnopqrstuvwxy-",
        ] {
            assert!(
                parse_preview_host(&host(label, HEX, domain), domain).is_none(),
                "{label}"
            );
        }
        for hex in [
            "0123456789abcdef0123456789abcde",   // short
            "0123456789abcdef0123456789abcdef0", // long
            "0123456789abcdef0123456789abcdeg",
            "01234567-89ab-cdef-0123-456789abcdef",
        ] {
            assert!(
                parse_preview_host(&host(LABEL, hex, domain), domain).is_none(),
                "{hex}"
            );
        }
        for raw in [
            "",
            "preview.localhost",
            &format!("{LABEL}--{HEX}.preview.localhost"),
            &format!("p-{LABEL}-{HEX}.preview.localhost"),
            &format!("x.p-{LABEL}--{HEX}.preview.localhost"),
            &format!("p-{LABEL}--{HEX}.x.preview.localhost"),
            &format!("p-{LABEL}--{HEX}, evil.preview.localhost"),
        ] {
            assert!(parse_preview_host(raw, domain).is_none(), "{raw}");
        }
    }

    #[test]
    fn rejects_other_domains() {
        let domain = "preview.localhost";
        for other in [
            "rt.localhost",
            "evilpreview.localhost",
            "preview.localhost.evil.test",
        ] {
            assert!(
                parse_preview_host(&host(LABEL, HEX, other), domain).is_none(),
                "{other}"
            );
        }
    }

    #[test]
    fn hashes_labels_as_lowercase_hex_sha256() {
        assert_eq!(
            capability_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn caches_allows_for_hook_ttl_capped_at_thirty_seconds() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let short = (Uuid::nil(), "short".to_string());
        let long = (Uuid::nil(), "long".to_string());
        cache.record(
            short.clone(),
            PreviewAuthDecision {
                allow: true,
                ttl_seconds: 10,
            },
            now,
        );
        cache.record(
            long.clone(),
            PreviewAuthDecision {
                allow: true,
                ttl_seconds: 3600,
            },
            now,
        );

        assert_eq!(cache.get(&short, now + Duration::from_secs(9)), Some(true));
        assert_eq!(cache.get(&short, now + Duration::from_secs(10)), None);
        assert_eq!(cache.get(&long, now + Duration::from_secs(29)), Some(true));
        assert_eq!(cache.get(&long, now + Duration::from_secs(30)), None);
    }

    #[test]
    fn caches_denials_for_five_seconds() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let key = (Uuid::nil(), "deny".to_string());
        cache.record(
            key.clone(),
            PreviewAuthDecision {
                allow: false,
                ttl_seconds: 600,
            },
            now,
        );
        assert_eq!(cache.get(&key, now + Duration::from_secs(4)), Some(false));
        assert_eq!(cache.get(&key, now + Duration::from_secs(5)), None);
    }

    #[test]
    fn does_not_cache_zero_ttl_allows() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let key = (Uuid::nil(), "zero".to_string());
        cache.record(
            key.clone(),
            PreviewAuthDecision {
                allow: true,
                ttl_seconds: 0,
            },
            now,
        );
        assert_eq!(cache.get(&key, now), None);
    }

    #[test]
    fn cache_evicts_least_recently_used_when_full() {
        let cache = DecisionCache::with_capacity(2, 2);
        let now = Instant::now();
        let allow = PreviewAuthDecision {
            allow: true,
            ttl_seconds: 30,
        };
        let a = (Uuid::nil(), "a".to_string());
        let b = (Uuid::nil(), "b".to_string());
        let c = (Uuid::nil(), "c".to_string());
        cache.record(a.clone(), allow, now);
        cache.record(b.clone(), allow, now + Duration::from_secs(1));
        assert_eq!(cache.get(&a, now + Duration::from_secs(2)), Some(true));
        cache.record(c.clone(), allow, now + Duration::from_secs(3));
        let later = now + Duration::from_secs(4);
        assert_eq!(cache.get(&a, later), Some(true));
        assert_eq!(cache.get(&b, later), None);
        assert_eq!(cache.get(&c, later), Some(true));
    }

    #[test]
    fn denial_floods_never_evict_allows() {
        let cache = DecisionCache::with_capacity(2, 2);
        let now = Instant::now();
        let member = (Uuid::nil(), "member".to_string());
        cache.record(
            member.clone(),
            PreviewAuthDecision {
                allow: true,
                ttl_seconds: 30,
            },
            now,
        );
        for index in 0..100 {
            cache.record(
                (Uuid::nil(), format!("random-{index}")),
                PreviewAuthDecision {
                    allow: false,
                    ttl_seconds: 0,
                },
                now,
            );
        }
        assert_eq!(cache.get(&member, now + Duration::from_secs(1)), Some(true));
        assert_eq!(cache.denies.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_newer_answer_replaces_the_other_kind() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let key = (Uuid::nil(), "flip".to_string());
        let deny = PreviewAuthDecision {
            allow: false,
            ttl_seconds: 0,
        };
        let allow = PreviewAuthDecision {
            allow: true,
            ttl_seconds: 30,
        };
        cache.record(key.clone(), allow, now);
        cache.record(key.clone(), deny, now);
        assert_eq!(cache.get(&key, now), Some(false));
        cache.record(key.clone(), allow, now);
        assert_eq!(cache.get(&key, now), Some(true));
    }

    #[test]
    fn hook_misses_are_limited_per_tunnel() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let busy = Uuid::from_u128(1);
        let quiet = Uuid::from_u128(2);
        let admitted = (0..100).filter(|_| cache.admit_miss(busy, now)).count();
        assert_eq!(admitted, MISS_BURST as usize);
        assert!(
            cache.admit_miss(quiet, now),
            "other tunnels keep their own budget"
        );
        assert!(!cache.admit_miss(busy, now + Duration::from_millis(50)));
        assert!(cache.admit_miss(busy, now + Duration::from_millis(150)));
    }

    fn test_state(hook_url: Option<String>) -> AppState {
        let mut config = test_broker_config();
        config.preview_auth_hook = hook_url.map(|url| HookConfig {
            url,
            token: Some("hook-secret".into()),
        });
        AppState::for_tests(config)
    }

    fn forwarded(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-host", HeaderValue::from_str(host).unwrap());
        headers
    }

    /// A stand-in controller hook that records calls and answers with `decision`.
    async fn spawn_hook(
        decision: serde_json::Value,
    ) -> (
        String,
        Arc<AtomicUsize>,
        Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    ) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (calls_in, seen_in) = (calls.clone(), seen.clone());
        let app = Router::new().route(
            "/hook",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let decision = decision.clone();
                    let (calls, seen) = (calls_in.clone(), seen_in.clone());
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        let bearer = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_string();
                        seen.lock().unwrap().push((bearer, body));
                        Json(decision)
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/hook"), calls, seen)
    }

    /// Like [`spawn_hook`], but each answer takes `delay`.
    async fn spawn_slow_hook(
        decision: serde_json::Value,
        delay: Duration,
    ) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_in = calls.clone();
        let app = Router::new().route(
            "/hook",
            post(move || {
                let (decision, calls) = (decision.clone(), calls_in.clone());
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    Json(decision)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/hook"), calls)
    }

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn blocks_service_worker_scripts() {
        let state = test_state(None);
        let mut headers = forwarded(&host(LABEL, HEX, "preview.localhost"));
        headers.insert("service-worker", HeaderValue::from_static("script"));
        let response = preview_auth(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn allows_through_the_hook_and_caches_the_answer() {
        let (url, calls, seen) =
            spawn_hook(serde_json::json!({"allow": true, "ttlSeconds": 30})).await;
        let state = test_state(Some(url));
        let headers = forwarded(&format!("{}:8083", host(LABEL, HEX, "preview.localhost")));

        let first = preview_auth(State(state.clone()), headers.clone()).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert!(body_text(first).await.is_empty());
        let second = preview_auth(State(state), headers).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "Bearer hook-secret");
        assert_eq!(
            seen[0].1,
            serde_json::json!({
                "tunnelId": Uuid::parse_str(HEX).unwrap().to_string(),
                "capabilityHash": capability_hash(LABEL),
            })
        );
        assert!(!seen[0].1.to_string().contains(LABEL));
    }

    #[tokio::test]
    async fn concurrent_misses_share_one_hook_call() {
        let (url, calls) = spawn_slow_hook(
            serde_json::json!({"allow": true, "ttlSeconds": 30}),
            Duration::from_millis(200),
        )
        .await;
        let state = test_state(Some(url));
        let headers = forwarded(&host(LABEL, HEX, "preview.localhost"));
        let requests = (0..8).map(|_| {
            let (state, headers) = (state.clone(), headers.clone());
            tokio::spawn(async move { preview_auth(State(state), headers).await.status() })
        });
        for request in requests.collect::<Vec<_>>() {
            assert_eq!(request.await.unwrap(), StatusCode::OK);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn random_labels_stop_reaching_the_hook_past_the_tunnel_limit() {
        let (url, calls, _) =
            spawn_hook(serde_json::json!({"allow": false, "ttlSeconds": 0})).await;
        let state = test_state(Some(url));
        for index in 0..(MISS_BURST as usize + 20) {
            let label: String = format!("{index:0>26}")
                .bytes()
                .map(|b| (b'a' + (b - b'0')) as char)
                .collect();
            let response = preview_auth(
                State(state.clone()),
                forwarded(&host(&label, HEX, "preview.localhost")),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(calls.load(Ordering::SeqCst), MISS_BURST as usize);
    }

    #[tokio::test]
    async fn a_label_flood_does_not_lock_out_a_member_whose_allow_expired() {
        // The hook allows only the member's label, for one second.
        let member = capability_hash(LABEL);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_in = calls.clone();
        let app = Router::new().route(
            "/hook",
            post(move |Json(body): Json<serde_json::Value>| {
                let (member, calls) = (member.clone(), calls_in.clone());
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let allow = body["capabilityHash"] == member;
                    Json(serde_json::json!({"allow": allow, "ttlSeconds": if allow { 1 } else { 0 }}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = test_state(Some(format!("http://{addr}/hook")));
        let member_host = forwarded(&host(LABEL, HEX, "preview.localhost"));
        assert_eq!(
            preview_auth(State(state.clone()), member_host.clone())
                .await
                .status(),
            StatusCode::OK
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        for index in 0..(MISS_BURST as usize + 20) {
            let label: String = format!("{index:0>26}")
                .bytes()
                .map(|b| (b'a' + (b - b'0')) as char)
                .collect();
            let response = preview_auth(
                State(state.clone()),
                forwarded(&host(&label, HEX, "preview.localhost")),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let before = calls.load(Ordering::SeqCst);
        assert_eq!(
            preview_auth(State(state.clone()), member_host)
                .await
                .status(),
            StatusCode::OK,
            "the member's expired allow is asked again outside the drained budget"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            before + 1,
            "and the hook is still asked"
        );
    }

    #[test]
    fn a_denial_forgets_that_a_key_was_allowed() {
        let cache = DecisionCache::new();
        let now = Instant::now();
        let key = (Uuid::from_u128(7), "h".to_string());
        cache.record(
            key.clone(),
            PreviewAuthDecision {
                allow: true,
                ttl_seconds: 30,
            },
            now,
        );
        assert!(cache.recently_allowed(&key, now + Duration::from_secs(60)));
        cache.record(
            key.clone(),
            PreviewAuthDecision {
                allow: false,
                ttl_seconds: 0,
            },
            now,
        );
        assert!(!cache.recently_allowed(&key, now));
        assert!(!cache.recently_allowed(&(Uuid::from_u128(8), "x".into()), now));
    }

    #[tokio::test]
    async fn denies_with_a_private_page() {
        let (url, calls, _) =
            spawn_hook(serde_json::json!({"allow": false, "ttlSeconds": 0})).await;
        let state = test_state(Some(url));
        let headers = forwarded(&host(LABEL, HEX, "preview.localhost"));

        let response = preview_auth(State(state.clone()), headers.clone()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        let body = body_text(response).await;
        assert!(body.contains("This preview link has expired or is private."));
        assert!(
            body.contains(r#"parent.postMessage({ type: "instafy-preview", status: 401 }, "*")"#)
        );

        let again = preview_auth(State(state), headers).await;
        assert_eq!(again.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "deny is cached");
    }

    #[tokio::test]
    async fn denies_when_the_hook_is_down() {
        // Bind and drop to get a port nothing listens on.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let state = test_state(Some(format!("http://{addr}/hook")));
        let response = preview_auth(
            State(state),
            forwarded(&host(LABEL, HEX, "preview.localhost")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn denies_without_hook_or_valid_host() {
        let state = test_state(None);
        let response = preview_auth(
            State(state),
            forwarded(&host(LABEL, HEX, "preview.localhost")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let (url, calls, _) =
            spawn_hook(serde_json::json!({"allow": true, "ttlSeconds": 30})).await;
        let state = test_state(Some(url));
        for headers in [
            HeaderMap::new(),
            forwarded(&host(LABEL, HEX, "rt.localhost")),
        ] {
            let response = preview_auth(State(state.clone()), headers).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn renders_error_pages_for_gateway_statuses() {
        let response = preview_error(Path("502".to_string())).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body_text(response).await;
        assert!(body.contains("This preview is not responding."));
        assert!(body.contains("status: 502"));

        let response = preview_error(Path("<script>".to_string())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = preview_error(Path("200".to_string())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
