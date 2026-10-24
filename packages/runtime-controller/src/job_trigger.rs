//! What started an agent job or made a message.
//!
//! Only the controller code that authenticated a cause works out its
//! trigger, from what it knows about the caller and never from a request
//! body: the message routes, the send queue, automations and agent plans. A
//! job keeps whose cause it was and when it was received
//! (`agent_jobs.trigger_user_id`, `trigger_received_at`); a job any other path
//! queues has neither. Where device grants are on for a message's sender, the
//! message keeps its trigger's kind ([`MESSAGE_TRIGGER_KEY`]). An unset
//! trigger, or a send whose client does not say a person typed it, is no
//! person's: nothing that needs a person's own turn takes it.

use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::auth::{require_user_session, RequestContext};
use crate::provider_requests::DEVICE_ID_MAX_LEN;

/// Where a client says how its person made a send: `{"kind": "typed"}`, or
/// `{"kind": "voice", "deviceId": ...}` for speech one of their devices
/// heard. Only a person's own session's word counts, and a send that says
/// nothing is no person's.
const INPUT_METADATA_KEY: &str = "input";
/// Web chat's mark on a resend of an earlier prompt, by hand or by itself.
const RETRY_OF_MESSAGE_ID_KEY: &str = "retryOfMessageId";
/// Web chat's mark on a goal's next turn, which an open tab sends by itself
/// when a goal run ends, or when its person resumes the goal.
const GOAL_CONTINUATION_KEYS: [&str; 2] = ["goalContinuation", "goal_continuation"];

/// The key of a user message's metadata that says what made it: the kind of
/// the trigger the controller worked out for its send, or null
/// ([`stamp_message`]).
pub(crate) const MESSAGE_TRIGGER_KEY: &str = "trigger";

