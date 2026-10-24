//! Durable human decisions for tracked workers, independent of a provider's live tools.
use std::collections::HashSet;

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{CodexAction, CodexOutcome, is_multi_agent_worker_job};
use crate::controller::LeaseJob;

pub(crate) const ARTIFACT_KIND: &str = "agent/user-input-request";
pub(super) const WORKER_INPUT_CONTRACT: &str = "\nWorker decisions and coordination:\n\
- Resolve implementation choices and task coordination with the parent agent through the linked conversation when those tools are available; they are not questions for the person. Never invent a sent message or available communication tool. Without communication tools, report a coordination blocker to the lead in your summary; do not ask the person as a substitute.\n\
- When a human decision is necessary before your scoped work can continue, finish with one request_user_input action in actions: {type: 'request_user_input', questions: [{id: string, header: string, question: string, options: [{label: string, description: string}], isOther: boolean, isSecret: false}], continuationNote: string}. Use 1-3 distinct questions; options may be omitted. IDs and headers are at most 100 characters, questions 2000, at most 6 options with labels 200 and descriptions 1000.\n\
- In continuationNote (at most 4000 characters), record completed work, the blocked next step, and references needed to continue. Do not include secrets. This ends the current job and asks the owning chat; an answer starts a scoped continuation of this worker, not a live native tool reply.\n\
- This action cannot request credentials, approve permissions, expand scope, or bypass policy. Use established credential/permission flows or report the restriction. Do not guess the person's answer, force edits/commands, or claim the blocked work is complete. Return files: [] when no changes are warranted before the decision.\n";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<WorkerInputOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_other: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_secret: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerInputRequest {
    pub questions: Vec<WorkerInputQuestion>,
    pub continuation_note: String,
}

fn bounded(value: &str, limit: usize, field: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.chars().count() <= limit && !value.contains('\0'),
        "request_user_input {field} must contain 1-{limit} characters"
    );
    Ok(())
}

impl WorkerInputRequest {
    fn validate(&self) -> Result<()> {
        ensure!(
            (1..=3).contains(&self.questions.len()),
            "request_user_input requires 1-3 questions"
        );
        bounded(&self.continuation_note, 4000, "continuationNote")?;
        let mut ids = HashSet::new();
        for question in &self.questions {
            bounded(&question.id, 100, "question id")?;
            ensure!(
                question.id.trim() == question.id && ids.insert(&question.id),
                "request_user_input requires unique, unpadded question ids"
            );
            bounded(&question.header, 100, "header")?;
            bounded(&question.question, 2000, "question")?;
            ensure!(
                question.is_secret != Some(true),
                "request_user_input does not accept secret questions"
            );
            if let Some(options) = &question.options {
                ensure!(
                    (1..=6).contains(&options.len()),
                    "request_user_input accepts 1-6 options when provided"
                );
                let mut labels = HashSet::new();
                for option in options {
                    bounded(&option.label, 200, "option label")?;
                    ensure!(
                        labels.insert(&option.label),
                        "request_user_input options require distinct labels"
                    );
                    ensure!(
                        option.description.chars().count() <= 1000
                            && !option.description.contains('\0'),
                        "request_user_input option description exceeds its bound"
                    );
                }
            }
        }
        Ok(())
    }

    pub(crate) fn artifact(&self) -> Value {
        json!({"kind": ARTIFACT_KIND, "questions": self.questions, "continuationNote": self.continuation_note})
    }
}

pub(super) fn parse_action(output: &Value) -> Result<Option<WorkerInputRequest>> {
    ensure!(
        output.get("type").and_then(Value::as_str) != Some("request_user_input"),
        "request_user_input must be inside the final response actions array"
    );
    let Some(raw_actions) = output.get("actions").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(actions) = raw_actions.as_array() else {
        ensure!(
            raw_actions.get("type").and_then(Value::as_str) != Some("request_user_input"),
            "request_user_input must be inside the actions array"
        );
        return Ok(None);
    };
    let mut request = None;
    for action in actions {
        if action.get("type").and_then(Value::as_str) != Some("request_user_input") {
            continue;
        }
        ensure!(
            request.is_none() && actions.len() == 1,
            "request_user_input must be the only final action"
        );
        let parsed: WorkerInputRequest = serde_json::from_value(action.clone()).map_err(|_| {
            anyhow::anyhow!("request_user_input has invalid question or continuationNote fields")
        })?;
        parsed.validate()?;
        request = Some(parsed);
    }
    Ok(request)
}

