import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(import.meta.dirname, "release-refs.sh");
const TAG = "android-v1.0-260860839";
const COMMIT = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);
const COMMIT_DATE = "2026-09-10T12:00:00Z";

function release(tag, draft, created) {
  return { tag_name: tag, draft, created_at: created };
}

function fullPage(created, draftTag) {
  return Array.from({ length: 100 }, (_, index) =>
    release(index === 50 && draftTag ? draftTag : `desktop-app-v1.0.${index}`, index === 50 && Boolean(draftTag), created),
  );
}

// A fake gh that answers the three read-only API calls the recheck makes.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
not_found() { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
server_error() { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }
case "$2" in
  repos/instafy-dev/instafy/git/ref/tags/*)
    case "$FAKE_TAG" in 404) not_found ;; 502) server_error ;; *) echo "$FAKE_TAG" ;; esac ;;
  repos/instafy-dev/instafy/git/tags/*) echo "$FAKE_PEELED" ;;
  repos/instafy-dev/instafy/compare/*) echo "$FAKE_COMPARE" ;;
  repos/instafy-dev/instafy/releases/tags/*)
    case "$FAKE_RELEASE" in 404) not_found ;; 502) server_error ;; *) echo 42 ;; esac ;;
  repos/instafy-dev/instafy/commits/*)
    case "$FAKE_COMMIT_DATE" in 502) server_error ;; *) jq -r "$4" <<< "$FAKE_COMMIT_DATE" ;; esac ;;
  "repos/instafy-dev/instafy/releases?per_page=100&page="*)
    [[ "$3" == "--jq" && $# -eq 4 ]] || { echo "unexpected releases call" >&2; exit 2; }
    case "$FAKE_RELEASE_PAGES" in 502) server_error ;; esac
    page="\${2##*page=}"
    # Real jq stands in for gh's --jq; pages past the end are empty arrays.
    jq -r --argjson p "$page" '(.[$p - 1] // []) | '"$4" <<< "$FAKE_RELEASE_PAGES" ;;
  *) echo "unexpected gh call" >&2; exit 2 ;;
esac
`;

function run(args, fake) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-refs-"));
  try {
    fs.writeFileSync(path.join(root, "gh"), FAKE_GH, { mode: 0o755 });
    const log = path.join(root, "gh.log");
    const result = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${root}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_TAG: `commit ${COMMIT}`,
        FAKE_PEELED: `commit ${COMMIT}`,
        FAKE_COMPARE: "ahead",
        FAKE_RELEASE: "404",
        FAKE_COMMIT_DATE: JSON.stringify({ commit: { author: { date: COMMIT_DATE }, committer: { date: COMMIT_DATE } } }),
        FAKE_RELEASE_PAGES: JSON.stringify([
          [release("android-v1.0-260860838", true, "2026-09-18T00:00:00Z"), release("android-v1.0-2608608390", true, "2026-09-17T00:00:00Z")],
        ]),
        ...fake,
      },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...result, calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("recheck passes only for the exact tag commit on main with no release yet", () => {
  const ok = run(["recheck", TAG, COMMIT], {});
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /android-v1\.0-260860839 -> a{40} on main \(ahead\); no GitHub Release yet/u);
  assert.deepEqual(ok.calls.map((call) => call.split(" ")[1]), [
    `repos/instafy-dev/instafy/git/ref/tags/${TAG}`,
    `repos/instafy-dev/instafy/compare/${COMMIT}...main`,
    `repos/instafy-dev/instafy/releases/tags/${TAG}`,
    `repos/instafy-dev/instafy/commits/${COMMIT}`,
    "repos/instafy-dev/instafy/releases?per_page=100&page=1",
  ]);
  const annotated = run(["recheck", TAG, COMMIT], { FAKE_TAG: `tag ${TAG_OBJECT}`, FAKE_COMPARE: "identical" });
  assert.equal(annotated.status, 0, annotated.stderr);
  assert.ok(annotated.calls.some((call) => call.includes(`git/tags/${TAG_OBJECT}`)));
});

test("recheck fails closed on moved tags, rewritten main, existing releases and unknown API errors", () => {
  const cases = [
    [{ FAKE_TAG: `commit ${"c".repeat(40)}` }, /no longer resolves to/u],
    [{ FAKE_TAG: "404" }, /no longer resolves to a{40} \(now: absent\)/u],
    [{ FAKE_TAG: "502" }, /Could not resolve tag/u],
    [{ FAKE_TAG: `tag ${TAG_OBJECT}`, FAKE_PEELED: `tree ${COMMIT}` }, /does not peel to a commit/u],
    [{ FAKE_COMPARE: "behind" }, /no longer contains/u],
    [{ FAKE_COMPARE: "diverged" }, /no longer contains/u],
    [{ FAKE_RELEASE: "exists" }, /already exists; this tag was already published/u],
    [{ FAKE_RELEASE: "502" }, /Could not prove that no GitHub Release exists/u],
    [{ FAKE_RELEASE_PAGES: JSON.stringify([[release("android-v1.0-1", true, "2026-09-11T00:00:00Z"), release(TAG, true, "2026-09-11T00:00:00Z")]]) }, /draft GitHub Release for android-v1\.0-260860839 exists/u],
    // A published release of the same name is caught by releases/tags; only drafts matter here.
    [{ FAKE_RELEASE_PAGES: JSON.stringify([fullPage("2026-09-12T00:00:00Z"), [release(TAG, true, COMMIT_DATE)]]) }, /draft GitHub Release for android-v1\.0-260860839 exists/u],
    [{ FAKE_RELEASE_PAGES: "502" }, /Could not list draft releases/u],
    [{ FAKE_COMMIT_DATE: "502" }, /Could not read the commit date/u],
    [{ FAKE_COMMIT_DATE: JSON.stringify({ commit: { author: { date: "yesterday" }, committer: { date: "yesterday" } } }) }, /Unexpected commit date/u],
  ];
  for (const [fake, error] of cases) {
    const result = run(["recheck", TAG, COMMIT], fake);
    assert.equal(result.status, 1, JSON.stringify(fake));
    assert.match(result.stderr, error, JSON.stringify(fake));
    assert.match(result.stderr, /^::error::/mu);
  }
});

test("the draft scan stops at the first page older than the source commit instead of listing every release", () => {
  const pageCalls = (result) => result.calls.filter((call) => call.includes("/releases?")).map((call) => call.split(" ")[1]);
  // Page 2 is entirely older than the commit: no draft for this tag can be on page 3+.
  const old = run(["recheck", TAG, COMMIT], {
    FAKE_RELEASE_PAGES: JSON.stringify([
      fullPage("2026-09-15T00:00:00Z"),
      fullPage("2026-01-01T00:00:00Z"),
      fullPage("2025-01-01T00:00:00Z", TAG),
    ]),
  });
  assert.equal(old.status, 0, old.stderr);
  assert.deepEqual(pageCalls(old), [
    "repos/instafy-dev/instafy/releases?per_page=100&page=1",
    "repos/instafy-dev/instafy/releases?per_page=100&page=2",
  ]);
  // The earlier of author/committer date bounds the scan (rebased commits keep an old author date).
  const rebased = run(["recheck", TAG, COMMIT], {
    FAKE_COMMIT_DATE: JSON.stringify({ commit: { author: { date: "2025-06-01T00:00:00Z" }, committer: { date: COMMIT_DATE } } }),
    FAKE_RELEASE_PAGES: JSON.stringify([
      fullPage("2026-09-15T00:00:00Z"),
      fullPage("2026-01-01T00:00:00Z"),
      fullPage("2025-07-01T00:00:00Z", TAG),
    ]),
  });
  assert.equal(rebased.status, 1);
  assert.match(rebased.stderr, /draft GitHub Release for android-v1\.0-260860839 exists/u);
  assert.equal(pageCalls(rebased).length, 3);
});

test("recheck keeps its working variables local", () => {
  const script = fs.readFileSync(SCRIPT, "utf8");
  for (const body of script.split(/^[a-z_]+\(\) \{$/mu).slice(1)) {
    const declared = new Set((body.match(/^ {2}local ([^\n]+)$/mu)?.[1] ?? "").split(/\s+/u));
    for (const [, name] of body.matchAll(/^\s+([a-z_]+)="\$\(/gmu)) {
      assert.ok(declared.has(name), `${name} is assigned without local`);
    }
  }
});

test("rejects malformed arguments before any API call", () => {
  for (const args of [["recheck", "ios-v1.0-81", COMMIT], ["recheck", TAG, "short"], ["recheck", TAG], ["delete", TAG]]) {
    const result = run(args, {});
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  }
});
