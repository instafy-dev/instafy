//! Follow mode: one member presents a space site, the others follow it live.
//!
//! Each viewer renders a space site in their own frame, so data is shared but
//! the view is not. The presenter's Studio posts the site's view (an opaque
//! JSON blob of at most 2 KB, a map's bounds and selection, say) and taps here;
//! every other member following the same preview gets them over an SSE
//! stream and hands them to their own frame.
//!
//! Views never touch the shared `EventHub`: its one broadcast is shared by
//! every `/events` stream on a node, and a 10 Hz stream could lag it and lose
//! chat events. Each preview gets a "room" instead: a `watch` that holds only
//! the latest view (a slow follower skips views, which is right for a view),
//! a small `broadcast` for taps (a dropped tap is harmless) and a `watch` of
//! the room's presence. Only presence (live, away, ended, follower count) goes
//! out on the `EventHub`, as the rare `preview.follow` event.
//!
//! Nodes share rooms through their own Redis channel (`redis_bus::spawn_follow`,
//! `<ns>:controller:follow`). Every node applies every presentation message,
//! so each one holds the same presentations and computes the same away and
//! timeout transitions; presence events are published on each node's local
//! hub only. Without Redis the hub is in-process.
//!
//! Nothing is stored: there are no tables, payloads live only in memory as
//! the latest view of a live presentation, and logs record size and seq only.
//! Presenting and following do not count as activity in the space, so they
//! never keep a runtime up by themselves; a preview that stops or closes ends
//! its presentation.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, Weak};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::{broadcast, mpsc, watch, Notify};
use tokio::time::Instant;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, warn};
use uuid::Uuid;

use super::{
    ensure_preview_runtime_access, ensure_previews_available, load_preview_grant, ApiResult,
    PreviewGrant, PreviewPath,
};
use crate::auth::{authenticate_request, RequestContext};
use crate::config::PgPool;
use crate::connection_limit::ConnectionPermit;
use crate::state::{AppState, ControllerEvent, EventHub};
use crate::tunnels::{
    ensure_project_authorized, parse_required_uuid, resolve_canonical_tunnel_runtime_id,
};
use crate::{bad_request, forbidden, not_found, unauthorized, ApiError};

/// The presence event on the main `/events` stream.
pub(crate) const FOLLOW_EVENT_KIND: &str = "preview.follow";
/// A view or tap payload, as compact JSON.
pub(crate) const FOLLOW_PAYLOAD_MAX_BYTES: usize = 2048;
/// A POST body larger than this is refused before it is parsed.
const FOLLOW_BODY_MAX_BYTES: usize = 8 * 1024;
/// Follow streams per user, under their own key, so following never takes
/// one of the four `/events` slots.
pub(crate) const FOLLOW_STREAMS_PER_USER: usize = 2;
/// Previews one user may present at once.
pub(crate) const PRESENTATIONS_PER_USER: usize = 3;
const FOLLOW_KEEP_ALIVE: Duration = Duration::from_secs(15);
/// The longest presentation: a tab left presenting overnight ends.
const PRESENTATION_MAX_SECONDS: u64 = 4 * 60 * 60;
/// Each node re-announces its followers this often, and drops another
/// node's list it has not heard again within [`FOLLOWERS_REMOTE_TTL`].
const FOLLOWERS_REANNOUNCE: Duration = Duration::from_secs(30);
const FOLLOWERS_REMOTE_TTL: Duration = Duration::from_secs(90);
const TAP_CHANNEL_CAPACITY: usize = 16;
const STREAM_QUEUE: usize = 32;
/// The follow bus queue; a full queue drops the message (a view is
/// superseded by the next one anyway).
pub(crate) const FOLLOW_BUS_QUEUE: usize = 4096;
const PERSON_NAME_MAX_CHARS: usize = 80;
/// How long a node remembers a presentation that ended here, so a late view
/// for it reads "ended" rather than "unknown".
const ENDED_REMEMBERED: Duration = Duration::from_secs(10 * 60);
const ENDED_REMEMBERED_MAX: usize = 10_000;
/// `op:"present"` per user and preview: 3 within 3 s.
const PRESENTS_PER_WINDOW: usize = 3;
const PRESENT_WINDOW: Duration = Duration::from_secs(3);
const FALLBACK_NAME: &str = "Someone";

/// Timeouts and rates. Tests shorten them; production uses the defaults.
#[derive(Clone, Debug)]
pub(crate) struct FollowLimits {
    /// A presenter who sends nothing (no view, tap or heartbeat) this long
    /// turns away.
    pub(crate) away_after: Duration,
    /// An away presentation ends after this much more.
    pub(crate) end_after_away: Duration,
    /// The longest presentation.
    pub(crate) max_duration: Duration,
    pub(crate) views_per_second: f64,
    pub(crate) view_burst: f64,
    pub(crate) taps_per_second: f64,
    pub(crate) tap_burst: f64,
}

impl Default for FollowLimits {
    fn default() -> Self {
        Self {
            away_after: Duration::from_secs(15),
            end_after_away: Duration::from_secs(120),
            max_duration: Duration::from_secs(PRESENTATION_MAX_SECONDS),
            views_per_second: 20.0,
            view_burst: 40.0,
            taps_per_second: 5.0,
            tap_burst: 5.0,
        }
    }
}

/// A member as the follow routes show them. Names come from the account
/// profile, never from the client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FollowPerson {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) avatar_url: Option<String>,
}

