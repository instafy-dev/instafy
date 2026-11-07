//! Pure policy shared by durable goal updates and continuation dispatch.
//! Callers enforce ownership, source-job/revision binding, and dispatch eligibility.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const MAX_CONTINUATIONS: u32 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GoalStatus {
    Active,
    Paused,
    Completed,
    Blocked,
    Canceled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Goal {
    pub id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub done_when: Option<String>,
    pub stop_when: Option<String>,
    pub progress_summary: Option<String>,
    pub parent_goal_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

// Match the client's nullish camelCase/snake_case fallback, not truthiness.
fn field<'a>(value: &'a Map<String, Value>, camel: &str, snake: &str) -> Option<&'a Value> {
    value
        .get(camel)
        .filter(|v| !v.is_null())
        .or_else(|| value.get(snake))
}

fn status(value: Option<&Value>) -> Option<GoalStatus> {
    match text(value)?.to_lowercase().as_str() {
        "active" => Some(GoalStatus::Active),
        "paused" => Some(GoalStatus::Paused),
        "completed" => Some(GoalStatus::Completed),
        "blocked" => Some(GoalStatus::Blocked),
        "canceled" => Some(GoalStatus::Canceled),
        _ => None,
    }
}

/// Normalize the persisted frontend contract. Unlike the UI, the controller must
/// not invent an ID when reading: a durable goal needs an existing stable identity.
pub(crate) fn normalize_goal(value: &Value, now: &str) -> Option<Goal> {
    let value = value.as_object()?;
    let created_at = text(field(value, "createdAt", "created_at")).unwrap_or_else(|| now.into());
    Some(Goal {
        id: text(value.get("id"))?,
        objective: text(value.get("objective"))?,
        status: status(value.get("status")).unwrap_or(GoalStatus::Active),
        done_when: text(field(value, "doneWhen", "done_when")),
        stop_when: text(field(value, "stopWhen", "stop_when")),
        progress_summary: text(field(value, "progressSummary", "progress_summary")),
        parent_goal_id: text(field(value, "parentGoalId", "parent_goal_id")),
        updated_at: text(field(value, "updatedAt", "updated_at"))
            .unwrap_or_else(|| created_at.clone()),
        created_at,
        created_by: text(field(value, "createdBy", "created_by")),
        updated_by: text(field(value, "updatedBy", "updated_by")),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GoalUpdate {
    Ignored,
    Set(Goal),
    Clear,
}

fn action_details(metadata: &Value) -> Option<&Map<String, Value>> {
    let metadata = metadata.as_object()?;
    let mut details = metadata
        .get("details")
        .and_then(Value::as_object)
        .unwrap_or(metadata);
    for _ in 0..3 {
        let Some(nested) = details.get("details").and_then(Value::as_object) else {
            break;
        };
        let wrapper = [
            "runtimeId",
            "runtime_id",
            "displayName",
            "display_name",
            "messageType",
            "message_type",
        ]
        .iter()
        .any(|key| details.get(*key).is_some_and(Value::is_string))
            || text(details.get("kind"))
                .is_some_and(|s| s.eq_ignore_ascii_case("runtime_selection"));
        if !wrapper {
            break;
        }
        details = nested;
    }
    Some(details)
}

/// Apply an already verified `goal_update` message. Authorization to create,
/// resume, replace, or clear a goal belongs to the caller, not the model payload.
pub(crate) fn apply_goal_update(
    current: Option<&Goal>,
    metadata: &Value,
    content: &str,
    new_goal_id: &str,
    now: &str,
    actor: Option<&str>,
) -> GoalUpdate {
    let empty = Map::new();
    let details = action_details(metadata).unwrap_or(&empty);
    let clear = ["operation", "op"]
        .iter()
        .any(|key| text(details.get(*key)).is_some_and(|s| s.eq_ignore_ascii_case("clear")));
    if clear {
        return if current.is_some() {
            GoalUpdate::Clear
        } else {
            GoalUpdate::Ignored
        };
    }
    let objective = text(details.get("objective"));
    let mut next = match current {
        Some(goal) => goal.clone(),
        None => {
            let Some(objective) = objective.as_ref() else {
                return GoalUpdate::Ignored;
            };
            if new_goal_id.trim().is_empty() {
                return GoalUpdate::Ignored;
            }
            Goal {
                id: new_goal_id.trim().into(),
                objective: objective.clone(),
                status: GoalStatus::Active,
                done_when: None,
                stop_when: None,
                progress_summary: None,
                parent_goal_id: None,
                created_at: now.into(),
                updated_at: now.into(),
                created_by: actor.map(str::to_owned),
                updated_by: actor.map(str::to_owned),
            }
        }
    };
    if let Some(objective) = objective {
        next.objective = objective;
    }
    if let Some(status) = status(details.get("status")) {
        next.status = status;
    }
    if let Some(done_when) = text(field(details, "doneWhen", "done_when")) {
        next.done_when = Some(done_when);
    }
    if let Some(stop_when) = text(field(details, "stopWhen", "stop_when")) {
        next.stop_when = Some(stop_when);
    }
    let content = Value::String(content.into());
    if let Some(progress) = text(
        field(details, "progressSummary", "progress_summary")
            .filter(|v| !v.is_null())
            .or(Some(&content)),
    ) {
        next.progress_summary = Some(progress);
    }
    next.updated_at = now.into();
    next.updated_by = actor.map(str::to_owned);
    if current == Some(&next) {
        GoalUpdate::Ignored
    } else {
        GoalUpdate::Set(next)
    }
}

/// Evidence from this goal's runs, ordered oldest to newest. The caller supplies
/// the latest three runs and the latest three text-bearing runs (which can differ).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RunEvidence {
    pub assistant_text: Option<String>,
    pub has_activity: bool,
    pub turn: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Stagnation {
    None,
    Warning {
        reason: &'static str,
        summary: &'static str,
    },
    Blocked {
        reason: &'static str,
        summary: &'static str,
    },
}

fn compact_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn assess_stagnation(turn_count: u32, recent: &[RunEvidence]) -> Stagnation {
    if turn_count < 3 {
        return Stagnation::None;
    }
    let texts: Vec<&str> = recent
        .iter()
        .rev()
        .filter_map(|run| run.assistant_text.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .take(3)
        .collect();
    let normalized: Vec<String> = texts
        .iter()
        .map(|text| compact_text(&text.to_lowercase()))
        .collect();
    let repeated_two = normalized.len() >= 2 && normalized[0] == normalized[1];
    if turn_count >= 5 && normalized.len() == 3 && repeated_two && normalized[1] == normalized[2] {
        return Stagnation::Blocked {
            reason: "repeated_assistant_output",
            summary: "Stopped because several automatic goal turns repeated the same assistant output without completing or blocking the goal.",
        };
    }
    if repeated_two {
        return Stagnation::Warning {
            reason: "repeated_assistant_output",
            summary: "Recent automatic goal turns look repetitive. The next turn should complete, block, or change strategy.",
        };
    }
    if turn_count >= 5
        && recent.len() >= 3
        && recent.iter().rev().take(3).all(|run| !run.has_activity)
        && texts.len() == 3
        && texts.iter().all(|text| text.encode_utf16().count() < 160)
    {
        return Stagnation::Warning {
            reason: "low_activity_continuations",
            summary: "The goal has used several automatic turns with little observable activity. The next turn should reassess the plan.",
        };
    }
    Stagnation::None
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ContinuationDecision {
    Continue {
        next_turn: u32,
        warning: Option<&'static str>,
    },
    Stop {
        reason: &'static str,
        summary: &'static str,
    },
}

/// Only evaluates goal policy. A Continue result does not authorize dispatch:
/// the caller still checks the terminal source run, access, revision, and deduplication.
pub(crate) fn decide_continuation(
    goal: &Goal,
    turn_count: u32,
    recent: &[RunEvidence],
) -> ContinuationDecision {
    if goal.status != GoalStatus::Active {
        return ContinuationDecision::Stop {
            reason: "inactive",
            summary: "The goal is not active.",
        };
    }
    if turn_count >= MAX_CONTINUATIONS {
        return ContinuationDecision::Stop {
            reason: "continuation_limit",
            summary: "Stopped after the automatic goal continuation turn limit.",
        };
    }
    match assess_stagnation(turn_count, recent) {
        Stagnation::Blocked { reason, summary } => ContinuationDecision::Stop { reason, summary },
        assessment => ContinuationDecision::Continue {
            next_turn: turn_count + 1,
            warning: match assessment {
                Stagnation::Warning { summary, .. } => Some(summary),
                _ => None,
            },
        },
    }
}

pub(crate) fn build_continuation_prompt(
    goal: &Goal,
    next_turn: u32,
    recent: &[RunEvidence],
    warning: Option<&str>,
) -> String {
    let mut lines = vec![
        format!("Continue the active goal: {}", goal.objective),
        format!("This is automatic goal continuation turn {next_turn} of {MAX_CONTINUATIONS}."),
    ];
    for (label, value) in [
        ("Done when", &goal.done_when),
        ("Stop when", &goal.stop_when),
        ("Latest checkpoint", &goal.progress_summary),
    ] {
        if let Some(value) = value {
            lines.push(format!("{label}: {value}"));
        }
    }
    let signals: Vec<_> = recent
        .iter()
        .filter(|run| {
            run.turn.is_some()
                || run.has_activity
                || run
                    .assistant_text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty())
        })
        .collect();
    let signals = &signals[signals.len().saturating_sub(3)..];
    if !signals.is_empty() {
        lines.push("\nRecent run evidence (historical observations):".into());
        for (index, run) in signals.iter().enumerate() {
            let label = run
                .turn
                .map(|turn| format!("turn {turn}"))
                .unwrap_or_else(|| format!("recent run {}", index + 1));
            let activity = if run.has_activity {
                "tool/file activity observed"
            } else {
                "no tool/file activity observed"
            };
            let result = run
                .assistant_text
                .as_deref()
                .map(compact_text)
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "no visible assistant result".into());
            let result = if result.chars().count() > 220 {
                format!("{}…", result.chars().take(220).collect::<String>())
            } else {
                result
            };
            lines.push(format!("- {label}: {activity}; assistant result: {result}"));
        }
    }
    if let Some(warning) = warning {
        lines.push(format!("\nGoal health warning: {warning}"));
    }
    lines.push("\nReview the checkpoint and evidence, then do meaningful remaining work without repeating completed work. Use available tools and project context to inspect, implement, or verify as needed. If recent work repeated or had little activity, change strategy before continuing.\nIf the goal is satisfied, emit a goal_update with status completed and the supporting evidence. If a required capability or resource is unavailable, unsafe, or unreachable, emit status blocked with the concrete blocker. Missing evidence alone is not a blocker: gather it when possible. Otherwise keep the goal active and record useful progress for the next turn, even when the goal needs work across multiple turns. Follow the goal's stop conditions and existing permissions.".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-11-05T12:00:00Z";
    fn goal() -> Goal {
        normalize_goal(
            &json!({"id": "goal-1", "objective": "Verify the change"}),
            NOW,
        )
        .unwrap()
    }
    fn evidence(text: &str) -> RunEvidence {
        RunEvidence {
            assistant_text: Some(text.into()),
            ..Default::default()
        }
    }

    #[test]
    fn normalizes_legacy_fields_without_inventing_identity() {
        let parsed = normalize_goal(&json!({"id":" goal-1 ", "objective":" Verify the change ", "status":" PAUSED ",
            "doneWhen":null, "done_when":" checked ", "created_at":"earlier", "created_by":"owner"}), NOW).unwrap();
        assert_eq!(parsed.status, GoalStatus::Paused);
        assert_eq!(parsed.done_when.as_deref(), Some("checked"));
        assert_eq!(parsed.updated_at, "earlier");
        let serialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(serialized["doneWhen"], "checked");
        assert_eq!(serialized["createdBy"], "owner");
        assert!(serialized.get("created_at").is_none());
        for malformed in [
            Value::Null,
            json!([]),
            json!({"objective":"x"}),
            json!({"id":"x", "objective":3}),
            json!({"id":" ", "objective":"x"}),
        ] {
            assert!(normalize_goal(&malformed, NOW).is_none());
        }
        assert_eq!(
            normalize_goal(&json!({"id":"x", "objective":"x", "status":"running"}), NOW)
                .unwrap()
                .status,
            GoalStatus::Active
        );
    }

    #[test]
    fn applies_wrapped_goal_updates_preserving_identity_and_optional_fields() {
        let metadata = json!({"details":{"runtimeId":"runtime", "details":{"messageType":"goal_update", "details":{
            "objective":"Verify the change", "done_when":"tests pass", "status":"paused"
        }}}});
        let GoalUpdate::Set(created) = apply_goal_update(
            None,
            &metadata,
            "Checking tests",
            "stable-id",
            NOW,
            Some("owner"),
        ) else {
            panic!("goal not created")
        };
        assert_eq!(created.id, "stable-id");
        assert_eq!(created.status, GoalStatus::Paused);
        assert_eq!(created.created_by.as_deref(), Some("owner"));
        assert_eq!(created.progress_summary.as_deref(), Some("Checking tests"));
        let GoalUpdate::Set(completed) = apply_goal_update(
            Some(&created),
            &json!({"status":"completed", "doneWhen":null}),
            "Tests passed",
            "unused",
            "later",
            None,
        ) else {
            panic!("goal not updated")
        };
        assert_eq!(completed.status, GoalStatus::Completed);
        assert_eq!(completed.id, created.id);
        assert_eq!(completed.created_at, created.created_at);
        assert_eq!(completed.done_when.as_deref(), Some("tests pass"));
        assert_eq!(completed.progress_summary.as_deref(), Some("Tests passed"));
        assert_eq!(
            apply_goal_update(
                Some(&completed),
                &json!({"op":"clear"}),
                "",
                "unused",
                NOW,
                None
            ),
            GoalUpdate::Clear
        );
        assert_eq!(
            apply_goal_update(None, &json!({"op":"clear"}), "", "unused", NOW, None),
            GoalUpdate::Ignored
        );
    }

    #[test]
    fn malformed_updates_cannot_supply_an_objective_or_terminal_status() {
        assert_eq!(
            apply_goal_update(
                None,
                &json!({"objective":{}, "status":"completed"}),
                "",
                "id",
                NOW,
                None
            ),
            GoalUpdate::Ignored
        );
        let mut paused = goal();
        paused.status = GoalStatus::Paused;
        assert_eq!(
            apply_goal_update(
                Some(&paused),
                &json!({"status":"complete", "objective":false}),
                "",
                "ignored",
                NOW,
                None
            ),
            GoalUpdate::Ignored
        );
        // Arbitrary nested details are not runtime envelopes.
        assert_eq!(
            apply_goal_update(
                Some(&paused),
                &json!({"details":{"details":{"status":"active"}}}),
                "",
                "ignored",
                NOW,
                None
            ),
            GoalUpdate::Ignored
        );
    }

    #[test]
    fn repeated_output_warns_before_blocking_and_normalizes_spacing_and_case() {
        let runs = [
            evidence("Checking  this"),
            RunEvidence::default(),
            evidence("CHECKING\nTHIS"),
            evidence("checking this"),
        ];
        assert_eq!(assess_stagnation(2, &runs), Stagnation::None);
        assert!(matches!(
            assess_stagnation(4, &runs),
            Stagnation::Warning {
                reason: "repeated_assistant_output",
                ..
            }
        ));
        assert!(matches!(
            decide_continuation(&goal(), 5, &runs),
            ContinuationDecision::Stop {
                reason: "repeated_assistant_output",
                ..
            }
        ));
        let mut progressing = runs.to_vec();
        progressing.push(RunEvidence {
            has_activity: true,
            ..evidence("Fixed and tested the remaining issue")
        });
        assert_eq!(assess_stagnation(6, &progressing), Stagnation::None);
    }

    #[test]
    fn low_activity_only_warns_and_uses_client_text_length_semantics() {
        let mut runs = vec![
            evidence("First inspection"),
            evidence("Another inspection"),
            evidence("Next inspection"),
        ];
        assert!(matches!(
            decide_continuation(&goal(), 5, &runs),
            ContinuationDecision::Continue {
                warning: Some(_),
                ..
            }
        ));
        runs[2] = evidence(&"🌕".repeat(80));
        assert_eq!(assess_stagnation(5, &runs), Stagnation::None);
    }

    #[test]
    fn inactive_goals_and_the_bound_stop_without_counter_overflow() {
        let mut goal = goal();
        for status in [
            GoalStatus::Paused,
            GoalStatus::Completed,
            GoalStatus::Blocked,
            GoalStatus::Canceled,
        ] {
            goal.status = status;
            assert!(matches!(
                decide_continuation(&goal, 0, &[]),
                ContinuationDecision::Stop {
                    reason: "inactive",
                    ..
                }
            ));
        }
        goal.status = GoalStatus::Active;
        assert_eq!(
            decide_continuation(&goal, 99, &[]),
            ContinuationDecision::Continue {
                next_turn: 100,
                warning: None
            }
        );
        for count in [100, u32::MAX] {
            assert!(matches!(
                decide_continuation(&goal, count, &[]),
                ContinuationDecision::Stop {
                    reason: "continuation_limit",
                    ..
                }
            ));
        }
    }

    #[test]
    fn continuation_carries_checkpoint_and_bounded_recent_evidence() {
        let mut goal = goal();
        goal.done_when = Some("The regression passes".into());
        goal.stop_when = Some("Access is revoked".into());
        goal.progress_summary = Some("Root cause found".into());
        let runs = [
            evidence("Old observation"),
            evidence("First recent"),
            evidence("Second recent"),
            evidence(&"x".repeat(300)),
        ];
        let prompt = build_continuation_prompt(&goal, 6, &runs, Some("Reassess progress"));
        for expected in [
            "Verify the change",
            "6 of 100",
            "The regression passes",
            "Access is revoked",
            "Root cause found",
            "First recent",
            "Reassess progress",
            "status completed",
            "status blocked",
        ] {
            assert!(prompt.contains(expected), "missing {expected}");
        }
        assert!(!prompt.contains("Old observation"));
        assert!(!prompt.contains(&"x".repeat(221)));
    }
}
