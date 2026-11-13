//! Local-engine turns ("the lane", docs/Local-Engine-Turns.md): the codes the runtime writes,
//! the controller keeps and Studio words, named once.
//!
//! runtime-agent's `NotReadyReason` and `FailureCode`, the controller's lists and Studio's
//! sentence tables are each a copy of these lists. `claude_code_lane_fixtures.json` holds the
//! same lists and one lane job's payload as the controller builds it, and each side's tests
//! compare their copy with it: the controller's payload builder and runtime-agent's
//! `LaneJob::of` with the payload, Studio's tables (`runtimes.ts`, `claudeCodeCopy.ts`,
//! `claudeCodeTurnPresentation.ts`) with the lists. A code or a payload key changed on one
//! side fails a test there instead of every turn.

/// Why a runtime's Claude Code cannot take a turn: the `reason` of a not-ready `claudeCode`
/// capability (3.2, 2.10). The controller keeps only these, and Studio has a sentence for each.
/// A turn whose own probe finds one fails with it as its code, so each is also one of
/// [`RUNTIME_FAILURE_CODES`].
pub const NOT_READY_REASONS: [&str; 5] = [
    "binary_missing",
    "binary_unsafe",
    "probe_failed",
    "unsupported_version",
    "bare_default",
];

/// The codes of a lane turn's `claude-code/failure` artifact that the controller copies onto
/// its failure message as `claudeCodeFailure` (2.6): the rows of 5.5's table above
/// `claude_code_turn_not_allowed`, in its order. The controller leaves any other code off, and
/// Studio words such a failure as one with no code.
pub const RUNTIME_FAILURE_CODES: [&str; 16] = [
    "not_signed_in",
    "plan_limit",
    "binary_missing",
    "binary_unsafe",
    "unsupported_version",
    "probe_failed",
    "bare_default",
    "session_unavailable",
    "turn_timeout",
    "stalled",
    "crashed",
    "unexpected_configuration",
    "project_config",
    "unsafe_import",
    "unsafe_link",
    "preflight_failed",
];

/// The `claudeCodeFailure` of a lane turn that a runtime stop failed: the computer's Instafy
/// stopped while the turn ran or before it started (2.9).
pub const MACHINE_STOPPED: &str = "claude_code_machine_stopped";
/// The `claudeCodeFailure` of a lane turn that the run-once sweep failed because nothing started
/// it within its minute (2.9). The sweep gives every run-once job it fails so this `kind`.
pub const START_BY_PASSED: &str = "start_by_passed";
/// The `claudeCodeFailure` of a lane turn whose lease ended while it ran, which never runs again
/// (2.9). The sweeps give every run-once job they fail so this `kind`.
pub const RUN_ONCE_INTERRUPTED: &str = "run_once_interrupted";
/// The codes the controller itself writes as a lane turn's `claudeCodeFailure`, a runtime
/// stop's and the sweeps' (2.9, 5.5). None of them is copied from a runtime's artifact.
pub const STOP_AND_SWEEP_FAILURE_CODES: [&str; 3] =
    [MACHINE_STOPPED, START_BY_PASSED, RUN_ONCE_INTERRUPTED];

#[cfg(test)]
mod tests {
    use super::{NOT_READY_REASONS, RUNTIME_FAILURE_CODES, STOP_AND_SWEEP_FAILURE_CODES};
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("claude_code_lane_fixtures.json")).expect("fixtures")
    }

    fn codes<'a>(fixtures: &'a Value, key: &str) -> Vec<&'a str> {
        fixtures[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixtures list {key}"))
            .iter()
            .map(|code| code.as_str().expect("a code"))
            .collect()
    }

    #[test]
    fn the_lists_are_the_fixtures() {
        let fixtures = fixtures();
        assert_eq!(codes(&fixtures, "notReadyReasons"), NOT_READY_REASONS);
        assert_eq!(
            codes(&fixtures, "runtimeFailureCodes"),
            RUNTIME_FAILURE_CODES
        );
        assert_eq!(
            codes(&fixtures, "stopAndSweepFailureCodes"),
            STOP_AND_SWEEP_FAILURE_CODES
        );
    }

    #[test]
    fn a_not_ready_reason_is_a_runtime_failure_code_and_no_code_is_listed_twice() {
        // A turn whose own probe says not ready fails with the reason as its code.
        for reason in NOT_READY_REASONS {
            assert!(RUNTIME_FAILURE_CODES.contains(&reason), "{reason}");
        }
        // A runtime's code is never one only the controller writes, so a runtime cannot make
        // its failure read as a stop or a sweep.
        let mut every: Vec<&str> = RUNTIME_FAILURE_CODES
            .iter()
            .chain(STOP_AND_SWEEP_FAILURE_CODES.iter())
            .copied()
            .collect();
        let listed = every.len();
        every.sort_unstable();
        every.dedup();
        assert_eq!(every.len(), listed, "a code is listed twice");
    }

    #[test]
    fn the_lane_job_payload_carries_placeholders_for_its_ids() {
        let fixtures = fixtures();
        let payload = &fixtures["laneJobPayload"];
        for (pointer, placeholder) in [
            ("/project_id", "<project_id>"),
            ("/user_id", "<user_id>"),
            ("/conversation_id", "<conversation_id>"),
            ("/targetThreadId", "<conversation_id>"),
            ("/prompt_id", "<prompt_id>"),
            ("/run_id", "<run_id>"),
            ("/metadata/agent/id", "<agent_id>"),
            ("/metadata/runtimePreference/runtimeId", "<runtime_id>"),
        ] {
            assert_eq!(
                payload.pointer(pointer).and_then(Value::as_str),
                Some(placeholder),
                "{pointer}"
            );
        }
    }
}
