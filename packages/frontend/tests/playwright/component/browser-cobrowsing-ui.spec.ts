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
    import { PersonalBrowserSurface, BrowserLocationOptions } from "/src/screens/studio/components/PersonalBrowserSurface.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    window.__bounds = [];
    window.__controlCalls = [];
    window.instafyDesktop = { personalBrowserSetBounds: async (bounds) => { window.__bounds.push(bounds); return {}; } };
    function Fixture() {
      const [native, setNative] = React.useState({ agentControlEnabled: false, humanControlReady: true, approvalMode: "ask" });
      const [agentError, setAgentError] = React.useState(null);
      const [preferredApprovalMode, setPreferredApprovalMode] = React.useState("routine");
      window.__confirmNativeDrain = () => setNative((value) => ({ ...value, humanControlReady: true }));
      const status = { supported:true, enabled:true, state:"ready", visible:true, url:"https://fixture.example.test/form", canGoBack:false, canGoForward:false, ownerId:"owner-1", projectId:"project-1", approvalModes:["ask","routine"], ...native };
      const model = {
        preferredApprovalMode, setPreferredApprovalMode, agentError, agentPhase:agentError ? "unavailable" : native.agentControlEnabled ? "ready" : "idle", available:true, checked:true,
        clearDataError:null, clearDataState:"idle", clearNavigationError:()=>{}, clearData:async()=>null,
        close:async()=>{ throw new Error("Expansion must not close the browser"); }, goBack:async()=>null,
        goForward:async()=>null, navigate:async()=>null, navigationError:null, ownerId:"owner-1", reload:async()=>null,
        recovering:false, retryAgentControl:async()=>{ window.__retryCalls = (window.__retryCalls ?? 0) + 1; return null; }, retryOpen:()=>{}, runtimeOverride:null, status,
        setAgentControlEnabled:async(enabled, approvalMode="ask")=> {
          const next = { ...status, agentControlEnabled:enabled, humanControlReady:false, approvalMode };
          window.__lastApprovalMode = approvalMode;
          window.__controlCalls.push(enabled);
          setNative(next);
          return next;
        },
      };
      return h("main", { style:{ display:"flex", height:"100dvh", width:"100%", maxWidth:"900px" } },
        h(PersonalBrowserSurface, {
          active:true, compactChrome:true, model, humanInputIdentityKey:"user:project:conversation:personal",
          locationOptions:h(BrowserLocationOptions,{ checked:true,mode:"personal",personalAvailable:true,onModeChange:()=>{} }),
          onContinueAfterHumanInput:async(message)=> {
            window.__continuationAttempts = (window.__continuationAttempts ?? 0) + 1;
            if (window.__failNextContinuation) {
              window.__failNextContinuation = false;
              setAgentError("Fixture continuation failed; try Let Octo continue again");
              return false;
            }
            window.__continuation = message;
            setAgentError(null);
            setNative({agentControlEnabled:true,humanControlReady:false,approvalMode:"ask"});
            return true;
          },
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

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "coarse pointer" : "fine pointer", () => {
    test.use({ hasTouch });
    for (const width of [360, 900]) {
      test(`expands and waits for confirmed takeover before continuing at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await mountPersonalControls(page);
        expect(await page.evaluate(() => ({
          fine: matchMedia("(pointer: fine)").matches,
          coarse: matchMedia("(pointer: coarse)").matches,
        }))).toEqual({ fine: !hasTouch, coarse: hasTouch });
        const resume = page.getByRole("button", { name: "Resume agent control", exact: true });
        await expect(resume).toHaveCount(1);
        await expect(resume).toHaveAttribute("data-testid", "personal-browser-agent-status");
        await expect(resume).toHaveText("Resume");
        await resume.focus();
        // Control density follows the pointer, including a narrow mouse window
        // and a wide touch screen; viewport width does not choose the target size.
        const resumeBounds = (await resume.boundingBox())!;
        expect(resumeBounds.height).toBe(hasTouch ? 44 : 32);
        if (hasTouch) expect(resumeBounds.width).toBeGreaterThanOrEqual(44);
        await page.getByRole("button", { name: "Browser settings", exact: true }).click();
        await expect(page.getByTestId("personal-browser-routine-approval")).toBeChecked();
        await page.keyboard.press("Escape");
        await resume.focus();
        await resume.press("Enter");
        await expect.poll(() => page.evaluate(() => (window as { __lastApprovalMode?: string }).__lastApprovalMode)).toBe("routine");
        await page.getByTestId("browser-human-input-request").click();
        await expect(page.getByRole("dialog", { name: "Take over browser", exact: true })).toBeVisible();
        await page.getByTestId("browser-human-input-takeover").click();
        await expect(page.getByTestId("browser-human-input-controls")).toContainText("Waiting for agent control to stop");
        await expect(page.getByTestId("browser-human-input-continue")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Resume agent control", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Retry agent control", exact: true })).toHaveCount(0);

        await page.getByTestId("personal-browser-fullscreen-toggle").click();
        await expect(page.getByRole("dialog", { name: "Personal Browser", exact: true })).toBeVisible();
        await expect(page.getByTestId("browser-human-input-controls")).toContainText("Waiting for agent control to stop");
        await page.evaluate(() => (window as unknown as { __confirmNativeDrain: () => void }).__confirmNativeDrain());
        await expect(page.getByTestId("browser-human-input-continue")).toBeEnabled();
        await expect(page.getByRole("button", { name: "Resume agent control", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("browser-human-input-continue")).toHaveText("Let Octo continue");
        const screenshotPath = testInfo.outputPath(`personal-takeover-expanded-${width}px.png`);
        await page.screenshot({ animations: "disabled", path: screenshotPath });
        await testInfo.attach(`Expanded Personal takeover at ${width}px`, { contentType: "image/png", path: screenshotPath });
        await page.getByTestId("personal-browser-fullscreen-toggle").click();
        await expect(page.getByRole("dialog", { name: "Personal Browser", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("browser-human-input-continue")).toBeVisible();
        await page.evaluate(() => { (window as { __failNextContinuation?: boolean }).__failNextContinuation = true; });
        await page.getByTestId("browser-human-input-continue").click();
        await expect(page.getByTestId("browser-human-input-controls")).toContainText("browser task was not sent");
        await expect(page.getByRole("button", { name: "Resume agent control", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Retry agent control", exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => (window as { __controlCalls?: boolean[] }).__controlCalls)).toEqual([true, false]);
        expect(await page.evaluate(() => (window as { __retryCalls?: number }).__retryCalls ?? 0)).toBe(0);
        await expect(page.getByTestId("browser-human-input-continue")).toBeEnabled();
        await page.getByTestId("browser-human-input-continue").click();
        await expect.poll(() => page.evaluate(() => (window as { __continuation?: string }).__continuation)).toContain("Take a fresh snapshot");
        expect(await page.evaluate(() => (window as { __continuationAttempts?: number }).__continuationAttempts)).toBe(2);
        await expect(page.getByTestId("browser-human-input-request")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(errors).toEqual([]);
      });
    }
  });
}

// Production Shared Browser participant controls with two people and a local
// owner the test answers by hand, as the browser's collaboration socket would.
async function mountSharedControls(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const fixturePath = "/__shared-browser-control-focus__";
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { SharedBrowserCollaborationControls } from "/src/screens/studio/components/SharedBrowserCollaborationControls.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const person = (id, displayName, color) => ({ id, displayName, color, pageId: "page-1", cursor: null, canControl: true });
    window.__releases = 0;
    function Fixture() {
      const [controlOwner, setControlOwner] = React.useState({ kind: "human", participantId: "self" });
      window.__answerRelease = () => setControlOwner(null);
      const client = { connectionStatus: "connected", participantId: "self", error: null, state: {
        revision: 1, participants: [person("self", "Taylor", "#0ea5e9"), person("peer", "Anna", "#8b5cf6")], controlOwner, requests: [],
      } };
      return h("div", { className: "flex items-center gap-2 p-4" },
        h(SharedBrowserCollaborationControls, { client, compact: false, localControlOwner: { kind: "human" },
          onGrantControl: () => true, onRequestControl: () => true, onTakeControl: () => true,
          onReleaseControl: () => { window.__releases += 1; return true; } }));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${fixturePath}/main.js"></script></head><body><div id="root"></div></body></html>`;
  await page.route(`**${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${fixturePath}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(fixturePath);
}

test("a pressed Release keeps keyboard focus while the browser answers, then shows the new state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mountSharedControls(page);
  const action = page.getByTestId("shared-browser-collaboration-control-action");
  await expect(action).toHaveText("Release control");
  await action.focus();
  await page.keyboard.press("Enter");
  // Studio's pending button: a spinner announced as "Loading" that ignores
  // presses. Native `disabled` would move focus to the page body.
  await expect(action.getByRole("progressbar", { name: "Loading" })).toBeVisible();
  await expect(action).toHaveAttribute("aria-disabled", "true");
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as { __releases?: number }).__releases)).toBe(1);
  await page.evaluate(() => (window as unknown as { __answerRelease: () => void }).__answerRelease());
  await expect(action).toHaveText("Take control");
  await expect(action).not.toHaveAttribute("aria-disabled", "true");
  await expect(action).toBeFocused();
  await expect(page.getByTestId("shared-browser-collaboration-control-state")).toHaveText("Control available");
  expect(errors).toEqual([]);
});