pub(super) fn validate_outcome_scope(job: &LeaseJob, outcome: &CodexOutcome) -> Result<()> {
    if outcome
        .actions
        .iter()
        .any(|action| matches!(action, CodexAction::RequestUserInput(_)))
    {
        ensure!(
            is_multi_agent_worker_job(job),
            "request_user_input is supported only for tracked worker jobs"
        );
    }
    Ok(())
}

pub(super) fn append_outcome_artifact(artifacts: &mut Vec<Value>, outcome: &CodexOutcome) {
    for action in &outcome.actions {
        if let CodexAction::RequestUserInput(request) = action {
            artifacts.push(request.artifact());
        }
    }
}

pub(crate) fn from_artifacts(
    job: &LeaseJob,
    artifacts: &[Value],
) -> Result<Option<(usize, WorkerInputRequest)>> {
    let mut request = None;
    for (index, artifact) in artifacts.iter().enumerate() {
        if artifact.get("kind").and_then(Value::as_str) != Some(ARTIFACT_KIND) {
            continue;
        }
        if request.is_some() {
            bail!("worker output contains duplicate user-input requests");
        }
        ensure!(
            is_multi_agent_worker_job(job),
            "user-input request requires a tracked worker job"
        );
        let parsed: WorkerInputRequest = serde_json::from_value(artifact.clone())?;
        parsed.validate()?;
        request = Some((index, parsed));
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output() -> Value {
        json!({"actions": [{"type": "request_user_input", "questions": [{"id": "tone", "header": "Tone", "question": "Which tone should the poem use?", "options": [{"label": "Playful", "description": "Use a light tone."}], "isOther": true, "isSecret": false}], "continuationNote": "No files changed; write poems/one.txt after the tone decision."}]})
    }

    #[test]
    fn parses_and_roundtrips_worker_request() {
        let request = parse_action(&output()).unwrap().unwrap();
        let artifact = request.artifact();
        assert_eq!(
            serde_json::from_value::<WorkerInputRequest>(artifact).unwrap(),
            request
        );
        assert!(
            parse_action(&json!({"actions": [{"type":"request_browser"}]}))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn malformed_questions_fail_instead_of_disappearing() {
        for replacement in [json!([]), json!([{"id":"x"}]), json!("question")] {
            let mut value = output();
            value["actions"][0]["questions"] = replacement;
            assert!(parse_action(&value).is_err());
        }
        let mut value = output();
        assert!(parse_action(&value["actions"][0]).is_err());
        value["actions"][0]["questions"][0]["isSecret"] = json!(true);
        assert!(parse_action(&value).is_err());
        value = output();
        value["actions"][0]["continuationNote"] = json!("x".repeat(4001));
        assert!(parse_action(&value).is_err());
        value = output();
        let question = value["actions"][0]["questions"][0].clone();
        value["actions"][0]["questions"]
            .as_array_mut()
            .unwrap()
            .push(question);
        assert!(parse_action(&value).is_err());
        value = output();
        let action = value["actions"][0].clone();
        value["actions"].as_array_mut().unwrap().push(action);
        assert!(parse_action(&value).is_err());
    }

    #[test]
    fn human_decision_cannot_dispatch_another_action_while_waiting() {
        let mut value = output();
        value["actions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"request_browser", "task":"Inspect a page"}));
        assert!(parse_action(&value).is_err());
        assert!(super::super::extract_codex_outcome(&value).is_err());
    }

    #[test]
    fn human_decision_defers_forced_edits_and_commands_without_emitting_a_card() {
        let outcome = super::super::extract_codex_outcome(&output()).unwrap();
        assert!(super::super::outcome_defers_workspace_file_changes(
            &outcome
        ));
        assert!(super::super::outcome_defers_command_execution(&outcome));
        assert!(super::super::build_final_messages_from_actions(&outcome.actions, None).is_empty());
    }
}
