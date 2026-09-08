import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__mobile_thumb_navigation__";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";
const JOB_B = "44444444-4444-4444-8444-444444444444";
const BROWSER_A = "55555555-5555-4555-8555-555555555555";

/** Production header/dock/sheet, overview policy, Router, persistent history
 * owner and viewport hook. Overview rows are inert typed navigation entries.
 * Authentication/project/conversation data are inert boundaries. The retained
 * input is deliberately synthetic, not a claim about the full Studio composer
 * or a physical platform keyboard. */
async function mountNavigation(page: Page, height: number, bottom: number) {
  const deps = await resolveViteReactDependencies(page);
  const source = await (await page.request.get("/src/router.tsx")).text();
  const router = source.match(/["'](\/node_modules\/\.vite[^/]*\/deps\/react-router-dom\.js\?v=[^"']+)["']/)?.[1];
  if (!router) throw new Error("Router dependency was not optimized");
  await page.addInitScript(({ height, bottom }) => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    document.addEventListener("DOMContentLoaded", () => {
      for (const edge of ["top", "left", "right"]) document.documentElement.style.setProperty(`--instafy-safe-area-inset-${edge}`, "0px");
      document.documentElement.style.setProperty("--instafy-safe-area-inset-bottom", `${bottom}px`);
    });
  }, { height, bottom });
  const state = `
    import ReactNS from '${deps.react}';
    export const React=ReactNS.default??ReactNS, h=React.createElement, State=React.createContext(null);
    export const projects=[{id:'${PROJECT_A}',name:'Alpha space',orgId:'team-a',orgName:'Fixture team A'},
      {id:'${PROJECT_B}',name:'Beta space',orgId:'team-b',orgName:'Fixture team B'}];
    export const chats=[{localId:'A',controllerId:'${CHAT_A}',title:'Alpha chat',lifecycleStatus:'active',createdAt:1},
      {localId:'B',controllerId:'${CHAT_B}',title:'Beta chat',lifecycleStatus:'active',createdAt:2}];
    export const longChats=Array.from({length:60},(_,i)=>({localId:'inert-'+i,controllerId:'33333333-3333-4333-8333-'+String(i).padStart(12,'0'),title:'Inert loaded chat '+String(i+1).padStart(2,'0'),lifecycleStatus:'active',createdAt:60-i}));
    export const useProject=()=>{const s=React.useContext(State);return {activeProjectId:s.project,activeProjectName:projects.find(p=>p.id===s.project).name,projectAccessPending:false,projectAccessBlocked:false};};
    export const useConversations=()=>{const s=React.useContext(State);return {projectKey:s.project,conversations:s.longList?longChats:chats,activeConversationId:s.chat,remoteConversationHistoryResolved:true,remoteConversationHistoryError:null,retryRemoteConversationHistory:()=>{throw Error('Unexpected retry');}};};
    // Beta is discoverable but absent from the local store. Legacy routing is
    // forbidden here: only the production sheet may write the Router URL.
    export const useProjects=()=>{const s=React.useContext(State);return {projectList:[projects[0]],activeProjectId:s.project,createProject:()=>{throw Error('Legacy createProject must not route');},switchProject:()=>{throw Error('Legacy switchProject must not route');}};};
    export const useMergedControllerProjects=()=>({mergedProjects:projects,remoteLoading:false,remoteRefreshing:false,remoteError:null,retryRemoteProjects:()=>{throw Error('Unexpected retry');}});`;
  await page.route("**/__thumb_state__.js", route => route.fulfill({ contentType: "application/javascript", body: state }));
  for (const [path, name] of [
    ["projects/useProject.ts", "useProject"], ["projects/useProjects.ts", "useProjects"],
    ["projects/useMergedControllerProjects.ts", "useMergedControllerProjects"],
    ["conversations/ConversationsProvider.tsx", "useConversations"],
  ]) await page.route(`**/src/${path}*`, route => route.fulfill({ contentType: "application/javascript", body: `export {${name}} from '/__thumb_state__.js';` }));
  // Real notification-center state/lifetime; only its transport and external
  // alert boundaries are inert. No synthetic replacement for the bell's press.
  for (const [path, body] of [
    ["sdk/instafy/index.ts", `const unexpected=()=>{throw Error('Unexpected notification mutation');};export const controllerClient={notifications:{list:async()=>({items:[],nextCursor:null,unreadCount:0,asOf:'2026-01-01T00:00:00Z'}),getPreferences:async()=>({hidePreviews:true,preferences:[]}),updateState:unexpected,readAll:unexpected,savePreferences:unexpected}};`],
    ["status/useStatus.ts", `const noop=()=>{};export const useStatus=()=>({showStatus:noop,hideStatus:noop});`],
    ["notifications/notificationPresentation.ts", `export const NOTIFICATION_RECEIVED_EVENT='fixture:notification';export const claimNotificationPresentation=async()=>false;`],
    ["notifications/assistantMessageNotifications.ts", `export const areMessageNotificationsEnabled=()=>false,isAppInForeground=()=>false,enableMessageNotifications=async()=>false,notifyAssistantMessage=async()=>false;`],
  ]) await page.route(`**/src/${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  const main = `
    import '/src/styles/tailwind.css';
    import {React,h,State,projects,chats} from '/__thumb_state__.js';
    import ReactDomNS from '${deps.reactDomClient}';
    import {createBrowserRouter,RouterProvider,useLocation} from '${router}';
    import {useStudioHistory} from '/src/navigation/useStudioHistory.ts';
    import {useStudioNavigation} from '/src/navigation/useStudioNavigation.ts';
    import {useStudioViewportState} from '/src/screens/useStudioViewportState.ts';
    import {useNotificationCenter} from '/src/notifications/useNotificationCenter.tsx';
    import {resolveMobileOverviewSection,useStudioNavigationPosture} from '/src/screens/studio/useStudioNavigationPosture.ts';
    import {MobileBottomDock} from '/src/screens/studio/components/MobileBottomDock.tsx';
    import {MobileStudioNavigationHeader} from '/src/screens/studio/components/MobileStudioNavigationHeader.tsx';
    import {MobileNavigationSheet} from '/src/screens/studio/components/MobileNavigationSheet.tsx';
    const {createRoot}=ReactDomNS.default??ReactDomNS;
    function Fixture(){
      const location=useLocation(),go=useStudioNavigation();
      const history=useStudioHistory(),viewport=useStudioViewportState({trackKeyboard:true}),posture=useStudioNavigationPosture();
      const notificationNavigate=React.useCallback(()=>{throw Error('No notification navigation in fixture');},[]);
      const notifications=useNotificationCenter({userId:'fixture-user',accessToken:'inert-fixture-token',navigate:notificationNavigate});
      const [section,setSection]=React.useState(null),[draft,setDraft]=React.useState(''),[longList,setLongList]=React.useState(false);
      const params=new URLSearchParams(location.search),project=params.get('projectId')??'${PROJECT_A}',chat=params.get('conversationId'),panel=params.get('panel')??'chat';
      const drawer=params.get('workspaceTab'),job=params.get('jobId');
      const activeTab=panel==='chat'?{kind:job?'jobThread':'conversation',conversationId:chat,jobId:job}:panel==='code'?{kind:'file',panel:'code',fileId:'inert',filePath:'/inert.txt'}:{kind:'panel',panel};
      const overview=resolveMobileOverviewSection(activeTab,drawer);
      const openChats=()=>go({kind:'panel',panel:'chat',workspaceTab:'history'});
      React.useEffect(()=>setSection(null),[location.key]);
      const close=()=>setSection(null);
      return h(State.Provider,{value:{project,chat,longList}},
        h('main',{'data-testid':'thumb-shell','data-keyboard-open':viewport.keyboardOpen,
          style:{height:viewport.viewportHeightPx??'100dvh',display:'flex',flexDirection:'column',overflow:'hidden'}},
          h(MobileStudioNavigationHeader,{key:location.key+'|'+project,history,title:overview==='home'?'Home':overview==='chat'?'Chats':overview==='projects'?'Spaces':chat==='B'?'Beta chat':'Alpha chat',
            spaceName:projects.find(p=>p.id===project).name,onOpenPicker:()=>setSection('chats'),onOpenChats:openChats,
            onOpenSettings:()=>go({kind:'panel',panel:'settings'}),notificationBell:notifications.bell}),
          h('div',{style:{flex:1,minHeight:0,overflow:'auto',padding:16}},
            h('h1',{style:{fontSize:18}},'Inert thumb-navigation fixture'),
            h('output',{'data-testid':'thumb-destination'},overview==='home'?'Home':overview==='chat'?'Chats overview':overview==='projects'?'Spaces overview':(chat??'No selected chat')+' / '+project),
            h('p',null,'Production navigation; synthetic retained input below.'),
            overview==='chat'?chats.map(c=>h('button',{key:c.localId,onClick:()=>go({kind:'conversation',projectId:project,conversationId:c.localId,conversationControllerId:c.controllerId})},'Open inert '+c.title)):null,
            overview==='projects'?projects.map(p=>h('button',{key:p.id,onClick:()=>go({kind:'conversation',projectId:p.id})},'Open inert '+p.name)):null,
            h('button',{onClick:()=>setLongList(true)},'Load inert long chat list'),
            h('button',{onClick:()=>go({kind:'conversation',projectId:project,conversationId:'B',conversationControllerId:'${CHAT_B}',jobId:'${JOB_B}'})},'Open inert Chat B job')),
          h('label',{style:{display:'block',padding:12}},'Synthetic retained draft',
            h('input',{'aria-label':'Synthetic retained draft',value:draft,onChange:e=>setDraft(e.target.value),style:{display:'block',width:'100%',minHeight:48,border:'1px solid #64748b'}})),
          posture.showTouchBottomDock&&overview&&!viewport.keyboardOpen?h(MobileBottomDock,{activeSlot:overview,homeAttentionCount:2,
            onHomePress:()=>go({kind:'panel',panel:'home'}),onChatPress:openChats,onProjectsPress:()=>go({kind:'panel',panel:'projects'})}):null),
        section?h(MobileNavigationSheet,{section,onSectionChange:setSection,onClose:close,history,keyboardOpen:viewport.keyboardOpen,
          onNewChat:()=>{throw Error('No chat allocation in fixture');},onOpenFiles:()=>go({kind:'panel',panel:'code'}),
          onOpenAllChats:openChats,onOpenAllSpaces:()=>go({kind:'panel',panel:'projects'})}):null,
        notifications.dialog);
    }
    createRoot(document.getElementById('root')).render(h(RouterProvider,{router:createBrowserRouter([{path:'*',element:h(Fixture)}])}));`;
  await page.route(`**${FIXTURE}/main.js`, route => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route(`**${FIXTURE}?*`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body,#root{margin:0;height:100%;width:100%;overflow:hidden}</style><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="${FIXTURE}/main.js"></script></head><body><div id="root"></div></body></html>` }));
  await page.goto(`${FIXTURE}?projectId=${PROJECT_A}&conversationId=A&conversationControllerId=${CHAT_A}&browserRuntimeId=${BROWSER_A}`);
  await expect(page.getByTestId("thumb-shell")).toBeVisible();
}

