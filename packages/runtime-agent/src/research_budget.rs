//! A research-only controller capability, kept separate from granted project secrets.

use std::collections::HashMap;

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub(crate) const ENV_KEYS: [&str; 3] = [
    "INSTAFY_RESEARCH_SHARED",
    "INSTAFY_RESEARCH_CONTROLLER_URL",
    "INSTAFY_RESEARCH_ACCESS_TOKEN",
];

/// Only the trusted parent constructs this capability from `/agent/secrets`.
/// The token authorizes research accounting, never general controller operations.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchBudgetAccess {
    shared: bool,
    controller_url: Option<String>,
    access_token: Option<String>,
}

impl std::fmt::Debug for ResearchBudgetAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResearchBudgetAccess")
            .field("shared", &self.shared)
            .field("has_access_token", &self.access_token.is_some())
            .finish_non_exhaustive()
    }
}

impl ResearchBudgetAccess {
    pub(crate) fn from_controller(
        shared: bool,
        controller_url: &str,
        access_token: Option<String>,
    ) -> Self {
        if !shared {
            return Self::default();
        }
        Self {
            shared,
            controller_url: Some(controller_url.to_string()),
            access_token: access_token.filter(|token| !token.trim().is_empty()),
        }
    }

    /// A failed settings fetch cannot establish that the legacy local allowance applies.
    pub(crate) fn unavailable() -> Self {
        Self {
            shared: true,
            ..Self::default()
        }
    }

    pub(crate) fn scrub(environment: &mut HashMap<String, String>) {
        environment.retain(|key, _| !ENV_KEYS.iter().any(|name| key.eq_ignore_ascii_case(name)));
    }

    pub(crate) fn apply(&self, environment: &mut HashMap<String, String>) {
        Self::scrub(environment);
        if self.shared {
            environment.insert(ENV_KEYS[0].into(), "1".into());
            if let Some(url) = &self.controller_url {
                environment.insert(ENV_KEYS[1].into(), url.clone());
            }
            if let Some(token) = &self.access_token {
                environment.insert(ENV_KEYS[2].into(), token.clone());
            }
        }
    }

    pub(crate) fn redact(&self, message: &str) -> String {
        match self
            .access_token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            Some(token) => message.replace(token, "[redacted]"),
            None => message.to_string(),
        }
    }

    pub(crate) fn validate(&self, controller_url: &str) -> Result<()> {
        if let Some(token) = &self.access_token {
            ensure!(
                self.shared && token.len() <= 128 * 1024 && !token.contains('\0'),
                "invalid research accounting credential"
            );
        }
        if let Some(url) = &self.controller_url {
            let endpoint = reqwest::Url::parse(url)?;
            let controller = reqwest::Url::parse(controller_url)?;
            ensure!(
                self.shared
                    && matches!(endpoint.scheme(), "http" | "https")
                    && endpoint.username().is_empty()
                    && endpoint.password().is_none()
                    && endpoint.origin() == controller.origin(),
                "research accounting must use the job's controller"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_controller_capabilities_set_shared_mode_and_missing_tokens_fail_closed() {
        let mut environment = HashMap::from([
            (ENV_KEYS[0].into(), "0".into()),
            (
                ENV_KEYS[1].to_ascii_lowercase(),
                "https://untrusted.invalid".into(),
            ),
            (ENV_KEYS[2].into(), "granted-secret".into()),
        ]);
        ResearchBudgetAccess::default().apply(&mut environment);
        assert!(environment.is_empty());
        let access = ResearchBudgetAccess::from_controller(
            true,
            "http://127.0.0.1:8787/",
            Some("research-only-token".into()),
        );
        access.apply(&mut environment);
        assert_eq!(environment[ENV_KEYS[0]], "1");
        assert_eq!(environment[ENV_KEYS[1]], "http://127.0.0.1:8787/");
        assert_eq!(environment[ENV_KEYS[2]], "research-only-token");
        assert!(!format!("{access:?}").contains("research-only-token"));
        ResearchBudgetAccess::from_controller(true, "http://127.0.0.1:8787/", None)
            .apply(&mut environment);
        assert_eq!(environment[ENV_KEYS[0]], "1");
        assert!(!environment.contains_key(ENV_KEYS[2]));
        ResearchBudgetAccess::unavailable().apply(&mut environment);
        assert_eq!(
            environment,
            HashMap::from([(ENV_KEYS[0].into(), "1".into())])
        );
        assert!(access.validate("http://127.0.0.1:8787/").is_ok());
        assert!(access.validate("http://127.0.0.1:8788/").is_err());
        assert!(
            ResearchBudgetAccess::from_controller(
                true,
                "http://127.0.0.1:8787/",
                Some("invalid\0token".into()),
            )
            .validate("http://127.0.0.1:8787/")
            .is_err()
        );
    }
}
