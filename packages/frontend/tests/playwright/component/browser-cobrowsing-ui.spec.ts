import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

// Production controls, a synthetic native-host boundary. The separate Chromium
// tool fixture proves real field highlighting/input; this proves UI sequencing.
async function mountPersonalControls(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const fixturePath = "/__browser-cobrowsing-ui__";
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { PersonalBrowserSurface, BrowserTransportSelector } from "/src/screens/studio/components/PersonalBrowserSurface.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    window.__bounds = [];
    window.instafyDesktop = { personalBrowserSetBounds: async (bounds) => { window.__bounds.push(bounds); } };
    function Fixture() {
      const [native, setNative] = React.useState({ agentControlEnabled: false, humanControlReady: true, approvalMode: "ask" });
      window.__confirmNativeDrain = () => setNative((value) => ({ ...value, humanControlReady: true }));
      const status = { supported:true, enabled:true, state:"ready", visible:true, url:"https://fixture.example.test/form", canGoBack:false, canGoForward:false, ownerId:"owner-1", projectId:"project-1", approvalModes:["ask","routine"], ...native };
      const model = {
        agentError:null, agentPhase:native.agentControlEnabled ? "ready" : "idle", available:true, checked:true,
        clearDataError:null, clearDataState:"idle", clearNavigationError:()=>{}, clearData:async()=>null,
        close:async()=>{ throw new Error("Expansion must not close the browser"); }, goBack:async()=>null,
        goForward:async()=>null, navigate:async()=>null, navigationError:null, ownerId:"owner-1", reload:async()=>null,
        recovering:false, retryAgentControl:async()=>null, retryOpen:()=>{}, runtimeOverride:null, status,
        setAgentControlEnabled:async(enabled, approvalMode="ask")=> {
          const next = { ...status, agentControlEnabled:enabled, humanControlReady:false, approvalMode };
          window.__lastApprovalMode = approvalMode;
          setNative(next);
          return next;
        },
      };
      return h("main", { style:{ display:"flex", height:"100dvh", width:"100%", maxWidth:"900px" } },
        h(PersonalBrowserSurface, {
          active:true, compactChrome:true, model, humanInputIdentityKey:"user:project:conversation:personal",
          transportSelector:h(BrowserTransportSelector,{ checked:true,compact:true,mode:"personal",personalAvailable:true,onModeChange:()=>{} }),
          onContinueAfterHumanInput:async(message)=> { window.__continuation = message; setNative({agentControlEnabled:true,humanControlReady:false,approvalMode:"ask"}); return true; },
        }),
      );
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>html,body,#root{margin:0;width:100%;height:100%;min-width:0}</style>
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${fixturePath}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${fixturePath}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(fixturePath);
  await expect(page.getByTestId("personal-browser-chrome")).toBeVisible();
}

for (const width of [360, 900]) {
  test(`expands and waits for confirmed takeover before continuing at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mountPersonalControls(page);
    await page.getByTestId("personal-browser-routine-approval").check();
    await page.getByRole("button", { name: "Resume agent control", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as { __lastApprovalMode?: string }).__lastApprovalMode)).toBe("routine");
    await page.getByTestId("browser-human-input-takeover").click();
    await expect(page.getByTestId("browser-human-input-controls")).toContainText("Waiting for agent control to stop");
    await expect(page.getByTestId("browser-human-input-continue")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume agent control", exact: true })).toBeDisabled();

    await page.getByTestId("personal-browser-fullscreen-toggle").click();
    await expect(page.getByRole("dialog", { name: "Personal Browser", exact: true })).toBeVisible();
    await expect(page.getByTestId("browser-human-input-controls")).toContainText("Waiting for agent control to stop");
    await page.evaluate(() => (window as unknown as { __confirmNativeDrain: () => void }).__confirmNativeDrain());
    await expect(page.getByTestId("browser-human-input-continue")).toBeEnabled();
    const screenshotPath = testInfo.outputPath(`personal-takeover-expanded-${width}px.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`Expanded Personal takeover at ${width}px`, { contentType: "image/png", path: screenshotPath });
    await page.getByTestId("personal-browser-fullscreen-toggle").click();
    await expect(page.getByRole("dialog", { name: "Personal Browser", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("browser-human-input-continue")).toBeVisible();
    await page.getByTestId("browser-human-input-continue").click();
    await expect.poll(() => page.evaluate(() => (window as { __continuation?: string }).__continuation)).toContain("Take a fresh snapshot");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}
