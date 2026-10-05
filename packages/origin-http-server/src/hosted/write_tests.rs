//! Gateway writes against real git: uploads committed on canonical `main`
//! through the routes, and the commit-and-push loop driven directly on the
//! test thread where a test needs the thread-local push hook or git
//! wrapper.

use std::collections::BTreeMap;
use std::io::{Cursor, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde_json::json;
use uuid::Uuid;
use zip::write::{FileOptions, ZipWriter};

use super::cache::{Freshness, MirrorCache};
use super::cas::{
    caller_message, cas_commit, save_author, ApplyKey, CachedCanonical, CasOutcome, CasTarget,
    MAX_ATTEMPTS,
};
use super::change::{Change, Edits};
use super::tests::{
    decoded, get, post, runtime_push, serve, serve_with, Answer, HostedScenario, Served,
};
use crate::apply::{stage_archive, validate_apply_paths, ManifestFileEntry};
use crate::auth::OriginClaims;
use crate::error::OriginError;
use crate::push::{clear_push_hook, set_push_hook, PushHookAction};
use crate::test_support::{git_in, git_output, install_shard_hook, GitWrapper};
use crate::workspace_git::GitIdentity;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

pub(super) fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_modes(
        &entries
            .iter()
            .map(|(path, bytes)| (*path, *bytes, false))
            .collect::<Vec<_>>(),
    )
}

fn zip_modes(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes, executable) in entries {
        let options = FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(if *executable { 0o100755 } else { 0o100644 });
        writer.start_file(*path, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A manifest writing `files` and deleting `deletes`, with `extra` fields.
pub(super) fn manifest(
    files: &[&str],
    deletes: &[&str],
    extra: serde_json::Value,
) -> serde_json::Value {
    let mut manifest = json!({
        "files": files.iter().map(|path| json!({ "path": path })).collect::<Vec<_>>(),
        "deletes": deletes,
    });
    if let serde_json::Value::Object(extra) = extra {
        manifest.as_object_mut().unwrap().extend(extra);
    }
    manifest
}

async fn apply_as(
    served: &Served,
    manifest: serde_json::Value,
    archive: &[u8],
    token: Option<&str>,
    client: Option<&str>,
) -> Answer {
    let mut request = reqwest::Client::new()
        .post(format!("{}/apply-json", served.base))
        .json(&json!({
            "manifest": manifest,
            "archiveBase64": base64::engine::general_purpose::STANDARD.encode(archive),
        }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(client) = client {
        request = request.header("x-instafy-client", client);
    }
    let response = request.send().await.unwrap();
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.unwrap().to_vec(),
    }
}

pub(super) async fn apply(served: &Served, manifest: serde_json::Value, archive: &[u8]) -> Answer {
    apply_as(served, manifest, archive, None, None).await
}

pub(super) async fn post_as(
    served: &Served,
    path: &str,
    body: serde_json::Value,
    token: &str,
) -> Answer {
    let response = reqwest::Client::new()
        .post(format!("{}{path}", served.base))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.unwrap().to_vec(),
    }
}

fn rev(answer: &Answer) -> String {
    answer.json()["rev"].as_str().unwrap().to_string()
}

/// `path` at `commit` in canonical, if it is there.
pub(super) fn show(sc: &HostedScenario, commit: &str, path: &str) -> Option<Vec<u8>> {
    let spec = format!("{commit}:{path}");
    let output = git_output(&sc.remote(), &["cat-file", "blob", &spec], None);
    output.status.success().then_some(output.stdout)
}

/// `git <args>` in canonical.
pub(super) fn canonical(sc: &HostedScenario, args: &[&str]) -> String {
    git_in(&sc.remote(), args)
}

fn parent(sc: &HostedScenario, commit: &str) -> String {
    canonical(sc, &["rev-parse", &format!("{commit}^")])
}

/// Every file under the mirror's `objects/`.
fn object_files(dir: &Path) -> usize {
    fn walk(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| {
                        let path = entry.path();
                        if path.is_dir() {
                            walk(&path)
                        } else {
                            1
                        }
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
    walk(&dir.join("objects"))
}

/// The hosted origin id the controller derives for a space.
fn hosted_origin_id(project: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("instafy:hosted-origin:{project}").as_bytes(),
    )
}

/// A controller that signs origin tokens, serves its JWKS, answers that
/// one lease is active and hands out git credentials
/// (`git-<n>-until-<unix seconds>`, living as long as it says).
pub(super) struct StubController {
    base: String,
    key: jsonwebtoken::EncodingKey,
    project: Uuid,
    pub(super) user: Uuid,
    pub(super) lease: Uuid,
    /// How many `git.write` credentials it handed out.
    pub(super) write_tokens: Arc<std::sync::atomic::AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for StubController {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl StubController {
    pub(super) async fn start(project: Uuid) -> Self {
        Self::start_with_git_token_life(project, 600).await
    }

    /// A controller whose git credentials live `life` seconds.
    pub(super) async fn start_with_git_token_life(project: Uuid, life: i64) -> Self {
        use axum::extract::State;
        use axum::routing::{get as get_route, post as post_route};
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use ring::rand::SystemRandom;
        use ring::signature::{Ed25519KeyPair, KeyPair as _};

        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let jwks = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "stub-key",
                "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            }]
        });
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let key = jsonwebtoken::EncodingKey::from_ed_pem(pem.as_bytes()).unwrap();
        let user = Uuid::new_v4();
        let lease = Uuid::new_v4();
        let active = json!({
            "lease": {
                "leaseId": lease,
                "projectId": project,
                "userId": user,
                "runtimeId": null,
                "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
            }
        });
        #[derive(Clone)]
        struct Stub {
            jwks: serde_json::Value,
            lease: serde_json::Value,
            write_tokens: Arc<std::sync::atomic::AtomicUsize>,
            life: i64,
        }
        let write_tokens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let app =
            axum::Router::new()
                .route(
                    "/.well-known/jwks.json",
                    get_route(|State(stub): State<Stub>| async move { axum::Json(stub.jwks) }),
                )
                .route(
                    "/projects/:project/lease",
                    get_route(|State(stub): State<Stub>| async move { axum::Json(stub.lease) }),
                )
                .route(
                    "/projects/:project/git/access_token",
                    post_route(
                        |State(stub): State<Stub>,
                         axum::Json(body): axum::Json<serde_json::Value>| async move {
                            let writes = body["scopes"].as_array().is_some_and(|scopes| {
                                scopes.iter().any(|scope| scope == "git.write")
                            });
                            let n = if writes {
                                stub.write_tokens
                                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                            } else {
                                0
                            };
                            let until = chrono::Utc::now().timestamp() + stub.life;
                            axum::Json(json!({
                                "token": format!("git-{n}-until-{until}"),
                                "expiresIn": stub.life,
                            }))
                        },
                    ),
                )
                .with_state(Stub {
                    jwks,
                    lease: active,
                    write_tokens: write_tokens.clone(),
                    life,
                });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            key,
            project,
            user,
            lease,
            write_tokens,
            server,
        }
    }

    /// Point the scenario's gateway at this controller.
    pub(super) fn configure(&self, sc: &mut HostedScenario) {
        sc.config.skip_auth = false;
        sc.config.controller_base_url = reqwest::Url::parse(&self.base).unwrap();
        sc.config.jwks_url =
            reqwest::Url::parse(&format!("{}/.well-known/jwks.json", self.base)).unwrap();
    }

    /// An origin token of the lease holder with `scopes` and extra claims.
    pub(super) fn token(&self, scopes: &[&str], extra: serde_json::Value) -> String {
        let now = chrono::Utc::now().timestamp();
        let origin = hosted_origin_id(self.project).to_string();
        let mut claims = json!({
            "aud": origin,
            "sub": self.user.to_string(),
            "project_id": self.project.to_string(),
            "origin_id": origin,
            "protocol": "http",
            "scopes": scopes,
            "lease_id": self.lease.to_string(),
            "iat": now,
            "exp": now + 600,
            "jti": Uuid::new_v4().to_string(),
        });
        if let serde_json::Value::Object(extra) = extra {
            claims.as_object_mut().unwrap().extend(extra);
        }
        let header = jsonwebtoken::Header {
            kid: Some("stub-key".to_string()),
            ..jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA)
        };
        jsonwebtoken::encode(&header, &claims, &self.key).unwrap()
    }
}

/// The gateway's identity in [`HostedScenario`].
fn gateway() -> GitIdentity {
    GitIdentity::new("instafy-origin", "gateway@instafy.dev")
}

/// The commit-and-push loop run on the test thread, so a push hook or a
/// git wrapper installed there applies to it.
struct Direct {
    runtime: tokio::runtime::Runtime,
    cache: Arc<MirrorCache>,
    project: Uuid,
    remote: String,
    staging: tempfile::TempDir,
}

impl Direct {
    fn new(sc: &HostedScenario) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let cache = Arc::new(sc.open_cache());
        let remote = cache.remote_url(sc.project).unwrap();
        Self {
            runtime,
            cache,
            project: sc.project,
            remote,
            staging: tempfile::tempdir().unwrap(),
        }
    }

    /// An upload of `files` and `deletes`, staged like the route stages it.
    fn edits(&self, files: &[(&str, &[u8])], deletes: &[&str], base_rev: Option<&str>) -> Change {
        let staging = self
            .staging
            .path()
            .canonicalize()
            .unwrap()
            .join(Uuid::new_v4().simple().to_string());
        std::fs::create_dir(&staging).unwrap();
        let archive = zip(files);
        let dir = Dir::open_ambient_dir(&staging, ambient_authority()).unwrap();
        let paths = validate_apply_paths(
            files
                .iter()
                .map(|(path, _)| ManifestFileEntry {
                    path: path.to_string(),
                    size: None,
                    encoding: None,
                })
                .collect(),
            deletes.iter().map(|path| path.to_string()).collect(),
            archive.len() as u64,
            1 << 24,
        )
        .unwrap();
        let staged = stage_archive(Cursor::new(archive), paths, 1 << 24, &dir).unwrap();
        Change::Edits(Edits::new(
            staging,
            staged.files,
            staged.deletes,
            base_rev.map(str::to_string),
            BTreeMap::new(),
            false,
        ))
    }

    fn commit(&self, change: &mut Change, message: &str) -> Result<CasOutcome, OriginError> {
        self.commit_as(change, message, None, None)
    }

    /// [`Self::commit`] for a caller with this bearer, expiring then.
    fn commit_as(
        &self,
        change: &mut Change,
        message: &str,
        caller: Option<String>,
        caller_expires: Option<std::time::SystemTime>,
    ) -> Result<CasOutcome, OriginError> {
        let lease = self.cache.lease(self.project);
        let dir = self.cache.ensure_mirror(&lease.mirror()).unwrap();
        let quarantine = self.cache.quarantine_dir().unwrap();
        let committer = gateway();
        let mut canonical = CachedCanonical::new(
            self.cache.clone(),
            lease,
            caller,
            self.runtime.handle().clone(),
        )
        .caller_expires(caller_expires);
        let target = CasTarget {
            mirror: &dir,
            quarantine_parent: &quarantine,
            remote: &self.remote,
            committer: &committer,
            // Longer than a save's budget, so a test can count every
            // attempt on a loaded machine.
            deadline: Instant::now() + Duration::from_secs(60),
            admission: None,
        };
        cas_commit(&target, change, &gateway(), message, None, &mut canonical)
    }
}