impl FollowPerson {
    fn short(&self) -> JsonValue {
        json!({ "id": self.id, "name": self.name })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationInfo {
    pub(crate) presentation_id: Uuid,
    pub(crate) project_id: Uuid,
    /// The preview's conversation: the presence event carries it, so
    /// private-conversation visibility applies as for any event.
    #[serde(default)]
    pub(crate) conversation_id: Option<Uuid>,
    /// The preview's runtime: named in the presence event, so a member who
    /// cannot see a private runtime does not see its presentations either.
    #[serde(default)]
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) presenter: FollowPerson,
    pub(crate) started_at: DateTime<Utc>,
    /// Whom this presentation took over from.
    #[serde(default)]
    pub(crate) replaced: Option<FollowPerson>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EndReason {
    Stopped,
    Replaced,
    Timeout,
    Closed,
    Access,
}

/// One view or tap of a presentation.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FollowFrame {
    pub(crate) presentation_id: Uuid,
    pub(crate) seq: u64,
    pub(crate) payload: JsonValue,
    pub(crate) at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EndNotice {
    pub(crate) presentation_id: Uuid,
    pub(crate) presenter_id: Uuid,
    pub(crate) reason: EndReason,
}

/// A room's presence, as its streams watch it.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RoomSignal {
    /// The presentation and whether its presenter is away.
    pub(crate) presentation: Option<(PresentationInfo, bool)>,
    /// Who follows, without the presenter.
    pub(crate) followers: Vec<FollowPerson>,
    /// The last presentation that ended or was taken over.
    pub(crate) end: Option<EndNotice>,
}

impl RoomSignal {
    fn presentation_id(&self) -> Option<Uuid> {
        self.presentation
            .as_ref()
            .map(|(info, _)| info.presentation_id)
    }
}

/// What travels between nodes on `<ns>:controller:follow`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum FollowBusMessage {
    #[serde(rename_all = "camelCase")]
    Present {
        preview_id: String,
        info: PresentationInfo,
    },
    /// A view; without a payload, the presenter's heartbeat.
    #[serde(rename_all = "camelCase")]
    View {
        preview_id: String,
        presentation_id: Uuid,
        seq: u64,
        #[serde(default)]
        payload: Option<JsonValue>,
        at: DateTime<Utc>,
    },
    #[serde(rename_all = "camelCase")]
    Tap {
        preview_id: String,
        presentation_id: Uuid,
        seq: u64,
        payload: JsonValue,
        at: DateTime<Utc>,
    },
    #[serde(rename_all = "camelCase")]
    End {
        preview_id: String,
        presentation_id: Uuid,
        reason: EndReason,
    },
    /// The sending node's followers of one preview (empty: none any more).
    #[serde(rename_all = "camelCase")]
    Followers {
        preview_id: String,
        project_id: Uuid,
        followers: Vec<FollowPerson>,
    },
}

impl FollowBusMessage {
    pub(crate) fn preview_id(&self) -> &str {
        match self {
            Self::Present { preview_id, .. }
            | Self::View { preview_id, .. }
            | Self::Tap { preview_id, .. }
            | Self::End { preview_id, .. }
            | Self::Followers { preview_id, .. } => preview_id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct FollowEnvelope {
    pub(crate) source: String,
    pub(crate) message: FollowBusMessage,
}

/// Why a presenter's POST was refused.
#[derive(Debug, PartialEq)]
pub(crate) enum FollowReject {
    /// Someone else presents now (last one wins).
    Replaced(FollowPerson),
    /// The presentation is over (stopped, timed out, closed).
    Ended,
    /// This node has never heard of the presentation: with several nodes,
    /// its `Present` may still be on the way. The client tries again
    /// shortly, and only then gives up.
    Unknown,
    /// The caller is not the presenter of this presentation.
    NotPresenter,
    RateLimited(Duration),
    TooManyPresentations,
}

struct TokenBucket {
    tokens: f64,
    updated: Instant,
    rate: f64,
    burst: f64,
}

impl TokenBucket {
    fn new(rate: f64, burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            updated: now,
            rate,
            burst,
        }
    }

    fn take(&mut self, now: Instant) -> Result<(), Duration> {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        self.updated = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64(
                (1.0 - self.tokens) / self.rate.max(f64::EPSILON),
            ))
        }
    }
}

struct Presentation {
    info: PresentationInfo,
    started: Instant,
    last_seen: Instant,
    away: bool,
    seq: Option<u64>,
    views: TokenBucket,
    taps: TokenBucket,
}

impl Presentation {
    fn new(info: PresentationInfo, now: Instant, limits: &FollowLimits) -> Self {
        Self {
            info,
            started: now,
            last_seen: now,
            away: false,
            seq: None,
            views: TokenBucket::new(limits.views_per_second, limits.view_burst, now),
            taps: TokenBucket::new(limits.taps_per_second, limits.tap_burst, now),
        }
    }

    fn state(&self) -> &'static str {
        if self.away {
            "away"
        } else {
            "live"
        }
    }
}

struct Room {
    project_id: Uuid,
    presentation: Option<Presentation>,
    last_end: Option<EndNotice>,
    /// This node's follow streams, by stream id.
    local: HashMap<u64, FollowPerson>,
    /// Other nodes' followers, by node id, with when they were heard.
    remote: HashMap<String, (Instant, Vec<FollowPerson>)>,
    announced_at: Option<Instant>,
    /// (presentation, state, followers) of the last presence event.
    presence: Option<(Uuid, &'static str, usize)>,
    signal: watch::Sender<RoomSignal>,
    views: watch::Sender<Option<FollowFrame>>,
    taps: broadcast::Sender<FollowFrame>,
}

impl Room {
    fn new(project_id: Uuid) -> Self {
        let (signal, _) = watch::channel(RoomSignal::default());
        let (views, _) = watch::channel(None);
        let (taps, _) = broadcast::channel(TAP_CHANNEL_CAPACITY);
        Self {
            project_id,
            presentation: None,
            last_end: None,
            local: HashMap::new(),
            remote: HashMap::new(),
            announced_at: None,
            presence: None,
            signal,
            views,
            taps,
        }
    }

    fn is_idle(&self) -> bool {
        self.presentation.is_none() && self.local.is_empty() && self.remote.is_empty()
    }

    fn local_followers(&self) -> Vec<FollowPerson> {
        let mut seen = HashSet::new();
        let mut people: Vec<FollowPerson> = self
            .local
            .values()
            .filter(|person| seen.insert(person.id))
            .cloned()
            .collect();
        people.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        people
    }

    /// Everyone following on any node, once each, without the presenter.
    fn followers(&self) -> Vec<FollowPerson> {
        let presenter = self
            .presentation
            .as_ref()
            .map(|presentation| presentation.info.presenter.id);
        let mut seen = HashSet::new();
        let mut people: Vec<FollowPerson> = self
            .local
            .values()
            .chain(self.remote.values().flat_map(|(_, people)| people.iter()))
            .filter(|person| Some(person.id) != presenter && seen.insert(person.id))
            .cloned()
            .collect();
        people.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        people
    }
}

struct HubInner {
    node_id: String,
    limits: FollowLimits,
    events: EventHub,
    outbound: Option<mpsc::Sender<FollowEnvelope>>,
    rooms: StdMutex<HashMap<String, Room>>,
    /// Presentations that ended on this node, and how. Locked after `rooms`.
    ended: StdMutex<HashMap<Uuid, (Instant, EndReason)>>,
    next_stream: AtomicU64,
    wake: Arc<Notify>,
    sweeper_started: AtomicBool,
}

/// The follow-mode relay of one controller node. Cheap to clone.
#[derive(Clone)]
pub(crate) struct FollowHub {
    inner: Arc<HubInner>,
}

/// One open follow stream's place in a room; dropping it leaves.
pub(crate) struct FollowSubscription {
    hub: FollowHub,
    preview_id: String,
    stream_id: u64,
    pub(crate) signal: watch::Receiver<RoomSignal>,
    pub(crate) views: watch::Receiver<Option<FollowFrame>>,
    pub(crate) taps: broadcast::Receiver<FollowFrame>,
}

impl Drop for FollowSubscription {
    fn drop(&mut self) {
        self.hub.unfollow(&self.preview_id, self.stream_id);
    }
}

impl FollowHub {
    pub(crate) fn new(events: EventHub, outbound: Option<mpsc::Sender<FollowEnvelope>>) -> Self {
        Self::with_limits(events, outbound, FollowLimits::default())
    }

