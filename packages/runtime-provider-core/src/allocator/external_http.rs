use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::info;
use uuid::Uuid;

use super::{EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator};
use crate::config::RuntimeProviderConfig;

#[derive(Clone)]
pub struct ExternalHttpRuntimeAllocator {
    client: Client,
    endpoint: String,
    token: Option<String>,
}

#[derive(Serialize)]
struct ExternalEnsureRequest<'a> {
    project_id: &'a Uuid,
    runtime_id: &'a Uuid,
    lease_id: &'a Uuid,
    provider: &'a str,
    runtime_token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_instance_id: Option<&'a Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_mode: Option<&'a String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    origin_protocols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_metadata: Option<&'a serde_json::Value>,
}

#[derive(Serialize)]
struct ExternalReleaseRequest<'a> {
    project_id: &'a Uuid,
    runtime_id: &'a Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_id: Option<&'a Uuid>,
}

#[derive(Deserialize)]
struct ExternalEnsureResponse {
    message: Option<String>,
}

impl ExternalHttpRuntimeAllocator {
    pub(crate) fn new(provider: &RuntimeProviderConfig) -> anyhow::Result<Self> {
        let endpoint = provider
            .endpoint
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("external provider missing endpoint"))?
            .trim()
            .trim_end_matches('/')
            .to_string();
        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(30)).build()?,
            endpoint,
            token: provider.auth_token.clone(),
        })
    }

    fn auth_header(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.token {
            req.bearer_auth(token)
        } else {
            req
        }
    }
}

#[async_trait]
impl RuntimeAllocator for ExternalHttpRuntimeAllocator {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome> {
        let body = ExternalEnsureRequest {
            project_id: &request.project_id,
            runtime_id: &request.runtime_id,
            lease_id: &request.lease_id,
            provider: &request.provider,
            runtime_token: &request.runtime_token,
            metadata: request.metadata.as_ref(),
            origin_instance_id: request.origin_instance_id.as_ref(),
            origin_mode: request.origin_mode.as_ref(),
            origin_protocols: request.origin_protocols.clone(),
            origin_metadata: request.origin_metadata.as_ref(),
        };
        let url = format!("{}/runtime/ensure", self.endpoint);
        let res = self
            .auth_header(self.client.post(url))
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!("external provider ensure failed: status={status} body={text}");
        }
        let payload: ExternalEnsureResponse = res
            .json()
            .await
            .unwrap_or(ExternalEnsureResponse { message: None });
        info!(
            runtime_id = %request.runtime_id,
            provider = %request.provider,
            message = ?payload.message,
            "external runtime allocator ensure completed"
        );
        Ok(EnsureRuntimeOutcome {
            launched: true,
            message: payload.message,
        })
    }

    async fn stop_runtime(&self, project_id: Uuid, runtime_id: Uuid) -> anyhow::Result<()> {
        self.stop_runtime_if_lease(project_id, runtime_id, None)
            .await
    }

    async fn stop_runtime_if_lease(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let body = ExternalReleaseRequest {
            project_id: &project_id,
            runtime_id: &runtime_id,
            lease_id: lease_id.as_ref(),
        };
        let url = format!("{}/runtime/release", self.endpoint);
        let res = self
            .auth_header(self.client.post(url))
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!("external provider release failed: status={status} body={text}");
        }
        Ok(())
    }
}
