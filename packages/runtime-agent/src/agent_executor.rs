use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::active_turn_input::ActiveTurnInputReceiver;
use crate::config::Config;
use crate::controller::{ControllerClient, LeaseJob, Registration};
use crate::job_cancel::JobCancelSignal;
use crate::jobs::rolling_saves;
use crate::jobs::{
    JobExecution, JobMessage, JobProcessor, JobProgress, ReplyDraft, ReplyDraftSender,
};
use crate::origin::LocalOriginSync;

/// How long a turn that lost its lease (a cancel, or a stop that requeued
/// it) still counts as interrupted once this runtime has started other work
/// since. The controller's pre-stop flush uses the same window for a job
/// cancelled before a stop.
const INTERRUPTED_TURN_WINDOW: Duration = Duration::from_secs(60);

/// The shortest gap between two sends of a job's reply draft. Each send carries the latest
/// text, so a slow controller gets fewer, longer drafts rather than a backlog.
const REPLY_DRAFT_INTERVAL: Duration = Duration::from_millis(200);

/// The turns this process runs, as a stop sees them: a turn still running is
/// unfinished, and so is one that lost its lease, within
/// [`INTERRUPTED_TURN_WINDOW`] or for as long as the runtime has started no
/// job since. A runtime whose job a stop requeued does nothing more until
/// its shutdown, which may come long after the stop fenced it (a provider
/// release that is retried later). Each job counts on its own, so
/// concurrent workers never reset each other, and a job that ends any other
/// way (done or failed) clears only its own entry.
#[derive(Debug, Default)]
struct TurnTracker {
    running: HashSet<uuid::Uuid>,
    /// Jobs that ended by losing their lease, and when.
    interrupted: HashMap<uuid::Uuid, Instant>,
    /// When this runtime last started a job.
    last_start: Option<Instant>,
}

impl TurnTracker {
    fn started(&mut self, job_id: uuid::Uuid) {
        self.running.insert(job_id);
        self.interrupted.remove(&job_id);
        self.last_start = Some(Instant::now());
    }

    fn started_at(&mut self, job_id: uuid::Uuid, now: Instant) {
        self.started(job_id);
        self.last_start = Some(now);
    }

    fn ended(&mut self, job_id: uuid::Uuid, lease_lost: bool, now: Instant) {
        self.running.remove(&job_id);
        if lease_lost {
            self.interrupted.insert(job_id, now);
        } else {
            self.interrupted.remove(&job_id);
        }
        let last_start = self.last_start;
        self.interrupted
            .retain(|_, at| Self::still_counts(*at, last_start, now));
    }

    fn still_counts(lost_at: Instant, last_start: Option<Instant>, now: Instant) -> bool {
        now.saturating_duration_since(lost_at) < INTERRUPTED_TURN_WINDOW
            || last_start.is_none_or(|started| started <= lost_at)
    }

    fn interrupted(&self, now: Instant) -> bool {
        !self.running.is_empty()
            || self
                .interrupted
                .values()
                .any(|at| Self::still_counts(*at, self.last_start, now))
    }
}

/// How a job's turn ended, as the job loop decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    /// Done, failed or refused: the turn is over.
    Finished,
    /// The job lost its lease (a cancel, or a stop that requeued it) before
    /// or during its turn: the turn is interrupted.
    LeaseLost,
}

impl TurnEnd {
    /// Before the turn runs: `LeaseLost` once the job's lease is gone.
    pub fn before_run(lease_lost: &JobCancelSignal) -> Option<Self> {
        lease_lost.is_canceled().then_some(Self::LeaseLost)
    }

    /// After the turn ran: `LeaseLost` when it stopped because its lease was
    /// lost, `Finished` when it completed or failed on its own.
    pub fn after_run<T>(result: &Result<T>) -> Self {
        match result {
            Err(error) if is_lease_lost(error) => Self::LeaseLost,
            _ => Self::Finished,
        }
    }
}

