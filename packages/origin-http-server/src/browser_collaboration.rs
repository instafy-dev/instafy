use std::collections::{HashMap, VecDeque};
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Extension;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, sleep, timeout, MissedTickBehavior};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::auth::{validated_claim_expiry, OriginClaims};
#[cfg(test)]
use crate::browser_approval::{read_agent_control_marker, AGENT_CONTROL_FILE_MAX_BYTES};
use crate::browser_approval::{AgentControlMarkerObservation, BrowserApprovalBridge};
use crate::error::OriginError;
use crate::routes::AppState;

const CLIENT_MESSAGE_MAX_BYTES: usize = 2 * 1024;
const SESSION_ID_MAX_BYTES: usize = 128;
const PAGE_ID_MAX_BYTES: usize = 256;
const PARTICIPANT_ID_MAX_BYTES: usize = 64;
const DISPLAY_NAME_MAX_BYTES: usize = 80;
const MAX_PARTICIPANTS: usize = 32;
const MAX_PIXEL_STREAMS_PER_PARTICIPANT: usize = 2;
// Preserve one steady pixel stream plus one short token-rotation overlap for
// every admitted collaboration participant. A runtime-wide cap equal to only
// the steady-state participant count makes the replacement socket lose the
// race whenever every participant is already viewing.
const MAX_PIXEL_STREAMS_TOTAL: usize = MAX_PARTICIPANTS * MAX_PIXEL_STREAMS_PER_PARTICIPANT;
// A mounted viewer normally owns one input socket. Permit one short overlap so
// the frontend can rotate its signed token without dropping control between
// closing the old socket and the origin observing that close.
const MAX_INPUT_STREAMS_PER_PARTICIPANT: usize = 2;
const MAX_INPUT_STREAMS_TOTAL: usize = MAX_PARTICIPANTS * MAX_INPUT_STREAMS_PER_PARTICIPANT;
const OUTBOUND_QUEUE_CAPACITY: usize = 16;
const JOIN_TIMEOUT: Duration = Duration::from_secs(5);
const PARTICIPANT_GRACE: Duration = Duration::from_secs(10);
const EXPIRY_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const COLLABORATION_FRAMES_PER_SECOND: usize = 120;
const CONTROL_ACTIONS_PER_WINDOW: usize = 12;
const CONTROL_ACTION_WINDOW: Duration = Duration::from_secs(10);
// Cursor movement is presentation-only. Coalesce every participant's updates
// behind one hub-wide timer so one noisy client (or many clients moving at
// once) cannot turn each input packet into a full-state fan-out.
const CURSOR_PUBLISH_INTERVAL: Duration = Duration::from_millis(50);
const AGENT_CONTROL_REFRESH_MIN_INTERVAL: Duration = Duration::from_millis(100);

const PARTICIPANT_COLORS: [&str; 8] = [
    "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5",
];

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum ClientMessage {
    Join {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "pageId")]
        page_id: Option<String>,
    },
    Heartbeat {
        #[serde(rename = "pageId")]
        page_id: Option<String>,
    },
    Cursor {
        #[serde(rename = "pageId")]
        page_id: String,
        // The assembled runtime enables serde_json/arbitrary_precision through
        // Cargo feature unification. Keep wire numbers as Number here because
        // direct f64 fields in this strict tagged enum are rejected in that graph.
        x: serde_json::Number,
        y: serde_json::Number,
    },
    RequestControl {},
    TakeControl {},
    ReleaseControl {},
    GrantControl {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    Leave {},
}

impl ClientMessage {
    fn affects_control(&self) -> bool {
        matches!(
            self,
            Self::RequestControl { .. }
                | Self::TakeControl { .. }
                | Self::ReleaseControl { .. }
                | Self::GrantControl { .. }
        )
    }
}

#[derive(Debug)]
struct SocketRateLimit {
    accepted_at: VecDeque<Instant>,
    limit: usize,
    window: Duration,
}

impl SocketRateLimit {
    fn new(limit: usize, window: Duration) -> Self {
        debug_assert!(limit > 0);
        debug_assert!(!window.is_zero());
        Self {
            accepted_at: VecDeque::with_capacity(limit),
            limit,
            window,
        }
    }

    fn take(&mut self) -> bool {
        self.take_at(Instant::now())
    }

    fn take_at(&mut self, now: Instant) -> bool {
        while self
            .accepted_at
            .front()
            .is_some_and(|accepted_at| now.saturating_duration_since(*accepted_at) >= self.window)
        {
            self.accepted_at.pop_front();
        }
        if self.accepted_at.len() >= self.limit {
            return false;
        }
        self.accepted_at.push_back(now);
        true
    }
}

