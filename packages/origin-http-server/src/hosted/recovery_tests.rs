//! Restoring and dismissing unsaved work on the gateway, against real git:
//! recovery and salvage refs on a bare canonical repository, restored onto
//! `main` and removed through the routes.

use serde_json::json;

use super::tests::{decoded, get, post, serve, Answer, HostedScenario, Served};
use super::write_tests::{canonical, post_as, show, StubController};
use crate::test_support::{git_in, git_output, install_shard_hook};

/// The origin the recovery refs of these tests were kept by.
const ORIGIN: &str = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";

fn recovery_ref(name: &str) -> String {
    format!("refs/instafy/recovery/{ORIGIN}/{name}")
}

/// What canonical's `reference` names, if it exists.
fn canonical_ref(sc: &HostedScenario, reference: &str) -> Option<String> {
    let output = git_output(
        &sc.remote(),
        &["rev-parse", "--verify", "--quiet", reference],
        None,
    );
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The unsaved-work list.
async fn listed(served: &Served) -> Vec<serde_json::Value> {
    let answer = get(served, "/git/recovery").await;
    assert_eq!(
        answer.status,
        200,
        "{}",
        String::from_utf8_lossy(&answer.body)
    );
    answer.json()["entries"].as_array().unwrap().clone()
}

fn entry(entries: &[serde_json::Value], reference: &str) -> Option<serde_json::Value> {
    entries
        .iter()
        .find(|entry| entry["ref"] == reference)
        .cloned()
}

async fn restore(served: &Served, body: serde_json::Value) -> Answer {
    post(served, "/git/recovery/restore", body).await
}

async fn dismiss(served: &Served, body: serde_json::Value) -> Answer {
    post(served, "/git/recovery/dismiss", body).await
}

fn ok(answer: &Answer) -> serde_json::Value {
    assert_eq!(
        answer.status,
        200,
        "{}",
        String::from_utf8_lossy(&answer.body)
    );
    answer.json()
}

fn refused(answer: &Answer) -> (u16, String) {
    (answer.status, answer.code())
}

fn not_restored(body: &serde_json::Value) -> Vec<(String, String)> {
    body["notRestored"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                item["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn parents(sc: &HostedScenario, commit: &str) -> Vec<String> {
    canonical(sc, &["rev-list", "--parents", "--max-count", "1", commit])
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect()
}

/// Spec test 17: unsaved work kept on a recovery ref is merged onto what
/// `main` became since, saved as one gateway commit that names the ref,
/// and the ref goes; it cannot be restored twice.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_saves_the_work_on_main_and_removes_its_ref() {
    let sc = HostedScenario::new();
    sc.push(
        &[("README.md", Some(b"saved\n")), ("a.txt", Some(b"a\n"))],
        "seed",
    );
    let unsaved = sc.side_commit(
        &[("a.txt", b"a from the agent\n"), ("notes/new.md", b"new\n")],
        "unsaved work\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: a.txt\nInstafy-Path: notes/new.md",
    );
    let reference = recovery_ref("20261005T120000Z-unsaved-1");
    sc.push_ref(&unsaved, &reference);
    // Saved after the work was kept.
    let head = sc.push(&[("b.txt", Some(b"b\n"))], "a later save");
    let served = serve(&sc).await;
    let item = entry(&listed(&served).await, &reference).expect("listed");
    assert_eq!(item["rev"], unsaved.as_str());

    let body = ok(&restore(
        &served,
        json!({ "ref": reference, "rev": item["rev"], "baseRev": head }),
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(body["baseRev"], head.as_str());
    assert_eq!(body["notRestored"], json!([]));
    assert_eq!(body["refDeleted"], true);
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(sc.canonical_main().as_deref(), Some(restored.as_str()));
    assert_eq!(parents(&sc, &restored), vec![head.clone()]);
    for (path, content) in [
        ("a.txt", &b"a from the agent\n"[..]),
        ("notes/new.md", b"new\n"),
        ("b.txt", b"b\n"),
        ("README.md", b"saved\n"),
    ] {
        assert_eq!(
            show(&sc, &restored, path).as_deref(),
            Some(content),
            "{path}"
        );
    }
    let raw = canonical(&sc, &["cat-file", "commit", &restored]);
    assert!(
        raw.contains("committer instafy-origin <gateway@instafy.dev>"),
        "{raw}"
    );
    assert!(
        raw.ends_with(&format!(
            "\n\nRestore unsaved work\n\nInstafy-Restored-From: {reference}"
        )),
        "{raw}"
    );
    assert_eq!(canonical_ref(&sc, &reference), None, "the ref is gone");

    // Reads show it at once; the list no longer has it.
    let read = get(&served, "/files/notes/new.md").await;
    assert_eq!(decoded(&read), b"new\n");
    assert_eq!(read.rev(), Some(restored.clone()));
    assert!(entry(&listed(&served).await, &reference).is_none());

    // A second restore is impossible.
    let again = restore(&served, json!({ "ref": reference, "rev": unsaved })).await;
    assert_eq!(refused(&again), (409, "recovery_ref_moved".to_string()));
    assert!(again.json()["rev"].is_null());
    let again = restore(&served, json!({ "ref": reference })).await;
    assert_eq!(refused(&again), (404, "rev_not_found".to_string()));
    assert_eq!(sc.canonical_main(), Some(restored));
}

/// Work `main` already has is "nothing to restore": no commit, and the ref
/// goes, since nothing is lost with it.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_of_work_main_already_has_changes_nothing() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"saved\n"))], "seed");
    let unsaved = sc.side_commit(&[("notes/new.md", b"new\n")], "unsaved");
    let reference = recovery_ref("unsaved-2");
    sc.push_ref(&unsaved, &reference);
    let head = sc.push(&[("notes/new.md", Some(b"new\n"))], "saved another way");
    let served = serve(&sc).await;

    let body = ok(&restore(
        &served,
        json!({ "ref": reference, "rev": unsaved, "baseRev": head }),
    )
    .await);
    assert_eq!(body["committed"], false);
    assert_eq!(body["rev"], head.as_str());
    assert_eq!(body["baseRev"], head.as_str());
    assert_eq!(body["notRestored"], json!([]));
    assert_eq!(body["refDeleted"], true);
    assert_eq!(sc.canonical_main(), Some(head));
    assert_eq!(canonical_ref(&sc, &reference), None);
}

/// Spec test 17 (409): what both sides changed is `restore_conflict` with
/// the head and paths, and nothing changes. Keeping the saved version of a
/// conflicted file ("Keep current") or saving the kept one first ("Use this
/// version") lets the rest be restored.
#[tokio::test(flavor = "multi_thread")]
async fn conflicts_are_answered_and_settled_by_the_person() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "seed");
    let unsaved = sc.side_commit(
        &[("README.md", b"theirs\n"), ("extra.md", b"extra\n")],
        "unsaved",
    );
    let reference = recovery_ref("unsaved-3");
    sc.push_ref(&unsaved, &reference);
    let head = sc.push(&[("README.md", Some(b"ours\n"))], "saved meanwhile");
    let served = serve(&sc).await;

    let answer = restore(
        &served,
        json!({ "ref": reference, "rev": unsaved, "baseRev": head }),
    )
    .await;
    assert_eq!(refused(&answer), (409, "restore_conflict".to_string()));
    assert_eq!(answer.json()["paths"], json!(["README.md"]));
    assert_eq!(answer.json()["head"], head.as_str());
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));
    assert_eq!(
        canonical_ref(&sc, &reference).as_deref(),
        Some(unsaved.as_str())
    );

    // "Keep current", then "Restore the rest".
    let body = ok(&restore(
        &served,
        json!({
            "ref": reference,
            "rev": unsaved,
            "baseRev": head,
            "keep": ["README.md", " README.md ", ""],
        }),
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(
        not_restored(&body),
        vec![("README.md".to_string(), "kept".to_string())]
    );
    assert_eq!(body["refDeleted"], true, "keeping a file is a choice");
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(
        show(&sc, &restored, "README.md").as_deref(),
        Some(&b"ours\n"[..])
    );
    assert_eq!(
        show(&sc, &restored, "extra.md").as_deref(),
        Some(&b"extra\n"[..])
    );

    // "Use this version": the kept file is saved first, so nothing
    // conflicts any more.
    let other = sc.side_commit(
        &[("README.md", b"theirs again\n"), ("more.md", b"more\n")],
        "more unsaved work",
    );
    let other_ref = recovery_ref("unsaved-4");
    sc.push_ref(&other, &other_ref);
    sc.push(&[("README.md", Some(b"ours again\n"))], "saved meanwhile");
    let answer = restore(&served, json!({ "ref": other_ref, "rev": other })).await;
    assert_eq!(refused(&answer), (409, "restore_conflict".to_string()));
    let used = sc.push(
        &[("README.md", Some(b"theirs again\n"))],
        "use this version",
    );
    let body = ok(&restore(
        &served,
        json!({ "ref": other_ref, "rev": other, "baseRev": used }),
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(body["notRestored"], json!([]));
    let restored = body["rev"].as_str().unwrap();
    assert_eq!(
        show(&sc, restored, "README.md").as_deref(),
        Some(&b"theirs again\n"[..])
    );
    assert_eq!(
        show(&sc, restored, "more.md").as_deref(),
        Some(&b"more\n"[..])
    );
}

/// Secrets, build output, files the space now ignores and files over the
/// size cap are never restored; they are reported, and the ref that still
/// holds them stays (marked restored in the list).
#[tokio::test(flavor = "multi_thread")]
async fn paths_that_may_never_be_saved_stay_out_and_keep_their_ref() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let big = vec![0u8; 20 * 1024 * 1024 + 1];
    let unsaved = sc.side_commit(
        &[
            ("ok.md", b"ok\n"),
            (".env", b"TOKEN=x\n"),
            ("tmp/x.txt", b"x\n"),
            ("logs/a.log", b"log\n"),
            ("data.bin", &big),
        ],
        "unsaved",
    );
    let reference = recovery_ref("unsaved-5");
    sc.push_ref(&unsaved, &reference);
    // The space ignores logs/ since.
    let head = sc.push(&[(".gitignore", Some(b"logs/\n"))], "ignore logs");
    let served = serve(&sc).await;

    let body = ok(&restore(
        &served,
        json!({ "ref": reference, "rev": unsaved, "baseRev": head }),
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(
        not_restored(&body),
        [
            (".env", "secret"),
            ("data.bin", "too_large"),
            ("logs/a.log", "ignored"),
            ("tmp/x.txt", "excluded"),
        ]
        .map(|(path, reason)| (path.to_string(), reason.to_string()))
        .to_vec()
    );
    assert_eq!(body["refDeleted"], false, "the ref keeps what was left out");
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(show(&sc, &restored, "ok.md").as_deref(), Some(&b"ok\n"[..]));
    for path in [".env", "tmp/x.txt", "logs/a.log", "data.bin"] {
        assert!(show(&sc, &restored, path).is_none(), "{path}");
    }
    assert_eq!(
        canonical_ref(&sc, &reference).as_deref(),
        Some(unsaved.as_str())
    );
    let item = entry(&listed(&served).await, &reference).expect("still listed");
    assert_eq!(item["restoredRev"], restored.as_str());

    // Again: nothing more to restore, and the ref still stays.
    let body = ok(&restore(&served, json!({ "ref": reference, "rev": unsaved })).await);
    assert_eq!(body["committed"], false);
    assert_eq!(body["rev"], restored.as_str());
    assert_eq!(body["refDeleted"], false);
}

/// Salvage refs are restored as often as wanted and never removed: not
/// by a restore, not by a dismiss.
#[tokio::test(flavor = "multi_thread")]
async fn salvage_work_is_restored_and_kept_for_good() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let salvaged = sc.side_commit(
        &[("draft.md", b"draft\n")],
        "Keep unsaved edits from the retired file gateway\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: draft.md",
    );
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    sc.push_ref(&salvaged, salvage);
    let served = serve(&sc).await;
    let item = entry(&listed(&served).await, salvage).expect("listed");
    assert_eq!(item["dismissible"], false);
    assert!(item.get("restoredRev").is_none());

    let body = ok(&restore(&served, json!({ "ref": salvage, "rev": salvaged })).await);
    assert_eq!(body["committed"], true);
    assert_eq!(body["refDeleted"], false);
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(
        show(&sc, &restored, "draft.md").as_deref(),
        Some(&b"draft\n"[..])
    );
    assert_eq!(
        canonical_ref(&sc, salvage).as_deref(),
        Some(salvaged.as_str())
    );
    let item = entry(&listed(&served).await, salvage).expect("still listed");
    assert_eq!(item["restoredRev"], restored.as_str());

    let answer = dismiss(&served, json!({ "ref": salvage, "rev": salvaged })).await;
    assert_eq!(refused(&answer), (409, "salvage_ref_kept".to_string()));
    assert_eq!(
        canonical_ref(&sc, salvage).as_deref(),
        Some(salvaged.as_str())
    );
    let body = ok(&restore(&served, json!({ "ref": salvage })).await);
    assert_eq!(body["committed"], false);
    assert_eq!(body["rev"], restored.as_str());
    assert_eq!(body["refDeleted"], false);
}

/// A dismiss deletes the ref only while it names what the client listed:
/// a ref that moved stays, one already gone answers `missing`, and a tag
/// ref is removed by the tag's id (the listed one).
#[tokio::test(flavor = "multi_thread")]
async fn a_dismiss_removes_only_what_was_listed() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let first = sc.side_commit(&[("a.md", b"a\n")], "first");
    let second = sc.side_commit(&[("b.md", b"b\n")], "second");
    let gone = recovery_ref("unsaved-6");
    sc.push_ref(&first, &gone);
    let moved = recovery_ref("unsaved-7");
    sc.push_ref(&second, &moved);
    git_in(&sc.work, &["tag", "-a", "-m", "kept", "kept-tag", &first]);
    let tag = git_in(&sc.work, &["rev-parse", "kept-tag"]);
    let tagged = recovery_ref("unsaved-8");
    sc.push_ref(&tag, &tagged);
    let main = sc.canonical_main();
    let served = serve(&sc).await;

    let body = ok(&dismiss(&served, json!({ "ref": gone, "rev": first })).await);
    assert_eq!(body, json!({ "dismissed": true, "missing": false }));
    assert_eq!(canonical_ref(&sc, &gone), None);
    let body = ok(&dismiss(&served, json!({ "ref": gone, "rev": first })).await);
    assert_eq!(body, json!({ "dismissed": false, "missing": true }));

    let answer = dismiss(&served, json!({ "ref": moved, "rev": first })).await;
    assert_eq!(refused(&answer), (409, "recovery_ref_moved".to_string()));
    assert_eq!(answer.json()["rev"], second.as_str());
    assert_eq!(canonical_ref(&sc, &moved).as_deref(), Some(second.as_str()));

    let item = entry(&listed(&served).await, &tagged).expect("listed");
    assert_eq!(item["rev"], tag.as_str());
    let answer = dismiss(&served, json!({ "ref": tagged, "rev": first })).await;
    assert_eq!(refused(&answer), (409, "recovery_ref_moved".to_string()));
    let body = ok(&dismiss(&served, json!({ "ref": tagged, "rev": tag })).await);
    assert_eq!(body["dismissed"], true);
    assert_eq!(canonical_ref(&sc, &tagged), None);

    for (body, code) in [
        (json!({ "ref": moved }), "invalid_rev"),
        (json!({ "ref": moved, "rev": "abc" }), "invalid_rev"),
        (
            json!({ "ref": "refs/heads/main", "rev": second }),
            "invalid_ref",
        ),
        (
            json!({ "ref": format!("refs/instafy/recovery/{ORIGIN}/../x"), "rev": second }),
            "invalid_ref",
        ),
    ] {
        let answer = dismiss(&served, body.clone()).await;
        assert_eq!(refused(&answer), (400, code.to_string()), "{body}");
    }
    assert_eq!(canonical_ref(&sc, &moved).as_deref(), Some(second.as_str()));
    assert_eq!(sc.canonical_main(), main, "main is never touched");
}

/// With a `baseRev` other than `main`, a restore checks that nothing it
/// changes moved since (409 `head_moved`, as for a save); moves elsewhere
/// do not matter, and the merge keeps both sides' lines.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_made_on_an_older_main_checks_what_it_changes() {
    let sc = HostedScenario::new();
    let seed = sc.push(
        &[
            ("a.txt", Some(b"1\n2\n3\n4\n5\n6\n7\n")),
            ("b.txt", Some(b"b\n")),
        ],
        "seed",
    );
    let unsaved = sc.side_commit(
        &[("a.txt", b"one\n2\n3\n4\n5\n6\n7\n"), ("q.md", b"q\n")],
        "unsaved",
    );
    let reference = recovery_ref("unsaved-9");
    sc.push_ref(&unsaved, &reference);
    let edited = sc.push(&[("a.txt", Some(b"1\n2\n3\n4\n5\n6\nseven\n"))], "edit");
    let served = serve(&sc).await;

    let answer = restore(
        &served,
        json!({ "ref": reference, "rev": unsaved, "baseRev": seed }),
    )
    .await;
    assert_eq!(refused(&answer), (409, "head_moved".to_string()));
    assert_eq!(answer.json()["paths"], json!(["a.txt"]));
    assert_eq!(answer.json()["head"], edited.as_str());
    // A version this space never had.
    let answer = restore(
        &served,
        json!({
            "ref": reference,
            "rev": unsaved,
            "baseRev": "0123456789abcdef0123456789abcdef01234567",
        }),
    )
    .await;
    assert_eq!(refused(&answer), (409, "head_moved".to_string()));
    assert_eq!(answer.json()["paths"], json!(["a.txt", "q.md"]));
    assert_eq!(sc.canonical_main().as_deref(), Some(edited.as_str()));

    // `main` moved only where the restore does not write.
    let later = sc.push(&[("b.txt", Some(b"b2\n"))], "unrelated");
    let body = ok(&restore(
        &served,
        json!({ "ref": reference, "rev": unsaved, "baseRev": edited }),
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(body["baseRev"], later.as_str());
    let restored = body["rev"].as_str().unwrap();
    assert_eq!(
        show(&sc, restored, "a.txt").as_deref(),
        Some(&b"one\n2\n3\n4\n5\n6\nseven\n"[..])
    );
    assert_eq!(show(&sc, restored, "b.txt").as_deref(), Some(&b"b2\n"[..]));
}

/// Work kept before a space had any `main` makes its first commit.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_into_an_empty_space_makes_its_first_commit() {
    let sc = HostedScenario::new();
    std::fs::write(sc.work.join("first.md"), "first\n").unwrap();
    git_in(&sc.work, &["add", "first.md"]);
    git_in(&sc.work, &["commit", "-q", "-m", "unsaved"]);
    let unsaved = git_in(&sc.work, &["rev-parse", "HEAD"]);
    let reference = recovery_ref("unsaved-10");
    sc.push_ref(&unsaved, &reference);
    assert_eq!(sc.canonical_main(), None);
    let served = serve(&sc).await;

    let body = ok(&restore(&served, json!({ "ref": reference, "rev": unsaved })).await);
    assert_eq!(body["committed"], true);
    assert!(body["baseRev"].is_null());
    assert_eq!(body["refDeleted"], true);
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(sc.canonical_main().as_deref(), Some(restored.as_str()));
    assert!(parents(&sc, &restored).is_empty(), "a root commit");
    assert_eq!(
        show(&sc, &restored, "first.md").as_deref(),
        Some(&b"first\n"[..])
    );
}

/// Bad requests change nothing.
#[tokio::test(flavor = "multi_thread")]
async fn restore_requests_are_checked_before_anything_changes() {
    let sc = HostedScenario::new();
    let seed = sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let unsaved = sc.side_commit(&[("a.md", b"a\n")], "unsaved");
    let reference = recovery_ref("unsaved-11");
    sc.push_ref(&unsaved, &reference);
    let served = serve(&sc).await;

    for (body, status, code) in [
        (json!({ "ref": "refs/heads/main" }), 400, "invalid_ref"),
        (
            json!({ "ref": reference, "rev": "abc" }),
            400,
            "invalid_rev",
        ),
        (
            json!({ "ref": reference, "baseRev": "xyz" }),
            400,
            "invalid_rev",
        ),
        (
            json!({ "ref": reference, "keep": ["../x"] }),
            400,
            "invalid_path",
        ),
        (
            json!({ "ref": reference, "rev": seed }),
            409,
            "recovery_ref_moved",
        ),
        (
            json!({ "ref": recovery_ref("never-there"), "rev": seed }),
            409,
            "recovery_ref_moved",
        ),
        (
            json!({ "ref": recovery_ref("never-there") }),
            404,
            "rev_not_found",
        ),
    ] {
        let answer = restore(&served, body.clone()).await;
        assert_eq!(refused(&answer), (status, code.to_string()), "{body}");
    }
    let moved = restore(&served, json!({ "ref": reference, "rev": seed })).await;
    assert_eq!(moved.json()["rev"], unsaved.as_str());
    let many: Vec<String> = (0..1001).map(|index| format!("f{index}")).collect();
    let answer = restore(&served, json!({ "ref": reference, "keep": many })).await;
    assert_eq!(answer.status, 400);
    assert_eq!(sc.canonical_main(), Some(seed));
    assert_eq!(
        canonical_ref(&sc, &reference).as_deref(),
        Some(unsaved.as_str())
    );
}

/// Under the shard's own rules and a person's token: the restore names the
/// person (never their id), a path the shard refuses stays out (and so the
/// ref stays), and recovery refs can be removed.
#[tokio::test(flavor = "multi_thread")]
async fn restores_and_dismisses_under_the_shard_rules_and_a_persons_token() {
    let mut sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"r\n"))], "seed");
    let unsaved = sc.side_commit(&[("ok.md", b"ok\n"), ("assets/a.zip", b"zip")], "unsaved");
    let reference = recovery_ref("unsaved-12");
    sc.push_ref(&unsaved, &reference);
    let clean = sc.side_commit(&[("clean.md", b"clean\n")], "clean");
    let clean_ref = recovery_ref("unsaved-13");
    sc.push_ref(&clean, &clean_ref);
    let dropped = sc.side_commit(&[("drop.md", b"d\n")], "dropped");
    let dropped_ref = recovery_ref("unsaved-14");
    sc.push_ref(&dropped, &dropped_ref);
    install_shard_hook(&sc.remote(), &[("GIT_DENY_PATHS", "*.zip")]);
    let controller = StubController::start(sc.project).await;
    controller.configure(&mut sc);
    let served = serve(&sc).await;
    let pseudonym = "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev";
    let token = controller.token(
        &["fs.read", "fs.write"],
        json!({ "author_name": "Ada Lovelace", "author_email": pseudonym }),
    );

    let answer = post_as(
        &served,
        "/git/recovery/restore",
        json!({ "ref": reference, "rev": unsaved }),
        &token,
    )
    .await;
    let body = ok(&answer);
    assert_eq!(body["committed"], true);
    assert_eq!(
        not_restored(&body),
        vec![("assets/a.zip".to_string(), "policy".to_string())]
    );
    assert_eq!(body["refDeleted"], false);
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(show(&sc, &restored, "ok.md").as_deref(), Some(&b"ok\n"[..]));
    assert!(show(&sc, &restored, "assets/a.zip").is_none());
    let raw = canonical(&sc, &["cat-file", "commit", &restored]);
    assert!(
        raw.contains(&format!("author Ada Lovelace <{pseudonym}>")),
        "{raw}"
    );
    assert!(
        raw.contains("committer instafy-origin <gateway@instafy.dev>"),
        "{raw}"
    );
    assert!(!raw.contains(&controller.user.to_string()), "{raw}");
    assert_eq!(
        canonical_ref(&sc, &reference).as_deref(),
        Some(unsaved.as_str())
    );

    let body = ok(&post_as(
        &served,
        "/git/recovery/restore",
        json!({ "ref": clean_ref, "rev": clean }),
        &token,
    )
    .await);
    assert_eq!(body["committed"], true);
    assert_eq!(body["refDeleted"], true);
    assert_eq!(canonical_ref(&sc, &clean_ref), None);

    let body = ok(&post_as(
        &served,
        "/git/recovery/dismiss",
        json!({ "ref": dropped_ref, "rev": dropped }),
        &token,
    )
    .await);
    assert_eq!(body["dismissed"], true);
    assert_eq!(canonical_ref(&sc, &dropped_ref), None);
}
