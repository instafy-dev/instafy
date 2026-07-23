use super::{EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator};
use async_trait::async_trait;
use tracing::info;

pub struct NoopRuntimeAllocator;

#[async_trait]
impl RuntimeAllocator for NoopRuntimeAllocator {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome> {
        info!(
            project_id = %request.project_id,
            runtime_id = %request.runtime_id,
            lease_id = %request.lease_id,
            provider = request.provider,
            origin_instance_id = ?request.origin_instance_id,
            "noop runtime allocator invoked"
        );
        Ok(EnsureRuntimeOutcome {
            launched: false,
            message: Some("noop allocator".to_string()),
        })
    }
}
