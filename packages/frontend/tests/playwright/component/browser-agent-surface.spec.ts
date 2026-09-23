import { expect, test } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

test.use({ hasTouch: true });

for (const width of [390, 1100]) {
  test(`surface handoff stays readable and reversible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const deps = await resolveViteReactDependencies(page);
    const fixturePath = "/__browser-agent-surface__";
    await page.route(`**${fixturePath}/main.js`, route => route.fulfill({ contentType: "application/javascript", body: `
      import "/src/styles/tailwind.css";
      import ReactNS from "${deps.react}";
      import ReactDomClientNS from "${deps.reactDomClient}";
      import { BrowserAgentSurface } from "/src/screens/studio/components/BrowserAgentSurface.tsx";
      import { BrowserHumanInputStatus } from "/src/screens/studio/components/BrowserHumanInputControls.tsx";
      import { useBrowserHumanInput } from "/src/screens/studio/components/useBrowserHumanInput.ts";
      const React = ReactNS.default ?? ReactNS;
      const {createRoot} = ReactDomClientNS.default ?? ReactDomClientNS;
      const h = React.createElement;
      function Fixture() {
        const [agent,setAgent] = React.useState(true);
        const [working,setWorking] = React.useState(true);
        const options = {identityKey:"fixture",request:null,canTakeOver:agent,humanControlConfirmed:!agent,
          onTakeOver:async()=>{setAgent(false);return true;},onContinue:async()=>{setAgent(true);return true;}};
        const state = useBrowserHumanInput(options);
        return h("main",null,
          h("div",{role:"toolbar","aria-label":"Browser",style:{height:50,display:"flex",justifyContent:"space-between"}},
            h("button",{onClick:()=>setWorking(!working)},"Toggle activity"),h(BrowserHumanInputStatus,{...options,state})),
          h("section",{style:{position:"relative",height:600,padding:24}},
            h("h1",null,"A readable page"),h("label",null,"Reading note",h("input",{"aria-label":"Reading note",defaultValue:"Preserve this note"})),
            agent ? h(BrowserAgentSurface,{working,onTakeOver:state.requestTakeOver}) : null));
      }
      createRoot(document.getElementById("root")).render(h(Fixture));
    ` }));
    await page.route(`**${fixturePath}`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
      </head><body><div id="root"></div><script type="module" src="${fixturePath}/main.js"></script></body></html>` }));
    await page.goto(fixturePath);
    const surface = page.getByTestId("browser-agent-surface");
    const target = page.getByTestId("browser-agent-surface-takeover");
    await expect(surface).toHaveAttribute("data-working", "true");
    await expect(page.getByRole("heading", { name: "A readable page" })).toBeVisible();
    // A click aimed at a field reaches the overlay, never the underlying input.
    const field = page.getByRole("textbox", { name: "Reading note" });
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 10, box!.y + 10);
    await expect(page.getByRole("dialog", { name: "Take over browser" })).toBeVisible();
    await page.getByRole("button", { name: "Keep AI working" }).click();
    await expect(target).toBeFocused();
    await expect(field).toHaveValue("Preserve this note");
    await target.press("Enter");
    await page.getByRole("button", { name: "Take over", exact: true }).click();
    await expect(surface).toHaveCount(0);
    await field.fill("Manual changes survive continuation");
    const continueButton = page.getByRole("button", { name: "Let AI continue", exact: true });
    expect(await continueButton.evaluate(el => ({coarse: matchMedia("(pointer: coarse)").matches, minHeight: getComputedStyle(el).minHeight}))).toEqual({coarse: true, minHeight: "44px"});
    await continueButton.click();
    await expect(surface).toBeVisible();
    await expect(field).toHaveValue("Manual changes survive continuation");
    await page.getByRole("button", { name: "Toggle activity" }).click();
    await expect(surface).toHaveAttribute("data-working", "false");
    const mosaic = page.locator(".browser-agent-mosaic");
    await expect.poll(() => mosaic.evaluate(el => getComputedStyle(el, "::before").animationPlayState)).toBe("paused");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Toggle activity" }).click();
    await expect.poll(() => mosaic.evaluate(el => getComputedStyle(el, "::before").animationName)).toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
