//! The same unsaved work restored by Desktop (a checkout behind
//! [`crate::routes`]) and by the hosted gateway (a mirror cache behind
//! [`crate::hosted`]), each over its own copy of one canonical history:
//! both answer alike and leave `main` and the ref alike, because both decide
//! by [`crate::restore_plan`]. Each test runs once per mode.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use uuid::Uuid;

use crate::config::ServerConfig;
use crate::test_support::{git_in, git_output};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Desktop,
    Gateway,
}

const MODES: [Mode; 2] = [Mode::Desktop, Mode::Gateway];

/// The origin the recovery refs of these tests were kept by.
const ORIGIN: &str = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";

fn recovery_ref(name: &str) -> String {
    format!("refs/instafy/recovery/{ORIGIN}/{name}")
}

/// One more byte than a save may hold.
fn too_large() -> Vec<u8> {
    vec![b'x'; crate::publish_policy::MAX_PUBLISH_BLOB_BYTES as usize + 1]
}

/// One mode serving a space.
struct Server {
    mode: Mode,
    config: ServerConfig,
    base: String,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl Server {
    /// `mode` serving the canonical repository `remote` (in the folder
    /// `canonical`), with its checkout or cache in `workspace`.
    async fn start(
        mode: Mode,
        project: Uuid,
        canonical: &Path,
        remote: &Path,
        workspace: PathBuf,
    ) -> Self {
        std::fs::create_dir_all(&workspace).unwrap();
        let gateway = mode == Mode::Gateway;
        let config = ServerConfig {
            project_id: project,
            origin_id: if gateway {
                Uuid::nil()
            } else {
                Uuid::parse_str(ORIGIN).unwrap()
            },
            workspace_root: workspace.clone(),
            git_remote_url: (!gateway).then(|| format!("file://{}", remote.display())),
            git_remote_base_url: gateway.then(|| format!("file://{}", canonical.display())),
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "instafy-origin".into(),
            git_author_email: if gateway {
                crate::config::DEFAULT_GATEWAY_AUTHOR_EMAIL.into()
            } else {
                crate::config::DEFAULT_ORIGIN_AUTHOR_EMAIL.into()
            },
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().unwrap(),
            controller_internal_token: None,
            controller_token_source: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().unwrap(),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 64 * 1024 * 1024,
            staging_base: None,
            multi_tenant: gateway,
            hosted_checkout: false,
        };
        let shared = Arc::new(config.clone());
        let http = reqwest::Client::new();
        let validator = crate::auth::TokenValidator::new(http.clone(), shared.jwks_url.clone());
        let app = match mode {
            Mode::Desktop => {
                crate::git::ensure_git_checkout(&config, None).expect("checkout");
                let state = crate::routes::AppState::new(shared, validator, http, workspace, None)
                    .expect("app state");
                crate::routes::router(state)
            }
            Mode::Gateway => {
                let cache = Arc::new(
                    crate::hosted::MirrorCache::open(
                        &workspace,
                        shared.clone(),
                        http.clone(),
                        u64::MAX,
                    )
                    .unwrap(),
                );
                let auth = crate::route_auth::RouteAuth {
                    token_validator: validator,
                    config: shared,
                    http_client: http,
                };
                crate::hosted::router(crate::hosted::HostedState::new(auth, cache))
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            mode,
            config,
            base: format!("http://{address}"),
            handle,
        }
    }

    /// Desktop's checkout catches up with canonical `main`, as its own
    /// refresh does.
    fn catch_up(&self) {
        if self.mode != Mode::Desktop {
            return;
        }
        let report = crate::publish::publish(
            &crate::publish::PublishContext {
                config: &self.config,
                workspace_root: &self.config.workspace_root,
                token: None,
                can_write: true,
            },
            crate::publish::PublishRequest {
                selection: crate::publish::Selection::None,
                message: "instafy: agent sync".to_string(),
                author: None,
                budget: Duration::from_secs(30),
            },
        )
        .expect("catch up");
        assert!(report.rev.is_some(), "{report:?}");
    }
}

/// A space whose canonical repository is a bare repository on disk, served
/// by one mode, or by both over that one repository.
struct Space {
    /// The servers; the first answers [`Space::restore`].
    servers: Vec<Server>,
    /// Canonical.
    remote: PathBuf,
    /// A clone that pushes to canonical, as a runtime or another client
    /// would.
    work: PathBuf,
    _dir: tempfile::TempDir,
}

impl Space {
    /// A space whose `main` holds `seed`, served by `mode`.
    async fn new(mode: Mode, seed: &[(&str, &[u8])]) -> Self {
        Self::served_by(&[mode], seed).await
    }

    /// A space whose `main` holds `seed`, served by each of `modes`.
    async fn served_by(modes: &[Mode], seed: &[(&str, &[u8])]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let project = Uuid::new_v4();
        let canonical = root.join("canonical");
        std::fs::create_dir_all(&canonical).unwrap();
        let remote = canonical.join(format!("{project}.git"));
        git_in(
            &root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        let work = root.join("work");
        git_in(&root, &["init", "-q", "-b", "main", work.to_str().unwrap()]);
        git_in(&work, &["config", "user.name", "Runtime"]);
        git_in(&work, &["config", "user.email", "agent@instafy.dev"]);
        let mut files: Vec<(&str, Option<&[u8]>)> = seed
            .iter()
            .map(|(path, bytes)| (*path, Some(*bytes)))
            .collect();
        files.push(("README.md", Some(b"seed\n")));
        commit_files(&work, &files, "seed");
        git_in(
            &work,
            &[
                "push",
                "-q",
                remote.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        let mut servers = Vec::new();
        for mode in modes {
            let workspace = root.join(match mode {
                Mode::Desktop => "ws",
                Mode::Gateway => "gateway",
            });
            servers.push(Server::start(*mode, project, &canonical, &remote, workspace).await);
        }
        Self {
            servers,
            remote,
            work,
            _dir: dir,
        }
    }

    fn server(&self, mode: Mode) -> &Server {
        self.servers
            .iter()
            .find(|server| server.mode == mode)
            .unwrap_or_else(|| panic!("{mode:?} serves this space"))
    }

    /// Commit `files` (`None` deletes) on top of canonical `main` and push
    /// it there. Desktop's checkout catches up, as it does before a person
    /// restores anything.
    fn push(&self, files: &[(&str, Option<&[u8]>)], message: &str) -> String {
        self.push_with_links(files, &[], message)
    }

    /// [`Space::push`], with `links` (path, target) added as symbolic links.
    fn push_with_links(
        &self,
        files: &[(&str, Option<&[u8]>)],
        links: &[(&str, &str)],
        message: &str,
    ) -> String {
        self.sync_work();
        for (path, target) in links {
            std::os::unix::fs::symlink(target, self.work.join(path)).unwrap();
            git_in(&self.work, &["add", "--", path]);
        }
        commit_files(&self.work, files, message);
        git_in(
            &self.work,
            &[
                "push",
                "-q",
                self.remote.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        for server in &self.servers {
            server.catch_up();
        }
        self.main()
    }

    /// Put `path` on canonical `main` as `mode` naming `oid` (a submodule
    /// names a commit that need not exist), as [`Space::push`] does.
    fn push_entry(&self, path: &str, mode: &str, oid: &str, message: &str) -> String {
        self.sync_work();
        let info = format!("{mode},{oid},{path}");
        git_in(&self.work, &["update-index", "--add", "--cacheinfo", &info]);
        git_in(&self.work, &["commit", "-q", "-m", message]);
        git_in(
            &self.work,
            &[
                "push",
                "-q",
                self.remote.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        for server in &self.servers {
            server.catch_up();
        }
        self.main()
    }

    /// The mode of the entry at `path` on canonical `main`, if any.
    fn mode_on_main(&self, path: &str) -> Option<String> {
        let listed = git_in(
            &self.remote,
            &["ls-tree", "--full-tree", "refs/heads/main", "--", path],
        );
        listed.split_whitespace().next().map(str::to_string)
    }

    /// Unsaved work: `files` (`None` deletes) committed on top of canonical
    /// `main` and pushed to `reference` only.
    fn park(&self, files: &[(&str, Option<&[u8]>)], reference: &str) -> String {
        self.sync_work();
        commit_files(&self.work, files, "Unsaved edits");
        let spec = format!("HEAD:{reference}");
        git_in(
            &self.work,
            &["push", "-q", self.remote.to_str().unwrap(), &spec],
        );
        let commit = git_in(&self.work, &["rev-parse", "HEAD"]);
        git_in(&self.work, &["reset", "-q", "--hard", "HEAD~1"]);
        commit
    }

    /// [`Space::park`] for work no checkout on a disk that ignores case
    /// could hold (a folder `Docs` beside a file `docs`): the commit is
    /// built in canonical itself, on `main`, with an index of its own.
    fn park_built(&self, files: &[(&str, Option<&[u8]>)], reference: &str) -> String {
        let index = self
            .remote
            .join(format!("index-{}", Uuid::new_v4().simple()));
        let git = |args: &[&str], input: Option<&[u8]>| -> String {
            use std::io::Write as _;
            let mut command = std::process::Command::new("git");
            command
                .current_dir(&self.remote)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_INDEX_FILE", &index)
                .env("GIT_AUTHOR_NAME", "Runtime")
                .env("GIT_AUTHOR_EMAIL", "agent@instafy.dev")
                .env("GIT_COMMITTER_NAME", "Runtime")
                .env("GIT_COMMITTER_EMAIL", "agent@instafy.dev")
                .args(["-c", "core.ignorecase=false"])
                .args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.unwrap_or_default())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&["read-tree", "refs/heads/main"], None);
        for (path, content) in files {
            match content {
                Some(bytes) => {
                    let blob = git(&["hash-object", "-w", "--stdin"], Some(bytes));
                    let info = format!("100644,{blob},{path}");
                    git(&["update-index", "--add", "--cacheinfo", &info], None);
                }
                None => {
                    git(&["update-index", "--force-remove", "--", path], None);
                }
            }
        }
        let tree = git(&["write-tree"], None);
        let commit = git(
            &[
                "commit-tree",
                &tree,
                "-p",
                "refs/heads/main",
                "-m",
                "Unsaved edits",
            ],
            None,
        );
        git(&["update-ref", reference, &commit], None);
        std::fs::remove_file(&index).unwrap();
        commit
    }

    /// The paths on canonical `main`.
    fn paths_on_main(&self) -> Vec<String> {
        git_in(
            &self.remote,
            &[
                "ls-tree",
                "-r",
                "--name-only",
                "--full-tree",
                "refs/heads/main",
            ],
        )
        .lines()
        .map(str::to_string)
        .collect()
    }

    fn sync_work(&self) {
        let remote = self.remote.to_str().unwrap();
        git_in(&self.work, &["fetch", "-q", remote, "main"]);
        git_in(&self.work, &["reset", "-q", "--hard", "FETCH_HEAD"]);
        git_in(&self.work, &["clean", "-q", "-fdx"]);
    }

    fn main(&self) -> String {
        git_in(&self.remote, &["rev-parse", "refs/heads/main"])
    }

    /// The file at `path` on canonical `main`.
    fn on_main(&self, path: &str) -> Option<Vec<u8>> {
        let output = git_output(
            &self.remote,
            &["cat-file", "blob", &format!("refs/heads/main:{path}")],
            None,
        );
        output.status.success().then_some(output.stdout)
    }

    /// What canonical's `reference` names, if it exists.
    fn canonical_ref(&self, reference: &str) -> Option<String> {
        let output = git_output(
            &self.remote,
            &["rev-parse", "--verify", "--quiet", reference],
            None,
        );
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    async fn restore(&self, body: serde_json::Value) -> (u16, serde_json::Value) {
        self.restore_in(self.servers[0].mode, body).await
    }

    async fn restore_in(&self, mode: Mode, body: serde_json::Value) -> (u16, serde_json::Value) {
        let response = reqwest::Client::new()
            .post(format!("{}/git/recovery/restore", self.server(mode).base))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.json().await.unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    /// A restore the first server answers 200; its body.
    async fn restored(&self, body: serde_json::Value) -> serde_json::Value {
        self.restored_in(self.servers[0].mode, body).await
    }

    /// A restore `mode` answers 200; its body.
    async fn restored_in(&self, mode: Mode, body: serde_json::Value) -> serde_json::Value {
        let (status, answer) = self.restore_in(mode, body).await;
        assert_eq!(status, 200, "{mode:?}: {answer}");
        answer
    }

    /// A restore the first server answers 409 `restore_conflict`; the
    /// paths.
    async fn conflict(&self, body: serde_json::Value) -> serde_json::Value {
        let (status, answer) = self.restore(body).await;
        assert_eq!(
            (status, answer["code"].as_str()),
            (409, Some("restore_conflict")),
            "{:?}: {answer}",
            self.servers[0].mode
        );
        answer["paths"].clone()
    }

    /// The unsaved-work list as `mode` serves it.
    async fn listed_in(&self, mode: Mode) -> Vec<serde_json::Value> {
        let response = reqwest::get(format!("{}/git/recovery", self.server(mode).base))
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200, "{mode:?}");
        let body: serde_json::Value = response.json().await.unwrap();
        body["entries"].as_array().unwrap().clone()
    }
}

/// Commit `files` (`None` deletes) in the clone `work`, ignored ones too.
fn commit_files(work: &Path, files: &[(&str, Option<&[u8]>)], message: &str) {
    for (path, content) in files {
        let target = work.join(path);
        match content {
            Some(bytes) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                // A folder the removal of its entries left behind (`git rm`
                // keeps one that held a submodule) gives way to the file.
                if target.is_dir() {
                    std::fs::remove_dir_all(&target).unwrap();
                }
                std::fs::write(&target, bytes).unwrap();
                git_in(work, &["add", "-f", "--", path]);
            }
            None => {
                git_in(work, &["rm", "-q", "-r", "--", path]);
            }
        }
    }
    git_in(work, &["commit", "-q", "--allow-empty", "-m", message]);
}

fn reasons(pairs: &[(&str, &str)]) -> serde_json::Value {
    pairs
        .iter()
        .map(|(path, reason)| json!({ "path": path, "reason": reason }))
        .collect()
}

/// Work that adds a folder where `main` now has a file conflicts on both
/// paths. Keeping the saved version of either side, or of both, clears the
/// clash and restores the rest; keeping only part of the folder does not,
/// because the rest of it would still be dropped silently.
#[tokio::test(flavor = "multi_thread")]
async fn keep_clears_a_file_and_folder_conflict() {
    for mode in MODES {
        let space = Space::new(mode, &[]).await;
        let mut refs = Vec::new();
        for (index, files) in [
            vec!["docs/readme.md", "other-0.md"],
            vec!["docs/readme.md", "other-1.md"],
            vec!["docs/readme.md", "other-2.md"],
            vec!["docs/readme.md", "docs/extra.md", "other-3.md"],
        ]
        .into_iter()
        .enumerate()
        {
            let reference = recovery_ref(&format!("20261005T12000{index}Z-unsaved-0123456789ab"));
            let contents: Vec<(&str, Option<&[u8]>)> = files
                .iter()
                .map(|path| (*path, Some(b"work\n".as_slice())))
                .collect();
            let commit = space.park(&contents, &reference);
            refs.push((reference, commit));
        }
        space.push(&[("docs", Some(b"a file now\n"))], "docs is a file");

        assert_eq!(
            space.conflict(json!({ "ref": refs[0].0 })).await,
            json!(["docs", "docs/readme.md"]),
            "{mode:?}"
        );
        for (index, keep) in [
            json!(["docs", "docs/readme.md"]),
            json!(["docs"]),
            json!(["docs/readme.md"]),
        ]
        .into_iter()
        .enumerate()
        {
            let (reference, commit) = &refs[index];
            let body = space
                .restored(json!({ "ref": reference, "rev": commit, "keep": keep }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {keep}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[("docs/readme.md", "kept")]),
                "{mode:?} {keep}: {body}"
            );
            assert_eq!(body["refDeleted"], true, "{mode:?} {keep}: {body}");
            assert_eq!(space.canonical_ref(reference), None, "{mode:?} {keep}");
            assert_eq!(
                space.on_main(&format!("other-{index}.md")).as_deref(),
                Some(&b"work\n"[..]),
                "{mode:?} {keep}"
            );
            assert_eq!(space.on_main("docs").as_deref(), Some(&b"a file now\n"[..]));
        }

        // Keeping one file of the folder leaves the other in the clash.
        let (reference, commit) = &refs[3];
        assert_eq!(
            space
                .conflict(json!({ "ref": reference, "rev": commit, "keep": ["docs/readme.md"] }))
                .await,
            json!(["docs", "docs/extra.md"]),
            "{mode:?}"
        );
        assert!(space.on_main("other-3.md").is_none(), "{mode:?}");
    }
}

/// Keeping a folder settles its clash, but a file below it that can never
/// come back here (a secret, which the conflict never showed; a file the
/// restored tree ignores) is still refused, not kept on request: the ref
/// stays, so that work is not removed on the person's behalf. With only
/// kept paths left out, the ref goes.
#[tokio::test(flavor = "multi_thread")]
async fn a_kept_folder_never_lets_refused_work_below_it_go() {
    for mode in MODES {
        let space = Space::new(mode, &[]).await;
        let clash = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let clash_commit = space.park(
            &[
                ("docs/readme.md", Some(b"work\n")),
                ("docs/.env", Some(b"TOKEN=1\n")),
                ("other.md", Some(b"other\n")),
            ],
            &clash,
        );
        let kept = recovery_ref("20261005T121500Z-unsaved-0123456789ac");
        let kept_commit = space.park(
            &[
                ("cfg/app.txt", Some(b"app\n")),
                ("cfg/.env", Some(b"TOKEN=1\n")),
                ("cfg/debug.log", Some(b"log\n")),
                ("more.md", Some(b"more\n")),
            ],
            &kept,
        );
        let only_kept = recovery_ref("20261005T123000Z-unsaved-0123456789ad");
        let only_kept_commit = space.park(
            &[
                ("cfg/app.txt", Some(b"app\n")),
                ("most.md", Some(b"most\n")),
            ],
            &only_kept,
        );
        space.push(&[("docs", Some(b"a file now\n"))], "docs is a file");
        space.push(&[(".gitignore", Some(b"*.log\n"))], "ignore logs");

        assert_eq!(
            space
                .conflict(json!({ "ref": clash, "rev": clash_commit }))
                .await,
            json!(["docs", "docs/readme.md"]),
            "{mode:?}"
        );
        let body = space
            .restored(json!({
                "ref": clash,
                "rev": clash_commit,
                "keep": ["docs", "docs/readme.md"],
            }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[("docs/.env", "secret"), ("docs/readme.md", "kept")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert_eq!(
            space.canonical_ref(&clash).as_deref(),
            Some(clash_commit.as_str())
        );
        assert_eq!(space.on_main("other.md").as_deref(), Some(&b"other\n"[..]));
        assert_eq!(space.on_main("docs").as_deref(), Some(&b"a file now\n"[..]));

        let body = space
            .restored(json!({ "ref": kept, "rev": kept_commit, "keep": ["cfg"] }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[
                ("cfg/.env", "secret"),
                ("cfg/app.txt", "kept"),
                ("cfg/debug.log", "ignored"),
            ]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert_eq!(
            space.canonical_ref(&kept).as_deref(),
            Some(kept_commit.as_str())
        );
        assert_eq!(space.on_main("more.md").as_deref(), Some(&b"more\n"[..]));
        for path in ["cfg/app.txt", "cfg/.env", "cfg/debug.log"] {
            assert!(space.on_main(path).is_none(), "{mode:?}: {path}");
        }

        let body = space
            .restored(json!({ "ref": only_kept, "rev": only_kept_commit, "keep": ["cfg"] }))
            .await;
        assert_eq!(
            body["notRestored"],
            reasons(&[("cfg/app.txt", "kept")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(space.canonical_ref(&only_kept), None, "{mode:?}");
    }
}

/// Work below a folder `main` turned into a file, which the space ignores
/// (or which is a secret): the clash is settled, since nothing of the work
/// could come in there, so the rest is restored without asking, the file is
/// reported, and the ref, its only copy, stays. Keeping the folder changes
/// none of that.
#[tokio::test(flavor = "multi_thread")]
async fn work_refused_below_a_clash_never_asks_and_keeps_its_ref() {
    for mode in MODES {
        let space = Space::new(mode, &[(".gitignore", b"*.log\n")]).await;
        let ignored = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let ignored_commit = space.park(
            &[("logs/app.log", Some(b"log\n")), ("x.md", Some(b"x\n"))],
            &ignored,
        );
        let refused = recovery_ref("20261005T121500Z-unsaved-0123456789ac");
        let refused_commit = space.park(
            &[("logs/.env", Some(b"TOKEN=1\n")), ("y.md", Some(b"y\n"))],
            &refused,
        );
        space.push(&[("logs", Some(b"a file now\n"))], "logs is a file");

        for (reference, commit, path, reason, restored) in [
            (&ignored, &ignored_commit, "logs/app.log", "ignored", "x.md"),
            (&refused, &refused_commit, "logs/.env", "secret", "y.md"),
        ] {
            let body = space
                .restored(json!({ "ref": reference, "rev": commit }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[(path, reason)]),
                "{mode:?}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
            assert!(space.on_main(restored).is_some(), "{mode:?}: {restored}");

            let body = space
                .restored(json!({ "ref": reference, "rev": commit, "keep": ["logs"] }))
                .await;
            assert_eq!(body["committed"], false, "{mode:?}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[(path, reason)]),
                "{mode:?}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
            assert_eq!(
                space.canonical_ref(reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?}"
            );
            assert_eq!(space.on_main("logs").as_deref(), Some(&b"a file now\n"[..]));
        }
    }
}

/// Work too large to save, or ignored, that sits in a conflict is refused
/// like any other: it is never shown as a choice ("use this version" could
/// never save it), and the ref that holds the only copy stays even when
/// the person keeps the folder around it.
#[tokio::test(flavor = "multi_thread")]
async fn refused_work_in_a_conflict_keeps_its_ref() {
    let big = too_large();
    for mode in MODES {
        let space = Space::new(mode, &[("big.bin", b"small\n")]).await;
        let changed = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let changed_commit = space.park(
            &[("big.bin", Some(&big)), ("extra.md", Some(b"extra\n"))],
            &changed,
        );
        let folder = recovery_ref("20261005T121500Z-unsaved-0123456789ac");
        let folder_commit = space.park(
            &[
                ("cfg/app.txt", Some(b"app\n")),
                ("cfg/debug.log", Some(b"log\n")),
                ("cfg/big.bin", Some(&big)),
            ],
            &folder,
        );
        space.push(&[("big.bin", Some(b"other small\n"))], "a small change");
        space.push(
            &[
                ("cfg", Some(b"a file now\n")),
                (".gitignore", Some(b"*.log\n")),
            ],
            "cfg is a file",
        );

        let body = space
            .restored(json!({ "ref": changed, "rev": changed_commit }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[("big.bin", "too_large")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert_eq!(
            space.canonical_ref(&changed).as_deref(),
            Some(changed_commit.as_str())
        );
        assert_eq!(space.on_main("extra.md").as_deref(), Some(&b"extra\n"[..]));
        assert_eq!(
            space.on_main("big.bin").as_deref(),
            Some(&b"other small\n"[..])
        );

        assert_eq!(
            space
                .conflict(json!({ "ref": folder, "rev": folder_commit }))
                .await,
            json!(["cfg", "cfg/app.txt"]),
            "{mode:?}"
        );
        let main = space.main();
        let body = space
            .restored(json!({ "ref": folder, "rev": folder_commit, "keep": ["cfg"] }))
            .await;
        assert_eq!(body["committed"], false, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[
                ("cfg/app.txt", "kept"),
                ("cfg/big.bin", "too_large"),
                ("cfg/debug.log", "ignored"),
            ]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert_eq!(
            space.canonical_ref(&folder).as_deref(),
            Some(folder_commit.as_str())
        );
        assert_eq!(space.main(), main, "{mode:?}");
    }
}

/// "Ignored" comes from the restored tree's own `.gitignore` files, in both
/// modes: work that stops ignoring a pattern brings the files it matched
/// back with it, and work that adds a rule never brings in a file its own
/// rule ignores.
#[tokio::test(flavor = "multi_thread")]
async fn the_restored_trees_own_rules_decide_what_is_ignored() {
    for mode in MODES {
        let space = Space::new(mode, &[(".gitignore", b"*.log\n")]).await;
        let unignores = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let unignores_commit = space.park(
            &[
                (".gitignore", Some(b"# nothing ignored\n")),
                ("app.log", Some(b"log\n")),
                ("notes.md", Some(b"notes\n")),
            ],
            &unignores,
        );
        let ignores = recovery_ref("20261005T121500Z-unsaved-0123456789ac");
        let ignores_commit = space.park(
            &[
                ("gen/.gitignore", Some(b"*.out\n")),
                ("gen/a.out", Some(b"out\n")),
                ("gen/keep.md", Some(b"keep\n")),
            ],
            &ignores,
        );

        let body = space
            .restored(json!({ "ref": unignores, "rev": unignores_commit }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(body["notRestored"], json!([]), "{mode:?}: {body}");
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(space.on_main("app.log").as_deref(), Some(&b"log\n"[..]));
        assert_eq!(
            space.on_main(".gitignore").as_deref(),
            Some(&b"# nothing ignored\n"[..])
        );

        let body = space
            .restored(json!({ "ref": ignores, "rev": ignores_commit }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[("gen/a.out", "ignored")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert!(space.on_main("gen/a.out").is_none(), "{mode:?}");
        assert!(space.on_main("gen/.gitignore").is_some(), "{mode:?}");
        assert!(space.on_main("gen/keep.md").is_some(), "{mode:?}");
    }
}

/// Work and `main` both turned the same file (or link) into a folder, each
/// with its own version of a file inside it. The work's removal of the file
/// is already on `main`, but that settles nothing below it: the file inside
/// is a conflict the person chooses for, and the ref, the only copy of the
/// work's version, stays until they do. Keeping `main`'s version restores
/// the rest and lets the ref go.
#[tokio::test(flavor = "multi_thread")]
async fn both_sides_turning_a_file_into_a_folder_still_conflict_inside_it() {
    for mode in MODES {
        for (case, top, inside) in [
            ("file", "notes", "notes/todo.md"),
            ("link", "lib", "lib/a.rs"),
        ] {
            let space = Space::new(mode, &[]).await;
            if case == "link" {
                space.push_with_links(&[], &[(top, "src/lib")], "lib is a link");
            } else {
                space.push(&[(top, Some(b"a file\n"))], "notes is a file");
            }
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park(
                &[
                    (top, None),
                    (inside, Some(b"work version\n")),
                    ("other.md", Some(b"other\n")),
                ],
                &reference,
            );
            let before = space.push(
                &[(top, None), (inside, Some(b"main version\n"))],
                "a folder now",
            );

            assert_eq!(
                space
                    .conflict(json!({ "ref": reference, "rev": commit }))
                    .await,
                json!([inside]),
                "{mode:?} {case}"
            );
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} {case}"
            );
            assert_eq!(space.main(), before, "{mode:?} {case}");
            assert_eq!(
                space.on_main(inside).as_deref(),
                Some(&b"main version\n"[..]),
                "{mode:?} {case}"
            );

            let body = space
                .restored(json!({ "ref": reference, "rev": commit, "keep": [inside] }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {case}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[(inside, "kept")]),
                "{mode:?} {case}: {body}"
            );
            assert_eq!(body["refDeleted"], true, "{mode:?} {case}: {body}");
            assert_eq!(space.on_main("other.md").as_deref(), Some(&b"other\n"[..]));
            assert_eq!(
                space.on_main(inside).as_deref(),
                Some(&b"main version\n"[..]),
                "{mode:?} {case}"
            );
        }
    }
}

/// Whether the folder `dir` is on a disk that ignores case in names.
fn ignores_case(dir: &Path) -> bool {
    let probe = dir.join(format!("case-probe-{}", Uuid::new_v4().simple()));
    std::fs::write(&probe, b"").unwrap();
    let upper = dir.join(probe.file_name().unwrap().to_str().unwrap().to_uppercase());
    let found = std::fs::symlink_metadata(upper).is_ok();
    std::fs::remove_file(probe).unwrap();
    found
}

/// The names of the entries of the folder `dir`, as the disk keeps them.
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

/// Work that renames a file or a folder by case only (`notes.md` to
/// `Notes.md`, `docs/` to `Docs/`, a folder `Src/` that becomes a file
/// `src`) is restored in both modes. On a disk that ignores case, Desktop
/// finds the file `HEAD` tracks (and this restore removes) at the new name:
/// that is never an untracked file in the way. A file `HEAD` does not track
/// at a name that differs only in case still is.
#[tokio::test(flavor = "multi_thread")]
async fn a_rename_by_case_only_is_restored() {
    type Files<'a> = Vec<(&'a str, Option<&'a [u8]>)>;
    for mode in MODES {
        let cases: Vec<(&str, Files, Files, &str, &str, &str)> = vec![
            (
                "file",
                vec![("notes.md", Some(&b"notes\n"[..]))],
                vec![("notes.md", None), ("Notes.md", Some(&b"notes\n"[..]))],
                "notes.md",
                "Notes.md",
                "Notes.md",
            ),
            (
                "folder",
                vec![("docs/a.md", Some(&b"a\n"[..]))],
                vec![("docs/a.md", None), ("Docs/a.md", Some(&b"a\n"[..]))],
                "docs/a.md",
                "Docs/a.md",
                "Docs",
            ),
            (
                "folder into a file",
                vec![("Src/a.md", Some(&b"a\n"[..]))],
                vec![("Src/a.md", None), ("src", Some(&b"a\n"[..]))],
                "Src/a.md",
                "src",
                "src",
            ),
        ];
        for (case, seed, work, gone, came, top) in cases {
            let space = Space::new(mode, &[]).await;
            space.push(&seed, "seed");
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let mut files = work.clone();
            files.push(("other.md", Some(b"other\n")));
            let commit = space.park(&files, &reference);

            let body = space
                .restored(json!({ "ref": reference, "rev": commit }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {case}: {body}");
            assert_eq!(body["notRestored"], json!([]), "{mode:?} {case}: {body}");
            assert_eq!(body["refDeleted"], true, "{mode:?} {case}: {body}");
            assert_eq!(space.canonical_ref(&reference), None, "{mode:?} {case}");
            assert_eq!(space.on_main(gone), None, "{mode:?} {case}");
            assert!(space.on_main(came).is_some(), "{mode:?} {case}");
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} {case}"
            );
            if mode == Mode::Desktop {
                let root = &space.server(mode).config.workspace_root;
                assert!(names_in(root).contains(&top.to_string()), "{case}");
            }
        }

        // A file the person keeps that `HEAD` never tracked, at a name
        // that differs only in case from one the work adds, stays theirs.
        if mode != Mode::Desktop {
            continue;
        }
        let space = Space::new(mode, &[]).await;
        let root = space.server(mode).config.workspace_root.clone();
        if !ignores_case(&root) {
            continue;
        }
        let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let commit = space.park(
            &[("todo.md", Some(b"work\n")), ("other.md", Some(b"other\n"))],
            &reference,
        );
        std::fs::write(root.join("TODO.md"), b"mine\n").unwrap();
        let before = space.main();
        let (status, body) = space
            .restore(json!({ "ref": reference, "rev": commit }))
            .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (409, Some("dirty_paths")),
            "{body}"
        );
        assert_eq!(body["paths"], json!(["todo.md"]), "{body}");
        assert_eq!(std::fs::read(root.join("TODO.md")).unwrap(), b"mine\n");
        assert_eq!(space.main(), before);
        assert_eq!(
            space.canonical_ref(&reference).as_deref(),
            Some(commit.as_str())
        );
    }
}

/// A new name of the work that differs only in case from a file `main`
/// keeps is a clash in both modes, never a restore that lands both names
/// (the gateway) or an unsaved edit that is not there (Desktop on a disk
/// that ignores case). Work that renames `notes.md` to `Notes.md` after
/// `main` edited `notes.md`: keeping `main`'s `notes.md` leaves the new
/// name to settle, and keeping both restores the rest and lets the ref go.
/// A new `todo.md` beside a `TODO.md` that `main` gained since is the
/// same.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_name_that_differs_only_in_case_from_one_main_keeps_is_a_clash() {
    for mode in MODES {
        let space = Space::new(mode, &[("notes.md", b"1\n2\n3\n")]).await;
        let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let commit = space.park(
            &[
                ("notes.md", None),
                ("Notes.md", Some(b"1\n2\nwork\n")),
                ("other.md", Some(b"other\n")),
            ],
            &reference,
        );
        space.push(&[("notes.md", Some(b"main\n2\n3\n"))], "edit notes");
        let before = space.main();

        assert_eq!(
            space
                .conflict(json!({ "ref": reference, "rev": commit }))
                .await,
            json!(["Notes.md", "notes.md"]),
            "{mode:?}"
        );
        assert_eq!(
            space
                .conflict(json!({ "ref": reference, "rev": commit, "keep": ["notes.md"] }))
                .await,
            json!(["Notes.md"]),
            "{mode:?}"
        );
        assert_eq!(space.main(), before, "{mode:?}");
        assert_eq!(
            space.canonical_ref(&reference).as_deref(),
            Some(commit.as_str()),
            "{mode:?}"
        );

        let body = space
            .restored(json!({ "ref": reference, "rev": commit, "keep": ["notes.md", "Notes.md"] }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[("Notes.md", "kept"), ("notes.md", "kept")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(
            space.on_main("notes.md").as_deref(),
            Some(&b"main\n2\n3\n"[..]),
            "{mode:?}"
        );
        assert_eq!(space.on_main("Notes.md"), None, "{mode:?}");
        assert_eq!(
            space.on_main("other.md").as_deref(),
            Some(&b"other\n"[..]),
            "{mode:?}"
        );

        // A new name beside a file `main` gained since, which the work
        // never touched.
        let space = Space::new(mode, &[]).await;
        let reference = recovery_ref("20261005T121500Z-unsaved-0123456789ac");
        let commit = space.park(
            &[("todo.md", Some(b"work\n")), ("other.md", Some(b"other\n"))],
            &reference,
        );
        space.push(&[("TODO.md", Some(b"main\n"))], "a todo list");
        assert_eq!(
            space
                .conflict(json!({ "ref": reference, "rev": commit }))
                .await,
            json!(["todo.md"]),
            "{mode:?}"
        );
        let body = space
            .restored(json!({ "ref": reference, "rev": commit, "keep": ["todo.md"] }))
            .await;
        assert_eq!(
            body["notRestored"],
            reasons(&[("todo.md", "kept")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(space.on_main("todo.md"), None, "{mode:?}");
        assert_eq!(
            space.on_main("TODO.md").as_deref(),
            Some(&b"main\n"[..]),
            "{mode:?}"
        );
        assert_eq!(
            space.on_main("other.md").as_deref(),
            Some(&b"other\n"[..]),
            "{mode:?}"
        );
    }
}

/// A new folder of the work whose name differs only in case from a file
/// `main` holds (`Docs/guide.md` beside a file `docs`, at any depth) is a
/// clash in both modes, never an unsaved edit that is not there (Desktop on
/// a disk that ignores case finds the file where the folder goes) or a
/// `main` holding both names (the gateway). Keeping the new path restores
/// the rest and lets the ref go.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_folder_whose_name_a_file_on_main_takes_is_a_clash() {
    for mode in MODES {
        for (file, added) in [("docs", "Docs/guide.md"), ("a/b", "A/b/c.md")] {
            let space = Space::new(mode, &[(file, b"file\n")]).await;
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park_built(
                &[(added, Some(b"guide\n")), ("other.md", Some(b"other\n"))],
                &reference,
            );
            let before = space.main();

            assert_eq!(
                space
                    .conflict(json!({ "ref": reference, "rev": commit }))
                    .await,
                json!([added]),
                "{mode:?} {added}"
            );
            assert_eq!(space.main(), before, "{mode:?} {added}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} {added}"
            );

            let body = space
                .restored(json!({ "ref": reference, "rev": commit, "keep": [added] }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {added}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[(added, "kept")]),
                "{mode:?} {added}: {body}"
            );
            assert_eq!(body["refDeleted"], true, "{mode:?} {added}: {body}");
            assert_eq!(space.canonical_ref(&reference), None, "{mode:?} {added}");
            assert_eq!(
                space.paths_on_main(),
                vec!["README.md", file, "other.md"],
                "{mode:?} {added}"
            );
        }
    }
}

/// A change `main` already holds as the work has it brings nothing in, so
/// it is neither restored nor refused: nothing of the work exists only on
/// the ref, which goes.
#[tokio::test(flavor = "multi_thread")]
async fn work_main_already_holds_is_not_judged() {
    for mode in MODES {
        let space = Space::new(mode, &[]).await;
        let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let commit = space.park(
            &[
                (".env.local", Some(b"TOKEN=1\n")),
                ("extra.md", Some(b"extra\n")),
            ],
            &reference,
        );
        space.push(&[(".env.local", Some(b"TOKEN=1\n"))], "the same file");

        let body = space
            .restored(json!({ "ref": reference, "rev": commit }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(body["notRestored"], json!([]), "{mode:?}: {body}");
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(space.on_main("extra.md").as_deref(), Some(&b"extra\n"[..]));
    }
}

/// `main` holds a submodule entry, and on Desktop the person's folder holds
/// their own repository there: its history and an uncommitted edit. Work
/// that turns that entry into a file, or removes it, is never restored in
/// either mode (reads hide submodules, and Desktop's restore would delete
/// the nested repository): it is listed `unsupported`, the rest comes back,
/// the ref stays, `main` keeps the submodule entry and the nested
/// repository is untouched.
#[tokio::test(flavor = "multi_thread")]
async fn work_over_a_submodule_entry_is_never_restored() {
    for mode in MODES {
        for (case, change) in [("into a file", Some(&b"a file\n"[..])), ("removed", None)] {
            let space = Space::new(mode, &[]).await;
            let seed = space.main();
            space.push_entry("vendor", "160000", &seed, "a submodule");
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let mut files: Vec<(&str, Option<&[u8]>)> = vec![("vendor", None)];
            if let Some(bytes) = change {
                files.push(("vendor", Some(bytes)));
            }
            files.push(("other.md", Some(b"other\n")));
            let commit = space.park(&files, &reference);
            let nested = (mode == Mode::Desktop).then(|| {
                let folder = space
                    .server(Mode::Desktop)
                    .config
                    .workspace_root
                    .join("vendor");
                std::fs::create_dir_all(&folder).unwrap();
                git_in(&folder, &["init", "-q", "-b", "main"]);
                std::fs::write(folder.join("notes.txt"), b"committed\n").unwrap();
                git_in(&folder, &["add", "notes.txt"]);
                git_in(
                    &folder,
                    &[
                        "-c",
                        "user.name=Person",
                        "-c",
                        "user.email=person@example.com",
                        "commit",
                        "-q",
                        "-m",
                        "mine",
                    ],
                );
                std::fs::write(folder.join("notes.txt"), b"committed\nunsaved\n").unwrap();
                folder
            });

            let body = space
                .restored(json!({ "ref": reference, "rev": commit }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {case}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[("vendor", "unsupported")]),
                "{mode:?} {case}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?} {case}: {body}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} {case}"
            );
            assert_eq!(
                space.mode_on_main("vendor").as_deref(),
                Some("160000"),
                "{mode:?} {case}"
            );
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} {case}"
            );
            if let Some(folder) = nested {
                assert!(folder.join(".git").is_dir(), "{case}: nested history");
                assert_eq!(
                    std::fs::read(folder.join("notes.txt")).ok().as_deref(),
                    Some(&b"committed\nunsaved\n"[..]),
                    "{case}: nested edit"
                );
            }
        }
    }
}

/// Work that turns the folder `cfg/` into a file `cfg`, restored while the
/// person keeps `main`'s `cfg/a.txt`: that file needs the folder, so the
/// work's `cfg` file cannot come in with it, and `cfg` is a clash the
/// person settles. That holds whether `main` moved since the work's base or
/// not: a restore onto the base takes the work's tree whole, and putting
/// the kept file back used to take the work's `cfg` away without a word,
/// then delete the ref, its only copy. Keeping `cfg` too restores the rest
/// and lets the ref go.
#[tokio::test(flavor = "multi_thread")]
async fn a_file_the_work_made_of_a_folder_is_never_dropped_for_a_path_kept_below_it() {
    for mode in MODES {
        for moved in [false, true] {
            let space = Space::new(mode, &[("cfg/a.txt", b"a\n"), ("cfg/b.txt", b"b\n")]).await;
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park(
                &[
                    ("cfg", None),
                    ("cfg", Some(b"the work's cfg file\n")),
                    ("other.md", Some(b"other\n")),
                ],
                &reference,
            );
            if moved {
                space.push(
                    &[("unrelated.md", Some(b"unrelated\n"))],
                    "an unrelated save",
                );
            }
            let before = space.main();

            assert_eq!(
                space
                    .conflict(json!({ "ref": reference, "rev": commit, "keep": ["cfg/a.txt"] }))
                    .await,
                json!(["cfg"]),
                "{mode:?} moved {moved}"
            );
            assert_eq!(space.main(), before, "{mode:?} moved {moved}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} moved {moved}"
            );

            let body = space
                .restored(json!({ "ref": reference, "rev": commit, "keep": ["cfg", "cfg/a.txt"] }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[
                    ("cfg", "kept"),
                    ("cfg/a.txt", "kept"),
                    ("cfg/b.txt", "kept"),
                ]),
                "{mode:?} moved {moved}: {body}"
            );
            assert_eq!(body["refDeleted"], true, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                space.canonical_ref(&reference),
                None,
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} moved {moved}"
            );
            assert_eq!(space.on_main("cfg/a.txt").as_deref(), Some(&b"a\n"[..]));
            assert_eq!(space.on_main("cfg/b.txt").as_deref(), Some(&b"b\n"[..]));
        }
    }
}

/// Work that turns the folder `libs/`, where `main` holds the submodule
/// entry `libs/vendor`, into a file `libs`. The submodule entry stays (as
/// in `work_over_a_submodule_entry_is_never_restored`), so the work's `libs`
/// file can never come in either: both are listed `unsupported`, never
/// dropped unlisted, the rest of the work (`other.md` and its removal of
/// `libs/other.txt`) is restored, and the ref, the file's only copy, stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_a_submodule_entry_below_it_is_listed_not_restored() {
    for mode in MODES {
        for moved in [false, true] {
            let space = Space::new(mode, &[("libs/other.txt", b"other\n")]).await;
            let seed = space.main();
            space.push_entry("libs/vendor", "160000", &seed, "a submodule");
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park(
                &[
                    ("libs", None),
                    ("libs", Some(b"a file\n")),
                    ("other.md", Some(b"other\n")),
                ],
                &reference,
            );
            if moved {
                space.push(
                    &[("unrelated.md", Some(b"unrelated\n"))],
                    "an unrelated save",
                );
            }

            let body = space
                .restored(json!({ "ref": reference, "rev": commit }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[("libs", "unsupported"), ("libs/vendor", "unsupported")]),
                "{mode:?} moved {moved}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.mode_on_main("libs/vendor").as_deref(),
                Some("160000"),
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.on_main("libs/other.txt"),
                None,
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} moved {moved}"
            );
        }
    }
}

/// Work that turns the folder `scratch/` into a file `scratch` the space
/// ignores: the file is refused, so `main`'s folder stays, and the work's
/// removal of `scratch/a.txt` below it cannot come in either. It is listed
/// with the same reason, never dropped unlisted, and the ref stays.
#[tokio::test(flavor = "multi_thread")]
async fn work_below_a_refused_file_is_listed_with_its_reason() {
    for mode in MODES {
        for moved in [false, true] {
            let space = Space::new(
                mode,
                &[(".gitignore", b"scratch\n"), ("scratch/a.txt", b"a\n")],
            )
            .await;
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park(
                &[
                    ("scratch", None),
                    ("scratch", Some(b"a file\n")),
                    ("other.md", Some(b"other\n")),
                ],
                &reference,
            );
            if moved {
                space.push(
                    &[("unrelated.md", Some(b"unrelated\n"))],
                    "an unrelated save",
                );
            }

            let body = space
                .restored(json!({ "ref": reference, "rev": commit }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[("scratch", "ignored"), ("scratch/a.txt", "ignored")]),
                "{mode:?} moved {moved}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?} moved {moved}: {body}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.on_main("scratch/a.txt").as_deref(),
                Some(&b"a\n"[..]),
                "{mode:?} moved {moved}"
            );
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} moved {moved}"
            );
        }
    }
}

/// Work that turns the file `server` into a folder holding `index.js` and a
/// file that is refused (a secret, or one the space ignores), after `main`
/// edited `server`. The refused new file is not on `main`, so leaving it
/// out puts nothing back there and does not stand in the folder's way: it
/// never makes the work's real code look refused. The edit of `server`
/// and the work's folder are a clash the person settles, as without the
/// refused file; keeping both restores the rest, lists the refused file
/// with its reason and keeps the ref, its only copy.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_file_in_a_folder_the_work_made_of_a_file_never_hides_the_clash() {
    for mode in MODES {
        for (refused, reason) in [("server/.env", "secret"), ("server/debug.log", "ignored")] {
            let space = Space::new(
                mode,
                &[(".gitignore", b"*.log\n"), ("server", b"echo v1\n")],
            )
            .await;
            let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
            let commit = space.park(
                &[
                    ("server", None),
                    ("server/index.js", Some(b"serve()\n")),
                    (refused, Some(b"refused\n")),
                    ("other.md", Some(b"other\n")),
                ],
                &reference,
            );
            space.push(&[("server", Some(b"echo v2\n"))], "edit server");
            let before = space.main();

            assert_eq!(
                space
                    .conflict(json!({ "ref": reference, "rev": commit }))
                    .await,
                json!(["server", "server/index.js"]),
                "{mode:?} {refused}"
            );
            assert_eq!(
                space
                    .conflict(
                        json!({ "ref": reference, "rev": commit, "keep": ["server/index.js"] })
                    )
                    .await,
                json!(["server"]),
                "{mode:?} {refused}"
            );
            assert_eq!(space.main(), before, "{mode:?} {refused}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} {refused}"
            );

            let body = space
                .restored(json!({
                    "ref": reference,
                    "rev": commit,
                    "keep": ["server", "server/index.js"],
                }))
                .await;
            assert_eq!(body["committed"], true, "{mode:?} {refused}: {body}");
            assert_eq!(
                body["notRestored"],
                reasons(&[
                    ("server", "kept"),
                    (refused, reason),
                    ("server/index.js", "kept"),
                ]),
                "{mode:?} {refused}: {body}"
            );
            assert_eq!(body["refDeleted"], false, "{mode:?} {refused}: {body}");
            assert_eq!(
                space.canonical_ref(&reference).as_deref(),
                Some(commit.as_str()),
                "{mode:?} {refused}"
            );
            assert_eq!(
                space.on_main("server").as_deref(),
                Some(&b"echo v2\n"[..]),
                "{mode:?} {refused}"
            );
            assert_eq!(
                space.on_main("other.md").as_deref(),
                Some(&b"other\n"[..]),
                "{mode:?} {refused}"
            );
        }
    }
}

/// A file the plan restores but the shard refuses (a shard that takes
/// smaller files than a save allows) stays out of `main` in both modes and
/// is listed in `notRestored` with the shard's reason, so the person is
/// never told it came back; the rest lands, and the ref, that file's only
/// copy, stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_file_the_shard_refuses_is_listed_as_not_restored() {
    let data = vec![b'x'; 10_000];
    for mode in MODES {
        let space = Space::new(mode, &[]).await;
        let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let commit = space.park(
            &[
                ("data.bin", Some(data.as_slice())),
                ("other.md", Some(b"other\n")),
            ],
            &reference,
        );
        crate::test_support::install_shard_hook(&space.remote, &[("GIT_MAX_BLOB_BYTES", "4096")]);
        let before = space.main();

        let body = space
            .restored(json!({ "ref": reference, "rev": commit }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"],
            reasons(&[("data.bin", "too_large")]),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], false, "{mode:?}: {body}");
        assert_eq!(
            space.canonical_ref(&reference).as_deref(),
            Some(commit.as_str()),
            "{mode:?}"
        );
        assert_ne!(space.main(), before, "{mode:?}");
        assert_eq!(
            space.on_main("other.md").as_deref(),
            Some(&b"other\n"[..]),
            "{mode:?}"
        );
        assert_eq!(space.on_main("data.bin"), None, "{mode:?}");
    }
}

/// Every clash is named in one answer, so the person can choose for all of
/// them at once: 250 files both sides changed are all listed, with nothing
/// left for a later round, and sent back as `keep` they restore the rest and
/// let the ref go. Both modes take as many kept paths as a restore allows,
/// and refuse one more.
#[tokio::test(flavor = "multi_thread")]
async fn every_conflict_is_listed_and_can_be_kept_at_once() {
    let most = crate::publish::MAX_RESTORE_KEEP_PATHS;
    let paths: Vec<String> = (0..250).map(|index| format!("f{index:03}.md")).collect();
    for mode in MODES {
        let seed: Vec<(&str, &[u8])> = paths
            .iter()
            .map(|path| (path.as_str(), &b"seed\n"[..]))
            .collect();
        let space = Space::new(mode, &seed).await;
        let reference = recovery_ref("20261005T120000Z-unsaved-0123456789ab");
        let mut work: Vec<(&str, Option<&[u8]>)> = paths
            .iter()
            .map(|path| (path.as_str(), Some(&b"work\n"[..])))
            .collect();
        work.push(("other.md", Some(b"other\n")));
        let commit = space.park(&work, &reference);
        let theirs: Vec<(&str, Option<&[u8]>)> = paths
            .iter()
            .map(|path| (path.as_str(), Some(&b"main\n"[..])))
            .collect();
        space.push(&theirs, "main changes them all");

        let (status, answer) = space
            .restore(json!({ "ref": reference, "rev": commit }))
            .await;
        assert_eq!(
            (status, answer["code"].as_str()),
            (409, Some("restore_conflict")),
            "{mode:?}: {answer}"
        );
        assert_eq!(answer["paths"], json!(paths), "{mode:?}");
        assert!(answer.get("morePaths").is_none(), "{mode:?}: {answer}");

        let mut keep = paths.clone();
        keep.extend((paths.len()..=most).map(|index| format!("unrelated/{index}.md")));
        assert_eq!(keep.len(), most + 1);
        let (status, answer) = space
            .restore(json!({ "ref": reference, "rev": commit, "keep": keep }))
            .await;
        assert_eq!(status, 400, "{mode:?}: {answer}");
        keep.pop();
        let body = space
            .restored(json!({ "ref": reference, "rev": commit, "keep": keep }))
            .await;
        assert_eq!(body["committed"], true, "{mode:?}: {body}");
        assert_eq!(
            body["notRestored"].as_array().map(Vec::len),
            Some(paths.len()),
            "{mode:?}: {body}"
        );
        assert_eq!(body["refDeleted"], true, "{mode:?}: {body}");
        assert_eq!(space.on_main("other.md").as_deref(), Some(&b"other\n"[..]));
        assert_eq!(space.on_main("f000.md").as_deref(), Some(&b"main\n"[..]));
    }
}

/// One canonical history served by both modes: a salvage ref restored in
/// one mode, with nothing left to bring back, is recorded once, by that
/// mode's empty restore commit. The other mode lists it as restored too,
/// and restoring it there records nothing more, even before Desktop's
/// branch has caught up with the record.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_recorded_in_one_mode_counts_in_the_other() {
    for (first, second) in [
        (Mode::Desktop, Mode::Gateway),
        (Mode::Gateway, Mode::Desktop),
    ] {
        let space = Space::served_by(&[first, second], &[]).await;
        let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
        let commit = space.park(&[("draft.md", Some(b"draft\n"))], salvage);
        let before = space.push(&[("draft.md", Some(b"draft\n"))], "the same draft");

        let body = space
            .restored_in(first, json!({ "ref": salvage, "rev": commit }))
            .await;
        assert_eq!(
            (&body["committed"], &body["marked"]),
            (&json!(false), &json!(true)),
            "{first:?}: {body}"
        );
        let marker = space.main();
        assert_ne!(marker, before, "{first:?}");
        assert_eq!(
            git_in(&space.remote, &["log", "-1", "--format=%ce", &marker]),
            space.server(first).config.git_author_email,
            "{first:?}"
        );

        // The other mode records nothing more.
        let body = space
            .restored_in(second, json!({ "ref": salvage, "rev": commit }))
            .await;
        assert_eq!(
            (&body["committed"], &body["marked"]),
            (&json!(false), &json!(false)),
            "{second:?} after {first:?}: {body}"
        );
        assert_eq!(space.main(), marker, "{second:?} after {first:?}");

        for server in &space.servers {
            server.catch_up();
        }
        for mode in [first, second] {
            let entries = space.listed_in(mode).await;
            let entry = entries
                .iter()
                .find(|entry| entry["ref"] == salvage)
                .unwrap_or_else(|| panic!("{mode:?} lists the salvage ref"));
            assert_eq!(
                entry["restoredRev"],
                marker.as_str(),
                "{mode:?} after {first:?}"
            );
        }
    }
}
