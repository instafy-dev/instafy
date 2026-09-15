import { describe, expect, it } from "vitest";
import type { ProductNotification } from "../../../notifications/notificationContract";
import type { ActivityItem } from "../../../services/runtimeController/activity";
import type { ConversationState } from "../../../conversations/ConversationsProvider";
import type { HomeAttentionEntry } from "../homeAttention";
import { buildHomeFeed } from "../homeFeed";
import { getHomeNotificationTarget } from "../homeNotifications";
import type { HomeSupportReport } from "../homeSupportReports";

const PROJECT = "00000001-1111-4111-8111-000000000001";
const OTHER_PROJECT = "00000002-1111-4111-8111-000000000002";
const CONVERSATION = "00000003-1111-4111-8111-000000000003";
const RUN = "00000004-1111-4111-8111-000000000004";
const AUTOMATION = "00000005-1111-4111-8111-000000000005";
const REPORT = "00000006-1111-4111-8111-000000000006";
const OTHER_RESOURCE = "00000007-1111-4111-8111-000000000007";
const NOW = Date.parse("2026-09-12T12:00:00Z");
const project = { id: PROJECT, name: "Autofix", orgId: "workshop", orgName: "Instafy workshop" };
const conversationUrl = `/studio?projectId=${PROJECT}&conversationControllerId=${CONVERSATION}`;

function notification(id: string, overrides: Partial<ProductNotification> = {}): ProductNotification {
  return {
    id, eventName: "conversation.reply", version: 1, category: "conversations",
    resourceType: "conversation", resourceId: CONVERSATION,
    occurredAt: new Date(NOW).toISOString(), title: "Instafy", body: "There is a new reply in your conversation.",
    url: conversationUrl, seenAt: null, readAt: null, archivedAt: null, ...overrides,
  };
}

function inbox(overrides: Partial<HomeAttentionEntry> = {}): HomeAttentionEntry {
  return {
    key: "inbox-conversation", kind: "reply", title: "Release investigation", subtitle: "", meta: null,
    preview: "The webhook retry needs an idempotency key.", source: "inbox", testId: "inbox-row",
    inboxItem: {
      projectId: PROJECT, projectName: project.name, orgId: project.orgId, orgName: project.orgName,
      conversationId: CONVERSATION, conversationTitle: "Release investigation", lastMessageId: "message-1",
      lastMessageAt: new Date(NOW - 1000).toISOString(), lastMessagePreview: "The webhook retry needs an idempotency key.",
    }, ...overrides,
  } as HomeAttentionEntry;
}

function activity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "12", kind: "conversation.reply", at: new Date(NOW - 2000).toISOString(),
    project: { id: PROJECT, name: project.name }, org: { id: project.orgId, name: project.orgName },
    conversation: { id: CONVERSATION, title: "Release investigation", visibility: "shared", threadKind: null },
    run: null, actor: { kind: "agent", userId: null, displayName: "Octo", handle: "octo", avatarSeed: null },
    title: "Release investigation", preview: "Confirmed the duplicate webhook.", needsYou: false,
    live: false, seen: false, data: {}, ...overrides,
  };
}

function build(options: Partial<Parameters<typeof buildHomeFeed>[0]> = {}) {
  return buildHomeFeed({
    attentionEntries: [], recentConversations: [], projects: [project], activeProject: null,
    conversations: [], teamFilter: "all", lastSeenAt: null, now: NOW, ...options,
  });
}

function supportReport(overrides: Partial<HomeSupportReport> = {}): HomeSupportReport {
  return {
    id: REPORT, title: "Missing release output", projectId: PROJECT,
    activityAt: new Date(NOW).toISOString(), supportLastMessageAt: new Date(NOW).toISOString(),
    resolvedAt: null, hasUnreadResolution: false, ...overrides,
  };
}

