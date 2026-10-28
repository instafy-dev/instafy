//! What started an agent job or made a message, worked out only by the code
//! that authenticated a send, from the caller's own credential and never from
//! a request body. The rules are docs/Architecture.md "Agent Job Trigger".

use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::auth::{require_user_session, RequestContext};
use crate::config::AppConfig;
use crate::provider_requests::DEVICE_ID_MAX_LEN;

/// Where a client says how its person made a send, in the trigger's own
/// kinds: `{"kind": "person"}`, or `{"kind": "device", "deviceId": ...}` for
/// input one of their devices relayed. Only a person's own session's word
/// counts, and a send that says nothing is no person's.
const INPUT_METADATA_KEY: &str = "input";
/// Web chat's mark on a resend of an earlier prompt, by hand or by itself.
const RETRY_OF_MESSAGE_ID_KEY: &str = "retryOfMessageId";
/// Web chat's mark on a goal's next turn, which an open tab sends by itself
/// when a goal run ends, or when its person resumes the goal.
const GOAL_CONTINUATION_KEYS: [&str; 2] = ["goalContinuation", "goal_continuation"];

/// The key of a user message's metadata that says what made it: the kind of
/// the trigger the controller worked out for its send ([`stamp_message`]).
pub(crate) const MESSAGE_TRIGGER_KEY: &str = "trigger";

/// Says in a user message's metadata what made it, under
/// [`MESSAGE_TRIGGER_KEY`]: `trigger`'s kind, over anything a client put
/// there. For a send without a kind, which is every send where device grants
/// are off for its person ([`JobTrigger::of_send`]), the message keeps no such
/// key, so a client cannot write one.
pub(crate) fn stamp_message(
    metadata: &mut serde_json::Map<String, JsonValue>,
    trigger: Option<&JobTrigger>,
) {
    match trigger.and_then(|trigger| trigger.kind) {
        Some(kind) => {
            metadata.insert(MESSAGE_TRIGGER_KEY.to_string(), kind.as_str().into());
        }
        None => {
            metadata.remove(MESSAGE_TRIGGER_KEY);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TriggerKind {
    /// The person typed it.
    Person,
    /// One of the person's devices relayed it, such as speech it heard. The
    /// device attests that, but no session says who made it, so it is not a
    /// person.
    Device,
}

impl TriggerKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Device => "device",
        }
    }
}

/// A send a person's own signed-in session made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobTrigger {
    pub(crate) user_id: Uuid,
    /// What its client says the person did, unless it is a resend or a goal's
    /// next turn, or device grants are off for the person. None when it says
    /// neither.
    pub(crate) kind: Option<TriggerKind>,
    /// The device that relayed a [`TriggerKind::Device`] send.
    pub(crate) device_id: Option<String>,
    /// When the controller received it, on the database clock. `None` means
    /// now: the time the job is queued.
    pub(crate) received_at: Option<DateTime<Utc>>,
}

impl JobTrigger {
    /// The trigger of a message `context` sent with `metadata`: none unless a
    /// person's own signed-in session sent it, so none for the service role or
    /// a scoped token (an agent job's, which acts as its subject). Where
    /// device grants are off for that person it has no kind.
    pub(crate) fn of_send(
        config: &AppConfig,
        context: &RequestContext,
        metadata: &JsonValue,
    ) -> Option<Self> {
        let user_id = require_user_session(context).ok()?;
        let marked = |key: &str| metadata.get(key).is_some_and(|value| !value.is_null());
        let resent =
            marked(RETRY_OF_MESSAGE_ID_KEY) || GOAL_CONTINUATION_KEYS.into_iter().any(marked);
        let kinded = !resent && config.device_grants.allow(user_id);
        let (kind, device_id) = match input_of(metadata).filter(|_| kinded) {
            Some((kind, device_id)) => (Some(kind), device_id),
            None => (None, None),
        };
        Some(Self {
            user_id,
            kind,
            device_id,
            received_at: None,
        })
    }

