//! Read-only census for the credential guard (docs/Local-Engine-Turns.md,
//! section 6): per space, the project secrets the guard stops delivering once
//! it ships. Those are secrets named `CLAUDE_CODE_OAUTH_TOKEN`, in any spelling
//! that `normalize_secret_name` turns into it, and secrets of any name whose
//! value is Claude sign-in material. The rules are the guard's own, since this
//! tool compiles `src/claude_material.rs`. A Claude API key or Admin API key is
//! not counted: it keeps working.
//!
//! It prints space ids, secret names and counts, never a value, and it writes
//! nothing: it reads in one read-only transaction.
//!
//! Run it server-side, from a checkout of the release that brings the guard,
//! with the controller's own database URL and credential keys:
//!
//! ```sh
//! DATABASE_URL='postgresql://…' \
//! CREDENTIAL_ENCRYPTION_KEY='…' \
//! CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS='…' \
//!   cargo run --release --example claude-material-census \
//!     --manifest-path packages/runtime-controller/Cargo.toml
//! ```
//!
//! The variables mean what they mean to the controller (src/config.rs).
//! `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` is optional and lists decrypt-only
//! keys. Under `DEV_MODE` without a key, the key is derived from
//! `USER_TOKEN_SECRET` as the controller derives it. The database connection
//! trusts the same roots as the controller's.
//!
//! Exit status: 0 when every active secret was read; 2 when some secret could
//! not be opened with the configured keys, in which case the report lists it
//! by name and its value went unchecked; 1 on any other error.
//!
//! Its tests need no database or network, and run with the controller's own
//! (`cargo test --manifest-path packages/runtime-controller/Cargo.toml`;
//! Cargo.toml lists this example with `test = true`), or alone with
//! `cargo test --example claude-material-census --manifest-path
//! packages/runtime-controller/Cargo.toml`.

// The guard's rules, compiled unchanged. Only its classification is used here;
// its refusal builder names the controller's error type, which `errors.rs`
// provides.
#[allow(dead_code)]
#[path = "../src/claude_material.rs"]
mod claude_material;
#[allow(dead_code)]
#[path = "../src/errors.rs"]
mod errors;

use std::collections::BTreeMap;
use std::process::ExitCode;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
// `claude_material.rs` names it as `crate::ApiError`, as in the controller.
use errors::ApiError;
use sha2::{Digest, Sha256};
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

/// What `USER_TOKEN_SECRET` falls back to under `DEV_MODE` (src/config.rs).
const DEV_USER_TOKEN_SECRET: &str = "dev-user-token-secret";

/// The authority Supabase's managed databases use, which the controller trusts
/// besides the public web roots (src/config.rs).
const SUPABASE_PROD_CA_2021: &str = include_str!("../certs/supabase-prod-ca-2021.pem");

