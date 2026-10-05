//! The gateway keeps no working copy: a space served through every route
//! leaves nothing under the workspace root but its disposable bare mirror,
//! and every save, revert and restore is on canonical `main`.

use std::path::Path;

use serde_json::json;

use super::tests::{decoded, get, post, serve, Answer, HostedScenario, Served};
use super::write_tests::{apply, manifest, zip};
use crate::test_support::git_in;

/// The origin the recovery refs of this test were kept by.
const ORIGIN: &str = "5e1f0c2a-7d3b-4c8e-9a6f-1b2c3d4e5f60";

fn ok(answer: &Answer, what: &str) -> serde_json::Value {
    assert_eq!(
        answer.status,
        200,
        "{what}: {}",
        String::from_utf8_lossy(&answer.body)
    );
    answer.json()
}

/// The names in `dir`, sorted.
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Every path below `dir`, relative to it, never following a link.
fn every_path(dir: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.file_type().is_symlink(), "{path:?} is a link");
            paths.push(
                path.strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    paths
}

/// A multipart `/apply` of `files` on `base`.
async fn apply_multipart(served: &Served, files: &[(&str, &[u8])], base: &str) -> Answer {
    let paths: Vec<&str> = files.iter().map(|(path, _)| *path).collect();
    let manifest_text = manifest(&paths, &[], json!({ "baseRev": base })).to_string();
    let boundary = "instafy-stateless-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n{manifest_text}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"archive\"; filename=\"a.zip\"\r\nContent-Type: application/zip\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&zip(files));
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
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.unwrap().to_vec(),
    }
}

