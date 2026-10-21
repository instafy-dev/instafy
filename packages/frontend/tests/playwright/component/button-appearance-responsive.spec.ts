import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__button-appearance-responsive__";

async function mountButtons(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  await page.route(`**${FIXTURE}`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>button { transition-duration: 0s !important; }</style>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="${FIXTURE}.js"></script></head><body><div id="root"></div></body></html>`,
  }));
  await page.route(`**${FIXTURE}.js`, route => route.fulfill({
    contentType: "application/javascript",
    body: `import '/src/styles/tailwind.css';
      import ReactNS from '${deps.react}';
      import ReactDOMNS from '${deps.reactDomClient}';
      import { Button, IconButton } from '/src/components/Button.tsx';
      const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
      function Example() {
        const [presses,setPresses]=R.useState(0);
        return h('main',{className:'flex flex-wrap items-start gap-4 p-4'},
          ...['xs','sm','md','lg'].flatMap(size=>[
            h(Button,{key:'button-'+size,size,'data-testid':'button-'+size},'Go'),
            h(IconButton,{key:'icon-'+size,size,'aria-label':'Icon '+size,'data-testid':'icon-'+size},'×')]),
          ...['ghost','outline'].map(variant=>h(Button,{key:'toolbar-'+variant,preset:'toolbar',variant,'data-testid':'toolbar-'+variant},
            h('span',{style:{width:24,height:24,borderRadius:'50%',background:'gray'},'aria-hidden':true}), 'Participants')),
          h(Button,{variant:'text',tone:'muted',size:'xs','data-testid':'text'},'Edit'),
          h(Button,{variant:'ghost',tone:'danger','data-testid':'danger',onPress:()=>setPresses(n=>n+1)},'Delete'),
          h(Button,{variant:'outline',tone:'danger','data-testid':'danger-outline'},'Remove'),
          h(Button,{variant:'text',tone:'danger',isDisabled:true,'data-testid':'disabled',onPress:()=>setPresses(n=>n+1)},'Disabled'),
          h('output',{'data-testid':'presses'},presses));
      }
      createRoot(document.getElementById('root')).render(h(Example));`,
  }));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("text")).toBeVisible();
}

const color = (page: Page, id: string) => page.getByTestId(id).evaluate(el => getComputedStyle(el).color);
const background = (page: Page, id: string) => page.getByTestId(id).evaluate(el => getComputedStyle(el).backgroundColor);

async function expectTouchTargets(page: Page) {
  for (const id of ["button-xs", "button-sm", "button-md", "button-lg", "icon-xs", "icon-sm", "icon-md", "icon-lg", "text", "toolbar-ghost", "toolbar-outline"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height, id).toBeGreaterThanOrEqual(44);
    expect(box!.width, id).toBeGreaterThanOrEqual(44);
  }
}

test.describe("fine pointer", () => {
  test.use({ hasTouch: false });
  for (const width of [390, 1280]) {
    test(`all sizes and text actions retain compact fine-pointer density at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mountButtons(page);
      expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
      for (const [id, height] of [["button-xs", 24], ["button-sm", 32], ["button-md", 36], ["button-lg", 44], ["icon-xs", 24], ["icon-sm", 32], ["icon-md", 36], ["icon-lg", 40], ["text", 16], ["toolbar-ghost", 32], ["toolbar-outline", 32]] as const) {
        expect((await page.getByTestId(id).boundingBox())!.height, id).toBe(height);
      }
      expect((await page.getByTestId("icon-xs").boundingBox())!.width).toBe(24);
      expect((await page.getByTestId("text").boundingBox())!.width).toBeLessThan(44);
      for (const id of ["toolbar-ghost", "toolbar-outline"]) {
        await expect(page.getByTestId(id)).toHaveCSS("border-radius", "8px");
        expect((await page.getByTestId(id).boundingBox())!.width).toBeGreaterThan(44);
      }
    });
  }

  for (const dark of [false, true]) {
    test(`quiet tones own hover and pressed colors, text stays unfilled (${dark ? "dark" : "light"})`, async ({ page }) => {
      await mountButtons(page);
      if (dark) await page.locator("html").evaluate(el => el.classList.add("dark"));
      const idleDanger = await color(page, "danger");
      expect(await color(page, "danger-outline")).toBe(idleDanger);
      const idleTextBackground = await background(page, "text");
      await page.getByTestId("text").hover();
      await expect.poll(() => background(page, "text")).toBe(idleTextBackground);
      await page.mouse.down();
      await expect.poll(() => background(page, "text")).toBe(idleTextBackground);
      await page.mouse.up();
      await page.getByTestId("danger").hover();
      await expect.poll(() => color(page, "danger")).not.toBe(idleDanger);
      const hoverDanger = await color(page, "danger");
      await page.mouse.down();
      await expect(page.getByTestId("danger")).toHaveAttribute("data-pressed", "true");
      await expect.poll(() => color(page, "danger")).not.toBe(hoverDanger);
      expect(await color(page, "danger")).not.toBe(await color(page, "text"));
      await page.mouse.up();
      await expect(page.getByTestId("presses")).toHaveText("1");
      await expect(page.getByTestId("disabled")).toBeDisabled();
      await page.getByTestId("disabled").evaluate((el: HTMLButtonElement) => el.click());
      await expect(page.getByTestId("presses")).toHaveText("1");
    });
  }
});

test.describe("coarse pointer", () => {
  test.use({ hasTouch: true });
  for (const width of [390, 1280]) {
    test(`all sizes keep 44px targets with a coarse pointer at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await mountButtons(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expectTouchTargets(page);
      await page.getByTestId("danger").tap();
      await expect(page.getByTestId("presses")).toHaveText("1");
    });
  }
});
