//! A team answers within its time budget.
//!
//! A person who asks for a team's work waits for one answer. Each of the team's turns has its own
//! limit and wrap-up, but a team adds them up: lanes, a follow-on agent that continues in a second
//! and third turn, and a lead that may start more agents at its checkpoint. One itinerary team
//! answered after 19 minutes because its builder continued, and another lead started a new builder
//! after 13 minutes that was still at work when the person had stopped waiting.
//!
//! So a plan may declare how long its team has (`timeBudgetMinutes` or `timeBudgetSeconds`, from
//! its skill). The team then keeps one clock, started when the controller accepts the plan:
//! `teamClock` in `metadata.multiAgentPlan` of every job of the team (its lanes, follow-on agent,
//! their continuations and retries, its lead checkpoints, and any agents a lead starts again),
//! with the deadline `startedAt + budgetSeconds`. A plan that declares none has no clock. An
//! operator can cap every team with `INSTAFY_TEAM_TIME_BUDGET_SECONDS` (it then also applies to
//! plans that declare none), or turn clocks off with 0.
//!
//! - The runtime ends each turn of the team by its deadline: a turn's hard limit is the time left
//!   (at least [`MIN_TEAM_TURN`], at most the usual limit), with its wrap-up before it, and a turn
//!   that leaves no room for another is told to finish rather than leave a note for a next turn.
//!   It counts from the time left the controller states at lease (`leftSecondsAtLease`), not from
//!   its own clock.
//! - No plan agent starts once less than [`MIN_TEAM_TURN`] is left, however it was queued (a lane
//!   that waited for its upstream, a retry, a continuation, the follow-on agent): the lease passes
//!   it over and the idle sweep settles it as not started, so the lead's checkpoint comes with
//!   that outcome. The controller also starts no further turn then.
//! - A lead checkpoint that comes when less than that is left is told to report what is ready and
//!   what is unfinished or not started, and not to start more agents. Any it starts anyway keep
//!   the team's clock.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::time::Duration;

pub(crate) const TEAM_CLOCK_KEY: &str = "teamClock";
const BUDGET_ENV: &str = "INSTAFY_TEAM_TIME_BUDGET_SECONDS";
/// The longest budget a plan may declare.
pub(crate) const MAX_DECLARED_BUDGET: Duration = Duration::from_secs(4 * 60 * 60);
/// The shortest turn worth starting, and the shortest the runtime gives a turn of a team whose
/// time is up (the runtime's `MIN_TEAM_TURN` is the same).
pub(crate) const MIN_TEAM_TURN: Duration = Duration::from_secs(180);

/// A team's clock: when its request started it, and how long it has.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TeamClock {
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) budget: Duration,
}

impl TeamClock {
    pub(crate) fn deadline(&self) -> DateTime<Utc> {
        self.started_at + chrono::Duration::from_std(self.budget).unwrap_or_default()
    }

    /// The time left at `now`; zero once the deadline has passed.
    pub(crate) fn left(&self, now: DateTime<Utc>) -> Duration {
        (self.deadline() - now).to_std().unwrap_or_default()
    }

    pub(crate) fn to_json(&self) -> JsonValue {
        let format = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Secs, true);
        json!({
            "startedAt": format(self.started_at),
            "budgetSeconds": self.budget.as_secs(),
            "deadlineAt": format(self.deadline()),
            // what the lease and the idle sweep compare in SQL
            "deadlineEpoch": self.deadline().timestamp(),
        })
    }

    fn from_json(value: &JsonValue) -> Option<Self> {
        let started_at = value
            .get("startedAt")
            .and_then(JsonValue::as_str)
            .and_then(|text| DateTime::parse_from_rfc3339(text).ok())?
            .with_timezone(&Utc);
        let budget = Duration::from_secs(value.get("budgetSeconds").and_then(JsonValue::as_u64)?);
        (!budget.is_zero()).then_some(Self { started_at, budget })
    }

    /// The clock in a plan job's `multiAgentPlan` metadata.
    pub(crate) fn from_plan_meta(plan_meta: &JsonMap<String, JsonValue>) -> Option<Self> {
        plan_meta.get(TEAM_CLOCK_KEY).and_then(Self::from_json)
    }

    /// The clock of the team a job belongs to, if it is one's.
    pub(crate) fn from_payload(payload: &JsonValue) -> Option<Self> {
        payload
            .pointer("/metadata/multiAgentPlan")
            .and_then(JsonValue::as_object)
            .and_then(Self::from_plan_meta)
    }
}

