import { expect, test, type Locator, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__organization-rail-reorder__";
const TEAM_KEYS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

async function mountRail(page: Page, overflow = false, titleBarFree = false) {
  const deps = await resolveViteReactDependencies(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`**${FIXTURE}`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="${FIXTURE}.js"></script>
      </head><body><div id="root"></div></body></html>`,
  }));
  await page.route(`**${FIXTURE}.js`, route => route.fulfill({
    contentType: "application/javascript",
    body: `import '/src/styles/tailwind.css';
      import ReactNS from '${deps.react}';
      import ReactDOMNS from '${deps.reactDomClient}';
      import { StudioOrganizationRail } from '/src/screens/studio/components/StudioOrganizationRail.tsx';
      const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
      const organizations=${JSON.stringify(TEAM_KEYS.slice(0, overflow ? TEAM_KEYS.length : 3))}.map(key=>({
        key,name:'Team '+key,label:'Team '+key,slug:key,count:1,
      }));
      function Fixture() {
        const [selected,setSelected]=R.useState('two');
        const [selectionCount,setSelectionCount]=R.useState(0);
        const browseButtonRef=R.useRef(null);
        return h('main',{style:{display:'flex',height:'${overflow ? 440 : 640}px'}},
          h(StudioOrganizationRail,{
            userId:'rail-test-user',organizations,selectedOrgKey:selected,homeActive:false,
            titleBarFree:${titleBarFree},browseButtonRef,
            onHome:()=>{},onBrowseOrganizations:()=>{},onCreateOrganization:()=>{},
            onOpenOrganizationOverview:()=>{},onOpenOrganizationSettings:()=>{},
            onSelectOrganization:key=>{setSelected(key);setSelectionCount(value=>value+1);},
            account:h('button',{'data-testid':'rail-account',style:{width:'44px',height:'44px'}},'Account'),
          }),
          h('div',null,h('output',{'data-testid':'rail-selected'},selected),
            h('output',{'data-testid':'rail-selection-count'},String(selectionCount))));
      }
      createRoot(document.getElementById('root')).render(h(Fixture));`,
  }));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("sidebar-team-one")).toBeVisible();
  return errors;
}

async function railOrder(page: Page) {
  return page.getByTestId("sidebar-team-rail-list").locator("button[data-testid]").evaluateAll(buttons =>
    buttons.map(button => button.getAttribute("data-testid")!.replace("sidebar-team-", "")));
}

async function center(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
}

async function startMouseDrag(page: Page, from: string, to: string) {
  const source = await center(page.getByTestId(`sidebar-team-${from}`));
  const target = await center(page.getByTestId(`sidebar-team-${to}`));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  // Cross the activation distance before moving over the destination.
  await page.mouse.move(source.x, source.y + (target.y < source.y ? -12 : 12), { steps: 3 });
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(1);
  await page.mouse.move(target.x, target.y, { steps: 12 });
}

async function fixedControls(page: Page) {
  return Promise.all(["sidebar-home-button", "sidebar-rail-actions", "sidebar-org-new", "sidebar-browse-teams", "rail-account"]
    .map(async testId => ({ testId, bounds: await page.getByTestId(testId).boundingBox() })));
}

async function activateMenuItemWithKeyboard(page: Page, testId: string) {
  const menu = page.getByRole("menu");
  const item = page.getByTestId(testId);
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  const count = await menu.getByRole("menuitem").count();
  for (let index = 0; index < count; index += 1) {
    if (await item.evaluate(element => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
}

test.describe("mouse and keyboard", () => {
  test.use({ hasTouch: false, viewport: { width: 1280, height: 800 } });

  for (const titleBarFree of [false, true]) {
    test(`dragging reorders teams without selecting them and survives reload (${titleBarFree ? "desktop title bar" : "standard rail"})`, async ({ page }) => {
      const errors = await mountRail(page, false, titleBarFree);
      const controls = await fixedControls(page);
      await expect.poll(() => railOrder(page)).toEqual(["one", "two", "three"]);

      await startMouseDrag(page, "three", "one");
      await page.mouse.up();
      await expect.poll(() => railOrder(page)).toEqual(["three", "one", "two"]);
      await expect(page.getByTestId("rail-selected")).toHaveText("two");
      await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
      expect(await fixedControls(page)).toEqual(controls);

      await page.reload();
      await expect.poll(() => railOrder(page)).toEqual(["three", "one", "two"]);
      await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
      await page.getByTestId("sidebar-team-one").click();
      await expect(page.getByTestId("rail-selected")).toHaveText("one");
      await expect(page.getByTestId("rail-selection-count")).toHaveText("1");
      await expect(page.getByTestId("sidebar-team-one")).toHaveAttribute("aria-current", "page");
      expect(errors).toEqual([]);
    });
  }

  test("Escape cancels a drag without selecting or persisting a new order", async ({ page }) => {
    const errors = await mountRail(page);
    await startMouseDrag(page, "one", "three");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => railOrder(page)).toEqual(["one", "two", "three"]);
    await expect(page.getByTestId("rail-selected")).toHaveText("two");
    await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
    await page.reload();
    await expect.poll(() => railOrder(page)).toEqual(["one", "two", "three"]);
    expect(errors).toEqual([]);
  });

  test("Shift+F10 exposes keyboard reorder actions with boundary and focus handling", async ({ page }) => {
    const errors = await mountRail(page);
    const third = page.getByTestId("sidebar-team-three");
    await third.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("sidebar-org-context-move-down")).toHaveAttribute("aria-disabled", "true");
    await activateMenuItemWithKeyboard(page, "sidebar-org-context-move-up");
    await expect.poll(() => railOrder(page)).toEqual(["one", "three", "two"]);
    await expect(third).toBeFocused();
    await expect(page.getByTestId("rail-selection-count")).toHaveText("0");

    await page.keyboard.press("Shift+F10");
    await activateMenuItemWithKeyboard(page, "sidebar-org-context-move-down");
    await expect.poll(() => railOrder(page)).toEqual(["one", "two", "three"]);
    await expect(third).toBeFocused();
    await expect(page.getByTestId("rail-selected")).toHaveText("two");
    await expect(page.getByTestId("rail-selection-count")).toHaveText("0");

    const first = page.getByTestId("sidebar-team-one");
    await first.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("sidebar-org-context-move-up")).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-org-context-menu")).toHaveCount(0);
    await expect(first).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("overflow scrolls only the teams while Home and footer stay fixed", async ({ page }) => {
    const errors = await mountRail(page, true);
    const controls = await fixedControls(page);
    const list = page.getByTestId("sidebar-team-rail-list");
    const rowHeights = await page.getByTestId("sidebar-team-one").evaluate(button => ({
      button: button.getBoundingClientRect().height,
      wrapper: button.parentElement!.getBoundingClientRect().height,
    }));
    expect(rowHeights.button).toBe(44);
    expect(rowHeights.wrapper).toBe(rowHeights.button);
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await list.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId("sidebar-team-eight")).toBeInViewport();
    expect(await fixedControls(page)).toEqual(controls);
    await expect.poll(() => railOrder(page)).toEqual(TEAM_KEYS);
    await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
    expect(errors).toEqual([]);
  });
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

  test("an immediate touch swipe scrolls teams without reordering or selecting", async ({ page }) => {
    const errors = await mountRail(page, true);
    const list = page.getByTestId("sidebar-team-rail-list");
    const controls = await fixedControls(page);
    const touch = await page.context().newCDPSession(page);
    const source = await center(page.getByTestId("sidebar-team-three"));
    const target = await center(page.getByTestId("sidebar-team-one"));
    try {
      // Moving immediately exceeds the hold tolerance and must remain a native scroll.
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [source] });
      for (let step = 1; step <= 6; step += 1) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
          x: source.x, y: source.y + (target.y - source.y) * step / 6,
        }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => railOrder(page)).toEqual(TEAM_KEYS);
      await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
      expect(await fixedControls(page)).toEqual(controls);
      expect(errors).toEqual([]);
    } finally {
      await touch.detach();
    }
  });

  test("a held touch reorders teams without selecting and leaves taps usable", async ({ page }) => {
    const errors = await mountRail(page, true);
    const controls = await fixedControls(page);
    const touch = await page.context().newCDPSession(page);
    try {
      const dragSource = await center(page.getByTestId("sidebar-team-three"));
      const dragTarget = await center(page.getByTestId("sidebar-team-one"));
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [dragSource] });
      // Wait through the production sensor's hold delay before moving.
      await expect(page.locator('[data-dragging="true"]')).toHaveCount(1);
      for (let step = 1; step <= 8; step += 1) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
          x: dragSource.x, y: dragSource.y + (dragTarget.y - dragSource.y) * step / 8,
        }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => railOrder(page)).toEqual(["three", "one", "two", ...TEAM_KEYS.slice(3)]);
      await expect(page.getByTestId("rail-selected")).toHaveText("two");
      await expect(page.getByTestId("rail-selection-count")).toHaveText("0");
      expect(await fixedControls(page)).toEqual(controls);
      await page.getByTestId("sidebar-team-one").tap();
      await expect(page.getByTestId("rail-selected")).toHaveText("one");
      await expect(page.getByTestId("rail-selection-count")).toHaveText("1");
      expect(errors).toEqual([]);
    } finally {
      await touch.detach();
    }
  });
});
