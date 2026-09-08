import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../../../services/runtimeController/activity";
import { teamActivity, teamWorkHref, teamWorkStatus } from "../teamActivity";

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return { id: "1", kind: "run.finished", at: "2026-09-08T06:00:00Z",
    org: { id: "team-a", name: "A" }, project: { id: "space-a", name: "Work" },
    conversation: { id: "thread-a", title: "Fix", visibility: "shared", threadKind: "automation" },
    run: { id: "run-a", status: "success", promptId: "prompt-a" },
    actor: { kind: "agent", userId: "member-a", displayName: "Octo", handle: "octo", avatarSeed: null },
    title: "Fix", preview: "Stopped because evidence was unavailable.", needsYou: false,
    live: false, seen: false, data: {}, ...overrides };
}

describe("team activity", () => {
  it("keeps only the selected team's authorized, navigable work", () => {
    const own = item();
    expect(teamActivity([own, item({ id: "2", org: { id: "team-b", name: "B" } }), item({ id: "3", org: null }), item({ id: "4", conversation: null })], "team-a")).toEqual([own]);
    expect(teamActivity([own], null)).toEqual([]);
  });
  it("uses the newest event for a run before prioritizing current work", () => {
    const done = item({ id: "3", at: "2026-09-08T06:10:00Z" });
    const old = item({ live: true, run: { id: "run-a", status: "running", promptId: null } });
    const running = item({ id: "2", run: { id: "run-b", status: "running", promptId: null }, live: true });
    expect(teamActivity([old, done, running], "team-a")).toEqual([running, done]);
  });
  it("never equates a completed turn with a successful fix or parses prose into status", () => {
    expect(teamWorkStatus(item())).toBe("Turn completed");
    expect(teamWorkStatus(item({ run: null, preview: "success failed blocked running" }))).toBe("Update");
    expect(teamWorkStatus(item({ needsYou: true }))).toBe("Needs attention");
    expect(teamWorkStatus(item({ run: { id: "r", status: "failed", promptId: null } }))).toBe("Run failed");
  });
  it("links the correct space and controller conversation without carrying another chat or settings route", () => {
    const url = new URL(teamWorkHref(item())!, "https://example.test");
    expect([...url.searchParams.entries()]).toEqual([["projectId", "space-a"], ["conversationControllerId", "thread-a"], ["panel", "chat"]]);
    expect(teamWorkHref(item({ project: null }))).toBeNull();
  });
});
