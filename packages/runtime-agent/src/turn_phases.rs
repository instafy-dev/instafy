//! Where a job's own time went: the runtime's steps of one turn, from the moment the lease loop
//! handed the job over to the moment its report goes out, as millisecond offsets
//! (`agent/phase-timings`).
//!
//! The controller's records give a turn's edges (`leasedAt`, `completedAt`) and the run log gives
//! the main Codex run from its own start (`atMs`). What lies between them is timed here: the
//! first heartbeat, the secrets, the folder's refresh, the routing step and the lease checks. A
//! slow turn then splits into its steps from stored data alone (docs/Octo-Turn-Eval.md, "Where
//! the time went").
//!
//! A job's clock runs from [`start`] until its guard is dropped. A step is timed by holding the
//! [`PhaseSpan`] that [`span`] returns. Without a running clock (a local-engine turn, a test that
//! drives the executor directly) nothing is recorded and no artifact is made.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::Mutex;
use serde_json::{Value as JsonValue, json};
use uuid::Uuid;

/// The artifact's kind.
pub(crate) const ARTIFACT_KIND: &str = "agent/phase-timings";
/// A job keeps at most this many steps; later ones are only counted (`phasesDropped`).
const MAX_PHASES: usize = 64;

/// A step of a job that the runtime times.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    /// The heartbeat sent before anything else of the job runs.
    FirstHeartbeat,
    /// The job's secrets (`POST /agent/secrets`).
    Secrets,
    /// The refresh of the folder against canonical `main` before the turn.
    WorkspaceRefresh,
    /// The lease check before the routing step.
    RoutingLeaseCheck,
    /// The routing step's whole Codex run: setup, model call and shutdown.
    Routing,
    /// The `git status` taken before the main run.
    GitStatus,
    /// The lease check before the main run.
    MainLeaseCheck,
    /// The main Codex run: setup, thread restore, model call and shutdown.
    Main,
    /// A recovery retry's Codex run.
    Recovery,
    /// A finalization pass's Codex run.
    Finalization,
    /// The save of the folder's work when the turn ends.
    TurnEndSave,
    /// The wait for the turn's streamed steps to reach the controller.
    MessageDrain,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::FirstHeartbeat => "first_heartbeat",
            Self::Secrets => "secrets",
            Self::WorkspaceRefresh => "workspace_refresh",
            Self::RoutingLeaseCheck => "routing_lease_check",
            Self::Routing => "routing",
            Self::GitStatus => "git_status",
            Self::MainLeaseCheck => "main_lease_check",
            Self::Main => "main",
            Self::Recovery => "recovery",
            Self::Finalization => "finalization",
            Self::TurnEndSave => "turn_end_save",
            Self::MessageDrain => "message_drain",
        }
    }
}

struct Timed {
    phase: Phase,
    start_ms: u64,
    /// None while the step runs.
    ms: Option<u64>,
}

struct JobClock {
    /// Which [`start`] made this clock, so a guard or span of an earlier clock of the same job
    /// never touches it.
    serial: u64,
    received: Instant,
    received_at: DateTime<Utc>,
    phases: Vec<Timed>,
    dropped: usize,
}

