//! A person's message that names several agents runs their turns one after
//! another, in the order the message names them (docs/Local-Engine-Turns.md
//! 11.22, D53). Each agent's turn may change any file of the space
//! (`unscoped`, `agent_write_scopes`), whatever AI the agent uses, and waits,
//! queued, until the turn of the agent named before it has ended, however it
//! ended. So no two of them change the space at once, and each starts from
//! the space as the one before it left it.
//!
//! - Dispatch decides it with the write scopes
//!   (`agent_write_scopes::build_agent_write_scope_plan`), records on each
//!   later job the job it waits for ([`wait_for`], `agent_jobs.after_job_id`),
//!   and stamps each later run with the run and the agent it waits for
//!   ([`stamp_run`]), which Studio words.
//! - The lease and the idle poll pass over a queued job while the job it
//!   waits for is queued or leased ([`waits_for_an_earlier_turn`]).

use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::{internal_error, ApiError};

/// The key, on a run's metadata, of the run and the agent whose turn it
/// waits for. Only dispatch writes it ([`strip_client_marks`]).
pub(crate) const RUN_KEY: &str = "takesTurns";

/// The SQL condition that a job, by the alias given, waits for the turn
/// before it: the job it waits for (`after_job_id`) is still queued or
/// leased. A job that waits for none, or whose earlier job completed,
/// failed, was stopped or was canceled, may be leased.
macro_rules! waits_for_an_earlier_turn {
    ($job:literal) => {
        concat!(
            "exists (
                select 1 from agent_jobs earlier_turn
                 where earlier_turn.id = ",
            $job,
            ".after_job_id
                   and earlier_turn.status in ('queued', 'leased')
            )"
        )
    };
}
pub(crate) use waits_for_an_earlier_turn;

/// Records that `job_id`'s turn waits for `earlier_job_id`'s, in the
/// dispatch transaction that queued both, so no lease sees the later job
/// before it waits.
pub(crate) async fn wait_for(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    earlier_job_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let updated = transaction
        .execute(
            "update agent_jobs
                set after_job_id = $3
              where id = $2
                and project_id = $1
                and status = 'queued'",
            &[project_id, job_id, earlier_job_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to make job {job_id} wait for job {earlier_job_id}: {error}"
            ))
        })?;
    if updated != 1 {
        return Err(internal_error(format!(
            "job {job_id} is not queued, so it cannot wait for job {earlier_job_id}"
        )));
    }
    Ok(())
}

/// Stamps a run's metadata with the run and the agent whose turn it waits
/// for, which Studio words while it waits ("Waiting for @a to finish…").
pub(crate) fn stamp_run(
    metadata: &mut JsonMap<String, JsonValue>,
    earlier_run_id: &Uuid,
    earlier_handle: &str,
) {
    metadata.insert(
        RUN_KEY.to_string(),
        json!({
            "version": 1,
            "afterRunId": earlier_run_id,
            "afterAgent": earlier_handle,
        }),
    );
}

/// Removes a client's own copy of [`RUN_KEY`], so a run says it waits for
/// another only when dispatch made it wait.
pub(crate) fn strip_client_marks(metadata: &mut JsonValue) {
    if let Some(map) = metadata.as_object_mut() {
        map.remove(RUN_KEY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lease_clause_reads_the_earlier_job_by_the_alias_given() {
        let clause = waits_for_an_earlier_turn!("aj");
        assert!(clause.contains("earlier_turn.id = aj.after_job_id"));
        assert!(clause.contains("earlier_turn.status in ('queued', 'leased')"));
    }

    #[test]
    fn a_run_names_the_run_and_agent_it_waits_for() {
        let earlier = Uuid::nil();
        let mut metadata = JsonMap::new();
        stamp_run(&mut metadata, &earlier, "a");
        assert_eq!(
            metadata.get(RUN_KEY),
            Some(&json!({
                "version": 1,
                "afterRunId": earlier,
                "afterAgent": "a",
            }))
        );
    }

    #[test]
    fn a_client_cannot_say_a_run_waits() {
        let mut metadata = json!({
            RUN_KEY: {"version": 1, "afterRunId": Uuid::nil(), "afterAgent": "a"},
            "other": true,
        });
        strip_client_marks(&mut metadata);
        assert_eq!(metadata, json!({"other": true}));
        strip_client_marks(&mut JsonValue::Null);
    }
}
