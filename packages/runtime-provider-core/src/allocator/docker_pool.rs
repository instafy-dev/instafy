use async_trait::async_trait;
use reqwest::Url;
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use super::{EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator};
use crate::config::ProviderConfig;

#[derive(Clone)]
pub struct DockerPoolRuntimeAllocator {
    client: reqwest::Client,
    hosts: Vec<Url>,
    auth_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteEnsureResponse {
    message: Option<String>,
}

impl DockerPoolRuntimeAllocator {
    pub(crate) fn new(config: &ProviderConfig) -> anyhow::Result<Self> {
        if config.docker_pool_hosts.is_empty() {
            return Err(anyhow::anyhow!(
                "DOCKER_POOL_HOSTS is required for docker_pool allocator"
            ));
        }

        let mut hosts = Vec::with_capacity(config.docker_pool_hosts.len());
        for raw in &config.docker_pool_hosts {
            let trimmed = raw.trim().trim_end_matches('/');
            if trimmed.is_empty() {
                continue;
            }
            let url = Url::parse(trimmed).map_err(|error| {
                anyhow::anyhow!("invalid DOCKER_POOL_HOSTS entry '{trimmed}': {error}")
            })?;
            hosts.push(url);
        }

        if hosts.is_empty() {
            return Err(anyhow::anyhow!(
                "DOCKER_POOL_HOSTS did not contain any valid host URLs"
            ));
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(Self {
            client,
            hosts,
            auth_token: config.docker_pool_auth_token.clone(),
        })
    }

    fn start_index(&self, runtime_id: Uuid) -> usize {
        (runtime_id.as_u128() % (self.hosts.len() as u128)) as usize
    }

    async fn call_remote_ensure(
        &self,
        base: &Url,
        request: &EnsureRuntimeRequest,
    ) -> anyhow::Result<Option<String>> {
        let url = base.join("/runtime/ensure")?;
        let mut req = self.client.post(url).json(request);
        if let Some(token) = self.auth_token.as_ref() {
            req = req.bearer_auth(token);
        }
        let res = req.send().await?;
        let res = res.error_for_status()?;
        let payload: RemoteEnsureResponse = res
            .json()
            .await
            .unwrap_or(RemoteEnsureResponse { message: None });
        Ok(payload.message)
    }

    async fn call_remote_release(
        &self,
        base: &Url,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        #[derive(serde::Serialize)]
        struct ReleasePayload {
            project_id: Uuid,
            runtime_id: Uuid,
            #[serde(skip_serializing_if = "Option::is_none")]
            lease_id: Option<Uuid>,
        }

        let url = base.join("/runtime/release")?;
        let mut req = self.client.post(url).json(&ReleasePayload {
            project_id,
            runtime_id,
            lease_id,
        });
        if let Some(token) = self.auth_token.as_ref() {
            req = req.bearer_auth(token);
        }
        req.send().await?.error_for_status()?;
        Ok(())
    }
}

#[async_trait]
impl RuntimeAllocator for DockerPoolRuntimeAllocator {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome> {
        let start = self.start_index(request.runtime_id);
        let mut last_error: Option<anyhow::Error> = None;