/// Clears this thread's push hook when dropped.
struct HookGuard;

impl Drop for HookGuard {
    fn drop(&mut self) {
        clear_push_hook();
    }
}

// ---------------------------------------------------------------------------
// Saves through the routes.
// ---------------------------------------------------------------------------

/// r3 test 1 (the 571f87db regression): a runtime pushed R; a save made
/// on the gateway lands on R with every file of R intact, and reads show it
/// at once.
#[tokio::test(flavor = "multi_thread")]
async fn a_save_lands_on_what_a_runtime_pushed() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let served = serve(&sc).await;
    // The gateway's view is now first; a runtime moves main past it.
    assert_eq!(get(&served, "/files/README.md").await.rev(), Some(first));
    let runtime = sc.push(
        &[
            ("src/lib.rs", Some(b"pub fn x() {}\n")),
            ("README.md", Some(b"two\n")),
        ],
        "runtime",
    );

    let answer = apply(
        &served,
        manifest(&["notes.md"], &[], json!({})),
        &zip(&[("notes.md", b"hello\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let body = answer.json();
    let saved = rev(&answer);
    assert_eq!(body["committed"], true);
    assert_eq!(body["baseRev"], runtime.as_str());
    assert_eq!(body["fileCount"], 1);
    assert_eq!(body["bytesWritten"], 6);
    assert_eq!(sc.canonical_main().as_deref(), Some(saved.as_str()));
    assert_eq!(parent(&sc, &saved), runtime);
    assert_eq!(show(&sc, &saved, "README.md").unwrap(), b"two\n");
    assert_eq!(show(&sc, &saved, "src/lib.rs").unwrap(), b"pub fn x() {}\n");
    assert_eq!(show(&sc, &saved, "notes.md").unwrap(), b"hello\n");
    assert_eq!(
        canonical(
            &sc,
            &["log", "-1", "--format=%s%n%an <%ae>%n%cn <%ce>", &saved]
        ),
        "Update notes.md\ninstafy-origin <gateway@instafy.dev>\ninstafy-origin <gateway@instafy.dev>"
    );

    // The mirror moved with the push: a read right after needs no fetch.
    let fetches = served.cache.fetches_started();
    let read = get(&served, "/files/notes.md").await;
    assert_eq!(read.status, 200);
    assert_eq!(read.rev().as_deref(), Some(saved.as_str()));
    assert_eq!(decoded(&read), b"hello\n");
    assert_eq!(served.cache.fetches_started(), fetches);
    // Nothing is left behind in the cache's scratch folders.
    for scratch in [".quarantine", ".staging"] {
        let left = std::fs::read_dir(sc.root.join(".git-cache").join(scratch))
            .unwrap()
            .count();
        assert_eq!(left, 0, "{scratch}");
    }
}

/// r3 test 2: with a stale baseRev, a path that changed since is refused,
/// another path is saved on the new main, a folder delete keeps a file
/// added since, and a folder that became a file is a path type conflict.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_base_refuses_only_the_paths_that_moved() {
    let sc = HostedScenario::new();
    let read_at = sc.push(
        &[
            ("doc.md", Some(b"alpha\n")),
            ("other.md", Some(b"other\n")),
            ("dir/a.txt", Some(b"a\n")),
            ("x/y.txt", Some(b"y\n")),
        ],
        "seed",
    );
    let served = serve(&sc).await;
    let moved = sc.push(
        &[("doc.md", Some(b"beta\n")), ("dir/new.txt", Some(b"new\n"))],
        "elsewhere",
    );

    let answer = apply(
        &served,
        manifest(&["doc.md"], &[], json!({ "baseRev": read_at })),
        &zip(&[("doc.md", b"mine\n")]),
    )
    .await;
    assert_eq!((answer.status, answer.code().as_str()), (409, "head_moved"));
    assert_eq!(answer.json()["head"], moved.as_str());
    assert_eq!(answer.json()["paths"], json!(["doc.md"]));
    assert_eq!(sc.canonical_main().as_deref(), Some(moved.as_str()));

    let answer = apply(
        &served,
        manifest(&["other.md"], &[], json!({ "baseRev": read_at })),
        &zip(&[("other.md", b"edited\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let saved = rev(&answer);
    assert_eq!(parent(&sc, &saved), moved);
    assert_eq!(show(&sc, &saved, "doc.md").unwrap(), b"beta\n");

    let answer = apply(
        &served,
        manifest(&[], &["dir"], json!({ "baseRev": read_at })),
        &zip(&[]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let deleted = rev(&answer);
    assert_eq!(show(&sc, &deleted, "dir/a.txt"), None);
    assert_eq!(show(&sc, &deleted, "dir/new.txt").unwrap(), b"new\n");
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%s", &deleted]),
        "Delete dir"
    );

    // Elsewhere the folder x became a file.
    let swapped = sc.push(&[("x/y.txt", None), ("x", Some(b"file now\n"))], "swap");
    let answer = apply(
        &served,
        manifest(&["x/z.txt"], &[], json!({ "baseRev": read_at })),
        &zip(&[("x/z.txt", b"z\n")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "path_type_conflict")
    );
    assert_eq!(answer.json()["paths"], json!(["x/z.txt"]));
    // And a file where a folder is.
    let answer = apply(
        &served,
        manifest(&["dir"], &[], json!({ "baseRev": swapped })),
        &zip(&[("dir", b"not a folder\n")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "path_type_conflict")
    );
    assert_eq!(sc.canonical_main().as_deref(), Some(swapped.as_str()));
}

/// r3e1-r3e4: a client read version B; each change made elsewhere since
/// makes the client's write of the same file a 409, and nothing changes.
#[tokio::test(flavor = "multi_thread")]
async fn changes_made_elsewhere_since_the_read_are_never_overwritten() {
    let seed: &[(&str, Option<&[u8]>)] = &[
        ("README.md", Some(b"readme\n")),
        ("doc.md", Some(b"alpha\nbeta\n")),
        ("logo.bin", Some(&[0, 1, 2, 3, 159, 146])),
    ];
    // e1: renamed elsewhere; the client writes the old name.
    // e2: deleted elsewhere; the client writes it.
    // e3: edited elsewhere; the client deletes it.
    // e4: a binary file changed on both sides.
    type Elsewhere = &'static [(&'static str, Option<&'static [u8]>)];
    let cases: [(&str, Elsewhere, &[&str], &[&str]); 4] = [
        (
            "e1",
            &[("doc.md", None), ("docs/doc.md", Some(b"alpha\nbeta\n"))],
            &["doc.md"],
            &[],
        ),
        ("e2", &[("doc.md", None)], &["doc.md"], &[]),
        (
            "e3",
            &[("doc.md", Some(b"alpha\nedited\n"))],
            &[],
            &["doc.md"],
        ),
        ("e4", &[("logo.bin", Some(&[9, 9, 9]))], &["logo.bin"], &[]),
    ];
    for (name, elsewhere, writes, deletes) in cases {
        let sc = HostedScenario::new();
        let read_at = sc.push(seed, "seed");
        let served = serve(&sc).await;
        let head = sc.push(elsewhere, name);
        let files: Vec<(&str, &[u8])> = writes.iter().map(|path| (*path, &b"mine\n"[..])).collect();
        let answer = apply(
            &served,
            manifest(writes, deletes, json!({ "baseRev": read_at })),
            &zip(&files),
        )
        .await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (409, "head_moved"),
            "{name}: {}",
            answer.json()
        );
        assert_eq!(
            sc.canonical_main().as_deref(),
            Some(head.as_str()),
            "{name}"
        );
        if name == "e2" {
            // A write of a file nobody touched still lands.
            let answer = apply(
                &served,
                manifest(&["README.md"], &[], json!({ "baseRev": read_at })),
                &zip(&[("README.md", b"new readme\n")]),
            )
            .await;
            assert_eq!(answer.status, 200, "{}", answer.json());
            assert_eq!(show(&sc, &rev(&answer), "doc.md"), None);
        }
    }
}

/// r3 test 6: a save sent twice (the answer to the first was lost) is a
/// no-op the second time, even with the conditions of the first read.
#[tokio::test(flavor = "multi_thread")]
async fn a_retried_save_changes_nothing() {
    let sc = HostedScenario::new();
    let read_at = sc.push(&[("a.txt", Some(b"one\n"))], "seed");
    let served = serve(&sc).await;
    let old_blob = sc.blob("one\n");
    let request = manifest(
        &["a.txt"],
        &[],
        json!({ "baseRev": read_at, "expected": { "a.txt": old_blob } }),
    );
    let archive = zip(&[("a.txt", b"two\n")]);
    let first = apply(&served, request.clone(), &archive).await;
    assert_eq!(first.status, 200, "{}", first.json());
    assert_eq!(first.json()["committed"], true);
    let saved = rev(&first);

    let again = apply(&served, request, &archive).await;
    assert_eq!(again.status, 200, "{}", again.json());
    assert_eq!(again.json()["committed"], false);
    assert_eq!(again.json()["rev"], saved.as_str());
    assert_eq!(again.json()["baseRev"], saved.as_str());
    assert_eq!(sc.canonical_main().as_deref(), Some(saved.as_str()));
}

/// A delete made on an old read of a path that is now the other kind of
/// entry (a file that became a folder, a folder that became a file)
/// removes nothing, and is answered as a change since the read, never as
/// done. A delete of a file that is simply gone stays a no-op, also when
/// retried with its first conditions.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_delete_of_a_path_that_changed_kind_is_head_moved() {
    let sc = HostedScenario::new();
    let read_at = sc.push(
        &[
            ("p", Some(b"x\n")),
            ("d/a.txt", Some(b"a\n")),
            ("d/b.txt", Some(b"b\n")),
            ("gone.txt", Some(b"g\n")),
            ("keep.txt", Some(b"k\n")),
        ],
        "seed",
    );
    let served = serve(&sc).await;
    let x = sc.blob("x\n");
    // Someone else turns the file p into a folder and the folder d into a
    // file, and deletes gone.txt.
    sc.push(
        &[
            ("p", None),
            ("d/a.txt", None),
            ("d/b.txt", None),
            ("gone.txt", None),
        ],
        "clear",
    );
    let swapped = sc.push(
        &[("p/q.txt", Some(b"q\n")), ("d", Some(b"now a file\n"))],
        "swap",
    );

    for extra in [
        json!({ "baseRev": read_at, "expected": { "p": x } }),
        json!({ "baseRev": read_at }),
    ] {
        let answer = apply(&served, manifest(&[], &["p"], extra.clone()), &zip(&[])).await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (409, "head_moved"),
            "{extra}: {}",
            answer.json()
        );
        assert_eq!(answer.json()["head"], swapped.as_str());
        assert!(
            answer.json()["paths"]
                .as_array()
                .unwrap()
                .contains(&json!("p")),
            "{}",
            answer.json()
        );
    }
    let answer = apply(
        &served,
        manifest(&[], &["d"], json!({ "baseRev": read_at })),
        &zip(&[]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "head_moved"),
        "{}",
        answer.json()
    );
    assert!(
        answer.json()["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("d")),
        "{}",
        answer.json()
    );
    assert_eq!(sc.canonical_main().as_deref(), Some(swapped.as_str()));
    assert_eq!(show(&sc, &swapped, "p/q.txt").unwrap(), b"q\n");
    assert_eq!(show(&sc, &swapped, "d").unwrap(), b"now a file\n");

    // A file deleted elsewhere: nothing to do.
    let gone = sc.blob("g\n");
    let answer = apply(
        &served,
        manifest(
            &[],
            &["gone.txt"],
            json!({ "baseRev": read_at, "expected": { "gone.txt": gone } }),
        ),
        &zip(&[]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["committed"], false);
    assert_eq!(answer.json()["rev"], swapped.as_str());
}

/// `expected` holds what each path held when the client read it.
#[tokio::test(flavor = "multi_thread")]
async fn expected_blobs_must_still_be_on_main() {
    let sc = HostedScenario::new();
    sc.push(
        &[("a.txt", Some(b"one\n")), ("b.txt", Some(b"b\n"))],
        "seed",
    );
    let served = serve(&sc).await;
    let one = sc.blob("one\n");

    // Right blob, and a path that must not exist: saved.
    let answer = apply(
        &served,
        manifest(
            &["a.txt", "c.txt"],
            &[],
            json!({ "expected": { "a.txt": one, "c.txt": null } }),
        ),
        &zip(&[("a.txt", b"two\n"), ("c.txt", b"c\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let head = rev(&answer);

    // a.txt moved on, and c.txt exists now.
    let answer = apply(
        &served,
        manifest(
            &["a.txt", "c.txt"],
            &[],
            json!({ "expected": { "a.txt": one, "c.txt": null, "b.txt": sc.blob("b\n") } }),
        ),
        &zip(&[("a.txt", b"three\n"), ("c.txt", b"cc\n")]),
    )
    .await;
    assert_eq!((answer.status, answer.code().as_str()), (409, "head_moved"));
    assert_eq!(answer.json()["paths"], json!(["a.txt", "c.txt"]));
    assert_eq!(answer.json()["head"], head.as_str());
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));

    for bad in [json!({ "a.txt": "xyz" }), json!({ "../a": null })] {
        let answer = apply(
            &served,
            manifest(&["a.txt"], &[], json!({ "expected": bad })),
            &zip(&[("a.txt", b"x\n")]),
        )
        .await;
        assert_eq!(answer.status, 400, "{}", answer.json());
    }
}

/// r3 test 16: a save without baseRev changes exact paths only, refuses a
/// folder delete, and is logged with the client's label.
#[tokio::test]
async fn a_save_without_a_base_changes_exact_paths_only_and_is_logged() {
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let capture = Capture::default();
    let writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    // Another test's thread may have registered the log line's callsite
    // while this subscriber was being set up, caching "no subscriber is
    // interested"; ask every callsite again now that it exists.
    tracing::callsite::rebuild_interest_cache();

    let sc = HostedScenario::new();
    sc.push(
        &[("dir/a.txt", Some(b"a\n")), ("dir/b.txt", Some(b"b\n"))],
        "seed",
    );
    let served = serve(&sc).await;
    let answer = apply_as(
        &served,
        manifest(&[], &["dir"], json!({})),
        &zip(&[]),
        None,
        Some("web/abc123"),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "delete_requires_base_rev")
    );
    let answer = apply_as(
        &served,
        manifest(&[], &["dir/a.txt"], json!({})),
        &zip(&[]),
        None,
        Some("bad label"),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(show(&sc, &rev(&answer), "dir/a.txt"), None);
    assert_eq!(show(&sc, &rev(&answer), "dir/b.txt").unwrap(), b"b\n");

    let logged = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    let lines: Vec<&str> = logged
        .lines()
        .filter(|line| line.contains("origin_apply_no_base_rev"))
        .collect();
    assert_eq!(lines.len(), 2, "{logged}");
    assert!(lines[0].contains("client=web/abc123"), "{logged}");
    assert!(lines[1].contains("client=unknown"), "{logged}");
    assert!(lines
        .iter()
        .all(|line| line.contains(&sc.project.to_string())));
}

/// Two saves of `path` (with and without a base) are refused with `code`.
async fn refuse(served: &Served, head: &str, path: &str, code: &str, reason: Option<&str>) {
    for base in [json!({}), json!({ "baseRev": head })] {
        let answer = apply(
            served,
            manifest(&[path], &[], base),
            &zip(&[(path, b"x\n")]),
        )
        .await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (422, code),
            "{path}: {}",
            answer.json()
        );
        assert_eq!(answer.json()["paths"], json!([path]), "{path}");
        if let Some(reason) = reason {
            assert_eq!(answer.json()["reason"], reason, "{path}");
        }
    }
}

/// r3 test 11 and Q7: ignored new files, Instafy and build paths, secrets
/// and legacy chat uploads are refused before any push; a tracked ignored
/// file stays editable, and a legacy upload can be deleted.
#[tokio::test(flavor = "multi_thread")]
async fn paths_that_may_never_be_saved_are_refused_before_the_push() {
    let sc = HostedScenario::new();
    let head = sc.push(
        &[
            (".gitignore", Some(b"*.log\n.env\nsecret-dir/\n")),
            ("keep.log", Some(b"tracked anyway\n")),
            ("chat-upload-1-a.png", Some(b"png")),
        ],
        "seed",
    );
    let served = serve(&sc).await;
    refuse(&served, &head, ".env", "ignored_path", None).await;
    refuse(&served, &head, "app/debug.log", "ignored_path", None).await;
    refuse(&served, &head, "secret-dir/notes.md", "ignored_path", None).await;
    refuse(&served, &head, "tmp/x", "excluded_path", Some("excluded")).await;
    refuse(
        &served,
        &head,
        "web/node_modules/a.js",
        "excluded_path",
        Some("excluded"),
    )
    .await;
    refuse(
        &served,
        &head,
        "chat-upload-2-b.png",
        "excluded_path",
        Some("attachment"),
    )
    .await;
    refuse(
        &served,
        &head,
        "app/.env.local",
        "excluded_path",
        Some("secret"),
    )
    .await;
    refuse(
        &served,
        &head,
        "certs/server.pem",
        "excluded_path",
        Some("secret"),
    )
    .await;
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));

    // A file the space tracks although it is ignored can be edited, and a
    // legacy upload deleted.
    let answer = apply(
        &served,
        manifest(
            &["keep.log"],
            &["chat-upload-1-a.png"],
            json!({ "baseRev": head }),
        ),
        &zip(&[("keep.log", b"edited\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let saved = rev(&answer);
    assert_eq!(show(&sc, &saved, "keep.log").unwrap(), b"edited\n");
    assert_eq!(show(&sc, &saved, "chat-upload-1-a.png"), None);

    // A new .gitignore in the same save applies to the save's new files.
    let answer = apply(
        &served,
        manifest(
            &["sub/.gitignore", "sub/out.txt"],
            &[],
            json!({ "baseRev": saved }),
        ),
        &zip(&[("sub/.gitignore", b"*.txt\n"), ("sub/out.txt", b"o\n")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (422, "ignored_path")
    );
    assert_eq!(answer.json()["paths"], json!(["sub/out.txt"]));

    // Without a .gitignore, .env is a secret.
    let plain = HostedScenario::new();
    plain.push(&[("README.md", Some(b"r\n"))], "seed");
    let served = serve(&plain).await;
    let answer = apply(
        &served,
        manifest(&[".env"], &[], json!({})),
        &zip(&[(".env", b"KEY=1\n")]),
    )
    .await;
    assert_eq!(
        (
            answer.status,
            answer.code().as_str(),
            answer.json()["reason"].clone()
        ),
        (422, "excluded_path", json!("secret"))
    );
}

/// The shard's own refusals of a path: its extra deny list is 422
/// `excluded_path`, its size cap 422 `policy_rejected`, and a refused push
/// leaves no object in the mirror. A save that landed reads without
/// canonical: its objects and `main` are in the mirror.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_push_leaves_nothing_and_a_landed_one_needs_no_fetch() {
    let sc = HostedScenario::new();
    install_shard_hook(
        &sc.remote(),
        &[("GIT_DENY_PATHS", "*.zip"), ("GIT_MAX_BLOB_BYTES", "64")],
    );
    let head = sc.push(&[("README.md", Some(b"readme\n"))], "seed");
    let served = serve(&sc).await;
    assert_eq!(get(&served, "/entries").await.status, 200);
    let mirror = sc.mirror();
    let objects = object_files(&mirror);

    let answer = apply(
        &served,
        manifest(&["assets/a.zip"], &[], json!({ "baseRev": head })),
        &zip(&[("assets/a.zip", b"zip")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (422, "excluded_path"),
        "{}",
        answer.json()
    );
    assert_eq!(answer.json()["reason"], "policy");
    assert_eq!(answer.json()["paths"], json!(["assets/a.zip"]));

    let answer = apply(
        &served,
        manifest(&["big.txt"], &[], json!({ "baseRev": head })),
        &zip(&[("big.txt", &[b'x'; 100])]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (422, "policy_rejected"),
        "{}",
        answer.json()
    );
    assert_eq!(answer.json()["reason"], "too_large");
    assert_eq!(object_files(&mirror), objects, "no refused object stays");
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));

    let answer = apply(
        &served,
        manifest(&["ok.txt"], &[], json!({ "baseRev": head })),
        &zip(&[("ok.txt", b"fine\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let saved = rev(&answer);
    // Canonical goes away: the save still reads from the mirror.
    let moved = sc.canonical.with_extension("away");
    std::fs::rename(&sc.canonical, &moved).unwrap();
    let read = get(&served, &format!("/files/ok.txt?rev={saved}")).await;
    assert_eq!(read.status, 200);
    assert_eq!(decoded(&read), b"fine\n");
    std::fs::rename(&moved, &sc.canonical).unwrap();
}

/// A file over the save limit is refused before the push.
#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_the_save_limit_is_refused() {
    let sc = HostedScenario::new();
    let head = sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let served = serve(&sc).await;
    let big = vec![0u8; 20 * 1024 * 1024 + 1];
    let answer = apply(
        &served,
        manifest(&["data.bin"], &[], json!({ "baseRev": head })),
        &zip(&[("data.bin", &big)]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (422, "policy_rejected"),
        "{}",
        answer.json()
    );
    assert_eq!(answer.json()["paths"], json!(["data.bin"]));
}

/// Links and submodules are never written over; a manifest naming a
/// reserved path is refused as a bad manifest.
#[tokio::test(flavor = "multi_thread")]
async fn links_submodules_and_reserved_paths_are_not_written() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let target = sc.blob("README.md");
    sc.push_entry("link", "120000", &target, "a link");
    let any = git_in(&sc.work, &["rev-parse", "HEAD"]);
    let head = sc.push_entry("vendor/sub", "160000", &any, "a submodule");
    let served = serve(&sc).await;
    for path in ["link", "vendor/sub"] {
        let answer = apply(
            &served,
            manifest(&[path], &[], json!({ "baseRev": head })),
            &zip(&[(path, b"x\n")]),
        )
        .await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (400, "unsupported_entry"),
            "{path}"
        );
    }
    for path in [".instafy/state.json", "a/.git/config"] {
        let answer = apply(
            &served,
            manifest(&[path], &[], json!({ "baseRev": head })),
            &zip(&[(path, b"x\n")]),
        )
        .await;
        assert_eq!(answer.status, 400, "{path}");
    }
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));
}

/// The controller's managed-files bootstrap (5.3): it reads each file,
/// writes the missing ones with `expected: null`, `baseRev` and
/// `autoCommitAfterApply`, and on a 409 reads again and leaves alone a path
/// the 409 named that still reads as missing.
fn bootstrap_manifest(head: &str, paths: &[&str]) -> serde_json::Value {
    let expected: serde_json::Map<String, serde_json::Value> = paths
        .iter()
        .map(|path| (path.to_string(), serde_json::Value::Null))
        .collect();
    manifest(
        paths,
        &[],
        json!({
            "baseRev": head,
            "expected": expected,
            "autoCommitAfterApply": true,
            "commitMessage": "instafy: bootstrap project memory",
        }),
    )
}

/// A managed file that is a link or a submodule on `main` reads as 404
/// `unsupported_entry`; writing it with "it was absent" is a 409 naming it
/// (so the bootstrap leaves it alone and seeds the rest), never a refusal
/// of the whole write. Without a condition it stays 400.
#[tokio::test(flavor = "multi_thread")]
async fn a_bootstrap_leaves_linked_managed_files_alone_and_seeds_the_rest() {
    let sc = HostedScenario::new();
    sc.push(&[("AGENTS.md", Some(b"agents\n"))], "seed");
    let target = sc.blob("AGENTS.md");
    sc.push_entry("CLAUDE.md", "120000", &target, "a link");
    let any = git_in(&sc.work, &["rev-parse", "HEAD"]);
    let head = sc.push_entry("INSTAFY.md", "160000", &any, "a submodule");
    let served = serve(&sc).await;
    let skill = ".agents/skills/x/SKILL.md";

    for linked in ["CLAUDE.md", "INSTAFY.md"] {
        let read = get(&served, &format!("/files/{linked}?encoding=base64")).await;
        assert_eq!(
            (read.status, read.code().as_str()),
            (404, "unsupported_entry")
        );
        assert_eq!(read.rev().as_deref(), Some(head.as_str()));
    }
    let paths = ["CLAUDE.md", "INSTAFY.md", skill];
    let answer = apply(
        &served,
        bootstrap_manifest(&head, &paths),
        &zip(&[
            ("CLAUDE.md", b"c\n"),
            ("INSTAFY.md", b"i\n"),
            (skill, b"s\n"),
        ]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "head_moved"),
        "{}",
        answer.json()
    );
    assert_eq!(answer.json()["paths"], json!(["CLAUDE.md", "INSTAFY.md"]));
    assert_eq!(answer.json()["head"], head.as_str());
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));

    // Read again: still missing, so the retry leaves both alone.
    let read = get(&served, "/files/CLAUDE.md?encoding=base64").await;
    assert_eq!(
        (read.status, read.code().as_str()),
        (404, "unsupported_entry")
    );
    let answer = apply(
        &served,
        bootstrap_manifest(&head, &[skill]),
        &zip(&[(skill, b"s\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["committed"], true);
    let seeded = rev(&answer);
    assert_eq!(show(&sc, &seeded, skill).unwrap(), b"s\n");
    assert!(canonical(&sc, &["ls-tree", &seeded, "CLAUDE.md"]).starts_with("120000 "));

    // Without a condition, writing over a link is still refused outright.
    let answer = apply(
        &served,
        manifest(&["CLAUDE.md"], &[], json!({ "baseRev": seeded })),
        &zip(&[("CLAUDE.md", b"c\n")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "unsupported_entry")
    );
}

/// A managed file the space's `.gitignore` ignores is seeded like tracked
/// content when the controller writes it (`autoCommitAfterApply`, as the
/// single-tenant apply force-adds); a person's save of a new ignored file
/// is still 422 `ignored_path`, and secrets stay out either way.
#[tokio::test(flavor = "multi_thread")]
async fn a_bootstrap_seeds_managed_files_the_space_ignores() {
    let sc = HostedScenario::new();
    let head = sc.push(
        &[
            ("README.md", Some(b"r\n")),
            (".gitignore", Some(b"CLAUDE.md\n.agents/\n")),
        ],
        "seed",
    );
    let served = serve(&sc).await;
    let skill = ".agents/skills/x/SKILL.md";
    let state = ".agents/.instafy-managed-defaults-state.json";

    let plain = apply(
        &served,
        manifest(&["CLAUDE.md"], &[], json!({ "baseRev": head })),
        &zip(&[("CLAUDE.md", b"c\n")]),
    )
    .await;
    assert_eq!((plain.status, plain.code().as_str()), (422, "ignored_path"));

    let paths = ["AGENTS.md", "CLAUDE.md", skill, state];
    let answer = apply(
        &served,
        bootstrap_manifest(&head, &paths),
        &zip(&[
            ("AGENTS.md", b"a\n"),
            ("CLAUDE.md", b"c\n"),
            (skill, b"s\n"),
            (state, b"{}\n"),
        ]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let seeded = rev(&answer);
    for path in paths {
        assert!(show(&sc, &seeded, path).is_some(), "{path}");
    }

    let secret = apply(
        &served,
        bootstrap_manifest(&seeded, &[".env"]),
        &zip(&[(".env", b"KEY=1\n")]),
    )
    .await;
    assert_eq!(
        (secret.status, secret.code().as_str()),
        (422, "excluded_path")
    );
}

/// Executable bits come from the upload, or stay as they were.
#[tokio::test(flavor = "multi_thread")]
async fn modes_follow_the_upload_or_stay() {
    let sc = HostedScenario::new();
    let served = serve(&sc).await;
    // A space without main gets a first commit with no parent.
    let answer = apply(
        &served,
        manifest(&["run.sh", "plain.txt"], &[], json!({})),
        &zip_modes(&[
            ("run.sh", b"#!/bin/sh\n", true),
            ("plain.txt", b"p\n", false),
        ]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["baseRev"], json!(null));
    let first = rev(&answer);
    assert_eq!(
        canonical(&sc, &["rev-list", "--parents", "-n", "1", &first]),
        first
    );
    let modes = canonical(&sc, &["ls-tree", &first]);
    assert!(
        modes.contains("100755 blob") && modes.contains("run.sh"),
        "{modes}"
    );
    assert!(modes.contains("100644 blob"), "{modes}");

    // An edit without the bit keeps the file executable.
    let answer = apply(
        &served,
        manifest(&["run.sh"], &[], json!({ "baseRev": first })),
        &zip(&[("run.sh", b"#!/bin/sh\necho\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let listed = canonical(&sc, &["ls-tree", &rev(&answer), "run.sh"]);
    assert!(listed.starts_with("100755 "), "{listed}");
}

/// Commit messages: the caller's text without `Instafy-` lines, or a plain
/// default.
#[tokio::test(flavor = "multi_thread")]
async fn caller_messages_never_carry_instafy_trailers() {
    let sc = HostedScenario::new();
    let head = sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let served = serve(&sc).await;
    let answer = apply(
        &served,
        manifest(
            &["a.txt"],
            &[],
            json!({
                "baseRev": head,
                "commitMessage": "Tidy the notes\n\nInstafy-Apply-Key: imp:planted\n  instafy-restored-from: refs/instafy/salvage/gateway/x\nMore text",
            }),
        ),
        &zip(&[("a.txt", b"b\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let message = canonical(&sc, &["log", "-1", "--format=%B", &rev(&answer)]);
    assert_eq!(message, "Tidy the notes\n\nMore text");

    let answer = apply(
        &served,
        manifest(
            &["b.txt", "c.txt"],
            &["a.txt"],
            json!({ "commitMessage": "Instafy-Only: x" }),
        ),
        &zip(&[("b.txt", b"b\n"), ("c.txt", b"c\n")]),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%B", &rev(&answer)]),
        "Update 3 files"
    );

    // A control character in front of `Instafy-` (C0, DEL, C1, escape,
    // vertical tab), alone or after blanks, never keeps the line.
    for hidden in [
        "\u{1}", "\u{7f}", "\u{80}", "\u{1b}", "\u{b}", " \t\u{1}", "\u{85}",
    ] {
        let text = format!(
            "Tidy\n\n{hidden}Instafy-Restored-From: refs/instafy/salvage/gateway/n\n{hidden}instafy-apply-key: imp:k"
        );
        assert_eq!(
            caller_message(Some(&text)).as_deref(),
            Some("Tidy"),
            "{hidden:?}"
        );
    }
}

/// A person's save whose message hides gateway trailers behind control
/// characters: the commit carries none, the salvage ref is not marked
/// restored and the import's receipt is still the import's commit.
#[tokio::test(flavor = "multi_thread")]
async fn a_control_character_never_smuggles_gateway_trailers() {
    let mut sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let salvaged = sc.side_commit(&[("draft.md", b"draft\n")], "kept");
    let salvage_ref = "refs/instafy/salvage/gateway/node-1-0123abcd";
    sc.push_ref(&salvaged, salvage_ref);
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve(&sc).await;

    let import = controller.token(&["fs.write", "workspace.import"], json!({}));
    let key = "imp:0123456789abcdef";
    let imported = apply_as(
        &served,
        manifest(
            &["src/app.ts"],
            &[],
            json!({
                "leaseId": controller.lease.to_string(),
                "idempotencyKey": key,
                "requestFingerprint": "sha256:aaaa",
                "commitMessage": "Import from GitHub",
            }),
        ),
        &zip(&[("src/app.ts", b"export {}\n")]),
        Some(&import),
        None,
    )
    .await;
    assert_eq!(imported.status, 200, "{}", imported.json());
    let imported = rev(&imported);

    let person = controller.token(&["fs.read", "fs.write"], json!({}));
    for hidden in ["\u{1}", "\u{7f}", "\u{80}"] {
        let message = format!(
            "Tidy\n\n{hidden}Instafy-Restored-From: {salvage_ref}\n{hidden}Instafy-Apply-Key: {key}\n{hidden}Instafy-Apply-Fingerprint: sha256:aaaa"
        );
        let head = sc.canonical_main().unwrap();
        let saved = apply_as(
            &served,
            manifest(
                &["notes.md"],
                &[],
                json!({
                    "leaseId": controller.lease.to_string(),
                    "baseRev": head,
                    "commitMessage": message,
                }),
            ),
            &zip(&[("notes.md", format!("{hidden:?}\n").as_bytes())]),
            Some(&person),
            None,
        )
        .await;
        assert_eq!(saved.status, 200, "{}", saved.json());
        let saved = rev(&saved);
        assert_eq!(
            canonical(&sc, &["log", "-1", "--format=%B", &saved]),
            "Tidy",
            "{hidden:?}"
        );
        assert_eq!(
            canonical(&sc, &["log", "-1", "--format=%(trailers)", &saved]),
            "",
            "{hidden:?}"
        );
    }

    let listed = reqwest::Client::new()
        .get(format!("{}/git/recovery", served.base))
        .bearer_auth(&person)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), 200);
    let listed: serde_json::Value = listed.json().await.unwrap();
    let salvage = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref"] == salvage_ref)
        .cloned()
        .expect("the salvage ref is listed");
    assert!(salvage.get("restoredRev").is_none(), "{salvage}");

    let status = post_as(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": key, "requestFingerprint": "sha256:aaaa" }),
        &import,
    )
    .await;
    assert_eq!(status.status, 200, "{}", status.json());
    assert_eq!(status.json()["rev"], imported.as_str());
}

/// The multipart form is served too, and an idempotency key from anything
/// but an import is refused.
#[tokio::test(flavor = "multi_thread")]
async fn multipart_uploads_and_keys_outside_imports() {
    let sc = HostedScenario::new();
    let served = serve(&sc).await;
    let archive = zip(&[("m.txt", b"multi\n")]);
    let manifest_text = manifest(&["m.txt"], &[], json!({})).to_string();
    let boundary = "instafy-test-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n{manifest_text}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"archive\"; filename=\"a.zip\"\r\nContent-Type: application/zip\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&archive);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = reqwest::Client::new()
        .post(format!("{}/apply", served.base))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let saved: serde_json::Value = response.json().await.unwrap();
    assert_eq!(saved["committed"], true);
    assert_eq!(
        show(&sc, saved["rev"].as_str().unwrap(), "m.txt").unwrap(),
        b"multi\n"
    );

    let answer = apply(
        &served,
        manifest(
            &["n.txt"],
            &[],
            json!({ "idempotencyKey": "imp:abc", "requestFingerprint": "sha256:1" }),
        ),
        &zip(&[("n.txt", b"n\n")]),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "idempotency_requires_import")
    );
    let answer = post(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": "imp:abc" }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "idempotency_requires_import")
    );
}

/// r3 test 9: an import is committed once with its key; its receipt is
/// read from main (also after the cache is deleted), a different request
/// under the same key is a conflict, and commits the gateway did not make
/// never count, even when they carry the key or the gateway's address.
#[tokio::test(flavor = "multi_thread")]
async fn imports_are_committed_once_and_found_by_their_key() {
    let mut sc = HostedScenario::new();
    let head = sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve(&sc).await;
    let import = controller.token(&["fs.write", "workspace.import"], json!({}));
    let key = "imp:0123456789abcdef";
    let request = manifest(
        &["src/app.ts", "dist/out.js", ".env", "huge.bin"],
        &[],
        json!({
            "projectId": sc.project.to_string(),
            "leaseId": controller.lease.to_string(),
            "idempotencyKey": key,
            "requestFingerprint": "sha256:aaaa",
            "commitMessage": "Import from GitHub",
        }),
    );
    let big = vec![1u8; 20 * 1024 * 1024 + 1];
    let archive = zip(&[
        ("src/app.ts", b"export {}\n"),
        ("dist/out.js", b"built\n"),
        (".env", b"KEY=1\n"),
        ("huge.bin", &big),
    ]);
    let answer = apply_as(&served, request.clone(), &archive, Some(&import), None).await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let body = answer.json();
    let imported = rev(&answer);
    assert_eq!(body["committed"], true);
    assert_eq!(body["baseRev"], head.as_str());
    assert_eq!(
        (body["fileCount"].clone(), body["bytesWritten"].clone()),
        (json!(1), json!(10))
    );
    // What may never be saved is left out of an import, and named.
    assert_eq!(
        body["skippedPaths"],
        json!([
            { "path": ".env", "reason": "secret" },
            { "path": "dist/out.js", "reason": "excluded" },
            { "path": "huge.bin", "reason": "too_large" },
        ])
    );
    assert_eq!(show(&sc, &imported, "dist/out.js"), None);
    assert_eq!(show(&sc, &imported, "src/app.ts").unwrap(), b"export {}\n");
    // What an import leaves out is never hashed, so never reaches the mirror.
    for left_out in ["KEY=1\n", "built\n"] {
        let blob = sc.blob(left_out);
        let present = git_output(&sc.mirror(), &["cat-file", "-e", &blob], None);
        assert!(!present.status.success(), "{left_out:?} reached the mirror");
    }
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%B", &imported]),
        format!("Import from GitHub\n\nInstafy-Apply-Key: {key}\nInstafy-Apply-Fingerprint: sha256:aaaa")
    );

    // The same request again replays the commit.
    sc.push(&[("later.txt", Some(b"l\n"))], "later work");
    let again = apply_as(&served, request.clone(), &archive, Some(&import), None).await;
    assert_eq!(again.status, 200, "{}", again.json());
    assert_eq!(again.json()["rev"], imported.as_str());
    assert_eq!(again.json()["replayed"], true);
    assert_eq!(again.json()["baseRev"], head.as_str());
    assert_eq!(again.json()["fileCount"], 1);

    // The receipt, also from a cache rebuilt from nothing.
    let status_body = json!({ "idempotencyKey": key, "requestFingerprint": "sha256:aaaa" });
    let status = post_as(&served, "/apply/status", status_body.clone(), &import).await;
    assert_eq!(status.status, 200, "{}", status.json());
    assert_eq!(
        status.json(),
        json!({
            "status": "succeeded",
            "rev": imported,
            "baseRev": head,
            "fileCount": 1,
            "bytesWritten": 10,
        })
    );
    // The whole cache goes; the next calls make what they need again.
    std::fs::remove_dir_all(sc.root.join(".git-cache")).unwrap();
    let status = post_as(&served, "/apply/status", status_body, &import).await;
    assert_eq!(status.status, 200, "{}", status.json());
    assert_eq!(status.json()["rev"], imported.as_str());

    // Another request under the same key.
    let status = post_as(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": key, "requestFingerprint": "sha256:bbbb" }),
        &import,
    )
    .await;
    assert_eq!(
        (status.status, status.code().as_str()),
        (409, "idempotency_conflict")
    );
    let mut other = request.clone();
    other["requestFingerprint"] = json!("sha256:bbbb");
    let answer = apply_as(&served, other, &archive, Some(&import), None).await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "idempotency_conflict")
    );

    // Commits carrying a key the gateway did not commit never count: one
    // by a runtime under the address runtimes commit under by default (a
    // copy of a key already on main, too), and one claiming the gateway's
    // address with a key nobody but the controller knows.
    let planted = "imp:planted";
    let message =
        format!("Planted\n\nInstafy-Apply-Key: {planted}\nInstafy-Apply-Fingerprint: sha256:aaaa");
    sc.push_as("instafy-origin", "origin@instafy.dev", &message);
    sc.push_as(
        "instafy-origin",
        "origin@instafy.dev",
        &format!("Copied\n\nInstafy-Apply-Key: {key}\nInstafy-Apply-Fingerprint: sha256:aaaa"),
    );
    let status = post_as(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": key, "requestFingerprint": "sha256:aaaa" }),
        &import,
    )
    .await;
    assert_eq!(status.json()["rev"], imported.as_str(), "{}", status.json());
    let forged_key = "imp:forged";
    sc.push_as(
        "instafy-origin",
        "gateway@instafy.dev",
        &format!(
            "Forged\n\nInstafy-Apply-Key: {forged_key}x\nInstafy-Apply-Fingerprint: sha256:aaaa"
        ),
    );
    for missing in [planted, forged_key, "imp:0123456789abcde"] {
        let status = post_as(
            &served,
            "/apply/status",
            json!({ "idempotencyKey": missing, "requestFingerprint": "sha256:aaaa" }),
            &import,
        )
        .await;
        assert_eq!(
            (status.status, status.code().as_str()),
            (404, "not_found"),
            "{missing}"
        );
    }
    // The planted key is a new import, not a replay.
    let answer = apply_as(
        &served,
        manifest(
            &["src/app.ts"],
            &[],
            json!({
                "leaseId": controller.lease.to_string(),
                "idempotencyKey": planted,
                "requestFingerprint": "sha256:aaaa",
            }),
        ),
        &zip(&[("src/app.ts", b"v2\n")]),
        Some(&import),
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["committed"], true);
    assert!(answer.json().get("replayed").is_none());

    // A person's token cannot ask for a receipt.
    let person = controller.token(&["fs.write"], json!({}));
    let status = post_as(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": key }),
        &person,
    )
    .await;
    assert_eq!(
        (status.status, status.code().as_str()),
        (400, "idempotency_requires_import")
    );
}

/// An import whose files `main` already holds still leaves its receipt (a
/// commit with no changes carrying its key), so a retry after a lost
/// answer replays it instead of writing over what was saved since.
#[tokio::test(flavor = "multi_thread")]
async fn an_import_that_changes_nothing_still_leaves_its_receipt() {
    let mut sc = HostedScenario::new();
    let head = sc.push(&[("src/app.ts", Some(b"v1\n"))], "seed");
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve(&sc).await;
    let import = controller.token(&["fs.write", "workspace.import"], json!({}));
    let key = "imp:feedfacefeedface";
    let request = manifest(
        &["src/app.ts"],
        &[],
        json!({
            "leaseId": controller.lease.to_string(),
            "idempotencyKey": key,
            "requestFingerprint": "sha256:cccc",
            "commitMessage": "Import from GitHub",
        }),
    );
    let archive = zip(&[("src/app.ts", b"v1\n")]);
    let answer = apply_as(&served, request.clone(), &archive, Some(&import), None).await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let receipt = rev(&answer);
    assert_eq!(answer.json()["committed"], true);
    assert_eq!(answer.json()["baseRev"], head.as_str());
    assert_eq!(parent(&sc, &receipt), head);
    assert_eq!(
        canonical(&sc, &["rev-parse", &format!("{receipt}^{{tree}}")]),
        canonical(&sc, &["rev-parse", &format!("{head}^{{tree}}")])
    );
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%B", &receipt]),
        format!("Import from GitHub\n\nInstafy-Apply-Key: {key}\nInstafy-Apply-Fingerprint: sha256:cccc")
    );

    let status = post_as(
        &served,
        "/apply/status",
        json!({ "idempotencyKey": key, "requestFingerprint": "sha256:cccc" }),
        &import,
    )
    .await;
    assert_eq!(status.status, 200, "{}", status.json());
    assert_eq!(status.json()["rev"], receipt.as_str());
    assert_eq!(
        (
            status.json()["fileCount"].clone(),
            status.json()["bytesWritten"].clone()
        ),
        (json!(0), json!(0))
    );

    // A runtime saves; the retried import replays and leaves that alone.
    let later = sc.push(&[("src/app.ts", Some(b"v2 by a runtime\n"))], "runtime");
    let again = apply_as(&served, request, &archive, Some(&import), None).await;
    assert_eq!(again.status, 200, "{}", again.json());
    assert_eq!(again.json()["rev"], receipt.as_str());
    assert_eq!(again.json()["replayed"], true);
    assert_eq!(sc.canonical_main().as_deref(), Some(later.as_str()));
    assert_eq!(
        show(&sc, &later, "src/app.ts").unwrap(),
        b"v2 by a runtime\n"
    );

    // An import into a space without main that saves nothing leaves a
    // receipt too (a first commit with an empty tree).
    let mut empty = HostedScenario::new();
    let controller = StubController::start(empty.project).await;
    controller.configure(&mut empty);
    let served = serve(&empty).await;
    let import = controller.token(&["fs.write", "workspace.import"], json!({}));
    let answer = apply_as(
        &served,
        manifest(
            &[".env"],
            &[],
            json!({
                "leaseId": controller.lease.to_string(),
                "idempotencyKey": key,
                "requestFingerprint": "sha256:cccc",
            }),
        ),
        &zip(&[(".env", b"KEY=1\n")]),
        Some(&import),
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["skippedPaths"][0]["path"], ".env");
    let receipt = rev(&answer);
    assert_eq!(empty.canonical_main().as_deref(), Some(receipt.as_str()));
    assert_eq!(
        git_in(&empty.remote(), &["ls-tree", "-r", "--name-only", &receipt]),
        ""
    );
}

/// r3 test 14 (Q6 form): a person's save is authored by the name and
/// pseudonymous address on their token, committed by the gateway, and
/// never names the token's subject; History reads it as a person's.
#[tokio::test(flavor = "multi_thread")]
async fn a_persons_save_carries_their_pseudonym_and_never_their_id() {
    let mut sc = HostedScenario::new();
    let head = sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve(&sc).await;
    let pseudonym = "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev";
    let token = controller.token(
        &["fs.read", "fs.write"],
        json!({ "author_name": "Ada Lovelace", "author_email": pseudonym }),
    );
    let answer = apply_as(
        &served,
        manifest(
            &["a.txt"],
            &[],
            json!({ "baseRev": head, "leaseId": controller.lease.to_string() }),
        ),
        &zip(&[("a.txt", b"b\n")]),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    let saved = rev(&answer);
    let raw = canonical(&sc, &["cat-file", "commit", &saved]);
    assert!(
        raw.contains(&format!("author Ada Lovelace <{pseudonym}>")),
        "{raw}"
    );
    assert!(
        raw.contains("committer instafy-origin <gateway@instafy.dev>"),
        "{raw}"
    );
    assert!(!raw.contains(&controller.user.to_string()), "{raw}");

    let history = reqwest::Client::new()
        .get(format!("{}/git/history?limit=1", served.base))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(history["entries"][0]["actor"], "user");

    // A token without author claims saves as the gateway.
    let plain = controller.token(&["fs.write"], json!({}));
    let answer = apply_as(
        &served,
        manifest(
            &["a.txt"],
            &[],
            json!({ "baseRev": saved, "leaseId": controller.lease.to_string() }),
        ),
        &zip(&[("a.txt", b"c\n")]),
        Some(&plain),
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%an <%ae>", &rev(&answer)]),
        "instafy-origin <gateway@instafy.dev>"
    );
}

#[test]
fn save_authors_come_from_clean_claims_only() {
    let claims = |name: Option<&str>, email: Option<&str>| -> OriginClaims {
        serde_json::from_value(json!({
            "aud": "a",
            "sub": "user-id-that-never-appears",
            "project_id": Uuid::new_v4().to_string(),
            "scopes": ["fs.write"],
            "iat": 0,
            "exp": 1,
            "author_name": name,
            "author_email": email,
        }))
        .unwrap()
    };
    let gateway = gateway();
    let pseudonym = "p1-aaaaaaaaaaaaaaaaaaaa@users.noreply.instafy.dev";
    let author = save_author(&claims(Some("Ada"), Some(pseudonym)), &gateway);
    assert_eq!(
        (author.name.as_str(), author.email.as_str()),
        ("Ada", pseudonym)
    );
    let author = save_author(&claims(None, Some(pseudonym)), &gateway);
    assert_eq!(author.name, "Instafy user");
    let author = save_author(&claims(Some(" <Ev\nil> "), Some(pseudonym)), &gateway);
    assert_eq!(author.name, "Ev il");
    let author = save_author(&claims(Some("..."), Some(pseudonym)), &gateway);
    assert_eq!(author.name, "Instafy user");
    for bad in [
        "",
        "  ",
        "no-at-sign",
        "a@b@c",
        "a b@c",
        "<a@b>",
        "a@b\nc",
        "@b",
        "a@",
    ] {
        let author = save_author(&claims(Some("Ada"), Some(bad)), &gateway);
        assert_eq!(author, gateway, "{bad:?}");
    }
    assert_eq!(save_author(&claims(Some("Ada"), None), &gateway), gateway);
}

/// r3 test 10: reverting a publish merge against its first parent keeps a
/// save made after it; a conflicting revert and a merge without a base are
/// refused.
#[tokio::test(flavor = "multi_thread")]
async fn reverts_merge_the_inverse_onto_main() {
    let sc = HostedScenario::new();
    let base = sc.push(
        &[
            ("shared.md", Some(b"one\ntwo\nthree\n")),
            ("keep.md", Some(b"k\n")),
        ],
        "seed",
    );
    // A runtime's publish: a merge of its local work on top of main.
    let local = sc.side_commit(&[("agent.md", b"agent work\n")], "agent turn");
    git_in(&sc.work, &["checkout", "-q", "--detach", &base]);
    git_in(
        &sc.work,
        &[
            "-c",
            "user.name=Runtime",
            "-c",
            "user.email=agent@instafy.dev",
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "instafy: publish 1 commit",
            &local,
        ],
    );
    let merge = git_in(&sc.work, &["rev-parse", "HEAD"]);
    git_in(
        &sc.work,
        &[
            "push",
            "-q",
            sc.remote().to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    git_in(&sc.work, &["checkout", "-q", "-B", "main", &merge]);
    // A Studio save after it.
    let studio = sc.push(&[("keep.md", Some(b"k2\n"))], "studio save");
    let served = serve(&sc).await;

    let answer = post(&served, "/git/revert-commit", json!({ "commit": merge })).await;
    assert_eq!(answer.status, 400, "{}", answer.json());

    let answer = post(
        &served,
        "/git/revert-commit",
        json!({ "commit": merge, "base": base }),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["committed"], true);
    assert_eq!(answer.json()["baseRev"], studio.as_str());
    let reverted = rev(&answer);
    assert_eq!(show(&sc, &reverted, "agent.md"), None);
    assert_eq!(show(&sc, &reverted, "keep.md").unwrap(), b"k2\n");
    assert_eq!(
        canonical(&sc, &["log", "-1", "--format=%B", &reverted]),
        format!("Revert \"instafy: publish 1 commit\"\n\nThis reverts commit {merge}.")
    );

    // Reverting again changes nothing.
    let answer = post(
        &served,
        "/git/revert-commit",
        json!({ "commit": merge, "base": base }),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.json());
    assert_eq!(answer.json()["committed"], false);

    // A line changed again later cannot be reverted automatically.
    let first_edit = sc.push(&[("shared.md", Some(b"one\nTWO\nthree\n"))], "edit two");
    sc.push(
        &[("shared.md", Some(b"one\nTwo!\nthree\n"))],
        "edit two again",
    );
    let answer = post(
        &served,
        "/git/revert-commit",
        json!({ "commit": first_edit }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "revert_conflict"),
        "{}",
        answer.json()
    );
    assert_eq!(answer.json()["paths"], json!(["shared.md"]));

    // A base that is not an ancestor, and commits nobody has.
    let answer = post(
        &served,
        "/git/revert-commit",
        json!({ "commit": base, "base": studio }),
    )
    .await;
    assert_eq!(answer.status, 400, "{}", answer.json());
    let answer = post(
        &served,
        "/git/revert-commit",
        json!({ "commit": "0".repeat(40) }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (404, "rev_not_found")
    );
    let answer = post(&served, "/git/revert-commit", json!({ "commit": "abc" })).await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "invalid_rev")
    );
}

/// A write that could not move the mirror's `main` (a fetch held its refs)
/// makes the next read fetch instead of reusing an earlier fetch.
#[tokio::test(flavor = "multi_thread")]
async fn a_push_recorded_while_a_fetch_runs_makes_reads_fetch() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("a.txt", Some(b"1\n"))], "first");
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Coalesced, None)
            .await
            .unwrap()
            .as_deref(),
        Some(first.as_str())
    );
    let second = sc.push(&[("a.txt", Some(b"2\n"))], "second");
    {
        let _refs = MirrorCache::hold_refs(&lease);
        cache.record_push(&lease.mirror(), &second, Some(&first), true);
    }
    let started = cache.fetches_started();
    let main = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(second.as_str()));
    assert_eq!(cache.fetches_started(), started + 1);
    // Once fetched, reads coalesce again.
    cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(cache.fetches_started(), started + 1);
}

// ---------------------------------------------------------------------------
// The commit-and-push loop on the test thread.
// ---------------------------------------------------------------------------

/// r3 test 4: a lost race fetches and saves on the new main; a race lost
/// every time ends with `main_busy` after the last attempt.
#[test]
fn a_lost_race_is_retried_and_endless_races_are_main_busy() {
    let sc = HostedScenario::new();
    sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let direct = Direct::new(&sc);
    let _hook = HookGuard;
    let (work, remote) = sc.runtime();
    let pushes = Arc::new(Mutex::new(0usize));
    let seen = pushes.clone();
    let hook_work = work.clone();
    let hook_remote = remote.clone();
    set_push_hook(move |_| {
        let mut count = seen.lock().unwrap();
        *count += 1;
        if *count == 1 {
            runtime_push(
                &hook_work,
                &hook_remote,
                &[("other.txt", Some(b"o\n"))],
                "first",
            );
        }
        PushHookAction::Proceed
    });
    let mut change = direct.edits(&[("mine.txt", b"m\n")], &[], None);
    let outcome = direct.commit(&mut change, "Update mine.txt").unwrap();
    assert!(outcome.committed);
    assert_eq!(*pushes.lock().unwrap(), 2);
    let saved = outcome.rev.unwrap();
    assert_eq!(sc.canonical_main().as_deref(), Some(saved.as_str()));
    assert_eq!(show(&sc, &saved, "other.txt").unwrap(), b"o\n");
    assert_eq!(show(&sc, &saved, "mine.txt").unwrap(), b"m\n");

    let always = Arc::new(Mutex::new(0usize));
    let seen = always.clone();
    set_push_hook(move |_| {
        let mut count = seen.lock().unwrap();
        *count += 1;
        let name = format!("race-{count}.txt");
        runtime_push(&work, &remote, &[(&name, Some(b"r\n"))], "race");
        PushHookAction::Proceed
    });
    let mut change = direct.edits(&[("lost.txt", b"l\n")], &[], None);
    let error = direct.commit(&mut change, "Update lost.txt").unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
    assert_eq!(*always.lock().unwrap(), MAX_ATTEMPTS);
    let main = sc.canonical_main().unwrap();
    assert_eq!(show(&sc, &main, "lost.txt"), None);
}

/// Refuses every push whose `git.write` credential (as the stub controller
/// mints them, `...-until-<unix seconds>`) has run out, as git-edge does:
/// git then asks for a password it may not prompt for.
const EXPIRED_CREDENTIALS_REFUSED: &str = r#"for arg in "$@"; do
  if [ "$arg" = push ]; then
    until="${GIT_CONFIG_VALUE_0##*until-}"
    case "$until" in ''|*[!0-9]*) echo "fatal: unable to get password from user" >&2; exit 128;; esac
    if [ "$(date +%s)" -ge "$until" ]; then
      echo "fatal: unable to get password from user" >&2
      exit 128
    fi
  fi
done"#;

/// A change can outlive one `git.write` credential (a minute at most, and
/// imports have 14): each push gets one with time left, exchanged again
/// from the caller's bearer; a credential canonical refuses is exchanged
/// once more and then reported; once the caller's own bearer is about to
/// expire, no further attempt starts.
#[test]
fn every_push_carries_a_current_write_credential() {
    let mut sc = HostedScenario::new();
    sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let controller_runtime = tokio::runtime::Runtime::new().unwrap();
    let controller =
        controller_runtime.block_on(StubController::start_with_git_token_life(sc.project, 6));
    controller.configure(&mut sc);
    let direct = Direct::new(&sc);
    let caller = controller.token(&["fs.write"], json!({}));
    let later = Some(std::time::SystemTime::now() + Duration::from_secs(600));
    let wrapper_dir = tempfile::tempdir().unwrap();
    let _git = GitWrapper::install(wrapper_dir.path(), EXPIRED_CREDENTIALS_REFUSED);
    let _hook = HookGuard;
    let minted = || {
        controller
            .write_tokens
            .load(std::sync::atomic::Ordering::SeqCst)
    };

    // The first push loses a race after a slow attempt; the second comes
    // after the first credential ran out.
    let (work, remote) = sc.runtime();
    let pushes = Arc::new(Mutex::new(0usize));
    let seen = pushes.clone();
    let (hook_work, hook_remote) = (work.clone(), remote.clone());
    set_push_hook(move |_| {
        let mut count = seen.lock().unwrap();
        *count += 1;
        if *count == 1 {
            std::thread::sleep(Duration::from_secs(4));
            runtime_push(
                &hook_work,
                &hook_remote,
                &[("other.txt", Some(b"o\n"))],
                "first",
            );
        } else {
            std::thread::sleep(Duration::from_secs(3));
        }
        PushHookAction::Proceed
    });
    let mut change = direct.edits(&[("mine.txt", b"m\n")], &[], None);
    let outcome = direct
        .commit_as(&mut change, "Update mine.txt", Some(caller.clone()), later)
        .unwrap();
    assert!(outcome.committed);
    assert_eq!(*pushes.lock().unwrap(), 2);
    assert_eq!(minted(), 2, "one credential per push");
    let saved = outcome.rev.unwrap();
    assert_eq!(sc.canonical_main().as_deref(), Some(saved.as_str()));
    assert_eq!(show(&sc, &saved, "mine.txt").unwrap(), b"m\n");

    // Canonical refuses every credential: exchanged once more, then the
    // refusal is the answer (not five attempts settled by fetching).
    clear_push_hook();
    let refusing = GitWrapper::install(
        wrapper_dir.path(),
        r#"for arg in "$@"; do
  if [ "$arg" = push ]; then
    echo "fatal: unable to get password from user" >&2
    exit 128
  fi
done"#,
    );
    let before = minted();
    let mut change = direct.edits(&[("refused.txt", b"r\n")], &[], None);
    let error = direct
        .commit_as(
            &mut change,
            "Update refused.txt",
            Some(caller.clone()),
            later,
        )
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);
    assert_eq!(minted() - before, 2);
    drop(refusing);

    // The caller's bearer ends within the margin: after a lost race no
    // credential is exchanged for another attempt.
    let _git = GitWrapper::install(wrapper_dir.path(), EXPIRED_CREDENTIALS_REFUSED);
    let pushes = Arc::new(Mutex::new(0usize));
    let seen = pushes.clone();
    set_push_hook(move |_| {
        let mut count = seen.lock().unwrap();
        *count += 1;
        runtime_push(
            &work,
            &remote,
            &[(&format!("race-{count}.txt"), Some(b"r\n"))],
            "race",
        );
        PushHookAction::Proceed
    });
    let ending = Some(std::time::SystemTime::now() + Duration::from_secs(5));
    let mut change = direct.edits(&[("late.txt", b"l\n")], &[], None);
    let error = direct
        .commit_as(&mut change, "Update late.txt", Some(caller), ending)
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
    assert_eq!(*pushes.lock().unwrap(), 1);
}

/// Admission covers the work on this server only: a slot is let go before
/// the push (which may wait on a slow shard), a write that finds every slot
/// taken is told to retry after a bounded wait (503 `writes_busy` with
/// `Retry-After`), and imports have slots of their own.
#[tokio::test(flavor = "multi_thread")]
async fn write_slots_are_bounded_and_end_before_the_push() {
    use std::os::unix::fs::PermissionsExt as _;
    let mut sc = HostedScenario::new();
    let head = sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve_with(&sc, |state| {
        state.with_admission_wait(Duration::from_millis(500))
    })
    .await;
    let person = controller.token(&["fs.read", "fs.write"], json!({}));
    let import = controller.token(&["fs.write", "workspace.import"], json!({}));
    let lease = controller.lease.to_string();

    // A slow shard: the push of a save waits in canonical's hook.
    let marker = sc.root.join("in-hook");
    let hook = sc.remote().join("hooks/pre-receive");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ncat >/dev/null\ntouch '{}'\nsleep 3\nexit 0\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let save = {
        let base = served.base.clone();
        let person = person.clone();
        let request = json!({
            "manifest": manifest(&["slow.txt"], &[], json!({ "baseRev": head, "leaseId": lease })),
            "archiveBase64": base64::engine::general_purpose::STANDARD.encode(zip(&[("slow.txt", b"s\n")])),
        });
        tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("{base}/apply-json"))
                .bearer_auth(person)
                .json(&request)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        })
    };
    let waited = Instant::now();
    while !marker.exists() {
        assert!(
            waited.elapsed() < Duration::from_secs(30),
            "the push never reached the hook"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(served.state.apply_slots.available_permits(), 4);
    assert_eq!(save.await.unwrap(), 200);
    std::fs::remove_file(&hook).unwrap();

    // Every save slot taken: a bounded wait, then 503 with Retry-After.
    let taken = served
        .state
        .apply_slots
        .clone()
        .acquire_many_owned(4)
        .await
        .unwrap();
    let main = sc.canonical_main().unwrap();
    let started = Instant::now();
    let busy = apply_as(
        &served,
        manifest(
            &["b.txt"],
            &[],
            json!({ "baseRev": main, "leaseId": lease }),
        ),
        &zip(&[("b.txt", b"b\n")]),
        Some(&person),
        None,
    )
    .await;
    assert_eq!(
        (busy.status, busy.code().as_str()),
        (503, "writes_busy"),
        "{}",
        busy.json()
    );
    assert_eq!(busy.header("retry-after").as_deref(), Some("2"));
    assert!(started.elapsed() < Duration::from_secs(5));
    let revert = post_as(
        &served,
        "/git/revert-commit",
        json!({ "commit": main }),
        &person,
    )
    .await;
    assert_eq!(
        (revert.status, revert.code().as_str()),
        (503, "writes_busy")
    );
    // An import has its own slots.
    let imported = apply_as(
        &served,
        manifest(
            &["src/app.ts"],
            &[],
            json!({
                "leaseId": lease,
                "idempotencyKey": "imp:0123456789abcdef",
                "requestFingerprint": "sha256:aaaa",
            }),
        ),
        &zip(&[("src/app.ts", b"export {}\n")]),
        Some(&import),
        None,
    )
    .await;
    assert_eq!(imported.status, 200, "{}", imported.json());
    drop(taken);
    let main = sc.canonical_main().unwrap();
    let saved = apply_as(
        &served,
        manifest(
            &["b.txt"],
            &[],
            json!({ "baseRev": main, "leaseId": lease }),
        ),
        &zip(&[("b.txt", b"b\n")]),
        Some(&person),
        None,
    )
    .await;
    assert_eq!(saved.status, 200, "{}", saved.json());
    assert_eq!(served.state.apply_slots.available_permits(), 4);
    assert_eq!(served.state.import_slots.available_permits(), 2);
}

/// r3 test 5: a push whose answer was lost is settled by fetching: it
/// landed (one commit, no duplicate), or it did not and is tried again.
#[test]
fn a_push_without_an_answer_is_settled_by_fetching() {
    let sc = HostedScenario::new();
    let head = sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let direct = Direct::new(&sc);
    {
        let _hook = HookGuard;
        let mut first = true;
        set_push_hook(move |_| {
            if std::mem::take(&mut first) {
                PushHookAction::LoseResponse
            } else {
                PushHookAction::Proceed
            }
        });
        let mut change = direct.edits(&[("landed.txt", b"l\n")], &[], None);
        let outcome = direct.commit(&mut change, "Update landed.txt").unwrap();
        let saved = outcome.rev.unwrap();
        assert!(outcome.committed);
        assert_eq!(sc.canonical_main().as_deref(), Some(saved.as_str()));
        assert_eq!(parent(&sc, &saved), head, "exactly one new commit");
    }

    // The connection drops before anything reached canonical.
    let marker = direct.staging.path().join("dropped-once");
    let _wrapper = GitWrapper::install(
        direct.staging.path(),
        &format!(
            "for a in \"$@\"; do if [ \"$a\" = push ] && [ ! -e '{}' ]; then : > '{}'; echo 'fatal: the remote end hung up unexpectedly' >&2; exit 128; fi; done",
            marker.display(),
            marker.display()
        ),
    );
    let before = sc.canonical_main().unwrap();
    let mut change = direct.edits(&[("retried.txt", b"r\n")], &[], None);
    let outcome = direct.commit(&mut change, "Update retried.txt").unwrap();
    assert!(marker.exists());
    let saved = outcome.rev.unwrap();
    assert_eq!(parent(&sc, &saved), before);
    assert_eq!(show(&sc, &saved, "retried.txt").unwrap(), b"r\n");
}

/// r3 test 12: two first saves into a space without main leave one root.
#[test]
fn the_first_save_race_leaves_one_root() {
    let sc = HostedScenario::new();
    let direct = Direct::new(&sc);
    let _hook = HookGuard;
    let (work, remote) = sc.runtime();
    let mut first = true;
    set_push_hook(move |_| {
        if std::mem::take(&mut first) {
            runtime_push(
                &work,
                &remote,
                &[("theirs.txt", Some(b"t\n"))],
                "their root",
            );
        }
        PushHookAction::Proceed
    });
    let mut change = direct.edits(&[("mine.txt", b"m\n")], &[], None);
    let outcome = direct.commit(&mut change, "Update mine.txt").unwrap();
    let saved = outcome.rev.unwrap();
    let roots = canonical(&sc, &["rev-list", "--max-parents=0", "main"]);
    assert_eq!(roots.lines().count(), 1, "{roots}");
    assert_eq!(outcome.base_rev.as_deref(), Some(roots.as_str()));
    assert_eq!(show(&sc, &saved, "theirs.txt").unwrap(), b"t\n");
    assert_eq!(show(&sc, &saved, "mine.txt").unwrap(), b"m\n");
}

/// An import key is written as trailers only for imports, and a staged
/// upload committed directly keeps nothing in the quarantine folder.
#[test]
fn import_trailers_are_added_by_the_gateway_only() {
    let sc = HostedScenario::new();
    sc.push(&[("a.txt", Some(b"a\n"))], "seed");
    let direct = Direct::new(&sc);
    let lease = direct.cache.lease(sc.project);
    let dir = direct.cache.ensure_mirror(&lease.mirror()).unwrap();
    let quarantine = direct.cache.quarantine_dir().unwrap();
    let committer = gateway();
    let mut canonical_main = CachedCanonical::new(
        direct.cache.clone(),
        lease,
        None,
        direct.runtime.handle().clone(),
    );
    let target = CasTarget {
        mirror: &dir,
        quarantine_parent: &quarantine,
        remote: &direct.remote,
        committer: &committer,
        deadline: Instant::now() + Duration::from_secs(30),
        admission: None,
    };
    let key = ApplyKey {
        key: "imp:k".into(),
        fingerprint: None,
    };
    let mut change = direct.edits(&[("b.txt", b"b\n")], &[], None);
    let outcome = cas_commit(
        &target,
        &mut change,
        &gateway(),
        "Import",
        Some(&key),
        &mut canonical_main,
    )
    .unwrap();
    assert_eq!(
        canonical(
            &sc,
            &["log", "-1", "--format=%B", outcome.rev.as_deref().unwrap()]
        ),
        "Import\n\nInstafy-Apply-Key: imp:k"
    );
    assert_eq!(std::fs::read_dir(&quarantine).unwrap().count(), 0);
}
