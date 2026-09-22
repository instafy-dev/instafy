//! Per-connection Explore authority and private frame routing. An owner approval
//! allows a separate page in the host browser's session, never a runtime grant.
use super::*;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Viewport {
    width: u32,
    height: u32,
    dpr: f64,
}
impl Viewport {
    pub(super) fn valid(&self) -> bool {
        (240..=1920).contains(&self.width)
            && (160..=1440).contains(&self.height)
            && self.dpr.is_finite()
            && (1.0..=3.0).contains(&self.dpr)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    connection_id: Uuid,
    user_id: Uuid,
    viewport: Viewport,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    view_id: Uuid,
    connection_id: Uuid,
    user_id: Uuid,
    viewport: Viewport,
}
#[derive(Clone, Default)]
pub(super) struct Snapshot {
    available: bool,
    requests: Vec<Request>,
    views: Vec<View>,
}
impl Snapshot {
    pub fn message(&self, connection: Uuid, publisher: bool) -> String {
        let mut value = json!({"type":"exploreState","available":self.available,"requested":self.requests.iter().any(|r|r.connection_id==connection),"view":self.views.iter().find(|v|v.connection_id==connection)});
        if publisher {
            value["requests"] = json!(self.requests);
            value["views"] = json!(self.views);
        }
        value.to_string()
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    ExploreRequest {
        viewport: Viewport,
    },
    ExploreReturn,
    ExploreApprove {
        #[serde(rename = "connectionId")]
        connection_id: Uuid,
        #[serde(rename = "viewId")]
        view_id: Uuid,
    },
    ExploreDeny {
        #[serde(rename = "connectionId")]
        connection_id: Uuid,
    },
    ExploreClose {
        #[serde(rename = "viewId")]
        view_id: Uuid,
    },
    ExploreResize {
        #[serde(rename = "viewId")]
        view_id: Uuid,
        viewport: Viewport,
    },
    ExploreInput {
        #[serde(rename = "viewId")]
        view_id: Uuid,
        input: control::TabInput,
    },
    ExploreNavigate {
        #[serde(rename = "viewId")]
        view_id: Uuid,
        action: String,
    },
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum Action {
    ExploreInput {
        #[serde(rename = "viewId")]
        view_id: Uuid,
        input: control::TabInput,
    },
    ExploreNavigate {
        #[serde(rename = "viewId")]
        view_id: Uuid,
        action: String,
    },
}
impl Action {
    fn id(&self) -> Uuid {
        match self {
            Self::ExploreInput { view_id, .. } | Self::ExploreNavigate { view_id, .. } => *view_id,
        }
    }
}
pub(super) struct Explore {
    pub state: watch::Sender<Snapshot>,
    frames: HashMap<Uuid, watch::Sender<Feed>>,
    input: mpsc::Sender<Action>,
    pub receiver: Option<mpsc::Receiver<Action>>,
    last_frames: HashMap<Uuid, Instant>,
}
impl Default for Explore {
    fn default() -> Self {
        let (state, _) = watch::channel(Snapshot::default());
        let (input, receiver) = mpsc::channel(32);
        Self {
            state,
            frames: HashMap::new(),
            input,
            receiver: Some(receiver),
            last_frames: HashMap::new(),
        }
    }
}
impl Explore {
    pub(super) fn view_id(&self, connection: Uuid) -> Option<Uuid> {
        self.state
            .borrow()
            .views
            .iter()
            .find(|v| v.connection_id == connection)
            .map(|v| v.view_id)
    }
    pub fn join(&mut self, connection: Uuid) -> watch::Receiver<Feed> {
        let (tx, rx) = watch::channel(Feed::Live(None));
        self.frames.insert(connection, tx);
        rx
    }
    pub fn is_active(&self, connection: Uuid) -> bool {
        self.state
            .borrow()
            .views
            .iter()
            .any(|v| v.connection_id == connection)
    }
    pub fn leave(&mut self, connection: Uuid) {
        self.clear(connection);
        self.frames.remove(&connection);
    }
    fn clear(&mut self, connection: Uuid) {
        let mut state = self.state.borrow().clone();
        state.requests.retain(|r| r.connection_id != connection);
        state.views.retain(|v| {
            if v.connection_id == connection {
                self.last_frames.remove(&v.view_id);
                false
            } else {
                true
            }
        });
        if let Some(feed) = self.frames.get(&connection) {
            feed.send_replace(Feed::Live(None));
        }
        self.state.send_replace(state);
    }
}
impl Registry {
    pub fn enable_explore(&self, id: Uuid) {
        if let Some(s) = self.0.lock().unwrap().get_mut(&id) {
            s.explore.state.send_modify(|v| v.available = true);
        }
    }
    pub fn exploring(&self, id: Uuid, connection: Uuid) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|s| s.explore.is_active(connection))
    }
    pub fn explore_message(
        &self,
        id: Uuid,
        connection: Uuid,
        user: Uuid,
        publish: bool,
        raw: &str,
    ) -> Option<bool> {
        if raw.len() > 16_384 {
            return Some(false);
        }
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        if !value.get("type")?.as_str()?.starts_with("explore") {
            return None;
        }
        let Ok(command) = serde_json::from_value::<Command>(value) else {
            return Some(false);
        };
        let mut shares = self.0.lock().unwrap();
        let Some(s) = shares.get_mut(&id) else {
            return Some(false);
        };
        if !s.publisher
            || !s.explore.state.borrow().available
            || (publish && user != s.info.owner_user_id)
            || (!publish
                && !s
                    .viewers
                    .get(&connection)
                    .is_some_and(|(u, _)| *u == user && s.allows(user)))
        {
            return Some(false);
        }
        let mut state = s.explore.state.borrow().clone();
        let own = |view_id: Uuid| {
            state
                .views
                .iter()
                .any(|v| v.view_id == view_id && v.connection_id == connection && v.user_id == user)
        };
        match command {
            Command::ExploreRequest { viewport } if !publish => {
                if !viewport.valid() {
                    return Some(false);
                }
                if !state.views.iter().any(|v| v.connection_id == connection)
                    && !state.requests.iter().any(|r| r.connection_id == connection)
                {
                    state.requests.push(Request {
                        connection_id: connection,
                        user_id: user,
                        viewport,
                    });
                }
            }
            Command::ExploreReturn if !publish => {
                s.explore.clear(connection);
                return Some(true);
            }
            Command::ExploreDeny { connection_id } if publish => {
                state.requests.retain(|r| r.connection_id != connection_id);
            }
            Command::ExploreApprove {
                connection_id,
                view_id,
            } if publish => {
                if state.views.len() >= 4
                    || state
                        .views
                        .iter()
                        .any(|v| v.connection_id == connection_id || v.view_id == view_id)
                {
                    return Some(true);
                }
                let Some(request) = state
                    .requests
                    .iter()
                    .find(|r| r.connection_id == connection_id)
                else {
                    return Some(true);
                };
                if !s.viewers.contains_key(&connection_id) || !s.allows(request.user_id) {
                    return Some(true);
                }
                state.views.push(View {
                    view_id,
                    connection_id,
                    user_id: request.user_id,
                    viewport: request.viewport.clone(),
                });
                state.requests.retain(|r| r.connection_id != connection_id);
                s.control.leave(connection_id);
            }
            Command::ExploreClose { view_id } if publish => {
                if let Some(view) = state.views.iter().find(|v| v.view_id == view_id) {
                    s.explore.clear(view.connection_id);
                }
                return Some(true);
            }
            Command::ExploreResize { view_id, viewport } if !publish => {
                if !viewport.valid() {
                    return Some(false);
                }
                if !own(view_id) {
                    return Some(true);
                }
                state
                    .views
                    .iter_mut()
                    .find(|v| v.view_id == view_id)
                    .unwrap()
                    .viewport = viewport;
            }
            Command::ExploreInput { view_id, input } if !publish => {
                if !input.valid() {
                    return Some(false);
                }
                if !own(view_id) {
                    return Some(true);
                }
                return Some(
                    s.explore
                        .input
                        .try_send(Action::ExploreInput { view_id, input })
                        .is_ok(),
                );
            }
            Command::ExploreNavigate { view_id, action } if !publish => {
                if !matches!(action.as_str(), "back" | "forward" | "reload") {
                    return Some(false);
                }
                if !own(view_id) {
                    return Some(true);
                }
                return Some(
                    s.explore
                        .input
                        .try_send(Action::ExploreNavigate { view_id, action })
                        .is_ok(),
                );
            }
            _ => return Some(false),
        }
        s.explore.state.send_replace(state);
        Some(true)
    }
    pub fn explore_action_current(&self, id: Uuid, action: &Action) -> bool {
        self.0.lock().unwrap().get(&id).is_some_and(|s| {
            s.explore.state.borrow().views.iter().any(|v| {
                v.view_id == action.id()
                    && s.viewers.contains_key(&v.connection_id)
                    && s.allows(v.user_id)
            })
        })
    }
    pub fn explore_frame(&self, id: Uuid, bytes: Vec<u8>) -> bool {
        // Versioned private image envelope: IEX1 + 36 ASCII UUID bytes + JPEG.
        if bytes.len() < 44
            || bytes.len() > MAX_FRAME + 40
            || !bytes.starts_with(b"IEX1")
            || !bytes[40..].starts_with(&[255, 216])
            || !bytes.ends_with(&[255, 217])
        {
            return false;
        }
        let Some(view_id) = std::str::from_utf8(&bytes[4..40])
            .ok()
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            return false;
        };
        let mut shares = self.0.lock().unwrap();
        let Some(s) = shares.get_mut(&id) else {
            return false;
        };
        let state = s.explore.state.borrow();
        let Some(view) = state.views.iter().find(|v| v.view_id == view_id) else {
            return true;
        };
        if !s.allows(view.user_id) {
            return true;
        }
        if s.explore
            .last_frames
            .get(&view_id)
            .is_some_and(|t| t.elapsed() < Duration::from_millis(100))
        {
            return true;
        }
        s.explore.last_frames.insert(view_id, Instant::now());
        if let Some(feed) = s.explore.frames.get(&view.connection_id) {
            feed.send_replace(Feed::Live(Some(Arc::new(bytes))));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn viewport() -> serde_json::Value {
        json!({"width":390,"height":650,"dpr":2})
    }
    fn message(
        reg: &Registry,
        id: Uuid,
        connection: Uuid,
        user: Uuid,
        publish: bool,
        value: serde_json::Value,
    ) -> bool {
        reg.explore_message(id, connection, user, publish, &value.to_string())
            .unwrap()
    }
    fn frame(id: Uuid) -> Vec<u8> {
        let mut v = format!("IEX1{id}").into_bytes();
        v.extend([255, 216, 255, 217]);
        v
    }
    #[test]
    fn browser_shares_explore_requires_owner_and_routes_only_to_the_approved_connection() {
        let reg = Registry::default();
        let project = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let share = reg.create(project, owner, None, Instant::now()).unwrap();
        let mut publisher = reg.connect(project, share.id, owner, true).unwrap();
        let a = reg.connect(project, share.id, guest, false).unwrap();
        let b = reg.connect(project, share.id, guest, false).unwrap();
        reg.enable_explore(share.id);
        let view = Uuid::new_v4();
        assert!(!message(
            &reg,
            share.id,
            a.id,
            guest,
            false,
            json!({"type":"exploreApprove","connectionId":a.id,"viewId":view})
        ));
        assert!(message(
            &reg,
            share.id,
            a.id,
            guest,
            false,
            json!({"type":"exploreRequest","viewport":viewport()})
        ));
        assert!(message(
            &reg,
            share.id,
            publisher.id,
            owner,
            true,
            json!({"type":"exploreApprove","connectionId":a.id,"viewId":view})
        ));
        assert!(reg.exploring(share.id, a.id));
        assert!(!reg.exploring(share.id, b.id));
        let snapshot: serde_json::Value =
            serde_json::from_str(&a.explore.borrow().message(a.id, false)).unwrap();
        assert!(snapshot.get("views").is_none());
        assert!(snapshot.get("requests").is_none());
        assert_eq!(snapshot["view"]["viewId"], view.to_string());
        assert!(reg.explore_frame(share.id, frame(view)));
        assert!(matches!(&*a.explore_feed.borrow(), Feed::Live(Some(_))));
        assert!(matches!(&*b.explore_feed.borrow(), Feed::Live(None)));
        let input =
            json!({"type":"exploreInput","viewId":view,"input":{"type":"text","text":"private"}});
        assert!(message(&reg, share.id, b.id, guest, false, input.clone()));
        assert!(publisher
            .explore_input
            .as_mut()
            .unwrap()
            .try_recv()
            .is_err());
        assert!(message(&reg, share.id, a.id, guest, false, input));
        let action = publisher
            .explore_input
            .as_mut()
            .unwrap()
            .try_recv()
            .unwrap();
        assert!(reg.explore_action_current(share.id, &action));
        reg.remove_viewer(project, share.id, owner, guest).unwrap();
        assert!(!reg.explore_action_current(share.id, &action));
        assert!(!reg.exploring(share.id, a.id));
        assert!(*a.revoked.borrow());
        assert!(reg.explore_frame(share.id, frame(view)));
        assert!(matches!(&*a.explore_feed.borrow(), Feed::Live(None)));
    }
    #[test]
    fn browser_shares_explore_return_and_disconnect_fence_late_approval_and_frames() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let share = reg.create(p, owner, None, Instant::now()).unwrap();
        let host = reg.connect(p, share.id, owner, true).unwrap();
        let a = reg.connect(p, share.id, guest, false).unwrap();
        reg.enable_explore(share.id);
        reg.enable_control(share.id);
        let view = Uuid::new_v4();
        let request = json!({"type":"exploreRequest","viewport":viewport()});
        let approve = json!({"type":"exploreApprove","connectionId":a.id,"viewId":view});
        assert!(message(&reg, share.id, a.id, guest, false, request.clone()));
        assert!(message(
            &reg,
            share.id,
            a.id,
            guest,
            false,
            json!({"type":"exploreReturn"})
        ));
        assert!(message(
            &reg,
            share.id,
            host.id,
            owner,
            true,
            approve.clone()
        ));
        assert!(!reg.exploring(share.id, a.id));
        assert!(message(&reg, share.id, a.id, guest, false, request));
        assert!(message(&reg, share.id, host.id, owner, true, approve));
        assert!(reg.control_message(share.id, a.id, guest, false, r#"{"type":"requestControl"}"#));
        assert!(!a
            .control
            .borrow()
            .message(a.id, false)
            .contains("\"requested\":true"));
        reg.leave(share.id, a.id);
        assert!(!reg.exploring(share.id, a.id));
        assert!(reg.explore_frame(share.id, frame(view)));
    }
    #[test]
    fn browser_shares_explore_rejects_unbounded_viewports_input_and_host_commands() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let share = reg.create(p, owner, None, Instant::now()).unwrap();
        reg.connect(p, share.id, owner, true).unwrap();
        let a = reg.connect(p, share.id, guest, false).unwrap();
        reg.enable_explore(share.id);
        for value in [
            json!({"type":"exploreRequest","viewport":{"width":999999,"height":650,"dpr":2}}),
            json!({"type":"exploreInput","viewId":Uuid::new_v4(),"input":{"type":"evaluate","expression":"secret"}}),
            json!({"type":"exploreNavigate","viewId":Uuid::new_v4(),"action":"file:///secret"}),
        ] {
            assert!(!message(&reg, share.id, a.id, guest, false, value));
        }
        assert!(!reg.explore_frame(share.id, b"IEX1bad".to_vec()));
    }
}
