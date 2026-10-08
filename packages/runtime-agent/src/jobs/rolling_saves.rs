//! Rolling saves of a running write job's working folder.
//!
//! While a write job runs on a hosted checkout, this runtime saves the
//! folder's unfinished work to canonical every [`TICK_INTERVAL`] and once
//! more when the job ends, through its own origin's `/workspace/persist`
//! (see `origin_http_server::working_state`). Nothing is pushed into the
//! checkout's branch and nothing it holds moves: a save is a recovery ref
//! the folder owns, which Studio hides while this runtime is live.
//!
//! - A tick first asks the origin, in process, whether the folder changed
//!   since its last confirmed save. When it did not (and no work waits on a
//!   local ref), the tick ends without a controller call.
//! - Otherwise it asks the controller for a one-minute `workspace.persist`
//!   grant with the job's internal workspace token, for this runtime's own
//!   origin only, and posts the save to the local listener.
//! - A 403 ends the ticks for this job: `rolling_saves_off` when the
//!   controller's switch is off, or a job the controller will not save for.
//!   So does a 401: the job's workspace token expired (the controller mints
//!   it once, when the job is leased), so no later grant can succeed; the
//!   job's own save at its end is recorded as not landed. Anything else (a
//!   busy workspace, a stop, a network failure) waits for the next tick.
//!   Ticks never overlap, and a missed one is not queued.
//! - When the job's body returns, whatever it returned, the ticker stops
//!   and the job's own save runs, unless the change check finds the folder
//!   as its last confirmed save held it in full (nothing deferred, nothing
//!   local-only); a save that did not land is recorded on the job as a
//!   `working-state` artifact.

use std::future::Future;
use std::time::Duration;

use anyhow::Result;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{debug, info, warn};
use uuid::Uuid;

use origin_http_server::working_state::WorkingState;

use super::JobExecution;
use crate::origin::LocalOriginSync;

/// How often a running write job saves its working folder.
pub(crate) const TICK_INTERVAL: Duration = Duration::from_secs(120);

/// The longest one save may take: a turn-end save may wait for the
/// workspace and then push for its full budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

/// The scope of a rolling save's grant (the controller's
/// `WORKSPACE_PERSIST_SCOPE`).
const WORKSPACE_PERSIST_SCOPE: &str = "workspace.persist";

/// The code of a grant refused because rolling saves are off.
const ROLLING_SAVES_OFF: &str = "rolling_saves_off";

/// Why a save was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    Tick,
    TurnEnd,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tick => "tick",
            Self::TurnEnd => "turn_end",
        }
    }
}

/// What one save did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SaveOutcome {
    /// Unchanged since the last confirmed save: nothing was asked.
    Unchanged,
    /// The origin answered.
    Saved(WorkingState),
    /// Rolling saves are off.
    Off,
    /// The controller will not save for this job (a fixed code or status).
    Refused(String),
    /// The job's workspace token expired: no later grant of this job can
    /// succeed.
    Expired,
    /// Not now: the workspace was busy, a stop began, or the grant named
    /// another origin. The next tick tries again.
    Skipped(&'static str),
    /// The grant or the save failed (a fixed description, no response body).
    Failed(String),
}

impl SaveOutcome {
    /// No later tick of this job can succeed.
    fn ends_ticks(&self) -> bool {
        matches!(self, Self::Off | Self::Refused(_) | Self::Expired)
    }
}

/// Everything a running write job needs to save its working folder.
#[derive(Clone)]
pub(crate) struct RollingSaves {
    client: reqwest::Client,
    controller_base_url: Url,
    workspace_token: String,
    project_id: Uuid,
    job_id: Uuid,
    origin: LocalOriginSync,
}

impl std::fmt::Debug for RollingSaves {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RollingSaves")
            .field("project_id", &self.project_id)
            .field("job_id", &self.job_id)
            .field("origin_id", &self.origin.origin_id)
            .finish_non_exhaustive()
    }
}

