import { describe, expect, it } from "vitest";
import type { ConversationState } from "../../../conversations/ConversationsProvider";
import type { HomeAttentionEntry } from "../homeAttention";
import type { NotificationInboxItem } from "../../../sdk/instafy";
import type { ActivityItem } from "../../../services/runtimeController/activity";
import {
  buildHomeFeed,
  dayLabelFor,
  formatRelativeTimestamp,
  readHomeLastSeen,
  resolveConversationActor,
  writeHomeLastSeen,
  type HomeFeedRecentConversation,
} from "../homeFeed";

const NOW = Date.parse("2026-09-02T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function inboxItem(overrides: Partial<NotificationInboxItem>): NotificationInboxItem {
  return {
    projectId: "p-acme",
    projectName: "checkout-flow",
    orgId: "org-acme",
    orgName: "Acme Co",
    conversationId: "c-1",
    conversationTitle: "Split checkout",
    lastMessageId: "m-1",
    lastMessageAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastMessagePreview: "Opened fix/checkout-package",
    ...overrides,
  };
}

function inboxEntry(item: NotificationInboxItem): HomeAttentionEntry {
  return {
    key: `inbox-${item.conversationId}`,
    title: item.conversationTitle ?? "New reply",
    subtitle: "",
    meta: null,
    preview: item.lastMessagePreview ?? null,
    kind: "reply",
    source: "inbox",
    inboxItem: item,
    testId: `home-attention-conversation-${item.conversationId}`,
  };
}

function localConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    localId: "local-1",
    title: "Octopus night shift",
    visibility: "shared" as ConversationState["visibility"],
    lifecycleStatus: "active" as ConversationState["lifecycleStatus"],
    controllerId: "c-local-1",
    parentConversationId: null,
    threadKind: null,
    ownerAgent: { id: "agent-octo", handle: "octo" },
    activeGoal: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [
      { id: "m-a", role: "user", content: "go", timestamp: NOW - 5 * HOUR },
      {
        id: "m-b",
        role: "assistant",
        content: "done",
        timestamp: NOW - 4 * HOUR,
        metadata: { agent: { handle: "@Octo", avatarSeed: "seed-octo" } },
      },
    ],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 1,
    createdAt: NOW - 6 * HOUR,
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
  } as ConversationState;
}

const personalProject = { id: "p-personal", name: "Untitled Space", orgId: null, orgName: "Personal" };
const acmeProject = { id: "p-acme", name: "checkout-flow", orgId: "org-acme", orgName: "Acme Co" };