/// The exit status when some secret could not be opened.
const INCOMPLETE: u8 = 2;

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(census) => {
            print!("{}", census.report());
            if census.is_complete() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(INCOMPLETE)
            }
        }
        Err(error) => {
            eprintln!("claude-material-census: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<Census> {
    let keys = KeyRing::from_env()?;
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let (mut client, connection) = tokio_postgres::connect(&database_url, database_tls()?)
        .await
        .context("could not connect to DATABASE_URL")?;
    let driver = tokio::spawn(connection);

    let transaction = client.build_transaction().read_only(true).start().await?;
    let mut census = Census::default();
    // The controller creates the table on first use.
    let stored: bool = transaction
        .query_one("select to_regclass('project_secrets') is not null", &[])
        .await?
        .get(0);
    if stored {
        let rows = transaction
            .query(
                "select project_id, name, nonce_b64, ciphertext_b64
                 from project_secrets
                 where revoked_at is null",
                &[],
            )
            .await?;
        for row in rows {
            let value = keys.open(row.get("nonce_b64"), row.get("ciphertext_b64"));
            census.record(row.get("project_id"), row.get("name"), value.as_deref());
        }
    }
    transaction.rollback().await?;
    drop(client);
    let _ = driver.await;
    Ok(census)
}

/// The controller's credential keys: the primary key, then the decrypt-only
/// previous keys, in that order.
struct KeyRing(Vec<[u8; 32]>);

impl KeyRing {
    fn from_env() -> anyhow::Result<Self> {
        let var = |name: &str| std::env::var(name).ok();
        Self::from_values(
            var("DEV_MODE").as_deref(),
            var("USER_TOKEN_SECRET").as_deref(),
            var("CREDENTIAL_ENCRYPTION_KEY").as_deref(),
            var("CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS").as_deref(),
        )
    }

    /// The ring as `resolve_credential_encryption_key` and
    /// `resolve_credential_key_ring` in src/config.rs build it. Messages never
    /// include a value.
    fn from_values(
        dev_mode: Option<&str>,
        user_token_secret: Option<&str>,
        primary: Option<&str>,
        previous: Option<&str>,
    ) -> anyhow::Result<Self> {
        let dev_mode = dev_mode
            .map(str::to_lowercase)
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"));
        let primary = match primary.map(str::trim).filter(|value| !value.is_empty()) {
            Some(raw) => decode_key(raw)
                .context("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key")?,
            None if dev_mode => derive_development_key(
                user_token_secret
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(DEV_USER_TOKEN_SECRET),
            ),
            None => bail!("CREDENTIAL_ENCRYPTION_KEY must be set outside DEV_MODE"),
        };
        let mut keys = vec![primary];
        let previous = previous
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty());
        for (index, entry) in previous.enumerate() {
            keys.push(decode_key(entry).with_context(|| {
                format!(
                    "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS entry {} must be a base64-encoded \
                     32-byte key",
                    index + 1
                )
            })?);
        }
        Ok(Self(keys))
    }

    /// A stored value, when a configured key opens it and it is UTF-8. Values
    /// are sealed with AES-256-GCM and no associated data, the nonce and the
    /// ciphertext stored apart in base64 (src/credential_keys.rs).
    fn open(&self, nonce_b64: &str, ciphertext_b64: &str) -> Option<String> {
        let nonce: [u8; 12] = BASE64.decode(nonce_b64.trim()).ok()?.try_into().ok()?;
        let ciphertext = BASE64.decode(ciphertext_b64.trim()).ok()?;
        let plaintext = self.0.iter().find_map(|key| {
            Aes256Gcm::new_from_slice(key)
                .ok()?
                .decrypt(&Nonce::from(nonce), ciphertext.as_slice())
                .ok()
        })?;
        String::from_utf8(plaintext).ok()
    }
}

fn decode_key(raw: &str) -> Option<[u8; 32]> {
    BASE64.decode(raw.trim()).ok()?.try_into().ok()
}

/// The `DEV_MODE` key, derived as `CredentialEncryptionKey` derives it from
/// `USER_TOKEN_SECRET` (src/config.rs).
fn derive_development_key(user_token_secret: &str) -> [u8; 32] {
    Sha256::new()
        .chain_update(b"instafy:credential-encryption-key:v1:")
        .chain_update(user_token_secret.as_bytes())
        .finalize()
        .into()
}

