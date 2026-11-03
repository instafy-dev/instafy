import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__segmented-control-responsive__";

async function mountControls(page: Page) {
  const deps = await resolveViteReactDependencies(page);
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
      import { SegmentedControl } from '/src/components/SegmentedControl.tsx';
      const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
      function Choices({size,label}) {
        const [value,setValue]=R.useState('light');
        return h(SegmentedControl,{label,size,value,onChange:setValue,width:'fit',options:[
          {value:'light',label:'Light',testId:size+'-light'},
          {value:'dark',label:'Dark',testId:size+'-dark'},
          {value:'week',label:'7D',testId:size+'-week'}
        ]});
      }
      createRoot(document.getElementById('root')).render(h('main',{className:'space-y-4 p-4'},
        h('button',null,'Before choices'),
        h('div',null,h(Choices,{size:'xs',label:'Appearance'})),
        h('div',null,h(Choices,{size:'sm',label:'Preview appearance'})),
        h('button',null,'After choices')));`,
  }));
  await page.goto(FIXTURE);
  await expect(page.getByRole("radiogroup", { name: "Appearance", exact: true })).toBeVisible();
}

async function expectTargets(page: Page, xs: number, sm: number) {
  for (const [size, height] of [["xs", xs], ["sm", sm]] as const) {
    for (const value of ["light", "dark", "week"]) {
      // React Aria's visually hidden input delegates the complete hit target
      // to its production label. Measure that target, not the hidden input.
      await expect.poll(async () => (await page.getByTestId(`${size}-${value}`).boundingBox())?.height)
        .toBe(height);
      const width = (await page.getByTestId(`${size}-${value}`).boundingBox())!.width;
      if (height === 44) expect(width).toBeGreaterThanOrEqual(44);
      else if (value === "week") expect(width).toBeLessThan(44);
    }
  }
}

test.describe("fine pointer", () => {
  test.use({ hasTouch: false });

  test("segmented choices stay compact at narrow mouse widths and support keyboard selection", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountControls(page);
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    await expectTargets(page, 28, 36);

    const appearance = page.getByRole("radiogroup", { name: "Appearance", exact: true });
    const light = appearance.getByRole("radio", { name: "Light", exact: true });
    const dark = appearance.getByRole("radio", { name: "Dark", exact: true });
    await expect(light).toBeChecked();
    await expect(dark).not.toBeChecked();
    await page.getByRole("button", { name: "Before choices" }).focus();
    await page.keyboard.press("Tab");
    await expect(light).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dark).toBeFocused();
    await expect(dark).toBeChecked();
    await expect(light).not.toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(appearance.getByRole("radio", { name: "7D", exact: true })).toBeFocused();
    await expect(appearance.getByRole("radio", { name: "7D", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(light).toBeFocused();
    await expect(light).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radiogroup", { name: "Preview appearance" }).getByRole("radio", { name: "Light", exact: true })).toBeFocused();
  });

  test("segmented choices use compact targets on wide fine-pointer screens", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountControls(page);
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    await expectTargets(page, 28, 36);
  });
});

test.describe("touch pointer", () => {
  test.use({ hasTouch: true });

  for (const width of [390, 1280]) {
    test(`segmented choices retain 44px targets on ${width}px touch screens`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mountControls(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expectTargets(page, 44, 44);
      await page.getByTestId("xs-dark").tap();
      const appearance = page.getByRole("radiogroup", { name: "Appearance", exact: true });
      await expect(appearance.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
      await expect(appearance.getByRole("radio", { name: "Light", exact: true })).not.toBeChecked();
    });
  }
});

// A local test, Nov 3: Credits showed its Usage section under Activity | Plans
// | Usage with Activity still looking chosen. The chosen segment's surface
// cross-faded over 150 ms, and a look right after the press found Activity a
// quarter of the way out and Usage a quarter of the way in.
test("a section's tab is chosen in the frame its section shows", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.emulateMedia({ colorScheme: "dark" });
  const deps = await resolveViteReactDependencies(page);
  const fixture = "/__settings-section-tabs__";
  await page.route(`**${fixture}`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="dark"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="${fixture}.js"></script>
      </head><body><div id="root"></div></body></html>`,
  }));
  await page.route(`**${fixture}.js`, route => route.fulfill({
    contentType: "application/javascript",
    body: `import '/src/styles/tailwind.css';
      import ReactNS from '${deps.react}';
      import ReactDOMNS from '${deps.reactDomClient}';
      import { SettingsShell } from '/src/screens/studio/components/SettingsShell.tsx';
      const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
      function Credits() {
        const [section,setSection]=R.useState('activity');
        return h(SettingsShell,{title:'Credits',navLabel:'Sections',activeCategoryId:section,onCategoryChange:setSection,categories:[
          {id:'activity',label:'Activity',testId:'section-activity'},
          {id:'plans',label:'Plans',testId:'section-plans'},
          {id:'usage',label:'Usage',testId:'section-usage'}
        ]},h('p',{'data-testid':'section-shown'},section));
      }
      createRoot(document.getElementById('root')).render(h('main',{className:'min-h-dvh bg-slate-950'},h(Credits)));`,
  }));
  await page.goto(fixture);
  await expect(page.getByTestId("section-shown")).toHaveText("activity");
  const chosen = await page.getByTestId("section-activity").evaluate((tab) => getComputedStyle(tab).backgroundColor);
  // Every frame from the press: which section shows, and each tab's surface.
  await page.evaluate(() => {
    const frames: string[][] = [];
    (window as unknown as { __frames: string[][] }).__frames = frames;
    const sample = () => {
      frames.push([
        document.querySelector('[data-testid="section-shown"]')?.textContent ?? "",
        ...["activity", "usage"].map((id) => getComputedStyle(document.querySelector(`[data-testid="section-${id}"]`)!).backgroundColor),
      ]);
      if (frames.length < 30) requestAnimationFrame(sample);
    };
    document.querySelector('[data-testid="section-usage"]')!.addEventListener("pointerdown", () => requestAnimationFrame(sample), { once: true });
  });
  await page.getByTestId("section-usage").click();
  await expect(page.getByTestId("section-shown")).toHaveText("usage");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __frames: string[][] }).__frames.length)).toBe(30);
  const frames = await page.evaluate(() => (window as unknown as { __frames: string[][] }).__frames);
  expect(frames.filter(([section]) => section === "usage")
    .filter(([, activity, usage]) => usage !== chosen || activity === chosen)).toEqual([]);
});