function recent(overrides: Partial<HomeFeedRecentConversation>): HomeFeedRecentConversation {
  return {
    projectId: "p-personal",
    projectName: "Untitled Space",
    orgId: null,
    orgName: "Personal",
    conversationId: "c-r1",
    localConversationId: null,
    title: "Conversation 1",
    preview: null,
    updatedAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("buildHomeFeed", () => {
  it("builds team chips from every team it sees, personal first, with needs-you counts", () => {
    const local = localConversation();
    const model = buildHomeFeed({
      // Production order: the active space's local replies come first, then
      // inbox replies — the feed must reorder by time regardless.
      attentionEntries: [
        {
          key: "reply-local-1",
          title: local.title,
          subtitle: "",
          meta: null,
          preview: "done",
          kind: "reply",
          source: "conversation",
          localConversationId: local.localId,
          testId: "home-attention-conversation-c-local-1",
        },
        inboxEntry(inboxItem({})),
      ],
      recentConversations: [recent({ orgId: "org-fp", orgName: "Fairplanen", projectId: "p-fp", conversationId: "c-fp" })],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [local],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.teams.map((team) => [team.key, team.name, team.needsCount])).toEqual([
      ["personal", "Personal", 1],
      ["org-acme", "Acme Co", 1],
      ["org-fp", "Fairplanen", 0],
    ]);
    expect(model.needs.map((event) => event.team.name)).toEqual(["Acme Co", "Personal"]);
    expect(model.isEmpty).toBe(false);
  });

  it("attaches the agent behind a local conversation and a generic assistant to inbox items", () => {
    const local = localConversation();
    const model = buildHomeFeed({
      attentionEntries: [
        inboxEntry(inboxItem({})),
        {
          key: "reply-local-1",
          title: local.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "reply",
          source: "conversation",
          localConversationId: local.localId,
          testId: "t",
        },
      ],
      recentConversations: [],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [local],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    const [inbox, localEvent] = model.needs;
    expect(inbox.actor).toEqual({ kind: "assistant", handle: null, avatarSeed: null });
    expect(localEvent.actor).toEqual({ kind: "agent", handle: "octo", avatarSeed: "seed-octo" });
  });

  it("orders needs-you like a feed: work in flight first, then the newest reply across teams", () => {
    const local = localConversation();
    const running = localConversation({
      localId: "local-run",
      controllerId: "c-run",
      title: "Nightly build",
      messages: [{ id: "m-r", role: "user", content: "go", timestamp: NOW - 8 * HOUR }],
    });
    const model = buildHomeFeed({
      attentionEntries: [
        {
          key: "reply-local-1",
          title: local.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "reply",
          source: "conversation",
          localConversationId: local.localId,
          testId: "t-reply",
        },
        {
          key: "running-local-run",
          title: running.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "running",
          source: "conversation",
          localConversationId: running.localId,
          testId: "t-run",
        },
        inboxEntry(inboxItem({})),
        inboxEntry(inboxItem({ conversationId: "c-undated", conversationTitle: "Undated", lastMessageAt: "" })),
      ],
      recentConversations: [],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [local, running],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    // Replies only, newest first; the undated one sinks to the bottom.
    expect(model.needs.map((event) => [event.kind, event.team.name])).toEqual([
      ["reply", "Acme Co"],
      ["reply", "Personal"],
      ["reply", "Acme Co"],
    ]);
    expect(model.needs.at(-1)?.title).toBe("Undated");
    // Work in flight is progress, not a demand: it leads Recent as a live group.
    expect(model.activity[0]).toMatchObject({ key: "live", label: "In progress" });
    expect(model.activity[0].events.map((event) => [event.kind, event.lane, event.title])).toEqual([
      ["running", "activity", "Nightly build"],
    ]);
    expect(model.teams.find((team) => team.isPersonal)?.needsCount).toBe(1);
  });

  it("keeps the caught-up cut in place when live rows sit above the dated groups", () => {
    const running = localConversation({
      localId: "local-run",
      controllerId: "c-run",
      title: "Nightly build",
      messages: [{ id: "m-r", role: "user", content: "go", timestamp: NOW - 8 * HOUR }],
    });
    const model = buildHomeFeed({
      attentionEntries: [
        {
          key: "running-local-run",
          title: running.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "running",
          source: "conversation",
          localConversationId: running.localId,
          testId: "t-run",
        },
      ],
      recentConversations: [
        recent({ conversationId: "a", updatedAt: new Date(NOW - HOUR).toISOString() }),
        recent({ conversationId: "b", updatedAt: new Date(NOW - 3 * HOUR).toISOString() }),
      ],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [running],
      teamFilter: "all",
      lastSeenAt: NOW - 2 * HOUR,
      now: NOW,
    });

    const flat = model.activity.flatMap((day) => day.events);
    expect(flat.map((event) => event.kind)).toEqual(["running", "conversation", "conversation"]);
    // Index 2 in the flat list: after the live row and the one new conversation.
    expect(model.sinceCutIndex).toBe(2);
    expect(model.isEmpty).toBe(false);
  });

  it("pins the user's real Personal org first and folds org-less spaces into it", () => {
    const local = localConversation();
    const model = buildHomeFeed({
      attentionEntries: [
        {
          key: "reply-local-1",
          title: local.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "reply",
          source: "conversation",
          localConversationId: local.localId,
          testId: "t",
        },
      ],
      recentConversations: [],
      organizations: [
        { id: "org-dr", name: "Design review" },
        { id: "org-me", name: "Personal team" },
      ],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [local],
      teamFilter: "personal",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.teams.map((team) => [team.key, team.name, team.isPersonal, team.needsCount])).toEqual([
      ["org-me", "Personal", true, 1],
      ["org-acme", "Acme Co", false, 0],
      ["org-dr", "Design review", false, 0],
    ]);
    expect(model.needs[0]?.team.key).toBe("org-me");
    expect(model.teamFilter).toBe("org-me");
    expect(model.needs.length).toBe(1);
  });

  it("tells two different Personal teams apart without touching the null bucket", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [],
      organizations: [
        { id: "org-me", name: "Personal team", slug: "user-624ae065-1cfe-4ea8" },
        { id: "org-them", name: "Personal team", slug: "ada" },
      ],
      projects: [acmeProject],
      activeProject: acmeProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.teams.map((team) => [team.key, team.name, team.isPersonal])).toEqual([
      ["org-me", "Personal • 624ae065", true],
      ["org-them", "Personal • ada", true],
      ["org-acme", "Acme Co", false],
    ]);
  });

  it("filters both lanes by team but keeps chip counts unfiltered, and falls back to all for an unknown team", () => {
    const base = {
      attentionEntries: [inboxEntry(inboxItem({}))],
      recentConversations: [recent({}), recent({ orgId: "org-acme", orgName: "Acme Co", projectId: "p-acme", conversationId: "c-r2" })],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [],
      lastSeenAt: null,
      now: NOW,
    };

    const acme = buildHomeFeed({ ...base, teamFilter: "org-acme" });
    expect(acme.teamFilter).toBe("org-acme");
    expect(acme.needs.length).toBe(1);
    expect(acme.activity.flatMap((day) => day.events).map((event) => event.project.id)).toEqual(["p-acme"]);
    expect(acme.teams.find((team) => team.key === "org-acme")?.needsCount).toBe(1);

    const unknown = buildHomeFeed({ ...base, teamFilter: "org-nope" });
    expect(unknown.teamFilter).toBe("all");
    expect(unknown.activity.flatMap((day) => day.events).length).toBe(2);
  });

  it("does not repeat a conversation that already needs you in the activity lane", () => {
    const model = buildHomeFeed({
      attentionEntries: [inboxEntry(inboxItem({ conversationId: "C-DUP" }))],
      recentConversations: [
        recent({ conversationId: "c-dup", projectId: "p-acme", orgId: "org-acme", orgName: "Acme Co" }),
        recent({ conversationId: "c-other" }),
      ],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.needs.length).toBe(1);
    expect(model.activity.flatMap((day) => day.events).map((event) => event.source.type === "recent" && event.source.recent.conversationId)).toEqual([
      "c-other",
    ]);
  });

  it("groups activity by day and places the since-you-were-here cut before the first seen item", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [
        recent({ conversationId: "a", updatedAt: new Date(NOW - HOUR).toISOString() }),
        recent({ conversationId: "b", updatedAt: new Date(NOW - 3 * HOUR).toISOString() }),
        recent({ conversationId: "c", updatedAt: new Date(NOW - DAY - HOUR).toISOString() }),
        recent({ conversationId: "d", updatedAt: new Date(NOW - 10 * DAY).toISOString() }),
      ],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: NOW - 2 * HOUR,
      now: NOW,
    });

    expect(model.activity.map((day) => [day.label, day.events.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      [dayLabelFor(NOW - 10 * DAY, NOW).label, 1],
    ]);
    const flat = model.activity.flatMap((day) => day.events);
    expect(flat.map((event) => event.isNew)).toEqual([true, false, false, false]);
    expect(model.sinceCutIndex).toBe(1);
  });

  it("omits the cut on a first visit or when nothing is new", () => {
    const base = {
      attentionEntries: [],
      recentConversations: [recent({ conversationId: "a", updatedAt: new Date(NOW - 3 * HOUR).toISOString() })],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      now: NOW,
    };
    expect(buildHomeFeed({ ...base, lastSeenAt: null }).sinceCutIndex).toBeNull();
    expect(buildHomeFeed({ ...base, lastSeenAt: NOW - HOUR }).sinceCutIndex).toBeNull();
  });

  it("lists a team from the membership list even before it has a space", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [],
      organizations: [
        { id: "org-acme", name: "Acme Co" },
        { id: "org-new", name: "Design review" },
      ],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "org-new",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.teams.map((team) => [team.key, team.name])).toEqual([
      ["personal", "Personal"],
      ["org-acme", "Acme Co"],
      ["org-new", "Design review"],
    ]);
    expect(model.teamFilter).toBe("org-new");
    expect(model.isEmpty).toBe(true);
  });

  it("reports an empty feed when nothing is waiting and nothing has happened", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });
    expect(model.isEmpty).toBe(true);
    expect(model.teams).toEqual([{ key: "personal", name: "Personal", isPersonal: true, needsCount: 0 }]);
  });
});

