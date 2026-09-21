//! One explicitly approved viewer connection. No runtime or agent authority.
use super::*;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum TabInput {
    Click {
        x: f64,
        y: f64,
    },
    Wheel {
        x: f64,
        y: f64,
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    Text {
        text: String,
    },
    Key {
        key: String,
        shift: bool,
    },
}
impl TabInput {
    pub(super) fn valid(&self) -> bool {
        let point = |x: f64, y: f64| (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y);
        match self {
            Self::Click { x, y } => point(*x, *y),
            Self::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                point(*x, *y)
                    && delta_x.is_finite()
                    && delta_y.is_finite()
                    && delta_x.abs() <= 4096.0
                    && delta_y.abs() <= 4096.0
            }
            Self::Text { text } => !text.is_empty() && text.len() <= 8192 && !text.contains('\0'),
            Self::Key { key, .. } => matches!(
                key.as_str(),
                "Backspace"
                    | "Delete"
                    | "Tab"
                    | "Enter"
                    | "ArrowLeft"
                    | "ArrowRight"
                    | "ArrowUp"
                    | "ArrowDown"
                    | "Home"
                    | "End"
                    | "PageUp"
                    | "PageDown"
                    | "SelectAll"
            ),
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    RequestControl,
    ReleaseControl,
    GrantControl {
        #[serde(rename = "connectionId")]
        connection_id: Uuid,
        #[serde(rename = "grantId")]
        grant_id: Uuid,
    },
    DenyControl {
        #[serde(rename = "connectionId")]
        connection_id: Uuid,
    },
    Input {
        #[serde(rename = "grantId")]
        grant_id: Uuid,
        input: TabInput,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Grant {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub user_id: Uuid,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    connection_id: Uuid,
    user_id: Uuid,
}
#[derive(Clone, Default)]
pub(super) struct Snapshot {
    available: bool,
    grant: Option<Grant>,
    requests: Vec<Request>,
}
impl Snapshot {
    pub fn message(&self, connection: Uuid, publisher: bool) -> String {
        let mut value = json!({"type":"controlState", "available":self.available, "connectionId":connection,
            "grant":self.grant, "requested":self.requests.iter().any(|r| r.connection_id == connection)});
        // Audience details are visible only to the publisher.
        if publisher {
            value["requests"] = json!(self.requests);
        }
        value.to_string()
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Input {
    #[serde(rename = "type")]
    kind: &'static str,
    pub grant_id: Uuid,
    pub input: TabInput,
}
pub(super) struct Control {
    pub state: watch::Sender<Snapshot>,
    pub input: mpsc::Sender<Input>,
    pub receiver: Option<mpsc::Receiver<Input>>,
}
impl Default for Control {
    fn default() -> Self {
        let (state, _) = watch::channel(Snapshot::default());
        let (input, receiver) = mpsc::channel(32);
        Self {
            state,
            input,
            receiver: Some(receiver),
        }
    }
}
impl Control {
    pub fn leave(&self, connection: Uuid) {
        self.state.send_modify(|s| {
            s.requests.retain(|r| r.connection_id != connection);
            if s.grant
                .as_ref()
                .is_some_and(|g| g.connection_id == connection)
            {
                s.grant = None;
            }
        });
    }
}
impl Registry {
    pub fn enable_control(&self, id: Uuid) {
        if let Some(s) = self.0.lock().unwrap().get_mut(&id) {
            s.control.state.send_modify(|c| c.available = true);
        }
    }
    pub fn control_message(
        &self,
        id: Uuid,
        connection: Uuid,
        user: Uuid,
        publish: bool,
        raw: &str,
    ) -> bool {
        if raw.len() > 16_384 {
            return false;
        }
        let Ok(command) = serde_json::from_str::<Command>(raw) else {
            return false;
        };
        let mut shares = self.0.lock().unwrap();
        let Some(s) = shares.get_mut(&id) else {
            return false;
        };
        if !s.publisher
            || !s.control.state.borrow().available
            || (publish && user != s.info.owner_user_id)
            || (!publish
                && !s
                    .viewers
                    .get(&connection)
                    .is_some_and(|(u, _)| *u == user && s.allows(user)))
        {
            return false;
        }
        let mut state = s.control.state.borrow().clone();
        match command {
            Command::RequestControl if !publish => {
                if s.explore.is_active(connection) {
                    return true;
                }
                if !state.requests.iter().any(|r| r.connection_id == connection)
                    && !state
                        .grant
                        .as_ref()
                        .is_some_and(|g| g.connection_id == connection)
                {
                    state.requests.push(Request {
                        connection_id: connection,
                        user_id: user,
                    });
                }
            }
            Command::ReleaseControl => {
                state.requests.retain(|r| r.connection_id != connection);
                if publish
                    || state
                        .grant
                        .as_ref()
                        .is_some_and(|g| g.connection_id == connection)
                {
                    state.grant = None;
                }
            }
            Command::DenyControl { connection_id } if publish => {
                state.requests.retain(|r| r.connection_id != connection_id)
            }
            Command::GrantControl {
                connection_id,
                grant_id,
            } if publish => {
                if state.grant.is_some() || s.explore.is_active(connection_id) {
                    return true;
                }
                let Some(request) = state
                    .requests
                    .iter()
                    .find(|r| r.connection_id == connection_id)
                else {
                    return true;
                };
                if !s.viewers.contains_key(&connection_id) || !s.allows(request.user_id) {
                    return false;
                }
                state.grant = Some(Grant {
                    id: grant_id,
                    connection_id,
                    user_id: request.user_id,
                });
                state.requests.retain(|r| r.connection_id != connection_id);
            }
            Command::Input { grant_id, input } if !publish => {
                if !input.valid() {
                    return false;
                }
                // In-flight input after a handoff is ignored, not a reason to
                // disconnect a legitimate spectator from the video stream.
                if !state.grant.as_ref().is_some_and(|g| {
                    g.id == grant_id && g.connection_id == connection && g.user_id == user
                }) {
                    return true;
                }
                return s
                    .control
                    .input
                    .try_send(Input {
                        kind: "input",
                        grant_id,
                        input,
                    })
                    .is_ok();
            }
            _ => return false,
        }
        s.control.state.send_replace(state);
        true
    }
    pub fn input_is_current(&self, id: Uuid, input: &Input) -> bool {
        self.0.lock().unwrap().get(&id).is_some_and(|s| {
            s.control.state.borrow().grant.as_ref().is_some_and(|g| {
                g.id == input.grant_id
                    && s.viewers.contains_key(&g.connection_id)
                    && s.allows(g.user_id)
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    fn fixture() -> (Registry, Uuid, Uuid, Uuid, Uuid, Connection, Connection) {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let id = reg.create(p, owner, None, Instant::now()).unwrap().id;
        let host = reg.connect(p, id, owner, true).unwrap();
        let peer = reg.connect(p, id, viewer, false).unwrap();
        reg.enable_control(id);
        (reg, p, id, owner, viewer, host, peer)
    }
    fn send(
        reg: &Registry,
        id: Uuid,
        c: &Connection,
        u: Uuid,
        publish: bool,
        value: Value,
    ) -> bool {
        reg.control_message(id, c.id, u, publish, &value.to_string())
    }
    #[test]
    fn browser_shares_control_requires_request_owner_approval_and_exact_connection() {
        let (reg, p, id, owner, viewer, mut host, peer) = fixture();
        let other = reg.connect(p, id, viewer, false).unwrap();
        let grant = Uuid::new_v4();
        let approve = json!({"type":"grantControl","connectionId":peer.id,"grantId":grant});
        let input =
            json!({"type":"input","grantId":grant,"input":{"type":"click","x":0.5,"y":0.5}});
        assert!(send(&reg, id, &peer, viewer, false, input.clone()));
        assert!(host.input.as_mut().unwrap().try_recv().is_err());
        assert!(send(&reg, id, &host, owner, true, approve.clone()));
        assert!(host.control.borrow().grant.is_none());
        assert!(send(
            &reg,
            id,
            &peer,
            viewer,
            false,
            json!({"type":"requestControl"})
        ));
        assert!(!send(&reg, id, &peer, viewer, false, approve.clone()));
        assert!(send(&reg, id, &host, owner, true, approve));
        assert!(send(&reg, id, &peer, viewer, false, input.clone()));
        let queued = host.input.as_mut().unwrap().try_recv().unwrap();
        assert!(reg.input_is_current(id, &queued));
        assert!(send(&reg, id, &other, viewer, false, input.clone()));
        assert!(host.input.as_mut().unwrap().try_recv().is_err());
        assert!(send(
            &reg,
            id,
            &host,
            owner,
            true,
            json!({"type":"releaseControl"})
        ));
        assert!(send(&reg, id, &peer, viewer, false, input));
        assert!(host.input.as_mut().unwrap().try_recv().is_err());
        assert!(!reg.input_is_current(id, &queued));
    }
    #[test]
    fn browser_shares_control_removal_disconnect_and_queued_input_are_fenced() {
        for removal in [false, true] {
            let (reg, p, id, owner, viewer, mut host, peer) = fixture();
            let grant = Uuid::new_v4();
            assert!(send(
                &reg,
                id,
                &peer,
                viewer,
                false,
                json!({"type":"requestControl"})
            ));
            assert!(send(
                &reg,
                id,
                &host,
                owner,
                true,
                json!({"type":"grantControl","connectionId":peer.id,"grantId":grant})
            ));
            assert!(send(
                &reg,
                id,
                &peer,
                viewer,
                false,
                json!({"type":"input","grantId":grant,"input":{"type":"text","text":"hello"}})
            ));
            let input = host.input.as_mut().unwrap().try_recv().unwrap();
            assert!(reg.input_is_current(id, &input));
            if removal {
                reg.remove_viewer(p, id, owner, viewer).unwrap();
            } else {
                reg.leave(id, peer.id);
            }
            assert!(!reg.input_is_current(id, &input));
            assert!(host.control.borrow().grant.is_none());
        }
    }
    #[test]
    fn browser_shares_control_rejects_unbounded_or_generic_commands() {
        for raw in [
            r#"{"type":"click","x":2,"y":0}"#,
            r#"{"type":"wheel","x":0,"y":0,"deltaX":0,"deltaY":99999}"#,
            r#"{"type":"key","key":"F12","shift":false}"#,
            r#"{"type":"text","text":"a","script":"bad"}"#,
        ] {
            assert!(!serde_json::from_str::<TabInput>(raw).is_ok_and(|i| i.valid()));
        }
        assert!(!TabInput::Text {
            text: "a".repeat(8193)
        }
        .valid());
        assert!(TabInput::Text {
            text: "こんにちは".into()
        }
        .valid());
    }
}
