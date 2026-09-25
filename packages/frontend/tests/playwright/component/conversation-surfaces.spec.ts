import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path });
  return path;
}

test("conversation views preserve mounted resources, drafts and split size across narrow layouts", async ({ page }, testInfo) => {
  const deps = await resolveViteReactDependencies(page);
  const layoutModule = await (await page.request.get("/src/workspace/ConversationSurfaceLayout.tsx")).text();
  const iconModule = layoutModule.match(/["']([^"']+iconoir-react[^"']+)["']/)?.[1];
  if (!iconModule) throw new Error("Could not resolve the layout's Vite icon dependency");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/__conversation-surfaces__", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import R from '/@react-refresh'; R.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__conversation-surfaces__.js"></script></head><body style="margin:0"><div id="root"></div></body></html>` }));
  await page.route("**/__conversation-surfaces__.js", route => route.fulfill({ contentType: "application/javascript", body: `
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}'; import ReactDOMNS from '${deps.reactDomClient}';
    import { Globe, Page } from '${iconModule}';
    import { ConversationSurfaceLayout } from '/src/workspace/ConversationSurfaceLayout.tsx';

    import { useConversationSurfacesOwner, selectConversationView, openConversationFile, closeConversationFile, conversationFileLabel } from '/src/workspace/conversationSurfaces.ts';
    const R=ReactNS.default??ReactNS, h=R.createElement, {createRoot}=ReactDOMNS.default??ReactDOMNS;
    function Browser(){const [visits,setVisits]=R.useState(0);return h('div',{id:'browser-panel'},h('button',{onClick:()=>setVisits(v=>v+1)},'Navigate page'),h('output',{'data-testid':'visits'},visits));}
    window.__surfaceMetrics = { renders: 0, writes: 0 };
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key,value){if(key.startsWith('instafy:conversation-views:'))window.__surfaceMetrics.writes++;return write.call(this,key,value)};
    function App(){
      window.__surfaceMetrics.renders++;
      const [conversation,setConversation]=R.useState('one'),[width,setWidth]=R.useState(innerWidth),[drafts,setDrafts]=R.useState({}),[notes,setNotes]=R.useState('Original notes'),[hasBrowser,setHasBrowser]=R.useState(true);
      const root=R.useRef(null),preview=R.useCallback(ratio=>root.current?.style.setProperty('--conversation-resource-ratio',String(ratio)),[]);
      const owner=useConversationSurfacesOwner(),state=owner.read(conversation);
      R.useEffect(()=>{const resize=()=>setWidth(innerWidth);addEventListener('resize',resize);return()=>removeEventListener('resize',resize)},[]);
      const change=fn=>owner.update(conversation,fn), select=id=>change(s=>selectConversationView(s,id));
      const split=width>=1024&&state.split&&(hasBrowser||state.files.length>0);
      const file=path=>({id:'file:'+path,path});
      window.openViews=paths=>change(s=>paths.reduce((next,path)=>openConversationFile(next,file(path)),s));
      window.hideBrowser=()=>setHasBrowser(false);
      return h('main',{ref:root,className:'bg-white text-slate-900 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100',style:{height:'100vh',display:'flex',flexDirection:'column'}},
        h('nav',null,...['one','two'].map(id=>h('button',{key:id,onClick:()=>setConversation(id)},'Conversation '+id))),
        h(ConversationSurfaceLayout,{
          chatPanelId:'chat-panel',activeId:state.activeId,resourceId:state.resourceId,split,wide:width>=1024,ratio:state.ratio,
          resources:[...(hasBrowser?[{id:'browser',label:'Browser',panelId:'browser-panel',icon:h(Globe,{className:'h-3.5 w-3.5'})}]:[]),...state.files.map(file=>({id:file.id,label:conversationFileLabel(file,state.files),title:file.path,panelId:'file-panel',icon:h(Page,{className:'h-3.5 w-3.5'}),dirty:file.path==='notes.md'&&notes!=='Original notes',onClose:()=>change(s=>closeConversationFile(s,file.id,hasBrowser))}))],
          onRatioPreview:preview,onSelect:select,onSplitChange:value=>change(s=>({...s,split:value})),onRatioChange:ratio=>change(s=>({...s,ratio})),
          chat:h('div',{id:'chat-panel',tabIndex:-1,className:'p-6'},h('h1',null,'Chat '+conversation),h('textarea',{'aria-label':'Draft',value:drafts[conversation]??'',onChange:e=>setDrafts({...drafts,[conversation]:e.target.value})}),h('button',{onClick:()=>change(s=>openConversationFile(s,{id:'file:notes.md',path:'notes.md'}))},'Open notes')),
          content:h(R.Fragment,null,h('div',{hidden:state.resourceId!=='browser'},h(Browser)),h('div',{id:'file-panel',className:'p-6',hidden:!state.resourceId.startsWith('file:')},h('textarea',{'aria-label':'Notes',value:notes,onChange:e=>setNotes(e.target.value)})))
        }),h('div',{'data-testid':'composer-width',style:{width:split?'calc((1 - var(--conversation-resource-ratio, '+state.ratio+')) * 100%)':'100%',height:2}}),h('output',{'data-testid':'ratio'},state.ratio));
    } createRoot(document.getElementById('root')).render(h(App));` }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__conversation-surfaces__");
  await expect(page.getByTestId("conversation-surface-layout")).toHaveAttribute("data-layout", "split");
  await page.getByRole("textbox", { name: "Draft", exact: true }).fill("Draft one");
  await page.getByRole("button", { name: "Navigate page" }).click();
  await page.getByRole("button", { name: "Open notes" }).click();
  const divider = page.getByRole("separator");
  const beforeDrag = await page.evaluate(() => ({...(window as unknown as {__surfaceMetrics: {renders:number;writes:number}}).__surfaceMetrics}));
  const bounds = (await divider.boundingBox())!;
  await page.mouse.move(bounds.x, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y + bounds.height / 2, { steps: 30 });
  const duringDrag = await page.evaluate(() => ({...(window as unknown as {__surfaceMetrics: {renders:number;writes:number}}).__surfaceMetrics}));
  // Header and external composer follow the panel while the owner is untouched.
  const liveWidths = await page.evaluate(() => ({
    chat: document.getElementById("chat-panel")!.getBoundingClientRect().width,
    heading: document.querySelector('[data-testid="conversation-subtabs"] > div')!.getBoundingClientRect().width,
    composer: document.querySelector('[data-testid="composer-width"]')!.getBoundingClientRect().width,
  }));
  expect(Math.abs(liveWidths.heading - liveWidths.chat)).toBeLessThan(2);
  expect(Math.abs(liveWidths.composer - liveWidths.chat)).toBeLessThan(2);
  await page.mouse.up();
  const afterDrag = await page.evaluate(() => ({...(window as unknown as {__surfaceMetrics: {renders:number;writes:number}}).__surfaceMetrics}));
  const dragMetrics = { during: { renders: duringDrag.renders - beforeDrag.renders, writes: duringDrag.writes - beforeDrag.writes }, settled: { renders: afterDrag.renders - beforeDrag.renders, writes: afterDrag.writes - beforeDrag.writes } };
  expect(dragMetrics).toEqual({ during: { renders: 0, writes: 0 }, settled: { renders: 1, writes: 1 } });
  console.log('SURFACE_DRAG_METRICS', JSON.stringify(dragMetrics));
  await testInfo.attach('divider-update-counts', { body: JSON.stringify(dragMetrics), contentType: 'application/json' });
  await divider.focus();
  await divider.press("ArrowLeft");
  const ratio = await page.getByTestId("ratio").textContent();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("conversation-surface-layout")).toHaveAttribute("data-layout", "single");
  await page.getByRole("tab", { name: "Browser", exact: true }).click();
  await expect(page.getByTestId("visits")).toHaveText("1");
  await page.getByRole("tab", { name: "Browser", exact: true }).press("End");
  await expect(page.getByRole("tab", { name: "notes.md" })).toBeFocused();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Unsaved notes");
  await page.getByRole("tab", { name: "notes.md" }).press("Home");
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("Draft one");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("Unsaved notes");
  await expect(page.getByTestId("ratio")).toHaveText(ratio!);
  await page.getByRole("button", { name: "Conversation two" }).click();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Draft", exact: true }).fill("Draft two");
  await page.getByRole("button", { name: "Conversation one" }).click();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("Draft one");
  await expect(page.getByRole("tab", { name: "notes.md" })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Closing a dirty view only removes its reference; reopening keeps the draft.
  await expect(page.getByRole("tab", { name: "notes.md, unsaved changes", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "notes.md, unsaved changes", exact: true }).click();
  await page.getByRole("tab", { name: "notes.md, unsaved changes", exact: true }).press("Delete");
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Open notes" }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("Unsaved notes");
  await page.evaluate(() => (window as unknown as {openViews: (paths: string[]) => void}).openViews([
    "drafts/notes.md", "docs/long-resource-name-that-should-truncate.md",
    ...Array.from({length: 10}, (_, i) => `docs/chapter-${i}.md`),
  ]));
  const tabs = page.getByRole("tablist", { name: "Conversation views" });
  const selected = page.getByRole("tab", { name: "chapter-9.md", exact: true });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "notes.md · ., unsaved changes", exact: true })).toHaveAttribute("title", "notes.md");
  await expect(page.getByRole("tab", { name: "notes.md · drafts", exact: true })).toHaveAttribute("title", "drafts/notes.md");
  const viewport = page.getByTestId("conversation-resource-tabs").locator(".overflow-x-auto");
  const closeLast = page.getByRole("button", { name: "Close chapter-9.md view", exact: true });
  const activeBounds = (await closeLast.boundingBox())!, viewportBounds = (await viewport.boundingBox())!;
  expect(activeBounds.x + activeBounds.width).toBeLessThanOrEqual(viewportBounds.x + viewportBounds.width + 1);
  await expect(page.getByRole("button", { name: "Scroll views left" })).toBeEnabled();
  await page.getByRole("button", { name: "Scroll views left" }).click();
  await expect(page.getByRole("button", { name: "Scroll views right" })).toBeEnabled();
  await selected.focus();
  await selected.press("Delete");
  await expect(page.getByRole("tab", { name: "chapter-8.md", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "chapter-8.md", exact: true }).press("Home");
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Close notes.md · . view", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  // Opening an existing view selects it without changing its position.
  const order = await tabs.getByRole("tab").allTextContents();
  await page.evaluate(() => (window as unknown as {openViews: (paths: string[]) => void}).openViews(["drafts/notes.md"]));
  expect(await tabs.getByRole("tab").allTextContents()).toEqual(order);
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      await expect(page.getByTestId("conversation-surface-layout")).toHaveAttribute("data-layout", width >= 1024 ? "split" : "single");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await testInfo.attach(`conversation-views-${dark ? "dark" : "light"}-${width}`, { path: await screenshot(page, testInfo, `views-${dark ? "dark" : "light"}-${width}.png`), contentType: "image/png" });
    }
  }
  // Chromium touch emulation exercises the actual coarse-pointer CSS and a touch close.
  const touch = await page.context().newCDPSession(page);
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const touchClose = page.getByRole("button", { name: "Close notes.md view", exact: true });
  const touchBounds = (await touchClose.boundingBox())!;
  expect(touchBounds.width).toBeGreaterThanOrEqual(44);
  expect(touchBounds.height).toBeGreaterThanOrEqual(44);
  const touchViewport = (await viewport.boundingBox())!;
  expect(touchBounds.x + touchBounds.width).toBeLessThanOrEqual(touchViewport.x + touchViewport.width + 1);
  await testInfo.attach("conversation-views-dark-touch-320", { path: await screenshot(page, testInfo, "views-dark-touch-320.png"), contentType: "image/png" });
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchBounds.x + touchBounds.width / 2, y: touchBounds.y + touchBounds.height / 2 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(touchClose).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "long-resource-name-that-should-truncate.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await touch.detach();
  // With no browser, closing the final file focuses the remaining Chat panel.
  await page.evaluate(() => (window as unknown as {hideBrowser: () => void}).hideBrowser());
  while (await page.getByRole("button", {name: /^Close .* view$/}).count()) {
    const closeButton = page.getByRole("button", {name: /^Close .* view$/}).first();
    await closeButton.click();
  }
  await expect(page.locator("#chat-panel")).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("Draft one");
  expect(errors).toEqual([]);
});
