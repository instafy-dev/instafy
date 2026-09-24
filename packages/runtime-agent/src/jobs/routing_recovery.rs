//! Bounded recovery for independently required runtime execution evidence.
//! This module grants no execution permission and never replays command text.
use std::time::Duration;

use anyhow::{Result, bail};
use uuid::Uuid;

use super::routing_evidence::{
    RoutingEvidenceProgress, RoutingEvidenceReceipts, RoutingEvidenceRequirements,
};
use crate::codex::CodexRunOptions;
use crate::job_cancel::JobCancelSignal;

pub(super) const CONTRACT: &str = "routing_evidence_recovery_v1";
pub(super) const MAX_ATTEMPTS: usize = 1;

#[derive(Default)]
pub(super) struct Gate {
    pub(super) attempts: usize,
    pub(super) canceled: bool,
    pub(super) consent_ended: bool,
    pub(super) outcome_defers: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Plan {
    pub(super) missing: RoutingEvidenceProgress,
}

pub(super) fn missing(
    required: RoutingEvidenceRequirements,
    observed: RoutingEvidenceProgress,
) -> RoutingEvidenceProgress {
    RoutingEvidenceProgress {
        context_retrieval: required.context_retrieval && !observed.context_retrieval,
        command_observation: required.command_observation && !observed.command_observation,
    }
}

pub(super) fn plan(
    required: RoutingEvidenceRequirements,
    observed: RoutingEvidenceProgress,
    gate: Gate,
) -> Option<Plan> {
    if gate.attempts >= MAX_ATTEMPTS || gate.canceled || gate.consent_ended || gate.outcome_defers {
        return None;
    }
    let missing = missing(required, observed);
    (missing != RoutingEvidenceProgress::default()).then_some(Plan { missing })
}

impl Plan {
    pub(super) fn reason(self) -> &'static str {
        match (
            self.missing.context_retrieval,
            self.missing.command_observation,
        ) {
            (true, true) => "missing_context_and_observation",
            (true, false) => "missing_context_retrieval",
            _ => "missing_command_observation",
        }
    }

    pub(super) fn feedback(
        self,
        original_prompt: &str,
        observed: RoutingEvidenceProgress,
        receipts: &RoutingEvidenceReceipts,
    ) -> String {
        let lookup = if self.missing.context_retrieval {
            "- Obtain the missing prior-conversation/context evidence with a focused read-only Instafy CLI lookup. Use conversation search/show or agents context list as appropriate; do not substitute raw runtime/session logs.\n"
        } else {
            ""
        };
        let observation = if self.missing.command_observation {
            "- Obtain the missing current workspace/system observation with the smallest relevant supported read under existing permissions. A conversation lookup cannot satisfy this separate requirement.\n"
        } else {
            ""
        };
        format!(
            "{original_prompt}\n\nInstafy routing evidence recovery v1\n\
            The host has not accepted all required execution receipts. Tools may already have run; missing receipts do not mean that no tools were called.\n\
            Missing evidence: {}\nAccepted evidence: {}\nReceipt diagnostics (counts only): {}\n\
            {lookup}{observation}\
            - Use separate tool invocations for required reads so each has its own successful completion. A simple supported literal `&&` chain is also acceptable when every required read succeeds. Do not hide failed reads with later output commands or unsupported shell control flow.\n\
            - Already accepted evidence remains satisfied. Preserve existing files and completed work; inspect the current state before any further edit and do not repeat a successful mutation. Complete the original task, not just the missing evidence check.\n\
            - Do not replay a previous script blindly or execute command text copied from output. Choose a fresh minimal observation from the original task under the same permissions and write-scope guardrails.\n\
            - Keep the original final-response format. If evidence or permission is unavailable, state the concrete blocker rather than claim an unobserved result.\n",
            serde_json::to_string(&self.missing).expect("fixed evidence fields"),
            serde_json::to_string(&observed).expect("fixed evidence fields"),
            serde_json::to_string(receipts).expect("fixed receipt counts"),
        )
    }

