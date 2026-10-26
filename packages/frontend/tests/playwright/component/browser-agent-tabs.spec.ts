import { expect, test } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

test.use({ hasTouch: true });

// The agent's tabs in both browsers: Shared (the workspace browser's tab
// picker and Reading row) and Personal (the desktop surface over a stubbed
// native host). Take over is one press and ends the agent's control of every
// tab; afterwards no tab carries the agent's control mark ("Octo · "), and a
// tab the agent opened only says whose it is ("Octo's tab: ").
for (const { width, dark } of [{ width: 390, dark: false }, { width: 390, dark: true }, { width: 1100, dark: false }]) {
  test(`agent tabs are badged, listed and taken over in one press at ${width}px in ${dark ? "dark" : "light"} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    const deps = await resolveViteReactDependencies(page);
    const fixturePath = "/__browser-agent-tabs__";
    await page.route(`**${fixturePath}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: `
      import "/src/styles/tailwind.css";
      import ReactNS from "${deps.react}";
      import ReactDomClientNS from "${deps.reactDomClient}";
      import { SharedBrowserChrome } from "/src/screens/studio/components/SharedBrowserChrome.tsx";
      import { BrowserReadingRow } from "/src/screens/studio/components/BrowserReadingRow.tsx";
      import { BrowserHumanInputStatus } from "/src/screens/studio/components/BrowserHumanInputControls.tsx";
      import { useBrowserHumanInput } from "/src/screens/studio/components/useBrowserHumanInput.ts";
      import { resolveAgentReadingPages } from "/src/screens/studio/components/browserAgentTabs.ts";
      import { PersonalBrowserSurface } from "/src/screens/studio/components/PersonalBrowserSurface.tsx";
      const React = ReactNS.default ?? ReactNS;
      const {createRoot} = ReactDomClientNS.default ?? ReactDomClientNS;
      const h = React.createElement;
      window.__revocations = [];
      const pages = [
        {id:"mine",url:"https://mine.example/",host:"mine.example",label:"Mine",title:"My own page",lastReferencedAt:3,isActive:false},
        {id:"bound",url:"https://www.city.example/parks",host:"city.example",label:"Parks",title:"Parks and gardens | City of Example",lastReferencedAt:2,isActive:true},
        {id:"opened",url:"https://transit.example/timetable",host:"transit.example",label:"Timetable",title:"Timetable with a very long title that keeps going past the edge of a phone screen",lastReferencedAt:1,isActive:false,openedBy:"agent"},
      ];
      const noop = () => {};
      function Shared() {
        const [agent,setAgent] = React.useState(true);
        const options = {identityKey:"shared",request:null,canTakeOver:agent,humanControlConfirmed:!agent,
          onTakeOver:async()=>{window.__revocations.push("shared");setAgent(false);return true;},onContinue:async()=>true};
        const state = useBrowserHumanInput(options);
        const owner = agent ? {kind:"agent",displayName:"Octo"} : {kind:"human"};
        const reading = resolveAgentReadingPages({pages,agentControlActive:agent,agentPageIds:["bound"]});
        return h("section",{"data-testid":"shared-fixture","aria-label":"Shared browser"},
          h(SharedBrowserChrome,{pages,resolved:true,pendingAction:null,error:null,compact:${width < 600},
            onNavigate:noop,onBack:noop,onForward:noop,onReload:noop,onFocusPage:noop,onClearError:noop,
            controlOwner:owner,agentPageIds:["bound"],interactionEnabled:!agent,
            toolbarActions:h(BrowserHumanInputStatus,{...options,state})}),
          agent ? h(BrowserReadingRow,{pages:reading,agentName:"Octo",canTakeOver:options.canTakeOver&&(!state.active||state.busy==="takeover"),
            takingOver:state.busy==="takeover",onTakeOver:()=>void state.takeOver()}) : null);
      }
      function Personal() {
        const [status,setStatus] = React.useState({supported:true,enabled:true,state:"ready",visible:true,
          url:"https://www.library.example/hours",title:"Opening hours",canGoBack:false,canGoForward:false,
          agentControlEnabled:true,humanControlReady:false,approvalMode:"routine",approvalModes:["ask","routine"],
          approvalPolicyVersion:2,ownerId:"owner-1",projectId:"project-1",runtimeId:"runtime-1"});
        const asyncNull = async () => null;
        const model = {approvalModeChoice:"routine",preferredApprovalMode:"routine",setPreferredApprovalMode:noop,
          agentError:null,agentPhase:"ready",available:true,checked:true,clearDataError:null,clearDataState:"idle",
          clearNavigationError:noop,clearData:asyncNull,close:asyncNull,goBack:asyncNull,goForward:asyncNull,
          navigate:asyncNull,navigationError:null,ownerId:"owner-1",pendingHandoff:null,readPage:asyncNull,
          reload:asyncNull,recovering:false,retryAgentControl:asyncNull,retryOpen:noop,
          runtimeOverride:{runtimeId:"runtime-1",runtimeDisplayName:"Personal Browser",preferRuntime:false},
          setAgentControlEnabled:async(enabled)=>{window.__revocations.push("personal:"+enabled);
            const next={...status,agentControlEnabled:enabled,humanControlReady:!enabled};setStatus(next);return next;},
          status};
        return h("section",{"data-testid":"personal-fixture","aria-label":"Personal browser",style:{height:320,display:"flex",flexDirection:"column"}},
          h(PersonalBrowserSurface,{active:true,agentWorking:true,model,transportSelector:null,compactChrome:${width < 600}}));
      }
      window.instafyDesktop = {notify:async()=>undefined,personalBrowserSetBounds:async()=>null};
      createRoot(document.getElementById("root")).render(h("main",null,h(Shared),h(Personal)));
    ` }));
    await page.route(`**${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
      <style>body{margin:0;background:${dark ? "#11141c" : "#fff"};color:${dark ? "#e6e8f2" : "#23283b"}}</style></head><body><div id="root"></div><script type="module" src="${fixturePath}/main.js"></script></body></html>` }));
    await page.goto(fixturePath);

    // A cold dev server optimizes the fixture's imports on first load.
    await expect(page.getByTestId("personal-fixture")).toBeVisible({ timeout: 30_000 });
    const before = testInfo.outputPath(`agent-tabs-before-${dark ? "dark" : "light"}-${width}.png`);
    await page.screenshot({ path: before });
    await testInfo.attach("Agent tabs while Octo reads", { path: before, contentType: "image/png" });

    // Shared: the tab picker names the agent on its tabs, the Reading row lists them.
    const shared = page.getByTestId("shared-fixture");
    const options = shared.locator('[data-testid="shared-browser-page-select"] option');
    await expect(options).toHaveText(["My own page", "Octo · Parks and gardens | City of Example", "Octo · Timetable with a very long title that keeps going past the edge of a phone screen"]);
    const sharedRow = shared.getByTestId("browser-reading-row");
    await expect(sharedRow).toContainText("Octo is reading");
    await expect(sharedRow.getByTestId("browser-reading-page")).toHaveCount(2);
    await expect(sharedRow.getByTestId("browser-reading-page").first()).toContainText("city.example");
    // The row stays one line inside the viewport, however long a title is.
    const rowBox = await sharedRow.boundingBox();
    expect(rowBox!.height).toBeLessThanOrEqual(60);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(width);
    const sharedTakeOver = sharedRow.getByRole("button", { name: "Take over" });
    expect(await sharedTakeOver.evaluate((el) => getComputedStyle(el).minHeight)).toBe("44px");
    await sharedTakeOver.click();
    // One press, no confirmation: control is revoked and every badge is gone.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(shared.getByTestId("browser-reading-row")).toHaveCount(0);
    await expect(options).toHaveText(["My own page", "Parks and gardens | City of Example", "Octo's tab: Timetable with a very long title that keeps going past the edge of a phone screen"]);
    await expect(shared.getByRole("button", { name: "Let AI continue" })).toBeVisible();

    // Personal: the page the resumed turn reads, and the same one-press take-over (Pause).
    const personal = page.getByTestId("personal-fixture");
    const personalRow = personal.getByTestId("browser-reading-row");
    await expect(personalRow.getByTestId("browser-reading-page")).toHaveText(["library.example· Opening hours"]);
    await personalRow.getByRole("button", { name: "Take over" }).click();
    await expect(personal.getByTestId("browser-reading-row")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __revocations: string[] }).__revocations)).toEqual(["shared", "personal:false"]);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const screenshot = testInfo.outputPath(`agent-tabs-${dark ? "dark" : "light"}-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach("After take-over", { path: screenshot, contentType: "image/png" });
  });
}