impl JobClock {
    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.received.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

static CLOCKS: LazyLock<Mutex<HashMap<Uuid, JobClock>>> = LazyLock::new(Default::default);
static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

/// Starts `job_id`'s clock now. Its record goes when the guard is dropped.
pub(crate) fn start(job_id: Uuid) -> JobClockGuard {
    let serial = NEXT_SERIAL.fetch_add(1, Ordering::Relaxed);
    CLOCKS.lock().insert(
        job_id,
        JobClock {
            serial,
            received: Instant::now(),
            received_at: Utc::now(),
            phases: Vec::new(),
            dropped: 0,
        },
    );
    JobClockGuard { job_id, serial }
}

/// Keeps a job's clock running; see [`start`].
pub(crate) struct JobClockGuard {
    job_id: Uuid,
    serial: u64,
}

impl Drop for JobClockGuard {
    fn drop(&mut self) {
        let mut clocks = CLOCKS.lock();
        if clocks
            .get(&self.job_id)
            .is_some_and(|clock| clock.serial == self.serial)
        {
            clocks.remove(&self.job_id);
        }
    }
}

/// Times `phase` of `job_id` from now until the returned span is dropped.
pub(crate) fn span(job_id: Uuid, phase: Phase) -> PhaseSpan {
    let mut clocks = CLOCKS.lock();
    let Some(clock) = clocks.get_mut(&job_id) else {
        return PhaseSpan { job_id, slot: None };
    };
    if clock.phases.len() >= MAX_PHASES {
        clock.dropped += 1;
        return PhaseSpan { job_id, slot: None };
    }
    let start_ms = clock.elapsed_ms();
    clock.phases.push(Timed {
        phase,
        start_ms,
        ms: None,
    });
    PhaseSpan {
        job_id,
        slot: Some((clock.serial, clock.phases.len() - 1)),
    }
}

/// One step being timed; it ends when this is dropped.
#[must_use = "a step is timed until its span is dropped"]
pub(crate) struct PhaseSpan {
    job_id: Uuid,
    /// The clock's serial and the step's place in it; None when nothing is recorded.
    slot: Option<(u64, usize)>,
}

impl Drop for PhaseSpan {
    fn drop(&mut self) {
        let Some((serial, index)) = self.slot else {
            return;
        };
        let mut clocks = CLOCKS.lock();
        let Some(clock) = clocks
            .get_mut(&self.job_id)
            .filter(|clock| clock.serial == serial)
        else {
            return;
        };
        let now = clock.elapsed_ms();
        if let Some(timed) = clock.phases.get_mut(index) {
            timed.ms = Some(now.saturating_sub(timed.start_ms));
        }
    }
}

/// `job_id`'s `agent/phase-timings` artifact as of now, or None when its clock is not running.
///
/// `receivedAt` is when the job was handed over, by this machine's clock; every `startMs` and
/// `reportedMs` counts from it. A step still running has `ms: null`.
pub(crate) fn artifact(job_id: Uuid) -> Option<JsonValue> {
    let clocks = CLOCKS.lock();
    let clock = clocks.get(&job_id)?;
    let phases: Vec<JsonValue> = clock
        .phases
        .iter()
        .map(|timed| {
            json!({
                "phase": timed.phase.name(),
                "startMs": timed.start_ms,
                "ms": timed.ms,
            })
        })
        .collect();
    Some(json!({
        "kind": ARTIFACT_KIND,
        "version": 1,
        "receivedAt": clock.received_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "reportedMs": clock.elapsed_ms(),
        "phases": phases,
        "phasesDropped": clock.dropped,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_job_reports_each_step_with_its_start_and_length() {
        let job = Uuid::new_v4();
        let clock = start(job);
        std::thread::sleep(Duration::from_millis(5));
        {
            let _heartbeat = span(job, Phase::FirstHeartbeat);
            std::thread::sleep(Duration::from_millis(20));
        }
        let main = span(job, Phase::Main);

        let report = artifact(job).expect("a running clock reports");
        assert_eq!(report["kind"], ARTIFACT_KIND);
        assert_eq!(report["version"], 1);
        assert!(DateTime::parse_from_rfc3339(report["receivedAt"].as_str().unwrap()).is_ok());
        let phases = report["phases"].as_array().unwrap();
        assert_eq!(phases.len(), 2);
        assert_eq!(phases[0]["phase"], "first_heartbeat");
        assert!(phases[0]["startMs"].as_u64().unwrap() >= 5);
        assert!(phases[0]["ms"].as_u64().unwrap() >= 20);
        // A step still running when the report is made has no length yet.
        assert_eq!(phases[1]["phase"], "main");
        assert!(phases[1]["ms"].is_null());
        assert!(report["reportedMs"].as_u64().unwrap() >= 25);
        assert_eq!(report["phasesDropped"], 0);

        drop(main);
        drop(clock);
        assert!(artifact(job).is_none(), "the record goes with its guard");
    }

    #[test]
    fn nothing_is_recorded_without_a_running_clock() {
        let job = Uuid::new_v4();
        drop(span(job, Phase::Routing));
        assert!(artifact(job).is_none());
    }

    #[test]
    fn an_earlier_clock_of_the_same_job_never_touches_a_later_one() {
        let job = Uuid::new_v4();
        let first = start(job);
        let first_step = span(job, Phase::Secrets);
        let second = start(job);
        drop(first_step);
        drop(first);
        let report = artifact(job).expect("the later clock still runs");
        assert_eq!(report["phases"], json!([]));
        drop(second);
        assert!(artifact(job).is_none());
    }

    #[test]
    fn a_job_keeps_a_bounded_number_of_steps() {
        let job = Uuid::new_v4();
        let _clock = start(job);
        for _ in 0..MAX_PHASES + 3 {
            drop(span(job, Phase::GitStatus));
        }
        let report = artifact(job).unwrap();
        assert_eq!(report["phases"].as_array().unwrap().len(), MAX_PHASES);
        assert_eq!(report["phasesDropped"], 3);
    }
}
