//! Who a user's saves are attributed to in a space's git history.
//!
//! Commits never carry a user id or an account email. A save made with a
//! user's workspace-write token is authored by a per-space pseudonym,
//! `p<version>-<hmac>@users.noreply.instafy.dev`, keyed by a controller
//! secret (`INSTAFY_AUTHOR_PSEUDONYM_KEYS`), and the display name from
//! `profiles.full_name` (or "Instafy user"). The controller signs both into
//! the origin token as `author_name` / `author_email`; origins that do not
//! read them, or tokens without them, keep the origin's own identity.
//!
//! The keyring is versioned and the email carries the version, so adding a
//! key changes the address of new commits only: every older address still
//! resolves with the key that made it, as long as that key stays configured.
//! Keys are therefore only ever added, never removed or replaced.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::{AppConfig, PgPool};

/// Environment variable holding the keyring: comma-separated
/// `v<version>:<base64 key>` entries, for example `v1:<key>,v2:<key>`.
pub const AUTHOR_PSEUDONYM_KEYS_ENV: &str = "INSTAFY_AUTHOR_PSEUDONYM_KEYS";
/// Domain of every pseudonymous author address.
pub const AUTHOR_EMAIL_DOMAIN: &str = "users.noreply.instafy.dev";
/// Display name when a user has no usable `profiles.full_name`.
pub const AUTHOR_FALLBACK_NAME: &str = "Instafy user";

/// Domain separation for the pseudonym HMAC. Changing it renames every
/// author, so it is fixed; a new derivation would need a new label.
const PSEUDONYM_DOMAIN_LABEL: &[u8] = b"instafy:author-pseudonym:v1\0";
/// Base32 characters of the HMAC kept in the address (100 bits).
const PSEUDONYM_HASH_CHARS: usize = 20;
const MIN_KEY_BYTES: usize = 32;
const MAX_KEY_BYTES: usize = 64;
const MAX_KEY_VERSION: u32 = 9_999;
const MAX_KEYS: usize = 64;
/// Upper bound on a display name written into a commit.
const MAX_DISPLAY_NAME_BYTES: usize = 64;
const BASE32_LOWER: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

type HmacSha256 = Hmac<Sha256>;

/// The `author_name` / `author_email` claims of a workspace-write token.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthorClaims {
    pub name: String,
    pub email: String,
}

impl std::fmt::Debug for AuthorClaims {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The pseudonym is not secret, but keep display names out of logs.
        f.debug_struct("AuthorClaims")
            .field("email", &self.email)
            .finish_non_exhaustive()
    }
}

/// Versioned HMAC keys for author pseudonyms. The highest version signs new
/// addresses; every version stays usable to resolve the addresses it made.
#[derive(Clone)]
pub struct AuthorPseudonymKeyring {
    keys: BTreeMap<u32, Vec<u8>>,
}

impl std::fmt::Debug for AuthorPseudonymKeyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorPseudonymKeyring")
            .field("versions", &self.versions())
            .finish_non_exhaustive()
    }
}