/// Whether a job saves its working folder as it runs, decided from what the
/// runtime knows when the job starts. Only a write job on a hosted checkout
/// with a canonical remote and an origin in this process does; a Desktop
/// folder and a read-only job never do. Whether the turn could take a
/// workspace lease plays no part.
pub(crate) struct Gate<'a> {
    pub(crate) hosted_checkout: bool,
    pub(crate) has_git_remote: bool,
    pub(crate) read_only_job: bool,
    pub(crate) workspace_token: Option<String>,
    pub(crate) local_origin: Option<LocalOriginSync>,
    pub(crate) controller_base_url: &'a Url,
    pub(crate) project_id: Uuid,
    pub(crate) job_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantRequest<'a> {
    project_id: String,
    protocol: &'static str,
    scopes: [&'static str; 1],
    job_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantResponse {
    origin_id: Uuid,
    token: String,
}

#[derive(Deserialize)]
struct RefusalBody {
    #[serde(default)]
    code: Option<String>,
}

impl RollingSaves {
    pub(crate) fn from_gate(gate: Gate<'_>) -> Option<Self> {
        if !gate.hosted_checkout || !gate.has_git_remote || gate.read_only_job {
            return None;
        }
        let origin = gate
            .local_origin
            .filter(|origin| origin.working_state.is_some())?;
        let workspace_token = gate
            .workspace_token
            .filter(|token| !token.trim().is_empty())?;
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .ok()?;
        Some(Self {
            client,
            controller_base_url: gate.controller_base_url.clone(),
            workspace_token,
            project_id: gate.project_id,
            job_id: gate.job_id,
            origin,
        })
    }

    /// One tick: the change check, then a save only when something changed.
    pub(crate) async fn tick(&self) -> SaveOutcome {
        if self
            .check()
            .await
            .is_some_and(|state| !state.changed && state.local_only == 0)
        {
            return SaveOutcome::Unchanged;
        }
        self.save(Reason::Tick).await
    }

    /// The change check, in process. `None` when it could not be read:
    /// saving reads the folder again, so that is no reason to skip a save.
    async fn check(&self) -> Option<WorkingState> {
        match self.origin.working_state.as_ref()?.state().await {
            Ok(state) => Some(state),
            Err(error) => {
                debug!(%error, "the working state could not be read");
                None
            }
        }
    }

    /// Ask for a grant and post one save to this runtime's own origin.
    pub(crate) async fn save(&self, reason: Reason) -> SaveOutcome {
        let grant = match self.grant().await {
            Ok(grant) => grant,
            Err(outcome) => return outcome,
        };
        // A grant for any other origin is never used here.
        if grant.origin_id != self.origin.origin_id {
            return SaveOutcome::Skipped("origin_not_local");
        }
        let endpoint = self.origin.endpoint.trim().trim_end_matches('/');
        let response = match self
            .client
            .post(format!("{endpoint}/workspace/persist"))
            .bearer_auth(&grant.token)
            .json(&json!({ "reason": reason.as_str() }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) if error.is_timeout() => {
                return SaveOutcome::Failed("origin_timeout".to_string());
            }
            Err(_) => return SaveOutcome::Failed("origin_unreachable".to_string()),
        };
        match response.status() {
            status if status.is_success() => match response.json::<WorkingState>().await {
                Ok(state) => SaveOutcome::Saved(state),
                Err(_) => SaveOutcome::Failed("origin_response_invalid".to_string()),
            },
            StatusCode::CONFLICT => SaveOutcome::Skipped("busy"),
            StatusCode::SERVICE_UNAVAILABLE => SaveOutcome::Skipped("stopping"),
            status => SaveOutcome::Failed(format!("origin_refused:{}", status.as_u16())),
        }
    }

    async fn grant(&self) -> Result<GrantResponse, SaveOutcome> {
        let url = self
            .controller_base_url
            .join("/access_token")
            .map_err(|_| SaveOutcome::Failed("controller_url_invalid".to_string()))?;
        let job_id = self.job_id.to_string();
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.workspace_token)
            .json(&GrantRequest {
                project_id: self.project_id.to_string(),
                protocol: "http",
                scopes: [WORKSPACE_PERSIST_SCOPE],
                job_id: &job_id,
            })
            .send()
            .await
            .map_err(|_| SaveOutcome::Failed("controller_unreachable".to_string()))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<GrantResponse>()
                .await
                .map_err(|_| SaveOutcome::Failed("grant_response_invalid".to_string()));
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(SaveOutcome::Expired);
        }
        if status == StatusCode::FORBIDDEN {
            let code = response
                .json::<RefusalBody>()
                .await
                .ok()
                .and_then(|body| body.code);
            return Err(match code.as_deref() {
                Some(ROLLING_SAVES_OFF) => SaveOutcome::Off,
                Some(code) => SaveOutcome::Refused(code.to_string()),
                None => SaveOutcome::Refused("forbidden".to_string()),
            });
        }
        Err(SaveOutcome::Failed(format!(
            "grant_refused:{}",
            status.as_u16()
        )))
    }

    /// Save every [`TICK_INTERVAL`] until stopped, the first one interval
    /// from now.
    pub(crate) fn start_ticker(&self) -> Ticker {
        self.start_ticker_every(TICK_INTERVAL)
    }

    pub(crate) fn start_ticker_every(&self, interval: Duration) -> Ticker {
        let saves = self.clone();
        spawn_ticker(interval, move || {
            let saves = saves.clone();
            async move {
                let outcome = saves.tick().await;
                log_tick(&saves, &outcome);
                !outcome.ends_ticks()
            }
        })
    }

    /// The job's own save once its body returned: `Some` artifact when the
    /// save did not leave canonical holding the folder's work. When the
    /// folder's last confirmed save holds all of it (nothing deferred,
    /// nothing local-only) and nothing changed since, there is nothing to
    /// save and the controller is not asked.
    pub(crate) async fn save_at_turn_end(&self) -> Option<JsonValue> {
        let outcome = if self
            .check()
            .await
            .is_some_and(|state| state.durable && !state.changed)
        {
            SaveOutcome::Unchanged
        } else {
            self.save(Reason::TurnEnd).await
        };
        let artifact = turn_end_artifact(&outcome);
        match &outcome {
            SaveOutcome::Saved(state) => info!(
                job_id = %self.job_id,
                durable = state.durable,
                unsaved = state.unsaved,
                local_only = state.local_only,
                error = state.error.as_deref().unwrap_or("none"),
                "saved the working folder at the end of the job"
            ),
            SaveOutcome::Unchanged => debug!(
                job_id = %self.job_id,
                "the working folder is saved and unchanged at the end of the job"
            ),
            other => warn!(
                job_id = %self.job_id,
                outcome = ?other,
                "could not save the working folder at the end of the job"
            ),
        }
        artifact
    }
}

