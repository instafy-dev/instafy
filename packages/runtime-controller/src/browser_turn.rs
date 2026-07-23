use std::collections::HashSet;
use std::fmt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha1::Sha1;
use uuid::Uuid;

pub(crate) const TURN_URLS_ENV: &str = "CONTROLLER_BROWSER_TURN_URLS";
pub(crate) const TURN_SHARED_SECRET_ENV: &str = "CONTROLLER_BROWSER_TURN_SHARED_SECRET";
pub(crate) const TURN_TTL_ENV: &str = "CONTROLLER_BROWSER_TURN_CREDENTIAL_TTL_SECONDS";
pub(crate) const WEBRTC_PROJECT_IDS_ENV: &str = "CONTROLLER_BROWSER_WEBRTC_PROJECT_IDS";

const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS: i64 = 3_600;
const MIN_TURN_CREDENTIAL_TTL_SECONDS: i64 = 300;
const MAX_TURN_CREDENTIAL_TTL_SECONDS: i64 = 86_400;
const MAX_TURN_URLS: usize = 4;
const MAX_TURN_URL_BYTES: usize = 2_048;
const MAX_TURN_URLS_BYTES: usize = MAX_TURN_URLS * MAX_TURN_URL_BYTES;
const MIN_TURN_SHARED_SECRET_BYTES: usize = 32;
const MAX_TURN_SHARED_SECRET_BYTES: usize = 4_096;
const MAX_WEBRTC_PROJECT_IDS: usize = 256;

/// Controller-only coturn REST configuration. The shared secret is deliberately
/// private and redacted from `Debug`; only derived, expiring credentials leave
/// the controller.
#[derive(Clone)]
pub(crate) struct BrowserTurnRestConfig {
    urls: Vec<String>,
    shared_secret: String,
    credential_ttl_seconds: i64,
    allowed_project_ids: HashSet<Uuid>,
    allow_all_projects: bool,
}

impl fmt::Debug for BrowserTurnRestConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrowserTurnRestConfig")
            .field("urls", &self.urls)
            .field("shared_secret", &"<redacted>")
            .field("credential_ttl_seconds", &self.credential_ttl_seconds)
            .field("allowed_project_count", &self.allowed_project_ids.len())
            .field("allow_all_projects", &self.allow_all_projects)
            .finish()
    }
}

impl BrowserTurnRestConfig {
    pub(crate) fn from_env() -> anyhow::Result<Option<Self>> {
        Self::from_values(
            read_optional_env(TURN_URLS_ENV)?,
            read_optional_env(TURN_SHARED_SECRET_ENV)?,
            read_optional_env(TURN_TTL_ENV)?,
            read_optional_env(WEBRTC_PROJECT_IDS_ENV)?,
        )
    }