test.use({ hasTouch: true, isMobile: true });
for (const layout of [
  { width: 375, height: 812, bottom: 34 },
  { width: 390, height: 844, bottom: 34 },
  { width: 844, height: 390, bottom: 21 },
]) {
  test(`thumb navigation preserves history, selection and input at ${layout.width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(layout);
    await mountNavigation(page, layout.height, layout.bottom);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const dock = page.getByTestId("mobile-bottom-dock");
    const destination = page.getByTestId("thumb-destination");
    const sheet = page.getByRole("dialog", { name: "Navigation", exact: true });
    const header = page.getByTestId("mobile-studio-navigation-header");
    const openPicker = () => header.getByTestId("mobile-header-picker").tap();
    const goBack = () => header.getByTestId("mobile-header-back").tap();
    const goForward = async () => {
      await openPicker();
      await sheet.getByRole("button", { name: "Forward", exact: true }).tap();
    };
    const initialKey = await page.evaluate(() => history.state.key);
    await expect(dock).toHaveCount(0);
    await expect(header.getByTestId("mobile-header-back")).toHaveCount(0);
    await expect(header.getByTestId("mobile-header-open-chats")).toBeVisible();
    await expect(header.getByTestId("mobile-header-picker")).toContainText("Alpha chat");
    await expect(header.getByTestId("mobile-header-picker")).toContainText("Alpha space");
    for (const id of ["mobile-header-open-chats", "mobile-header-picker", "mobile-header-more"]) {
      const box = (await header.getByTestId(id).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48); expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    }
    const headerScreenshot = testInfo.outputPath(`thumb-header-${layout.width}.png`);
    await page.screenshot({ path: headerScreenshot }); await testInfo.attach("Production detail header without bottom navigation", { path: headerScreenshot, contentType: "image/png" });
    const notificationUrl = page.url();
    await header.getByTestId("mobile-header-more").tap();
    await page.getByTestId("notification-center-bell").tap();
    const notificationCenter = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(notificationCenter).toBeVisible();
    await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    await expect(notificationCenter.getByText("No notifications yet.", { exact: true })).toBeVisible();
    // The center survives unmounting the originating More/bell subtree and
    // remains interactive; this must use real touch press, not element.click.
    await notificationCenter.getByRole("button", { name: "Unread", exact: true }).tap();
    await expect(notificationCenter.getByText("You're all caught up.", { exact: true })).toBeVisible();
    const notificationScreenshot = testInfo.outputPath(`thumb-notifications-${layout.width}.png`);
    await page.screenshot({ path: notificationScreenshot }); await testInfo.attach("Real notification center after More closes", { path: notificationScreenshot, contentType: "image/png" });
    await notificationCenter.getByRole("button", { name: "Close dialog", exact: true }).tap();
    await expect(notificationCenter).toHaveCount(0); expect(page.url()).toBe(notificationUrl);
    await header.getByTestId("mobile-header-more").tap(); await page.getByTestId("notification-center-bell").tap();
    await expect(notificationCenter).toBeVisible(); await page.keyboard.press("Escape");
    await expect(notificationCenter).toHaveCount(0); await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    expect(page.url()).toBe(notificationUrl);
    const checkDock = async () => {
      await expect(dock).toBeVisible();
      await expect(dock.getByRole("button")).toHaveCount(3);
      await expect(dock.getByTestId("mobile-bottom-dock-back")).toHaveCount(0);
      await expect.poll(() => dock.evaluate(e => e.getBoundingClientRect().bottom)).toBe(layout.height);
      const sizes = await dock.getByRole("button").evaluateAll(buttons => buttons.map(button => {
        const r = button.getBoundingClientRect(); return { width: r.width, height: r.height, bottom: r.bottom };
      }));
      for (const size of sizes) { expect(size.width).toBeGreaterThanOrEqual(48); expect(size.height).toBeGreaterThanOrEqual(48); expect(size.bottom).toBeLessThanOrEqual(layout.height - layout.bottom + 1); }
    };
    // A direct chat entry uses the header's Open chats fallback. The three
    // overview destinations navigate to pages, never to the transient picker.
    await header.getByTestId("mobile-header-open-chats").tap();
    await expect(destination).toHaveText("Chats overview"); await expect(sheet).toHaveCount(0);
    await checkDock();
    await dock.getByTestId("mobile-bottom-dock-projects").tap();
    await expect(destination).toHaveText("Spaces overview"); await expect(sheet).toHaveCount(0); await checkDock();
    await dock.getByTestId("mobile-bottom-dock-home").tap();
    await expect(destination).toHaveText("Home"); await expect(sheet).toHaveCount(0); await checkDock();
    await dock.getByTestId("mobile-bottom-dock-chat").tap();
    await expect(destination).toHaveText("Chats overview"); await expect(sheet).toHaveCount(0); await checkDock();
    const overviewUrl = page.url(), overviewKey = await page.evaluate(() => history.state.key);
    const dockScreenshot = testInfo.outputPath(`thumb-dock-${layout.width}.png`);
    await page.screenshot({ path: dockScreenshot }); await testInfo.attach("Production three-destination overview dock", { path: dockScreenshot, contentType: "image/png" });
    await page.getByRole("button", { name: "Open inert Beta chat", exact: true }).tap();
    await expect(destination).toHaveText(`B / ${PROJECT_A}`); await expect(dock).toHaveCount(0);
    const secondUrl = page.url(), secondKey = await page.evaluate(() => history.state.key);
    expect(secondKey).not.toBe(initialKey);
    await goBack(); await expect(destination).toHaveText("Chats overview"); await checkDock();
    expect(page.url()).toBe(overviewUrl); expect(await page.evaluate(() => history.state.key)).toBe(overviewKey);
    await goForward(); await expect(destination).toHaveText(`B / ${PROJECT_A}`); await expect(dock).toHaveCount(0);
    expect(page.url()).toBe(secondUrl); expect(await page.evaluate(() => history.state.key)).toBe(secondKey);
    await openPicker();
    await expect(sheet).toBeVisible();
    const search = sheet.getByRole("searchbox", { name: "Search loaded chats", exact: true });
    await search.fill("no-match"); await expect(sheet.getByText("No matching loaded chats.", { exact: true })).toBeVisible();
    await search.fill("Alpha"); await expect(sheet.getByRole("button", { name: "Beta chat", exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Alpha chat", exact: true }).tap();
    await expect(sheet).toHaveCount(0); await expect(destination).toHaveText(`A / ${PROJECT_A}`); await expect(dock).toHaveCount(0);
    await goBack(); await expect(destination).toHaveText(`B / ${PROJECT_A}`);
    expect(await page.evaluate(() => history.state.key)).toBe(secondKey);

    // This inert Router action provides real prior chat/job/browser values to
    // clear. It does not mock or help the sheet's subsequent space navigation.
    await page.getByRole("button", { name: "Open inert Chat B job", exact: true }).tap();
    await expect.poll(() => new URL(page.url()).searchParams.get("jobId")).toBe(JOB_B);
    await expect(dock).toHaveCount(0);
    const chatBVisitUrl = page.url(), chatBVisitKey = await page.evaluate(() => history.state.key);
    const priorParams = new URL(chatBVisitUrl).searchParams;
    expect(priorParams.get("conversationId")).toBe("B");
    expect(priorParams.get("conversationControllerId")).toBe(CHAT_B);
    expect(priorParams.get("browserRuntimeId")).toBe(BROWSER_A);
    await openPicker(); await sheet.getByRole("button", { name: "Spaces", exact: true }).tap();
    await sheet.getByRole("searchbox", { name: "Search spaces", exact: true }).fill("Beta");
    await expect(sheet.getByRole("button", { name: /Alpha space/ })).toHaveCount(0);
    await sheet.getByRole("button", { name: /Beta space/ }).tap();
    await expect(sheet).toHaveCount(0); await expect(destination).toHaveText(`No selected chat / ${PROJECT_B}`);
    await expect(dock).toHaveCount(0);
    const remoteSpaceUrl = page.url(), remoteSpaceKey = await page.evaluate(() => history.state.key);
    const remoteParams = new URL(remoteSpaceUrl).searchParams;
    expect(remoteParams.get("projectId")).toBe(PROJECT_B);
    for (const name of ["conversationId", "conversationControllerId", "jobId", "browserRuntimeId"]) expect(remoteParams.has(name), name).toBe(false);
    expect(remoteSpaceKey).not.toBe(chatBVisitKey);
    await goBack();
    await expect(destination).toHaveText(`B / ${PROJECT_A}`);
    expect(page.url()).toBe(chatBVisitUrl); expect(await page.evaluate(() => history.state.key)).toBe(chatBVisitKey);
    await goForward();
    await expect(sheet).toHaveCount(0); await expect(destination).toHaveText(`No selected chat / ${PROJECT_B}`);
    expect(page.url()).toBe(remoteSpaceUrl); expect(await page.evaluate(() => history.state.key)).toBe(remoteSpaceKey);
    await expect(dock).toHaveCount(0);
    await openPicker(); await sheet.getByRole("button", { name: "Files", exact: true }).tap();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("code");
    await expect(dock).toHaveCount(0);
    await goBack(); await expect.poll(() => page.url()).toBe(remoteSpaceUrl);
    await header.getByTestId("mobile-header-more").tap();
    await page.getByRole("button", { name: "Space settings", exact: true }).tap();
    await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("settings");
    await expect(dock).toHaveCount(0);
    await goBack(); await expect.poll(() => page.url()).toBe(remoteSpaceUrl);
    await openPicker(); await sheet.getByRole("button", { name: "Beta chat", exact: true }).tap();
    await expect(sheet).toHaveCount(0); await expect(destination).toHaveText(`B / ${PROJECT_B}`);
    await expect(dock).toHaveCount(0);

    const draft = page.getByRole("textbox", { name: "Synthetic retained draft", exact: true });
    await draft.tap(); await draft.fill("Unsaved inert fixture draft");
    await draft.evaluate(e => { (window as unknown as { fixtureDraft: Element }).fixtureDraft = e; });
    const keyboardHeight = layout.width === 844 ? 180 : layout.height - 320;
    // Animated IME opening must retain the closed baseline rather than ratchet
    // it down on every small frame. The browser input itself remains mounted.
    for (const height of [layout.height - 40, layout.height - 90, layout.height - 140, keyboardHeight]) {
      await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, height);
      await expect.poll(() => page.getByTestId("thumb-shell").evaluate(e => e.getBoundingClientRect().height)).toBe(height);
    }
    await expect(page.getByTestId("thumb-shell")).toHaveAttribute("data-keyboard-open", "true");
    await expect(dock).toHaveCount(0); await expect(draft).toBeFocused(); await expect(draft).toHaveValue("Unsaved inert fixture draft");
    expect(await draft.evaluate(e => e === (window as unknown as { fixtureDraft: Element }).fixtureDraft)).toBe(true);
    expect((await draft.boundingBox())!.y + (await draft.boundingBox())!.height).toBeLessThanOrEqual(keyboardHeight);
    await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, layout.height);
    await expect.poll(() => page.getByTestId("thumb-shell").evaluate(e => e.getBoundingClientRect().height)).toBe(layout.height);
    await expect(dock).toHaveCount(0); await expect(draft).toBeFocused(); await expect(draft).toHaveValue("Unsaved inert fixture draft");

    await openPicker();
    await expect(sheet).toBeVisible();
    const footer = page.getByTestId("mobile-navigation-footer");
    for (const control of await footer.locator("button,input").all()) {
      const r = await control.boundingBox();
      const label = await control.evaluate(e => `${e.getAttribute("aria-label") ?? e.textContent}: min-height=${getComputedStyle(e).minHeight}`);
      expect(r!.width, label).toBeGreaterThanOrEqual(48); expect(r!.height, label).toBeGreaterThanOrEqual(48);
    }
    const footerBounds = (await footer.boundingBox())!;
    expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(layout.height);
    if (layout.width < 844) {
      // A small picker hugs its content near the thumb; a fixed tall modal
      // would leave a large empty gap between these two rows and the search.
      const firstChatBounds = (await sheet.getByRole("button", { name: "Beta chat", exact: true }).boundingBox())!;
      const allChatsBounds = (await sheet.getByRole("button", { name: "All chats", exact: true }).boundingBox())!;
      expect(firstChatBounds.y).toBeGreaterThan(layout.height / 2);
      expect(footerBounds.y - allChatsBounds.y - allChatsBounds.height).toBeLessThanOrEqual(16);
      expect((await sheet.boundingBox())!.height).toBeLessThan(500);
      expect(await page.getByTestId("mobile-navigation-results").evaluate(e => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);
    }
    const sheetScreenshot = testInfo.outputPath(`thumb-picker-${layout.width}.png`);
    await page.screenshot({ path: sheetScreenshot }); await testInfo.attach("Production thumb picker", { path: sheetScreenshot, contentType: "image/png" });
    const sheetSearch = sheet.getByRole("searchbox", { name: "Search loaded chats", exact: true });
    expect(await sheetSearch.evaluate(e => getComputedStyle(e).fontSize)).toBe("16px");
    await sheetSearch.tap(); await sheetSearch.fill("Beta");
    await sheetSearch.evaluate(e => { (window as unknown as { fixturePickerSearch: Element }).fixturePickerSearch = e; });
    await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, keyboardHeight);
    // The modal's outer border can leave its footer one pixel inside the edge.
    await expect.poll(() => footer.evaluate((e, height) => Math.abs(e.getBoundingClientRect().bottom - height), keyboardHeight)).toBeLessThanOrEqual(1);
    await expect(sheetSearch).toBeFocused(); await expect(sheetSearch).toHaveValue("Beta");
    expect(await sheetSearch.evaluate(e => e === (window as unknown as { fixturePickerSearch: Element }).fixturePickerSearch)).toBe(true);
    const searchBounds = (await sheetSearch.boundingBox())!;
    expect(searchBounds.y).toBeGreaterThanOrEqual(0); expect(searchBounds.y + searchBounds.height).toBeLessThanOrEqual(keyboardHeight);
    const resultsBounds = (await page.getByTestId("mobile-navigation-results").boundingBox())!;
    expect(resultsBounds.height).toBeGreaterThan(0); expect(resultsBounds.y).toBeGreaterThanOrEqual(0);
    await expect(sheet.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);
    const filteredChatBounds = (await sheet.getByRole("button", { name: "Beta chat", exact: true }).boundingBox())!;
    expect(filteredChatBounds.y).toBeLessThan(resultsBounds.y + 40);
    expect(filteredChatBounds.height).toBeGreaterThanOrEqual(48);
    expect(filteredChatBounds.y + filteredChatBounds.height).toBeLessThanOrEqual(resultsBounds.y + resultsBounds.height);
    for (const name of ["Chats", "Spaces", "Forward"]) await expect(sheet.getByRole("button", { name, exact: true })).toBeHidden();
    const closeBounds = (await sheet.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
    expect(closeBounds.width).toBeGreaterThanOrEqual(48); expect(closeBounds.height).toBeGreaterThanOrEqual(48);
    expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(keyboardHeight);
    const keyboardScreenshot = testInfo.outputPath(`thumb-picker-keyboard-${layout.width}.png`);
    await page.screenshot({ path: keyboardScreenshot }); await testInfo.attach("Production picker with simulated keyboard viewport", { path: keyboardScreenshot, contentType: "image/png" });
    // Closing the keyboard restores secondary actions without remounting or
    // moving the search out of its persistent first footer row.
    await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, layout.height);
    for (const name of ["Chats", "Spaces", "Forward"]) await expect(sheet.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(sheetSearch).toBeFocused(); await expect(sheetSearch).toHaveValue("Beta");
    expect(await sheetSearch.evaluate(e => e === (window as unknown as { fixturePickerSearch: Element }).fixturePickerSearch)).toBe(true);
    await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, keyboardHeight);
    await expect(sheet.getByRole("button", { name: "Forward", exact: true })).toBeHidden();
    // The filtered row must be initially visible and accept a normal tap even
    // at180px, without a discovery scroll through hidden quick actions.
    const filteredChat = sheet.getByRole("button", { name: "Beta chat", exact: true });
    await filteredChat.tap();
    await expect(sheet).toHaveCount(0); await expect(destination).toHaveText(`B / ${PROJECT_B}`);
    await page.evaluate(height => { Object.assign(window.visualViewport!, { height, offsetTop: 0, scale: 1 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, layout.height);
    await expect.poll(() => page.getByTestId("thumb-shell").evaluate(e => e.getBoundingClientRect().height)).toBe(layout.height);
    await expect(dock).toHaveCount(0); await expect(draft).toHaveValue("Unsaved inert fixture draft");
    await openPicker(); await expect(sheet).toBeVisible();
    const beforeDismiss = page.url();
    await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); expect(page.url()).toBe(beforeDismiss);
    await expect(draft).toHaveValue("Unsaved inert fixture draft");
    // Content hugging must still cap a large loaded list and leave the fixed
    // footer usable, with ordinary scrolling reaching the last displayed row.
    await page.getByRole("button", { name: "Load inert long chat list", exact: true }).tap();
    await openPicker(); await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Inert loaded chat / })).toHaveCount(40);
    const longResults = page.getByTestId("mobile-navigation-results");
    expect((await sheet.boundingBox())!.height).toBeLessThanOrEqual(Math.min(640, layout.height));
    expect(await longResults.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(500);
    const lastRow = sheet.getByRole("button", { name: "Inert loaded chat 40", exact: true });
    await lastRow.scrollIntoViewIfNeeded();
    expect(await longResults.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    const lastBounds = (await lastRow.boundingBox())!, longBounds = (await longResults.boundingBox())!;
    expect(lastBounds.y).toBeGreaterThanOrEqual(longBounds.y);
    expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(longBounds.y + longBounds.height);
    const finalClose = sheet.getByRole("button", { name: "Close", exact: true });
    expect((await finalClose.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    expect((await finalClose.boundingBox())!.y + (await finalClose.boundingBox())!.height).toBeLessThanOrEqual(layout.height);
    const longScreenshot = testInfo.outputPath(`thumb-picker-long-${layout.width}.png`);
    await page.screenshot({ path: longScreenshot }); await testInfo.attach("Production picker with long inert list", { path: longScreenshot, contentType: "image/png" });
    await finalClose.tap(); await expect(sheet).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