impl AuthorPseudonymKeyring {
    /// Parse `v<version>:<base64 key>` entries separated by commas. Empty
    /// entries are ignored. Every key must decode to 32-64 bytes; versions
    /// are positive integers without leading zeros, each used once, and no
    /// key may appear under two versions (a rotation that changed nothing).
    /// Messages name entries by position and version, never by value.
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        let mut keys: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let entries = raw
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty());
        for (index, entry) in entries.enumerate() {
            let position = index + 1;
            anyhow::ensure!(
                position <= MAX_KEYS,
                "{AUTHOR_PSEUDONYM_KEYS_ENV} lists more than {MAX_KEYS} keys"
            );
            let (label, encoded) = entry.split_once(':').ok_or_else(|| {
                anyhow::anyhow!(
                    "{AUTHOR_PSEUDONYM_KEYS_ENV} entry {position} must look like v<version>:<base64 key>"
                )
            })?;
            let version = parse_key_version(label.trim()).ok_or_else(|| {
                anyhow::anyhow!(
                    "{AUTHOR_PSEUDONYM_KEYS_ENV} entry {position} must start with v1 to \
                     v{MAX_KEY_VERSION} (no leading zeros)"
                )
            })?;
            let key = BASE64
                .decode(encoded.trim().as_bytes())
                .ok()
                .filter(|key| (MIN_KEY_BYTES..=MAX_KEY_BYTES).contains(&key.len()))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "{AUTHOR_PSEUDONYM_KEYS_ENV} entry {position} (v{version}) must be a \
                         base64-encoded key of {MIN_KEY_BYTES} to {MAX_KEY_BYTES} bytes; \
                         generate one with `openssl rand -base64 32`"
                    )
                })?;
            if keys.contains_key(&version) {
                anyhow::bail!("{AUTHOR_PSEUDONYM_KEYS_ENV} lists v{version} more than once");
            }
            if let Some((&other, _)) = keys.iter().find(|(_, existing)| **existing == key) {
                anyhow::bail!(
                    "{AUTHOR_PSEUDONYM_KEYS_ENV} v{other} and v{version} are the same key; a new \
                     version needs a newly generated key"
                );
            }
            keys.insert(version, key);
        }
        anyhow::ensure!(
            !keys.is_empty(),
            "{AUTHOR_PSEUDONYM_KEYS_ENV} lists no keys"
        );
        Ok(Self { keys })
    }

    /// The version that signs new addresses.
    pub fn current_version(&self) -> u32 {
        *self
            .keys
            .keys()
            .next_back()
            .expect("a parsed keyring holds at least one key")
    }

    pub fn versions(&self) -> Vec<u32> {
        self.keys.keys().copied().collect()
    }

    /// The pseudonymous author address of `user_id` in `project_id`, under
    /// the current key.
    pub fn pseudonym(&self, project_id: &Uuid, user_id: &Uuid) -> String {
        let version = self.current_version();
        pseudonym_with_key(version, &self.keys[&version], project_id, user_id)
    }

    /// Whether `email` is the pseudonym of `user_id` in `project_id` under
    /// any configured version, including retired ones. This is what keeps
    /// History able to name the authors of old commits after a rotation; its
    /// caller (resolving History authors for project members) is not built
    /// yet.
    #[allow(dead_code)]
    pub fn resolves(&self, email: &str, project_id: &Uuid, user_id: &Uuid) -> bool {
        let Some(version) = pseudonym_version(email) else {
            return false;
        };
        let Some(key) = self.keys.get(&version) else {
            return false;
        };
        let expected = pseudonym_with_key(version, key, project_id, user_id);
        expected.as_bytes().ct_eq(email.as_bytes()).unwrap_u8() == 1
    }
}

fn parse_key_version(label: &str) -> Option<u32> {
    let digits = label.strip_prefix('v')?;
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    digits
        .parse::<u32>()
        .ok()
        .filter(|version| (1..=MAX_KEY_VERSION).contains(version))
}

/// The key version an author address was made with, if it is a pseudonym.
#[allow(dead_code)]
pub fn pseudonym_version(email: &str) -> Option<u32> {
    let local = email.strip_suffix(AUTHOR_EMAIL_DOMAIN)?.strip_suffix('@')?;
    let rest = local.strip_prefix('p')?;
    let (digits, hash) = rest.split_once('-')?;
    if hash.len() != PSEUDONYM_HASH_CHARS || !hash.bytes().all(|byte| BASE32_LOWER.contains(&byte))
    {
        return None;
    }
    parse_key_version(&format!("v{digits}"))
}

fn pseudonym_with_key(version: u32, key: &[u8], project_id: &Uuid, user_id: &Uuid) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(PSEUDONYM_DOMAIN_LABEL);
    mac.update(project_id.as_bytes());
    mac.update(user_id.as_bytes());
    let digest = mac.finalize().into_bytes();
    let encoded = base32_lower(&digest);
    format!(
        "p{version}-{}@{AUTHOR_EMAIL_DOMAIN}",
        &encoded[..PSEUDONYM_HASH_CHARS]
    )
}

/// RFC 4648 base32, lower-case, without padding.
fn base32_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_LOWER[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_LOWER[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Resolve the keyring at startup. A hosted workspace gateway commits every
/// cloud save, so with `HOSTED_ORIGIN_ENDPOINT` configured the keyring is
/// required. Without one, saves keep each origin's own identity.
pub fn resolve_author_pseudonym_keys(
    configured: Option<&str>,
    hosted_origin_endpoint_configured: bool,
) -> anyhow::Result<Option<AuthorPseudonymKeyring>> {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => {
            let keyring = AuthorPseudonymKeyring::parse(raw)?;
            info!(
                versions = ?keyring.versions(),
                current = keyring.current_version(),
                "author pseudonym keys configured"
            );
            Ok(Some(keyring))
        }
        None if hosted_origin_endpoint_configured => anyhow::bail!(
            "{AUTHOR_PSEUDONYM_KEYS_ENV} must be set when HOSTED_ORIGIN_ENDPOINT is configured: \
             the hosted gateway attributes cloud saves to per-space pseudonyms made with it. \
             Generate a key with `openssl rand -base64 32` and set \
             {AUTHOR_PSEUDONYM_KEYS_ENV}=v1:<key>"
        ),
        None => {
            warn!(
                "{AUTHOR_PSEUDONYM_KEYS_ENV} is unset: workspace-write tokens carry no author, so \
                 saves are attributed to each origin's own git identity"
            );
            Ok(None)
        }
    }
}

/// The name written as a commit's author: `profiles.full_name` with control
/// characters and angle brackets removed, whitespace collapsed and at most
/// 64 bytes, or "Instafy user". A name that contains `@` is not used, so an
/// email address typed as a name never reaches history.
pub fn author_display_name(full_name: Option<&str>) -> String {
    let cleaned = full_name
        .unwrap_or_default()
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>') {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed.contains('@') {
        return AUTHOR_FALLBACK_NAME.to_string();
    }
    let mut end = MAX_DISPLAY_NAME_BYTES.min(collapsed.len());
    while !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    let bounded = collapsed[..end].trim();
    if bounded.is_empty() {
        AUTHOR_FALLBACK_NAME.to_string()
    } else {
        bounded.to_string()
    }
}

