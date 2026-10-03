use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::active_turn_input::ActiveTurnInputReceiver;
use crate::config::Config;
use crate::controller::{ControllerClient, LeaseJob, Registration};
use crate::job_cancel::JobCancelSignal;
use crate::jobs::{JobExecution, JobMessage, JobProcessor, JobProgress};
use crate::origin::LocalOriginSync;

/// How long a turn that lost its lease (a cancel, or a stop that requeued
/// it) still counts as interrupted. The controller's pre-stop flush uses the
/// same window for a job cancelled before a stop.
const INTERRUPTED_TURN_WINDOW: Duration = Duration::from_secs(60);

/// The turns this process runs, as a stop sees them: a turn still running,
/// or one that lost its lease within [`INTERRUPTED_TURN_WINDOW`], is
/// unfinished. Each job counts on its own, so concurrent workers never reset
/// each other, and a job that ends any other way (done or failed) clears
/// only its own entry.
#[derive(Debug, Default)]
struct TurnTracker {
    running: HashSet<uuid::Uuid>,
    /// Jobs that ended by losing their lease, and when.
    interrupted: HashMap<uuid::Uuid, Instant>,
}

impl TurnTracker {
    fn started(&mut self, job_id: uuid::Uuid) {
        self.running.insert(job_id);
        self.interrupted.remove(&job_id);
    }

    fn ended(&mut self, job_id: uuid::Uuid, lease_lost: bool, now: Instant) {
        self.running.remove(&job_id);
        if lease_lost {
            self.interrupted.insert(job_id, now);
        } else {
            self.interrupted.remove(&job_id);
        }
        self.interrupted
            .retain(|_, at| now.saturating_duration_since(*at) < INTERRUPTED_TURN_WINDOW);
    }

    fn interrupted(&self, now: Instant) -> bool {
        !self.running.is_empty()
            || self
                .interrupted
                .values()
                .any(|at| now.saturating_duration_since(*at) < INTERRUPTED_TURN_WINDOW)
    }
}

/// One job's turn, from lease to end. [`TurnGuard::end`] records how it
/// ended; a guard dropped without it (the job's task was cancelled, or it
/// left by an unexpected path) counts as interrupted.
pub struct TurnGuard {
    tracker: Arc<Mutex<TurnTracker>>,
    job_id: uuid::Uuid,
    ended: bool,
}

impl TurnGuard {
    /// The job finished (`lease_lost == false`: done or failed normally) or
    /// lost its lease before its turn finished.
    pub fn end(mut self, lease_lost: bool) {
        self.record(lease_lost);
    }

    fn record(&mut self, lease_lost: bool) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.tracker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ended(self.job_id, lease_lost, Instant::now());
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.record(true);
    }
}

/// Shared agent execution helper that can be reused by hosted and self-hosted runtimes.
/// It owns a JobProcessor and wraps the progress/streaming plumbing.
#[derive(Clone)]
pub struct AgentExecutor {
    processor: Arc<JobProcessor>,
    turns: Arc<Mutex<TurnTracker>>,
}

impl AgentExecutor {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            processor: Arc::new(JobProcessor::new(config)),
            turns: Arc::new(Mutex::new(TurnTracker::default())),
        }
    }

    /// Start tracking `job_id`'s turn until the returned guard ends.
    pub fn begin_turn(&self, job_id: uuid::Uuid) -> TurnGuard {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .started(job_id);
        TurnGuard {
            tracker: self.turns.clone(),
            job_id,
            ended: false,
        }
    }

    /// Whether a stop now interrupts a turn: one is still running, or one
    /// lost its lease within the last minute. A shutdown flush then sets the
    /// turns' local commits aside instead of leaving them for the next
    /// publish.
    pub fn turn_interrupted(&self) -> bool {
        self.turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .interrupted(Instant::now())
    }

    pub fn processor(&self) -> Arc<JobProcessor> {
        self.processor.clone()
    }

    /// Publish (or clear, with None) the locally hosted origin's identity and
    /// loopback endpoint so workspace sync can bypass the tunnel data path
    /// when a job's origin is served by this very process (#153).
    pub fn set_local_origin_sync(&self, value: Option<LocalOriginSync>) {
        self.processor.set_local_origin_sync(value);
    }

    pub async fn run_apply_with_progress(
        &self,
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        lease_lost_signal: Option<JobCancelSignal>,
        active_turn_input: Option<ActiveTurnInputReceiver>,
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
                active_turn_input,
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

#[cfg(test)]
mod turn_tests {
    use super::{INTERRUPTED_TURN_WINDOW, TurnGuard, TurnTracker};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    #[test]
    fn a_running_turn_or_one_that_lost_its_lease_within_the_window_is_interrupted() {
        let start = Instant::now();
        let mut turns = TurnTracker::default();
        assert!(!turns.interrupted(start));

        let job = Uuid::new_v4();
        turns.started(job);
        assert!(turns.interrupted(start), "a running turn is unfinished");

        turns.ended(job, true, start);
        assert!(turns.interrupted(start + Duration::from_secs(59)));
        assert!(
            !turns.interrupted(start + INTERRUPTED_TURN_WINDOW),
            "a cancel long before the stop does not count"
        );
    }

    #[test]
    fn a_job_that_ends_normally_clears_only_itself() {
        let now = Instant::now();
        let mut turns = TurnTracker::default();
        let cancelled = Uuid::new_v4();
        let finished = Uuid::new_v4();
        let failed = Uuid::new_v4();
        for job in [cancelled, finished, failed] {
            turns.started(job);
        }
        turns.ended(cancelled, true, now);
        turns.ended(finished, false, now);
        turns.ended(failed, false, now);
        assert!(
            turns.interrupted(now),
            "a concurrent worker finishing never hides another's cancel"
        );

        // The cancelled job runs again and finishes: nothing is unfinished.
        turns.started(cancelled);
        turns.ended(cancelled, false, now);
        assert!(!turns.interrupted(now));
    }

    #[test]
    fn a_turn_dropped_without_an_end_counts_as_interrupted() {
        let tracker = Arc::new(Mutex::new(TurnTracker::default()));
        let job = Uuid::new_v4();
        tracker.lock().unwrap().started(job);
        drop(TurnGuard {
            tracker: tracker.clone(),
            job_id: job,
            ended: false,
        });
        assert!(tracker.lock().unwrap().interrupted(Instant::now()));

        let finished = Uuid::new_v4();
        let other = Arc::new(Mutex::new(TurnTracker::default()));
        other.lock().unwrap().started(finished);
        TurnGuard {
            tracker: other.clone(),
            job_id: finished,
            ended: false,
        }
        .end(false);
        assert!(!other.lock().unwrap().interrupted(Instant::now()));
    }
}