/// What the operator set for team budgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperatorBudget {
    /// Nothing: a team has the budget its plan declares, if any.
    Unset,
    /// No team has a clock.
    Off,
    /// No team has more than this; a plan that declares none has this.
    Cap(Duration),
}

fn parse_operator_budget(value: Option<&str>) -> OperatorBudget {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => OperatorBudget::Unset,
        Some(value) => match value.parse::<u64>() {
            Ok(0) => OperatorBudget::Off,
            Ok(seconds) => OperatorBudget::Cap(Duration::from_secs(seconds)),
            Err(_) => OperatorBudget::Unset,
        },
    }
}

fn resolve_budget(declared: Option<Duration>, operator: OperatorBudget) -> Option<Duration> {
    match operator {
        OperatorBudget::Off => None,
        OperatorBudget::Unset => declared,
        OperatorBudget::Cap(cap) => Some(declared.map_or(cap, |declared| declared.min(cap))),
    }
}

/// The budget of a new team whose plan declared `declared`, within what the operator set.
pub(crate) fn team_budget(declared: Option<Duration>) -> Option<Duration> {
    resolve_budget(
        declared,
        parse_operator_budget(std::env::var(BUDGET_ENV).ok().as_deref()),
    )
}

/// The budget a plan declares: `timeBudgetMinutes` or `timeBudgetSeconds`, a positive number up
/// to [`MAX_DECLARED_BUDGET`].
pub(crate) fn declared_budget(plan: &JsonMap<String, JsonValue>) -> Option<Duration> {
    let number = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| plan.get(*key).and_then(JsonValue::as_f64))
            .filter(|value| value.is_finite() && *value > 0.0)
    };
    let seconds = number(&["timeBudgetSeconds", "time_budget_seconds"]).or_else(|| {
        number(&["timeBudgetMinutes", "time_budget_minutes"]).map(|minutes| minutes * 60.0)
    })?;
    Some(
        Duration::from_secs_f64(seconds.min(MAX_DECLARED_BUDGET.as_secs_f64()))
            .max(Duration::from_secs(1)),
    )
}

/// The clock of the agents a plan starts: the one of the team whose lead wrote the plan, else a
/// new one from when the controller accepted the plan.
pub(crate) fn for_new_plan(
    planner_payload: &JsonValue,
    accepted_at: DateTime<Utc>,
    budget: Option<Duration>,
) -> Option<TeamClock> {
    TeamClock::from_payload(planner_payload).or_else(|| {
        budget.map(|budget| TeamClock {
            started_at: accepted_at,
            budget,
        })
    })
}

/// A job row (alias `alias`) of a team with less than [`MIN_TEAM_TURN`] left: no plan agent of it
/// starts. A job without a clock never matches.
pub(crate) fn out_of_time_sql(alias: &str) -> String {
    let path = "'{metadata,multiAgentPlan,teamClock,deadlineEpoch}'";
    format!(
        "coalesce(jsonb_typeof({alias}.payload #> {path}) = 'number'
          and ({alias}.payload #>> {path})::numeric
              < extract(epoch from statement_timestamp()) + {}, false)",
        MIN_TEAM_TURN.as_secs()
    )
}

/// What a lease hands the runtime: the team's time left as the controller counts it, so a runtime
/// whose clock is off still ends the turn by the team's deadline.
pub(crate) fn stamp_left_at_lease(payload: &mut JsonValue, leased_at: DateTime<Utc>) {
    let Some(clock) = TeamClock::from_payload(payload) else {
        return;
    };
    if let Some(entry) = payload
        .pointer_mut("/metadata/multiAgentPlan/teamClock")
        .and_then(JsonValue::as_object_mut)
    {
        entry.insert(
            "leftSecondsAtLease".to_string(),
            json!((clock.deadline() - leased_at).num_seconds().max(0)),
        );
    }
}

