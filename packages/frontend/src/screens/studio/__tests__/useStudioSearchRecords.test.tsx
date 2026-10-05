// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerProjectConversation, ControllerProjectSummary } from "../../../sdk/instafy";
import type { ProjectListItem } from "../../../projects/useProjects";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../../../projects/projectAccessEvents";
import { useStudioSearchRecords, type StudioSearchRecordsOptions } from "../useStudioSearchRecords";
import type { ControllerMessageSearchMatch, ControllerMessageSearchPage } from "@instafy/sdk/conversation-search";
import { ControllerMessageSearchError } from "../../../services/runtimeController/messageSearch";

const { discover, listChats, searchMessages } = vi.hoisted(() => ({ discover: vi.fn(), listChats: vi.fn(), searchMessages: vi.fn() }));
vi.mock("../../../sdk/instafy", () => ({ controllerClient: { projects: { listResult: discover }, conversations: { listForProject: listChats }, search: { messages: searchMessages } } }));

const project = (id: string, orgId: string | null = "team-a"): ControllerProjectSummary => ({ projectId: id, projectName: id, orgId, orgName: orgId ?? "Personal" });
const chat = (id: string, projectId = "space-a", metadata: Record<string, unknown> = { title: id }): ControllerProjectConversation => ({
  id, projectId, metadata, sessionId: null, createdBy: "viewer", createdAt: "2026-09-01", updatedAt: "2026-09-02",
});
function knownProject(id: string, paths: Array<{ path: string; kind?: "file" | "directory" | "other" }>): ProjectListItem {
  return { id, state: { code: { files: paths.map((file, index) => ({ id: `file-${index}`, ...file, generated: "content must not be indexed", modified: "private draft" })) } } } as ProjectListItem;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
const messageMatch = (messageId = "message-1", overrides: Partial<ControllerMessageSearchMatch> = {}): ControllerMessageSearchMatch => ({
  messageId, conversationId: "remote-space-a", projectId: "space-a", orgId: "team-a", projectName: "Core", orgName: "Team",
  conversationTitle: "Repair navigation", role: "user", createdAt: "2026-09-10T10:00:00Z",
  snippet: "Please fix this search", matchRanges: [{ start: 16, end: 22 }], ...overrides,
});
const messagePage = (matches = [messageMatch()], nextCursor: string | null = null): ControllerMessageSearchPage => ({ matches, nextCursor, hasMore: Boolean(nextCursor) });

describe("useStudioSearchRecords", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useStudioSearchRecords>;
  let options: StudioSearchRecordsOptions;
  let renders: string[][];
  function Harness() {
    current = useStudioSearchRecords(options);
    renders.push(current.records.map((record) => record.id));
    return <div>{current.records.map((record) => record.title).join(",")}</div>;
  }
  async function render(patch: Partial<StudioSearchRecordsOptions> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    discover.mockResolvedValue({ status: "success", projects: [project("space-a"), project("space-b", "team-b")] });
    listChats.mockImplementation(async ({ projectId }) => [chat(`remote-${projectId}`, projectId)]);
    searchMessages.mockResolvedValue(messagePage());
    options = { viewerUserId: "viewer", enabled: true, scope: "space", orgId: "team-a", spaceId: "space-a", projects: [], activeConversations: null, onActivate: vi.fn() };
    renders = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not read or expose records until a signed-in user opens search", async () => {
    await render({ enabled: false, projects: [knownProject("space-a", [{ path: "README.md" }])] });
    expect(discover).not.toHaveBeenCalled();
    expect(current.records).toEqual([]);
    await render({ enabled: true, viewerUserId: null });
    expect(discover).not.toHaveBeenCalled();
    expect(current.loading).toBe(false);
  });

  it("scopes authenticated summary reads to space, team and all spaces without navigating", async () => {
    await render();
    expect(discover).toHaveBeenCalledWith({ orgId: "team-a", signal: expect.any(AbortSignal) });
    expect(listChats.mock.calls.map(([params]) => params.projectId)).toEqual(["space-a"]);
    await render({ scope: "org", orgId: "team-b" });
    expect(current.records.every((record) => record.orgId === "team-b")).toBe(true);
    expect(listChats).toHaveBeenLastCalledWith({ projectId: "space-b", limit: 200, signal: expect.any(AbortSignal) });
    await render({ scope: "all" });
    expect(discover).toHaveBeenLastCalledWith({ signal: expect.any(AbortSignal) });
    expect(current.records.filter((record) => record.group === "Chats")).toHaveLength(2);
    expect(options.onActivate).not.toHaveBeenCalled();
  });

  it("orders initial chat titles across spaces by message activity with timestamp fallbacks", async () => {
    listChats.mockImplementation(async ({ projectId }) => projectId === "space-a" ? [
      { ...chat("older-message", projectId), lastMessageAt: "2026-09-03", updatedAt: "2026-09-14" },
      { ...chat("tie-a", projectId), lastMessageAt: "2026-09-09" },
      { ...chat("unknown", projectId), lastMessageAt: "invalid", updatedAt: "", createdAt: "invalid" },
    ] : [
      { ...chat("recent-message", projectId), lastMessageAt: "2026-09-12" },
      { ...chat("updated-fallback", projectId), lastMessageAt: "invalid", updatedAt: "2026-09-11" },
      { ...chat("created-fallback", projectId), lastMessageAt: null, updatedAt: "invalid", createdAt: "2026-09-10" },
      { ...chat("tie-b", projectId), lastMessageAt: "2026-09-09" },
    ]);
    await render({ scope: "all", activeConversations: { projectId: "space-a", items: [
      { localId: "unsynced", controllerId: null, title: "Just created", createdAt: Date.parse("2026-09-13") },
    ] } });
    expect(searchMessages).not.toHaveBeenCalled();
    expect(current.records.filter((record) => record.group === "Chats").map((record) => record.title)).toEqual([
      "Just created", "recent-message", "updated-fallback", "created-fallback", "tie-a", "tie-b", "older-message", "unknown",
    ]);
    current.records.find((record) => record.title === "recent-message")!.activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: "space-b", conversationId: null, conversationControllerId: "recent-message" });
  });

  it("keeps equal chat activity stable and preserves backend message and non-chat order", async () => {
    listChats.mockImplementation(async ({ projectId }) => [
      { ...chat(`z-${projectId}`, projectId), lastMessageAt: "2026-09-10" },
      { ...chat(`a-${projectId}`, projectId), lastMessageAt: "2026-09-10" },
    ]);
    searchMessages.mockResolvedValue(messagePage([
      messageMatch("z-message", { projectId: "space-b", orgId: "team-b" }),
      messageMatch("a-message"),
    ]));
    await render({ query: "search", scope: "all", projects: [
      knownProject("space-a", [{ path: "a.md" }]), knownProject("space-b", [{ path: "b.md" }]),
    ] });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const chatTitles = () => current.records.filter((record) => record.group === "Chats").map((record) => record.title);
    const otherRecords = () => current.records.filter((record) => record.group !== "Chats").map((record) => record.id);
    expect(chatTitles()).toEqual(["z-space-a", "a-space-a", "z-space-b", "a-space-b"]);
    expect(current.records.filter((record) => record.group === "Messages").map((record) => record.id)).toEqual([
      "message:space-b:remote-space-a:z-message", "message:space-a:remote-space-a:a-message",
    ]);
    const originalOtherOrder = otherRecords();
    // Fresh activity in the later alphabetical space changes only chat ordering.
    listChats.mockImplementation(async ({ projectId }) => [
      { ...chat(`z-${projectId}`, projectId), lastMessageAt: projectId === "space-b" ? "2026-09-11" : "2026-09-10" },
      { ...chat(`a-${projectId}`, projectId), lastMessageAt: "2026-09-10" },
    ]);
    await act(async () => current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(chatTitles()).toEqual(["z-space-b", "z-space-a", "a-space-a", "a-space-b"]);
    expect(otherRecords()).toEqual(originalOtherOrder);
  });

  it("keeps Personal separate from team spaces and ignores an inaccessible cached project", async () => {
    discover.mockResolvedValue({ status: "success", projects: [project("personal", null), project("space-a")] });
    await render({ scope: "org", orgId: "personal", projects: [knownProject("inaccessible", [{ path: "secret.md" }])] });
    expect(listChats.mock.calls.map(([params]) => params.projectId)).toEqual(["personal"]);
    expect(current.records.every((record) => record.orgId === "personal")).toBe(true);
    expect(current.records.some((record) => record.title === "secret.md")).toBe(false);
  });

  it("makes no discovery request while a scoped team or space is unresolved", async () => {
    await render({ scope: "space", orgId: null });
    expect(discover).not.toHaveBeenCalled();
    expect(current.records).toEqual([]);
    await render({ scope: "space", orgId: "team-a", spaceId: null });
    expect(discover).not.toHaveBeenCalled();
    await render({ scope: "org", orgId: null });
    expect(discover).not.toHaveBeenCalled();
    expect(current.loading).toBe(false);
  });

  it("checks a space's actual team even if discovery returns accessible projects from another team", async () => {
    await render({ scope: "space", spaceId: "space-b", orgId: "team-a" });
    expect(listChats).not.toHaveBeenCalled();
    expect(current.records).toEqual([]);
    await render({ orgId: "team-b" });
    expect(listChats).toHaveBeenCalledExactlyOnceWith({ projectId: "space-b", limit: 200, signal: expect.any(AbortSignal) });
  });

  it("uses real known safe file paths without indexing contents or requesting a runtime", async () => {
    await render({ projects: [knownProject("space-a", [
      { path: "src/main.ts" }, { path: "src/main.ts" }, { path: "src\\other.ts" },
      { path: "../secret" }, { path: "/etc/passwd" }, { path: "C:\\secret" }, { path: "src//bad" },
      { path: "src", kind: "directory" }, { path: "socket", kind: "other" },
    ])] });
    const files = current.records.filter((record) => record.group === "Files");
    expect(files.map((record) => record.title)).toEqual(["src/main.ts", "src/other.ts"]);
    expect(JSON.stringify(current.records)).not.toContain("private draft");
    expect(JSON.stringify(current.records)).not.toContain("content must not be indexed");
    files[0].activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "file", projectId: "space-a", path: "src/main.ts", fileId: "file-0" });
    expect(current.notice).toContain("opened file names");
    expect(current.notice).toContain("Unloaded folders and file contents are not included");
  });

  it("adds already-listed unopened files without more I/O and prefers an opened file identity", async () => {
    await render({ projects: [knownProject("space-a", [{ path: "CLAUDE.md" }])] });
    const discoveryCount = discover.mock.calls.length;
    const chatReadCount = listChats.mock.calls.length;
    await render({ knownFiles: [
      { projectId: "space-a", path: "CLAUDE.md", fileId: "CLAUDE.md" },
      { projectId: "space-a", path: "INSTAFY.md", fileId: "INSTAFY.md" },
      { projectId: "space-a", path: "INSTAFY.md", fileId: "duplicate" },
      { projectId: "space-a", path: "../private", fileId: "unsafe" },
      { projectId: "inaccessible", path: "private.md", fileId: "foreign" },
    ] });
    const files = current.records.filter((record) => record.group === "Files");
    expect(files.map((record) => record.title)).toEqual(["CLAUDE.md", "INSTAFY.md"]);
    files[0].activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "file", projectId: "space-a", path: "CLAUDE.md", fileId: "file-0" });
    files[1].activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "file", projectId: "space-a", path: "INSTAFY.md", fileId: "INSTAFY.md", requiresLoad: true });
    expect(discover).toHaveBeenCalledTimes(discoveryCount);
    expect(listChats).toHaveBeenCalledTimes(chatReadCount);
    expect(current.notice).toContain("files already listed in the current space");
  });

  it("deduplicates synchronized chats, preserves new local chats and drops unauthorized cached private chats", async () => {
    listChats.mockResolvedValue([
      chat("remote", "space-a", { title: "Server title", localId: "server-local" }),
      chat("remote", "space-a"), chat("foreign", "other-project"),
    ]);
    await render({ activeConversations: { projectId: "space-a", items: [
      { localId: "local", controllerId: "remote", title: "Edited title" },
      { localId: "unsynced", controllerId: null, title: "New chat" },
      { localId: "private", controllerId: "revoked", title: "Old private chat" },
    ] } });
    const chats = current.records.filter((record) => record.group === "Chats");
    expect(chats.map((record) => record.title)).toEqual(["Edited title", "New chat"]);
    chats[0].activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: "space-a", conversationId: "local", conversationControllerId: "remote" });
  });

  it("routes server chat identities and settings to the exact project or team", async () => {
    listChats.mockResolvedValue([chat("remote", "space-a", { title: "Repair", local_id: "local-id" })]);
    await render();
    current.records.find((record) => record.group === "Chats")!.activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: "space-a", conversationId: "local-id", conversationControllerId: "remote" });
    current.records.find((record) => record.id === "settings:space-a")!.activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "space-panel", projectId: "space-a", panel: "settings" });
    current.records.find((record) => record.id === "org-settings:team-a")!.activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "org-settings", orgId: "team-a" });
  });

  it("respects this viewer's hidden and deleted chats while keeping archived chats searchable", async () => {
    listChats.mockResolvedValue([
      chat("hidden", "space-a", { title: "Hidden chat", instafy_conversation_lifecycle_v1_viewer: "hidden" }),
      chat("deleted", "space-a", { title: "Deleted chat", instafy_conversation_lifecycle_v1_viewer: { status: "deleted" } }),
      chat("archived", "space-a", { title: "Archived chat", instafy_conversation_lifecycle_v1_viewer: "archived" }),
      chat("other-viewer", "space-a", { title: "Visible to me", instafy_conversation_lifecycle_v1_other: "hidden" }),
    ]);
    await render();
    expect(current.records.filter((record) => record.group === "Chats").map((record) => record.title)).toEqual(["Archived chat", "Visible to me"]);
  });

  it("aborts obsolete reads and hides the prior account's rows on the very first render", async () => {
    await render();
    expect(current.records.length).toBeGreaterThan(0);
    const pending = deferred<{ status: "success"; projects: ControllerProjectSummary[] }>();
    discover.mockReturnValueOnce(pending.promise);
    const start = renders.length;
    await render({ viewerUserId: "other-viewer" });
    expect(renders[start]).toEqual([]);
    expect(current.records).toEqual([]);
    const signal = discover.mock.calls.at(-1)![0].signal as AbortSignal;
    await render({ enabled: false });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ status: "success", projects: [project("late")] }));
    expect(current.records).toEqual([]);
    expect(listChats.mock.calls.some(([params]) => params.projectId === "late")).toBe(false);
  });

  it("ignores a late conversation response when the selected team changes", async () => {
    const pending = deferred<ControllerProjectConversation[]>();
    listChats.mockReturnValueOnce(pending.promise);
    await render();
    const oldSignal = listChats.mock.calls[0][0].signal as AbortSignal;
    await render({ scope: "org", orgId: "team-b" });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => pending.resolve([chat("stale-private")]));
    expect(current.records.every((record) => record.orgId === "team-b")).toBe(true);
  });

  it("shows partial failures and retries without using cached chats as a successful fallback", async () => {
    listChats.mockResolvedValueOnce(null);
    await render({ activeConversations: { projectId: "space-a", items: [{ localId: "cached", controllerId: "remote", title: "Cached chat" }] } });
    expect(current.records.some((record) => record.group === "Chats")).toBe(false);
    expect(current.error).toContain("Couldn’t load chats in one space");
    await act(async () => current.retry());
    expect(current.error).toBeNull();
    expect(current.records.some((record) => record.group === "Chats")).toBe(true);
    discover.mockResolvedValueOnce({ status: "error" });
    await act(async () => current.retry());
    expect(current.records).toEqual([]);
    expect(current.error).toContain("Unable to load accessible spaces");
  });

  it("revalidates access on the existing invalidation event and clears revoked results", async () => {
    await render();
    discover.mockResolvedValueOnce({ status: "success", projects: [] });
    const start = renders.length;
    await act(async () => window.dispatchEvent(new Event(PROJECT_ACCESS_REFRESH_EVENT)));
    expect(renders[start]).toEqual([]);
    expect(current.records).toEqual([]);
    expect(current.error).toBeNull();
  });

  it("bounds concurrent reads, project fan-out and titles per space, with explicit coverage", async () => {
    discover.mockResolvedValue({ status: "success", projects: Array.from({ length: 45 }, (_, index) => project(`space-${String(index).padStart(2, "0")}`)) });
    const pending = deferred<ControllerProjectConversation[]>();
    listChats.mockReturnValue(pending.promise);
    await render({ scope: "all" });
    expect(listChats).toHaveBeenCalledTimes(4);
    listChats.mockImplementation(async ({ projectId }) => Array.from({ length: 205 }, (_, index) => chat(`chat-${index}`, projectId)));
    await act(async () => pending.resolve([]));
    expect(listChats).toHaveBeenCalledTimes(40);
    expect(listChats.mock.calls.every(([params]) => params.limit === 200)).toBe(true);
    expect(current.records.filter((record) => record.spaceId === "space-04" && record.group === "Chats")).toHaveLength(200);
    expect(current.notice).toContain("5 more spaces");
    expect(current.loading).toBe(false);
    await act(async () => current.loadMoreSpaces());
    expect(listChats).toHaveBeenCalledTimes(45);
    expect(current.records.filter(record => record.spaceId === "space-44" && record.group === "Chats")).toHaveLength(200);
    expect(current.remainingSpaces).toBe(0);
    expect(current.spacePageCount).toBe(2);
    await render({ enabled: false });
    await render({ enabled: true, restoreSpacePages: 2 });
    expect(listChats).toHaveBeenCalledTimes(90);
    expect(current.remainingSpaces).toBe(0);
    discover.mockResolvedValue({ status: "success", projects: [project("space-00")] });
    await act(async () => current.retry());
    expect(current.records.some(record => record.spaceId === "space-44")).toBe(false);
  });

  it("debounces message search without repeating title discovery and opens the exact message", async () => {
    await render({ query: "se" });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(searchMessages).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(discover).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledExactlyOnceWith({ query: "search", projectId: "space-a", orgId: "team-a", limit: 30, signal: expect.any(AbortSignal) });
    const result = current.records.find((record) => record.group === "Messages")!;
    expect(result.message).toEqual({ excerpt: "Please fix this search", query: "search", matchRanges: [{ start: 16, end: 22 }], authorLabel: "User", createdAt: "2026-09-10T10:00:00Z" });
    result.activate();
    expect(options.onActivate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: "space-a", conversationId: null, conversationControllerId: "remote-space-a", messageId: "message-1" });
    expect(current.messagePageCount).toBe(1);
  });

  it("does not request message bodies for an empty, too-short, or overlong query", async () => {
    await render({ query: "x" });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(searchMessages).not.toHaveBeenCalled();
    await render({ query: "" });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(searchMessages).not.toHaveBeenCalled();
    await render({ query: "x".repeat(201) });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(searchMessages).not.toHaveBeenCalled();
    expect(current.error).toContain("up to 200 characters");
  });

  it("cancels old queries and hides obsolete message results during A → B → A", async () => {
    const late = deferred<ControllerMessageSearchPage>();
    searchMessages.mockReturnValueOnce(late.promise);
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const signal = searchMessages.mock.calls[0][0].signal as AbortSignal;
    await render({ query: "other" });
    await render({ query: "search" });
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(messagePage([messageMatch("obsolete")])));
    expect(current.records.some((record) => record.group === "Messages")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(current.records.some((record) => record.id.endsWith(":message-1"))).toBe(true);
    const start = renders.length;
    await render({ viewerUserId: "another-account" });
    expect(renders[start]).toEqual([]);
    expect(current.records.some((record) => record.group === "Messages")).toBe(false);
  });

  it("passes Personal and all-org scopes to the server and filters mismatched response scope", async () => {
    searchMessages.mockResolvedValue(messagePage([messageMatch("personal", { orgId: null }), messageMatch("wrong-team")]));
    await render({ query: "search", scope: "org", orgId: "personal" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(searchMessages).toHaveBeenLastCalledWith({ query: "search", personal: true, limit: 30, signal: expect.any(AbortSignal) });
    expect(current.records.filter((record) => record.group === "Messages").map((record) => record.orgId)).toEqual(["personal"]);
    await render({ scope: "all" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(searchMessages).toHaveBeenLastCalledWith({ query: "search", limit: 30, signal: expect.any(AbortSignal) });
    expect(current.records.filter((record) => record.group === "Messages")).toHaveLength(2);
  });

  it("loads distinct message pages once and restores their count with fresh authorized reads", async () => {
    searchMessages.mockImplementation(async ({ cursor }) => cursor
      ? messagePage([messageMatch("message-1"), messageMatch("message-2")])
      : messagePage([messageMatch("message-1")], "page-2"));
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(current.hasMoreMessages).toBe(true);
    await act(async () => { current.loadMoreMessages(); current.loadMoreMessages(); });
    expect(searchMessages).toHaveBeenCalledTimes(2);
    expect(current.records.filter((record) => record.group === "Messages")).toHaveLength(2);
    expect(current.messagePageCount).toBe(2);
    expect(current.hasMoreMessages).toBe(false);
    await render({ enabled: false });
    expect(current.records).toEqual([]);
    await render({ enabled: true, restoreMessagePages: 2 });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(searchMessages).toHaveBeenCalledTimes(4);
    expect(current.messagePageCount).toBe(2);
    expect(current.records.filter((record) => record.group === "Messages")).toHaveLength(2);
  });

  it("reports unavailable message search without losing title results, then retries", async () => {
    searchMessages.mockRejectedValueOnce(new ControllerMessageSearchError("Message search is not available on this controller yet.", 404));
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(current.error).toContain("not available on this controller");
    expect(current.records.some((record) => record.group === "Chats")).toBe(true);
    await act(async () => current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(current.error).toBeNull();
    expect(current.records.some((record) => record.group === "Messages")).toBe(true);
  });

  it("clears existing message pages when pagination reports revoked access", async () => {
    searchMessages.mockResolvedValueOnce(messagePage([messageMatch()], "page-2"));
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    searchMessages.mockRejectedValueOnce(new ControllerMessageSearchError("Access changed", 403));
    await act(async () => current.loadMoreMessages());
    expect(current.records.some((record) => record.group === "Messages")).toBe(false);
    expect(current.hasMoreMessages).toBe(false);
    expect(current.error).toContain("Access changed");
  });

  it("invalidates message pages with the existing project access refresh event", async () => {
    await render({ query: "search" });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const signal = searchMessages.mock.calls[0][0].signal as AbortSignal;
    await act(async () => window.dispatchEvent(new Event(PROJECT_ACCESS_REFRESH_EVENT)));
    expect(signal.aborted).toBe(true);
    expect(current.records.some((record) => record.group === "Messages")).toBe(false);
    searchMessages.mockResolvedValueOnce(messagePage([]));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(current.records.some((record) => record.group === "Messages")).toBe(false);
  });
});
