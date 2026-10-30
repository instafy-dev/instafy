//! A run's own instructions, on a fresh thread and on a resumed one.
//!
//! Why: a chat's turns share one Codex thread, and each later turn resumes it from its rollout.
//! Codex puts a config's `developer_instructions` only into a thread's initial context, so a
//! resumed thread kept the text of the run that started it: a browser turn that resumed the
//! chat's default thread never read the browser policy, and an ordinary turn after a browser
//! turn still read a browser policy for tools it no longer had.
//!
//! What: a run's developer text (its lane's contract, then its browser policies) is a World
//! State section of its own. Codex sends it with the thread's initial context, then again only
//! when it changes: a run whose text differs from the one the thread last read sends its own
//! text once, saying that it replaces every earlier one, and a run whose text is the same sends
//! nothing, so the thread's cached prompt stays as it was. A note for one turn only (such as a
//! page another chat left open) is a second section, sent with its turn and withdrawn on the
//! thread's next turn without one. Both are developer messages, as the text they replace was,
//! and only a whole developer message part with a section's tags is taken for one of its
//! blocks: never text that a person or a page writes.
//!
//! A [`RunInstructionsContext`] holds one run's text, so it belongs to that attempt's
//! `ThreadManager`: a manager reused across runs would need a new one for each run.

use std::sync::Arc;

use codex_extension_api::{
    ContextContributor, ExtensionFuture, PreviousWorldStateSection, RenderedWorldStateFragment,
    WorldStateContributionInput, WorldStateSectionContribution,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const RUN_SECTION_ID: &str = "instafy_run_instructions";
const RUN_OPEN: &str = "<instafy_run_instructions>\n";
const RUN_CLOSE: &str = "\n</instafy_run_instructions>";
const NOTE_SECTION_ID: &str = "instafy_turn_notes";
const NOTE_OPEN: &str = "<instafy_turn_notes>\n";
const NOTE_CLOSE: &str = "\n</instafy_turn_notes>";

/// Opens a run's text on a thread that already read other run instructions.
const REPLACE: &str = "These run instructions replace all run instructions given earlier in this conversation, including the ones it started with. All other instructions still apply.";
/// Sent when a run has no text of its own on a thread that read some.
const WITHDRAW: &str = "Run instructions given earlier in this conversation no longer apply.";
const NOTE_REPLACE: &str = "This note replaces any earlier turn note in this conversation.";
const NOTE_FOR_THIS_TURN: &str = "For this turn only:";
const NOTE_WITHDRAW: &str = "Earlier turn notes in this conversation no longer apply.";

/// How each lane's developer text began on threads started before run instructions were a
/// section of their own: untagged, at the start of a thread's first developer message. Such a
/// thread is given its run's text once more, saying that it replaces the earlier text. Frozen:
/// it holds every heading a lane's text has had, and a lane whose heading changes adds its new
/// heading and keeps the old one here.
pub(super) const LEGACY_LANE_HEADINGS: &[&str] = &[
    "Instafy Studio structured execution run:",
    "Instafy Studio focused execution run:",
    "Instafy Studio workspace task:",
    "Browser/UI execution run:",
    "MCP-focused run:",
    "Granted device turn:",
    // The workspace task's heading before it was renamed.
    "Instafy Studio workspace-change run:",
];

/// What one run tells the model beyond its base instructions.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RunInstructions {
    /// The run's developer text: its lane's contract, then its browser policies.
    pub(crate) policy: String,
    /// Holds for this turn only; the thread's next turn without one withdraws it.
    pub(crate) turn_note: Option<String>,
}

/// Gives each turn its run's instructions through Codex's World State (see the module doc).
pub(super) struct RunInstructionsContext {
    policy: Option<Arc<str>>,
    policy_snapshot: Value,
    turn_note: Option<Arc<str>>,
    turn_note_snapshot: Value,
}

impl RunInstructionsContext {
    pub(super) fn new(run: &RunInstructions) -> Self {
        let policy = Some(run.policy.as_str()).filter(|policy| !policy.is_empty());
        let turn_note = run.turn_note.as_deref().filter(|note| !note.is_empty());
        Self {
            policy_snapshot: snapshot(policy),
            policy: policy.map(Arc::from),
            turn_note_snapshot: snapshot(turn_note),
            turn_note: turn_note.map(Arc::from),
        }
    }

    fn sections(&self) -> Vec<WorldStateSectionContribution> {
        vec![self.run_section(), self.turn_note_section()]
    }

