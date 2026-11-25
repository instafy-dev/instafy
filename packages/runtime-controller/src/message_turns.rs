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

/// The words that, ending an agent's part of a message or opening the next
/// agent's, ask for the next agent's turn after the earlier ones: "@alpha
/// write a poem, then @beta translate it" (11.23, D58). Lowercase, each a
/// whole word or words.
const FOLLOW_ON_WORDS: [&str; 20] = [
    "then",
    "and then",
    "afterwards",
    "and afterwards",
    "afterward",
    "after that",
    "and after that",
    "after this",
    "once done",
    "once that's done",
    "once that is done",
    "once it's done",
    "once it is done",
    "once finished",
    "when done",
    "when that's done",
    "when that is done",
    "when it's done",
    "when it is done",
    "when finished",
];

/// Whether `text` ends with one of [`FOLLOW_ON_WORDS`] as whole words,
/// ignoring case and the commas, colons and spaces after it; the length of
/// `text` before them when it does.
fn follow_on_ending(text: &str) -> Option<usize> {
    let trimmed = text.trim_end_matches(|character: char| {
        character.is_whitespace() || matches!(character, ',' | ':' | ';')
    });
    let lower = trimmed.to_lowercase();
    // Lowercasing an ASCII word keeps its length, so a match's start in
    // `lower` is its start in `trimmed`.
    FOLLOW_ON_WORDS
        .iter()
        .filter(|words| lower.ends_with(**words) && trimmed.len() >= words.len())
        .map(|words| (trimmed.len() - words.len(), *words))
        .filter(|(start, words)| {
            trimmed.is_char_boundary(*start) && trimmed[*start..].eq_ignore_ascii_case(words)
        })
        .map(|(start, _)| start)
        .filter(|start| {
            trimmed[..*start]
                .chars()
                .next_back()
                .is_none_or(|before| !before.is_alphanumeric() && before != '\'')
        })
        .min()
}

/// Whether the person's words ask for an agent's turn after the turns of the
/// agents named before it (11.23, D58): the part before its mention ends
/// with "then", "after that", "once that's done" and the like, or its own
/// part opens with "then", "next" or "afterwards", as in "@alpha write a
/// poem, then @beta translate it" or "@beta then translate it". Such a turn
/// waits for the earlier ones whatever its AI, so it starts from what they
/// left.
pub(crate) fn follows_on(words_before: &str, own_words: &str) -> bool {
    if follow_on_ending(words_before).is_some() {
        return true;
    }
    let opening = own_words.trim_start().to_lowercase();
    [
        "then",
        "next",
        "afterwards",
        "afterward",
        "after that",
        "after this",
    ]
    .iter()
    .any(|words| {
        opening.starts_with(words)
            && opening[words.len()..]
                .chars()
                .next()
                .is_none_or(|after| !after.is_alphanumeric())
    })
}

/// `part`, an agent's part of a message, without the "then" or "after that"
/// that ends it and asks for the next agent's turn after it ([`follows_on`]),
/// and the comma before it: those words are the next agent's, and an agent
/// handed "write a poem, then" asks what it should do next.
pub(crate) fn without_follow_on_ending(part: &str) -> &str {
    match follow_on_ending(part) {
        Some(end) => part[..end].trim_end_matches(|character: char| {
            character.is_whitespace() || matches!(character, ',' | ';' | '-')
        }),
        None => part,
    }
}

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
    fn then_asks_for_a_turn_after_the_earlier_ones() {
        for (before, own) in [
            (
                "@alpha write a poem into poem.txt, then",
                "translate poem.txt",
            ),
            ("@alpha write a poem. Then", "translate it"),
            ("@alpha write a poem and then", "translate it"),
            ("@alpha write a poem; after that,", "translate it"),
            ("@alpha write a poem, once that's done", "translate it"),
            ("@alpha write a poem. When it is done:", "translate it"),
            ("@alpha write a poem,", "then translate it"),
            ("@alpha write a poem,", "Next, translate it"),
            ("@alpha write a poem,", "afterwards translate it"),
        ] {
            assert!(follows_on(before, own), "{before:?} {own:?}");
        }
        for (before, own) in [
            ("@alpha write a poem,", "translate the README"),
            (
                "@alpha refactor it and then run the tests,",
                "update the docs",
            ),
            ("@alpha fix the strength of the bridge,", "write the docs"),
            ("@alpha lengthen the intro,", "write the docs"),
            ("@alpha lengthen", "write the docs"),
            ("@alpha add a next button,", "add a back button"),
            ("@alpha write a poem,", "thenceforth do nothing"),
            ("@alpha read what's next,", "summarize it"),
        ] {
            assert!(!follows_on(before, own), "{before:?} {own:?}");
        }
    }

    #[test]
    fn an_agents_part_loses_the_then_that_was_the_next_agents() {
        assert_eq!(
            without_follow_on_ending("@alpha write a poem into poem.txt, then"),
            "@alpha write a poem into poem.txt"
        );
        assert_eq!(
            without_follow_on_ending("@alpha write a poem. Then"),
            "@alpha write a poem."
        );
        assert_eq!(
            without_follow_on_ending("@alpha write a poem and after that,"),
            "@alpha write a poem"
        );
        assert_eq!(
            without_follow_on_ending("@alpha write a poem, once that's done"),
            "@alpha write a poem"
        );
        assert_eq!(
            without_follow_on_ending("@alpha fix the strength"),
            "@alpha fix the strength"
        );
        assert_eq!(
            without_follow_on_ending("@alpha write a poem,"),
            "@alpha write a poem,"
        );
    }

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
