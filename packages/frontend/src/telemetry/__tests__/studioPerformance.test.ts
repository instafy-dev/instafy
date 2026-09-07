import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioPerformanceTracker, studioMessageCountBucket, type StudioPerformanceSample, type StudioVisibleContent } from "../studioPerformance";

const content = (overrides: Partial<StudioVisibleContent> = {}): StudioVisibleContent => ({
  projectId: "project-private", organizationId: "org-private", conversationId: "chat-private",
  messageCount: 400, loading: false, error: false, ...overrides,
});

describe("Studio performance tracker", () => {
  let tracker: ReturnType<typeof createStudioPerformanceTracker>;
  let samples: StudioPerformanceSample[];
  let visible: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    visible = true;
    samples = [];
    tracker = createStudioPerformanceTracker({ now: () => Date.now(), visible: () => visible, viewport: () => "narrow" });
    tracker.subscribe((sample) => samples.push(sample));
  });

  afterEach(() => {
    tracker.clear();
    vi.useRealTimers();
  });

  it.each([
    [-1, "0"], [0, "0"], [1, "1-50"], [50, "1-50"], [51, "51-200"],
    [200, "51-200"], [201, "201-1000"], [1000, "201-1000"], [1001, "1001+"],
  ])("buckets message count %s as %s", (count, bucket) => {
    expect(studioMessageCountBucket(Number(count))).toBe(bucket);
  });

  it("matches all requested destinations, treating personal organization null as an exact scope", () => {
    tracker.begin("organization_switch", { projectId: "personal-project", organizationId: null, conversationId: "personal-chat" });
    const personal = content({ projectId: "personal-project", organizationId: null, conversationId: "personal-chat" });
    for (const other of [
      { ...personal, organizationId: "another-org" },
      { ...personal, projectId: "another-project" },
      { ...personal, conversationId: "another-chat" },
    ]) expect(tracker.observe({ ...other, loading: true })).toBeNull();
    expect(samples).toEqual([]);
    tracker.observe(personal)?.();
    expect(samples).toMatchObject([{ outcome: "ready", loadingShown: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows unspecified organization context while retaining explicit project and conversation matching", () => {
    tracker.beginConversation("project-private", "chat-private");
    expect(tracker.observe(content({ projectId: "other-project" }))).toBeNull();
    tracker.observe(content({ organizationId: null }))?.();
    expect(samples).toMatchObject([{ operation: "conversation_switch", outcome: "ready" }]);
  });

  it("records loading once and waits for committed ready content", () => {
    tracker.beginConversation("project-private", "chat-private");
    expect(tracker.observe(content({ loading: true, messageCount: 0 }))).toBeNull();
    vi.advanceTimersByTime(100);
    const complete = tracker.observe(content());
    expect(samples).toEqual([]);
    vi.advanceTimersByTime(32);
    complete?.();
    complete?.();
    expect(samples).toEqual([{
      version: 1, operation: "conversation_switch", outcome: "ready", durationMs: 132,
      loadingShown: true, messageCountBucket: "201-1000", viewport: "narrow",
    }]);
  });

  it.each([[0, "error"], [12, "ready"]] as const)("reports an error with %s retained messages as %s", (messageCount, outcome) => {
    tracker.begin("studio_startup");
    tracker.observe(content({ messageCount, loading: true, error: true }))?.();
    expect(samples).toMatchObject([{ outcome, loadingShown: true }]);
  });

  it("invalidates completion callbacks when rapidly leaving and returning to the same destination", () => {
    tracker.beginConversation("project-private", "chat-private");
    const stale = tracker.observe(content());
    tracker.beginConversation("project-private", "other-chat");
    tracker.beginConversation("project-private", "chat-private");
    stale?.();
    expect(samples.map((sample) => sample.outcome)).toEqual(["superseded", "superseded"]);
    expect(vi.getTimerCount()).toBe(1);
    tracker.observe(content())?.();
    expect(samples.map((sample) => sample.outcome)).toEqual(["superseded", "superseded", "ready"]);
  });

  it("preserves document startup across project discovery and conversation selection", () => {
    vi.advanceTimersByTime(1_200);
    tracker.begin("studio_startup", {}, 0);
    tracker.beginProject("project-private", "org-private", null);
    tracker.beginConversation("project-private", "chat-private");
    vi.advanceTimersByTime(300);
    tracker.observe(content())?.();
    expect(samples).toMatchObject([{ operation: "studio_startup", outcome: "ready", durationMs: 1_500 }]);
  });

  it("retargets organization discovery without allowing an earlier project's paint to finish it", () => {
    tracker.begin("organization_switch", { organizationId: "org-private" });
    tracker.beginProject("old-project", "org-private", "other-org");
    tracker.beginConversation("old-project", "old-chat");
    const stale = tracker.observe(content({ projectId: "old-project", conversationId: "old-chat" }));
    vi.advanceTimersByTime(100);
    tracker.beginProject("project-private", "org-private", "other-org");
    tracker.beginConversation("project-private", "chat-private");
    stale?.();
    expect(samples).toEqual([]);
    tracker.observe(content())?.();
    expect(samples).toMatchObject([{ operation: "organization_switch", outcome: "ready", durationMs: 100 }]);
  });

  it("does not restart an existing selection when store and tab callbacks repeat it", () => {
    tracker.beginProject("project-private", "org-private", "org-private");
    vi.advanceTimersByTime(200);
    tracker.beginProject("project-private", "org-private", "org-private");
    tracker.beginConversation("project-private", "chat-private");
    tracker.beginConversation("project-private", "chat-private");
    tracker.observe(content())?.();
    expect(samples).toMatchObject([{ operation: "space_switch", durationMs: 200 }]);
    tracker.beginProject("personal-project", null, "org-private");
    tracker.observe(content({ projectId: "personal-project", organizationId: null }))?.();
    expect(samples[1]).toMatchObject({ operation: "organization_switch" });
  });

  it("lets a selected non-chat panel finish a workspace navigation without completing a conversation switch", () => {
    const panel = { projectId: "project-private", organizationId: "org-private", loading: false, error: false };
    tracker.beginProject("project-private", "org-private", null);
    tracker.beginConversation("project-private", "chat-private");
    expect(tracker.observePanel({ ...panel, projectId: "other-project" })).toBeNull();
    expect(tracker.observePanel({ ...panel, organizationId: null })).toBeNull();
    tracker.observePanel(panel)?.();
    expect(samples).toMatchObject([{ operation: "organization_switch", outcome: "ready", messageCountBucket: "0" }]);

    tracker.beginConversation("project-private", "other-chat");
    expect(tracker.observePanel(panel)).toBeNull();
    expect(samples).toHaveLength(1);
    tracker.observe(content({ conversationId: "other-chat" }))?.();
    expect(samples[1]).toMatchObject({ operation: "conversation_switch", outcome: "ready" });
  });

  it("uses the remaining document-start deadline instead of granting another 30 seconds", () => {
    vi.advanceTimersByTime(12_000);
    tracker.begin("studio_startup", {}, 0);
    vi.advanceTimersByTime(17_999);
    expect(samples).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(samples).toMatchObject([{ outcome: "timeout", durationMs: 30_000 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abandons only a chat switch when the selected destination becomes a non-chat panel", () => {
    tracker.beginConversation("project-private", "chat-private");
    const stale = tracker.observe(content());
    tracker.cancelConversation();
    stale?.();
    vi.advanceTimersByTime(30_000);
    expect(samples).toMatchObject([{ operation: "conversation_switch", outcome: "superseded" }]);
    expect(vi.getTimerCount()).toBe(0);
    for (const operation of ["studio_startup", "space_switch", "organization_switch"] as const) {
      tracker.begin(operation, { projectId: "project-private" });
      tracker.cancelConversation();
      tracker.observePanel({ projectId: "project-private", organizationId: "org-private", loading: false, error: false })?.();
      expect(samples.at(-1)).toMatchObject({ operation, outcome: "ready" });
    }
  });

  it("cancels abandoned organization discovery without cancelling a selected destination space", () => {
    tracker.begin("organization_switch", { organizationId: null });
    tracker.cancelOrganizationDiscovery("other-org");
    expect(samples).toEqual([]);
    tracker.cancelOrganizationDiscovery(null);
    vi.advanceTimersByTime(30_000);
    expect(samples).toMatchObject([{ operation: "organization_switch", outcome: "superseded" }]);
    tracker.begin("organization_switch", { organizationId: "org-private" });
    tracker.beginProject("project-private", "org-private", null);
    tracker.cancelOrganizationDiscovery("org-private");
    tracker.observe(content())?.();
    expect(samples[1]).toMatchObject({ operation: "organization_switch", outcome: "ready" });
    tracker.begin("studio_startup");
    tracker.cancelOrganizationDiscovery(null);
    tracker.observe(content())?.();
    expect(samples[2]).toMatchObject({ operation: "studio_startup", outcome: "ready" });
  });

  it("does not start hidden work and reports hidden work at either observation or deadline", () => {
    visible = false;
    tracker.begin("studio_startup");
    expect(vi.getTimerCount()).toBe(0);
    visible = true;
    tracker.begin("studio_startup");
    visible = false;
    expect(tracker.observe(content())).toBeNull();
    expect(samples).toMatchObject([{ outcome: "hidden" }]);
    visible = true;
    tracker.begin("studio_startup");
    const complete = tracker.observe(content());
    visible = false;
    complete?.();
    visible = true;
    tracker.begin("studio_startup");
    visible = false;
    vi.advanceTimersByTime(30_000);
    expect(samples.map((sample) => sample.outcome)).toEqual(["hidden", "hidden", "hidden"]);
  });

  it("cancels once and clears pending work plus replay on account cleanup", () => {
    tracker.begin("studio_startup");
    tracker.cancel();
    tracker.cancel();
    tracker.beginConversation("project-private", "chat-private");
    const stale = tracker.observe(content());
    tracker.clear();
    stale?.();
    vi.advanceTimersByTime(60_000);
    expect(samples).toMatchObject([{ outcome: "superseded" }]);
    expect(vi.getTimerCount()).toBe(0);
    const replay = vi.fn();
    tracker.subscribe(replay, { replay: true });
    expect(replay).not.toHaveBeenCalled();
    tracker.begin("studio_startup");
    tracker.observe(content())?.();
    expect(replay).toHaveBeenCalledOnce();
  });

  it("replays only the latest 32 anonymous immutable samples and isolates broken listeners", () => {
    const broken = vi.fn(() => { throw new Error("observer unavailable"); });
    const stopBroken = tracker.subscribe(broken);
    for (let duration = 1; duration <= 40; duration += 1) {
      tracker.begin("conversation_switch", { projectId: "project-private", organizationId: "org-private", conversationId: "chat-private" });
      vi.advanceTimersByTime(duration);
      tracker.observe(content())?.();
    }
    expect(broken).toHaveBeenCalledTimes(40);
    const replay: StudioPerformanceSample[] = [];
    const stopReplay = tracker.subscribe((sample) => replay.push(sample), { replay: true });
    expect(replay.map((sample) => sample.durationMs)).toEqual(Array.from({ length: 32 }, (_, index) => index + 9));
    expect(Object.keys(replay[0]!).sort()).toEqual(["durationMs", "loadingShown", "messageCountBucket", "operation", "outcome", "version", "viewport"]);
    expect(Object.isFrozen(replay[0])).toBe(true);
    expect(JSON.stringify(replay)).not.toMatch(/project-private|org-private|chat-private/);
    expect(() => tracker.subscribe(broken, { replay: true })).not.toThrow();
    stopReplay();
    stopBroken();
    tracker.begin("studio_startup");
    tracker.observe(content())?.();
    expect(replay).toHaveLength(32);
    expect(broken).toHaveBeenCalledTimes(72);
  });
});