    fn run_section(&self) -> WorldStateSectionContribution {
        let policy = self.policy.clone();
        let current = self.policy_snapshot.clone();
        WorldStateSectionContribution::new(
            RUN_SECTION_ID,
            self.policy_snapshot.clone(),
            move |previous| {
                let had_text = match previous {
                    PreviousWorldStateSection::Known(previous) if previous == &current => {
                        return None;
                    }
                    PreviousWorldStateSection::Known(previous) => Some(has_revision(previous)),
                    PreviousWorldStateSection::Unknown => Some(true),
                    PreviousWorldStateSection::Absent => None,
                };
                let body = match (policy.as_deref(), had_text) {
                    (Some(policy), None) => policy.to_string(),
                    (Some(policy), Some(_)) => format!("{REPLACE}\n\n{policy}"),
                    (None, Some(true)) => WITHDRAW.to_string(),
                    (None, _) => return None,
                };
                Some(RenderedWorldStateFragment::new(
                    "developer",
                    (RUN_OPEN, RUN_CLOSE),
                    body,
                ))
            },
        )
        .with_retained_fragment_matcher(is_run_block)
        .with_legacy_matcher(|role, text| {
            is_run_block(role, text) || is_legacy_run_text(role, text)
        })
    }

    fn turn_note_section(&self) -> WorldStateSectionContribution {
        let note = self.turn_note.clone();
        let current = self.turn_note_snapshot.clone();
        WorldStateSectionContribution::new(
            NOTE_SECTION_ID,
            self.turn_note_snapshot.clone(),
            move |previous| {
                let had_note = match previous {
                    PreviousWorldStateSection::Known(previous) if previous == &current => {
                        return None;
                    }
                    PreviousWorldStateSection::Known(previous) => has_revision(previous),
                    PreviousWorldStateSection::Unknown => true,
                    PreviousWorldStateSection::Absent => false,
                };
                let body = match (note.as_deref(), had_note) {
                    (Some(note), true) => format!("{NOTE_REPLACE}\n{NOTE_FOR_THIS_TURN}\n{note}"),
                    (Some(note), false) => format!("{NOTE_FOR_THIS_TURN}\n{note}"),
                    (None, true) => NOTE_WITHDRAW.to_string(),
                    (None, false) => return None,
                };
                Some(RenderedWorldStateFragment::new(
                    "developer",
                    (NOTE_OPEN, NOTE_CLOSE),
                    body,
                ))
            },
        )
        .with_retained_fragment_matcher(is_turn_note_block)
        .with_legacy_matcher(is_turn_note_block)
    }
}

impl ContextContributor for RunInstructionsContext {
    fn contribute_world_state<'a>(
        &'a self,
        _input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move { self.sections() })
    }
}

/// A section's comparison state: a digest of its text, never the text itself.
fn snapshot(text: Option<&str>) -> Value {
    match text {
        Some(text) => {
            json!({ "revision": format!("sha256:{:x}", Sha256::digest(text.as_bytes())) })
        }
        None => json!({ "state": "none" }),
    }
}

fn has_revision(snapshot: &Value) -> bool {
    snapshot.get("revision").is_some()
}

/// A whole developer message part this section rendered: the tags alone are not enough when
/// they are somewhere inside other text, and a person's or a page's words never count.
fn is_tagged_block(role: &str, text: &str, open: &str, close: &str) -> bool {
    role == "developer"
        && text.trim_start().starts_with(open.trim_end())
        && text.trim_end().ends_with(close.trim_start())
}

fn is_run_block(role: &str, text: &str) -> bool {
    is_tagged_block(role, text, RUN_OPEN, RUN_CLOSE)
}

fn is_turn_note_block(role: &str, text: &str) -> bool {
    is_tagged_block(role, text, NOTE_OPEN, NOTE_CLOSE)
}