describe("buildHomeFeed with ledger rows", () => {
  function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
    return {
      id: "10",
      kind: "conversation.reply",
      at: new Date(NOW - HOUR).toISOString(),
      project: { id: "p-acme", name: "checkout-flow" },
      org: { id: "org-acme", name: "Acme Co" },
      conversation: { id: "c-server", title: "Split checkout", visibility: "public" },
      run: null,
      actor: { kind: "agent", userId: null, displayName: "Octo", handle: "octo", avatarSeed: "seed-octo" },
      title: "Split checkout",
      preview: "Opened fix/checkout-package",
      needsYou: false,
      live: false,
      seen: false,
      data: {},
      ...overrides,
    };
  }

  it("maps replies, new conversations and run outcomes into Recent with real actors", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [],
      activity: [
        activityItem({ id: "12", kind: "run.failed", at: new Date(NOW - 10 * 60 * 1000).toISOString(), preview: "boom", run: { id: "run-1", status: "failed", promptId: null } }),
        activityItem({ id: "11", kind: "conversation.created", at: new Date(NOW - 30 * 60 * 1000).toISOString(), preview: null, actor: { kind: "user", userId: "u-1", displayName: "Ada Lovelace", handle: null, avatarSeed: null } }),
        activityItem({ id: "10" }),
        activityItem({ id: "9", kind: "member.joined", at: new Date(NOW - 2 * HOUR).toISOString() }),
        activityItem({ id: "8", kind: "run.started", live: false, at: new Date(NOW - 3 * HOUR).toISOString() }),
      ],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    const flat = model.activity.flatMap((day) => day.events);
    expect(flat.map((event) => [event.kind, event.title, event.actor?.kind ?? null])).toEqual([
      ["run_failed", "Split checkout", "agent"],
      ["conversation", "Split checkout", "user"],
      ["reply", "Split checkout", "agent"],
    ]);
    expect(flat[1].actor?.displayName).toBe("Ada Lovelace");
    expect(flat[2].actor).toEqual({ kind: "agent", handle: "octo", avatarSeed: "seed-octo", displayName: "Octo" });
    expect(flat[2].testId).toBe("home-recent-item-10");
    expect(flat[2].team).toEqual({ key: "org-acme", name: "Acme Co" });
    expect(model.teams.map((team) => team.key)).toEqual(["personal", "org-acme"]);
  });

  it("puts live server runs in the In progress group and drops them once the active space knows about them", () => {
    const local = localConversation({
      localId: "local-run",
      controllerId: "c-server",
      messages: [{ id: "m-r", role: "user", content: "go", timestamp: NOW - 8 * HOUR }],
    });
    const model = buildHomeFeed({
      attentionEntries: [
        {
          key: "running-local-run",
          title: local.title,
          subtitle: "",
          meta: null,
          preview: null,
          kind: "running",
          source: "conversation",
          localConversationId: local.localId,
          testId: "t-run",
        },
      ],
      recentConversations: [],
      activity: [
        activityItem({ id: "20", kind: "run.started", live: true, conversation: { id: "c-server", title: "Split checkout", visibility: "public" } }),
        activityItem({ id: "21", kind: "run.started", live: true, conversation: { id: "c-other", title: "Other", visibility: "public" }, title: "Other" }),
      ],
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [local],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });

    expect(model.activity[0]).toMatchObject({ key: "live", label: "In progress" });
    // Newest first: the server row for "Other" (an hour ago) precedes the
    // local run whose last message is eight hours old. The server row for
    // c-server is gone — the active space's own entry already covers it.
    expect(model.activity[0].events.map((event) => [event.kind, event.title])).toEqual([
      ["running", "Other"],
      ["running", local.title],
    ]);
  });

  it("hides a server reply for a conversation that already needs you", () => {
    const model = buildHomeFeed({
      attentionEntries: [inboxEntry(inboxItem({ conversationId: "C-SERVER" }))],
      recentConversations: [],
      activity: [activityItem({ id: "10" })],
      projects: [personalProject, acmeProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });
    expect(model.needs.length).toBe(1);
    expect(model.activity.flatMap((day) => day.events).length).toBe(0);
  });

  it("places the caught-up cut from the server-side event cursor", () => {
    const model = buildHomeFeed({
      attentionEntries: [],
      recentConversations: [],
      activity: [
        activityItem({ id: "6", at: new Date(NOW - HOUR).toISOString(), conversation: { id: "c-6", title: "Six", visibility: "public" }, title: "Six" }),
        activityItem({ id: "4", at: new Date(NOW - 2 * HOUR).toISOString(), conversation: { id: "c-4", title: "Four", visibility: "public" }, title: "Four" }),
      ],
      serverLastSeenEventId: "5",
      projects: [personalProject],
      activeProject: personalProject,
      conversations: [],
      teamFilter: "all",
      lastSeenAt: null,
      now: NOW,
    });
    const flat = model.activity.flatMap((day) => day.events);
    expect(flat.map((event) => event.isNew)).toEqual([true, false]);
    expect(model.sinceCutIndex).toBe(1);
  });
});