    pub(crate) fn with_limits(
        events: EventHub,
        outbound: Option<mpsc::Sender<FollowEnvelope>>,
        limits: FollowLimits,
    ) -> Self {
        Self {
            inner: Arc::new(HubInner {
                node_id: Uuid::new_v4().to_string(),
                limits,
                events,
                outbound,
                rooms: StdMutex::new(HashMap::new()),
                ended: StdMutex::new(HashMap::new()),
                next_stream: AtomicU64::new(1),
                wake: Arc::new(Notify::new()),
                sweeper_started: AtomicBool::new(false),
            }),
        }
    }

    /// A hub whose presence events reach no stream: for test states that
    /// never use follow mode.
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        Self::new(EventHub::new(), None)
    }

    pub(crate) fn bus_channel() -> (mpsc::Sender<FollowEnvelope>, mpsc::Receiver<FollowEnvelope>) {
        mpsc::channel(FOLLOW_BUS_QUEUE)
    }

    pub(crate) fn node_id(&self) -> &str {
        &self.inner.node_id
    }

    fn rooms(&self) -> MutexGuard<'_, HashMap<String, Room>> {
        self.inner
            .rooms
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn ended(&self) -> MutexGuard<'_, HashMap<Uuid, (Instant, EndReason)>> {
        self.inner
            .ended
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn remember_end(&self, presentation_id: Uuid, reason: EndReason, now: Instant) {
        let mut ended = self.ended();
        if ended.len() >= 1024 {
            ended.retain(|_, (at, _)| now.saturating_duration_since(*at) < ENDED_REMEMBERED);
        }
        if ended.len() >= ENDED_REMEMBERED_MAX {
            if let Some(oldest) = ended
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(id, _)| *id)
            {
                ended.remove(&oldest);
            }
        }
        ended.insert(presentation_id, (now, reason));
    }

    fn send_bus(&self, message: FollowBusMessage) {
        let Some(outbound) = &self.inner.outbound else {
            return;
        };
        if let Err(error) = outbound.try_send(FollowEnvelope {
            source: self.inner.node_id.clone(),
            message,
        }) {
            debug!(%error, "follow bus queue refused a message");
        }
    }

    /// Start the timer task on first use, inside the runtime that uses the
    /// hub, and wake it to recompute its next deadline.
    fn kick(&self) {
        if !self.inner.sweeper_started.swap(true, Ordering::SeqCst) {
            tokio::spawn(sweep_loop(
                Arc::downgrade(&self.inner),
                self.inner.wake.clone(),
            ));
        }
        self.inner.wake.notify_one();
    }

    fn publish_presence(
        &self,
        preview_id: &str,
        info: &PresentationInfo,
        state: &str,
        followers: usize,
        reason: Option<EndReason>,
    ) {
        let mut data = json!({
            "previewId": preview_id,
            "presentationId": info.presentation_id,
            "state": state,
            "presenter": info.presenter.short(),
            "followers": followers,
        });
        // why it ended ("timeout": the presenter's screen went away), so
        // Studio can say so instead of "stopped presenting"
        if let Some(reason) = reason {
            data["reason"] = json!(reason);
        }
        if let Some(runtime_id) = info.runtime_id {
            data["runtimeId"] = json!(runtime_id);
        }
        // Every node applies every presentation message itself, so each one
        // announces presence to its own streams only.
        self.inner.events.publish_local(ControllerEvent {
            kind: FOLLOW_EVENT_KIND.to_string(),
            project_id: Some(info.project_id),
            session_id: None,
            conversation_id: info.conversation_id,
            run_id: None,
            job_id: None,
            channel: None,
            channels: Vec::new(),
            target_user_id: None,
            data,
            timestamp: Utc::now(),
        });
    }

    /// Bring the room's watched presence up to date, and announce a change
    /// of presentation, state or follower count.
    fn refresh(&self, preview_id: &str, room: &mut Room) {
        let followers = room.followers();
        let count = followers.len();
        let signal = RoomSignal {
            presentation: room
                .presentation
                .as_ref()
                .map(|presentation| (presentation.info.clone(), presentation.away)),
            followers,
            end: room.last_end.clone(),
        };
        room.signal.send_if_modified(|current| {
            if *current == signal {
                false
            } else {
                *current = signal;
                true
            }
        });
        if let Some(presentation) = &room.presentation {
            let key = (
                presentation.info.presentation_id,
                presentation.state(),
                count,
            );
            if room.presence != Some(key) {
                room.presence = Some(key);
                self.publish_presence(
                    preview_id,
                    &presentation.info,
                    presentation.state(),
                    count,
                    None,
                );
            }
        }
    }

    fn install(&self, preview_id: &str, room: &mut Room, info: PresentationInfo, now: Instant) {
        if let Some(previous) = room.presentation.take() {
            self.remember_end(previous.info.presentation_id, EndReason::Replaced, now);
            room.last_end = Some(EndNotice {
                presentation_id: previous.info.presentation_id,
                presenter_id: previous.info.presenter.id,
                reason: EndReason::Replaced,
            });
        }
        room.views.send_replace(None);
        room.presentation = Some(Presentation::new(info, now, &self.inner.limits));
        room.presence = None;
        self.refresh(preview_id, room);
    }

    fn finish(
        &self,
        preview_id: &str,
        room: &mut Room,
        presentation_id: Uuid,
        reason: EndReason,
    ) -> bool {
        if room
            .presentation
            .as_ref()
            .map(|presentation| presentation.info.presentation_id)
            != Some(presentation_id)
        {
            return false;
        }
        let Some(ended) = room.presentation.take() else {
            return false;
        };
        self.remember_end(presentation_id, reason, Instant::now());
        room.last_end = Some(EndNotice {
            presentation_id,
            presenter_id: ended.info.presenter.id,
            reason,
        });
        room.views.send_replace(None);
        room.presence = None;
        let followers = room.followers().len();
        self.publish_presence(preview_id, &ended.info, "ended", followers, Some(reason));
        self.refresh(preview_id, room);
        true
    }

    /// Start presenting `preview_id`; the last one wins. Fails only when the
    /// presenter already presents [`PRESENTATIONS_PER_USER`] other previews.
    pub(crate) fn present(
        &self,
        preview_id: &str,
        project_id: Uuid,
        conversation_id: Option<Uuid>,
        runtime_id: Option<Uuid>,
        presenter: FollowPerson,
    ) -> Result<PresentationInfo, FollowReject> {
        let now = Instant::now();
        let info = {
            let mut rooms = self.rooms();
            let elsewhere = rooms
                .iter()
                .filter(|(key, room)| {
                    key.as_str() != preview_id
                        && room.presentation.as_ref().is_some_and(|presentation| {
                            presentation.info.presenter.id == presenter.id
                        })
                })
                .count();
            if elsewhere >= PRESENTATIONS_PER_USER {
                return Err(FollowReject::TooManyPresentations);
            }
            let room = rooms
                .entry(preview_id.to_string())
                .or_insert_with(|| Room::new(project_id));
            let mut started_at = Utc::now();
            let mut replaced = None;
            if let Some(current) = &room.presentation {
                // Nodes order presentations by start time; a new one must
                // sort after the one it replaces even with clock skew.
                if current.info.started_at >= started_at {
                    started_at = current.info.started_at + chrono::Duration::milliseconds(1);
                }
                if current.info.presenter.id != presenter.id {
                    replaced = Some(current.info.presenter.clone());
                }
            }
            let info = PresentationInfo {
                presentation_id: Uuid::new_v4(),
                project_id,
                conversation_id,
                runtime_id,
                presenter,
                started_at,
                replaced,
            };
            self.install(preview_id, room, info.clone(), now);
            info
        };
        self.send_bus(FollowBusMessage::Present {
            preview_id: preview_id.to_string(),
            info: info.clone(),
        });
        self.kick();
        Ok(info)
    }

    /// Check the caller presents `presentation_id` now. A presentation this
    /// node never heard of is [`FollowReject::Unknown`], not ended: with
    /// several nodes its `Present` may not have arrived yet.
    fn presenter_room<'a>(
        &self,
        rooms: &'a mut HashMap<String, Room>,
        preview_id: &str,
        presentation_id: Uuid,
        user_id: Uuid,
    ) -> Result<&'a mut Room, FollowReject> {
        let current = rooms
            .get(preview_id)
            .and_then(|room| room.presentation.as_ref())
            .map(|presentation| presentation.info.clone());
        match current {
            Some(info) if info.presentation_id == presentation_id => {
                if info.presenter.id != user_id {
                    return Err(FollowReject::NotPresenter);
                }
                rooms.get_mut(preview_id).ok_or(FollowReject::Unknown)
            }
            current => match self
                .ended()
                .get(&presentation_id)
                .map(|(_, reason)| *reason)
            {
                Some(EndReason::Replaced) => Err(current
                    .map(|info| FollowReject::Replaced(info.presenter))
                    .unwrap_or(FollowReject::Ended)),
                Some(_) => Err(FollowReject::Ended),
                None => Err(FollowReject::Unknown),
            },
        }
    }

    /// The presenter's view, or without `payload` a heartbeat.
    pub(crate) fn view(
        &self,
        preview_id: &str,
        presentation_id: Uuid,
        user_id: Uuid,
        seq: u64,
        payload: Option<JsonValue>,
    ) -> Result<(), FollowReject> {
        let now = Instant::now();
        let at = Utc::now();
        let mut republish = None;
        {
            let mut rooms = self.rooms();
            let room = self.presenter_room(&mut rooms, preview_id, presentation_id, user_id)?;
            let Some(presentation) = room.presentation.as_mut() else {
                return Err(FollowReject::Ended);
            };
            presentation
                .views
                .take(now)
                .map_err(FollowReject::RateLimited)?;
            // A heartbeat announces the presentation again, so a node that
            // missed its `Present` (Redis was down, say) learns it within one
            // heartbeat. A node that has it already ignores the repeat.
            if payload.is_none() {
                republish = Some(presentation.info.clone());
            }
            self.apply_view(
                preview_id,
                room,
                presentation_id,
                seq,
                payload.clone(),
                at,
                now,
            );
        }
        if let Some(info) = republish {
            self.send_bus(FollowBusMessage::Present {
                preview_id: preview_id.to_string(),
                info,
            });
        }
        self.send_bus(FollowBusMessage::View {
            preview_id: preview_id.to_string(),
            presentation_id,
            seq,
            payload,
            at,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_view(
        &self,
        preview_id: &str,
        room: &mut Room,
        presentation_id: Uuid,
        seq: u64,
        payload: Option<JsonValue>,
        at: DateTime<Utc>,
        now: Instant,
    ) {
        let Some(presentation) = room.presentation.as_mut() else {
            return;
        };
        if presentation.info.presentation_id != presentation_id {
            return;
        }
        presentation.last_seen = now;
        let was_away = std::mem::replace(&mut presentation.away, false);
        if let Some(payload) = payload {
            // Views can pass each other on the way; an older one never
            // replaces a newer one.
            if presentation.seq.is_none_or(|last| seq > last) {
                presentation.seq = Some(seq);
                room.views.send_replace(Some(FollowFrame {
                    presentation_id,
                    seq,
                    payload,
                    at,
                }));
            }
        }
        if was_away {
            self.refresh(preview_id, room);
            // The timer waits for the away presentation's end; it must
            // now wait for the next away instead.
            self.kick();
        }
    }

    /// A tap of the presenter: `payload` is `{x, y}` in 0..1 of the frame,
    /// plus an optional site-defined `at`.
    pub(crate) fn tap(
        &self,
        preview_id: &str,
        presentation_id: Uuid,
        user_id: Uuid,
        seq: u64,
        payload: JsonValue,
    ) -> Result<(), FollowReject> {
        let now = Instant::now();
        let at = Utc::now();
        {
            let mut rooms = self.rooms();
            let room = self.presenter_room(&mut rooms, preview_id, presentation_id, user_id)?;
            let Some(presentation) = room.presentation.as_mut() else {
                return Err(FollowReject::Ended);
            };
            presentation
                .taps
                .take(now)
                .map_err(FollowReject::RateLimited)?;
            self.apply_tap(
                preview_id,
                room,
                presentation_id,
                seq,
                payload.clone(),
                at,
                now,
            );
        }
        self.send_bus(FollowBusMessage::Tap {
            preview_id: preview_id.to_string(),
            presentation_id,
            seq,
            payload,
            at,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_tap(
        &self,
        preview_id: &str,
        room: &mut Room,
        presentation_id: Uuid,
        seq: u64,
        payload: JsonValue,
        at: DateTime<Utc>,
        now: Instant,
    ) {
        let Some(presentation) = room.presentation.as_mut() else {
            return;
        };
        if presentation.info.presentation_id != presentation_id {
            return;
        }
        presentation.last_seen = now;
        let was_away = std::mem::replace(&mut presentation.away, false);
        let _ = room.taps.send(FollowFrame {
            presentation_id,
            seq,
            payload,
            at,
        });
        if was_away {
            self.refresh(preview_id, room);
            // The timer waits for the away presentation's end; it must
            // now wait for the next away instead.
            self.kick();
        }
    }

    /// The presenter stops. `false` when the presentation was already over
    /// or is someone else's.
    pub(crate) fn stop(&self, preview_id: &str, presentation_id: Uuid, user_id: Uuid) -> bool {
        let stopped = {
            let mut rooms = self.rooms();
            match self.presenter_room(&mut rooms, preview_id, presentation_id, user_id) {
                Ok(room) => self.finish(preview_id, room, presentation_id, EndReason::Stopped),
                Err(_) => false,
            }
        };
        if stopped {
            self.send_bus(FollowBusMessage::End {
                preview_id: preview_id.to_string(),
                presentation_id,
                reason: EndReason::Stopped,
            });
            self.gc(preview_id);
        }
        stopped
    }

    /// End whatever presentation the preview has (it was closed, say).
    pub(crate) fn end_preview(&self, preview_id: &str, reason: EndReason) {
        let ended = {
            let mut rooms = self.rooms();
            let Some(room) = rooms.get_mut(preview_id) else {
                return;
            };
            let Some(presentation_id) = room
                .presentation
                .as_ref()
                .map(|presentation| presentation.info.presentation_id)
            else {
                return;
            };
            self.finish(preview_id, room, presentation_id, reason)
                .then_some(presentation_id)
        };
        if let Some(presentation_id) = ended {
            self.send_bus(FollowBusMessage::End {
                preview_id: preview_id.to_string(),
                presentation_id,
                reason,
            });
            self.gc(preview_id);
        }
    }

    /// How many previews `user_id` presents now (all nodes).
    #[cfg(test)]
    pub(crate) fn presentations_of(&self, user_id: Uuid) -> usize {
        self.rooms()
            .values()
            .filter(|room| {
                room.presentation
                    .as_ref()
                    .is_some_and(|presentation| presentation.info.presenter.id == user_id)
            })
            .count()
    }

    #[cfg(test)]
    pub(crate) fn room_count(&self) -> usize {
        self.rooms().len()
    }

    /// The room's presence for a watcher that has not subscribed yet.
    pub(crate) fn signal(&self, preview_id: &str) -> (RoomSignal, Option<FollowFrame>) {
        let rooms = self.rooms();
        match rooms.get(preview_id) {
            Some(room) => (room.signal.borrow().clone(), room.views.borrow().clone()),
            None => (RoomSignal::default(), None),
        }
    }

    /// Join the room as a follower until the subscription is dropped.
    pub(crate) fn follow(
        &self,
        preview_id: &str,
        project_id: Uuid,
        person: FollowPerson,
    ) -> FollowSubscription {
        let stream_id = self.inner.next_stream.fetch_add(1, Ordering::Relaxed);
        let subscription = {
            let mut rooms = self.rooms();
            let room = rooms
                .entry(preview_id.to_string())
                .or_insert_with(|| Room::new(project_id));
            room.local.insert(stream_id, person);
            self.refresh(preview_id, room);
            self.announce(preview_id, room, Instant::now());
            FollowSubscription {
                hub: self.clone(),
                preview_id: preview_id.to_string(),
                stream_id,
                signal: room.signal.subscribe(),
                views: room.views.subscribe(),
                taps: room.taps.subscribe(),
            }
        };
        self.kick();
        subscription
    }

    fn unfollow(&self, preview_id: &str, stream_id: u64) {
        let mut rooms = self.rooms();
        let Some(room) = rooms.get_mut(preview_id) else {
            return;
        };
        if room.local.remove(&stream_id).is_none() {
            return;
        }
        self.refresh(preview_id, room);
        self.announce(preview_id, room, Instant::now());
        if room.is_idle() {
            rooms.remove(preview_id);
        }
    }

    /// Tell other nodes who follows this preview here.
    fn announce(&self, preview_id: &str, room: &mut Room, now: Instant) {
        if self.inner.outbound.is_none() {
            return;
        }
        room.announced_at = Some(now);
        self.send_bus(FollowBusMessage::Followers {
            preview_id: preview_id.to_string(),
            project_id: room.project_id,
            followers: room.local_followers(),
        });
    }

    fn gc(&self, preview_id: &str) {
        let mut rooms = self.rooms();
        if rooms.get(preview_id).is_some_and(Room::is_idle) {
            rooms.remove(preview_id);
        }
    }

    /// Apply another node's message. A node's own messages come back from
    /// Redis too; they are ignored.
    pub(crate) fn receive(&self, envelope: FollowEnvelope) {
        if envelope.source == self.inner.node_id {
            return;
        }
        let now = Instant::now();
        let preview_id = envelope.message.preview_id().to_string();
        // Views and taps arrive at 10 Hz; only a new presentation or another
        // node's followers bring a deadline the timer must learn about (a
        // return from away kicks it in `apply_view`).
        let new_deadline = matches!(
            envelope.message,
            FollowBusMessage::Present { .. } | FollowBusMessage::Followers { .. }
        );
        {
            let mut rooms = self.rooms();
            match envelope.message {
                FollowBusMessage::Present { info, .. } => {
                    let room = rooms
                        .entry(preview_id.clone())
                        .or_insert_with(|| Room::new(info.project_id));
                    // A repeat of an ended presentation (a heartbeat's
                    // re-announcement that crossed its end) never revives it.
                    let ended = self.ended().contains_key(&info.presentation_id);
                    let newer = !ended
                        && room.presentation.as_ref().is_none_or(|current| {
                            (info.started_at, info.presentation_id)
                                > (current.info.started_at, current.info.presentation_id)
                        });
                    if newer {
                        self.install(&preview_id, room, info, now);
                    }
                }
                FollowBusMessage::View {
                    presentation_id,
                    seq,
                    payload,
                    at,
                    ..
                } => {
                    if let Some(room) = rooms.get_mut(&preview_id) {
                        self.apply_view(&preview_id, room, presentation_id, seq, payload, at, now);
                    }
                }
                FollowBusMessage::Tap {
                    presentation_id,
                    seq,
                    payload,
                    at,
                    ..
                } => {
                    if let Some(room) = rooms.get_mut(&preview_id) {
                        self.apply_tap(&preview_id, room, presentation_id, seq, payload, at, now);
                    }
                }
                FollowBusMessage::End {
                    presentation_id,
                    reason,
                    ..
                } => {
                    if let Some(room) = rooms.get_mut(&preview_id) {
                        self.finish(&preview_id, room, presentation_id, reason);
                    }
                }
                FollowBusMessage::Followers {
                    project_id,
                    followers,
                    ..
                } => {
                    if followers.is_empty() {
                        if let Some(room) = rooms.get_mut(&preview_id) {
                            room.remote.remove(&envelope.source);
                            self.refresh(&preview_id, room);
                        }
                    } else {
                        let room = rooms
                            .entry(preview_id.clone())
                            .or_insert_with(|| Room::new(project_id));
                        room.remote
                            .insert(envelope.source.clone(), (now, followers));
                        self.refresh(&preview_id, room);
                    }
                }
            }
            if rooms.get(&preview_id).is_some_and(Room::is_idle) {
                rooms.remove(&preview_id);
            }
        }
        if new_deadline {
            self.kick();
        }
    }

    /// Apply due transitions: away, timeout, the 4 h cap, other nodes'
    /// follower lists going stale, and this node's re-announcements. Returns
    /// the next deadline.
    fn sweep(&self, now: Instant) -> Option<Instant> {
        let limits = self.inner.limits.clone();
        let mut next: Option<Instant> = None;
        let mut soonest = |at: Instant| {
            next = Some(next.map_or(at, |current: Instant| current.min(at)));
        };
        let mut ended = Vec::new();
        {
            let mut rooms = self.rooms();
            let keys: Vec<String> = rooms.keys().cloned().collect();
            for preview_id in keys {
                let Some(room) = rooms.get_mut(&preview_id) else {
                    continue;
                };
                if let Some(presentation) = room.presentation.as_mut() {
                    let presentation_id = presentation.info.presentation_id;
                    let cap = presentation.started + limits.max_duration;
                    let away_at = presentation.last_seen + limits.away_after;
                    let end_at = away_at + limits.end_after_away;
                    if now >= cap || now >= end_at {
                        if self.finish(&preview_id, room, presentation_id, EndReason::Timeout) {
                            ended.push((preview_id.clone(), presentation_id));
                        }
                    } else if !presentation.away && now >= away_at {
                        presentation.away = true;
                        self.refresh(&preview_id, room);
                        soonest(end_at.min(cap));
                    } else if presentation.away {
                        soonest(end_at.min(cap));
                    } else {
                        soonest(away_at.min(cap));
                    }
                }
                let before = room.remote.len();
                room.remote.retain(|_, (heard, _)| {
                    now.saturating_duration_since(*heard) < FOLLOWERS_REMOTE_TTL
                });
                if room.remote.len() != before {
                    self.refresh(&preview_id, room);
                }
                for (heard, _) in room.remote.values() {
                    soonest(*heard + FOLLOWERS_REMOTE_TTL);
                }
                if !room.local.is_empty() && self.inner.outbound.is_some() {
                    let due = room
                        .announced_at
                        .map_or(now, |at| at + FOLLOWERS_REANNOUNCE);
                    if now >= due {
                        self.announce(&preview_id, room, now);
                        soonest(now + FOLLOWERS_REANNOUNCE);
                    } else {
                        soonest(due);
                    }
                }
                if room.is_idle() {
                    rooms.remove(&preview_id);
                }
            }
        }
        for (preview_id, presentation_id) in ended {
            self.send_bus(FollowBusMessage::End {
                preview_id,
                presentation_id,
                reason: EndReason::Timeout,
            });
        }
        next
    }
}

async fn sweep_loop(hub: Weak<HubInner>, wake: Arc<Notify>) {
    loop {
        let next = {
            let Some(inner) = hub.upgrade() else {
                return;
            };
            FollowHub { inner }.sweep(Instant::now())
        };
        let until = next.unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        tokio::select! {
            _ = tokio::time::sleep_until(until) => {}
            _ = wake.notified() => {}
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP

/// A member allowed to view the preview: the same membership and
/// private-runtime checks as `GET /projects/:projectId/previews/:previewId`.
/// Follow mode is for people in Studio, so runtime and job tokens are
/// refused.
struct FollowCaller {
    context: RequestContext,
    user_id: Uuid,
    project_id: Uuid,
    grant: PreviewGrant,
}

impl FollowCaller {
    fn preview_id(&self) -> &str {
        &self.grant.record.tunnel_id
    }
}

/// A caller who may not see the preview learns nothing about it: 404.
fn hide_denial(error: (StatusCode, Json<ApiError>)) -> (StatusCode, Json<ApiError>) {
    match error.0 {
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => not_found("preview not found"),
        _ => error,
    }
}

async fn follow_access(
    state: &AppState,
    project_id: &Uuid,
    preview_id: &str,
    context: &RequestContext,
) -> ApiResult<PreviewGrant> {
    ensure_project_authorized(state, project_id, context)
        .await
        .map_err(hide_denial)?;
    let grant = load_preview_grant(&state.pool, project_id, preview_id).await?;
    ensure_preview_runtime_access(state, project_id, &grant, context)
        .await
        .map_err(hide_denial)?;
    Ok(grant)
}

async fn follow_caller(
    state: &AppState,
    headers: &HeaderMap,
    params: &PreviewPath,
) -> ApiResult<FollowCaller> {
    // Off wherever previews are off, like every other preview route.
    ensure_previews_available(state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let context = authenticate_request(&state.config, headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("follow mode runs in a Studio session"));
    }
    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("sign in to present or follow"))?;
    let grant = follow_access(state, &project_id, &params.preview_id, &context).await?;
    Ok(FollowCaller {
        context,
        user_id,
        project_id,
        grant,
    })
}

/// The member's name and picture from their account profile.
async fn load_person(pool: &PgPool, user_id: &Uuid) -> FollowPerson {
    let mut person = FollowPerson {
        id: *user_id,
        name: FALLBACK_NAME.to_string(),
        avatar_url: None,
    };
    let row = match pool.get().await {
        Ok(connection) => connection
            .query_opt(
                "select p.full_name, p.avatar_url, u.raw_user_meta_data
                 from auth.users u
                 left join profiles p on p.user_id = u.id
                 where u.id = $1",
                &[user_id],
            )
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return person,
        Err(error) => {
            warn!(%error, "failed to load a presenter's or follower's profile");
            return person;
        }
    };
    let metadata: Option<JsonValue> = row.get("raw_user_meta_data");
    let (fallback_name, fallback_avatar) = crate::projects::human_profile_metadata_defaults(
        metadata.as_ref().unwrap_or(&JsonValue::Null),
    );
    let saved_name = row
        .get::<_, Option<String>>("full_name")
        .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|name| !name.is_empty());
    if let Some(name) = saved_name.or(fallback_name) {
        person.name = name.chars().take(PERSON_NAME_MAX_CHARS).collect();
    }
    person.avatar_url = row
        .get::<_, Option<String>>("avatar_url")
        .filter(|url| !url.trim().is_empty())
        .or(fallback_avatar);
    person
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowPostBody {
    op: String,
    #[serde(default)]
    presentation_id: Option<String>,
    #[serde(default)]
    seq: Option<u64>,
    #[serde(default)]
    payload: Option<JsonValue>,
}

fn payload_too_large() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ApiError::with_details(
            "a view or tap is at most 2048 bytes of JSON",
            "payload_too_large",
            json!({ "maxBytes": FOLLOW_PAYLOAD_MAX_BYTES }),
        )),
    )
}

/// The compact JSON size of a payload.
fn payload_bytes(payload: &JsonValue) -> usize {
    serde_json::to_vec(payload)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn checked_payload(payload: Option<JsonValue>) -> ApiResult<Option<JsonValue>> {
    match payload {
        None | Some(JsonValue::Null) => Ok(None),
        Some(payload) if payload_bytes(&payload) > FOLLOW_PAYLOAD_MAX_BYTES => {
            Err(payload_too_large())
        }
        Some(payload) => Ok(Some(payload)),
    }
}

fn valid_tap(payload: &JsonValue) -> bool {
    let unit = |key: &str| {
        payload
            .get(key)
            .and_then(JsonValue::as_f64)
            .is_some_and(|value| (0.0..=1.0).contains(&value))
    };
    payload.is_object() && unit("x") && unit("y")
}

fn rejection(reject: FollowReject) -> Response {
    match reject {
        FollowReject::Replaced(presenter) => (
            StatusCode::CONFLICT,
            Json(json!({
                "message": format!("{} is presenting now", presenter.name),
                "code": "presentation_replaced",
                "state": "replaced",
                "presenter": presenter,
            })),
        )
            .into_response(),
        FollowReject::Ended => (
            StatusCode::CONFLICT,
            Json(json!({
                "message": "this presentation has ended",
                "code": "presentation_ended",
                "state": "ended",
                "presenter": null,
            })),
        )
            .into_response(),
        FollowReject::Unknown => (
            StatusCode::CONFLICT,
            Json(json!({
                "message": "this presentation is not known here yet",
                "code": "presentation_unknown",
                "state": "unknown",
                "presenter": null,
            })),
        )
            .into_response(),
        FollowReject::NotPresenter => {
            forbidden("only the presenter sends views and taps").into_response()
        }
        FollowReject::RateLimited(wait) => {
            let seconds = wait.as_secs_f64().ceil().max(1.0) as u64;
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ApiError::with_details(
                    "sending too fast; slow down",
                    "follow_rate_limited",
                    json!({ "retryAfterSeconds": seconds }),
                )),
            )
                .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
            response
        }
        FollowReject::TooManyPresentations => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ApiError::with_details(
                "you are presenting too many sites at once; stop one first",
                "too_many_presentations",
                json!({ "max": PRESENTATIONS_PER_USER }),
            )),
        )
            .into_response(),
    }
}

fn presentation_json(
    info: &PresentationInfo,
    away: bool,
    frame: Option<&FollowFrame>,
) -> JsonValue {
    let frame = frame.filter(|frame| frame.presentation_id == info.presentation_id);
    let mut value = json!({
        "presentationId": info.presentation_id,
        "presenter": info.presenter,
        "startedAt": info.started_at.to_rfc3339(),
        "state": if away { "away" } else { "live" },
        "seq": frame.map(|frame| frame.seq),
        "payload": frame.map(|frame| frame.payload.clone()),
    });
    if let Some(replaced) = &info.replaced {
        value["replaced"] = replaced.short();
    }
    value
}

fn state_json(signal: &RoomSignal, frame: Option<&FollowFrame>) -> JsonValue {
    json!({
        "presentation": signal
            .presentation
            .as_ref()
            .map(|(info, away)| presentation_json(info, *away, frame)),
        "followers": signal.followers,
    })
}

/// `POST …/previews/:previewId/follow` with `op` present, view, tap or stop.
pub(super) async fn post_preview_follow(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle_follow_post(&state, &params, &headers, &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn handle_follow_post(
    state: &AppState,
    params: &PreviewPath,
    headers: &HeaderMap,
    body: &[u8],
) -> ApiResult<Response> {
    if body.len() > FOLLOW_BODY_MAX_BYTES {
        return Err(payload_too_large());
    }
    let caller = follow_caller(state, headers, params).await?;
    let body: FollowPostBody = serde_json::from_slice(body)
        .map_err(|_| bad_request("expected {op, presentationId, seq, payload}"))?;
    let presentation_id = || -> ApiResult<Uuid> {
        body.presentation_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
            .ok_or_else(|| bad_request("presentationId is required"))
    };
    let preview_id = caller.preview_id().to_string();
    let hub = &state.follow;
    // A preview that stopped, closed or expired has nothing to present: its
    // presentation ends, and nobody starts a new one. Stop always answers.
    if body.op != "stop" && !caller.grant.is_live() {
        hub.end_preview(&preview_id, EndReason::Closed);
        return Ok(rejection(FollowReject::Ended));
    }
    match body.op.as_str() {
        "present" => {
            // Each present loads the presenter and announces presence to
            // every `/events` stream of the space, so it has its own bucket.
            if let Err(limit) = state
                .rate_limiter
                .enforce(
                    format!("follow:present:{}:{preview_id}", caller.user_id),
                    PRESENTS_PER_WINDOW,
                    PRESENT_WINDOW,
                )
                .await
            {
                return Ok(rejection(FollowReject::RateLimited(limit.retry_after)));
            }
            let presenter = load_person(&state.pool, &caller.user_id).await;
            let runtime_id = resolve_canonical_tunnel_runtime_id(
                state,
                &caller.project_id,
                caller.grant.record.runtime_id,
                caller.grant.record.runtime_lease_id,
            )
            .await?
            .or(caller.grant.record.runtime_id);
            let conversation_id = caller
                .grant
                .preview_str("conversationId")
                .and_then(|raw| Uuid::parse_str(raw).ok());
            let info = match hub.present(
                &preview_id,
                caller.project_id,
                conversation_id,
                runtime_id,
                presenter,
            ) {
                Ok(info) => info,
                Err(reject) => return Ok(rejection(reject)),
            };
            debug!(preview_id = %preview_id, presentation_id = %info.presentation_id, "presentation started");
            let mut response = json!({
                "presentationId": info.presentation_id,
                "presenter": info.presenter,
                "startedAt": info.started_at.to_rfc3339(),
            });
            if let Some(replaced) = &info.replaced {
                response["replaced"] = replaced.short();
            }
            Ok((StatusCode::OK, Json(response)).into_response())
        }
        "view" => {
            let presentation_id = presentation_id()?;
            let payload = checked_payload(body.payload.clone())?;
            let seq = body.seq.unwrap_or(0);
            let bytes = payload.as_ref().map_or(0, payload_bytes);
            match hub.view(&preview_id, presentation_id, caller.user_id, seq, payload) {
                Ok(()) => {
                    debug!(preview_id = %preview_id, seq, bytes, "follow view");
                    Ok(StatusCode::ACCEPTED.into_response())
                }
                Err(reject) => Ok(rejection(reject)),
            }
        }
        "tap" => {
            let presentation_id = presentation_id()?;
            let payload = checked_payload(body.payload.clone())?
                .filter(valid_tap)
                .ok_or_else(|| bad_request("a tap needs {x, y} in 0..1 of the frame"))?;
            let seq = body.seq.ok_or_else(|| bad_request("seq is required"))?;
            match hub.tap(&preview_id, presentation_id, caller.user_id, seq, payload) {
                Ok(()) => Ok(StatusCode::ACCEPTED.into_response()),
                Err(reject) => Ok(rejection(reject)),
            }
        }
        "stop" => {
            let presentation_id = presentation_id()?;
            let stopped = hub.stop(&preview_id, presentation_id, caller.user_id);
            Ok((StatusCode::OK, Json(json!({ "stopped": stopped }))).into_response())
        }
        _ => Err(bad_request("op must be present, view, tap or stop")),
    }
}

/// `GET …/previews/:previewId/follow`: the presentation, if any, and who
/// follows it.
pub(super) async fn get_preview_follow(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
) -> ApiResult<Json<JsonValue>> {
    let caller = follow_caller(&state, &headers, &params).await?;
    let (signal, frame) = state.follow.signal(caller.preview_id());
    Ok(Json(state_json(&signal, frame.as_ref())))
}

/// `GET …/previews/:previewId/follow/stream`: opening it is following.
/// Events: `state` (on connect and on every presence change), `view` (the
/// latest only; always sent on connect), `tap`, and `end`. Access is checked
/// again every `event_access_recheck_after`; a member who loses it gets
/// `end{reason:"access"}` and the stream closes.
pub(super) async fn get_preview_follow_stream(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let caller = follow_caller(&state, &headers, &params).await?;
    let permit = if state.config.dev_mode {
        None
    } else {
        Some(
            state
                .connection_limiter
                .try_acquire(
                    format!("follow:user:{}", caller.user_id),
                    FOLLOW_STREAMS_PER_USER,
                )
                .await
                .ok_or_else(|| {
                    crate::too_many_requests(
                        "Too many open follow streams. Stop following elsewhere and try again.",
                    )
                })?,
        )
    };
    let person = load_person(&state.pool, &caller.user_id).await;
    let subscription = state
        .follow
        .follow(caller.preview_id(), caller.project_id, person);
    let (sender, receiver) = mpsc::channel(STREAM_QUEUE);
    tokio::spawn(run_follow_stream(
        state.clone(),
        caller,
        subscription,
        sender,
        permit,
    ));
    Ok(Sse::new(ReceiverStream::new(receiver))
        .keep_alive(
            KeepAlive::new()
                .interval(FOLLOW_KEEP_ALIVE)
                .text("keep-alive"),
        )
        .into_response())
}

type SseSender = mpsc::Sender<Result<SseEvent, Infallible>>;

async fn send_event(sender: &SseSender, name: &str, id: Option<u64>, data: &JsonValue) -> bool {
    let mut event = SseEvent::default().event(name);
    if let Some(id) = id {
        event = event.id(id.to_string());
    }
    match event.json_data(data) {
        Ok(event) => sender.send(Ok(event)).await.is_ok(),
        Err(error) => {
            warn!(?error, "failed to encode a follow event");
            true
        }
    }
}

fn frame_json(frame: &FollowFrame) -> JsonValue {
    json!({ "seq": frame.seq, "payload": frame.payload, "at": frame.at.to_rfc3339() })
}

async fn run_follow_stream(
    state: AppState,
    caller: FollowCaller,
    mut subscription: FollowSubscription,
    sender: SseSender,
    _permit: Option<ConnectionPermit>,
) {
    let user_id = caller.user_id;
    let preview_id = caller.preview_id().to_string();
    let initial = subscription.signal.borrow_and_update().clone();
    let frame = subscription.views.borrow_and_update().clone();
    // An end that happened before this stream opened is not news to it.
    let mut seen_end = initial.end.as_ref().map(|end| end.presentation_id);
    if !send_event(
        &sender,
        "state",
        None,
        &state_json(&initial, frame.as_ref()),
    )
    .await
    {
        return;
    }
    if let Some(frame) =
        frame.filter(|frame| Some(frame.presentation_id) == initial.presentation_id())
    {
        if !send_event(&sender, "view", Some(frame.seq), &frame_json(&frame)).await {
            return;
        }
    }
    let period = state
        .config
        .event_access_recheck_after
        .max(Duration::from_millis(50));
    let mut recheck = tokio::time::interval_at(Instant::now() + period, period);
    recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = sender.closed() => break,
            changed = subscription.signal.changed() => {
                if changed.is_err() {
                    break;
                }
                let signal = subscription.signal.borrow_and_update().clone();
                if let Some(end) = &signal.end {
                    if seen_end != Some(end.presentation_id) {
                        seen_end = Some(end.presentation_id);
                        // Followers follow the preview: a takeover is a new
                        // `state`. Only the replaced presenter hears `end`.
                        if end.reason != EndReason::Replaced || end.presenter_id == user_id {
                            let data = json!({ "reason": end.reason, "presentationId": end.presentation_id });
                            if !send_event(&sender, "end", None, &data).await {
                                break;
                            }
                        }
                    }
                }
                let frame = subscription.views.borrow().clone();
                if !send_event(&sender, "state", None, &state_json(&signal, frame.as_ref())).await {
                    break;
                }
            }
            changed = subscription.views.changed() => {
                if changed.is_err() {
                    break;
                }
                let frame = subscription.views.borrow_and_update().clone();
                let current = subscription.signal.borrow().presentation_id();
                if let Some(frame) = frame.filter(|frame| Some(frame.presentation_id) == current) {
                    if !send_event(&sender, "view", Some(frame.seq), &frame_json(&frame)).await {
                        break;
                    }
                }
            }
            tap = subscription.taps.recv() => {
                match tap {
                    Ok(frame) => {
                        let current = subscription.signal.borrow().presentation_id();
                        if Some(frame.presentation_id) == current
                            && !send_event(&sender, "tap", Some(frame.seq), &frame_json(&frame)).await
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = recheck.tick() => {
                match follow_access(&state, &caller.project_id, &preview_id, &caller.context).await {
                    Ok(grant) => {
                        // Stopped with its runtime, closed or expired: the
                        // presentation is over (the stream stays, in case the
                        // site is opened again).
                        if !grant.is_live() {
                            state.follow.end_preview(&preview_id, EndReason::Closed);
                        }
                    }
                    Err((status, _)) if status.is_server_error() => {
                        warn!(%status, "follow stream access check failed; trying again");
                    }
                    Err(_) => {
                        let data = json!({ "reason": EndReason::Access });
                        let _ = send_event(&sender, "end", None, &data).await;
                        break;
                    }
                }
            }
        }
    }
    drop(subscription);
}
