use std::env;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use axum::http::HeaderMap;
use runtime_contracts::{CreditEventRequest, CreditSnapshotPayload};
use uuid::Uuid;

use crate::auth::Credentials;
use crate::controller_client::ControllerClient;
use crate::controller_credential_source::ControllerCredentialSource;
use crate::credential_lease::{CredentialLease, CredentialLeasePurpose};
use crate::proxy_auth::{ProxyClaims, ProxyTokenValidator};

#[derive(Clone)]
pub struct ControllerIntegration {
    client: ControllerClient,
    validator: ProxyTokenValidator,
    burn_amount: i32,
    credential_source: ControllerCredentialSource,
}

#[derive(Clone)]
pub struct CreditBurn {
    client: ControllerClient,
    project_id: String,
    runtime_id: Option<String>,
    run_id: Option<String>,
    amount: i32,
    provider: String,
    burn_request_id: String,
    snapshot: Option<CreditSnapshotPayload>,
}

impl ControllerIntegration {
    pub fn from_env() -> Result<Option<Self>> {
        let Some(base_url) =
            read_env("PROXY_CONTROLLER_BASE_URL").or_else(|| read_env("CONTROLLER_BASE_URL"))
        else {
            return Ok(None);
        };
        let service_bearer = read_env("CONTROLLER_INTERNAL_TOKEN")
            .ok_or_else(|| anyhow!("controller integration requires CONTROLLER_INTERNAL_TOKEN"))?;
        let credential_lease_bearer =
            read_env("PROXY_CREDENTIAL_LEASE_TOKEN").ok_or_else(|| {
                anyhow!("controller integration requires PROXY_CREDENTIAL_LEASE_TOKEN")
            })?;
        let burn_amount = read_env("PROXY_CREDIT_BURN_AMOUNT")
            .and_then(|raw| raw.parse::<i32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(0);

        let validator = ProxyTokenValidator::from_env(true).ok_or_else(|| {
            anyhow!("controller integration requires proxy token validation configuration")
        })?;
        let client =
            ControllerClient::new(base_url, service_bearer, credential_lease_bearer);

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
            burn_amount,
            credential_source,
        }))
    }

    pub fn should_burn_credits(&self) -> bool {
        self.burn_amount > 0
    }

    pub async fn verify_credential_lease_protocol(&self) -> Result<()> {
        self.client.verify_credential_lease_protocol().await
    }

    pub fn authenticate(&self, headers: &HeaderMap) -> Result<ProxyClaims> {
        self.validator.authenticate(headers)
    }

    pub async fn burn(&self, claims: &ProxyClaims, model: &str) -> Result<CreditBurn> {
        let mut request = CreditEventRequest::default();
        let burn_request_id = Uuid::new_v4().to_string();
        request.request_id = burn_request_id.clone();
        request.action = "burn".to_string();
        request.project_id = claims.project_id.clone();
        if let Some(runtime_id) = claims.runtime_id.as_ref() {
            request.runtime_id = runtime_id.clone();
        }
        if let Some(run_id) = claims.run_id.as_ref() {
            request.run_id = run_id.clone();
        }
        request.provider = model.to_string();
        request.amount = self.burn_amount;
        request.reason = "proxy burn".to_string();

        let response = self
            .client
            .send_credit_event(request)
            .await
            .context("controller burn request failed")?;

        let snapshot = response
            .snapshot
            .as_ref()
            .map(CreditSnapshotPayload::from_proto);

        Ok(CreditBurn {
            client: self.client.clone(),
            project_id: claims.project_id.clone(),
            runtime_id: claims.runtime_id.clone(),
            run_id: claims.run_id.clone(),
            amount: self.burn_amount,
            provider: model.to_string(),
            burn_request_id,
            snapshot,
        })
    }

    pub async fn acquire_credential_lease(
        &self,
        credential_id: &str,
    ) -> Result<CredentialLease<Credentials>> {
        self.credential_source
            .acquire_lease(credential_id, CredentialLeasePurpose::InitialRequest)
            .await
    }

    pub async fn renew_credential_lease_after_rejection(
        &self,
        credential_id: &str,
    ) -> Result<CredentialLease<Credentials>> {
        self.credential_source
            .acquire_lease(
                credential_id,
                CredentialLeasePurpose::AfterUpstreamRejection,
            )
            .await
    }
}

impl CreditBurn {
    pub fn snapshot(&self) -> Option<CreditSnapshotPayload> {
        self.snapshot.clone()
    }

    pub async fn refund(self, reason: &str) -> Result<()> {
        let CreditBurn {
            client,
            project_id,
            runtime_id,
            run_id,
            amount,
            provider,
            burn_request_id,
            snapshot: _,
        } = self;

        let mut request = CreditEventRequest::default();
        request.request_id = Uuid::new_v4().to_string();
        request.action = "refill".to_string();
        request.project_id = project_id;
        if let Some(runtime_id) = runtime_id {
            request.runtime_id = runtime_id;
        }
        if let Some(run_id) = run_id {
            request.run_id = run_id;
        }
        request.amount = amount;
        request.provider = provider;

        let reason_text = reason.trim();
        if reason_text.is_empty() {
            request.reason = format!("proxy refund ({})", burn_request_id);
        } else {
            request.reason = format!("{} ({})", reason_text, burn_request_id);
        }

        let _ = client
            .send_credit_event(request)
            .await
            .map_err(|error| anyhow!("controller refund failed: {error}"));

        Ok(())
    }
}

fn read_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
