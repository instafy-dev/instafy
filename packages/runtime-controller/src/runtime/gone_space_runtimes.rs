//! Releasing provider runtimes whose space no longer exists.
//!
//! Deleting a space through the controller stops its runtimes (see
//! [`super::deleted_project_stop`]). A space can also go without that path:
//! deleting a user removes their spaces with the database rows of their
//! runtimes, and a release can fail after the database already says
//! `stopped`. The provider still runs those containers, nothing in the
//! database points at them any more, and on a local Docker node each one holds
//! a network subnet until new starts fail for want of one.
//!
//! So the idle sweep, at most once per [`RECONCILE_INTERVAL`], asks each
//! node provider for its census and releases every runtime whose space is
//! missing from the database or deleted, unless the database still tracks
//! that exact generation as live (the deleted-space stop owns those). The
//! release names the generation the container runs, so the provider never
//! stops a newer one. A provider serves one controller: its database is the
//! authority on which spaces exist.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use tracing::{info, warn};
use uuid::Uuid;

use crate::AppState;

use super::drain::{drained_providers, provider_census, ProviderContainer};
use super::provider::{
    call_provider_endpoint, ProviderReleaseRequest, RUNTIME_PROVIDER_RELEASE_TIMEOUT,
};

/// How often the idle sweep reconciles the providers' runtimes.
pub(super) const RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Runtimes released per provider and run; the next run takes the rest.
const RELEASE_BATCH_SIZE: usize = 10;

static LAST_RECONCILE: Mutex<Option<Instant>> = Mutex::new(None);

/// [`release_runtimes_of_gone_spaces`] when the last run is older than
/// [`RECONCILE_INTERVAL`]. Never while this controller is being drained: the
/// drain decides what runs on its node.
pub(super) async fn maybe_release_runtimes_of_gone_spaces(state: &AppState) {
    if state.runtime_drain.is_fenced() {
        return;
    }
    {
        let mut last = LAST_RECONCILE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < RECONCILE_INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    release_runtimes_of_gone_spaces(state).await;
}

/// Release, on every node provider, the runtimes whose space is missing or
/// deleted (see the module docs). Returns how many releases the providers
/// acknowledged. Failures are logged; the next run tries again.
pub(super) async fn release_runtimes_of_gone_spaces(state: &AppState) -> usize {
    let mut released = 0;
    for provider in drained_providers(state) {
        let census = match provider_census(state, &provider).await {
            Ok(census) if census.supported => census,
            Ok(_) => continue,
            Err(error) => {
                warn!(provider = %provider.id, %error, "runtime census failed; runtimes of gone spaces wait for the next run");
                continue;
            }
        };
        let candidates = match runtimes_of_gone_spaces(state, &census.containers).await {
            Ok(candidates) => candidates,
            Err(error) => {
                warn!(provider = %provider.id, error = %format!("{error:#}"), "could not check which runtimes belong to gone spaces");
                continue;
            }
        };
        for (project_id, runtime_id, lease_id, compose_project) in
            candidates.into_iter().take(RELEASE_BATCH_SIZE)
        {
            let request = ProviderReleaseRequest {
                project_id: &project_id,
                runtime_id: &runtime_id,
                lease_id: Some(&lease_id),
            };
            match call_provider_endpoint(
                state,
                &provider,
                "/runtime/release",
                &request,
                RUNTIME_PROVIDER_RELEASE_TIMEOUT,
            )
            .await
            {
                Ok(_) => {
                    released += 1;
                    info!(
                        provider = %provider.id,
                        %project_id,
                        %runtime_id,
                        %compose_project,
                        "released the runtime of a space that no longer exists"
                    );
                }
                Err(error) => warn!(
                    provider = %provider.id,
                    %project_id,
                    %runtime_id,
                    %error,
                    "failed to release the runtime of a space that no longer exists"
                ),
            }
        }
    }
    released
}

/// The census entries to release: a space that is missing or deleted, a
/// runtime and generation the container names, and no live database runtime
/// running that same generation. As `(project, runtime, lease, compose
/// project)`.
async fn runtimes_of_gone_spaces(
    state: &AppState,
    containers: &[ProviderContainer],
) -> anyhow::Result<Vec<(Uuid, Uuid, Uuid, String)>> {
    let named: Vec<(Uuid, Uuid, Uuid, String)> = containers
        .iter()
        .filter_map(|container| {
            Some((
                container.project_id?,
                container.runtime_id?,
                container.lease_id?,
                container.compose_project.clone(),
            ))
        })
        .collect();
    if named.is_empty() {
        return Ok(Vec::new());
    }
    let project_ids: Vec<Uuid> = named.iter().map(|entry| entry.0).collect();
    let runtime_ids: Vec<Uuid> = named.iter().map(|entry| entry.1).collect();
    let lease_ids: Vec<Uuid> = named.iter().map(|entry| entry.2).collect();
    let connection = state
        .pool
        .get()
        .await
        .context("failed to get a connection to check the census against the spaces")?;
    let rows = connection
        .query(
            "select c.ordinality
             from unnest($1::uuid[], $2::uuid[], $3::uuid[])
                  with ordinality as c(project_id, runtime_id, lease_id, ordinality)
             left join projects p on p.id = c.project_id
             where (p.id is null or p.status = 'deleted')
               and not exists (
                 select 1 from runtimes r
                 where r.id = c.runtime_id
                   and r.project_id = c.project_id
                   and r.active_lease_id = c.lease_id
                   and r.status not in ('stopped', 'offline', 'removed')
               )
             order by c.ordinality",
            &[&project_ids, &runtime_ids, &lease_ids],
        )
        .await
        .context("failed to check the census against the spaces")?;
    drop(connection);
    Ok(rows
        .iter()
        .filter_map(|row| {
            let ordinality: i64 = row.get("ordinality");
            named.get(usize::try_from(ordinality - 1).ok()?).cloned()
        })
        .collect())
}

#[cfg(test)]
#[path = "gone_space_runtimes_tests.rs"]
mod db_tests;