/// A run's text as a thread started before this section carried it.
fn is_legacy_run_text(role: &str, text: &str) -> bool {
    let text = text.trim_start();
    role == "developer"
        && LEGACY_LANE_HEADINGS
            .iter()
            .any(|heading| text.starts_with(heading))
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: &str = "Browser/UI execution run:\n- Keep the visible page open.";
    const OTHER_POLICY: &str =
        "Instafy Studio structured execution run:\n- Treat this as a background automation job.";
    const NOTE: &str = "- The page this turn starts on was left open by a task in another chat.";

    fn run(policy: &str, note: Option<&str>) -> RunInstructions {
        RunInstructions {
            policy: policy.to_string(),
            turn_note: note.map(str::to_string),
        }
    }

    /// The run section, then the note section, as Codex adds them.
    fn sections(run: &RunInstructions) -> [WorldStateSectionContribution; 2] {
        let sections = RunInstructionsContext::new(run).sections();
        assert_eq!(
            sections
                .iter()
                .map(|section| section.id())
                .collect::<Vec<_>>(),
            [RUN_SECTION_ID, NOTE_SECTION_ID]
        );
        sections.try_into().unwrap_or_else(|_| unreachable!())
    }

    /// The text Codex puts into history for a fragment.
    fn rendered(fragment: &RenderedWorldStateFragment) -> String {
        let (open, close) = fragment.markers();
        format!("{open}{}{close}", fragment.body())
    }

    #[test]
    fn an_unchanged_run_sends_nothing_and_a_changed_one_replaces_every_earlier_text() {
        let [current, _] = sections(&run(POLICY, None));
        let [other, _] = sections(&run(OTHER_POLICY, None));

        assert!(
            current
                .render_diff(PreviousWorldStateSection::Known(current.snapshot()))
                .is_none(),
            "a thread that read this text is not sent it again"
        );

        for previous in [
            PreviousWorldStateSection::Known(other.snapshot()),
            PreviousWorldStateSection::Unknown,
        ] {
            let fragment = current.render_diff(previous).expect("a changed run's text");
            assert_eq!(fragment.role(), "developer");
            assert_eq!(fragment.markers(), (RUN_OPEN, RUN_CLOSE));
            assert_eq!(fragment.body(), format!("{REPLACE}\n\n{POLICY}"));
            assert!(current.matches_retained_fragment("developer", &rendered(&fragment)));
        }

        let fresh = current
            .render_diff(PreviousWorldStateSection::Absent)
            .expect("a fresh thread's text");
        assert_eq!(fresh.body(), POLICY);
        assert!(!fresh.body().contains(REPLACE));
        assert_eq!(
            rendered(&fresh),
            format!("<instafy_run_instructions>\n{POLICY}\n</instafy_run_instructions>")
        );
    }

    #[test]
    fn a_run_without_text_withdraws_the_earlier_text_once() {
        let [with_text, _] = sections(&run(POLICY, None));
        let [without, _] = sections(&RunInstructions::default());
        for previous in [
            PreviousWorldStateSection::Known(with_text.snapshot()),
            PreviousWorldStateSection::Unknown,
        ] {
            let fragment = without.render_diff(previous).expect("withdrawal");
            assert_eq!(fragment.body(), WITHDRAW);
            assert_eq!(fragment.role(), "developer");
        }
        for previous in [
            PreviousWorldStateSection::Known(without.snapshot()),
            PreviousWorldStateSection::Absent,
        ] {
            assert!(without.render_diff(previous).is_none());
        }
    }

    #[test]
    fn a_turn_note_is_said_for_its_turn_and_withdrawn_once_on_the_next() {
        let [_, note] = sections(&run(POLICY, Some(NOTE)));
        let [_, other_note] = sections(&run(POLICY, Some("- Another note.")));
        let [_, without] = sections(&run(POLICY, None));

        for previous in [
            PreviousWorldStateSection::Absent,
            PreviousWorldStateSection::Known(without.snapshot()),
        ] {
            let fragment = note.render_diff(previous).expect("the note");
            assert_eq!(fragment.role(), "developer");
            assert_eq!(fragment.markers(), (NOTE_OPEN, NOTE_CLOSE));
            assert_eq!(fragment.body(), format!("For this turn only:\n{NOTE}"));
            assert!(note.matches_retained_fragment("developer", &rendered(&fragment)));
        }
        assert!(
            note.render_diff(PreviousWorldStateSection::Known(note.snapshot()))
                .is_none(),
            "the same note in effect (a retry of the same turn) is not repeated"
        );
        for previous in [
            PreviousWorldStateSection::Known(other_note.snapshot()),
            PreviousWorldStateSection::Unknown,
        ] {
            assert_eq!(
                note.render_diff(previous).expect("a replacing note").body(),
                format!(
                    "This note replaces any earlier turn note in this conversation.\nFor this turn only:\n{NOTE}"
                )
            );
        }

        // The next turn without a note withdraws it once, then says nothing.
        let withdrawal = without
            .render_diff(PreviousWorldStateSection::Known(note.snapshot()))
            .expect("withdrawal");
        assert_eq!(
            withdrawal.body(),
            "Earlier turn notes in this conversation no longer apply."
        );
        assert!(without.matches_retained_fragment("developer", &rendered(&withdrawal)));
        assert!(
            without
                .render_diff(PreviousWorldStateSection::Known(without.snapshot()))
                .is_none()
        );
        assert!(
            without
                .render_diff(PreviousWorldStateSection::Absent)
                .is_none()
        );
        // History holds a note but its state was lost: withdraw it to be sure.
        assert_eq!(
            without
                .render_diff(PreviousWorldStateSection::Unknown)
                .expect("withdrawal")
                .body(),
            NOTE_WITHDRAW
        );
    }

    #[test]
    fn only_whole_tagged_developer_blocks_count_as_run_text() {
        let [run_section, note_section] = sections(&run(POLICY, Some(NOTE)));
        let block = rendered(
            &run_section
                .render_diff(PreviousWorldStateSection::Absent)
                .unwrap(),
        );
        let note = rendered(
            &note_section
                .render_diff(PreviousWorldStateSection::Absent)
                .unwrap(),
        );
        for (section, block) in [(&run_section, &block), (&note_section, &note)] {
            assert!(section.matches_retained_fragment("developer", block));
            assert!(section.matches_retained_fragment("developer", &format!("\n{block}\n")));
            // A person or a page writing the tags never counts.
            assert!(!section.matches_retained_fragment("user", block));
            assert!(!section.matches_retained_fragment("assistant", block));
            // Nor do tags inside other text.
            assert!(
                !section.matches_retained_fragment("developer", &format!("Quoted: {block} end"))
            );
            assert!(!section.matches_retained_fragment("developer", &format!("{block} end")));
        }
        assert!(!run_section.matches_retained_fragment("developer", &note));
        assert!(!note_section.matches_retained_fragment("developer", &block));
        assert!(!run_section.matches_retained_fragment("developer", POLICY));
    }

    #[test]
    fn threads_started_before_the_section_are_recognized_by_their_lane_heading() {
        let [run_section, note_section] = sections(&run(POLICY, None));
        let block = rendered(
            &run_section
                .render_diff(PreviousWorldStateSection::Absent)
                .unwrap(),
        );
        assert!(run_section.matches_legacy_fragment("developer", &block));
        assert!(!run_section.matches_legacy_fragment("user", &block));
        for heading in LEGACY_LANE_HEADINGS {
            let text = format!("{heading}\n- A rule of that lane.");
            assert!(
                run_section.matches_legacy_fragment("developer", &text),
                "{heading}"
            );
            assert!(
                run_section.matches_legacy_fragment("developer", &format!("\n  {text}")),
                "{heading}"
            );
            assert!(
                !run_section.matches_legacy_fragment("user", &text),
                "{heading}"
            );
            assert!(
                !run_section.matches_legacy_fragment("developer", &format!("Quoted: {text}")),
                "{heading}"
            );
            assert!(!note_section.matches_legacy_fragment("developer", &text));
        }
        assert!(!run_section.matches_legacy_fragment("developer", "Other developer text."));
    }

    /// Old threads carry these exact lines, so none may change or go: every heading a lane's
    /// text has started with, a renamed one included.
    #[test]
    fn legacy_lane_headings_are_frozen() {
        assert_eq!(
            LEGACY_LANE_HEADINGS,
            [
                "Instafy Studio structured execution run:",
                "Instafy Studio focused execution run:",
                "Instafy Studio workspace task:",
                "Browser/UI execution run:",
                "MCP-focused run:",
                "Granted device turn:",
                "Instafy Studio workspace-change run:",
            ]
        );
    }

    /// A workspace task's text opened with "Instafy Studio workspace-change run:" until that
    /// lane's heading was renamed, so a thread such a turn started is an older thread too: the
    /// next turn is told that its text replaces that one.
    #[test]
    fn a_thread_a_renamed_lane_heading_started_is_recognized() {
        const RENAMED_WRITE_TEXT: &str = "Instafy Studio workspace-change run:\n- Treat this as a background automation job, not an interactive chat turn.\n- Make the requested file changes directly with `apply_patch` (or write the files).";
        let [run_section, note_section] = sections(&run(POLICY, None));
        assert!(run_section.matches_legacy_fragment("developer", RENAMED_WRITE_TEXT));
        assert!(!run_section.matches_legacy_fragment("user", RENAMED_WRITE_TEXT));
        assert!(!note_section.matches_legacy_fragment("developer", RENAMED_WRITE_TEXT));
    }

    #[test]
    fn snapshots_hold_a_digest_and_never_the_text() {
        let [run_section, note_section] = sections(&run(POLICY, Some(NOTE)));
        for (section, text) in [(&run_section, POLICY), (&note_section, NOTE)] {
            let snapshot = section.snapshot().to_string();
            assert!(
                snapshot.starts_with("{\"revision\":\"sha256:"),
                "{snapshot}"
            );
            for line in text.lines() {
                assert!(!snapshot.contains(line), "{snapshot}");
            }
        }
        let [other, _] = sections(&run(OTHER_POLICY, None));
        assert_ne!(run_section.snapshot(), other.snapshot());
        let [empty, no_note] = sections(&RunInstructions::default());
        assert_eq!(empty.snapshot(), &json!({ "state": "none" }));
        assert_eq!(no_note.snapshot(), &json!({ "state": "none" }));
    }
}
