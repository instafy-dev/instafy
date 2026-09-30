use std::env;
use std::time::Duration;

use anyhow::{Result, anyhow};
use axum::http::HeaderMap;

use crate::controller_client::ControllerClient;
use crate::controller_credential_source::ControllerCredentialSource;
use crate::credential_lease::{CredentialLease, CredentialLeasePurpose, LeasedCredentials};
use crate::proxy_auth::{ProxyClaims, ProxyTokenValidator};

#[derive(Clone)]
pub struct ControllerIntegration {
    client: ControllerClient,
    validator: ProxyTokenValidator,
    credential_source: ControllerCredentialSource,
}

impl ControllerIntegration {
    pub fn from_env() -> Result<Option<Self>> {
        let Some(base_url) =
            read_env("PROXY_CONTROLLER_BASE_URL").or_else(|| read_env("CONTROLLER_BASE_URL"))
        else {
            return Ok(None);
        };
        // The proxy no longer sends this token to the controller, but it stays
        // required: ProxyTokenValidator derives the signing secret from it when
        // PROXY_SIGNING_SECRET is unset.
        read_env("CONTROLLER_INTERNAL_TOKEN")
            .ok_or_else(|| anyhow!("controller integration requires CONTROLLER_INTERNAL_TOKEN"))?;
        let credential_lease_bearer =
            read_env("PROXY_CREDENTIAL_LEASE_TOKEN").ok_or_else(|| {
                anyhow!("controller integration requires PROXY_CREDENTIAL_LEASE_TOKEN")
            })?;

        let validator = ProxyTokenValidator::from_env(true).ok_or_else(|| {
            anyhow!("controller integration requires proxy token validation configuration")
        })?;
        let client = ControllerClient::new(base_url, credential_lease_bearer);

        let credential_cache_ttl = Duration::from_secs(
            read_env("PROXY_CREDENTIAL_CACHE_SECONDS")
                .and_then(|raw| raw.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(60),
        );
        let credential_source =
            ControllerCredentialSource::new(client.clone(), credential_cache_ttl);

        Ok(Some(Self {
            client,
            validator,
            credential_source,
        }))
    }

    pub async fn verify_credential_lease_protocol(&self) -> Result<()> {
        self.client.verify_credential_lease_protocol().await
    }

    pub fn authenticate(&self, headers: &HeaderMap) -> Result<ProxyClaims> {
        self.validator.authenticate(headers)
    }

    pub async fn acquire_credential_lease(
        &self,
        credential_id: &str,
    ) -> Result<CredentialLease<LeasedCredentials>> {
        self.credential_source
            .acquire_lease(credential_id, CredentialLeasePurpose::InitialRequest)
            .await
    }

    pub async fn renew_credential_lease_after_rejection(
        &self,
        credential_id: &str,
    ) -> Result<CredentialLease<LeasedCredentials>> {
        self.credential_source
            .acquire_lease(
                credential_id,
                CredentialLeasePurpose::AfterUpstreamRejection,
            )
            .await
    }

    /// Forward a BYOC subscription-usage snapshot to the controller. Used
    /// fire-and-forget by the proxy; never gates the user's response.
    pub async fn post_credential_usage(
        &self,
        credential_id: &str,
        snapshot: &serde_json::Value,
    ) -> Result<()> {
        self.client
            .post_credential_usage(credential_id, snapshot)
            .await
    }
}

fn read_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
