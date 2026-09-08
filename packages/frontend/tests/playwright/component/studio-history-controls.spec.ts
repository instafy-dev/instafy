import { expect, test } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

test("native history controls traverse Router entries with 44px targets and bounded forward state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const deps = await resolveViteReactDependencies(page);
  const routerSource = await (await page.request.get("/src/router.tsx")).text();
  const router = routerSource.match(/["'](\/node_modules\/\.vite[^/]*\/deps\/react-router-dom\.js\?v=[^"']+)["']/)?.[1];
  if (!router) throw new Error("Router dependency was not optimized");
  const main = `
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}';
    import ReactDomNS from '${deps.reactDomClient}';
    import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from '${router}';
    import { StudioHistoryControls } from '/src/navigation/StudioHistoryControls.tsx';
    const React=ReactNS.default??ReactNS, h=React.createElement, {createRoot}=ReactDomNS.default??ReactDomNS;
    function Fixture() {
      const location=useLocation(), navigate=useNavigate();
      return h('main',null,
        h(StudioHistoryControls),
        h(StudioHistoryControls,{enabled:true}),
        h('output',{'data-testid':'visit'},new URLSearchParams(location.search).get('visit')),
        ...['A','B','C','D'].map(visit=>h('button',{onClick:()=>navigate('?visit='+visit)},'Visit '+visit)),
        h('button',{onClick:()=>navigate(location.search+'&canonical=1',{replace:true})},'Canonical replace'),
        h('input',{'aria-label':'Inert text field'}));
    }
    createRoot(document.getElementById('root')).render(h(RouterProvider,{router:createBrowserRouter([{path:'*',element:h(Fixture)}])}));`;
  await page.route("**/__history_controls_main__.js", (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route("**/__studio_history_controls__?*", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/__history_controls_main__.js"></script>`,
  }));
  await page.goto("/__studio_history_controls__?visit=A");
  const controls = page.getByTestId("studio-history-controls");
  // The ordinary-web instance is absent; only the explicit shell fixture renders.
  await expect(controls).toHaveCount(1);
  const back = controls.getByRole("button", { name: "Go back", exact: true });
  const forward = controls.getByRole("button", { name: "Go forward", exact: true });
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    for (const button of [back, forward]) {
      const box = await button.boundingBox();
      expect(box?.width).toBe(44);
      expect(box?.height).toBe(44);
    }
  }
  const visit = page.getByTestId("visit");
  await page.getByRole("button", { name: "Visit B", exact: true }).click();
  await expect(visit).toHaveText("B");
  await page.getByRole("button", { name: "Visit C", exact: true }).click();
  await expect(visit).toHaveText("C");
  await back.click(); await expect(visit).toHaveText("B");
  await expect(forward).toBeEnabled();
  await page.getByRole("button", { name: "Canonical replace", exact: true }).click();
  await forward.click(); await expect(visit).toHaveText("C");
  await back.click(); await expect(visit).toHaveText("B");
  expect(new URL(page.url()).searchParams.get("canonical")).toBe("1");
  await back.click(); await expect(visit).toHaveText("A");
  await expect(back).toBeDisabled();
  await page.getByRole("button", { name: "Visit D", exact: true }).click();
  await expect(visit).toHaveText("D");
  await expect(forward).toBeDisabled();
  // Text editing is not an app-navigation shortcut.
  const input = page.getByRole("textbox", { name: "Inert text field" });
  await input.fill("inert"); await input.press("Backspace");
  await expect(input).toHaveValue("iner"); await expect(visit).toHaveText("D");
  expect(errors).toEqual([]);
});
