// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createInitialConversation } from "../../conversations/conversationState";
import { organizationChatId, useOrganizationChatTabs } from "../useOrganizationChatTabs";
import { type WorkspaceTabState } from "../workspaceTabFactories";

type Props = Parameters<typeof useOrganizationChatTabs>[0];
const chat = (title = "Same chat") => ({ ...createInitialConversation({ localId: "same" }), title, controllerId: "remote" });
const tab = () => ({ id: "conversation:same", kind: "conversation", conversationId: "same", title: "Same chat", preview: true, closable: true, dirty: false, draggable: true, badge: null }) as WorkspaceTabState;
const projects = [{ id: "a", name: "Autofix", orgId: "one" }, { id: "b", name: "Design", orgId: "one" }, { id: "c", name: "Private", orgId: "two" }];
let props: Props, result: ReturnType<typeof useOrganizationChatTabs>, root: Root, node: HTMLDivElement;
function Probe() { result = useOrganizationChatTabs(props); return null; }
const render = () => act(async () => root.render(<Probe />));
const ids = () => result.tabs.map(tab => tab.id);
const visit = async (projectId: string, orgKey = "one") => { props = { ...props, projectId, orgKey, tabs: [tab()], conversations: [chat()], activeTab: tab(), ready: true }; await render(); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear(); node = document.createElement("div"); root = createRoot(node);
  props = { userId: "user", orgKey: "one", projects, projectId: "a", ready: true, tabs: [tab()], conversations: [chat()], activeTab: tab() };
});
afterEach(async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("retains distinct same-ID chats across spaces and filters by the current organization", async () => {
  await render(); await visit("b");
  expect(ids()).toEqual([organizationChatId("a", "same"), organizationChatId("b", "same")]);
  expect(result.tabs.map(tab => tab.spaceName)).toEqual(["Autofix", "Design"]);
  await visit("c", "two"); expect(ids()).toEqual([organizationChatId("c", "same")]);
  await visit("a"); expect(ids()).toHaveLength(2);
});
it("does not overwrite references with an old or incomplete destination history", async () => {
  await render(); await visit("b");
  props = { ...props, projectId: "a", ready: false, tabs: [], conversations: [] }; await render();
  expect(ids()).toHaveLength(2);
  props = { ...props, ready: true, tabs: [tab()], conversations: [chat("Renamed")] }; await render();
  expect(result.tabs[0].title).toBe("Renamed");
  props = { ...props, tabs: [] }; await render(); expect(ids()).toEqual([organizationChatId("b", "same")]);
});
it("keeps and closes background references, retaining per-user references through remount", async () => {
  await render(); await visit("b");
  await act(async () => result.updateInactive(result.tabs[0], "keep"));
  expect(result.tabs[0].preview).toBe(false);
  await act(async () => root.unmount()); root = createRoot(node); await render();
  expect(ids()).toHaveLength(2); expect(result.tabs[0].preview).toBe(false);
  await act(async () => result.updateInactive(result.tabs[0], "close")); expect(ids()).toEqual([organizationChatId("b", "same")]);
  props = { ...props, userId: "different", ready: false }; await render(); expect(result.tabs).toEqual([]);
  props = { ...props, userId: "user" }; await render(); expect(ids()).toEqual([organizationChatId("b", "same")]);
});
it("hides inaccessible or moved spaces and does not retain a deleted chat", async () => {
  await render(); await visit("b");
  props = { ...props, projects: projects.filter(item => item.id !== "a") }; await render(); expect(ids()).toEqual([organizationChatId("b", "same")]);
  props = { ...props, projects: projects.map(item => item.id === "a" ? { ...item, orgId: "two" } : item), orgKey: "two", ready: false }; await render(); expect(result.tabs).toEqual([]);
  props = { ...props, orgKey: "one", ready: true, conversations: [{ ...chat(), lifecycleStatus: "deleted" }] }; await render(); expect(result.tabs).toEqual([]);
});
it("remembers only matching owned views, and clears a view when Chat is explicitly selected", async () => {
  props.activeTab = { id: "diff-a", kind: "gitDiff", workspaceOwner: { userId: "user", projectId: "a", conversationId: "same" } } as WorkspaceTabState;
  await render(); expect(result.tabs[0].viewTabId).toBe("diff-a");
  await visit("b"); expect(result.tabs[0].viewTabId).toBe("diff-a"); expect(result.tabs[1].viewTabId).toBeUndefined();
  await visit("a"); expect(result.tabs[0].viewTabId).toBeUndefined();
});
it("recovers from malformed session storage without trusting stored IDs or extra data", async () => {
  await act(async () => root.unmount()); root = createRoot(node);
  sessionStorage.setItem("instafy:organization-chat-tabs:v1:user", JSON.stringify({ a: [{ id: "bad", projectId: "a", orgKey: "one", conversationId: "same", title: "Saved", content: "not a navigation reference" }, null] }));
  props.ready = false; await render();
  expect(ids()).toEqual([organizationChatId("a", "same")]); expect(JSON.stringify(result.tabs)).not.toContain("content");
});