describe("Home's durable notifications", () => {
  it("merges a conversation's replies and run failure into its rich unread row with exact IDs", () => {
    const reply = notification("reply", { occurredAt: new Date(NOW - 500).toISOString() });
    const failure = notification("failure", { eventName: "run.failed", category: "runs", resourceType: "run", resourceId: RUN });
    const read = notification("read", { readAt: new Date(NOW).toISOString(), occurredAt: new Date(NOW - 1500).toISOString() });
    const model = build({
      attentionEntries: [inbox()], activity: [activity()], notifications: [reply, failure, read, reply],
      recentConversations: [{
        projectId: PROJECT, projectName: project.name, orgId: project.orgId, orgName: project.orgName,
        conversationId: CONVERSATION, localConversationId: null, title: "Release investigation",
        preview: "A recent-chat fallback", updatedAt: new Date(NOW - 3000).toISOString(),
      }],
    });
    expect(model.needs).toHaveLength(1);
    expect(model.needs[0]).toMatchObject({
      title: "Release investigation",
      kind: "run_failed", statusLabel: "Run failed", at: NOW, source: { type: "inbox" },
    });
    expect(model.needs[0].notifications?.map((item) => item.id)).toEqual(["failure", "reply", "read"]);
    expect(model.activity).toEqual([]);
    expect(model.teams[0].needsCount).toBe(1);
  });

  it("matches local attention by controller identity without depending on the activity ledger", () => {
    const local = {
      localId: "device-conversation", controllerId: CONVERSATION.toUpperCase(), title: "Local title",
      messages: [{ role: "assistant", timestamp: NOW - 1000, content: "Detailed local reply" }],
    } as ConversationState;
    const model = build({
      conversations: [local], activeProject: project,
      attentionEntries: [{
        key: "local", kind: "reply", title: "Local title", subtitle: "", meta: null, preview: "Detailed local reply",
        source: "conversation", localConversationId: local.localId, testId: "local",
      }],
      notifications: [notification("one"), notification("two")],
    });
    expect(model.needs).toHaveLength(1);
    expect(model.needs[0]).toMatchObject({ title: "Local title", source: { type: "conversation" } });
    expect(model.needs[0].notifications).toHaveLength(2);
  });

  it("uses read events for Recent and excludes archived events without clearing independent legacy unread", () => {
    const read = notification("read", { readAt: new Date(NOW).toISOString() });
    const archived = notification("archived", { archivedAt: new Date(NOW).toISOString() });
    const model = build({ notifications: [read, archived] });
    expect(model.needs).toEqual([]);
    expect(model.activity.flatMap((day) => day.events)).toMatchObject([
      { kind: "reply", dismissible: false, notifications: [{ id: "read" }] },
    ]);
    expect(build({ notifications: [archived] }).isEmpty).toBe(true);
    expect(build({ notifications: [read], attentionEntries: [inbox()] }).needs).toHaveLength(1);
  });

  it("groups support by report and keeps it account-wide, including on a Personal filter", () => {
    const support = (id: string, report = REPORT) => notification(id, {
      eventName: "support.reply", category: "support", resourceType: "support_report", resourceId: report,
      url: `/studio?supportReportId=${report}`,
    });
    const notifications = [
      support("reply"),
      { ...support("resolved"), eventName: "support.resolved" as const, occurredAt: new Date(NOW + 1000).toISOString() },
      support("other", OTHER_RESOURCE),
    ];
    const projects = [project, { id: OTHER_PROJECT, name: "Personal project", orgId: null, orgName: "Personal" }];
    const model = build({ notifications, projects });
    expect(model.needs).toHaveLength(2);
    expect(model.needs[0]).toMatchObject({
      kind: "support_resolved", title: "Report resolved", team: { key: "all", name: "All teams" }, project: { id: "", name: "" },
    });
    expect(model.needs[0].notifications?.map((item) => item.id)).toEqual(["resolved", "reply"]);
    expect(model.teams.every((team) => team.needsCount === 0)).toBe(true);
    expect(build({ notifications, projects, teamFilter: "personal" }).needs).toEqual([]);
    expect(build({ notifications, projects, teamFilter: project.orgId }).needs).toEqual([]);
  });

  it("includes unread support from before the durable ledger as one account-wide click-to-read row", () => {
    const model = build({ supportReports: [supportReport(), supportReport()] });
    expect(model.needs).toMatchObject([{
      title: "Missing release output", kind: "support_reply", dismissible: false,
      source: { type: "support", report: { id: REPORT } },
      team: { key: "all" }, project: { id: "", name: "" },
    }]);
    expect(model.teams[0].needsCount).toBe(0);
    expect(build({ supportReports: [supportReport()], teamFilter: project.orgId }).needs).toEqual([]);
  });

  it("dedupes covered legacy support into its durable row and uses the report title", () => {
    const durable = notification("support", {
      eventName: "support.reply", category: "support", resourceType: "support_report", resourceId: REPORT,
      url: `/studio?supportReportId=${REPORT}`,
    });
    const model = build({ supportReports: [supportReport()], notifications: [durable] });
    expect(model.needs).toMatchObject([{
      title: "Missing release output", source: { type: "notification" }, notifications: [{ id: "support" }],
    }]);
    const read = build({ supportReports: [supportReport()], notifications: [{ ...durable, readAt: new Date(NOW).toISOString() }] });
    expect(read.needs).toEqual([]);
    expect(read.activity.flatMap(day => day.events)).toHaveLength(1);
    const archived = build({ supportReports: [supportReport()], notifications: [{ ...durable, archivedAt: new Date(NOW).toISOString() }] });
    expect(archived.isEmpty).toBe(true);
  });

  it("a newer legacy support reply stays unread without duplicating its older durable destination", () => {
    const older = notification("support", {
      eventName: "support.resolved", category: "support", resourceType: "support_report", resourceId: REPORT,
      url: `/studio?supportReportId=${REPORT}`, occurredAt: new Date(NOW - 1000).toISOString(),
    });
    for (const item of [older, { ...older, readAt: new Date(NOW).toISOString() }, { ...older, archivedAt: new Date(NOW).toISOString() }]) {
      const model = build({ supportReports: [supportReport()], notifications: [item] });
      expect(model.needs).toMatchObject([{ kind: "support_reply", source: { type: "support" }, dismissible: false }]);
      expect(model.needs).toHaveLength(1);
      expect(model.activity).toEqual([]);
    }
  });

  it("shows the newest support state when a legacy report has both a reply and a resolution", () => {
    const reports = [supportReport({ hasUnreadResolution: true, resolvedAt: new Date(NOW + 1000).toISOString(), activityAt: new Date(NOW + 1000).toISOString() })];
    expect(build({ supportReports: reports }).needs[0]).toMatchObject({ kind: "support_resolved", preview: "Your support report was resolved." });
    expect(build({ supportReports: [{ ...reports[0], supportLastMessageAt: new Date(NOW + 2000).toISOString() }] }).needs[0].kind).toBe("support_reply");
  });

  it("keeps separate automation resources even when they share the same navigation URL", () => {
    const automation = (id: string, resourceId: string) => notification(id, {
      eventName: "automation.completed", category: "automations", resourceType: "automation", resourceId,
      url: `/studio?projectId=${PROJECT}&panel=automations`,
    });
    const model = build({ notifications: [
      automation("first", AUTOMATION), automation("update", AUTOMATION), automation("other", OTHER_RESOURCE),
    ] });
    expect(model.needs).toHaveLength(2);
    expect(model.needs.map((event) => event.notifications?.length).sort()).toEqual([1, 2]);
    expect(model.needs.every((event) => event.kind === "automation_completed")).toBe(true);
    expect(model.teams[0].needsCount).toBe(2);
  });

  it("matches automation ledger metadata by resource without merging an unrelated conversation reply", () => {
    const model = build({
      activity: [
        activity({ id: "13", kind: "automation.failed", conversation: null, title: "Nightly checks", data: { automationId: AUTOMATION } }),
        activity(),
      ],
      notifications: [notification("automation", {
        eventName: "automation.failed", category: "automations", resourceType: "automation", resourceId: AUTOMATION,
      })],
    });
    expect(model.needs).toHaveLength(1);
    expect(model.needs[0]).toMatchObject({ title: "Nightly checks", source: { type: "activity", item: { id: "13" } } });
    expect(model.activity.flatMap((day) => day.events)).toMatchObject([{ source: { type: "activity", item: { id: "12" } } }]);
  });

  it("matches a project-scoped failed run by run ID, but not other runs in that project", () => {
    const runFailure = (id: string, resourceId: string) => notification(id, {
      eventName: "run.failed", category: "runs", resourceType: "run", resourceId,
      url: `/studio?projectId=${PROJECT}`,
    });
    const model = build({
      activity: [activity({ kind: "run.failed", conversation: null, run: { id: RUN, status: "failed", promptId: null }, title: "Build broke" })],
      notifications: [runFailure("one", RUN), runFailure("two", OTHER_RESOURCE)],
    });
    expect(model.needs).toHaveLength(2);
    expect(model.needs.find((event) => event.title === "Build broke")?.notifications?.map((item) => item.id)).toEqual(["one"]);
    expect(model.activity).toEqual([]);
  });

  it("resolves a notification's org from inbox and activity metadata if projects are not loaded", () => {
    const fromInbox = build({ projects: [], attentionEntries: [inbox()], notifications: [notification("reply")] });
    const fromActivity = build({ projects: [], activity: [activity()], notifications: [notification("reply")] });
    for (const model of [fromInbox, fromActivity]) {
      expect(model.needs[0].team).toEqual({ key: project.orgId, name: project.orgName });
      expect(model.needs[0].project).toEqual({ id: PROJECT, name: project.name });
      expect(model.teams).toMatchObject([{ key: project.orgId, needsCount: 1 }]);
    }
  });

  it("leaves unknown project scope in All until metadata resolves, instead of treating it as Personal", () => {
    const notifications = [notification("unknown")];
    const personal = { id: OTHER_PROJECT, name: "Mine", orgId: null, orgName: "Personal" };
    const model = build({ projects: [personal], notifications });
    expect(model.needs[0]).toMatchObject({ team: { key: "all" }, project: { id: PROJECT, name: "" } });
    expect(model.teams).toMatchObject([{ key: "personal", needsCount: 0 }]);
    expect(build({ projects: [personal], notifications, teamFilter: "personal" }).needs).toEqual([]);
    expect(build({ projects: [{ ...personal, id: PROJECT }], notifications, teamFilter: "personal" }).needs).toHaveLength(1);
  });

  it("keeps work in progress visible when that chat also has an unread durable reply", () => {
    const model = build({
      activity: [activity({ kind: "run.started", live: true, run: { id: RUN, status: "running", promptId: null } })],
      notifications: [notification("reply")],
    });
    expect(model.needs).toMatchObject([{ kind: "reply" }]);
    expect(model.activity[0]).toMatchObject({ key: "live", events: [{ kind: "running" }] });
  });

  it("does not let an older failure relabel the latest detailed reply", () => {
    const model = build({ attentionEntries: [inbox()], notifications: [notification("failure", {
      eventName: "run.failed", category: "runs", resourceType: "run", resourceId: RUN,
      occurredAt: new Date(NOW - 5000).toISOString(),
    })] });
    expect(model.needs[0].kind).toBe("reply");
    expect(model.needs[0].statusLabel).toBeUndefined();
  });

  it("uses the latest durable outcome when an older ledger failure has since been resolved", () => {
    const model = build({
      activity: [activity({ kind: "automation.failed", conversation: null, title: "Nightly checks", preview: "The runtime was unavailable.", data: { automationId: AUTOMATION } })],
      notifications: [notification("completed", {
        eventName: "automation.completed", category: "automations", resourceType: "automation", resourceId: AUTOMATION,
        body: "Your automation has finished.",
      })],
    });
    expect(model.needs[0]).toMatchObject({ kind: "automation_completed", title: "Nightly checks", preview: "Your automation has finished." });
    expect(model.needs[0].statusLabel).toBeUndefined();
  });

  it("preserves a detailed failure preview and reason when both ledgers describe the same outcome", () => {
    const model = build({
      activity: [activity({ kind: "automation.failed", conversation: null, title: "Nightly checks", preview: "The runtime was unavailable.", data: { automationId: AUTOMATION, failureCode: "runtime_unavailable" } })],
      notifications: [notification("failed", {
        eventName: "automation.failed", category: "automations", resourceType: "automation", resourceId: AUTOMATION,
        body: "Your automation could not finish.",
      })],
    });
    expect(model.needs[0]).toMatchObject({
      kind: "automation_failed", title: "Nightly checks", preview: "The runtime was unavailable.", statusLabel: "Runtime unavailable",
    });
  });

  it("a newer reply no longer presents the previous failure as the current status", () => {
    const model = build({ activity: [activity({ kind: "run.failed" })], notifications: [notification("reply")] });
    expect(model.needs[0]).toMatchObject({ kind: "reply", title: "Release investigation" });
    expect(model.needs[0].statusLabel).toBeUndefined();
  });

  it("sorts mixed unread destinations newest first, independent of notification input order", () => {
    const model = build({ notifications: [
      notification("support", { eventName: "support.reply", category: "support", resourceId: REPORT, resourceType: "support_report", url: `/studio?supportReportId=${REPORT}`, occurredAt: new Date(NOW - 1000).toISOString() }),
      notification("conversation"),
    ] });
    expect(model.needs.map((event) => event.source.type === "notification" && event.source.item.id)).toEqual(["conversation", "support"]);
  });
});

describe("Home notification destinations", () => {
  it("canonicalizes UUID conversation targets", () => {
    expect(getHomeNotificationTarget(notification("one", { url: conversationUrl.toUpperCase().replace("/STUDIO?PROJECTID=", "/studio?projectId=").replace("&CONVERSATIONCONTROLLERID=", "&conversationControllerId=") }))).toMatchObject({
      key: `conversation:${CONVERSATION}`, kind: "conversation", conversationId: CONVERSATION, projectId: PROJECT,
    });
  });

  it.each(["https://other.example/studio", "//other.example/studio", `${conversationUrl}&controllerUrl=http://localhost`, "/studio?projectId=invalid", "/studio"])(
    "excludes untrusted or non-conversation reply destinations: %s", (url) => {
      expect(getHomeNotificationTarget(notification("bad", { url }))).toBeNull();
      expect(build({ notifications: [notification("bad", { url })] }).isEmpty).toBe(true);
    },
  );
});
