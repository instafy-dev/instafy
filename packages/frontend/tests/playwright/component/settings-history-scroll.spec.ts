import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__settings-history-scroll-fixture__";

async function mountSettings(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const routeModule = await page.request.get("/src/screens/studio/settingsRoute.ts");
  expect(routeModule.ok()).toBe(true);
  const routerUrl = (await routeModule.text()).match(/["'](\/node_modules\/\.vite(?:-browser-ui-ci)?\/deps\/react-router-dom\.js\?v=[^"']+)["']/)?.[1];
  if (!routerUrl) throw new Error("Could not resolve Settings' router dependency");
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { BrowserRouter, useLocation, useNavigate } from "${routerUrl}";
    import { SettingsShell } from "/src/screens/studio/components/SettingsShell.tsx";
    import { useSettingsRoute, buildSettingsSectionSearch } from "/src/screens/studio/settingsRoute.ts";
    import { StudioPanelScrollContainer, buildStudioPanelScrollIdentity } from "/src/navigation/StudioPanelScrollContainer.tsx";
    import { getStudioVisitKey } from "/src/navigation/studioVisit.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    function Fixture() {
      const location = useLocation(); const navigate = useNavigate();
      const route = useSettingsRoute("profile");
      const [filter, setFilter] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const categories = {
        profile: [{id:"account", label:"Account"}, {id:"preferences", label:"Preferences"}],
        org: [{id:"members", label:"Members"}, {id:"billing", label:"Billing"}],
        project: [{id:"overview", label:"Overview"}, {id:"ai", label:"Voice & audio", children:[{id:"speech", label:"Speech"}, {id:"audio", label:"Audio"}]}],
      }[route.tab];
      const identity = buildStudioPanelScrollIdentity({ userId:"fixture-user", projectId:"fixture-project", visitKey:getStudioVisitKey(location), panel:"settings", section:JSON.stringify([route.tab,route.category,route.itemId]) });
      const long = route.category === "account" || route.category === "members";
      return h("div", null,
        h("header", {style:{height:70, display:"flex", gap:8, alignItems:"center"}},
          ...["profile","org","project"].map((tab) => h("button", {key:tab, onClick:() => navigate({search:"?" + buildSettingsSectionSearch(location.search,tab,{profile:"account",org:"members",project:"overview"}[tab])})}, tab)),
          h("button", {onClick:() => route.selectSection(categories[1].id)}, "Next category"),
          h("button", {onClick:() => setLoading(!loading)}, loading ? "Finish loading" : "Delay content"),
          h("input", {"aria-label":"Local filter", value:filter, onChange:(event) => setFilter(event.target.value)})),
        h("output", {"data-testid":"section"}, JSON.stringify([route.tab,route.category,route.itemId])),
        h(StudioPanelScrollContainer, {identity,ready:true,"data-testid":"settings-scroll",className:"overflow-y-auto",},
          h(SettingsShell, {title:"Settings", categories, activeCategoryId:route.category,
            onCategoryChange:route.selectSection, activeChildCategoryId:route.itemId ?? "speech",
            onChildCategoryChange:(item) => route.selectSection("ai",item)},
            h("div", {style:{height:loading ? 40 : long ? 1800 : 120}}, "Inert settings content"))));
    }
    createRoot(document.getElementById("root")).render(h(BrowserRouter,null,h(Fixture)));`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body{margin:0}[data-testid=settings-scroll]{height:400px;overflow:auto;overflow-anchor:none}</style>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}*`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.goto(`${FIXTURE_PATH}?panel=settings&settingsTab=profile`);
}

test("restores URL-driven settings categories and per-visit scroll with browser Back and Forward", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountSettings(page);
  const section = page.getByTestId("section");
  const port = page.getByTestId("settings-scroll");
  await expect(section).toHaveText('["profile","account",null]');
  const initialHistory = await page.evaluate(() => history.length);
  await page.getByLabel("Local filter").fill("local only");
  expect(await page.evaluate(() => history.length)).toBe(initialHistory);
  await port.evaluate((element) => { element.scrollTop = 725; });
  await page.getByRole("button", { name: "Next category", exact: true }).click();
  await expect(section).toHaveText('["profile","preferences",null]');
  expect(await page.evaluate(() => history.length)).toBe(initialHistory + 1);
  await page.getByRole("button", { name: "Next category", exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(initialHistory + 1);
  await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Delay content", exact: true }).click();
  await page.goBack();
  await expect(section).toHaveText('["profile","account",null]');
  await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBe(0);
  // Complete async content without a user gesture in the restoring scrollport.
  await page.getByRole("button", { name: "Finish loading", exact: true }).click();
  await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBe(725);
  await page.goForward(); await expect(section).toHaveText('["profile","preferences",null]');
  await page.getByRole("button", { name: "org", exact: true }).click();
  await expect(section).toHaveText('["org","members",null]');
  await port.evaluate((element) => { element.scrollTop = 550; });
  await page.getByRole("button", { name: "Next category", exact: true }).click();
  await expect(section).toHaveText('["org","billing",null]');
  await page.goBack(); await expect(section).toHaveText('["org","members",null]');
  await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBe(550);
  await page.getByRole("button", { name: "project", exact: true }).click();
  await page.getByRole("button", { name: "Next category", exact: true }).click();
  await expect(section).toHaveText('["project","ai",null]');
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await expect(section).toHaveText('["project","ai","audio"]');
  await page.goBack(); await expect(section).toHaveText('["project","ai",null]');
  await page.goBack(); await expect(section).toHaveText('["project","overview",null]');
  await page.goForward(); await expect(section).toHaveText('["project","ai",null]');
  expect(errors).toEqual([]);
});
