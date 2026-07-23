use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::config::Config;
use crate::controller::{ControllerClient, LeaseJob, Registration};
use crate::job_cancel::JobCancelSignal;
use crate::jobs::{JobExecution, JobMessage, JobProcessor, JobProgress};

/// Shared agent execution helper that can be reused by hosted and self-hosted runtimes.
/// It owns a JobProcessor and wraps the progress/streaming plumbing.
#[derive(Clone)]
pub struct AgentExecutor {
    processor: Arc<JobProcessor>,
}

impl AgentExecutor {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            processor: Arc::new(JobProcessor::new(config)),
        }
    }

    pub fn processor(&self) -> Arc<JobProcessor> {
        self.processor.clone()
    }

    pub async fn run_apply_with_progress(
        &self,
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        lease_lost_signal: Option<JobCancelSignal>,
    ) -> Result<JobExecution> {
        let (progress_tx, progress_status, progress_task) =
            spawn_progress_dispatch(client, registration, job.id, lease_lost_signal.clone());
        let progress_handle = JobProgress {
            sender: progress_tx.clone(),
            status: progress_status,
        };

        let result = self
            .processor
            .run_apply_job(
                registration,
                job,
                true,
                Some(progress_handle),
                lease_lost_signal.clone(),
            )
            .await;

        finish_progress_dispatch(progress_tx, progress_task, job.id).await;
        result
    }

    pub async fn run_parallel_direct_write_scoped_with_progress(
        &self,
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        lease_lost_signal: Option<JobCancelSignal>,
    ) -> Result<JobExecution> {
        let (progress_tx, progress_status, progress_task) =
            spawn_progress_dispatch(client, registration, job.id, lease_lost_signal.clone());
        let progress_handle = JobProgress {
            sender: progress_tx.clone(),
            status: progress_status,
        };

        let result = self
            .processor
            .run_parallel_direct_write_scoped_worker_job(
                registration,
                job,
                Some(progress_handle),
                lease_lost_signal.clone(),
            )
            .await;

        finish_progress_dispatch(progress_tx, progress_task, job.id).await;
        result
    }
}

fn spawn_progress_dispatch(
    client: Arc<ControllerClient>,
    registration: &Registration,
    job_id: uuid::Uuid,
    lease_lost_signal: Option<JobCancelSignal>,
) -> (UnboundedSender<JobMessage>, Arc<AtomicBool>, JoinHandle<()>) {
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<JobMessage>();
    let progress_registration = registration.clone();
    let progress_status = Arc::new(AtomicBool::new(true));
    let status_flag = progress_status.clone();
    let progress_lease_lost_signal = lease_lost_signal.clone();

    let progress_task = tokio::spawn(async move {
        while let Some(message) = progress_rx.recv().await {
            if let Err(error) = client
                .append_job_message(
                    &progress_registration,
                    job_id,
                    &message.content,
                    message.message_type.as_deref(),
                    message.metadata.as_ref(),
                )
                .await
            {
                warn!(
                    ?error,
                    job_id = %job_id,
                    "failed to report streaming agent message"
                );
                status_flag.store(false, Ordering::SeqCst);

                // If the controller rejected the message because the job lease is gone (for example:
                // the user clicked "stop" which cancels the job), notify the runtime job loop so it
                // can tear down promptly instead of continuing to run indefinitely.
                let message = error.to_string();
                let lease_lost = message.contains("status=409")
                    || message.contains("status=404")
                    || message.to_ascii_lowercase().contains("lease lost");
                if lease_lost {
                    if let Some(signal) = progress_lease_lost_signal.as_ref() {
                        signal.cancel();
                    }
                    break;
                }
            }
        }
    });

    (progress_tx, progress_status, progress_task)
}

async fn finish_progress_dispatch(
    progress_tx: UnboundedSender<JobMessage>,
    progress_task: JoinHandle<()>,
    job_id: uuid::Uuid,
) {
    drop(progress_tx);

    if let Err(join_error) = progress_task.await
        && !join_error.is_cancelled()
    {
        warn!(
            ?join_error,
            job_id = %job_id,
            "progress dispatch task ended unexpectedly"
        );
    }
}