impl ClientMessage {
    fn parse(value: &str) -> Result<Self, OriginError> {
        if value.len() > CLIENT_MESSAGE_MAX_BYTES {
            return Err(OriginError::bad_request(
                "browser collaboration message is too large",
            ));
        }
        serde_json::from_str(value)
            .map_err(|_| OriginError::bad_request("invalid browser collaboration message"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct CursorSnapshot {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParticipantSnapshot {
    id: String,
    display_name: String,
    color: String,
    page_id: Option<String>,
    cursor: Option<CursorSnapshot>,
    can_control: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ControlOwnerSnapshot {
    Human {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    Agent {
        #[serde(rename = "displayName")]
        display_name: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Welcome {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    State {
        revision: u64,
        participants: Vec<ParticipantSnapshot>,
        #[serde(rename = "controlOwner")]
        control_owner: Option<ControlOwnerSnapshot>,
        requests: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum ControlOwner {
    Human {
        participant_id: String,
    },
    #[allow(dead_code)]
    Agent {
        owner_id: String,
        run_id: String,
        display_name: String,
        expires_at_ms: u64,
    },
}

impl ControlOwner {
    fn snapshot(&self) -> ControlOwnerSnapshot {
        match self {
            Self::Human { participant_id } => ControlOwnerSnapshot::Human {
                participant_id: participant_id.clone(),
            },
            Self::Agent { display_name, .. } => ControlOwnerSnapshot::Agent {
                display_name: display_name.clone(),
            },
        }
    }
}

struct Participant {
    id: String,
    subject: String,
    session_id: String,
    display_name: String,
    color: String,
    page_id: Option<String>,
    cursor: Option<CursorSnapshot>,
    can_control: bool,
    expires_at_unix_seconds: i64,
    last_seen: Instant,
    connection_id: Option<Uuid>,
    sender: Option<mpsc::Sender<String>>,
    control_action_rate_limit: SocketRateLimit,
}

impl Participant {
    fn snapshot(&self) -> ParticipantSnapshot {
        ParticipantSnapshot {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            color: self.color.clone(),
            page_id: self.page_id.clone(),
            cursor: self.cursor,
            can_control: self.can_control,
        }
    }
}

#[derive(Default)]
struct HubState {
    revision: u64,
    participants: HashMap<String, Participant>,
    control_owner: Option<ControlOwner>,
    suspended_human_owner: Option<String>,
    requests: VecDeque<String>,
    cursor_dirty: bool,
    cursor_publish_scheduled: bool,
}

impl HubState {
    fn server_state(&self) -> ServerMessage {
        let mut participants: Vec<ParticipantSnapshot> = self
            .participants
            .values()
            .map(Participant::snapshot)
            .collect();
        participants.sort_by(|left, right| left.id.cmp(&right.id));
        ServerMessage::State {
            revision: self.revision,
            participants,
            control_owner: self.control_owner.as_ref().map(ControlOwner::snapshot),
            requests: self.requests.iter().cloned().collect(),
        }
    }

    fn publish(&mut self) {
        // Every state publication includes the latest cursor snapshots, even
        // when it was triggered by a control or presence change.
        self.cursor_dirty = false;
        self.revision = self.revision.saturating_add(1);
        let payload = serde_json::to_string(&self.server_state())
            .expect("browser collaboration state must serialize");
        for participant in self.participants.values_mut() {
            if let Some(sender) = participant.sender.as_ref() {
                match sender.try_send(payload.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => {
                        // Never leave a slow client on a stale control-owner
                        // snapshot. Bound memory, close its authority-bearing
                        // collaboration connection, and let it reconnect to
                        // the latest state after the queued snapshots drain.
                        participant.sender = None;
                        participant.connection_id = None;
                    }
                }
            }
        }
    }

    fn promote_next_request(&mut self) {
        if matches!(self.control_owner, Some(ControlOwner::Agent { .. })) {
            return;
        }
        while let Some(participant_id) = self.requests.pop_front() {
            if self
                .participants
                .get(&participant_id)
                .is_some_and(|participant| participant.can_control)
            {
                self.control_owner = Some(ControlOwner::Human { participant_id });
                return;
            }
        }
    }

    fn remove_participant(&mut self, participant_id: &str) -> bool {
        if self.participants.remove(participant_id).is_none() {
            return false;
        }
        self.requests.retain(|request| request != participant_id);
        if self.suspended_human_owner.as_deref() == Some(participant_id) {
            self.suspended_human_owner = None;
        }
        if matches!(
            self.control_owner.as_ref(),
            Some(ControlOwner::Human { participant_id: owner }) if owner == participant_id
        ) {
            self.control_owner = None;
            self.promote_next_request();
        }
        true
    }

    fn sync_agent_control(&mut self, observation: AgentControlMarkerObservation) -> bool {
        match observation {
            AgentControlMarkerObservation::Active(marker) => {
                let public_state_changed = match self.control_owner.as_ref() {
                    Some(ControlOwner::Agent { display_name, .. }) => {
                        display_name != &marker.display_name
                    }
                    Some(ControlOwner::Human { participant_id }) => {
                        self.suspended_human_owner = Some(participant_id.clone());
                        true
                    }
                    None => true,
                };
                self.control_owner = Some(ControlOwner::Agent {
                    owner_id: marker.owner_id,
                    run_id: marker.run_id,
                    display_name: marker.display_name,
                    expires_at_ms: marker.expires_at_ms,
                });
                public_state_changed
            }
            AgentControlMarkerObservation::Inactive => {
                if !matches!(self.control_owner, Some(ControlOwner::Agent { .. })) {
                    return false;
                }
                self.control_owner = self
                    .suspended_human_owner
                    .take()
                    .filter(|participant_id| {
                        self.participants
                            .get(participant_id)
                            .is_some_and(|participant| participant.can_control)
                    })
                    .map(|participant_id| ControlOwner::Human { participant_id });
                if self.control_owner.is_none() {
                    self.promote_next_request();
                }
                true
            }
            AgentControlMarkerObservation::Unavailable(_) => {
                // An unreadable marker cannot prove that an active agent has
                // yielded. Preserve a known agent owner, or install a bounded
                // presentation-only sentinel that blocks all human mutation
                // until a later read proves Active or Inactive.
                if matches!(self.control_owner, Some(ControlOwner::Agent { .. })) {
                    return false;
                }
                if let Some(ControlOwner::Human { participant_id }) = self.control_owner.as_ref() {
                    self.suspended_human_owner = Some(participant_id.clone());
                }
                self.control_owner = Some(ControlOwner::Agent {
                    owner_id: "marker-unavailable".to_string(),
                    run_id: "marker-unavailable".to_string(),
                    display_name: "Assistant".to_string(),
                    expires_at_ms: u64::MAX,
                });
                true
            }
        }
    }

    fn expire_stale(&mut self, now: Instant) -> bool {
        let now_unix_seconds = unix_time_seconds();
        let expired: Vec<String> = self
            .participants
            .values()
            .filter(|participant| {
                participant.expires_at_unix_seconds <= now_unix_seconds
                    || now.saturating_duration_since(participant.last_seen) >= PARTICIPANT_GRACE
            })
            .map(|participant| participant.id.clone())
            .collect();
        let mut changed = false;
        for participant_id in expired {
            changed |= self.remove_participant(&participant_id);
        }
        changed
    }
}

struct JoinedConnection {
    participant_id: String,
    connection_id: Uuid,
    receiver: mpsc::Receiver<String>,
}

#[derive(Default)]
struct AgentControlRefresh {
    last_checked: Option<Instant>,
}

#[derive(Default)]
struct PixelStreamAdmissions {
    total: usize,
    by_participant: HashMap<String, usize>,
}

#[derive(Default)]
struct InputStreamAdmissions {
    total: usize,
    by_participant: HashMap<String, usize>,
}

/// Socket-lifetime admission for transports that expose live browser pixels.
/// A synchronous mutex keeps Drop deterministic on every WebSocket exit path.
pub(crate) struct PixelStreamAdmission {
    admissions: Arc<StdMutex<PixelStreamAdmissions>>,
    participant_id: String,
}

impl Drop for PixelStreamAdmission {
    fn drop(&mut self) {
        let mut admissions = match self.admissions.lock() {
            Ok(admissions) => admissions,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(count) = admissions.by_participant.get_mut(&self.participant_id) {
            if *count > 1 {
                *count -= 1;
            } else {
                admissions.by_participant.remove(&self.participant_id);
            }
            admissions.total = admissions.total.saturating_sub(1);
        }
    }
}

/// Socket-lifetime admission for the bounded CDP input channel. The guard is
/// acquired before target resolution/upgrading, so rejected sockets never open
/// a Chromium debugging connection. Two slots per signed surface cover only a
/// token-rotation overlap; the runtime-wide ceiling remains authoritative.
pub(crate) struct InputStreamAdmission {
    admissions: Arc<StdMutex<InputStreamAdmissions>>,
    participant_id: String,
}

impl Drop for InputStreamAdmission {
    fn drop(&mut self) {
        let mut admissions = match self.admissions.lock() {
            Ok(admissions) => admissions,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(count) = admissions.by_participant.get_mut(&self.participant_id) {
            if *count > 1 {
                *count -= 1;
            } else {
                admissions.by_participant.remove(&self.participant_id);
            }
            admissions.total = admissions.total.saturating_sub(1);
        }
    }
}

#[derive(Clone)]
pub struct BrowserCollaborationHub {
    state: Arc<Mutex<HubState>>,
    approval_bridge: BrowserApprovalBridge,
    agent_control_refresh: Arc<Mutex<AgentControlRefresh>>,
    pixel_stream_admissions: Arc<StdMutex<PixelStreamAdmissions>>,
    input_stream_admissions: Arc<StdMutex<InputStreamAdmissions>>,
}

impl Default for BrowserCollaborationHub {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState::default())),
            approval_bridge: BrowserApprovalBridge::default(),
            agent_control_refresh: Arc::new(Mutex::new(AgentControlRefresh::default())),
            pixel_stream_admissions: Arc::new(StdMutex::new(PixelStreamAdmissions::default())),
            input_stream_admissions: Arc::new(StdMutex::new(InputStreamAdmissions::default())),
        }
    }
}

impl BrowserCollaborationHub {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn new_with_agent_control_path(path: PathBuf) -> Self {
        let approval_dir = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/tmp"))
            .join("approvals");
        Self {
            state: Arc::new(Mutex::new(HubState::default())),
            approval_bridge: BrowserApprovalBridge::for_test(path, approval_dir),
            agent_control_refresh: Arc::new(Mutex::new(AgentControlRefresh::default())),
            pixel_stream_admissions: Arc::new(StdMutex::new(PixelStreamAdmissions::default())),
            input_stream_admissions: Arc::new(StdMutex::new(InputStreamAdmissions::default())),
        }
    }

    pub(crate) fn approval_bridge(&self) -> &BrowserApprovalBridge {
        &self.approval_bridge
    }

    async fn refresh_agent_control(&self, force: bool) {
        let mut refresh = self.agent_control_refresh.lock().await;
        let now = Instant::now();
        if !force
            && refresh.last_checked.is_some_and(|last_checked| {
                now.saturating_duration_since(last_checked) < AGENT_CONTROL_REFRESH_MIN_INTERVAL
            })
        {
            return;
        }
        let marker = self.approval_bridge.read_agent_control().await;
        if let AgentControlMarkerObservation::Unavailable(error) = &marker {
            warn!(
                path = %self.approval_bridge.marker_path().display(),
                %error,
                "Shared Browser agent-control marker is unavailable; preserving fail-closed authority"
            );
        }
        refresh.last_checked = Some(now);
        let mut state = self.state.lock().await;
        if state.sync_agent_control(marker) {
            state.publish();
        }
    }

    pub(crate) fn admit_pixel_stream(
        &self,
        claims: &OriginClaims,
    ) -> Result<PixelStreamAdmission, OriginError> {
        validated_claim_expiry(claims)?;
        if !claims.scopes.iter().any(|scope| scope == "browser.view") {
            return Err(OriginError::unauthorized(
                "browser.view is required for Shared Browser pixels",
            ));
        }
        let session_id = validated_claim_session_id(claims)?;
        let participant_id = participant_id_for_claims(claims, session_id)?;
        let mut admissions = self.pixel_stream_admissions.lock().map_err(|_| {
            OriginError::unavailable("Shared Browser pixel admission is unavailable")
        })?;
        if admissions.total >= MAX_PIXEL_STREAMS_TOTAL {
            return Err(OriginError::unavailable(
                "Shared Browser pixel stream capacity is full",
            ));
        }
        let participant_count = admissions
            .by_participant
            .get(&participant_id)
            .copied()
            .unwrap_or_default();
        if participant_count >= MAX_PIXEL_STREAMS_PER_PARTICIPANT {
            return Err(OriginError::unavailable(
                "Shared Browser participant pixel stream capacity is full",
            ));
        }
        admissions.total += 1;
        admissions
            .by_participant
            .insert(participant_id.clone(), participant_count + 1);
        drop(admissions);
        Ok(PixelStreamAdmission {
            admissions: self.pixel_stream_admissions.clone(),
            participant_id,
        })
    }

    pub(crate) fn admit_input_stream(
        &self,
        claims: &OriginClaims,
    ) -> Result<InputStreamAdmission, OriginError> {
        validated_claim_expiry(claims)?;
        if !claims.scopes.iter().any(|scope| scope == "browser.control") {
            return Err(OriginError::unauthorized(
                "browser.control is required for Shared Browser input",
            ));
        }
        let session_id = validated_claim_session_id(claims)?;
        let participant_id = participant_id_for_claims(claims, session_id)?;
        let mut admissions = self.input_stream_admissions.lock().map_err(|_| {
            OriginError::unavailable("Shared Browser input admission is unavailable")
        })?;
        if admissions.total >= MAX_INPUT_STREAMS_TOTAL {
            return Err(OriginError::unavailable(
                "Shared Browser input stream capacity is full",
            ));
        }
        let participant_count = admissions
            .by_participant
            .get(&participant_id)
            .copied()
            .unwrap_or_default();
        if participant_count >= MAX_INPUT_STREAMS_PER_PARTICIPANT {
            return Err(OriginError::unavailable(
                "Shared Browser participant input stream capacity is full",
            ));
        }
        admissions.total += 1;
        admissions
            .by_participant
            .insert(participant_id.clone(), participant_count + 1);
        drop(admissions);
        Ok(InputStreamAdmission {
            admissions: self.input_stream_admissions.clone(),
            participant_id,
        })
    }

    async fn join(
        &self,
        claims: &OriginClaims,
        session_id: &str,
        page_id: Option<&str>,
    ) -> Result<JoinedConnection, OriginError> {
        // Joining may assign control, so it must observe a newly-created agent
        // marker rather than relying on the presentation refresh cache.
        self.refresh_agent_control(true).await;
        validated_claim_expiry(claims)?;
        let expires_at_unix_seconds = claims
            .exp
            .expect("validated browser claims must carry an expiry");
        let claim_session_id = validated_claim_session_id(claims)?;
        let session_id = validate_session_id(session_id)?;
        if claim_session_id != session_id {
            return Err(OriginError::unauthorized(
                "browser collaboration session does not match its signed token",
            ));
        }
        if !claims.scopes.iter().any(|scope| scope == "browser.view") {
            return Err(OriginError::unauthorized(
                "browser collaboration requires browser.view",
            ));
        }
        let page_id = validate_optional_page_id(page_id)?;
        let participant_id = participant_id_for_claims(claims, claim_session_id)?;
        let can_control = claims.scopes.iter().any(|scope| scope == "browser.control");
        let display_name = normalized_display_name(claims.actor_label.as_deref());
        let color = participant_color(&participant_id).to_string();
        let connection_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        let now = Instant::now();

        let mut state = self.state.lock().await;
        if state.expire_stale(now) {
            state.publish();
        }
        if let Some(participant) = state.participants.get_mut(&participant_id) {
            if participant.subject != claims.sub || participant.session_id != claim_session_id {
                return Err(OriginError::unauthorized(
                    "browser collaboration participant identity mismatch",
                ));
            }
            if participant.page_id != page_id {
                participant.page_id = page_id;
                participant.cursor = None;
            }
            participant.display_name = display_name;
            participant.color = color;
            participant.can_control = can_control;
            participant.expires_at_unix_seconds = expires_at_unix_seconds;
            participant.last_seen = now;
            participant.connection_id = Some(connection_id);
            participant.sender = Some(sender);
        } else {
            if state.participants.len() >= MAX_PARTICIPANTS {
                return Err(OriginError::unavailable(
                    "Shared Browser collaboration is full",
                ));
            }
            state.participants.insert(
                participant_id.clone(),
                Participant {
                    id: participant_id.clone(),
                    subject: claims.sub.clone(),
                    session_id: claim_session_id.to_string(),
                    display_name,
                    color,
                    page_id,
                    cursor: None,
                    can_control,
                    expires_at_unix_seconds,
                    last_seen: now,
                    connection_id: Some(connection_id),
                    sender: Some(sender),
                    control_action_rate_limit: SocketRateLimit::new(
                        CONTROL_ACTIONS_PER_WINDOW,
                        CONTROL_ACTION_WINDOW,
                    ),
                },
            );
        }

        if !can_control
            && matches!(
                state.control_owner.as_ref(),
                Some(ControlOwner::Human { participant_id: owner }) if owner == &participant_id
            )
        {
            state.control_owner = None;
            state.promote_next_request();
        }
        if !can_control && state.suspended_human_owner.as_deref() == Some(participant_id.as_str()) {
            state.suspended_human_owner = None;
        }
        if can_control
            && state.suspended_human_owner.is_none()
            && matches!(state.control_owner, Some(ControlOwner::Agent { .. }))
        {
            state.suspended_human_owner = Some(participant_id.clone());
        }
        if state.control_owner.is_none() && can_control {
            state.control_owner = Some(ControlOwner::Human {
                participant_id: participant_id.clone(),
            });
            state.requests.retain(|request| request != &participant_id);
        }
        state.publish();

        Ok(JoinedConnection {
            participant_id,
            connection_id,
            receiver,
        })
    }

    async fn apply_message(
        &self,
        participant_id: &str,
        connection_id: Uuid,
        message: ClientMessage,
    ) -> Result<bool, OriginError> {
        if message.affects_control() {
            // Control mutations are authority decisions; never admit one from
            // the short marker-read cache after an agent has taken control.
            self.refresh_agent_control(true).await;
        }
        let now = Instant::now();
        let mut state = self.state.lock().await;
        let expired = state.expire_stale(now);
        let Some(participant) = state.participants.get_mut(participant_id) else {
            if expired {
                state.publish();
            }
            return Err(OriginError::unauthorized(
                "browser collaboration participant expired",
            ));
        };
        if participant.connection_id != Some(connection_id) {
            if expired {
                state.publish();
            }
            return Err(OriginError::unauthorized(
                "browser collaboration connection was replaced",
            ));
        }
        participant.last_seen = now;

        let mut changed = expired;
        let mut schedule_cursor_publish = false;
        match message {
            ClientMessage::Join { .. } => {
                return Err(OriginError::bad_request(
                    "browser collaboration join must be the first message",
                ));
            }
            ClientMessage::Heartbeat { page_id } => {
                let page_id = validate_optional_page_id(page_id.as_deref())?;
                let participant = state
                    .participants
                    .get_mut(participant_id)
                    .expect("participant checked above");
                if participant.page_id != page_id {
                    participant.page_id = page_id;
                    participant.cursor = None;
                    changed = true;
                }
            }
            ClientMessage::Cursor { page_id, x, y } => {
                let page_id = validate_page_id(&page_id)?;
                let cursor = validate_cursor_numbers(&x, &y)?;
                let cursor_changed = {
                    let participant = state
                        .participants
                        .get_mut(participant_id)
                        .expect("participant checked above");
                    let cursor_changed = participant.page_id.as_deref() != Some(page_id.as_str())
                        || participant.cursor != Some(cursor);
                    if cursor_changed {
                        participant.page_id = Some(page_id);
                        participant.cursor = Some(cursor);
                    }
                    cursor_changed
                };
                if cursor_changed {
                    state.cursor_dirty = true;
                    if !state.cursor_publish_scheduled {
                        state.cursor_publish_scheduled = true;
                        schedule_cursor_publish = true;
                    }
                }
            }
            ClientMessage::RequestControl { .. } => {
                ensure_participant_can_control(&state, participant_id)?;
                if !is_human_owner(&state, participant_id) {
                    if state.control_owner.is_none() {
                        state.control_owner = Some(ControlOwner::Human {
                            participant_id: participant_id.to_string(),
                        });
                        state.requests.retain(|request| request != participant_id);
                        changed = true;
                    } else if !state
                        .requests
                        .iter()
                        .any(|request| request == participant_id)
                    {
                        state.requests.push_back(participant_id.to_string());
                        changed = true;
                    }
                }
            }
            ClientMessage::TakeControl { .. } => {
                ensure_participant_can_control(&state, participant_id)?;
                if !is_human_owner(&state, participant_id) {
                    if state.control_owner.is_some() {
                        return Err(OriginError::conflict(
                            "Shared Browser control is already held",
                        ));
                    }
                    state.control_owner = Some(ControlOwner::Human {
                        participant_id: participant_id.to_string(),
                    });
                    state.requests.retain(|request| request != participant_id);
                    changed = true;
                }
            }
            ClientMessage::ReleaseControl { .. } => {
                let removed_request = state
                    .requests
                    .iter()
                    .any(|request| request == participant_id);
                state.requests.retain(|request| request != participant_id);
                changed |= removed_request;
                if state.suspended_human_owner.as_deref() == Some(participant_id) {
                    state.suspended_human_owner = None;
                    changed = true;
                }
                if is_human_owner(&state, participant_id) {
                    state.control_owner = None;
                    state.promote_next_request();
                    changed = true;
                }
            }
            ClientMessage::GrantControl {
                participant_id: target_id,
            } => {
                let target_id = validate_participant_id(&target_id)?;
                if !is_human_owner(&state, participant_id) {
                    return Err(OriginError::unauthorized(
                        "only the current Shared Browser controller may grant control",
                    ));
                }
                ensure_participant_can_control(&state, target_id)?;
                if target_id != participant_id {
                    state.control_owner = Some(ControlOwner::Human {
                        participant_id: target_id.to_string(),
                    });
                    state.requests.retain(|request| request != target_id);
                    changed = true;
                }
            }
            ClientMessage::Leave { .. } => {
                changed |= state.remove_participant(participant_id);
                if changed {
                    state.publish();
                }
                return Ok(false);
            }
        }

        if changed {
            state.publish();
        }
        drop(state);
        if schedule_cursor_publish {
            let hub = self.clone();
            tokio::spawn(async move {
                sleep(CURSOR_PUBLISH_INTERVAL).await;
                hub.flush_cursor_updates().await;
            });
        }
        Ok(true)
    }

    async fn admit_control_action(&self, participant_id: &str, connection_id: Uuid) -> bool {
        let mut state = self.state.lock().await;
        state
            .participants
            .get_mut(participant_id)
            .filter(|participant| participant.connection_id == Some(connection_id))
            .is_some_and(|participant| participant.control_action_rate_limit.take())
    }

    async fn flush_cursor_updates(&self) {
        let mut state = self.state.lock().await;
        state.cursor_publish_scheduled = false;
        if state.cursor_dirty {
            state.publish();
        }
    }

    async fn disconnect(&self, participant_id: &str, connection_id: Uuid) {
        let mut state = self.state.lock().await;
        if let Some(participant) = state.participants.get_mut(participant_id) {
            if participant.connection_id == Some(connection_id) {
                participant.connection_id = None;
                participant.sender = None;
            }
        }
    }

    async fn expire_and_connection_is_current(
        &self,
        participant_id: &str,
        connection_id: Uuid,
    ) -> bool {
        self.refresh_agent_control(false).await;
        let mut state = self.state.lock().await;
        if state.expire_stale(Instant::now()) {
            state.publish();
        }
        state
            .participants
            .get(participant_id)
            .is_some_and(|participant| participant.connection_id == Some(connection_id))
    }

    pub async fn assert_human_control(&self, claims: &OriginClaims) -> Result<(), OriginError> {
        validated_claim_expiry(claims)?;
        // Input authorization must observe agent preemption on the very next
        // message. The 100 ms cache is only for non-authority polling.
        self.refresh_agent_control(true).await;
        if !claims.scopes.iter().any(|scope| scope == "browser.control") {
            return Err(OriginError::unauthorized(
                "browser.control is required for Shared Browser input",
            ));
        }
        let session_id = validated_claim_session_id(claims)?;
        let participant_id = participant_id_for_claims(claims, session_id)?;
        let mut state = self.state.lock().await;
        if state.expire_stale(Instant::now()) {
            state.publish();
        }
        let participant_holds_control =
            state
                .participants
                .get(&participant_id)
                .is_some_and(|participant| {
                    participant.subject == claims.sub
                        && participant.session_id == session_id
                        && participant.can_control
                })
                && is_human_owner(&state, &participant_id);
        if participant_holds_control {
            Ok(())
        } else {
            Err(OriginError::conflict(
                "Shared Browser control is held by another participant",
            ))
        }
    }

    pub async fn has_human_control(&self, claims: &OriginClaims) -> bool {
        self.assert_human_control(claims).await.is_ok()
    }
}

fn ensure_participant_can_control<'a>(
    state: &'a HubState,
    participant_id: &str,
) -> Result<&'a Participant, OriginError> {
    state
        .participants
        .get(participant_id)
        .filter(|participant| participant.can_control)
        .ok_or_else(|| {
            OriginError::unauthorized(
                "participant does not have permission to control the Shared Browser",
            )
        })
}

fn is_human_owner(state: &HubState, participant_id: &str) -> bool {
    matches!(
        state.control_owner.as_ref(),
        Some(ControlOwner::Human { participant_id: owner }) if owner == participant_id
    )
}

fn validated_claim_session_id(claims: &OriginClaims) -> Result<&str, OriginError> {
    let session_id = claims
        .browser_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            OriginError::unauthorized("browser collaboration token is missing its session")
        })?;
    validate_session_id(session_id)
}

fn participant_id_for_claims(
    claims: &OriginClaims,
    session_id: &str,
) -> Result<String, OriginError> {
    let subject = claims.sub.trim();
    if subject.is_empty() || subject.len() > 512 {
        return Err(OriginError::unauthorized(
            "browser collaboration token subject is invalid",
        ));
    }
    let project_id = claims.project_id.trim();
    if project_id.is_empty() || project_id.len() > 64 {
        return Err(OriginError::unauthorized(
            "browser collaboration token project is invalid",
        ));
    }
    let material = format!("instafy:shared-browser:{project_id}:{subject}:{session_id}");
    Ok(Uuid::new_v5(&Uuid::NAMESPACE_URL, material.as_bytes()).to_string())
}

fn validate_session_id(value: &str) -> Result<&str, OriginError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > SESSION_ID_MAX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(OriginError::bad_request(
            "browser collaboration session id is invalid",
        ));
    }
    Ok(value)
}

fn validate_optional_page_id(value: Option<&str>) -> Result<Option<String>, OriginError> {
    value.map(validate_page_id).transpose()
}

fn validate_page_id(value: &str) -> Result<String, OriginError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > PAGE_ID_MAX_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(OriginError::bad_request(
            "browser collaboration page id is invalid",
        ));
    }
    Ok(value.to_string())
}

fn validate_participant_id(value: &str) -> Result<&str, OriginError> {
    let value = value.trim();
    if value.is_empty() || value.len() > PARTICIPANT_ID_MAX_BYTES || Uuid::parse_str(value).is_err()
    {
        return Err(OriginError::bad_request(
            "browser collaboration participant id is invalid",
        ));
    }
    Ok(value)
}

fn validate_cursor(x: f64, y: f64) -> Result<CursorSnapshot, OriginError> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err(OriginError::bad_request(
            "browser collaboration cursor must use normalized coordinates",
        ));
    }
    Ok(CursorSnapshot { x, y })
}