    fn from_values(
        urls_raw: Option<String>,
        shared_secret_raw: Option<String>,
        ttl_raw: Option<String>,
        allowed_projects_raw: Option<String>,
    ) -> anyhow::Result<Option<Self>> {
        if urls_raw.is_none() && shared_secret_raw.is_none() && ttl_raw.is_none() {
            return Ok(None);
        }

        let urls_raw = urls_raw.ok_or_else(|| {
            anyhow::anyhow!(
                "{TURN_URLS_ENV} must be set when controller TURN credentials are configured"
            )
        })?;
        let shared_secret = shared_secret_raw.ok_or_else(|| {
            anyhow::anyhow!(
                "{TURN_SHARED_SECRET_ENV} must be set when controller TURN credentials are configured"
            )
        })?;

        let urls = parse_turn_urls(&urls_raw)?;
        anyhow::ensure!(
            !shared_secret.is_empty(),
            "{TURN_SHARED_SECRET_ENV} must not be empty"
        );
        anyhow::ensure!(
            shared_secret.trim() == shared_secret,
            "{TURN_SHARED_SECRET_ENV} must not contain leading or trailing whitespace"
        );
        anyhow::ensure!(
            (MIN_TURN_SHARED_SECRET_BYTES..=MAX_TURN_SHARED_SECRET_BYTES)
                .contains(&shared_secret.len()),
            "{TURN_SHARED_SECRET_ENV} must be between {MIN_TURN_SHARED_SECRET_BYTES} and {MAX_TURN_SHARED_SECRET_BYTES} bytes"
        );

        let credential_ttl_seconds = match ttl_raw {
            Some(raw) => raw.trim().parse::<i64>().map_err(|_| {
                anyhow::anyhow!(
                    "{TURN_TTL_ENV} must be an integer between {MIN_TURN_CREDENTIAL_TTL_SECONDS} and {MAX_TURN_CREDENTIAL_TTL_SECONDS}"
                )
            })?,
            None => DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
        };
        anyhow::ensure!(
            (MIN_TURN_CREDENTIAL_TTL_SECONDS..=MAX_TURN_CREDENTIAL_TTL_SECONDS)
                .contains(&credential_ttl_seconds),
            "{TURN_TTL_ENV} must be between {MIN_TURN_CREDENTIAL_TTL_SECONDS} and {MAX_TURN_CREDENTIAL_TTL_SECONDS} seconds"
        );

        let (allowed_project_ids, allow_all_projects) =
            parse_allowed_projects(allowed_projects_raw.as_deref())?;

        Ok(Some(Self {
            urls,
            shared_secret,
            credential_ttl_seconds,
            allowed_project_ids,
            allow_all_projects,
        }))
    }

    /// Mint a coturn REST credential whose username binds its expiry to one
    /// project/runtime pair. coturn validates the base64 HMAC-SHA1 credential
    /// when configured with `use-auth-secret` and the matching static secret.
    pub(crate) fn mint_ice_servers_json(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        now_unix: i64,
    ) -> String {
        let expires_at = now_unix.saturating_add(self.credential_ttl_seconds);
        let username = format!("{expires_at}:{project_id}:{runtime_id}");
        let mut mac = Hmac::<Sha1>::new_from_slice(self.shared_secret.as_bytes())
            .expect("HMAC-SHA1 accepts keys of any size");
        mac.update(username.as_bytes());
        let credential = BASE64.encode(mac.finalize().into_bytes());

        json!([{
            "urls": self.urls,
            "username": username,
            "credential": credential,
        }])
        .to_string()
    }

    pub(crate) fn allows_project(&self, project_id: Uuid) -> bool {
        self.allow_all_projects || self.allowed_project_ids.contains(&project_id)
    }

    #[cfg(test)]
    pub(crate) fn for_test(urls: &str, shared_secret: &str, ttl_seconds: i64) -> Self {
        Self::from_values(
            Some(urls.to_string()),
            Some(shared_secret.to_string()),
            Some(ttl_seconds.to_string()),
            Some("*".to_string()),
        )
        .expect("valid TURN test configuration")
        .expect("configured TURN test configuration")
    }

    #[cfg(test)]
    pub(crate) fn for_test_projects(
        urls: &str,
        shared_secret: &str,
        ttl_seconds: i64,
        allowed_projects: &str,
    ) -> Self {
        Self::from_values(
            Some(urls.to_string()),
            Some(shared_secret.to_string()),
            Some(ttl_seconds.to_string()),
            Some(allowed_projects.to_string()),
        )
        .expect("valid TURN test configuration")
        .expect("configured TURN test configuration")
    }
}

fn parse_allowed_projects(raw: Option<&str>) -> anyhow::Result<(HashSet<Uuid>, bool)> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok((HashSet::new(), false));
    };
    if raw == "*" {
        return Ok((HashSet::new(), true));
    }

    let mut project_ids = HashSet::new();
    for value in raw.split(|character: char| character == ',' || character.is_whitespace()) {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        anyhow::ensure!(
            project_ids.len() < MAX_WEBRTC_PROJECT_IDS,
            "{WEBRTC_PROJECT_IDS_ENV} supports at most {MAX_WEBRTC_PROJECT_IDS} project ids"
        );
        let project_id = Uuid::parse_str(value).map_err(|_| {
            anyhow::anyhow!("{WEBRTC_PROJECT_IDS_ENV} contains an invalid project id")
        })?;
        project_ids.insert(project_id);
    }
    Ok((project_ids, false))
}

