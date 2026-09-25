import { expect, test } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

test("conversation views preserve mounted resources, drafts and split size across narrow layouts", async ({ page }) => {
  const deps = await resolveViteReactDependencies(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/__conversation-surfaces__", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import R from '/@react-refresh'; R.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__conversation-surfaces__.js"></script></head><body style="margin:0"><div id="root"></div></body></html>` }));
  await page.route("**/__conversation-surfaces__.js", route => route.fulfill({ contentType: "application/javascript", body: `
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}'; import ReactDOMNS from '${deps.reactDomClient}';
    import { ConversationSurfaceLayout } from '/src/workspace/ConversationSurfaceLayout.tsx';
    import { useConversationSurfacesOwner, selectConversationView, openConversationFile } from '/src/workspace/conversationSurfaces.ts';
    const R=ReactNS.default??ReactNS, h=R.createElement, {createRoot}=ReactDOMNS.default??ReactDOMNS;
    function Browser(){const [visits,setVisits]=R.useState(0);return h('div',{id:'browser-panel'},h('button',{onClick:()=>setVisits(v=>v+1)},'Navigate page'),h('output',{'data-testid':'visits'},visits));}
    function App(){
      const [conversation,setConversation]=R.useState('one'),[width,setWidth]=R.useState(innerWidth),[drafts,setDrafts]=R.useState({});
      const owner=useConversationSurfacesOwner(),state=owner.read(conversation);
      R.useEffect(()=>{const resize=()=>setWidth(innerWidth);addEventListener('resize',resize);return()=>removeEventListener('resize',resize)},[]);
      const change=fn=>owner.update(conversation,fn), select=id=>change(s=>selectConversationView(s,id));
      const split=width>=1024&&state.split;
      return h('main',{style:{height:'100vh',display:'flex',flexDirection:'column'}},
        h('nav',null,...['one','two'].map(id=>h('button',{key:id,onClick:()=>setConversation(id)},'Conversation '+id))),
        h(ConversationSurfaceLayout,{
          chatPanelId:'chat-panel',activeId:state.activeId,resourceId:state.resourceId,split,wide:width>=1024,ratio:state.ratio,
          resources:[{id:'browser',label:'Browser',panelId:'browser-panel'},{id:'file:notes.md',label:'notes.md',panelId:'file-panel'}],
          onSelect:select,onSplitChange:value=>change(s=>({...s,split:value})),onRatioChange:ratio=>change(s=>({...s,ratio})),
          chat:h('div',{id:'chat-panel'},h('h1',null,'Chat '+conversation),h('textarea',{'aria-label':'Draft',value:drafts[conversation]??'',onChange:e=>setDrafts({...drafts,[conversation]:e.target.value})}),h('button',{onClick:()=>change(s=>openConversationFile(s,{id:'file:notes.md',path:'notes.md'}))},'Open notes')),
          content:h(R.Fragment,null,h('div',{hidden:state.resourceId!=='browser'},h(Browser)),h('div',{id:'file-panel',hidden:state.resourceId!=='file:notes.md'},h('textarea',{'aria-label':'Notes',defaultValue:'Original notes'})))
        }),h('output',{'data-testid':'ratio'},state.ratio));
    } createRoot(document.getElementById('root')).render(h(App));` }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__conversation-surfaces__");
  await expect(page.getByTestId("conversation-surface-layout")).toHaveAttribute("data-layout", "split");
  await page.getByRole("textbox", { name: "Draft", exact: true }).fill("Draft one");
  await page.getByRole("button", { name: "Navigate page" }).click();
  const divider = page.getByRole("separator");
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
  expect(errors).toEqual([]);
});