/// Says in a user message's metadata what made it, under
/// [`MESSAGE_TRIGGER_KEY`]: `trigger`'s kind, or null, over anything a client
/// put there, where device grants are on for its sender (`grants_on`).
/// Anywhere else the message keeps no such key, so a client cannot write one.
pub(crate) fn stamp_message(
    metadata: &mut serde_json::Map<String, JsonValue>,
    trigger: Option<&JobTrigger>,
    grants_on: bool,
) {
    if !grants_on {
        metadata.remove(MESSAGE_TRIGGER_KEY);
        return;
    }
    metadata.insert(
        MESSAGE_TRIGGER_KEY.to_string(),
        trigger.map_or(JsonValue::Null, |trigger| trigger.kind.as_str().into()),
    );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TriggerKind {
    /// A person typed it, in their own signed-in session.
    Person,
    /// One of the person's devices heard it. The device attests that, but no
    /// session says who spoke, so it is not a person.
    DeviceVoice,
    /// The person's own session sent it again without them typing it now: a
    /// resend of an earlier prompt, or a goal's next turn.
    Resend,
    /// Nobody sent it: an automation, an agent's own message or plan, or the
    /// controller itself.
    Automatic,
}

impl TriggerKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::DeviceVoice => "device_voice",
            Self::Resend => "resend",
            Self::Automatic => "automatic",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobTrigger {
    pub(crate) kind: TriggerKind,
    /// Whose cause it was: the person who sent it, or whose automation or
    /// agent did.
    pub(crate) user_id: Option<Uuid>,
    /// The device that heard a [`TriggerKind::DeviceVoice`] send.
    pub(crate) device_id: Option<String>,
    /// When the controller received the cause, on the database clock. `None`
    /// means now: the time the job is queued.
    pub(crate) received_at: Option<DateTime<Utc>>,
}

impl JobTrigger {
    pub(crate) fn new(kind: TriggerKind, user_id: Option<Uuid>) -> Self {
        Self {
            kind,
            user_id,
            device_id: None,
            received_at: None,
        }
    }

    /// The trigger of a message `context` sent with `metadata`. The service
    /// role's, and a scoped token's (an agent job's, which acts as its
    /// subject), is automatic. A person's own session's is a resend when the
    /// message is marked as a retry or a goal's next turn, and otherwise what
    /// its client says the person did; when it says nothing, there is none.
    pub(crate) fn of_send(context: &RequestContext, metadata: &JsonValue) -> Option<Self> {
        if context.is_service_role || context.scoped_claims.is_some() {
            return Some(Self::new(TriggerKind::Automatic, context.user_id));
        }
        let user_id = require_user_session(context).ok()?;
        let marked = |key: &str| metadata.get(key).is_some_and(|value| !value.is_null());
        if marked(RETRY_OF_MESSAGE_ID_KEY) || GOAL_CONTINUATION_KEYS.into_iter().any(marked) {
            return Some(Self::new(TriggerKind::Resend, Some(user_id)));
        }
        let input = metadata.get(INPUT_METADATA_KEY)?;
        match input.get("kind").and_then(JsonValue::as_str)? {
            "typed" => Some(Self::new(TriggerKind::Person, Some(user_id))),
            "voice" => {
                let device_id = input.get("deviceId")?.as_str()?.trim();
                if device_id.is_empty() || device_id.len() > DEVICE_ID_MAX_LEN {
                    return None;
                }
                Some(Self {
                    device_id: Some(device_id.to_string()),
                    ..Self::new(TriggerKind::DeviceVoice, Some(user_id))
                })
            }
            _ => None,
        }
    }

    /// This trigger, received at `received_at` rather than now.
    pub(crate) fn received_at(self, received_at: DateTime<Utc>) -> Self {
        Self {
            received_at: Some(received_at),
            ..self
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{JobTrigger, TriggerKind};
    use crate::auth::RequestContext;

    /// Only a person's own session's word makes a send theirs: what its client
    /// says they did, unless it is a resend or a goal's next turn. A job token
    /// or the service role never types for a person, and a send that says
    /// nothing, or something unknown, is nobody's.
    #[test]
    fn a_send_is_what_its_callers_own_credential_and_client_say() {
        let user_id = Uuid::new_v4();
        let context = |is_service_role: bool, job_token: bool| RequestContext {
            user_id: Some(user_id),
            is_service_role,
            scoped_claims: job_token.then(|| {
                serde_json::from_value(json!({
                    "aud": "runtime",
                    "sub": user_id.to_string(),
                    "project_id": Uuid::nil().to_string(),
                    "scopes": ["controller.access"],
                    "iat": 0,
                    "exp": 0,
                    "jti": "job-token",
                }))
                .expect("claims")
            }),
        };
        let person = context(false, false);
        let typed = |extra: serde_json::Value| {
            let mut metadata = json!({ "input": { "kind": "typed" } });
            for (key, value) in extra.as_object().expect("object") {
                metadata[key] = value.clone();
            }
            metadata
        };
        let of_kind = |kind| Some(JobTrigger::new(kind, Some(user_id)));
        let heard = Some(JobTrigger {
            device_id: Some("device-1".to_string()),
            ..JobTrigger::new(TriggerKind::DeviceVoice, Some(user_id))
        });
        for (context, metadata, trigger) in [
            (&person, typed(json!({})), of_kind(TriggerKind::Person)),
            (
                &person,
                json!({ "input": { "kind": "voice", "deviceId": " device-1 " } }),
                heard,
            ),
            (&person, json!({}), None),
            (&person, json!({ "input": null }), None),
            (&person, json!({ "input": "typed" }), None),
            (&person, json!({ "input": { "kind": "pasted" } }), None),
            (&person, json!({ "input": { "kind": "voice" } }), None),
            (
                &person,
                json!({ "input": { "kind": "voice", "deviceId": "  " } }),
                None,
            ),
            (
                &person,
                json!({ "input": { "kind": "voice", "deviceId": "d".repeat(257) } }),
                None,
            ),
            (
                &person,
                typed(json!({ "retryOfMessageId": Uuid::new_v4().to_string() })),
                of_kind(TriggerKind::Resend),
            ),
            (
                &person,
                typed(json!({ "goalContinuation": { "turn": 2 } })),
                of_kind(TriggerKind::Resend),
            ),
            (
                &person,
                typed(json!({ "goal_continuation": { "source": "manual_resume" } })),
                of_kind(TriggerKind::Resend),
            ),
            (
                &person,
                typed(json!({ "retryOfMessageId": null, "goalContinuation": null })),
                of_kind(TriggerKind::Person),
            ),
            (
                &context(false, true),
                typed(json!({})),
                of_kind(TriggerKind::Automatic),
            ),
            (
                &context(true, false),
                typed(json!({})),
                of_kind(TriggerKind::Automatic),
            ),
        ] {
            assert_eq!(
                JobTrigger::of_send(context, &metadata),
                trigger,
                "{metadata} from {context:?}"
            );
        }
    }
}
