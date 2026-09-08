import { expect, test, type Page, type Route } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDS = {
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
  C: "33333333-3333-4333-8333-333333333333",
  D: "44444444-4444-4444-8444-444444444444",
};

/** Real Router, tab provider, routing, visit snapshots and overlay coordinator;
 * only authentication/project/conversation data and transcript rows are inert. */
async function mountWorkspace(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const body = await (await page.request.get("/src/router.tsx")).text();
  const router = body.match(/["'](\/node_modules\/\.vite[^/]*\/deps\/react-router-dom\.js\?v=[^"']+)["']/)?.[1];
  if (!router) throw new Error("Router dependency was not optimized");
  const stateModule = `
    import ReactNS from "${deps.react}";
    export const React = ReactNS.default ?? ReactNS, h = React.createElement;
    export const State = React.createContext(null), noop = () => {};
    export const project = ${JSON.stringify(PROJECT)}, secondProject = ${JSON.stringify(SECOND_PROJECT)}, ids = ${JSON.stringify(IDS)};
    export const conversations = Object.entries(ids).map(([localId, controllerId]) => ({
      localId, controllerId, title: 'Chat '+localId, lifecycleStatus: 'active', unreadCount: 0,
      messages: [{id:'message-'+localId,role:'assistant',content:'Fixture',timestamp:1}],
      draft: '', pendingRunIds: [], awaitingLeaseRunIds: [], runs: [], createdAt: 1, updatedAt: 1,
    }));
    const workspace = { files: [] };
    export const useCode = () => ({ workspace, setActiveFile: noop });
    export const useProject = () => ({ activeProjectId: React.useContext(State).activeProject });
    export const useWorkspaceUi = () => React.useContext(State);
    export const useConversations = () => {
      const state = React.useContext(State);
      return {conversations: state.available, activeConversationId:state.conversation,
        selectConversation:state.setConversation, markConversationRead:state.markConversationRead, createConversation:noop,
        remoteConversationHistoryResolved:state.remoteResolved, projectKey:state.projectKey};
    };`;
  await page.route("**/__history_state__.js", (route) => route.fulfill({ contentType: "application/javascript", body: stateModule }));
  await page.route("**/src/features/applicationFrontendFeatureComposition.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `import { createFrontendApplicationComposition } from '/src/features/frontendApplicationComposition.ts'; import { LOCAL_CORE_ASSISTANT_PROVIDER } from '/src/assistants/coreAssistantProvider.ts'; export const APPLICATION_FRONTEND_FEATURE_COMPOSITION = createFrontendApplicationComposition([{apiVersion:1,id:'fixture.core',assistantProviders:[LOCAL_CORE_ASSISTANT_PROVIDER],capabilityAssistantProviders:[LOCAL_CORE_ASSISTANT_PROVIDER]}]); export const APPLICATION_FRONTEND_FEATURES = APPLICATION_FRONTEND_FEATURE_COMPOSITION.features; export const APPLICATION_FRONTEND_REGISTRATION_INPUTS = APPLICATION_FRONTEND_FEATURE_COMPOSITION.registrations;`,
  }));
  for (const [path, name] of [
    ["/src/code/useCode.ts", "useCode"], ["/src/projects/useProject.ts", "useProject"],
    ["/src/workspace/useWorkspace.ts", "useWorkspaceUi"],
    ["/src/conversations/ConversationsProvider.tsx", "useConversations"],
  ]) {
    await page.route(`**${path}*`, (route) => route.fulfill({ contentType: "application/javascript", body: `export {${name}} from '/__history_state__.js';` }));
  }
  const main = `
    import { React, h, State, noop, project, secondProject, ids, conversations, useConversations, useWorkspaceUi } from '/__history_state__.js';
    import ReactDomNS from '${deps.reactDomClient}';
    import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from '${router}';
    import { WorkspaceTabsProvider, useWorkspaceTabs } from '/src/workspace/WorkspaceTabsProvider.tsx';
    import { conversationsReducer } from '/src/conversations/conversationState.ts';
    import { useStudioLayoutWorkspaceRouting } from '/src/screens/useStudioLayoutWorkspaceRouting.ts';
    import { useStudioLayoutChromeState } from '/src/screens/useStudioLayoutChromeState.ts';
    import { StudioNavigationProvider, useStudioNavigation } from '/src/navigation/useStudioNavigation.ts';
    import { useChatScrollController } from '/src/screens/studio/components/useChatScrollOrchestration.ts';
    import { resolveChatScrollHistoryVisit } from '/src/screens/studio/components/chatScrollHistory.ts';
    import { ChatScrollSnapshotBoundary } from '/src/screens/studio/components/ChatScrollSnapshotBoundary.tsx';
    const {createRoot} = ReactDomNS.default ?? ReactDomNS;
    function Transcript({conversation, job, location, activeProject, projectKey}) {
      const messages = React.useMemo(() => Array.from({length:60},(_,i)=>({id:conversation+'-'+i,role:'assistant',content:'Message '+i,timestamp:i})),[conversation]);
      const historyVisit=resolveChatScrollHistoryVisit({location,userId:'fixture-user',projectId:activeProject,conversationsProjectKey:projectKey,conversationId:conversation,conversationControllerId:ids[conversation],jobThread:job?{conversationId:conversation,jobId:job}:null});
      const scroll=useChatScrollController({activeConversationId:conversation,historyVisit,hasMoreHistory:false,isHistoryLoading:false,messages,loadOlderMessages:noop});
      return h(ChatScrollSnapshotBoundary,{identity:location.key+conversation+(job??''),messages,capture:scroll.recordScrollPosition},
        h('div',{'data-testid':'transcript',ref:scroll.scrollContainerRef,style:{height:300,overflowY:'auto'}},
          h('div',{ref:scroll.handleScrollContentRef},messages.map(message=>h('div',{key:message.id,'data-chat-scroll-message-id':message.id,style:{height:60}},message.id)))));
    }
    function Controls({routing, chrome}) {
      const go=useStudioNavigation(),tabs=useWorkspaceTabs();
      const link=id=>go({kind:'conversation',projectId:project,conversationId:id,conversationControllerId:ids[id]});
      return h('nav',null,
        ...['home','secrets','settings','credits'].map(panel=>h('button',{onClick:()=>routing.handlePanelSelect(panel)},panel)),
        ...['A','B','C'].map(id=>h('button',{onClick:()=>link(id)},'chat '+id)),
        h('button',{onClick:()=>{tabs.requestUrlPush();tabs.openConversationTab('B');}},'legacy B'),
        h('button',{onClick:()=>{tabs.requestUrlPush();link('C');}},'direct with stale intent'),
        h('button',{onClick:()=>{link('B');link('C');}},'rapid B C'),
        h('button',{onClick:()=>go({kind:'conversation',projectId:project,conversationId:'B',conversationControllerId:ids.B,jobId:'job-1'})},'job B'),
        h('button',{onClick:()=>chrome.setMobileSidebarOpen(true)},'sidebar'),
        chrome.mobileSidebarOpen?h('section',{'data-testid':'sidebar'},
          h('output',{'data-testid':'sidebar-view'},chrome.mobileSidebarNavigation.view),
          h('button',{onClick:()=>chrome.mobileSidebarNavigation.openView('workspace')},'spaces'),
          h('button',{onClick:()=>go({kind:'panel',panel:'settings',settingsTab:'profile'})},'profile settings'),
          h('button',{onClick:()=>chrome.setMobileSidebarOpen(false)},'close sidebar')):null);
    }
    function Workspace() {
      const location=useLocation(),navigate=useNavigate(),tabs=useWorkspaceTabs(),state=useWorkspaceUi(),data=useConversations();
      const chrome=useStudioLayoutChromeState({isLargeScreen:false,scopeKey:'fixture-user:'+state.activeProject});
      const tab=tabs.activeTab, job=tab?.kind==='jobThread'?tab.jobId:null;
      const routing=useStudioLayoutWorkspaceRouting({
        activeConversationControllerId:data.conversations.find(c=>c.localId===state.conversation)?.controllerId??null,activeConversationId:state.conversation,activePanel:state.activePanel,activeProjectId:state.activeProject,
        activeWorkspaceGitReviewReturnTabId:null,activeWorkspaceReviewTabId:null,activeWorkspaceTabConversationId:tab?.conversationId??null,
        activeWorkspaceTabId:tab?.id??null,activeWorkspaceTabJobId:job,activeWorkspaceTabKind:tab?.kind??null,activeWorkspaceTabPanel:tab?.panel??null,
        consumeUrlNavigation:tabs.consumeUrlNavigation,peekUrlNavigation:tabs.peekUrlNavigation,requestUrlNavigation:tabs.requestUrlNavigation,
        conversations:data.conversations,conversationsProjectKey:state.projectKey,conversationTabsReady:tabs.conversationTabsReady,focusWorkspaceTab:tabs.focusTab,isLargeScreen:false,leftDrawer:chrome.leftDrawer,
        locationPathname:location.pathname,locationSearch:location.search,locationKey:location.key,locationState:location.state,navigate,
        openConversationTab:tabs.openConversationTab,openJobThreadTab:tabs.openJobThreadTab,openPanelTab:tabs.openPanelTab,
        projectReadyForWorkspace:state.projectReady,restoreGitReviewTab:()=>false,selectConversation:state.setConversation,setConversationControllerId:state.recordControllerWrite,
        setIsProjectLauncherOpen:noop,setLeftDrawer:chrome.setLeftDrawer,setMobileSidebarOpen:chrome.setMobileSidebarOpen,workspaceTabs:tabs.tabs,
      });
      return h(StudioNavigationProvider,{value:chrome.runAfterSidebarClose},
        h(Controls,{routing,chrome}),
        h('button',{onClick:()=>state.setAvailable(conversations.filter(c=>c.localId!=='C'&&c.localId!=='D'))},'unload C'),
        h('button',{onClick:()=>state.setAvailable(conversations.filter(c=>c.localId!=='D'))},'load C'),
        h('button',{onClick:()=>{tabs.openPanelTab('projects');state.setProjectReady(false);state.setActiveProject(secondProject);navigate('/studio?projectId='+secondProject+'&conversationId=D&conversationControllerId='+ids.D);}},'cross-space while loading'),
        h('button',{onClick:()=>{
          // Access resolves before the conversation HTTP response. This is a
          // real empty placeholder, so the provider must suppress its tab.
          state.setRemoteResolved(false);state.setAvailable([{...conversations.find(c=>c.localId==='D'),controllerId:null,messages:[]}]);
          state.setConversation('D');state.setProjectKey(secondProject);state.setProjectReady(true);
          navigate('/studio?projectId='+secondProject+'&conversationId=D',{replace:true});
          fetch('/__history_second_space__.json').then(response=>response.json()).then(rows=>{state.setAvailable(rows);state.setRemoteResolved(true);});
        }},'load second space'),
        // Model delayed project/tab hydration without a user URL intent. The
        // real provider restores Projects while the coarse panel stays chat.
        h('button',{onClick:()=>{tabs.openPanelTab('projects');state.setActivePanel('chat');}},'late Projects tab hydration'),
        h('output',{'data-testid':'state'},JSON.stringify({panel:state.activePanel,conversation:state.conversation,controllerId:data.conversations.find(c=>c.localId===state.conversation)?.controllerId??null,job,tabKind:tab?.kind??null,tabPanel:tab?.panel??null,tabConversation:tab?.conversationId??null,search:location.search,settingsTab:routing.settingsTab,pending:tabs.peekUrlNavigation(),activeProject:state.activeProject,projectKey:state.projectKey,projectReady:state.projectReady,remoteResolved:state.remoteResolved,conversationTabs:tabs.tabs.filter(t=>t.kind==='conversation').map(t=>t.conversationId),available:state.available.map(c=>c.localId),selections:state.selections,controllerWrites:state.controllerWrites})),
        tab?.kind==='conversation'||tab?.kind==='jobThread'?h(Transcript,{conversation:state.conversation,job,location,activeProject:state.activeProject,projectKey:state.projectKey}):h('h1',{'data-testid':'rendered-panel'},tab?.panel??'No active tab'));
    }
    function Fixture() {
      const [activePanel,setActivePanel]=React.useState('chat'),[conversation,applyConversation]=React.useState('A'),[available,setAvailable]=React.useState(conversations.filter(c=>c.localId!=='D'));
      const [activeProject,setActiveProject]=React.useState(project),[projectKey,setProjectKey]=React.useState(project),[projectReady,setProjectReady]=React.useState(true);
      const [remoteResolved,setRemoteResolved]=React.useState(true);
      const [selections,setSelections]=React.useState([]),[controllerWrites,setControllerWrites]=React.useState([]);
      const setConversation=React.useCallback(id=>{setSelections(current=>[...current,id]);applyConversation(id);},[]);
      // Use the real reducer: MARK_READ creates a fresh conversation array,
      // even at unreadCount=0. A no-op would hide provider/routing cycles.
      const markConversationRead=React.useCallback(id=>setAvailable(current=>conversationsReducer({projectKey:project,conversations:current,activeId:null,sequence:1,runMap:{}},{type:'MARK_READ',id}).conversations),[]);
      const recordControllerWrite=React.useCallback((localId,controllerId)=>setControllerWrites(current=>[...current,{localId,controllerId}]),[]);
      return h(State.Provider,{value:{activePanel,setActivePanel,conversation,setConversation,available,setAvailable,activeProject,setActiveProject,projectKey,setProjectKey,projectReady,setProjectReady,remoteResolved,setRemoteResolved,selections,controllerWrites,recordControllerWrite,markConversationRead}},h(WorkspaceTabsProvider,null,h(Workspace)));
    }
    createRoot(document.getElementById('root')).render(h(RouterProvider,{router:createBrowserRouter([{path:'*',element:h(Fixture)}])}));`;
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__history_main__.js"></script>`;
  await page.route("**/__history_main__.js", (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route("**/studio?*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`/studio?projectId=${PROJECT}&conversationId=A&conversationControllerId=${IDS.A}`);
}

async function check(page: Page, panel: string, conversation: keyof typeof IDS, job: string | null = null) {
  await expect.poll(async () => {
    const state = JSON.parse(await page.getByTestId("state").innerText());
    return { panel: state.panel, conversation: state.conversation, controllerId: state.controllerId, job: state.job,
      tabKind: state.tabKind, tabPanel: state.tabPanel,
      tabConversation: panel === "chat" ? state.tabConversation : null, settled: state.search === new URL(page.url()).search && state.pending === null };
  }).toEqual({ panel, conversation, controllerId: IDS[conversation], job, tabKind: panel === "chat" ? job ? "jobThread" : "conversation" : "panel",
    tabPanel: panel === "chat" ? null : panel, tabConversation: panel === "chat" ? conversation : null, settled: true });
  await expect.poll(() => new URL(page.url()).searchParams.get("conversationControllerId")).toBe(IDS[conversation]);
}

for (const width of [1280, 390]) {
  test(`restores exact visits and transcript positions through Back and Forward at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await mountWorkspace(page); await check(page, "chat", "A");
    const scroll = page.getByTestId("transcript");
    await scroll.evaluate((node) => { node.scrollTop = 630; });
    await page.getByRole("button", { name: "chat B", exact: true }).click(); await check(page, "chat", "B");
    await scroll.evaluate((node) => { node.scrollTop = 1250; });
    await page.getByRole("button", { name: "chat A", exact: true }).click(); await check(page, "chat", "A");
    await scroll.evaluate((node) => { node.scrollTop = 2100; });
    await page.goBack(); await check(page, "chat", "B");
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(1250);
    await page.goBack(); await check(page, "chat", "A");
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(630);
    await page.goForward(); await check(page, "chat", "B");
    await page.goForward(); await check(page, "chat", "A");
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(2100);
    await page.getByRole("button", { name: "home", exact: true }).click(); await check(page, "home", "A");
    await page.getByRole("button", { name: "direct with stale intent", exact: true }).click(); await check(page, "chat", "C");
    await page.goBack(); await check(page, "home", "A");
    await page.goBack(); await check(page, "chat", "A");
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(2100);
    expect(errors).toEqual([]);
  });
}

test("collapses mobile sidebar drill-ins before navigating without stale Back loops", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mountWorkspace(page); await check(page, "chat", "A");
  await page.getByRole("button", { name: "sidebar", exact: true }).click();
  await page.getByRole("button", { name: "spaces", exact: true }).click();
  await expect(page.getByTestId("sidebar-view")).toHaveText("workspace");
  await page.goBack(); await expect(page.getByTestId("sidebar-view")).toHaveText("sidebar");
  await page.goForward(); await expect(page.getByTestId("sidebar-view")).toHaveText("workspace");
  await page.getByRole("button", { name: "profile settings", exact: true }).click();
  await check(page, "settings", "A"); await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page.goBack(); await check(page, "chat", "A"); await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page.goForward(); await check(page, "settings", "A"); await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("preserves rapid destinations, legacy tab clicks, jobs and unloaded deep links", async ({ page }) => {
  await mountWorkspace(page); await check(page, "chat", "A");
  await page.getByRole("button", { name: "rapid B C", exact: true }).click(); await check(page, "chat", "C");
  await page.goBack(); await check(page, "chat", "B");
  await page.goBack(); await check(page, "chat", "A");
  await page.getByRole("button", { name: "legacy B", exact: true }).click(); await check(page, "chat", "B");
  await page.goBack(); await check(page, "chat", "A");
  await page.getByRole("button", { name: "job B", exact: true }).click(); await check(page, "chat", "B", "job-1");
  await page.goBack(); await check(page, "chat", "A");
  await page.getByRole("button", { name: "unload C", exact: true }).click();
  await page.getByRole("button", { name: "chat C", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversationControllerId")).toBe(IDS.C);
  await page.getByRole("button", { name: "load C", exact: true }).click(); await check(page, "chat", "C");
  await page.goBack(); await check(page, "chat", "A");
});

test("abandons pending old-space conversations while a new space is loading", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const depthErrors: string[] = []; page.on("console", (message) => {
    if (message.type() === "error" && /maximum update depth|React error #185/i.test(message.text())) depthErrors.push(message.text());
  });
  const secondSpaceResponses: Route[] = [];
  await page.route("**/__history_second_space__.json", (route) => { secondSpaceResponses.push(route); });
  await mountWorkspace(page); await check(page, "chat", "A");
  await page.getByRole("button", { name: "unload C", exact: true }).click();
  await page.getByRole("button", { name: "chat C", exact: true }).click();
  await expect.poll(async () => {
    const state = JSON.parse(await page.getByTestId("state").innerText());
    return state.search === new URL(page.url()).search && new URL(page.url()).searchParams.get("conversationControllerId") === IDS.C;
  }).toBe(true);
  await page.getByRole("button", { name: "cross-space while loading", exact: true }).click();
  await expect.poll(async () => {
    const state = JSON.parse(await page.getByTestId("state").innerText());
    return { project: state.activeProject, projectKey: state.projectKey, ready: state.projectReady,
      routeProject: new URL(page.url()).searchParams.get("projectId"), routeController: new URL(page.url()).searchParams.get("conversationControllerId") };
  }).toEqual({ project: SECOND_PROJECT, projectKey: PROJECT, ready: false, routeProject: SECOND_PROJECT, routeController: IDS.D });
  const beforeLateArrival = JSON.parse(await page.getByTestId("state").innerText());
  // A late old-space response contains the abandoned C. It must not select C
  // or attach its controller ID while access/new-space data is unresolved.
  await page.getByRole("button", { name: "load C", exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.getByTestId("state").innerText()).available).toEqual(["A", "B", "C"]);
  const afterLateArrival = JSON.parse(await page.getByTestId("state").innerText());
  expect(afterLateArrival.selections).toEqual(beforeLateArrival.selections);
  expect(afterLateArrival.controllerWrites).toEqual(beforeLateArrival.controllerWrites);
  expect(afterLateArrival.conversation).not.toBe("C");
  expect(new URL(page.url()).searchParams.get("projectId")).toBe(SECOND_PROJECT);
  expect(new URL(page.url()).searchParams.get("conversationControllerId")).toBe(IDS.D);
  await page.getByRole("button", { name: "load second space", exact: true }).click();
  await expect.poll(() => secondSpaceResponses.length).toBe(1);
  await expect.poll(async () => {
    const state = JSON.parse(await page.getByTestId("state").innerText());
    return { project: state.activeProject, projectKey: state.projectKey, ready: state.projectReady,
      remoteResolved: state.remoteResolved, conversation: state.conversation, controllerId: state.controllerId,
      tabKind: state.tabKind, tabPanel: state.tabPanel, conversationTabs: state.conversationTabs, pending: state.pending };
  }).toEqual({ project: SECOND_PROJECT, projectKey: SECOND_PROJECT, ready: true, remoteResolved: false,
    conversation: "D", controllerId: null, tabKind: "panel", tabPanel: "projects", conversationTabs: [], pending: null });
  const pendingVisit = await page.evaluate(() => ({ url: location.href, key: history.state.key, index: history.state.idx, length: history.length }));
  expect(new URL(pendingVisit.url).searchParams.has("panel")).toBe(false);
  expect(new URL(pendingVisit.url).searchParams.has("conversationControllerId")).toBe(false);
  // Allow repeated passive effects while the genuine HTTP response is held.
  // Neither a placeholder tab nor a route write may race provider suppression.
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0; const next = () => ++frames === 6 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next);
  }));
  expect(errors).toEqual([]); expect(depthErrors).toEqual([]);
  expect(await page.evaluate(() => ({ url: location.href, key: history.state.key, index: history.state.idx, length: history.length }))).toEqual(pendingVisit);
  await secondSpaceResponses[0].fulfill({ json: [{
    localId: "D", controllerId: IDS.D, title: "Chat D", lifecycleStatus: "active", unreadCount: 0,
    messages: [{ id: "message-D", role: "assistant", content: "Fixture", timestamp: 1 }],
    draft: "", pendingRunIds: [], awaitingLeaseRunIds: [], runs: [], createdAt: 1, updatedAt: 1,
  }] });
  await check(page, "chat", "D");
  expect(new URL(page.url()).searchParams.get("projectId")).toBe(SECOND_PROJECT);
  const settled = JSON.parse(await page.getByTestId("state").innerText());
  expect(settled.selections).not.toContain("C");
  expect(settled.controllerWrites).toEqual(beforeLateArrival.controllerWrites);
  const resolvedVisit = await page.evaluate(() => ({ url: location.href, key: history.state.key, index: history.state.idx, length: history.length }));
  // Attaching the fetched controller ID is a canonical REPLACE, not a visit.
  const resolvedVisitKey = await page.evaluate(() => history.state.usr?.instafyVisitKey ?? history.state.key);
  expect({ key: resolvedVisitKey, index: resolvedVisit.index, length: resolvedVisit.length }).toEqual({ key: pendingVisit.key, index: pendingVisit.index, length: pendingVisit.length });
  expect(new URL(resolvedVisit.url).searchParams.has("panel")).toBe(false);
  // A delayed workspace snapshot may restore a retained Projects tab after
  // the implicit chat route was already hydrated. Correct URL/activePanel
  // alone do not prove the conversation is the selected/rendered workspace.
  await page.getByRole("button", { name: "late Projects tab hydration", exact: true }).click();
  await check(page, "chat", "D");
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("rendered-panel")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => ({ url: location.href, key: history.state.key, index: history.state.idx, length: history.length }))).toEqual(resolvedVisit);
  const rendered = JSON.parse(await page.getByTestId("state").innerText());
  const proofPath = testInfo.outputPath("implicit-chat-tab-reconciliation.json");
  await writeFile(proofPath, JSON.stringify({ pendingVisit, visit: resolvedVisit, resolvedVisitKey, panel: rendered.panel, tabKind: rendered.tabKind, tabPanel: rendered.tabPanel, tabConversation: rendered.tabConversation, errors, depthErrors }, null, 2));
  await testInfo.attach("Implicit chat reclaims the actual workspace tab without a new visit", {
    path: proofPath,
    contentType: "application/json",
  });
  expect(errors).toEqual([]); expect(depthErrors).toEqual([]);
});