/// An execution error that says the job's lease was lost.
pub fn is_lease_lost(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .to_ascii_lowercase()
            .contains("lease lost")
    })
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
    /// Record how the job's turn ended.
    pub fn end(mut self, end: TurnEnd) {
        self.record(end == TurnEnd::LeaseLost);
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
            .started_at(job_id, Instant::now());
        TurnGuard {
            tracker: self.turns.clone(),
            job_id,
            ended: false,
        }
    }

    /// Whether a stop now interrupts a turn: one is still running, or one
    /// lost its lease within the last minute or with no job started since.
    /// A shutdown flush then sets the turns' local commits aside instead of
    /// leaving them for the next publish.
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
        let (reply_draft_tx, reply_draft_task) =
            spawn_reply_draft_dispatch(client.clone(), registration, job.id);
        let (progress_tx, progress_status, progress_task) =
            spawn_progress_dispatch(client, registration, job.id, lease_lost_signal.clone());
        let progress_handle = JobProgress {
            sender: progress_tx.clone(),
            status: progress_status,
            reply_draft: Some(reply_draft_tx),
        };

        // The folder's unfinished work reaches canonical every two minutes
        // while the job runs, and once more when it ends.
        let saves = self.processor.rolling_saves_for(registration, job).await;
        let ticker = saves
            .as_ref()
            .map(rolling_saves::RollingSaves::start_ticker);
        let mut result = self
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
        // The reply is about to be posted whole, and no draft may arrive after it.
        reply_draft_task.abort();
        if let Some(saves) = saves.as_ref() {
            rolling_saves::finish_job(saves, ticker, &mut result).await;
        }

        finish_progress_dispatch(progress_tx, progress_task, job.id).await;
        result
    }

    pub async fn run_parallel_scoped_with_progress(
        &self,
        client: Arc<ControllerClient>,
        registration: &Registration,
        job: &LeaseJob,
        lease_lost_signal: Option<JobCancelSignal>,
    ) -> Result<JobExecution> {
        // The subprocess receives only this job's scoped secrets. Never install
        // them into the parent environment shared by sibling workers.
        let secrets = client.fetch_job_secrets(registration, job.id, true).await?;
        let worker_config = crate::agent::resolved_worker_job_config(&secrets)?;
        let (progress_tx, progress_status, progress_task) =
            spawn_progress_dispatch(client, registration, job.id, lease_lost_signal.clone());
        // A scoped worker reports to its lead, not to the conversation, so it drafts nothing.
        let progress_handle = JobProgress {
            sender: progress_tx.clone(),
            status: progress_status,
            reply_draft: None,
        };
        // Private copies are published only after scope/conflict validation.
        // A rolling whole-checkout save must not collect a sibling's edits.
        let result = self
            .processor
            .run_parallel_scoped_worker_job(
                registration,
                job,
                Some(progress_handle),
                lease_lost_signal,
                worker_config,
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

/// Sends the job's reply draft to the controller while the model writes it: the latest text
/// at most every [`REPLY_DRAFT_INTERVAL`], on its own task so it never waits behind the
/// progress queue. The first failure ends drafting for the job; a controller without the
/// draft route still receives the reply whole.
fn spawn_reply_draft_dispatch(
    client: Arc<ControllerClient>,
    registration: &Registration,
    job_id: uuid::Uuid,
) -> (ReplyDraftSender, JoinHandle<()>) {
    let (draft_tx, mut draft_rx) = watch::channel(ReplyDraft::default());
    let registration = registration.clone();
    let task = tokio::spawn(async move {
        let mut sent = ReplyDraft::default();
        let mut seq = 0u64;
        while draft_rx.changed().await.is_ok() {
            let draft = draft_rx.borrow_and_update().clone();
            // An empty draft matters only when it clears text a viewer has.
            if draft == sent || (draft.text.is_empty() && sent.text.is_empty()) {
                continue;
            }
            seq += 1;
            if let Err(error) = client
                .post_reply_draft(&registration, job_id, seq, &draft)
                .await
            {
                info!(
                    %error,
                    job_id = %job_id,
                    "controller did not take a reply draft; the reply arrives whole"
                );
                break;
            }
            sent = draft;
            tokio::time::sleep(REPLY_DRAFT_INTERVAL).await;
        }
    });
    (draft_tx, task)
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
    use super::{INTERRUPTED_TURN_WINDOW, TurnEnd, TurnGuard, TurnTracker, is_lease_lost};
    use crate::job_cancel::JobCancelSignal;
    use anyhow::Context as _;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    #[test]
    fn a_running_turn_or_one_that_lost_its_lease_is_interrupted_until_work_moves_on() {
        let start = Instant::now();
        let mut turns = TurnTracker::default();
        assert!(!turns.interrupted(start));

        let job = Uuid::new_v4();
        turns.started_at(job, start);
        assert!(turns.interrupted(start), "a running turn is unfinished");

        turns.ended(job, true, start);
        assert!(turns.interrupted(start + Duration::from_secs(59)));
        assert!(
            turns.interrupted(start + INTERRUPTED_TURN_WINDOW * 10),
            "with nothing started since, a late shutdown still interrupts it"
        );

        // The runtime moved on: another job ran after the loss.
        let later = Uuid::new_v4();
        turns.started_at(later, start + Duration::from_secs(1));
        turns.ended(later, false, start + Duration::from_secs(2));
        assert!(turns.interrupted(start + Duration::from_secs(59)));
        assert!(
            !turns.interrupted(start + INTERRUPTED_TURN_WINDOW),
            "a cancel long before the stop does not count once work moved on"
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
            turns.started_at(job, now);
        }
        turns.ended(cancelled, true, now);
        turns.ended(finished, false, now);
        turns.ended(failed, false, now);
        assert!(
            turns.interrupted(now),
            "a concurrent worker finishing never hides another's cancel"
        );

        // The cancelled job runs again and finishes: nothing is unfinished.
        turns.started_at(cancelled, now);
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
        .end(TurnEnd::Finished);
        assert!(!other.lock().unwrap().interrupted(Instant::now()));
    }

    /// How the job loop decides a turn's end: a lease lost before the run or
    /// during it interrupts the turn; a run that completes or fails on its
    /// own finishes it.
    #[test]
    fn the_job_loop_tells_a_lost_lease_from_a_finished_turn() {
        let signal = JobCancelSignal::new();
        assert_eq!(TurnEnd::before_run(&signal), None);
        signal.cancel();
        assert_eq!(TurnEnd::before_run(&signal), Some(TurnEnd::LeaseLost));

        let done: anyhow::Result<()> = Ok(());
        assert_eq!(TurnEnd::after_run(&done), TurnEnd::Finished);
        let failed: anyhow::Result<()> = Err(anyhow::anyhow!("codex exited with status 1"));
        assert_eq!(TurnEnd::after_run(&failed), TurnEnd::Finished);
        let lost: anyhow::Result<()> =
            Err(anyhow::anyhow!("job lease lost during heartbeat")).context("apply job failed");
        assert!(is_lease_lost(lost.as_ref().unwrap_err()));
        assert_eq!(TurnEnd::after_run(&lost), TurnEnd::LeaseLost);
    }
}
