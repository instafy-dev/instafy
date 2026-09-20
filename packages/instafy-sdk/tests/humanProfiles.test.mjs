import assert from "node:assert/strict";
import test from "node:test";
import { getProjectMemberProfile, projectMemberProfilePath, PROFILE_BIO_MAX_LENGTH } from "../src/humanProfiles.ts";

test("member profiles bind both IDs to one exact path and leave credentials to the transport", async () => {
  const signal = new AbortController().signal;
  const profile = { userId: "target", displayName: "Alex Reader", avatarUrl: null, bio: "I work on the editor." };
  const calls = [];
  const result = await getProjectMemberProfile(async (...args) => { calls.push(args); return profile; }, {
    projectId: "space/one?", userId: "person/#&", signal,
  });
  assert.deepEqual(calls, [["/projects/space%2Fone%3F/members/person%2F%23%26/profile", { method: "GET", signal }]]);
  assert.equal(result, profile);
  assert.equal(PROFILE_BIO_MAX_LENGTH, 500);
  assert.equal(projectMemberProfilePath({ projectId: "space", userId: "target" }), "/projects/space/members/target/profile");
});

test("explicitly cleared public values remain cleared", async () => {
  const result = await getProjectMemberProfile(async () => ({ userId: "target", displayName: null, avatarUrl: null, bio: null }), {
    projectId: "space", userId: "target",
  });
  assert.deepEqual(result, { userId: "target", displayName: null, avatarUrl: null, bio: null });
});

test("denied, revoked, and aborted profile requests propagate instead of becoming empty profiles", async () => {
  for (const failure of [Object.assign(new Error("Forbidden"), { status: 403 }), Object.assign(new Error("Revoked"), { status: 403 }), new DOMException("Aborted", "AbortError")]) {
    await assert.rejects(getProjectMemberProfile(async () => { throw failure; }, { projectId: "space", userId: "target" }), error => error === failure);
  }
});