describe("helpers", () => {
  it("formats compact relative times", () => {
    expect(formatRelativeTimestamp(NOW - 20 * 1000, NOW)).toBe("just now");
    expect(formatRelativeTimestamp(NOW - 12 * 60 * 1000, NOW)).toBe("12m");
    expect(formatRelativeTimestamp(NOW - 5 * HOUR, NOW)).toBe("5h");
    expect(formatRelativeTimestamp(NOW - 3 * DAY, NOW)).toBe("3d");
    expect(formatRelativeTimestamp(null, NOW)).toBeNull();
  });

  it("resolves the actor from the latest assistant message, then the owner agent", () => {
    expect(resolveConversationActor(localConversation())).toEqual({
      kind: "agent",
      handle: "octo",
      avatarSeed: "seed-octo",
    });
    expect(
      resolveConversationActor(
        localConversation({
          messages: [{ id: "m", role: "assistant", content: "x", timestamp: NOW }],
          ownerAgent: { id: null, handle: "@Ada" },
        }),
      ),
    ).toEqual({ kind: "agent", handle: "ada", avatarSeed: null });
    expect(
      resolveConversationActor(
        localConversation({ messages: [{ id: "m", role: "user", content: "x", timestamp: NOW }], ownerAgent: null }),
      ),
    ).toBeNull();
  });

  it("persists the last-seen cut per user and survives a broken storage", () => {
    const storage = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    };
    try {
      expect(readHomeLastSeen("Me@Example.com")).toBeNull();
      writeHomeLastSeen("Me@Example.com", NOW);
      expect(readHomeLastSeen("me@example.com")).toBe(NOW);
      expect(readHomeLastSeen("other@example.com")).toBeNull();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }

    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    };
    try {
      expect(() => writeHomeLastSeen("x", NOW)).not.toThrow();
      expect(readHomeLastSeen("x")).toBeNull();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