/// Put `clock` into dispatch `metadata.multiAgentPlan`.
pub(crate) fn stamp(metadata: &mut JsonValue, clock: Option<&TeamClock>) {
    if let (Some(clock), Some(plan)) = (
        clock,
        metadata
            .get_mut("multiAgentPlan")
            .and_then(JsonValue::as_object_mut),
    ) {
        plan.insert(TEAM_CLOCK_KEY.to_string(), clock.to_json());
    }
}

/// Carry the team's clock from a plan job's metadata into the dispatch metadata of the next job.
pub(crate) fn carry(metadata: &mut JsonValue, plan_meta: &JsonMap<String, JsonValue>) {
    stamp(metadata, TeamClock::from_plan_meta(plan_meta).as_ref());
}

/// Whether a further turn of an agent of this team is worth starting at `now`: always without a
/// clock.
pub(crate) fn room_for_another_turn(
    plan_meta: &JsonMap<String, JsonValue>,
    now: DateTime<Utc>,
) -> bool {
    TeamClock::from_plan_meta(plan_meta).is_none_or(|clock| clock.left(now) >= MIN_TEAM_TURN)
}

/// What a lead checkpoint is told when its team's time is (nearly) up.
pub(crate) fn lead_note(
    plan_meta: &JsonMap<String, JsonValue>,
    now: DateTime<Utc>,
) -> Option<String> {
    let clock = TeamClock::from_plan_meta(plan_meta)?;
    if clock.left(now) >= MIN_TEAM_TURN {
        return None;
    }
    let minutes = ((clock.budget.as_secs() + 30) / 60).max(1);
    let state = if clock.left(now).is_zero() {
        "has run out"
    } else {
        "is nearly spent"
    };
    Some(format!(
        "\n\nFrom the controller: the team's time budget ({minutes} minutes) {state}. Answer now with what is ready, and list what is unfinished or not started. Do not start more agents."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).expect("time")
    }

    fn meta(clock: &TeamClock) -> JsonMap<String, JsonValue> {
        let mut metadata = json!({"multiAgentPlan": {"groupId": "g"}});
        stamp(&mut metadata, Some(clock));
        metadata["multiAgentPlan"]
            .as_object()
            .cloned()
            .expect("plan")
    }

    #[test]
    fn a_team_has_the_budget_its_plan_declares_within_what_the_operator_set() {
        let minutes = |n: u64| Duration::from_secs(n * 60);
        let plan = |value: JsonValue| value.as_object().cloned().expect("plan");
        assert_eq!(
            declared_budget(&plan(json!({"timeBudgetMinutes": 12}))),
            Some(minutes(12))
        );
        assert_eq!(
            declared_budget(&plan(json!({"timeBudgetSeconds": 90}))),
            Some(Duration::from_secs(90))
        );
        assert_eq!(
            declared_budget(&plan(json!({"timeBudgetMinutes": 10_000}))),
            Some(MAX_DECLARED_BUDGET)
        );
        for none in [
            json!({}),
            json!({"timeBudgetMinutes": 0}),
            json!({"timeBudgetMinutes": "soon"}),
        ] {
            assert_eq!(declared_budget(&plan(none.clone())), None, "{none}");
        }
        // nothing set by the operator: only a plan that declares one has a clock
        let unset = parse_operator_budget(None);
        assert_eq!(unset, OperatorBudget::Unset);
        assert_eq!(parse_operator_budget(Some(" ")), OperatorBudget::Unset);
        assert_eq!(parse_operator_budget(Some("soon")), OperatorBudget::Unset);
        assert_eq!(resolve_budget(Some(minutes(12)), unset), Some(minutes(12)));
        assert_eq!(resolve_budget(None, unset), None);
        // an operator cap holds for every team; 0 turns clocks off
        let cap = parse_operator_budget(Some("600"));
        assert_eq!(cap, OperatorBudget::Cap(minutes(10)));
        assert_eq!(resolve_budget(Some(minutes(12)), cap), Some(minutes(10)));
        assert_eq!(resolve_budget(Some(minutes(5)), cap), Some(minutes(5)));
        assert_eq!(resolve_budget(None, cap), Some(minutes(10)));
        assert_eq!(
            resolve_budget(Some(minutes(12)), parse_operator_budget(Some("0"))),
            None
        );
    }

    #[test]
    fn a_lease_states_the_time_left_by_the_controllers_clock() {
        let clock = TeamClock {
            started_at: at(0),
            budget: Duration::from_secs(780),
        };
        let mut payload = json!({"metadata": {"multiAgentPlan": {"role": "worker"}}});
        stamp(&mut payload["metadata"], Some(&clock));
        stamp_left_at_lease(&mut payload, at(500));
        assert_eq!(
            payload["metadata"]["multiAgentPlan"][TEAM_CLOCK_KEY]["leftSecondsAtLease"],
            json!(280)
        );
        assert_eq!(
            payload["metadata"]["multiAgentPlan"][TEAM_CLOCK_KEY]["deadlineEpoch"],
            json!(at(780).timestamp())
        );
        stamp_left_at_lease(&mut payload, at(900));
        assert_eq!(
            payload["metadata"]["multiAgentPlan"][TEAM_CLOCK_KEY]["leftSecondsAtLease"],
            json!(0)
        );
        let mut without = json!({"metadata": {}});
        stamp_left_at_lease(&mut without, at(500));
        assert_eq!(without, json!({"metadata": {}}));
    }

    #[test]
    fn a_plan_keeps_its_leads_clock_or_starts_one_when_it_is_accepted() {
        let clock = TeamClock {
            started_at: at(0),
            budget: Duration::from_secs(780),
        };
        let mut lead = json!({"metadata": {"multiAgentPlan": {"role": "lead_continuation"}}});
        stamp(&mut lead["metadata"], Some(&clock));
        // a lead that plans again keeps the team's clock, whatever the budget is now
        assert_eq!(
            for_new_plan(&lead, at(700), Some(Duration::from_secs(3_600))),
            Some(clock.clone())
        );
        assert_eq!(for_new_plan(&lead, at(700), None), Some(clock));
        // a new request starts a new clock, unless the deployment turned it off
        let root = json!({"metadata": {}});
        assert_eq!(
            for_new_plan(&root, at(5), Some(Duration::from_secs(780))),
            Some(TeamClock {
                started_at: at(5),
                budget: Duration::from_secs(780)
            })
        );
        assert_eq!(for_new_plan(&root, at(5), None), None);
    }

    #[test]
    fn the_clock_reads_back_from_the_metadata_with_its_deadline() {
        let clock = TeamClock {
            started_at: at(0),
            budget: Duration::from_secs(780),
        };
        let plan = meta(&clock);
        assert_eq!(
            plan[TEAM_CLOCK_KEY]["deadlineAt"],
            json!(at(780).to_rfc3339_opts(SecondsFormat::Secs, true))
        );
        assert_eq!(TeamClock::from_plan_meta(&plan), Some(clock.clone()));
        let mut next = json!({"multiAgentPlan": {"groupId": "g"}});
        carry(&mut next, &plan);
        assert_eq!(next["multiAgentPlan"][TEAM_CLOCK_KEY], plan[TEAM_CLOCK_KEY]);
        let mut without = json!({"multiAgentPlan": {}});
        carry(&mut without, &JsonMap::new());
        assert!(without["multiAgentPlan"].get(TEAM_CLOCK_KEY).is_none());
    }

    #[test]
    fn no_further_turn_and_a_report_now_once_less_than_a_turn_is_left() {
        let clock = TeamClock {
            started_at: at(0),
            budget: Duration::from_secs(780),
        };
        let plan = meta(&clock);
        assert!(room_for_another_turn(&plan, at(600)));
        assert_eq!(lead_note(&plan, at(600)), None);
        assert!(!room_for_another_turn(&plan, at(601)));
        let nearly = lead_note(&plan, at(700)).expect("nearly spent");
        assert!(
            nearly.contains("time budget (13 minutes) is nearly spent"),
            "{nearly}"
        );
        assert!(
            nearly.contains("list what is unfinished or not started")
                && nearly.contains("Do not start more agents"),
            "{nearly}"
        );
        assert!(lead_note(&plan, at(900))
            .expect("spent")
            .contains("(13 minutes) has run out"));
        // a team without a clock is never cut short
        assert!(room_for_another_turn(&JsonMap::new(), at(100_000)));
        assert_eq!(lead_note(&JsonMap::new(), at(100_000)), None);
    }
}
