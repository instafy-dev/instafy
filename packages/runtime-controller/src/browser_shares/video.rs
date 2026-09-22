//! Video signaling is scoped to the same audience, connection and Explore view
//! as JPEG delivery. Media never travels through the controller socket.
use super::*;
use serde_json::{json, Value};

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Peer {
    id: Uuid,
    connection_id: Uuid,
    view_id: Option<Uuid>,
    viewport: explore::Viewport,
    configuration: Value,
    offer: Option<String>,
    answer: Option<String>,
    playing: bool,
    #[serde(skip)]
    born: Option<Instant>,
}
#[derive(Clone, Default, PartialEq)]
pub(super) struct Snapshot {
    available: bool,
    peers: Vec<Peer>,
    needs_follow_frames: bool,
}
impl Snapshot {
    pub fn message(&self, connection: Uuid, publisher: bool, lease: bool) -> String {
        if publisher && lease {
            return json!({"type":"videoLease","peers":self.peers.iter().map(|p|json!({"id":p.id,"viewId":p.view_id})).collect::<Vec<_>>()}).to_string();
        }
        json!({"type":"videoState","available":self.available,
            "needsFollowFrames":self.needs_follow_frames,
            "peers":self.peers.iter().filter(|p|publisher || p.connection_id==connection).collect::<Vec<_>>()}).to_string()
    }
}
pub(super) struct Video {
    pub state: watch::Sender<Snapshot>,
    requests: HashMap<Uuid, Vec<Instant>>,
}
impl Default for Video {
    fn default() -> Self {
        Self {
            state: watch::channel(Snapshot::default()).0,
            requests: HashMap::new(),
        }
    }
}
impl Video {
    pub fn leave(&mut self, connection: Uuid) {
        self.requests.remove(&connection);
        self.state
            .send_modify(|s| s.peers.retain(|p| p.connection_id != connection));
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    VideoRequest {
        id: Uuid,
        viewport: explore::Viewport,
    },
    VideoViewport {
        id: Uuid,
        viewport: explore::Viewport,
    },
    VideoOffer {
        id: Uuid,
        sdp: String,
    },
    VideoAnswer {
        id: Uuid,
        sdp: String,
    },
    VideoPlaying {
        id: Uuid,
    },
    VideoClose {
        id: Uuid,
    },
    VideoAlive,
}
fn valid_sdp(sdp: &str) -> bool {
    sdp.len() <= 32_768
        && sdp.starts_with("v=0")
        && sdp.contains("m=video ")
        && !sdp.contains("m=audio ")
        && !sdp.contains("m=application ")
}

pub(super) fn configuration(state: &AppState, project: Uuid, share: Uuid) -> Option<Value> {
    match state.config.browser_turn_rest.as_ref() {
        Some(turn) if turn.allows_project(project) => {
            let now = chrono::Utc::now().timestamp();
            let servers: Value =
                serde_json::from_str(&turn.mint_ice_servers_json(project, share, now)).ok()?;
            Some(json!({"iceServers":servers,"iceTransportPolicy":"relay"}))
        }
        Some(_) => None,
        None => Some(json!({"iceServers":[],"iceTransportPolicy":"all"})),
    }
}
fn reconcile(s: &mut Share) {
    let mut snapshot = s.video.state.borrow().clone();
    snapshot.peers.retain(|p| {
        s.viewers.contains_key(&p.connection_id)
            && p.view_id == s.explore.view_id(p.connection_id)
            && (p.playing
                || p.born
                    .is_some_and(|born| born.elapsed() < Duration::from_secs(30)))
    });
    snapshot.needs_follow_frames = s.viewers.keys().any(|c| {
        s.explore.view_id(*c).is_none()
            && !snapshot
                .peers
                .iter()
                .any(|p| p.connection_id == *c && p.playing)
    });
    if *s.video.state.borrow() != snapshot {
        s.video.state.send_replace(snapshot);
    }
}
impl Registry {
    pub(super) fn enable_video(&self, id: Uuid) {
        if let Some(s) = self.0.lock().unwrap().get_mut(&id) {
            s.video.state.send_modify(|v| v.available = true);
        }
    }
    pub(super) fn reconcile_video(&self, id: Uuid) {
        if let Some(s) = self.0.lock().unwrap().get_mut(&id) {
            reconcile(s);
        }
    }
    pub(super) fn video_message(
        &self,
        id: Uuid,
        connection: Uuid,
        publish: bool,
        raw: &str,
        configuration: Option<Value>,
    ) -> Option<bool> {
        let Ok(command) = serde_json::from_str::<Command>(raw) else {
            return None;
        };
        let mut shares = self.0.lock().unwrap();
        let Some(s) = shares.get_mut(&id) else {
            return Some(false);
        };
        reconcile(s);
        let mut snapshot = s.video.state.borrow().clone();
        if !snapshot.available || (!publish && !s.viewers.contains_key(&connection)) {
            return Some(false);
        }
        match command {
            Command::VideoAlive if publish => {
                s.seen = Instant::now();
                return Some(true);
            }
            Command::VideoRequest { id, viewport } if !publish && viewport.valid() => {
                let Some(configuration) = configuration else {
                    return Some(false);
                };
                if snapshot
                    .peers
                    .iter()
                    .any(|p| p.id == id && p.connection_id != connection)
                {
                    return Some(false);
                }
                // One request at a time per connection. Duplicates cannot reset
                // its deadline or move a peer to another view.
                if snapshot.peers.iter().any(|p| p.id == id) {
                    return Some(true);
                }
                // Negotiation allocates a native encoder. Ordinary input has
                // a much higher rate limit; bound repeated encoder restarts.
                let requests = s.video.requests.entry(connection).or_default();
                requests.retain(|at| at.elapsed() < Duration::from_secs(10));
                if requests.len() >= 6 {
                    return Some(false);
                }
                requests.push(Instant::now());
                snapshot.peers.retain(|p| p.connection_id != connection);
                snapshot.peers.push(Peer {
                    id,
                    connection_id: connection,
                    view_id: s.explore.view_id(connection),
                    viewport,
                    configuration,
                    offer: None,
                    answer: None,
                    playing: false,
                    born: Some(Instant::now()),
                });
            }
            Command::VideoViewport { id, viewport } if !publish && viewport.valid() => {
                if let Some(p) = snapshot
                    .peers
                    .iter_mut()
                    .find(|p| p.id == id && p.connection_id == connection)
                {
                    p.viewport = viewport;
                }
            }
            Command::VideoOffer { id, sdp } if publish && valid_sdp(&sdp) => {
                if let Some(p) = snapshot
                    .peers
                    .iter_mut()
                    .find(|p| p.id == id && p.offer.is_none())
                {
                    p.offer = Some(sdp);
                }
            }
            Command::VideoAnswer { id, sdp } if !publish && valid_sdp(&sdp) => {
                if let Some(p) = snapshot.peers.iter_mut().find(|p| {
                    p.id == id
                        && p.connection_id == connection
                        && p.offer.is_some()
                        && p.answer.is_none()
                }) {
                    p.answer = Some(sdp);
                }
            }
            Command::VideoPlaying { id } if !publish => {
                if let Some(p) = snapshot
                    .peers
                    .iter_mut()
                    .find(|p| p.id == id && p.connection_id == connection && p.answer.is_some())
                {
                    p.playing = true;
                }
            }
            Command::VideoClose { id } => {
                snapshot
                    .peers
                    .retain(|p| !(p.id == id && (publish || p.connection_id == connection)));
            }
            _ => return Some(false),
        }
        s.video.state.send_replace(snapshot);
        reconcile(s);
        Some(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Option<Value> {
        Some(json!({"iceServers":[],"iceTransportPolicy":"all"}))
    }
    fn fixture() -> (
        Registry,
        Uuid,
        Uuid,
        Uuid,
        Connection,
        Connection,
        Connection,
    ) {
        let reg = Registry::default();
        let project = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let share = reg.create(project, owner, None, Instant::now()).unwrap();
        let publisher = reg.connect(project, share.id, owner, true).unwrap();
        let a = reg.connect(project, share.id, guest, false).unwrap();
        let b = reg.connect(project, share.id, guest, false).unwrap();
        reg.enable_video(share.id);
        (reg, project, owner, share.id, publisher, a, b)
    }
    fn request(id: Uuid) -> String {
        json!({"type":"videoRequest","id":id,"viewport":{"width":390,"height":650,"dpr":2}})
            .to_string()
    }
    const SDP: &str = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
    #[test]
    fn browser_shares_video_bounds_encoder_churn_per_connection() {
        let (reg, _, _, id, _, a, b) = fixture();
        for _ in 0..6 {
            assert_eq!(
                reg.video_message(id, a.id, false, &request(Uuid::new_v4()), config()),
                Some(true)
            );
        }
        assert_eq!(
            reg.video_message(id, a.id, false, &request(Uuid::new_v4()), config()),
            Some(false)
        );
        assert_eq!(
            reg.video_message(id, b.id, false, &request(Uuid::new_v4()), config()),
            Some(true)
        );
        reg.leave(id, a.id);
        assert!(!reg.0.lock().unwrap()[&id]
            .video
            .requests
            .contains_key(&a.id));
    }
    #[test]
    fn browser_shares_video_signaling_is_private_and_bound_to_exact_connection() {
        let (reg, _, _, id, publisher, a, b) = fixture();
        let peer = Uuid::new_v4();
        assert_eq!(
            reg.video_message(id, a.id, false, &request(peer), config()),
            Some(true)
        );
        let offer = json!({"type":"videoOffer","id":peer,"sdp":SDP}).to_string();
        assert_eq!(
            reg.video_message(id, b.id, false, &offer, config()),
            Some(false)
        );
        assert_eq!(
            reg.video_message(id, publisher.id, true, &offer, config()),
            Some(true)
        );
        assert!(a
            .video
            .borrow()
            .message(a.id, false, false)
            .contains(SDP.replace('\r', "\\r").replace('\n', "\\n").as_str()));
        assert!(!b
            .video
            .borrow()
            .message(b.id, false, false)
            .contains(&peer.to_string()));
        let answer = json!({"type":"videoAnswer","id":peer,"sdp":SDP}).to_string();
        assert_eq!(
            reg.video_message(id, b.id, false, &answer, config()),
            Some(true)
        );
        assert!(a.video.borrow().peers[0].answer.is_none());
        reg.video_message(id, a.id, false, &answer, config());
        reg.video_message(
            id,
            a.id,
            false,
            &json!({"type":"videoPlaying","id":peer}).to_string(),
            config(),
        );
        reg.reconcile_video(id);
        // The other connection still needs JPEGs even for the same account.
        assert!(publisher.video.borrow().needs_follow_frames);
        reg.leave(id, b.id);
        reg.reconcile_video(id);
        assert!(!publisher.video.borrow().needs_follow_frames);
        // An established stream keeps its existing transport while the share
        // is authorized. Only unfinished negotiations have a startup deadline.
        reg.0
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .video
            .state
            .send_modify(|s| {
                s.peers[0].born = Some(Instant::now() - Duration::from_secs(600));
            });
        reg.reconcile_video(id);
        assert_eq!(publisher.video.borrow().peers.len(), 1);
    }
    #[test]
    fn browser_shares_video_return_removal_and_deadline_revoke_old_signaling() {
        let (reg, project, owner, id, publisher, a, _) = fixture();
        let peer = Uuid::new_v4();
        reg.video_message(id, a.id, false, &request(peer), config());
        reg.enable_explore(id);
        let guest = reg.0.lock().unwrap()[&id].viewers[&a.id].0;
        assert_eq!(
            reg.explore_message(
                id,
                a.id,
                guest,
                false,
                r#"{"type":"exploreRequest","viewport":{"width":390,"height":650,"dpr":2}}"#
            ),
            Some(true)
        );
        let view = Uuid::new_v4();
        reg.explore_message(
            id,
            publisher.id,
            owner,
            true,
            &json!({"type":"exploreApprove","connectionId":a.id,"viewId":view}).to_string(),
        );
        reg.reconcile_video(id);
        assert!(publisher.video.borrow().peers.is_empty());
        let next = Uuid::new_v4();
        reg.video_message(id, a.id, false, &request(next), config());
        assert_eq!(a.video.borrow().peers[0].view_id, Some(view));
        reg.explore_message(id, a.id, guest, false, r#"{"type":"exploreReturn"}"#);
        reg.reconcile_video(id);
        assert!(publisher.video.borrow().peers.is_empty());
        reg.video_message(id, a.id, false, &request(Uuid::new_v4()), config());
        reg.0
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .video
            .state
            .send_modify(|s| s.peers[0].born = Some(Instant::now() - Duration::from_secs(31)));
        reg.reconcile_video(id);
        assert!(publisher.video.borrow().peers.is_empty());
        reg.video_message(id, a.id, false, &request(Uuid::new_v4()), config());
        reg.remove_viewer(project, id, owner, guest).unwrap();
        assert!(publisher.video.borrow().peers.is_empty());
        assert_eq!(
            reg.video_message(id, a.id, false, &request(Uuid::new_v4()), config()),
            Some(false)
        );
    }
    #[test]
    fn browser_shares_video_rejects_extra_authority_and_bounds_signaling() {
        let (reg, _, _, id, publisher, a, _) = fixture();
        let peer = Uuid::new_v4();
        let mut raw: Value = serde_json::from_str(&request(peer)).unwrap();
        raw["viewId"] = json!(Uuid::new_v4());
        assert_eq!(
            reg.video_message(id, a.id, false, &raw.to_string(), config()),
            None
        );
        assert_eq!(
            reg.video_message(id, a.id, false, &request(peer), None),
            Some(false)
        );
        reg.video_message(id, a.id, false, &request(peer), config());
        for sdp in [
            format!("{SDP}m=audio 9 RTP/AVP 0\r\n"),
            format!("{SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"),
            format!("{SDP}{}", "x".repeat(32768)),
        ] {
            assert_eq!(
                reg.video_message(
                    id,
                    publisher.id,
                    true,
                    &json!({"type":"videoOffer","id":peer,"sdp":sdp}).to_string(),
                    config()
                ),
                Some(false)
            );
        }
        assert_eq!(
            reg.video_message(id, a.id, false, r#"{"type":"videoAlive"}"#, config()),
            Some(false)
        );
        assert_eq!(
            reg.video_message(id, publisher.id, true, r#"{"type":"videoAlive"}"#, config()),
            Some(true)
        );
    }
}