    /// This trigger, received at `received_at` rather than now.
    pub(crate) fn received_at(self, received_at: DateTime<Utc>) -> Self {
        Self {
            received_at: Some(received_at),
            ..self
        }
    }
}

/// What `metadata`'s client says its person did ([`INPUT_METADATA_KEY`]), and
/// the device that relayed it.
fn input_of(metadata: &JsonValue) -> Option<(TriggerKind, Option<String>)> {
    let input = metadata.get(INPUT_METADATA_KEY)?;
    match input.get("kind").and_then(JsonValue::as_str)? {
        "person" => Some((TriggerKind::Person, None)),
        "device" => {
            let device_id = input.get("deviceId")?.as_str()?.trim();
            if device_id.is_empty() || device_id.len() > DEVICE_ID_MAX_LEN {
                return None;
            }
            Some((TriggerKind::Device, Some(device_id.to_string())))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{JobTrigger, TriggerKind};
    use crate::auth::RequestContext;
    use crate::config::DeviceGrantUsers;

    /// Only a person's own session's word makes a send theirs: what its client
    /// says they did, unless it is a resend or a goal's next turn, or device
    /// grants are off for them. A job token or the service role never sends
    /// for a person, and a send that says nothing, or something unknown, has
    /// no kind.
    #[test]
    fn a_send_is_what_its_callers_own_credential_and_client_say() {
        let user_id = Uuid::new_v4();
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "job-trigger",
        );
        config.device_grants = DeviceGrantUsers::Only(vec![user_id]);
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
        let own_session = context(false, false);
        let person = |extra: serde_json::Value| {
            let mut metadata = json!({ "input": { "kind": "person" } });
            for (key, value) in extra.as_object().expect("object") {
                metadata[key] = value.clone();
            }
            metadata
        };
        let own = |kind, device_id: Option<&str>| {
            Some(JobTrigger {
                user_id,
                kind,
                device_id: device_id.map(str::to_string),
                received_at: None,
            })
        };
        let person_now = own(Some(TriggerKind::Person), None);
        for (context, metadata, trigger) in [
            (&own_session, person(json!({})), person_now.clone()),
            (
                &own_session,
                json!({ "input": { "kind": "device", "deviceId": " device-1 " } }),
                own(Some(TriggerKind::Device), Some("device-1")),
            ),
            (&own_session, json!({}), own(None, None)),
            (&own_session, json!({ "input": null }), own(None, None)),
            (&own_session, json!({ "input": "person" }), own(None, None)),
            // The kind is the trigger's own word.
            (
                &own_session,
                json!({ "input": { "kind": "typed" } }),
                own(None, None),
            ),
            (
                &own_session,
                json!({ "input": { "kind": "pasted" } }),
                own(None, None),
            ),
            (
                &own_session,
                json!({ "input": { "kind": "device" } }),
                own(None, None),
            ),
            (
                &own_session,
                json!({ "input": { "kind": "device", "deviceId": "  " } }),
                own(None, None),
            ),
            (
                &own_session,
                json!({ "input": { "kind": "device", "deviceId": "d".repeat(257) } }),
                own(None, None),
            ),
            (
                &own_session,
                person(json!({ "retryOfMessageId": Uuid::new_v4().to_string() })),
                own(None, None),
            ),
            (
                &own_session,
                person(json!({ "goalContinuation": { "turn": 2 } })),
                own(None, None),
            ),
            (
                &own_session,
                person(json!({ "goal_continuation": { "source": "manual_resume" } })),
                own(None, None),
            ),
            (
                &own_session,
                person(json!({ "retryOfMessageId": null, "goalContinuation": null })),
                person_now,
            ),
            (&context(false, true), person(json!({})), None),
            (&context(true, false), person(json!({})), None),
        ] {
            assert_eq!(
                JobTrigger::of_send(&config, context, &metadata),
                trigger,
                "{metadata} from {context:?}"
            );
        }
        config.device_grants = DeviceGrantUsers::Nobody;
        assert_eq!(
            JobTrigger::of_send(&config, &own_session, &person(json!({}))),
            own(None, None)
        );
    }
}