fn validate_cursor_numbers(
    x: &serde_json::Number,
    y: &serde_json::Number,
) -> Result<CursorSnapshot, OriginError> {
    let Some(x) = x.as_f64() else {
        return Err(OriginError::bad_request(
            "browser collaboration cursor must use finite coordinates",
        ));
    };
    let Some(y) = y.as_f64() else {
        return Err(OriginError::bad_request(
            "browser collaboration cursor must use finite coordinates",
        ));
    };
    validate_cursor(x, y)
}

fn normalized_display_name(raw: Option<&str>) -> String {
    let normalized = raw
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = truncate_utf8(&normalized, DISPLAY_NAME_MAX_BYTES);
    if normalized.is_empty() {
        "Teammate".to_string()
    } else {
        normalized
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn participant_color(participant_id: &str) -> &'static str {
    let hash = participant_id
        .as_bytes()
        .iter()
        .fold(0x811c9dc5_u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(0x01000193)
        });
    PARTICIPANT_COLORS[hash as usize % PARTICIPANT_COLORS.len()]
}

#[cfg(test)]
fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn unix_time_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub async fn handle_collaboration_ws(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    ws: WebSocketUpgrade,
) -> Result<Response, OriginError> {
    validated_claim_expiry(&claims)?;
    validated_claim_session_id(&claims)?;
    Ok(ws
        .max_message_size(CLIENT_MESSAGE_MAX_BYTES)
        .max_frame_size(CLIENT_MESSAGE_MAX_BYTES)
        .on_upgrade(move |socket| run_collaboration_socket(socket, state, claims)))
}