/// `profiles.full_name` only. The account email is never a fallback.
async fn load_author_full_name(pool: &PgPool, user_id: &Uuid) -> anyhow::Result<Option<String>> {
    let connection = pool.get().await?;
    let row = connection
        .query_opt(
            "select full_name from profiles where user_id = $1 limit 1",
            &[user_id],
        )
        .await?;
    Ok(row.and_then(|row| row.get::<_, Option<String>>("full_name")))
}

/// The author claims for a workspace-write token whose subject is
/// `user_id`, or `None` when no keyring is configured or the subject is the
/// controller's service runtime user (not a person). A profile lookup
/// failure falls back to the default display name, so it never blocks a save.
pub async fn author_claims_for_user(
    config: &AppConfig,
    pool: &PgPool,
    project_id: &Uuid,
    user_id: &Uuid,
) -> Option<AuthorClaims> {
    let keyring = config.author_pseudonym_keys.as_ref()?;
    if config.service_runtime_user_id == Some(*user_id) {
        return None;
    }
    let full_name = match load_author_full_name(pool, user_id).await {
        Ok(name) => name,
        Err(error) => {
            warn!(
                project_id = %project_id,
                error = %error,
                "failed to load the author display name; using the default"
            );
            None
        }
    };
    Some(AuthorClaims {
        name: author_display_name(full_name.as_deref()),
        email: keyring.pseudonym(project_id, user_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_V1: &str = "ERERERERERERERERERERERERERERERERERERERERERE=";
    const KEY_V2: &str = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=";

    fn project() -> Uuid {
        Uuid::parse_str("6f1c2a8e-0b5d-4c3e-9a7f-2d4e6b8c0a1f").unwrap()
    }

    fn user() -> Uuid {
        Uuid::parse_str("3b9d7e21-5c4a-4f8e-b6d2-1a0c9e8f7d65").unwrap()
    }

    #[test]
    fn base32_matches_rfc_4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "my"),
            ("fo", "mzxq"),
            ("foo", "mzxw6"),
            ("foob", "mzxw6yq"),
            ("fooba", "mzxw6ytb"),
            ("foobar", "mzxw6ytboi"),
        ] {
            assert_eq!(base32_lower(input.as_bytes()), expected, "{input:?}");
        }
    }

    #[test]
    fn pseudonym_is_a_fixed_hmac_of_project_and_user() {
        // Known answer: renaming every author by accident must fail a test.
        let keyring = AuthorPseudonymKeyring::parse(&format!("v1:{KEY_V1}")).unwrap();
        let email = keyring.pseudonym(&project(), &user());
        assert_eq!(email, "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev");
        assert_eq!(keyring.pseudonym(&project(), &user()), email);
        assert!(!email.contains(&user().to_string()));
        assert!(!email.contains(&user().simple().to_string()));
        assert!(!email.contains(&project().to_string()));

        // Per space and per user.
        assert_ne!(keyring.pseudonym(&Uuid::new_v4(), &user()), email);
        assert_ne!(keyring.pseudonym(&project(), &Uuid::new_v4()), email);
        assert_eq!(pseudonym_version(&email), Some(1));
    }

    #[test]
    fn highest_version_signs_and_rotation_keeps_old_addresses_resolvable() {
        let before = AuthorPseudonymKeyring::parse(&format!("v1:{KEY_V1}")).unwrap();
        let old = before.pseudonym(&project(), &user());

        // Order in the variable does not matter; v2 signs.
        let rotated =
            AuthorPseudonymKeyring::parse(&format!(" v2:{KEY_V2} ,, v1:{KEY_V1} ,")).unwrap();
        assert_eq!(rotated.versions(), vec![1, 2]);
        assert_eq!(rotated.current_version(), 2);
        let new = rotated.pseudonym(&project(), &user());
        assert_eq!(new, "p2-dbrguygjwtzw7bzs7d2p@users.noreply.instafy.dev");

        assert!(rotated.resolves(&old, &project(), &user()));
        assert!(rotated.resolves(&new, &project(), &user()));
        assert!(!rotated.resolves(&old, &project(), &Uuid::new_v4()));
        assert!(!rotated.resolves(&old, &Uuid::new_v4(), &user()));

        // Dropping a key strands every address it made: keys are only added.
        let dropped = AuthorPseudonymKeyring::parse(&format!("v2:{KEY_V2}")).unwrap();
        assert!(!dropped.resolves(&old, &project(), &user()));
        assert!(dropped.resolves(&new, &project(), &user()));

        for not_a_pseudonym in [
            "someone@example.com",
            "p1-3ujoyn5txgxsverj7psd@example.com",
            "p01-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev",
            "p1-3UJOYN5TXGXSVERJ7PSD@users.noreply.instafy.dev",
            "p1-short@users.noreply.instafy.dev",
        ] {
            assert!(
                !rotated.resolves(not_a_pseudonym, &project(), &user()),
                "{not_a_pseudonym}"
            );
        }
    }

    #[test]
    fn keyring_parse_refuses_malformed_entries_without_echoing_them() {
        let short = BASE64.encode([0x33u8; 16]);
        let long = BASE64.encode([0x44u8; 65]);
        for (raw, diagnostic) in [
            (",  ,".to_string(), "lists no keys"),
            (KEY_V1.to_string(), "entry 1 must look like v<version>"),
            (format!("1:{KEY_V1}"), "entry 1 must start with v1"),
            (format!("v0:{KEY_V1}"), "entry 1 must start with v1"),
            (format!("v01:{KEY_V1}"), "entry 1 must start with v1"),
            (format!("vx:{KEY_V1}"), "entry 1 must start with v1"),
            (format!("v10000:{KEY_V1}"), "entry 1 must start with v1"),
            (
                format!("v1:{KEY_V1},v2:{short}"),
                "entry 2 (v2) must be a base64",
            ),
            (format!("v1:{long}"), "entry 1 (v1) must be a base64"),
            ("v1:not*base64".to_string(), "entry 1 (v1) must be a base64"),
            (
                format!("v1:{KEY_V1},v1:{KEY_V2}"),
                "lists v1 more than once",
            ),
            (
                format!("v1:{KEY_V1},v2:{KEY_V1}"),
                "v1 and v2 are the same key",
            ),
        ] {
            let error = AuthorPseudonymKeyring::parse(&raw)
                .expect_err(&raw)
                .to_string();
            assert!(error.contains(diagnostic), "{error}");
            assert!(error.contains(AUTHOR_PSEUDONYM_KEYS_ENV), "{error}");
            for secret in [KEY_V1, KEY_V2, short.as_str(), long.as_str(), "not*base64"] {
                assert!(!error.contains(secret), "{error}");
            }
        }
    }

    #[test]
    fn keyring_debug_output_names_versions_only() {
        let keyring = AuthorPseudonymKeyring::parse(&format!("v1:{KEY_V1},v2:{KEY_V2}")).unwrap();
        let debug = format!("{keyring:?}");
        assert!(debug.contains("[1, 2]"), "{debug}");
        assert!(
            !debug.contains(KEY_V1) && !debug.contains(KEY_V2),
            "{debug}"
        );
        assert!(!debug.contains("17, 17"), "{debug}");
    }

    #[test]
    fn hosted_gateway_requires_the_keyring() {
        let error = resolve_author_pseudonym_keys(None, true)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("must be set when HOSTED_ORIGIN_ENDPOINT"),
            "{error}"
        );
        assert!(resolve_author_pseudonym_keys(Some("   "), true).is_err());

        assert!(resolve_author_pseudonym_keys(None, false)
            .unwrap()
            .is_none());
        assert!(resolve_author_pseudonym_keys(Some(""), false)
            .unwrap()
            .is_none());
        let configured = resolve_author_pseudonym_keys(Some(&format!("v1:{KEY_V1}")), true)
            .unwrap()
            .expect("configured keyring");
        assert_eq!(configured.current_version(), 1);
        // A malformed value is refused even without a hosted gateway.
        assert!(resolve_author_pseudonym_keys(Some("v1:short"), false).is_err());
    }

    #[test]
    fn display_name_comes_from_the_profile_name_only() {
        assert_eq!(author_display_name(Some("Ada Lovelace")), "Ada Lovelace");
        assert_eq!(
            author_display_name(Some("  Ada \n\t <Lovelace>  ")),
            "Ada Lovelace"
        );
        assert_eq!(author_display_name(None), AUTHOR_FALLBACK_NAME);
        assert_eq!(author_display_name(Some(" \u{7} ")), AUTHOR_FALLBACK_NAME);
        assert_eq!(
            author_display_name(Some("ada@example.com")),
            AUTHOR_FALLBACK_NAME
        );
        let long = author_display_name(Some(&"å".repeat(80)));
        assert!(long.len() <= MAX_DISPLAY_NAME_BYTES);
        assert!(long.chars().all(|ch| ch == 'å'));
    }
}
