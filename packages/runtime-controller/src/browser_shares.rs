//! Explicit, ephemeral local tab sharing. Control grants cover one selected tab,
//! never runtime, shell, profile or agent authority.
mod control;
mod explore;
use crate::{
    auth::{authenticate_request, require_user_session, RequestContext},
    bad_request, forbidden, internal_error, not_found, too_many_requests, ApiError, AppState,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use uuid::Uuid;

type Result<T> = std::result::Result<T, (StatusCode, Json<ApiError>)>;
const MAX_FRAME: usize = 1024 * 1024;
const MAX_LIFETIME: Duration = Duration::from_secs(3600);
const HOST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone)]
enum Feed {
    Live(Option<Arc<Vec<u8>>>),
    Stopped,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareInfo {
    id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    audience: &'static str,
    mode: &'static str,
}

struct Share {
    info: ShareInfo,
    born: Instant,
    seen: Instant,
    publisher: bool,
    selected: Option<HashSet<Uuid>>,
    removed: HashSet<Uuid>,
    viewers: HashMap<Uuid, (Uuid, watch::Sender<bool>)>,
    feed: watch::Sender<Feed>,
    control: control::Control,
    explore: explore::Explore,
}

struct Connection {
    id: Uuid,
    feed: watch::Receiver<Feed>,
    revoked: watch::Receiver<bool>,
    control: watch::Receiver<control::Snapshot>,
    input: Option<tokio::sync::mpsc::Receiver<control::Input>>,
    explore: watch::Receiver<explore::Snapshot>,
    explore_feed: watch::Receiver<Feed>,
    explore_input: Option<tokio::sync::mpsc::Receiver<explore::Action>>,
}

impl Share {
    fn allows(&self, user: Uuid) -> bool {
        self.info.owner_user_id == user
            || (!self.removed.contains(&user)
                && self
                    .selected
                    .as_ref()
                    .is_none_or(|users| users.contains(&user)))
    }
}

#[derive(Clone, Default)]
struct Registry(Arc<Mutex<HashMap<Uuid, Share>>>);

impl Registry {
    fn prune(shares: &mut HashMap<Uuid, Share>, now: Instant) {
        shares.retain(|_, s| {
            let alive = now.duration_since(s.born) < MAX_LIFETIME
                && now.duration_since(s.seen) < HOST_TIMEOUT;
            if !alive {
                s.feed.send_replace(Feed::Stopped);
            }
            alive
        });
    }
    fn create(
        &self,
        project: Uuid,
        owner: Uuid,
        selected: Option<HashSet<Uuid>>,
        now: Instant,
    ) -> Result<ShareInfo> {
        let mut shares = self.0.lock().unwrap();
        Self::prune(&mut shares, now);
        if shares.len() >= 64
            || shares
                .values()
                .filter(|s| s.info.project_id == project)
                .count()
                >= 8
            || shares.values().any(|s| s.info.owner_user_id == owner)
        {
            return Err(too_many_requests(
                "Stop the existing tab share before starting another",
            ));
        }
        let info = ShareInfo {
            id: Uuid::new_v4(),
            project_id: project,
            owner_user_id: owner,
            audience: if selected.is_some() {
                "selected"
            } else {
                "space"
            },
            mode: "view",
        };
        let (feed, _) = watch::channel(Feed::Live(None));
        shares.insert(
            info.id,
            Share {
                info: info.clone(),
                born: now,
                seen: now,
                publisher: false,
                selected,
                removed: HashSet::new(),
                viewers: HashMap::new(),
                feed,
                control: control::Control::default(),
                explore: explore::Explore::default(),
            },
        );
        Ok(info)
    }
    fn list(&self, project: Uuid, user: Uuid) -> Vec<ShareInfo> {
        let mut shares = self.0.lock().unwrap();
        Self::prune(&mut shares, Instant::now());
        shares
            .values()
            .filter(|s| s.info.project_id == project && s.publisher && s.allows(user))
            .map(|s| s.info.clone())
            .collect()
    }
    fn connect(&self, project: Uuid, id: Uuid, user: Uuid, publish: bool) -> Result<Connection> {
        let mut shares = self.0.lock().unwrap();
        Self::prune(&mut shares, Instant::now());
        let s = shares
            .get_mut(&id)
            .filter(|s| s.info.project_id == project)
            .ok_or_else(|| not_found("Tab share ended"))?;
        let connection_id = Uuid::new_v4();
        let (revoked, receiver) = watch::channel(false);
        if publish {
            if s.info.owner_user_id != user || s.publisher {
                return Err(forbidden("Tab share publisher does not match"));
            }
            s.publisher = true;
        } else {
            if !s.allows(user) {
                return Err(not_found("Tab share unavailable"));
            }
            if s.viewers.len() >= 8 {
                return Err(too_many_requests("This tab share has eight viewers"));
            }
            s.viewers.insert(connection_id, (user, revoked));
        }
        Ok(Connection {
            id: connection_id,
            feed: s.feed.subscribe(),
            revoked: receiver,
            control: s.control.state.subscribe(),
            explore: s.explore.state.subscribe(),
            explore_feed: s.explore.join(connection_id),
            explore_input: if publish {
                s.explore.receiver.take()
            } else {
                None
            },
            input: if publish {
                s.control.receiver.take()
            } else {
                None
            },
        })
    }
    fn frame(&self, id: Uuid, bytes: Vec<u8>) -> bool {
        if bytes.len() > MAX_FRAME
            || !bytes.starts_with(&[0xff, 0xd8])
            || !bytes.ends_with(&[0xff, 0xd9])
        {
            return false;
        }
        let mut shares = self.0.lock().unwrap();
        Self::prune(&mut shares, Instant::now());
        let Some(s) = shares.get_mut(&id).filter(|s| s.publisher) else {
            return false;
        };
        s.seen = Instant::now();
        // One latest frame, never an unbounded queue or a recording.
        s.feed.send_replace(Feed::Live(Some(Arc::new(bytes))));
        true
    }
    fn stop(&self, project: Uuid, id: Uuid, user: Uuid) -> Result<()> {
        let mut shares = self.0.lock().unwrap();
        if let Some(s) = shares.get(&id) {
            if s.info.project_id != project || s.info.owner_user_id != user {
                return Err(forbidden("Only the tab owner can stop this share"));
            }
        }
        if let Some(s) = shares.remove(&id) {
            s.feed.send_replace(Feed::Stopped);
        }
        Ok(())
    }
    fn remove_viewer(&self, project: Uuid, id: Uuid, owner: Uuid, user: Uuid) -> Result<()> {
        let mut shares = self.0.lock().unwrap();
        let s = shares
            .get_mut(&id)
            .filter(|s| s.info.project_id == project)
            .ok_or_else(|| not_found("Tab share ended"))?;
        if s.info.owner_user_id != owner {
            return Err(forbidden("Only the tab owner can remove viewers"));
        }
        if user == owner {
            return Err(bad_request("Use Stop sharing to end your own share"));
        }
        if s.removed.len() >= 256 && !s.removed.contains(&user) {
            return Err(too_many_requests("Stop sharing to reset the audience"));
        }
        s.removed.insert(user);
        // Every connection belonging to this person is revoked, including idle
        // viewers. A fresh connection cannot bypass the session's removal set.
        s.viewers.retain(|connection, (viewer, revoked)| {
            if *viewer == user {
                s.control.leave(*connection);
                s.explore.leave(*connection);
                revoked.send_replace(true);
                false
            } else {
                true
            }
        });
        Ok(())
    }
    fn audience_members(
        &self,
        project: Uuid,
        id: Uuid,
        owner: Uuid,
    ) -> Result<Vec<(Uuid, bool, bool)>> {
        let mut shares = self.0.lock().unwrap();
        Self::prune(&mut shares, Instant::now());
        let s = shares
            .get(&id)
            .filter(|s| s.info.project_id == project)
            .ok_or_else(|| not_found("Tab share ended"))?;
        if s.info.owner_user_id != owner {
            return Err(forbidden("Only the tab owner can inspect viewers"));
        }
        let active: HashSet<_> = s.viewers.values().map(|(user, _)| *user).collect();
        let users: HashSet<_> = active
            .iter()
            .chain(s.selected.iter().flatten())
            .chain(s.removed.iter())
            .copied()
            .collect();
        Ok(users
            .into_iter()
            .filter(|user| *user != owner)
            .map(|user| (user, active.contains(&user), s.removed.contains(&user)))
            .collect())
    }
    fn leave(&self, id: Uuid, connection: Uuid) {
        if let Some(s) = self.0.lock().unwrap().get_mut(&id) {
            s.viewers.remove(&connection);
            s.control.leave(connection);
            s.explore.leave(connection);
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/:project/browser-shares", get(list).post(create))
        .route("/projects/:project/browser-shares/people", get(people))
        .route(
            "/projects/:project/browser-shares/:id/viewers",
            get(viewers),
        )
        .route(
            "/projects/:project/browser-shares/:id/viewers/:user",
            axum::routing::delete(remove_viewer),
        )
        .route(
            "/projects/:project/browser-shares/:id",
            axum::routing::delete(stop),
        )
        .route("/projects/:project/browser-shares/:id/:role", get(socket))
        .layer(Extension(Registry::default()))
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    project: Uuid,
    publish: bool,
) -> Result<Uuid> {
    let context = authenticate_request(&state.config, headers).await?;
    let user = require_user_session(&context)?;
    let mut db = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Tab share database unavailable"))?;
    let tx = db
        .transaction()
        .await
        .map_err(|_| internal_error("Tab share database unavailable"))?;
    let record = crate::load_project_record(&tx, &project).await?;
    if publish {
        crate::ensure_project_write_access(&tx, &record, &context, None).await?;
    } else {
        crate::ensure_project_access(&tx, &record, &context, None).await?;
    }
    Ok(user)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    audience: String,
    mode: String,
    #[serde(default)]
    viewer_user_ids: Vec<Uuid>,
}

async fn create(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateRequest>,
) -> Result<Json<ShareInfo>> {
    let owner = authorize(&state, &headers, project, true).await?;
    let selected = body.selection(owner)?;
    if let Some(users) = &selected {
        let mut db = state
            .pool
            .get()
            .await
            .map_err(|_| internal_error("Tab share database unavailable"))?;
        let tx = db
            .transaction()
            .await
            .map_err(|_| internal_error("Tab share database unavailable"))?;
        let record = crate::load_project_record(&tx, &project).await?;
        for user in users {
            let context = RequestContext {
                user_id: Some(*user),
                is_service_role: false,
                scoped_claims: None,
            };
            crate::ensure_project_access(&tx, &record, &context, None)
                .await
                .map_err(|_| bad_request("Every selected person must have current space access"))?;
        }
    }
    Ok(Json(reg.create(
        project,
        owner,
        selected,
        Instant::now(),
    )?))
}
impl CreateRequest {
    fn selection(&self, owner: Uuid) -> Result<Option<HashSet<Uuid>>> {
        if self.mode != "view" {
            return Err(bad_request("Only tab viewing is supported"));
        }
        match self.audience.as_str() {
            "space" if self.viewer_user_ids.is_empty() => Ok(None),
            "selected"
                if !self.viewer_user_ids.is_empty()
                    && self.viewer_user_ids.len() <= 32
                    && !self.viewer_user_ids.contains(&owner) =>
            {
                Ok(Some(self.viewer_user_ids.iter().copied().collect()))
            }
            _ => Err(bad_request(
                "Choose the space or between one and 32 other people",
            )),
        }
    }
}

async fn list(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<ShareInfo>>> {
    let user = authorize(&state, &headers, project, false).await?;
    Ok(Json(reg.list(project, user)))
}
async fn stop(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path((project, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    // An owner who just lost space membership must still be able to stop.
    let context = authenticate_request(&state.config, &headers).await?;
    reg.stop(project, id, require_user_session(&context)?)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    user_id: Uuid,
    full_name: Option<String>,
    email: Option<String>,
}
#[derive(Deserialize, Default)]
struct PeopleQuery {
    #[serde(default)]
    q: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeopleResponse {
    people: Vec<Person>,
    has_more: bool,
}

async fn people(
    State(state): State<AppState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Query(query): Query<PeopleQuery>,
) -> Result<Json<PeopleResponse>> {
    let owner = authorize(&state, &headers, project, true).await?;
    if query.q.len() > 200 {
        return Err(bad_request("Search is too long"));
    }
    let mut db = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Tab share database unavailable"))?;
    let tx = db
        .transaction()
        .await
        .map_err(|_| internal_error("Tab share database unavailable"))?;
    let record = crate::load_project_record(&tx, &project).await?;
    // Include inherited organization access as well as direct membership. Keep
    // role interpretation aligned with the project's access authority.
    let rows = tx.query("with candidates as (
        select user_id, role from project_memberships where project_id = $1
        union select user_id, role from org_memberships where org_id = $2
        union select $3::uuid, 'owner'::text where $3::uuid is not null
      ) select u.id, u.email, p.full_name, array_agg(c.role) as roles
      from candidates c join auth.users u on u.id = c.user_id
      left join profiles p on p.user_id = u.id
      where u.id <> $4 and (strpos(lower(coalesce(p.full_name, '') || ' ' || coalesce(u.email, '')), lower($5)) > 0)
      group by u.id, u.email, p.full_name order by lower(coalesce(p.full_name, u.email, '')), u.id limit 201",
      &[&project, &record.org_id, &record.owner_user_id, &owner, &query.q.trim()]).await
      .map_err(|_| internal_error("Could not load people with space access"))?;
    let has_more = rows.len() > 200;
    let people = rows
        .into_iter()
        .take(200)
        .filter(|row| {
            row.get::<_, Vec<String>>("roles")
                .iter()
                .any(|role| crate::projects::ProjectRole::from_membership_role(role).is_some())
        })
        .map(|row| Person {
            user_id: row.get("id"),
            full_name: row.get("full_name"),
            email: row.get("email"),
        })
        .collect();
    Ok(Json(PeopleResponse { people, has_more }))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Viewer {
    #[serde(flatten)]
    person: Person,
    active: bool,
    removed: bool,
}
async fn viewers(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path((project, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<Vec<Viewer>>> {
    let owner = authorize(&state, &headers, project, true).await?;
    let members = reg.audience_members(project, id, owner)?;
    let ids: Vec<_> = members.iter().map(|(user, _, _)| *user).collect();
    let db = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Tab share database unavailable"))?;
    let rows = db.query("select u.id, u.email, p.full_name from auth.users u left join profiles p on p.user_id = u.id where u.id = any($1)", &[&ids]).await
        .map_err(|_| internal_error("Could not load tab viewers"))?;
    let mut people: HashMap<_, _> = rows
        .into_iter()
        .map(|row| {
            let user_id = row.get("id");
            (
                user_id,
                Person {
                    user_id,
                    full_name: row.get("full_name"),
                    email: row.get("email"),
                },
            )
        })
        .collect();
    Ok(Json(
        members
            .into_iter()
            .map(|(user_id, active, removed)| Viewer {
                person: people.remove(&user_id).unwrap_or(Person {
                    user_id,
                    full_name: None,
                    email: None,
                }),
                active,
                removed,
            })
            .collect(),
    ))
}
async fn remove_viewer(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path((project, id, user)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    // Like Stop, removal remains available to the owner after membership loss.
    let context = authenticate_request(&state.config, &headers).await?;
    reg.remove_viewer(project, id, require_user_session(&context)?, user)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SocketAuth {
    access_token: String,
    #[serde(default)]
    control_version: Option<u32>,
    #[serde(default)]
    explore_version: Option<u32>,
}

async fn socket(
    State(state): State<AppState>,
    Extension(reg): Extension<Registry>,
    Path((project, id, role)): Path<(Uuid, Uuid, String)>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let publish = match role.as_str() {
        "publish" => true,
        "watch" => false,
        _ => return Err(not_found("Unknown tab share operation")),
    };
    // Session tokens travel in the first TLS-protected message, never URLs/logs.
    Ok(ws
        .max_message_size(MAX_FRAME + 40)
        .max_frame_size(MAX_FRAME + 40)
        .on_upgrade(move |ws| serve(ws, state, reg, project, id, publish)))
}

async fn serve(
    mut socket: WebSocket,
    state: AppState,
    reg: Registry,
    project: Uuid,
    id: Uuid,
    publish: bool,
) {
    let Ok(Some(Ok(Message::Text(raw)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    if raw.len() > 16_384 {
        return;
    }
    let Ok(auth) = serde_json::from_str::<SocketAuth>(&raw) else {
        return;
    };
    let mut headers = HeaderMap::new();
    let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", auth.access_token)) else {
        return;
    };
    headers.insert("authorization", value);
    let Ok(Ok(user)) = tokio::time::timeout(
        Duration::from_secs(5),
        authorize(&state, &headers, project, publish),
    )
    .await
    else {
        return;
    };
    let Ok(Connection {
        id: connection_id,
        mut feed,
        mut revoked,
        mut control,
        mut input,
        mut explore,
        mut explore_feed,
        mut explore_input,
    }) = reg.connect(project, id, user, publish)
    else {
        return;
    };
    if publish && auth.control_version == Some(1) {
        reg.enable_control(id);
    }
    if publish && auth.explore_version == Some(1) {
        reg.enable_explore(id);
    }
    let mut message_window = Instant::now();
    let mut message_count = 0;
    let mut membership = tokio::time::interval(Duration::from_secs(10));
    let mut last_frame = Instant::now() - Duration::from_secs(1);
    let mut lifetime = tokio::time::interval(Duration::from_secs(1));
    let _ = socket
        .send(Message::Text("{\"type\":\"ready\"}".into()))
        .await;
    // send_modify causes existing latest pixels to be delivered to this watcher.
    feed.mark_changed();
    control.mark_changed();
    explore.mark_changed();
    loop {
        tokio::select! {
            biased;
            _ = revoked.changed(), if !publish => { break; }
            _ = lifetime.tick() => {
                { let mut shares = reg.0.lock().unwrap();
                  Registry::prune(&mut shares, Instant::now());
                  if !shares.contains_key(&id) { break; }
                }
                if publish && auth.explore_version == Some(1) {
                    let message = explore.borrow().message(connection_id, true);
                    if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
                }
                // A heartbeat renews the native input lease; a partition cannot
                // leave the local owner locked out indefinitely.
                if publish && auth.control_version == Some(1) {
                    let message = control.borrow().message(connection_id, true);
                    if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
                }
            }
            _ = membership.tick() => {
                let authorized = tokio::select! {
                    biased;
                    _ = revoked.changed(), if !publish => { break; }
                    result = tokio::time::timeout(Duration::from_secs(5), authorize(&state, &headers, project, publish)) => result,
                };
                if !matches!(authorized, Ok(Ok(current)) if current == user) { break; }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) if publish => {
                        if bytes.starts_with(b"IEX1") { if !reg.explore_frame(id, bytes) { break; } continue; }
                        if last_frame.elapsed() < Duration::from_millis(100) { continue; }
                        last_frame = Instant::now();
                        if !reg.frame(id, bytes) { break; }
                    }
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Ping(value))) => { if socket.send(Message::Pong(value)).await.is_err() { break; } },
                    Some(Ok(Message::Text(raw))) => {
                        if message_window.elapsed() >= Duration::from_secs(1) { message_window = Instant::now(); message_count = 0; }
                        message_count += 1;
                        if message_count > 120 || !reg.explore_message(id, connection_id, user, publish, &raw).unwrap_or_else(|| reg.control_message(id, connection_id, user, publish, &raw)) { break; }
                    }
                    // All other messages and binary viewer input remain invalid.
                    _ => break,
                }
            }
            changed = explore.changed() => {
                if changed.is_err() { break; }
                let message = explore.borrow_and_update().message(connection_id, publish);
                if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
                if !publish && !reg.exploring(id, connection_id) { feed.mark_changed(); }
            }
            next = async { match explore_input.as_mut() { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if publish => {
                let Some(next) = next else { break; };
                if reg.explore_action_current(id, &next) {
                    let message = serde_json::to_string(&next).unwrap();
                    if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
                }
            }
            changed = explore_feed.changed(), if !publish => {
                if changed.is_err() { break; }
                let update = explore_feed.borrow_and_update().clone();
                if let Feed::Live(Some(bytes)) = update {
                    if reg.exploring(id, connection_id) && !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Binary((*bytes).clone()))).await, Ok(Ok(()))) { break; }
                }
            }
            changed = control.changed() => {
                if changed.is_err() { break; }
                let message = control.borrow_and_update().message(connection_id, publish);
                if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
            }
            next = async { match input.as_mut() { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if publish => {
                let Some(next) = next else { break; };
                if reg.input_is_current(id, &next) {
                    let message = serde_json::to_string(&next).unwrap();
                    if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Text(message))).await, Ok(Ok(()))) { break; }
                }
            }
            changed = feed.changed() => {
                if changed.is_err() { break; }
                let update = feed.borrow_and_update().clone();
                match update {
                    Feed::Stopped => break,
                    Feed::Live(Some(bytes)) if !publish && !reg.exploring(id, connection_id) => {
                        let sent = tokio::select! {
                            biased;
                            _ = revoked.changed() => { break; }
                            result = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Binary((*bytes).clone()))) => result,
                        };
                        if !matches!(sent, Ok(Ok(()))) { break; }
                    }
                    _ => {},
                }
            }
        }
    }
    if publish {
        let _ = reg.stop(project, id, user);
    } else {
        reg.leave(id, connection_id);
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(None))).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_shares_bind_publisher_and_project_without_runtime_authority() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let s = reg.create(p, owner, None, Instant::now()).unwrap();
        assert!(reg.connect(p, s.id, guest, true).is_err());
        assert!(reg.connect(Uuid::new_v4(), s.id, guest, false).is_err());
        reg.connect(p, s.id, owner, true).unwrap();
        assert!(reg.connect(p, s.id, owner, true).is_err());
        let rx = reg.connect(p, s.id, guest, false).unwrap();
        assert!(reg.stop(p, s.id, guest).is_err());
        assert!(reg.frame(s.id, vec![255, 216, 1, 255, 217]));
        assert!(matches!(&*rx.feed.borrow(), Feed::Live(Some(_))));
        reg.stop(p, s.id, owner).unwrap();
        assert!(matches!(&*rx.feed.borrow(), Feed::Stopped));
        assert!(!reg.frame(s.id, vec![255, 216, 255, 217]));
        assert!(reg.connect(p, s.id, guest, false).is_err());
    }
    #[test]
    fn browser_shares_expire_bound_memory_and_never_reuse_sessions() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let u = Uuid::new_v4();
        let now = Instant::now();
        let old = reg.create(p, u, None, now).unwrap();
        assert!(reg.create(p, u, None, now).is_err());
        let rx = reg.connect(p, old.id, u, true).unwrap();
        assert!(!reg.frame(old.id, vec![0; MAX_FRAME + 1]));
        Registry::prune(&mut reg.0.lock().unwrap(), now + HOST_TIMEOUT);
        assert!(matches!(&*rx.feed.borrow(), Feed::Stopped));
        let next = reg.create(p, u, None, Instant::now()).unwrap();
        assert_ne!(old.id, next.id);
    }
    #[test]
    fn browser_shares_limit_viewers_and_release_capacity() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let u = Uuid::new_v4();
        let s = reg.create(p, u, None, Instant::now()).unwrap();
        let first = reg.connect(p, s.id, Uuid::new_v4(), false).unwrap();
        for _ in 1..8 {
            reg.connect(p, s.id, Uuid::new_v4(), false).unwrap();
        }
        assert!(reg.connect(p, s.id, Uuid::new_v4(), false).is_err());
        reg.leave(s.id, first.id);
        assert!(reg.connect(p, s.id, Uuid::new_v4(), false).is_ok());
    }
    #[test]
    fn browser_shares_selected_audience_hides_discovery_and_rejects_unselected_connections() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let selected = Uuid::new_v4();
        let other = Uuid::new_v4();
        let s = reg
            .create(p, owner, Some(HashSet::from([selected])), Instant::now())
            .unwrap();
        reg.connect(p, s.id, owner, true).unwrap();
        assert_eq!(reg.list(p, owner).len(), 1);
        assert_eq!(reg.list(p, selected).len(), 1);
        assert!(reg.list(p, other).is_empty());
        assert!(reg.connect(p, s.id, other, false).is_err());
        assert!(reg.connect(p, s.id, selected, false).is_ok());
        // The owner can still view their selected share on another device.
        assert!(reg.connect(p, s.id, owner, false).is_ok());
        assert!(reg.audience_members(p, s.id, selected).is_err());
    }
    #[test]
    fn browser_shares_removal_revokes_every_connection_without_ending_other_viewers() {
        for selected in [false, true] {
            let reg = Registry::default();
            let p = Uuid::new_v4();
            let owner = Uuid::new_v4();
            let a = Uuid::new_v4();
            let b = Uuid::new_v4();
            let s = reg
                .create(
                    p,
                    owner,
                    selected.then(|| HashSet::from([a, b])),
                    Instant::now(),
                )
                .unwrap();
            reg.connect(p, s.id, owner, true).unwrap();
            let first = reg.connect(p, s.id, a, false).unwrap();
            let second = reg.connect(p, s.id, a, false).unwrap();
            let other = reg.connect(p, s.id, b, false).unwrap();
            assert!(reg.remove_viewer(p, s.id, a, b).is_err());
            assert!(reg.remove_viewer(Uuid::new_v4(), s.id, owner, a).is_err());
            assert!(reg.remove_viewer(p, s.id, owner, owner).is_err());
            reg.remove_viewer(p, s.id, owner, a).unwrap();
            assert!(*first.revoked.borrow());
            assert!(*second.revoked.borrow());
            assert!(!*other.revoked.borrow());
            assert!(reg.connect(p, s.id, a, false).is_err());
            assert!(reg.list(p, a).is_empty());
            assert!(reg.frame(s.id, vec![255, 216, 255, 217]));
            assert!(matches!(&*other.feed.borrow(), Feed::Live(Some(_))));
            // Late cleanup from a revoked socket cannot remove someone else's capacity.
            reg.leave(s.id, first.id);
            let members = reg.audience_members(p, s.id, owner).unwrap();
            assert!(members.contains(&(a, false, true)));
            assert!(members.contains(&(b, true, false)));
            reg.stop(p, s.id, owner).unwrap();
            let next = reg.create(p, owner, None, Instant::now()).unwrap();
            assert!(reg.connect(p, next.id, a, false).is_ok());
        }
    }
    #[test]
    fn browser_shares_remove_before_join_and_bound_removal_memory() {
        let reg = Registry::default();
        let p = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let s = reg
            .create(p, owner, Some(HashSet::from([guest])), Instant::now())
            .unwrap();
        reg.remove_viewer(p, s.id, owner, guest).unwrap();
        assert!(reg.connect(p, s.id, guest, false).is_err());
        for _ in 1..256 {
            reg.remove_viewer(p, s.id, owner, Uuid::new_v4()).unwrap();
        }
        assert!(reg.remove_viewer(p, s.id, owner, Uuid::new_v4()).is_err());
        assert!(reg.remove_viewer(p, s.id, owner, guest).is_ok());
    }
    #[test]
    fn browser_shares_require_an_explicit_unambiguous_audience() {
        let owner = Uuid::new_v4();
        let guest = Uuid::new_v4();
        let body = |audience: &str, users: Vec<Uuid>| CreateRequest {
            audience: audience.into(),
            mode: "view".into(),
            viewer_user_ids: users,
        };
        assert!(body("space", vec![]).selection(owner).unwrap().is_none());
        assert_eq!(
            body("selected", vec![guest, guest])
                .selection(owner)
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        for invalid in [
            body("selected", vec![]),
            body("selected", vec![owner]),
            body("selected", vec![guest; 33]),
            body("space", vec![guest]),
            body("public", vec![]),
        ] {
            assert!(invalid.selection(owner).is_err());
        }
    }
}