fn log_tick(saves: &RollingSaves, outcome: &SaveOutcome) {
    match outcome {
        SaveOutcome::Unchanged => debug!(job_id = %saves.job_id, "the working folder is unchanged"),
        SaveOutcome::Saved(state) => info!(
            job_id = %saves.job_id,
            durable = state.durable,
            unsaved = state.unsaved,
            error = state.error.as_deref().unwrap_or("none"),
            "rolling save of the working folder"
        ),
        SaveOutcome::Off => info!(job_id = %saves.job_id, "rolling saves are off; no more ticks"),
        SaveOutcome::Refused(code) => warn!(
            job_id = %saves.job_id,
            %code,
            "the controller will not save this job's folder; no more ticks"
        ),
        SaveOutcome::Expired => warn!(
            job_id = %saves.job_id,
            "the job's workspace token expired; no more rolling saves for this job, and its own save at the end will not land either"
        ),
        SaveOutcome::Skipped(reason) => {
            debug!(job_id = %saves.job_id, reason, "rolling save skipped")
        }
        SaveOutcome::Failed(code) => {
            warn!(job_id = %saves.job_id, %code, "rolling save failed; the next tick tries again")
        }
    }
}

/// The `working-state` artifact of a turn-end save that did not land, if it
/// did not. Saves switched off, or refused for this job, record nothing.
pub(crate) fn turn_end_artifact(outcome: &SaveOutcome) -> Option<JsonValue> {
    let error = match outcome {
        SaveOutcome::Saved(state) if state.durable => return None,
        SaveOutcome::Saved(state) => state
            .error
            .clone()
            .unwrap_or_else(|| "not_durable".to_string()),
        SaveOutcome::Unchanged | SaveOutcome::Off | SaveOutcome::Refused(_) => return None,
        SaveOutcome::Expired => "workspace_token_expired".to_string(),
        SaveOutcome::Skipped(reason) => (*reason).to_string(),
        SaveOutcome::Failed(code) => code.clone(),
    };
    let persisted_at = match outcome {
        SaveOutcome::Saved(state) => state.persisted_at,
        _ => None,
    };
    Some(json!({
        "kind": "working-state",
        "durable": false,
        "error": error,
        "persistedAt": persisted_at,
    }))
}

/// A running ticker; [`Ticker::stop`] ends it.
pub(crate) struct Ticker {
    task: JoinHandle<()>,
}

impl Ticker {
    /// Stop ticking: abort, then wait for the task, a tick in flight
    /// included, to be gone.
    pub(crate) async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }

    #[cfg(test)]
    fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

/// Run `tick` every `interval`, the first one interval from now, until it
/// answers `false`. A tick runs to its end before the next is due, so ticks
/// never overlap, and one missed meanwhile is skipped, not queued.
pub(crate) fn spawn_ticker<F, Fut>(interval: Duration, tick: F) -> Ticker
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = bool> + Send + 'static,
{
    let task = tokio::spawn(async move {
        let mut due = Instant::now() + interval;
        loop {
            tokio::time::sleep_until(due).await;
            if !tick().await {
                break;
            }
            // The next slot on the fixed grid that is still ahead: slots a
            // long tick covered are dropped, never run late.
            let now = Instant::now();
            due += interval;
            while due <= now {
                due += interval;
            }
        }
    });
    Ticker { task }
}

/// After a write job's body returned, whatever it returned: stop the
/// ticker, then run the job's own save, and record a save that did not
/// land on the job's result.
pub(crate) async fn finish_job(
    saves: &RollingSaves,
    ticker: Option<Ticker>,
    result: &mut Result<JobExecution>,
) {
    if let Some(ticker) = ticker {
        ticker.stop().await;
    }
    if let Some(artifact) = saves.save_at_turn_end().await {
        attach_artifact(result, artifact);
    }
}

/// Add `artifact` to a job's result: its execution, or the artifacts a
/// failure reports.
pub(crate) fn attach_artifact(result: &mut Result<JobExecution>, artifact: JsonValue) {
    match result {
        Ok(execution) => execution.artifacts.push(artifact),
        Err(error) => {
            if let Some(failure) = error.downcast_mut::<super::JobFailureWithArtifacts>() {
                failure.artifacts.push(artifact);
            }
        }
    }
}

#[cfg(test)]
#[path = "rolling_saves_tests.rs"]
mod tests;
