import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__mobile_thumb_navigation__";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";
const JOB_B = "44444444-4444-4444-8444-444444444444";
const BROWSER_A = "55555555-5555-4555-8555-555555555555";

/** Production header with the chat switcher Studio's top bar gives it in a
 * chat, dock, navigation drawer (at the side, or at the bottom as the
 * composer opens it) with the spaces directory, overview policy, Router,
 * persistent history owner and viewport hook. The drawer's destination rows,
 * the overview rows and the button that opens the bottom drawer are inert
 * typed navigation entries standing in for the sidebar, the overview pages
 * and the composer, and the switcher lists inert chats. The retained input is
 * deliberately synthetic, not a claim about the full Studio composer or a
 * physical platform keyboard. */
async function mountNavigation(page: Page, width: number, height: number, bottom: number) {
  const deps = await resolveViteReactDependencies(page);
  const source = await (await page.request.get("/src/router.tsx")).text();
  const router = source.match(/["'](\/node_modules\/\.vite[^/]*\/deps\/react-router-dom\.js\?v=[^"']+)["']/)?.[1];
  if (!router) throw new Error("Router dependency was not optimized");
  await page.addInitScript(({ width, height, bottom }) => {
    // Popovers place themselves in the visual viewport, so it has a width and
    // a left edge as well as the height the keyboard steps below change.
    const viewport = new EventTarget();
    Object.assign(viewport, { width, height, offsetLeft: 0, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    document.addEventListener("DOMContentLoaded", () => {
      for (const edge of ["top", "left", "right"]) document.documentElement.style.setProperty(`--instafy-safe-area-inset-${edge}`, "0px");
      document.documentElement.style.setProperty("--instafy-safe-area-inset-bottom", `${bottom}px`);
    });
  }, { width, height, bottom });
  const main = `
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}';
    import ReactDomNS from '${deps.reactDomClient}';
    import {createBrowserRouter,RouterProvider,useLocation} from '${router}';
    import {useStudioHistory} from '/src/navigation/useStudioHistory.ts';
    import {useStudioNavigation} from '/src/navigation/useStudioNavigation.ts';
    import {useStudioViewportState} from '/src/screens/useStudioViewportState.ts';
    import {resolveMobileOverviewSection,useStudioNavigationPosture} from '/src/screens/studio/useStudioNavigationPosture.ts';
    import {MobileBottomDock} from '/src/screens/studio/components/MobileBottomDock.tsx';
    import {MobileStudioNavigationHeader} from '/src/screens/studio/components/MobileStudioNavigationHeader.tsx';
    import {StudioMobileSidebarOverlay} from '/src/screens/studio/components/StudioMobileSidebarOverlay.tsx';
    import {StudioSidebarWorkspacePanel} from '/src/screens/studio/components/StudioSidebarWorkspacePanel.tsx';
    import {StudioSidebarWorkspaceSwitcher} from '/src/screens/studio/components/StudioSidebarWorkspaceSwitcher.tsx';
    const React=ReactNS.default??ReactNS, h=React.createElement;
    const {createRoot}=ReactDomNS.default??ReactDomNS;
    const projects=[{id:'${PROJECT_A}',name:'Alpha space',orgId:'team-a',orgName:'Fixture team A'},
      {id:'${PROJECT_B}',name:'Beta space',orgId:'team-b',orgName:'Fixture team B'}];
    const chats=[{id:'A',controllerId:'${CHAT_A}',title:'Alpha chat'},{id:'B',controllerId:'${CHAT_B}',title:'Beta chat'}];
    const longChats=Array.from({length:60},(_,i)=>({id:'inert-'+i,controllerId:'33333333-3333-4333-8333-'+String(i).padStart(12,'0'),title:'Inert loaded chat '+String(i+1).padStart(2,'0')}));
    function Fixture(){
      const location=useLocation(),go=useStudioNavigation();
      const history=useStudioHistory(),viewport=useStudioViewportState({trackKeyboard:true}),posture=useStudioNavigationPosture();
      // The drawer the header's picker opened ('sidebar'), or the spaces
      // directory inside it that the chat switcher's Switch space opened.
      // The composer opens the same drawer at the bottom.
      const [drawer,setDrawer]=React.useState(null),[bottom,setBottom]=React.useState(false);
      const [draft,setDraft]=React.useState(''),[longList,setLongList]=React.useState(false);
      const [spaceSearch,setSpaceSearch]=React.useState(false),[spaceQuery,setSpaceQuery]=React.useState('');
      const spacesTrigger=React.useRef(null);
      const params=new URLSearchParams(location.search),project=params.get('projectId')??'${PROJECT_A}',chat=params.get('conversationId'),panel=params.get('panel')??'chat';
      const drawerTab=params.get('workspaceTab'),job=params.get('jobId');
      const activeTab=panel==='chat'?{kind:job?'jobThread':'conversation',conversationId:chat,jobId:job}:panel==='code'?{kind:'file',panel:'code',fileId:'inert',filePath:'/inert.txt'}:{kind:'panel',panel};
      const overview=resolveMobileOverviewSection(activeTab,drawerTab);
      const current=projects.find(p=>p.id===project),loaded=longList?longChats:chats;
      const openChats=()=>go({kind:'panel',panel:'chat',workspaceTab:'history'});
      const openChat=id=>{const c=loaded.find(c=>c.id===id);go({kind:'conversation',projectId:project,conversationId:c.id,conversationControllerId:c.controllerId});};
      const closeDrawer=()=>{setDrawer(null);setBottom(false);setSpaceSearch(false);setSpaceQuery('');};
      React.useEffect(closeDrawer,[location.key]);
      const needle=spaceQuery.trim().toLocaleLowerCase(),matches=p=>!needle||p.name.toLocaleLowerCase().includes(needle);
      const inChat=panel==='chat'&&overview===null;
      const title=overview==='home'?'Home':overview==='chat'?'Chats':overview==='projects'?'Spaces':panel==='chat'?(loaded.find(c=>c.id===chat)?.title??'New chat'):panel==='code'?'Files':'Settings';
      return h(React.Fragment,null,
        h('main',{'data-testid':'thumb-shell','data-keyboard-open':viewport.keyboardOpen,
          style:{height:viewport.viewportHeightPx??'100dvh',display:'flex',flexDirection:'column',overflow:'hidden'}},
          h(MobileStudioNavigationHeader,{key:location.key+'|'+project,history,title,spaceName:current.name,
            onOpenPicker:()=>setDrawer('sidebar'),sidebarOpen:drawer!==null,
            onOpenSettings:()=>go({kind:'panel',panel:'settings'}),
            // As the top bar passes it in a chat: the chats on hand, All chats and Switch space.
            conversationSwitcher:inChat?{tabs:loaded.map(c=>({id:c.id,title:c.title,spaceName:current.name})),activeId:chat,
              onSelect:openChat,onBrowseChats:openChats,onSwitchSpace:()=>setDrawer('spaces')}:undefined}),
          h('div',{style:{flex:1,minHeight:0,overflow:'auto',padding:16}},
            h('h1',{style:{fontSize:18}},'Inert thumb-navigation fixture'),
            h('output',{'data-testid':'thumb-destination'},overview==='home'?'Home':overview==='chat'?'Chats overview':overview==='projects'?'Spaces overview':(chat??'No selected chat')+' / '+project),
            h('p',null,'Production navigation; synthetic retained input below.'),
            overview==='chat'?chats.map(c=>h('button',{key:c.id,onClick:()=>openChat(c.id)},'Open inert '+c.title)):null,
            overview==='projects'?projects.map(p=>h('button',{key:p.id,onClick:()=>go({kind:'conversation',projectId:p.id})},'Open inert '+p.name)):null,
            h('button',{onClick:()=>setLongList(true)},'Load inert long chat list'),
            h('button',{onClick:()=>{setBottom(true);setDrawer('sidebar');}},'Open inert chat navigation'),
            h('button',{onClick:()=>go({kind:'conversation',projectId:project,conversationId:'B',conversationControllerId:'${CHAT_B}',jobId:'${JOB_B}'})},'Open inert Chat B job')),
          h('label',{style:{display:'block',padding:12}},'Synthetic retained draft',
            h('input',{'aria-label':'Synthetic retained draft',value:draft,onChange:e=>setDraft(e.target.value),style:{display:'block',width:'100%',minHeight:48,border:'1px solid #64748b'}})),
          posture.showTouchBottomDock&&overview&&!viewport.keyboardOpen?h(MobileBottomDock,{activeSlot:overview,homeAttentionCount:2,
            onHomePress:()=>go({kind:'panel',panel:'home'}),onChatPress:openChats,onProjectsPress:()=>go({kind:'panel',panel:'projects'})}):null),
        // As Studio lays it out: compact while the bottom drawer shows the
        // sidebar, whose handle closes it, and a footer Close in its other views.
        drawer?h(StudioMobileSidebarOverlay,{onClose:closeDrawer,presentation:bottom?'bottom':'side',
          compact:bottom&&drawer==='sidebar',showCloseFooter:drawer!=='sidebar'},
          h('nav',{'aria-label':'Inert sidebar',style:{position:'relative',width:288,height:'100%',display:'flex',flexDirection:'column',gap:8,padding:12}},
            h('button',{onClick:()=>go({kind:'panel',panel:'code'}),style:{minHeight:48}},'Files'),
            h('button',{onClick:openChats,style:{minHeight:48}},'All chats'),
            h('button',{ref:spacesTrigger,onClick:()=>setDrawer('spaces'),style:{minHeight:48}},'Spaces'),
            h(StudioSidebarWorkspacePanel,{mode:'spaces',open:drawer==='spaces',desktop:false,portalTarget:null,triggerRef:spacesTrigger,
              onClose:()=>{setDrawer('sidebar');setSpaceSearch(false);setSpaceQuery('');}},
              h(StudioSidebarWorkspaceSwitcher,{mode:'spaces',orgOptions:[],workspaceOrgKey:'all',
                onWorkspaceOrgChange:()=>{throw Error('No team change in fixture');},
                canSearchSpaces:true,showProjectSearch:spaceSearch,workspaceProjectSearchOpen:spaceSearch,
                workspaceProjectQuery:spaceQuery,onWorkspaceProjectQueryChange:setSpaceQuery,
                onToggleProjectSearch:()=>{setSpaceSearch(!spaceSearch);setSpaceQuery('');},
                currentOrgProject:matches(current)?current:null,switcherProjects:projects.filter(p=>p.id!==project&&matches(p)),
                // Commit one destination; the access provider hydrates even a
                // newly discovered space and the previous chat stays in history.
                onProjectMenuAction:key=>{const id=String(key).slice('project:'.length);closeDrawer();if(id!==project)go({kind:'conversation',projectId:id});}})))):null);
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
    await mountNavigation(page, layout.width, layout.height, layout.bottom);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const dock = page.getByTestId("mobile-bottom-dock");
    const destination = page.getByTestId("thumb-destination");
    const header = page.getByTestId("mobile-studio-navigation-header");
    const switcher = page.getByTestId("mobile-chat-switcher");
    const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
    const spaces = page.getByTestId("sidebar-project-switcher-menu");
    const openSwitcher = async () => {
      await header.getByTestId("mobile-chat-switcher-trigger").tap();
      await expect(switcher).toBeVisible();
    };
    const openDrawer = async () => {
      await header.getByTestId("mobile-header-picker").tap();
      await expect(drawer).toBeVisible();
    };
    const goBack = () => header.getByTestId("mobile-header-back").tap();
    const goForward = async () => {
      // Forward must remain available without opening navigation: a real
      // sidebar entry would truncate the branch that Forward needs.
      await expect(header.getByTestId("mobile-header-back")).toBeVisible();
      await expect(header.getByTestId("mobile-header-forward")).toBeEnabled();
      // The location keeps its place; in a chat it is the switcher's trigger.
      const beforeLocation = await header.getByTestId("mobile-header-location").boundingBox();
      await page.getByTestId("mobile-header-forward").tap();
      const afterLocation = await header.getByTestId("mobile-header-location").boundingBox();
      expect(afterLocation?.x).toBe(beforeLocation?.x);
      await expect(drawer).toHaveCount(0);
      await expect(switcher).toHaveCount(0);
      await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    };
    const expectInViewport = (box: { x: number; y: number; width: number; height: number } | null) => {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(layout.width);
      expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(layout.height);
    };
    const initialKey = await page.evaluate(() => history.state.key);
    await expect(dock).toHaveCount(0);
    await expect(header.getByTestId("mobile-header-back")).toHaveCount(0);
    await expect(header.getByTestId("mobile-header-open-chats")).toHaveCount(0);
    await expect(header.getByTestId("mobile-history-controls")).toHaveCount(0);
    await expect(header.getByTestId("mobile-header-title")).toHaveText("Alpha chat");
    await expect(header.getByTestId("mobile-header-space")).toHaveText("Alpha space");
    await expect(header.getByTestId("mobile-header-picker")).toHaveAccessibleName("Open space navigation: Alpha space");
    await expect(header.getByTestId("mobile-chat-switcher-trigger")).toHaveAccessibleName("Switch chats: Alpha chat");
    for (const id of ["mobile-header-picker", "mobile-chat-switcher-trigger", "mobile-header-more"]) {
      const box = (await header.getByTestId(id).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48); expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    }
    const headerScreenshot = testInfo.outputPath(`thumb-header-${layout.width}.png`);
    await page.screenshot({ path: headerScreenshot }); await testInfo.attach("Production detail header without bottom navigation", { path: headerScreenshot, contentType: "image/png" });
    const menuUrl = page.url();
    await header.getByTestId("mobile-header-more").tap();
    await expect(page.getByTestId("mobile-header-actions")).toBeVisible();
    // Activity lives on Home; compact navigation no longer has a duplicate bell.
    await expect(page.getByTestId("notification-center-bell")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Space settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    expect(page.url()).toBe(menuUrl);
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
    // The chat switcher's All chats opens the chats overview. History
    // controls never change into destination shortcuts.
    await openSwitcher();
    expectInViewport(await switcher.boundingBox());
    await switcher.getByTestId("mobile-chat-switcher-browse").tap();
    await expect(destination).toHaveText("Chats overview"); await expect(switcher).toHaveCount(0);
    await checkDock();
    await dock.getByTestId("mobile-bottom-dock-projects").tap();
    await expect(destination).toHaveText("Spaces overview"); await checkDock();
    await dock.getByTestId("mobile-bottom-dock-home").tap();
    await expect(destination).toHaveText("Home"); await checkDock();
    await dock.getByTestId("mobile-bottom-dock-chat").tap();
    await expect(destination).toHaveText("Chats overview"); await checkDock();
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

    // Choosing another chat in the switcher is one visit; the current chat
    // only closes it.
    await openSwitcher();
    await expect(switcher.getByTestId("mobile-chat-switcher-tab-B")).toHaveAttribute("aria-current", "page");
    // Its rows (the open chats, All chats and Switch space), not the hidden
    // Dismiss button the popover keeps for screen readers.
    const rows = await switcher.locator('button[data-testid^="mobile-chat-switcher-"]').all();
    expect(rows.length).toBe(4);
    for (const row of rows) {
      const box = (await row.boundingBox())!;
      expect(box.height, await row.getAttribute("data-testid") ?? "").toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    }
    await switcher.getByTestId("mobile-chat-switcher-tab-B").tap();
    await expect(switcher).toHaveCount(0); expect(page.url()).toBe(secondUrl);
    await openSwitcher();
    await switcher.getByTestId("mobile-chat-switcher-tab-A").tap();
    await expect(switcher).toHaveCount(0); await expect(destination).toHaveText(`A / ${PROJECT_A}`); await expect(dock).toHaveCount(0);
    await goBack(); await expect(destination).toHaveText(`B / ${PROJECT_A}`);
    expect(await page.evaluate(() => history.state.key)).toBe(secondKey);

    // This inert Router action provides real prior chat/job/browser values to
    // clear. It does not mock or help the spaces directory's navigation.
    await page.getByRole("button", { name: "Open inert Chat B job", exact: true }).tap();
    await expect.poll(() => new URL(page.url()).searchParams.get("jobId")).toBe(JOB_B);
    await expect(dock).toHaveCount(0);
    const chatBVisitUrl = page.url(), chatBVisitKey = await page.evaluate(() => history.state.key);
    const priorParams = new URL(chatBVisitUrl).searchParams;
    expect(priorParams.get("conversationId")).toBe("B");
    expect(priorParams.get("conversationControllerId")).toBe(CHAT_B);
    expect(priorParams.get("browserRuntimeId")).toBe(BROWSER_A);
    await openSwitcher(); await switcher.getByTestId("mobile-chat-switcher-spaces").tap();
    await expect(drawer).toBeVisible(); await expect(spaces).toBeVisible();
    expectInViewport(await spaces.getByTestId("sidebar-project-switcher-back").boundingBox());
    await spaces.getByRole("button", { name: "Search spaces", exact: true }).tap();
    await spaces.getByRole("searchbox", { name: "Search spaces", exact: true }).fill("Beta");
    await expect(spaces.getByTestId(`sidebar-project-current-${PROJECT_A}`)).toHaveCount(0);
    await spaces.getByTestId(`sidebar-project-switcher-item-${PROJECT_B}`).tap();
    await expect(drawer).toHaveCount(0); await expect(destination).toHaveText(`No selected chat / ${PROJECT_B}`);
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
    await expect(destination).toHaveText(`No selected chat / ${PROJECT_B}`);
    expect(page.url()).toBe(remoteSpaceUrl); expect(await page.evaluate(() => history.state.key)).toBe(remoteSpaceKey);
    await expect(dock).toHaveCount(0);
    // The header's picker opens the navigation drawer; its Back leaves the
    // spaces directory before the drawer itself closes.
    await openDrawer();
    await drawer.getByRole("button", { name: "Spaces", exact: true }).tap();
    await expect(spaces).toBeVisible();
    await spaces.getByTestId("sidebar-project-switcher-back").tap();
    await expect(spaces).toHaveCount(0); await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Files", exact: true }).tap();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("code");
    await expect(dock).toHaveCount(0);
    await goBack(); await expect.poll(() => page.url()).toBe(remoteSpaceUrl);
    await header.getByTestId("mobile-header-more").tap();
    await page.getByRole("button", { name: "Space settings", exact: true }).tap();
    await expect(page.getByTestId("mobile-header-actions")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("settings");
    await expect(dock).toHaveCount(0);
    await goBack(); await expect.poll(() => page.url()).toBe(remoteSpaceUrl);
    await openSwitcher(); await switcher.getByTestId("mobile-chat-switcher-tab-B").tap();
    await expect(switcher).toHaveCount(0); await expect(destination).toHaveText(`B / ${PROJECT_B}`);
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

    // Dismissing either picker changes nothing and keeps the draft.
    const beforeDismiss = page.url();
    await openDrawer();
    await page.keyboard.press("Escape"); await expect(drawer).toHaveCount(0); expect(page.url()).toBe(beforeDismiss);
    await openSwitcher();
    await page.keyboard.press("Escape"); await expect(switcher).toHaveCount(0); expect(page.url()).toBe(beforeDismiss);
    await expect(draft).toHaveValue("Unsaved inert fixture draft");
    // The drawer the composer opens at the bottom: its handle closes it from
    // the sidebar, and in the spaces directory a footer Close in reach does.
    await page.getByRole("button", { name: "Open inert chat navigation", exact: true }).tap();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("mobile-sidebar-surface")).toHaveAttribute("data-presentation", "bottom");
    await expect(drawer.getByTestId("mobile-navigation-sheet-handle")).toHaveAccessibleName("Close navigation");
    await expect(drawer.getByTestId("mobile-navigation-sheet-close")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Spaces", exact: true }).tap();
    await expect(spaces).toBeVisible();
    const drawerClose = drawer.getByTestId("mobile-navigation-sheet-close");
    await expect(drawerClose).toHaveAccessibleName("Close navigation");
    const drawerCloseBox = await drawerClose.boundingBox();
    expect(drawerCloseBox!.height).toBeGreaterThanOrEqual(48);
    expectInViewport(drawerCloseBox);
    await drawerClose.tap();
    await expect(drawer).toHaveCount(0); expect(page.url()).toBe(beforeDismiss);
    await expect(draft).toHaveValue("Unsaved inert fixture draft");
    // A long list gets the switcher's filter; a filtered row stays in view and
    // takes a normal tap.
    await page.getByRole("button", { name: "Load inert long chat list", exact: true }).tap();
    await openSwitcher();
    const filter = switcher.getByRole("searchbox", { name: "Filter open chats", exact: true });
    await expect(filter).toBeVisible();
    await expect(switcher.getByRole("button", { name: /^Inert loaded chat / })).toHaveCount(60);
    expectInViewport(await switcher.boundingBox());
    const longScreenshot = testInfo.outputPath(`thumb-picker-long-${layout.width}.png`);
    await page.screenshot({ path: longScreenshot }); await testInfo.attach("Production chat switcher with long inert list", { path: longScreenshot, contentType: "image/png" });
    await filter.fill("chat 40");
    const filteredChat = switcher.getByRole("button", { name: "Inert loaded chat 40", exact: true });
    await expect(switcher.getByRole("button", { name: /^Inert loaded chat / })).toHaveCount(1);
    expectInViewport(await filteredChat.boundingBox());
    expect((await filteredChat.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await filteredChat.tap();
    await expect(switcher).toHaveCount(0); await expect(destination).toHaveText(`inert-39 / ${PROJECT_B}`);
    await expect(header.getByTestId("mobile-header-title")).toHaveText("Inert loaded chat 40");
    await expect(dock).toHaveCount(0); await expect(draft).toHaveValue("Unsaved inert fixture draft");
    expect(errors).toEqual([]);
  });
}
