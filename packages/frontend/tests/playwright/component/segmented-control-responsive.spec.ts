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

  test("segmented choices retain 44px targets at phone width and support keyboard selection", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountControls(page);
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    await expectTargets(page, 44, 44);

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

  test("segmented choices retain 44px targets on wide touch screens", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountControls(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expectTargets(page, 44, 44);
    await page.getByTestId("xs-dark").tap();
    const appearance = page.getByRole("radiogroup", { name: "Appearance", exact: true });
    await expect(appearance.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await expect(appearance.getByRole("radio", { name: "Light", exact: true })).not.toBeChecked();
  });
});