fn read_optional_env(name: &str) -> anyhow::Result<Option<String>> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(anyhow::anyhow!("{name} must contain valid UTF-8"))
        }
    }
}

fn parse_turn_urls(raw: &str) -> anyhow::Result<Vec<String>> {
    anyhow::ensure!(
        !raw.is_empty(),
        "{TURN_URLS_ENV} must contain at least one TURN URL"
    );
    anyhow::ensure!(
        raw.len() <= MAX_TURN_URLS_BYTES,
        "{TURN_URLS_ENV} is too large"
    );

    let mut urls = Vec::new();
    for (index, candidate) in raw.split(',').enumerate() {
        anyhow::ensure!(
            index < MAX_TURN_URLS,
            "{TURN_URLS_ENV} supports at most {MAX_TURN_URLS} URLs"
        );
        let url = candidate.trim();
        anyhow::ensure!(!url.is_empty(), "{TURN_URLS_ENV} contains an empty URL");
        anyhow::ensure!(
            url.len() <= MAX_TURN_URL_BYTES,
            "{TURN_URLS_ENV} contains a URL longer than {MAX_TURN_URL_BYTES} bytes"
        );
        anyhow::ensure!(
            !url.chars().any(char::is_whitespace),
            "{TURN_URLS_ENV} URLs must not contain whitespace"
        );
        anyhow::ensure!(
            !url.contains('@'),
            "{TURN_URLS_ENV} URLs must not embed credentials"
        );
        anyhow::ensure!(
            !url.contains('#'),
            "{TURN_URLS_ENV} URLs must not contain fragments"
        );

        let lower = url.to_ascii_lowercase();
        let remainder = lower
            .strip_prefix("turns:")
            .or_else(|| lower.strip_prefix("turn:"))
            .ok_or_else(|| anyhow::anyhow!("{TURN_URLS_ENV} only accepts turn: and turns: URLs"))?;
        anyhow::ensure!(
            !remainder.is_empty() && !remainder.starts_with("//") && !remainder.starts_with('?'),
            "{TURN_URLS_ENV} contains an invalid TURN URL"
        );

        if !urls.iter().any(|existing| existing == url) {
            urls.push(url.to_string());
        }
    }

    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn absent_turn_configuration_is_disabled() {
        assert!(BrowserTurnRestConfig::from_values(None, None, None, None)
            .expect("absent config")
            .is_none());
    }

    #[test]
    fn partial_turn_configuration_is_rejected_without_exposing_secret() {
        let missing_secret = BrowserTurnRestConfig::from_values(
            Some("turns:turn.example.test:5349".to_string()),
            None,
            None,
            None,
        )
        .expect_err("missing secret must fail");
        assert!(missing_secret.to_string().contains(TURN_SHARED_SECRET_ENV));

        let missing_urls = BrowserTurnRestConfig::from_values(
            None,
            Some(TEST_SECRET.to_string()),
            Some("600".to_string()),
            None,
        )
        .expect_err("missing URLs must fail");
        assert!(missing_urls.to_string().contains(TURN_URLS_ENV));
        assert!(!missing_urls.to_string().contains(TEST_SECRET));

        let ttl_only =
            BrowserTurnRestConfig::from_values(None, None, Some("600".to_string()), None)
                .expect_err("TTL-only config must fail");
        assert!(ttl_only.to_string().contains(TURN_URLS_ENV));
    }

    #[test]
    fn turn_configuration_validates_urls_secret_and_ttl_bounds() {
        for ttl in ["299", "86401", "not-a-number"] {
            let error = BrowserTurnRestConfig::from_values(
                Some("turn:turn.example.test:3478".to_string()),
                Some(TEST_SECRET.to_string()),
                Some(ttl.to_string()),
                None,
            )
            .expect_err("invalid TTL must fail");
            assert!(error.to_string().contains(TURN_TTL_ENV));
        }

        for url in [
            "https://turn.example.test",
            "turn:user@turn.example.test:3478",
            "turn://turn.example.test:3478",
            "turn:turn.example.test:3478#fragment",
        ] {
            let error = BrowserTurnRestConfig::from_values(
                Some(url.to_string()),
                Some(TEST_SECRET.to_string()),
                None,
                None,
            )
            .expect_err("invalid TURN URL must fail");
            assert!(error.to_string().contains(TURN_URLS_ENV));
        }

        let too_many_urls = BrowserTurnRestConfig::from_values(
            Some(
                [
                    "turn:a.example.test",
                    "turn:b.example.test",
                    "turn:c.example.test",
                    "turn:d.example.test",
                    "turn:e.example.test",
                ]
                .join(","),
            ),
            Some(TEST_SECRET.to_string()),
            None,
            None,
        )
        .expect_err("too many TURN URLs must fail");
        assert!(too_many_urls.to_string().contains(TURN_URLS_ENV));

        let short_secret = BrowserTurnRestConfig::from_values(
            Some("turn:turn.example.test:3478".to_string()),
            Some("too-short".to_string()),
            None,
            None,
        )
        .expect_err("short secret must fail");
        assert!(short_secret.to_string().contains(TURN_SHARED_SECRET_ENV));
        assert!(!short_secret.to_string().contains("too-short"));
    }

    #[test]
    fn valid_turn_configuration_deduplicates_urls_and_redacts_secret() {
        let config = BrowserTurnRestConfig::from_values(
            Some(
                "turn:turn.example.test:3478, turns:turn.example.test:5349,turn:turn.example.test:3478"
                    .to_string(),
            ),
            Some(TEST_SECRET.to_string()),
            None,
            Some("11111111-1111-4111-8111-111111111111".to_string()),
        )
        .expect("valid config")
        .expect("configured");

        assert_eq!(config.urls.len(), 2);
        assert_eq!(
            config.credential_ttl_seconds,
            DEFAULT_TURN_CREDENTIAL_TTL_SECONDS
        );
        let debug = format!("{config:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(TEST_SECRET));
        assert!(
            config.allows_project(Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap())
        );
        assert!(!config.allows_project(Uuid::new_v4()));
    }

    #[test]
    fn minted_credentials_bind_expiry_project_and_runtime() {
        let config = BrowserTurnRestConfig::for_test(
            "turn:turn.example.test:3478,turns:turn.example.test:5349",
            TEST_SECRET,
            600,
        );
        let project_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let runtime_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let raw = config.mint_ice_servers_json(project_id, runtime_id, 1_700_000_000);
        let ice: serde_json::Value = serde_json::from_str(&raw).expect("ICE JSON");

        assert_eq!(
            ice[0]["username"],
            "1700000600:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"
        );
        assert_eq!(ice[0]["credential"], "wE+0zQRpiMm161r1Adl4XdlE9Ec=");
        assert_eq!(
            ice[0]["urls"],
            json!([
                "turn:turn.example.test:3478",
                "turns:turn.example.test:5349"
            ])
        );
        assert!(!raw.contains(TEST_SECRET));

        let other_project = config.mint_ice_servers_json(Uuid::new_v4(), runtime_id, 1_700_000_000);
        let other_runtime = config.mint_ice_servers_json(project_id, Uuid::new_v4(), 1_700_000_000);
        let renewed = config.mint_ice_servers_json(project_id, runtime_id, 1_700_000_001);
        let credential = |value: &str| {
            serde_json::from_str::<serde_json::Value>(value)
                .expect("ICE JSON")
                .get(0)
                .and_then(|server| server.get("credential"))
                .and_then(serde_json::Value::as_str)
                .expect("TURN credential")
                .to_string()
        };
        assert_ne!(credential(&raw), credential(&other_project));
        assert_ne!(credential(&raw), credential(&other_runtime));
        assert_ne!(credential(&raw), credential(&renewed));
    }
}
