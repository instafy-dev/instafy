import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_BIO_MAX_LENGTH,
  getProjectAgentProfile,
  normalizeAgentBio,
  projectAgentProfilePath,
  type AgentProfileRequest,
} from "../src/agents.ts";

test("bot public profile requests bind exact project and agent IDs and preserve cancellation", async () => {
  const signal = new AbortController().signal;
  const profile = { id: "bot", handle: "build-bot", displayName: "Build bot", avatarSeed: "robot", bio: "I help with builds." };
  const calls: Parameters<AgentProfileRequest>[] = [];
  const result = await getProjectAgentProfile(async (...args) => { calls.push(args); return profile; }, {
    projectId: "space/one?", agentId: "bot/#&", signal,
  });
  assert.deepEqual(calls, [["/projects/space%2Fone%3F/agents/bot%2F%23%26/profile", { method: "GET", signal }]]);
  assert.equal(result, profile);
  assert.equal(projectAgentProfilePath({ projectId: "space", agentId: "bot" }), "/projects/space/agents/bot/profile");
});

test("public bot bios normalize blanks and enforce Unicode codepoint length", () => {
  assert.equal(AGENT_BIO_MAX_LENGTH, 500);
  assert.equal(normalizeAgentBio(null), null);
  assert.equal(normalizeAgentBio(" \n "), null);
  assert.equal(normalizeAgentBio("  Build helper\n"), "Build helper");
  assert.equal(normalizeAgentBio("🤖".repeat(500)), "🤖".repeat(500));
  assert.throws(() => normalizeAgentBio("🤖".repeat(501)), RangeError);
  assert.throws(() => normalizeAgentBio("a\u0301".repeat(251)), RangeError);
});

test("cleared bios and access failures do not become stale public profiles", async () => {
  const profile = { id: "bot", handle: "build-bot", displayName: null, avatarSeed: "robot", bio: null };
  assert.deepEqual(await getProjectAgentProfile(async () => profile, { projectId: "space", agentId: "bot" }), profile);
  for (const failure of [Object.assign(new Error("Forbidden"), { status: 403 }), new DOMException("Aborted", "AbortError")]) {
    await assert.rejects(getProjectAgentProfile(async () => { throw failure; }, { projectId: "space", agentId: "bot" }), error => error === failure);
  }
});
