//! A person's message that names several agents runs their turns one after
//! another, in the order the message names them (docs/Local-Engine-Turns.md
//! 11.22, D53). Each agent's turn may change any file of the space
//! (`unscoped`, `agent_write_scopes`), whatever AI the agent uses, and waits,
//! queued, until the turns of every agent named before it have ended, however
//! they ended. So no two of them change the space at once, and each starts
//! from the space as the ones before it left it.
//!
//! The exception is a message's Claude Code agents (11.23, D57): each works
//! in a folder of its own whose save merges into the space's folder, so a
//! Claude Code agent's turn waits only for the earlier agents on other AIs
//! ([`waited_for`]), and its computer runs it beside the others as far as it
//! can.
//!
//! - Dispatch decides it with the write scopes
//!   (`agent_write_scopes::build_agent_write_scope_plan`), records on each
//!   later job the jobs it waits for ([`wait_for`], `agent_jobs.after_job_ids`):
//!   every earlier one, so stopping a middle turn while it waits never lets
//!   the next start beside the first. It stamps each later run with the runs
//!   and the agents before it ([`stamp_run`]), which Studio words.
//! - The lease and the idle poll pass over a queued job while any job it
//!   waits for is queued or leased ([`waits_for_an_earlier_turn`]). So do the
//!   busy checks for a teammate's turn, and a runtime's stop, which never
//!   counts such a turn as interrupted.

use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::{internal_error, ApiError};

/// The key, on a run's metadata, of the runs and the agents whose turns it
/// waits for. Only dispatch writes it ([`strip_client_marks`]).
pub(crate) const RUN_KEY: &str = "takesTurns";

/// The SQL condition that a job, by the alias or table name given, waits for
/// an earlier turn: one of the jobs it waits for (`after_job_ids`) is still
/// queued or leased. A job that waits for none, or whose earlier jobs all
/// completed, failed, expired or were canceled, may be leased.
macro_rules! waits_for_an_earlier_turn {
    ($job:literal) => {
        concat!(
            "exists (
                select 1 from agent_jobs earlier_turn
                 where earlier_turn.id = any(",
            $job,
            ".after_job_ids)
                   and earlier_turn.status in ('queued', 'leased')
            )"
        )
    };
}
pub(crate) use waits_for_an_earlier_turn;

/// Of a message's earlier turns, each with whether it is a Claude Code
/// turn, the ones a turn waits for (11.22, 11.23): every one, unless the turn
/// is a Claude Code turn, which waits only for the turns of agents on other
/// AIs. Claude Code turns work in folders of their own, merged back as each
/// saves (D55, D57), so they run beside each other.
pub(crate) fn waited_for<T: Copy>(earlier: &[(T, bool)], claude_code: bool) -> Vec<T> {
    earlier
        .iter()
        .filter(|(_, earlier_claude_code)| !(claude_code && *earlier_claude_code))
        .map(|(turn, _)| *turn)
        .collect()
}

/// Records that `job_id`'s turn waits for those of `earlier_job_ids`, in
/// the dispatch transaction that queued them all, so no lease sees the later
/// job before it waits.
pub(crate) async fn wait_for(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    earlier_job_ids: &[Uuid],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let updated = transaction
        .execute(
            "update agent_jobs
                set after_job_ids = $3
              where id = $2
                and project_id = $1
                and status = 'queued'",
            &[project_id, job_id, &earlier_job_ids],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to make job {job_id} wait for the turns before it: {error}"
            ))
        })?;
    if updated != 1 {
        return Err(internal_error(format!(
            "job {job_id} is not queued, so it cannot wait for the turns before it"
        )));
    }
    Ok(())
}

/// Stamps a run's metadata with the runs and the agents whose turns it waits
/// for, in the order the message names them, which Studio words while it
/// waits: "Waiting for @a to finish…", by the latest of them still running.
pub(crate) fn stamp_run(metadata: &mut JsonMap<String, JsonValue>, earlier: &[(Uuid, &str)]) {
    let after: Vec<JsonValue> = earlier
        .iter()
        .map(|(run_id, handle)| json!({ "runId": run_id, "agent": handle }))
        .collect();
    metadata.insert(RUN_KEY.to_string(), json!({ "version": 1, "after": after }));
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
    fn a_claude_code_turn_waits_only_for_the_earlier_agents_on_other_ais() {
        // "@claude1 do x, @codex do y, @claude2 do z, @helper do w"
        let earlier = [(1, true), (2, false), (3, true)];
        assert_eq!(waited_for(&earlier, true), vec![2]);
        assert_eq!(waited_for(&earlier, false), vec![1, 2, 3]);
        assert!(waited_for(&[(1, true)], true).is_empty());
        assert!(waited_for::<u8>(&[], false).is_empty());
    }

    #[test]
    fn the_lease_clause_reads_the_earlier_job_by_the_alias_given() {
        let clause = waits_for_an_earlier_turn!("aj");
        assert!(clause.contains("earlier_turn.id = any(aj.after_job_ids)"));
        assert!(clause.contains("earlier_turn.status in ('queued', 'leased')"));
    }

    #[test]
    fn a_run_names_the_runs_and_agents_it_waits_for() {
        let (first, second) = (Uuid::nil(), Uuid::max());
        let mut metadata = JsonMap::new();
        stamp_run(&mut metadata, &[(first, "a"), (second, "b")]);
        assert_eq!(
            metadata.get(RUN_KEY),
            Some(&json!({
                "version": 1,
                "after": [
                    { "runId": first, "agent": "a" },
                    { "runId": second, "agent": "b" },
                ],
            }))
        );
    }

    #[test]
    fn a_client_cannot_say_a_run_waits() {
        let mut metadata = json!({
            RUN_KEY: {"version": 1, "after": [{"runId": Uuid::nil(), "agent": "a"}]},
            "other": true,
        });
        strip_client_marks(&mut metadata);
        assert_eq!(metadata, json!({"other": true}));
        strip_client_marks(&mut JsonValue::Null);
    }
}