/// Every route a space uses, reads and writes alike, then the workspace
/// root: only `.git-cache` with the space's bare mirror and empty scratch
/// folders. No folder named for the space, no `.instafy`, no checked-out
/// file anywhere, no index in the mirror; canonical `main` holds the work.
#[tokio::test(flavor = "multi_thread")]
async fn every_route_leaves_only_the_disposable_mirror() {
    let sc = HostedScenario::new();
    let first = sc.push(
        &[
            ("README.md", Some(b"one\n")),
            ("src/a.rs", Some(b"a\n")),
            ("docs/old.md", Some(b"old\n")),
        ],
        "first",
    );
    let kept = sc.side_commit(
        &[("notes/kept.md", b"kept\n")],
        "unsaved work\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: notes/kept.md",
    );
    let kept_ref = format!("refs/instafy/recovery/{ORIGIN}/20261005T120000Z-unsaved-1");
    sc.push_ref(&kept, &kept_ref);
    let dropped = sc.side_commit(
        &[("notes/dropped.md", b"dropped\n")],
        "unsaved work\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: notes/dropped.md",
    );
    let dropped_ref = format!("refs/instafy/recovery/{ORIGIN}/20261005T120000Z-unsaved-2");
    sc.push_ref(&dropped, &dropped_ref);
    let served = serve(&sc).await;

    let reads = [
        "/entries".to_string(),
        "/entries?path=src".to_string(),
        "/files/README.md".to_string(),
        "/raw/README.md".to_string(),
        "/git/status".to_string(),
        "/git/history".to_string(),
        "/git/diff?path=README.md".to_string(),
        format!("/git/history/review?commit={first}"),
        "/git/recovery".to_string(),
        format!("/files/notes/kept.md?ref={kept_ref}"),
        format!("/git/history/review?commit={kept}&ref={kept_ref}"),
    ];
    for read in &reads {
        let answer = get(&served, read).await;
        assert_eq!(
            answer.status,
            200,
            "{read}: {}",
            String::from_utf8_lossy(&answer.body)
        );
    }

    // A save (JSON), a save (multipart), a revert, two syncs, a restore,
    // a dismiss and a refused discard.
    let saved = ok(
        &apply(
            &served,
            manifest(
                &["README.md", "src/b.rs"],
                &["docs/old.md"],
                json!({ "baseRev": first }),
            ),
            &zip(&[("README.md", b"two\n"), ("src/b.rs", b"b\n")]),
        )
        .await,
        "apply-json",
    );
    assert_eq!(saved["committed"], true);
    let saved = saved["rev"].as_str().unwrap().to_string();
    let uploaded = ok(
        &apply_multipart(&served, &[("src/c.rs", b"c\n")], &saved).await,
        "apply",
    );
    let uploaded = uploaded["rev"].as_str().unwrap().to_string();
    let reverted = ok(
        &post(&served, "/git/revert-commit", json!({ "commit": saved })).await,
        "revert-commit",
    );
    assert_eq!(reverted["committed"], true);
    let reverted = reverted["rev"].as_str().unwrap().to_string();
    assert_eq!(
        ok(
            &post(&served, "/git/sync", json!({ "expectedRev": uploaded })).await,
            "sync",
        )["rev"],
        reverted.as_str()
    );
    assert_eq!(
        ok(&post(&served, "/git/sync", json!({})).await, "sync")["committed"],
        false
    );
    let restored = ok(
        &post(
            &served,
            "/git/recovery/restore",
            json!({ "ref": kept_ref, "rev": kept, "baseRev": reverted }),
        )
        .await,
        "restore",
    );
    assert_eq!(restored["committed"], true);
    assert_eq!(restored["refDeleted"], true);
    let restored = restored["rev"].as_str().unwrap().to_string();
    assert_eq!(
        ok(
            &post(
                &served,
                "/git/recovery/dismiss",
                json!({ "ref": dropped_ref, "rev": dropped }),
            )
            .await,
            "dismiss",
        )["dismissed"],
        true
    );
    let discard = post(&served, "/git/revert", json!({ "paths": ["README.md"] })).await;
    assert_eq!(
        (discard.status, discard.code().as_str()),
        (400, "not_supported")
    );

    // Canonical holds all of it; the reads show it.
    assert_eq!(sc.canonical_main(), Some(restored.clone()));
    let mut files: Vec<String> = git_in(
        &sc.remote(),
        &["ls-tree", "-r", "--name-only", "refs/heads/main"],
    )
    .lines()
    .map(str::to_string)
    .collect();
    files.sort();
    assert_eq!(
        files,
        [
            "README.md",
            "docs/old.md",
            "notes/kept.md",
            "src/a.rs",
            "src/c.rs"
        ]
    );
    let readme = get(&served, "/files/README.md").await;
    assert_eq!(decoded(&readme), b"one\n");
    assert_eq!(readme.rev(), Some(restored.clone()));
    for read in &reads[..9] {
        assert_eq!(get(&served, read).await.status, 200, "{read}");
    }

    // The workspace root holds the cache and nothing else.
    assert_eq!(names(&sc.root), [".git-cache"]);
    let cache = sc.root.join(".git-cache");
    let mirror_name = format!("{}.git", sc.project);
    assert_eq!(
        names(&cache),
        [".quarantine", ".staging", ".trash", mirror_name.as_str()]
    );
    for scratch in [".quarantine", ".staging", ".trash"] {
        assert_eq!(
            names(&cache.join(scratch)),
            Vec::<String>::new(),
            "{scratch}"
        );
    }
    let mirror = sc.mirror();
    assert_eq!(
        git_in(&mirror, &["rev-parse", "--is-bare-repository"]),
        "true"
    );
    assert_eq!(git_in(&mirror, &["config", "--get", "core.bare"]), "true");
    assert!(!mirror.join("index").exists());
    assert_eq!(
        git_in(&mirror, &["rev-parse", "refs/heads/main"]),
        restored.as_str()
    );
    for path in every_path(&sc.root) {
        let name = path.rsplit('/').next().unwrap_or_default();
        assert!(
            !matches!(
                name,
                "README.md" | "a.rs" | "b.rs" | "c.rs" | "kept.md" | "old.md"
            ) && !path.split('/').any(|part| part == ".instafy"),
            "{path} looks like a working copy"
        );
    }
}
