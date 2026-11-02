//! Coalesced, best-effort delivery of ephemeral replies. Never blocks job progress.
use crate::controller::{ControllerClient, Registration};
use crate::job_cancel::JobCancelSignal;
use crate::jobs::{ReplyDraft, ReplyDraftSender};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub(super) struct DraftTask(JoinHandle<()>);
impl Drop for DraftTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn spawn(
    client: Arc<ControllerClient>,
    registration: &Registration,
    job_id: uuid::Uuid,
    lease_attempt: i32,
    cancellation: Option<JobCancelSignal>,
) -> (ReplyDraftSender, DraftTask) {
    let (sender, mut receiver) = watch::channel(ReplyDraft::default());
    let registration = registration.clone();
    let cancellation = cancellation.unwrap_or_default();
    let task = tokio::spawn(async move {
        let mut sent = ReplyDraft::default();
        let mut seq = 0u64;
        loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break,
                result = receiver.changed() => if result.is_err() { break; },
            }
            loop {
                let draft = receiver.borrow_and_update().clone();
                if draft == sent || (draft.text.is_empty() && sent.text.is_empty()) {
                    break;
                }
                seq += 1;
                let result = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return,
                    result = client.post_reply_draft(&registration, job_id, lease_attempt, seq, &draft) => result,
                };
                match result {
                    Ok(false) => return, // Old controller, revoked scope or lost job lease.
                    Ok(true) => {
                        sent = draft;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        break;
                    }
                    Err(_) => {
                        // A transport failure affects only this preview. Re-send the
                        // newest snapshot after backoff, never a queued token backlog.
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => return,
                            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                        }
                    }
                }
            }
        }
    });
    (sender, DraftTask(task))
}