        for attempt in 0..self.hosts.len() {
            let index = (start + attempt) % self.hosts.len();
            let host = &self.hosts[index];
            match self.call_remote_ensure(host, &request).await {
                Ok(message) => {
                    let host_label = host.as_str().trim_end_matches('/').to_string();
                    let combined = match message {
                        Some(msg) if !msg.trim().is_empty() => {
                            Some(format!("docker_pool host={host_label} {msg}"))
                        }
                        _ => Some(format!("docker_pool host={host_label}")),
                    };
                    return Ok(EnsureRuntimeOutcome {
                        launched: true,
                        message: combined,
                    });
                }
                Err(error) => {
                    warn!(
                        project_id = %request.project_id,
                        runtime_id = %request.runtime_id,
                        lease_id = %request.lease_id,
                        host = %host,
                        %error,
                        "docker_pool ensure failed; trying next host"
                    );
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("docker_pool ensure failed")))
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
        let start = self.start_index(runtime_id);
        let mut errors = Vec::new();

        for attempt in 0..self.hosts.len() {
            let index = (start + attempt) % self.hosts.len();
            let host = &self.hosts[index];
            match self
                .call_remote_release(host, project_id, runtime_id, lease_id)
                .await
            {
                Ok(()) => {}
                Err(error) => {
                    warn!(
                        %project_id,
                        %runtime_id,
                        host = %host,
                        %error,
                        "docker_pool release failed on one host"
                    );
                    errors.push(format!("{host}: {error}"));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            anyhow::bail!(
                "docker_pool release was not acknowledged by every host: {}",
                errors.join("; ")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProviderConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    struct StubServer {
        base: Url,
        shutdown: Option<oneshot::Sender<()>>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl StubServer {
        async fn start(status_line: &'static str, body: &'static str) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            let base = Url::parse(&format!("http://{}:{}", addr.ip(), addr.port())).unwrap();
            let (shutdown, mut shutdown_rx) = oneshot::channel();
            let handle = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => break,
                        accept = listener.accept() => {
                            let Ok((mut socket, _)) = accept else { continue };
                            tokio::spawn(async move {
                                let mut buf = vec![0u8; 2048];
                                let _ = socket.read(&mut buf).await;
                                let body_bytes = body.as_bytes();
                                let response = format!(
                                    "HTTP/1.1 {status_line}\r\nContent-Length: {len}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                                    status_line = status_line,
                                    len = body_bytes.len(),
                                    body = body
                                );
                                let _ = socket.write_all(response.as_bytes()).await;
                                let _ = socket.shutdown().await;
                            });
                        }
                    }
                }
            });
            Self {
                base,
                shutdown: Some(shutdown),
                handle,
            }
        }

        async fn stop(mut self) {
            if let Some(tx) = self.shutdown.take() {
                let _ = tx.send(());
            }
            let _ = self.handle.await;
        }
    }

    #[tokio::test]
    async fn docker_pool_falls_back_to_next_host() {
        let failing = StubServer::start("500 Internal Server Error", "{\"error\":\"no\"}").await;
        let ok = StubServer::start("200 OK", "{\"message\":\"ok\"}").await;

        let mut config = ProviderConfig::default_docker();
        config.runtime_allocator_required = true;
        config.docker_pool_hosts = vec![failing.base.to_string(), ok.base.to_string()];

        let allocator = DockerPoolRuntimeAllocator::new(&config).unwrap();
        let runtime_id = Uuid::from_u128(0);
        let outcome = allocator
            .ensure_runtime(EnsureRuntimeRequest {
                project_id: Uuid::from_u128(1),
                runtime_id,
                lease_id: Uuid::from_u128(2),
                provider: "docker_pool".to_string(),
                runtime_token: "token".to_string(),
                metadata: None,
                origin_instance_id: Some(Uuid::from_u128(3)),
                origin_mode: None,
                origin_protocols: vec!["http".to_string()],
                origin_metadata: None,
            })
            .await
            .unwrap();

        assert!(outcome.launched);
        assert!(outcome
            .message
            .unwrap_or_default()
            .contains(ok.base.as_str().trim_end_matches('/')));

        failing.stop().await;
        ok.stop().await;
    }

    #[tokio::test]
    async fn docker_pool_release_requires_every_host_to_acknowledge() {
        let failing = StubServer::start("500 Internal Server Error", "{\"error\":\"no\"}").await;
        let ok = StubServer::start("204 No Content", "").await;

        let mut config = ProviderConfig::default_docker();
        config.runtime_allocator_required = true;
        config.docker_pool_hosts = vec![failing.base.to_string(), ok.base.to_string()];

        let allocator = DockerPoolRuntimeAllocator::new(&config).unwrap();
        let error = allocator
            .stop_runtime(Uuid::from_u128(1), Uuid::from_u128(0))
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("was not acknowledged by every host"));

        failing.stop().await;
        ok.stop().await;
    }
}