/// The roots `database_tls` in src/config.rs trusts.
fn database_tls() -> anyhow::Result<MakeRustlsConnect> {
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    for certificate in rustls_pemfile::certs(&mut SUPABASE_PROD_CA_2021.as_bytes()) {
        roots.add(certificate.context("the bundled Supabase CA certificate does not parse")?)?;
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(MakeRustlsConnect::new(config))
}

/// Active project secrets by space: the ones the guard refuses, and the ones
/// no configured key opens. Only names are kept.
#[derive(Default)]
struct Census {
    checked: usize,
    refused: BTreeMap<Uuid, Vec<String>>,
    unreadable: BTreeMap<Uuid, Vec<String>>,
}

impl Census {
    /// Counts one active secret. `value` is `None` when no configured key
    /// opens it; such a secret is still refused when its name is reserved.
    fn record(&mut self, space_id: Uuid, name: &str, value: Option<&str>) {
        self.checked += 1;
        let spaces = if claude_material::is_refused_secret(name, value) {
            &mut self.refused
        } else if value.is_none() {
            &mut self.unreadable
        } else {
            return;
        };
        spaces.entry(space_id).or_default().push(name.to_string());
    }

    fn is_complete(&self) -> bool {
        self.unreadable.is_empty()
    }

    /// The report: space ids, secret names and counts, never a value.
    fn report(&self) -> String {
        let mut lines = vec![format!(
            "Checked {} in project_secrets.",
            counted(self.checked, "active secret")
        )];
        if self.refused.is_empty() {
            lines.push(
                "None holds a Claude sign-in, so the credential guard stops delivering nothing."
                    .to_string(),
            );
        } else {
            lines.push(format!(
                "The credential guard stops delivering {} in {}:",
                counted(self.refused.values().map(Vec::len).sum(), "secret"),
                counted(self.refused.len(), "space"),
            ));
            lines.extend(space_lines(&self.refused));
        }
        if !self.is_complete() {
            lines.push(format!(
                "Incomplete: no configured key opens {} in {}, so only their names were checked:",
                counted(self.unreadable.values().map(Vec::len).sum(), "secret"),
                counted(self.unreadable.len(), "space"),
            ));
            lines.extend(space_lines(&self.unreadable));
        }
        lines.join("\n") + "\n"
    }
}

fn space_lines(spaces: &BTreeMap<Uuid, Vec<String>>) -> Vec<String> {
    spaces
        .iter()
        .map(|(space_id, names)| {
            // A legacy name was never checked against the name rules, so it is
            // escaped before it reaches a terminal.
            let mut names: Vec<String> = names
                .iter()
                .map(|name| name.escape_debug().to_string())
                .collect();
            names.sort();
            format!("  space {space_id}: {} ({})", names.len(), names.join(", "))
        })
        .collect()
}

fn counted(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Inert stand-ins with the shapes the guard reads. None is a real key or token.
    const OAUTH_ACCESS: &str = "sk-ant-oat01-inert-census-access";
    const API_KEY: &str = "sk-ant-api03-inert-census-api-key";
    const ADMIN_KEY: &str = "sk-ant-admin01-inert-census-admin-key";

    fn space(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn seal(key: &[u8; 32], plaintext: &[u8]) -> (String, String) {
        let nonce = [7u8; 12];
        let ciphertext = Aes256Gcm::new_from_slice(key)
            .expect("a 32-byte key")
            .encrypt(&Nonce::from(nonce), plaintext)
            .expect("seals");
        (BASE64.encode(nonce), BASE64.encode(ciphertext))
    }

    #[test]
    fn the_census_counts_what_the_guard_refuses_and_nothing_else() {
        let mut census = Census::default();
        census.record(space(1), "CLAUDE_CODE_OAUTH_TOKEN", Some("inert"));
        census.record(space(1), "claude-code-oauth-token", None);
        census.record(space(1), "DEPLOY_TOKEN", Some(OAUTH_ACCESS));
        census.record(space(2), "SETTINGS", Some(r#"{"claudeAiOauth":{}}"#));
        census.record(space(2), "ANTHROPIC_API_KEY", Some(API_KEY));
        census.record(space(2), "ANTHROPIC_ADMIN_KEY", Some(ADMIN_KEY));
        census.record(space(3), "RISK_NOTE", Some("risk-ant-oat01-inert"));
        census.record(space(3), "PLAIN", Some("inert"));

        assert_eq!(census.checked, 8);
        assert_eq!(
            census.refused,
            BTreeMap::from([
                (
                    space(1),
                    vec![
                        "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                        "claude-code-oauth-token".to_string(),
                        "DEPLOY_TOKEN".to_string(),
                    ]
                ),
                (space(2), vec!["SETTINGS".to_string()]),
            ])
        );
        // A reserved name needs no value, so the census stays complete.
        assert!(census.is_complete());
    }

    #[test]
    fn the_report_names_spaces_and_secrets_and_never_a_value() {
        let mut census = Census::default();
        census.record(space(1), "DEPLOY_TOKEN", Some(OAUTH_ACCESS));
        census.record(
            space(1),
            "CLAUDE_CODE_OAUTH_TOKEN",
            Some("inert-reserved-value"),
        );
        census.record(space(2), "ANTHROPIC_API_KEY", Some(API_KEY));
        let report = census.report();
        assert_eq!(
            report,
            format!(
                "Checked 3 active secrets in project_secrets.\n\
                 The credential guard stops delivering 2 secrets in 1 space:\n  \
                 space {}: 2 (CLAUDE_CODE_OAUTH_TOKEN, DEPLOY_TOKEN)\n",
                space(1)
            )
        );
        for value in [OAUTH_ACCESS, "inert-reserved-value", API_KEY, "sk-ant-"] {
            assert!(!report.contains(value), "{report}");
        }

        let mut empty = Census::default();
        empty.record(space(3), "ANTHROPIC_API_KEY", Some(API_KEY));
        assert_eq!(
            empty.report(),
            "Checked 1 active secret in project_secrets.\n\
             None holds a Claude sign-in, so the credential guard stops delivering nothing.\n"
        );
    }

    #[test]
    fn a_secret_no_key_opens_makes_the_census_incomplete() {
        let mut census = Census::default();
        census.record(space(4), "LEGACY_TOKEN", None);
        census.record(space(4), "PLAIN", Some("inert"));
        assert!(!census.is_complete());
        let report = census.report();
        assert!(
            report.contains(&format!(
                "Incomplete: no configured key opens 1 secret in 1 space, so only their names \
                 were checked:\n  space {}: 1 (LEGACY_TOKEN)\n",
                space(4)
            )),
            "{report}"
        );
    }

    #[test]
    fn names_are_escaped_before_they_reach_a_terminal() {
        let mut census = Census::default();
        census.record(
            space(5),
            "CLAUDE_CODE_OAUTH_TOKEN\u{1b}[2J",
            Some(OAUTH_ACCESS),
        );
        let report = census.report();
        assert!(!report.contains('\u{1b}'), "{report:?}");
        assert!(
            report.contains("CLAUDE_CODE_OAUTH_TOKEN\\u{1b}[2J"),
            "{report}"
        );
    }

    #[test]
    fn keys_are_read_as_the_controller_reads_them() {
        let primary = [1u8; 32];
        let previous = [2u8; 32];
        let ring = KeyRing::from_values(
            None,
            None,
            Some(&format!(" {} ", BASE64.encode(primary))),
            Some(&format!(" , {} ,", BASE64.encode(previous))),
        )
        .expect("valid keys");
        assert_eq!(ring.0, vec![primary, previous]);

        // Outside DEV_MODE the key must be configured, and a malformed one is
        // named without its value.
        let missing = KeyRing::from_values(None, Some("a-signing-secret"), None, None)
            .err()
            .expect("no key outside DEV_MODE");
        assert!(missing.to_string().contains("CREDENTIAL_ENCRYPTION_KEY"));
        let malformed = KeyRing::from_values(None, None, Some("not-a-real-key-value"), None)
            .err()
            .expect("a malformed key");
        assert!(!format!("{malformed:#}").contains("not-a-real-key-value"));
        let previous_error = KeyRing::from_values(
            None,
            None,
            Some(&BASE64.encode(primary)),
            Some("not-a-real-previous-key"),
        )
        .err()
        .expect("a malformed previous key");
        let previous_error = format!("{previous_error:#}");
        assert!(previous_error.contains("entry 1"), "{previous_error}");
        assert!(!previous_error.contains("not-a-real-previous-key"));

        // Under DEV_MODE the key is derived from USER_TOKEN_SECRET. With the
        // published development secret it is the key whose one-way id the
        // controller pins as PUBLISHED_DEVELOPMENT_KEY_ID.
        for dev_mode in ["1", "true", "YES", "on"] {
            let ring = KeyRing::from_values(Some(dev_mode), None, None, None).expect("DEV_MODE");
            let key_id = Sha256::new()
                .chain_update(b"instafy:credential-encryption-key-id:v1:")
                .chain_update(ring.0[0])
                .finalize();
            assert_eq!(hex::encode(&key_id[..6]), "f986c240abce", "{dev_mode}");
        }
        let derived =
            KeyRing::from_values(Some("1"), Some(" a-signing-secret "), None, None).expect("dev");
        assert_eq!(derived.0, vec![derive_development_key("a-signing-secret")]);
        assert!(KeyRing::from_values(Some("0"), None, None, None).is_err());
    }

    #[test]
    fn values_open_under_any_configured_key() {
        let primary = [1u8; 32];
        let previous = [2u8; 32];
        let ring = KeyRing(vec![primary, previous]);
        let (nonce, ciphertext) = seal(&previous, OAUTH_ACCESS.as_bytes());
        assert_eq!(
            ring.open(&nonce, &ciphertext).as_deref(),
            Some(OAUTH_ACCESS)
        );
        assert_eq!(KeyRing(vec![primary]).open(&nonce, &ciphertext), None);
        let (nonce, not_utf8) = seal(&primary, &[0xff, 0xfe]);
        assert_eq!(ring.open(&nonce, &not_utf8), None);
        assert_eq!(ring.open("not base64", &ciphertext), None);
        assert_eq!(ring.open(&BASE64.encode([0u8; 12]), "AAAA"), None);
    }
}