async fn run_collaboration_socket(mut socket: WebSocket, state: AppState, claims: OriginClaims) {
    let mut inbound_rate_limit =
        SocketRateLimit::new(COLLABORATION_FRAMES_PER_SECOND, Duration::from_secs(1));
    let first_frame = match timeout(JOIN_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(message))) => message,
        _ => {
            let _ = socket.send(WsMessage::Close(None)).await;
            return;
        }
    };
    // Count the join as the first inbound frame. This also keeps the ordering
    // explicit: every later frame consumes ingress capacity before token,
    // marker, participant, or control-owner work.
    if !inbound_rate_limit.take() {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let first_message = match first_frame {
        WsMessage::Text(text) => match ClientMessage::parse(&text) {
            Ok(message) => message,
            Err(error) => {
                warn!(error = %error, "Shared Browser collaboration join message was rejected");
                let _ = socket.send(WsMessage::Close(None)).await;
                return;
            }
        },
        _ => {
            let _ = socket.send(WsMessage::Close(None)).await;
            return;
        }
    };
    let (session_id, page_id) = match first_message {
        ClientMessage::Join {
            session_id,
            page_id,
        } => (session_id, page_id),
        _ => {
            warn!("Shared Browser collaboration socket did not start with join");
            let _ = socket.send(WsMessage::Close(None)).await;
            return;
        }
    };
    let joined = match state
        .browser_collaboration
        .join(&claims, &session_id, page_id.as_deref())
        .await
    {
        Ok(joined) => joined,
        Err(error) => {
            warn!(error = %error, "Shared Browser collaboration participant join was rejected");
            let _ = socket.send(WsMessage::Close(None)).await;
            return;
        }
    };

    let welcome = serde_json::to_string(&ServerMessage::Welcome {
        participant_id: joined.participant_id.clone(),
    })
    .expect("browser collaboration welcome must serialize");
    if socket.send(WsMessage::Text(welcome)).await.is_err() {
        state
            .browser_collaboration
            .disconnect(&joined.participant_id, joined.connection_id)
            .await;
        return;
    }

    let participant_id = joined.participant_id;
    let connection_id = joined.connection_id;
    let mut outbound = joined.receiver;
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let mut expiry_timer = interval(EXPIRY_CHECK_INTERVAL);
    expiry_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            inbound = socket_receiver.next() => {
                let message = match inbound {
                    Some(Ok(message)) => message,
                    Some(Err(error)) => {
                        warn!(
                            participant_id = %participant_id,
                            error = %error,
                            "Shared Browser collaboration socket receive failed"
                        );
                        break;
                    }
                    None => break,
                };
                if !inbound_rate_limit.take() {
                    warn!(
                        participant_id = %participant_id,
                        "Shared Browser collaboration socket exceeded its ingress rate limit"
                    );
                    break;
                }
                if let Err(error) = validated_claim_expiry(&claims) {
                    warn!(
                        participant_id = %participant_id,
                        error = %error,
                        "Shared Browser collaboration token expired"
                    );
                    break;
                }
                let message = match message {
                    WsMessage::Text(text) => match ClientMessage::parse(&text) {
                        Ok(message) => message,
                        Err(error) => {
                            warn!(
                                participant_id = %participant_id,
                                error = %error,
                                "Shared Browser collaboration message was invalid"
                            );
                            break;
                        }
                    },
                    WsMessage::Ping(payload) => {
                        if socket_sender.send(WsMessage::Pong(payload)).await.is_err() {
                            warn!(
                                participant_id = %participant_id,
                                "Shared Browser collaboration pong failed"
                            );
                            break;
                        }
                        continue;
                    }
                    WsMessage::Pong(_) => continue,
                    WsMessage::Close(_) => break,
                    WsMessage::Binary(_) => {
                        warn!(
                            participant_id = %participant_id,
                            "Shared Browser collaboration rejected a binary message"
                        );
                        break;
                    }
                };
                if message.affects_control()
                    && !state
                        .browser_collaboration
                        .admit_control_action(&participant_id, connection_id)
                        .await
                {
                    warn!(
                        participant_id = %participant_id,
                        "Shared Browser collaboration socket exceeded its control-action rate limit"
                    );
                    break;
                }
                match state
                    .browser_collaboration
                    .apply_message(&participant_id, connection_id, message)
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        warn!(
                            participant_id = %participant_id,
                            error = %error,
                            "Shared Browser collaboration message was rejected"
                        );
                        break;
                    }
                }
            }
            payload = outbound.recv() => {
                let Some(payload) = payload else {
                    debug!(
                        participant_id = %participant_id,
                        "Shared Browser collaboration outbound channel closed"
                    );
                    break;
                };
                if socket_sender.send(WsMessage::Text(payload)).await.is_err() {
                    warn!(
                        participant_id = %participant_id,
                        "Shared Browser collaboration state delivery failed"
                    );
                    break;
                }
            }
            _ = expiry_timer.tick() => {
                if !state
                    .browser_collaboration
                    .expire_and_connection_is_current(&participant_id, connection_id)
                    .await
                {
                    debug!(
                        participant_id = %participant_id,
                        "Shared Browser collaboration participant expired or was replaced"
                    );
                    break;
                }
            }
        }
    }

    state
        .browser_collaboration
        .disconnect(&participant_id, connection_id)
        .await;
    let _ = socket_sender.send(WsMessage::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker_json(
        owner_id: Uuid,
        run_id: Uuid,
        initiator_user_id: Uuid,
        expires_at_ms: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "version": 2,
            "ownerId": owner_id,
            "runId": run_id,
            "initiatorUserId": initiator_user_id,
            "browserPageId": "PAGE1",
            "displayName": "Octo",
            "expiresAtMs": expires_at_ms,
        })
    }

    fn write_test_marker(path: &std::path::Path, value: &serde_json::Value) {
        std::fs::write(path, serde_json::to_vec(value).expect("marker json"))
            .expect("write marker");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .expect("protect marker");
        }
    }

    fn test_hub() -> BrowserCollaborationHub {
        BrowserCollaborationHub::new_with_agent_control_path(std::env::temp_dir().join(format!(
            "instafy-collaboration-test-missing-{}",
            Uuid::new_v4()
        )))
    }

    fn claims(session_id: &str, label: Option<&str>, can_control: bool) -> OriginClaims {
        let mut scopes = vec!["browser.view".to_string()];
        if can_control {
            scopes.push("browser.control".to_string());
        }
        OriginClaims {
            aud: Uuid::new_v4().to_string(),
            sub: Uuid::new_v4().to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: Some(Uuid::new_v4().to_string()),
            runtime_id: Some(Uuid::new_v4().to_string()),
            protocol: Some("http".to_string()),
            scopes,
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            iat: None,
            exp: Some(unix_time_seconds() + 60 * 60),
            jti: Some(Uuid::new_v4().to_string()),
            actor_label: label.map(str::to_string),
            browser_session_id: Some(session_id.to_string()),
        }
    }

    #[test]
    fn client_contract_rejects_unknown_and_sensitive_fields() {
        assert!(ClientMessage::parse(
            r#"{"type":"join","sessionId":"session-1","pageId":"PAGE1"}"#
        )
        .is_ok());
        assert!(
            ClientMessage::parse(r#"{"type":"join","sessionId":"session-1","pageId":null}"#)
                .is_ok()
        );
        assert!(ClientMessage::parse(
            r#"{"type":"cursor","pageId":"ABE88080EA7DD137184DA6F36A5D07BE","x":0.5484,"y":0.4795}"#
        )
        .is_ok());
        for payload in [
            r#"{"type":"join","sessionId":"session-1","pageId":"PAGE1","url":"https://secret.test"}"#,
            r#"{"type":"cursor","pageId":"PAGE1","x":0.5,"y":0.5,"text":"password"}"#,
            r#"{"type":"heartbeat","pageId":"PAGE1","password":"secret"}"#,
            r#"{"type":"requestControl","label":"Admin"}"#,
            r#"{"type":"leave","extra":true}"#,
        ] {
            assert!(ClientMessage::parse(payload).is_err(), "accepted {payload}");
        }
        assert!(ClientMessage::parse(&"x".repeat(CLIENT_MESSAGE_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn collaboration_ingress_and_control_actions_have_bounded_sliding_windows() {
        let now = Instant::now();
        let mut ingress =
            SocketRateLimit::new(COLLABORATION_FRAMES_PER_SECOND, Duration::from_secs(1));
        for _ in 0..COLLABORATION_FRAMES_PER_SECOND {
            assert!(ingress.take_at(now));
        }
        assert!(!ingress.take_at(now));
        assert!(ingress.take_at(now + Duration::from_secs(1)));

        let mut control = SocketRateLimit::new(CONTROL_ACTIONS_PER_WINDOW, CONTROL_ACTION_WINDOW);
        for _ in 0..CONTROL_ACTIONS_PER_WINDOW {
            assert!(control.take_at(now));
        }
        assert!(!control.take_at(now));
        assert!(control.take_at(now + CONTROL_ACTION_WINDOW));
    }

    #[tokio::test]
    async fn control_action_abuse_budget_survives_connection_replacement() {
        let hub = test_hub();
        let controller = claims("control-budget-session", Some("Controller"), true);
        let first = hub
            .join(&controller, "control-budget-session", Some("PAGE1"))
            .await
            .expect("first controller join");
        for _ in 0..CONTROL_ACTIONS_PER_WINDOW {
            assert!(
                hub.admit_control_action(&first.participant_id, first.connection_id)
                    .await
            );
        }
        assert!(
            !hub.admit_control_action(&first.participant_id, first.connection_id)
                .await
        );

        let replacement = hub
            .join(&controller, "control-budget-session", Some("PAGE1"))
            .await
            .expect("replacement controller join");
        assert_eq!(replacement.participant_id, first.participant_id);
        assert!(
            !hub.admit_control_action(&replacement.participant_id, replacement.connection_id)
                .await,
            "token rotation must not reset the participant's abuse budget"
        );
    }

    #[test]
    fn cursor_coordinates_and_ids_are_strictly_bounded() {
        assert_eq!(
            validate_cursor(0.0, 1.0).expect("normalized cursor"),
            CursorSnapshot { x: 0.0, y: 1.0 }
        );
        assert!(validate_cursor(-0.01, 0.5).is_err());
        assert!(validate_cursor(0.5, 1.01).is_err());
        assert!(validate_cursor(f64::NAN, 0.5).is_err());
        assert!(validate_page_id("PAGE_1-2").is_ok());
        assert!(validate_page_id("https://example.test").is_err());
        assert!(validate_session_id("session-1.device:tab").is_ok());
        assert!(validate_session_id("session 1").is_err());
    }

    #[tokio::test]
    async fn first_controller_auto_acquires_and_can_grant_control() {
        let hub = test_hub();
        let first = claims("session-first", Some("Taylor"), true);
        let second = claims("session-second", Some("Anna"), true);
        let first_join = hub
            .join(&first, "session-first", Some("PAGE1"))
            .await
            .expect("first join");
        let second_join = hub
            .join(&second, "session-second", Some("PAGE2"))
            .await
            .expect("second join");

        assert!(hub.has_human_control(&first).await);
        assert!(!hub.has_human_control(&second).await);
        hub.apply_message(
            &second_join.participant_id,
            second_join.connection_id,
            ClientMessage::RequestControl {},
        )
        .await
        .expect("request control");
        hub.apply_message(
            &first_join.participant_id,
            first_join.connection_id,
            ClientMessage::GrantControl {
                participant_id: second_join.participant_id.clone(),
            },
        )
        .await
        .expect("grant control");

        assert!(!hub.has_human_control(&first).await);
        assert!(hub.has_human_control(&second).await);
        let state = hub.state.lock().await;
        assert!(state.requests.is_empty());
        assert_eq!(state.participants.len(), 2);
    }

    #[tokio::test]
    async fn cursor_flood_is_coalesced_into_one_hub_wide_publication() {
        let hub = test_hub();
        let viewer = claims("cursor-session", Some("Viewer"), false);
        let mut joined = hub
            .join(&viewer, "cursor-session", Some("PAGE1"))
            .await
            .expect("viewer join");
        while joined.receiver.try_recv().is_ok() {}
        let initial_revision = hub.state.lock().await.revision;

        for index in 0..200 {
            hub.apply_message(
                &joined.participant_id,
                joined.connection_id,
                ClientMessage::Cursor {
                    page_id: "PAGE1".to_string(),
                    x: serde_json::Number::from_f64(f64::from(index) / 200.0)
                        .expect("finite x coordinate"),
                    y: serde_json::Number::from_f64(0.5).expect("finite y coordinate"),
                },
            )
            .await
            .expect("cursor update");
        }

        {
            let state = hub.state.lock().await;
            assert_eq!(state.revision, initial_revision);
            let participant = state
                .participants
                .get(&joined.participant_id)
                .expect("connected viewer");
            assert!(participant.connection_id.is_some());
            assert!(participant.sender.is_some());
        }

        sleep(CURSOR_PUBLISH_INTERVAL + Duration::from_millis(20)).await;
        let state = hub.state.lock().await;
        assert_eq!(state.revision, initial_revision + 1);
        assert!(!state.cursor_dirty);
        assert!(!state.cursor_publish_scheduled);
        drop(state);
        assert!(joined.receiver.try_recv().is_ok());
        assert!(joined.receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn view_only_participant_cannot_request_or_take_control() {
        let hub = test_hub();
        let viewer = claims("viewer-session", None, false);
        let joined = hub
            .join(&viewer, "viewer-session", Some("PAGE1"))
            .await
            .expect("viewer join");
        assert!(!hub.has_human_control(&viewer).await);
        assert!(hub
            .apply_message(
                &joined.participant_id,
                joined.connection_id,
                ClientMessage::RequestControl {},
            )
            .await
            .is_err());
        let state = hub.state.lock().await;
        assert!(state.control_owner.is_none());
        assert_eq!(
            state
                .participants
                .get(&joined.participant_id)
                .expect("viewer")
                .display_name,
            "Teammate"
        );
    }

    #[tokio::test]
    async fn disconnect_keeps_control_for_grace_then_expires_it() {
        let hub = test_hub();
        let controller = claims("controller-session", Some("Controller"), true);
        let joined = hub
            .join(&controller, "controller-session", Some("PAGE1"))
            .await
            .expect("controller join");
        hub.disconnect(&joined.participant_id, joined.connection_id)
            .await;
        assert!(hub.has_human_control(&controller).await);

        {
            let mut state = hub.state.lock().await;
            state
                .participants
                .get_mut(&joined.participant_id)
                .expect("participant")
                .last_seen = Instant::now() - PARTICIPANT_GRACE - Duration::from_millis(1);
        }
        assert!(!hub.has_human_control(&controller).await);
        let state = hub.state.lock().await;
        assert!(state.participants.is_empty());
        assert!(state.control_owner.is_none());
    }

    #[tokio::test]
    async fn signed_session_is_authoritative_and_reconnect_replaces_old_socket() {
        let hub = test_hub();
        let controller = claims("signed-session", Some("Controller"), true);
        assert!(hub
            .join(&controller, "different-session", Some("PAGE1"))
            .await
            .is_err());
        let first = hub
            .join(&controller, "signed-session", Some("PAGE1"))
            .await
            .expect("first socket");
        let second = hub
            .join(&controller, "signed-session", Some("PAGE1"))
            .await
            .expect("replacement socket");
        assert!(hub
            .apply_message(
                &first.participant_id,
                first.connection_id,
                ClientMessage::Heartbeat {
                    page_id: Some("PAGE1".to_string()),
                },
            )
            .await
            .is_err());
        assert!(hub
            .apply_message(
                &second.participant_id,
                second.connection_id,
                ClientMessage::Heartbeat {
                    page_id: Some("PAGE1".to_string()),
                },
            )
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn signed_expiry_is_enforced_for_join_input_and_socket_polling() {
        let hub = test_hub();
        let mut expired = claims("expired-session", Some("Expired"), true);
        expired.exp = Some(unix_time_seconds() - 1);
        assert!(hub
            .join(&expired, "expired-session", Some("PAGE1"))
            .await
            .is_err());
        expired.exp = None;
        assert!(hub
            .join(&expired, "expired-session", Some("PAGE1"))
            .await
            .is_err());

        let mut controller = claims("live-session", Some("Controller"), true);
        let joined = hub
            .join(&controller, "live-session", Some("PAGE1"))
            .await
            .expect("live join");
        assert!(hub.has_human_control(&controller).await);

        controller.exp = Some(unix_time_seconds() - 1);
        assert!(!hub.has_human_control(&controller).await);

        {
            let mut state = hub.state.lock().await;
            state
                .participants
                .get_mut(&joined.participant_id)
                .expect("participant")
                .expires_at_unix_seconds = unix_time_seconds() - 1;
        }
        assert!(hub
            .apply_message(
                &joined.participant_id,
                joined.connection_id,
                ClientMessage::Heartbeat {
                    page_id: Some("PAGE1".to_string()),
                },
            )
            .await
            .is_err());

        let poll_controller = claims("poll-session", Some("Poll controller"), true);
        let poll_joined = hub
            .join(&poll_controller, "poll-session", Some("PAGE1"))
            .await
            .expect("poll participant join");
        {
            let mut state = hub.state.lock().await;
            state
                .participants
                .get_mut(&poll_joined.participant_id)
                .expect("poll participant")
                .expires_at_unix_seconds = unix_time_seconds() - 1;
        }
        assert!(
            !hub.expire_and_connection_is_current(
                &poll_joined.participant_id,
                poll_joined.connection_id,
            )
            .await
        );
        let state = hub.state.lock().await;
        assert!(state.participants.is_empty());
        assert!(state.control_owner.is_none());
    }

    #[tokio::test]
    async fn agent_marker_preempts_until_explicit_absence_restores_human_control() {
        let directory = tempfile::tempdir().expect("tempdir");
        let marker_path = directory.path().join("agent-control.json");
        let hub = BrowserCollaborationHub::new_with_agent_control_path(marker_path.clone());
        let controller = claims("human-session", Some("Taylor"), true);
        hub.join(&controller, "human-session", Some("PAGE1"))
            .await
            .expect("human joins first");
        assert!(hub.has_human_control(&controller).await);

        let owner_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let initiator_user_id = Uuid::new_v4();
        write_test_marker(
            &marker_path,
            &marker_json(
                owner_id,
                run_id,
                initiator_user_id,
                unix_time_millis() + 12_000,
            ),
        );

        assert!(!hub.has_human_control(&controller).await);
        {
            let state = hub.state.lock().await;
            assert!(matches!(
                state.control_owner,
                Some(ControlOwner::Agent { ref display_name, .. }) if display_name == "Octo"
            ));
            let json = serde_json::to_value(state.server_state()).expect("state json");
            assert_eq!(json["controlOwner"]["kind"], "agent");
            assert_eq!(json["controlOwner"]["displayName"], "Octo");
        }

        std::fs::remove_file(&marker_path).expect("remove marker");
        assert!(hub.has_human_control(&controller).await);

        write_test_marker(
            &marker_path,
            &marker_json(
                owner_id,
                run_id,
                initiator_user_id,
                unix_time_millis() + 12_000,
            ),
        );
        assert!(!hub.has_human_control(&controller).await);
        write_test_marker(
            &marker_path,
            &marker_json(owner_id, run_id, initiator_user_id, unix_time_millis() - 1),
        );
        assert!(
            !hub.has_human_control(&controller).await,
            "marker expiry alone cannot prove that the agent stopped"
        );
        std::fs::remove_file(&marker_path).expect("remove expired marker");
        assert!(hub.has_human_control(&controller).await);
    }

    #[tokio::test]
    async fn unreadable_agent_marker_fails_closed_until_absence_is_proven() {
        let directory = tempfile::tempdir().expect("tempdir");
        let marker_path = directory.path().join("agent-control.json");
        let hub = BrowserCollaborationHub::new_with_agent_control_path(marker_path.clone());
        let controller = claims("human-session", Some("Taylor"), true);
        let controller_id = participant_id_for_claims(
            &controller,
            controller.browser_session_id.as_deref().expect("session"),
        )
        .expect("participant id");
        hub.join(&controller, "human-session", Some("PAGE1"))
            .await
            .expect("human joins first");
        assert!(hub.has_human_control(&controller).await);

        std::fs::write(&marker_path, b"{not-json").expect("corrupt marker");
        assert!(!hub.has_human_control(&controller).await);
        {
            let state = hub.state.lock().await;
            assert!(matches!(
                state.control_owner,
                Some(ControlOwner::Agent { ref owner_id, .. }) if owner_id == "marker-unavailable"
            ));
            assert_eq!(
                state.suspended_human_owner.as_deref(),
                Some(controller_id.as_str())
            );
        }

        // Repeated parse failures must preserve the fail-closed owner instead
        // of restoring human input. A definitive removal restores the prior
        // live participant immediately.
        assert!(!hub.has_human_control(&controller).await);
        std::fs::remove_file(&marker_path).expect("remove corrupt marker");
        assert!(hub.has_human_control(&controller).await);

        let owner_id = Uuid::new_v4();
        write_test_marker(
            &marker_path,
            &marker_json(
                owner_id,
                Uuid::new_v4(),
                Uuid::new_v4(),
                unix_time_millis() + 12_000,
            ),
        );
        assert!(!hub.has_human_control(&controller).await);
        std::fs::write(&marker_path, b"{still-not-json").expect("corrupt active marker");
        assert!(!hub.has_human_control(&controller).await);
        {
            let state = hub.state.lock().await;
            assert!(matches!(
                state.control_owner,
                Some(ControlOwner::Agent { owner_id: ref active_owner_id, .. })
                    if active_owner_id == &owner_id.to_string()
            ));
        }
        std::fs::remove_file(&marker_path).expect("remove corrupt active marker");
        assert!(hub.has_human_control(&controller).await);
    }

    #[tokio::test]
    async fn participant_count_is_bounded() {
        let hub = test_hub();
        for index in 0..MAX_PARTICIPANTS {
            let session_id = format!("session-{index}");
            let participant = claims(&session_id, Some("Teammate"), false);
            hub.join(&participant, &session_id, None)
                .await
                .expect("participant within cap");
        }
        let overflow = claims("overflow-session", Some("Overflow"), false);
        assert!(hub.join(&overflow, "overflow-session", None).await.is_err());
    }

    #[test]
    fn pixel_stream_admission_is_bounded_per_participant_and_runtime() {
        let hub = test_hub();
        let participant = claims("pixel-session", Some("Viewer"), false);
        let first = hub
            .admit_pixel_stream(&participant)
            .expect("first participant stream");
        let second = hub
            .admit_pixel_stream(&participant)
            .expect("second participant stream");
        assert!(hub.admit_pixel_stream(&participant).is_err());
        drop(first);
        let replacement = hub
            .admit_pixel_stream(&participant)
            .expect("released participant slot is reusable");
        drop(second);
        drop(replacement);

        assert_eq!(
            MAX_PIXEL_STREAMS_TOTAL,
            MAX_PARTICIPANTS * MAX_PIXEL_STREAMS_PER_PARTICIPANT
        );
        let viewers = (0..MAX_PARTICIPANTS)
            .map(|index| claims(&format!("pixel-viewer-{index}"), Some("Viewer"), false))
            .collect::<Vec<_>>();
        let mut admissions = Vec::new();
        for viewer in &viewers {
            admissions.push(
                hub.admit_pixel_stream(viewer)
                    .expect("steady pixel stream within runtime cap"),
            );
        }
        for viewer in &viewers {
            admissions.push(
                hub.admit_pixel_stream(viewer)
                    .expect("rotation overlap has reserved runtime headroom"),
            );
        }
        let overflow = claims("pixel-overflow", Some("Overflow"), false);
        assert!(hub.admit_pixel_stream(&overflow).is_err());
        drop(admissions.pop());
        assert!(hub.admit_pixel_stream(&overflow).is_ok());
    }

    #[test]
    fn input_stream_admission_is_bounded_and_allows_one_rotation_overlap() {
        let hub = test_hub();
        let participant = claims("input-session", Some("Controller"), true);
        let first = hub
            .admit_input_stream(&participant)
            .expect("steady-state input stream");
        let rotating = hub
            .admit_input_stream(&participant)
            .expect("token-rotation overlap");
        assert!(hub.admit_input_stream(&participant).is_err());
        drop(first);
        let replacement = hub
            .admit_input_stream(&participant)
            .expect("released overlap slot is reusable");
        drop(rotating);
        drop(replacement);

        let viewer = claims("view-only-session", Some("Viewer"), false);
        assert!(hub.admit_input_stream(&viewer).is_err());

        let mut missing_session = claims("missing-input-session", Some("Controller"), true);
        missing_session.browser_session_id = None;
        assert!(hub.admit_input_stream(&missing_session).is_err());

        let mut expired = claims("expired-input-session", Some("Expired"), true);
        expired.exp = Some(unix_time_seconds() - 1);
        assert!(hub.admit_input_stream(&expired).is_err());
    }

    #[test]
    fn input_stream_admission_is_bounded_across_the_runtime() {
        let hub = test_hub();
        assert_eq!(
            MAX_INPUT_STREAMS_TOTAL,
            MAX_PARTICIPANTS * MAX_INPUT_STREAMS_PER_PARTICIPANT
        );
        let controllers = (0..MAX_PARTICIPANTS)
            .map(|index| {
                claims(
                    &format!("input-controller-{index}"),
                    Some("Controller"),
                    true,
                )
            })
            .collect::<Vec<_>>();
        let mut admissions = Vec::new();
        for controller in &controllers {
            admissions.push(
                hub.admit_input_stream(controller)
                    .expect("steady input stream within runtime cap"),
            );
        }
        for controller in &controllers {
            admissions.push(
                hub.admit_input_stream(controller)
                    .expect("input rotation overlap has reserved runtime headroom"),
            );
        }
        let overflow = claims("input-overflow", Some("Overflow"), true);
        assert!(hub.admit_input_stream(&overflow).is_err());
        drop(admissions.pop());
        assert!(hub.admit_input_stream(&overflow).is_ok());
    }

    #[tokio::test]
    async fn agent_marker_reader_distinguishes_inactive_from_unavailable() {
        let directory = tempfile::tempdir().expect("tempdir");
        let marker_path = directory.path().join("agent-control.json");
        let mut legacy = marker_json(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            unix_time_millis() + 12_000,
        );
        legacy["version"] = serde_json::json!(1);
        write_test_marker(&marker_path, &legacy);
        assert!(matches!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Unavailable(_)
        ));

        let base = marker_json(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            unix_time_millis() - 1,
        );
        write_test_marker(&marker_path, &base);
        assert!(matches!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Active(_)
        ));

        let mut unknown = base;
        unknown["expiresAtMs"] = serde_json::json!(unix_time_millis() + 12_000);
        unknown["pageText"] = serde_json::json!("sensitive");
        write_test_marker(&marker_path, &unknown);
        assert!(matches!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Unavailable(_)
        ));

        std::fs::write(
            &marker_path,
            vec![b'x'; AGENT_CONTROL_FILE_MAX_BYTES as usize + 1],
        )
        .expect("oversized marker");
        assert!(matches!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Unavailable(_)
        ));

        std::fs::remove_file(&marker_path).expect("remove marker");
        std::fs::create_dir(&marker_path).expect("marker path directory");
        assert!(matches!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Unavailable(_)
        ));
        std::fs::remove_dir(&marker_path).expect("remove marker directory");
        assert_eq!(
            read_agent_control_marker(&marker_path).await,
            AgentControlMarkerObservation::Inactive
        );
    }

    #[test]
    fn state_contract_has_only_bounded_presence_and_control_fields() {
        let message = ServerMessage::State {
            revision: 7,
            participants: vec![ParticipantSnapshot {
                id: Uuid::nil().to_string(),
                display_name: "Teammate".to_string(),
                color: "#2563eb".to_string(),
                page_id: Some("PAGE1".to_string()),
                cursor: Some(CursorSnapshot { x: 0.25, y: 0.75 }),
                can_control: true,
            }],
            control_owner: Some(ControlOwnerSnapshot::Agent {
                display_name: "Octo".to_string(),
            }),
            requests: vec![Uuid::nil().to_string()],
        };
        let value = serde_json::to_value(message).expect("state json");
        assert_eq!(value["type"], "state");
        assert_eq!(value["controlOwner"]["kind"], "agent");
        assert_eq!(value["participants"][0]["canControl"], true);
        assert!(value.get("url").is_none());
        assert!(value.get("text").is_none());
    }
}