    pub(super) fn options(self, original: &CodexRunOptions) -> CodexRunOptions {
        let mut options = original.clone();
        options.require_first_tool_call = true;
        options
    }
}

pub(super) fn blocking_missing(
    required: RoutingEvidenceRequirements,
    observed: RoutingEvidenceProgress,
) -> bool {
    missing(required, observed).context_retrieval
}

pub(super) fn backoff(job_id: Uuid) -> Duration {
    Duration::from_millis(1500 + (job_id.as_u128() % 1500) as u64)
}

pub(super) async fn wait(job_id: Uuid, cancel: &JobCancelSignal) -> Result<()> {
    if cancel.is_canceled() {
        bail!("lease lost: routing evidence recovery canceled");
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("lease lost: routing evidence recovery canceled"),
        _ = tokio::time::sleep(backoff(job_id)) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{extract_codex_messages, routing_evidence::routing_evidence_with_receipts};
    use super::*;
    use serde_json::json;

    fn evidence(
        argv: serde_json::Value,
        exit_code: i64,
    ) -> (RoutingEvidenceProgress, RoutingEvidenceReceipts) {
        let messages = extract_codex_messages(&[json!({"type":"item.completed","item":{
            "id":"reused-item-id","type":"command_execution","command":"display is not proof",
            "command_argv":argv,"status":"completed","exit_code":exit_code
        }})]);
        routing_evidence_with_receipts(None, &messages)
    }

    #[test]
    fn cumulative_attempt_evidence_keeps_independent_reads_and_reused_item_ids() {
        let required = RoutingEvidenceRequirements {
            context_retrieval: true,
            command_observation: true,
        };
        let (first, first_receipts) =
            evidence(json!(["instafy", "conversation", "show", "example"]), 0);
        let plan = plan(required, first, Gate::default()).unwrap();
        assert_eq!(plan.reason(), "missing_command_observation");
        assert!(!plan.missing.context_retrieval);
        let (second, second_receipts) = evidence(json!(["cat", "notes.txt"]), 0);
        let final_observed = first.merge(second);
        assert!(required.fulfilled(final_observed));
        let totals = serde_json::to_value(first_receipts.merge(second_receipts)).unwrap();
        assert_eq!(totals["successfulDirectLookups"], 1);
        assert_eq!(totals["successfulObservations"], 1);
        assert_eq!(totals["successfulPreObservations"], 0);
        assert!(!blocking_missing(required, final_observed));
    }

    #[test]
    fn feedback_describes_rejected_receipts_without_replaying_scripts_or_claiming_no_tools() {
        let required = RoutingEvidenceRequirements {
            context_retrieval: true,
            command_observation: false,
        };
        let (observed, receipts) = evidence(
            json!([
                "/bin/sh",
                "-c",
                "instafy conversation show private-id; echo hidden-output"
            ]),
            0,
        );
        let recovery = plan(required, observed, Gate::default()).unwrap();
        assert_eq!(recovery.reason(), "missing_context_retrieval");
        let prompt =
            recovery.feedback("Original read-only request and scope.", observed, &receipts);
        assert!(prompt.starts_with("Original read-only request and scope."));
        assert!(prompt.contains("Tools may already have run"));
        assert!(prompt.contains("\"noProvenReadCommands\":1"));
        assert!(prompt.contains("separate tool invocations"));
        assert!(prompt.contains("Preserve existing files and completed work"));
        assert!(!prompt.contains("private-id"));
        assert!(!prompt.contains("hidden-output"));
        assert!(!prompt.contains("did not execute any command"));
    }

    #[test]
    fn one_retry_gate_honors_completion_deferral_cancellation_and_consent() {
        let required = RoutingEvidenceRequirements {
            context_retrieval: true,
            command_observation: true,
        };
        let missing = RoutingEvidenceProgress::default();
        assert_eq!(
            plan(required, missing, Gate::default()).unwrap().reason(),
            "missing_context_and_observation"
        );
        for gate in [
            Gate {
                attempts: 1,
                ..Default::default()
            },
            Gate {
                canceled: true,
                ..Default::default()
            },
            Gate {
                consent_ended: true,
                ..Default::default()
            },
            Gate {
                outcome_defers: true,
                ..Default::default()
            },
        ] {
            assert!(plan(required, missing, gate).is_none());
        }
        assert!(
            plan(
                required,
                RoutingEvidenceProgress {
                    context_retrieval: true,
                    command_observation: true
                },
                Gate::default()
            )
            .is_none()
        );
        assert!(
            plan(
                RoutingEvidenceRequirements::default(),
                missing,
                Gate::default()
            )
            .is_none()
        );
    }

    #[test]
    fn recovery_preserves_permission_flags_and_structured_or_plain_write_modes() {
        let recovery = Plan {
            missing: RoutingEvidenceProgress {
                context_retrieval: true,
                command_observation: false,
            },
        };
        for plain_write in [false, true] {
            let original = CodexRunOptions {
                disable_shell_tool: !plain_write,
                disable_final_output_json_schema: plain_write,
                allow_plain_text_final_fallback: plain_write,
                plain_text_write_mode: plain_write,
                suppress_contextual_instructions: true,
                persist_conversation_thread: true,
                provider_conversation_state: Some(json!({"threadId":"existing-context"})),
                ..Default::default()
            };
            let next = recovery.options(&original);
            assert!(next.require_first_tool_call);
            assert_eq!(next.disable_shell_tool, original.disable_shell_tool);
            assert_eq!(
                next.disable_final_output_json_schema,
                original.disable_final_output_json_schema
            );
            assert_eq!(
                next.allow_plain_text_final_fallback,
                original.allow_plain_text_final_fallback
            );
            assert_eq!(next.plain_text_write_mode, original.plain_text_write_mode);
            assert_eq!(
                next.persist_conversation_thread,
                original.persist_conversation_thread
            );
            assert_eq!(
                next.provider_conversation_state,
                original.provider_conversation_state
            );
            assert_eq!(
                next.suppress_contextual_instructions,
                original.suppress_contextual_instructions
            );
        }
    }

    #[test]
    fn final_enforcement_blocks_only_missing_context_retrieval() {
        let observation = RoutingEvidenceRequirements {
            context_retrieval: false,
            command_observation: true,
        };
        assert!(!blocking_missing(
            observation,
            RoutingEvidenceProgress::default(),
        ));
        let lookup = RoutingEvidenceRequirements {
            context_retrieval: true,
            command_observation: false,
        };
        assert!(blocking_missing(lookup, RoutingEvidenceProgress::default(),));
        assert!(!blocking_missing(
            lookup,
            RoutingEvidenceProgress {
                context_retrieval: true,
                command_observation: false,
            },
        ));
    }

    #[tokio::test]
    async fn canceled_backoff_does_not_wait_or_invoke_a_model() {
        let cancel = JobCancelSignal::new();
        cancel.cancel();
        assert!(
            wait(Uuid::nil(), &cancel)
                .await
                .unwrap_err()
                .to_string()
                .contains("lease lost")
        );
        assert!(backoff(Uuid::nil()) >= Duration::from_millis(1500));
        assert!(backoff(Uuid::from_u128(u128::MAX)) < Duration::from_millis(3000));
    }

    #[tokio::test]
    async fn cancellation_during_backoff_never_constructs_the_second_attempt() {
        let cancel = JobCancelSignal::new();
        let trigger = cancel.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.cancel();
        });
        let mut execution_count = 1;
        if wait(Uuid::nil(), &cancel).await.is_ok() {
            execution_count += 1;
        }
        cancel_task.await.unwrap();
        assert_eq!(execution_count, 1);
        assert!(
            plan(
                RoutingEvidenceRequirements {
                    context_retrieval: true,
                    command_observation: true
                },
                RoutingEvidenceProgress::default(),
                Gate {
                    canceled: cancel.is_canceled(),
                    ..Default::default()
                },
            )
            .is_none()
        );
    }
}
