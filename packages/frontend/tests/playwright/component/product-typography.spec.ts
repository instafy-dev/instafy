import { expect, test, type Locator, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__product-typography-fixture__";

async function mountFixture(page: Page, dark: boolean): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const menuModule = await page.request.get("/src/components/aria/StudioMenu.tsx");
  expect(menuModule.ok(), "Vite transforms the actual menu component").toBe(true);
  const ariaModule = (await menuModule.text()).match(
    /["'](\/node_modules\/[^"']+\/react-aria-components\.js\?v=[^"']+)["']/,
  )?.[1];
  if (!ariaModule) throw new Error("Could not resolve the actual React Aria dependency");

  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { MenuTrigger } from "${ariaModule}";
    import { Text } from "/src/components/Text.tsx";
    import { Button } from "/src/components/Button.tsx";
    import { Input } from "/src/components/Input.tsx";
    import { Select } from "/src/components/Select.tsx";
    import { StudioMenu, StudioMenuItem } from "/src/components/aria/StudioMenu.tsx";
    import { StudioPopover } from "/src/components/aria/StudioPopover.tsx";
    import { SettingsSection } from "/src/screens/studio/components/SettingsSection.tsx";
    import { ChatInput } from "/src/screens/studio/components/chat-input/ChatInput.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;

    function Fixture() {
      const [submitted, setSubmitted] = React.useState("");
      const [action, setAction] = React.useState("");
      const [draft, setDraft] = React.useState("");
      const [editorState, setEditorState] = React.useState(null);
      return h("main", {
        "data-testid": "typography-fixture",
        style: { width: "100%", maxWidth: "720px", padding: "16px", margin: "0 auto" },
      },
        h(Text, { "data-testid": "body-copy" }, "Review reports and choose the next useful action."),
        h(Text, { className: "leading-tight", "data-testid": "tight-body-copy" }, "A caller can keep a tighter line height."),
        h(Text, { className: "text-xs leading-snug", "data-testid": "small-body-copy" }, "A caller can set both size and line height."),
        h(Text, { variant: "caption", "data-testid": "caption-copy" }, "Changes stay in this local fixture."),
        h(Text, { as: "code", variant: "mono", "data-testid": "code-copy" }, "pnpm test"),
        h(SettingsSection, {
          title: "Workspace preferences",
          description: "Choose a review mode for this workspace.",
          "data-testid": "settings-section",
          actions: h(MenuTrigger, null,
            h(Button, { size: "xs", "aria-label": "Workspace actions" }, "Actions"),
            h(StudioPopover, { placement: "bottom end", style: { width: "230px", maxWidth: "calc(100vw - 32px)" } },
              h(StudioMenu, { "aria-label": "Workspace actions", onAction: (key) => setAction(String(key)) },
                h(StudioMenuItem, { id: "review" }, "Review reports"),
                h(StudioMenuItem, { id: "settings" }, "Open settings"),
              ),
            ),
          ),
        },
          h("form", {
            "aria-label": "Workspace preferences",
            style: { display: "grid", gap: "12px" },
            onSubmit: (event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              setSubmitted(String(values.get("workspace")) + " / " + String(values.get("mode")));
            },
          },
            h(Text, { as: "label", htmlFor: "workspace-name", variant: "caption" }, "Workspace name"),
            h(Input, { id: "workspace-name", name: "workspace", size: "sm", defaultValue: "Typography review", required: true }),
            h(Text, { as: "label", htmlFor: "review-mode", variant: "caption" }, "Review mode"),
            h(Select, { id: "review-mode", name: "mode", size: "sm", defaultValue: "manual" },
              h("option", { value: "manual" }, "Manual review"),
              h("option", { value: "automatic" }, "Automatic review"),
            ),
            h(Input, { "aria-label": "Filter reports", size: "xs", placeholder: "Filter reports" }),
            h(Select, { "aria-label": "Report status", size: "xs", defaultValue: "open" },
              h("option", { value: "open" }, "Open reports"),
              h("option", { value: "closed" }, "Closed reports"),
            ),
            h(Button, { type: "submit", size: "sm" }, "Save preferences"),
          ),
        ),
        h("section", { "aria-label": "Message composer", style: { marginTop: "24px" } },
          h(ChatInput, {
            value: draft, editorState, placeholder: "Write a message", agentHandles: [],
            compactViewport: window.innerWidth < 640,
            onChange: (value, state) => { setDraft(value); setEditorState(state); },
            onKeyDown: () => {},
          }),
        ),
        h("output", { "data-testid": "saved-preferences" }, submitted),
        h("output", { "data-testid": "selected-action" }, action),
        h("output", { "data-testid": "draft-value", style: { display: "block", overflowWrap: "anywhere" } }, draft),
      );
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html class="${dark ? "dark" : ""}"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body class="bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100"><div id="root"></div></body></html>`;

  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill({
    contentType: "application/javascript", body: "export const controllerClient = {};",
  }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByRole("heading", { name: "Workspace preferences" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(errors).toEqual([]);
  return errors;
}

async function expectTypography(locator: Locator, family: string, size: number, lineHeight: number) {
  await expect(locator).toHaveCSS("font-family", family);
  await expect(locator).toHaveCSS("font-size", `${size}px`);
  await expect(locator).toHaveCSS("line-height", `${lineHeight}px`);
}

async function expectContained(locator: Locator) {
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth, overflow: element.scrollWidth - element.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
}

for (const width of [360, 1024]) {
  for (const dark of [false, true]) {
    test(`product typography and keyboard controls at ${width}px in ${dark ? "dark" : "light"} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      const errors = await mountFixture(page, dark);
      const family = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
      expect(family.split(",")[0].trim()).toBe("-apple-system");
      expect(family).toContain("system-ui");
      expect(family).not.toContain("Inter");

      await expectTypography(page.getByTestId("body-copy"), family, 14, width >= 900 ? 21 : 22.75);
      await expectTypography(page.getByTestId("tight-body-copy"), family, 14, 17.5);
      await expectTypography(page.getByTestId("small-body-copy"), family, 12, 16.5);
      await expectTypography(page.getByTestId("caption-copy"), family, 12, 16);
      await expectTypography(page.getByRole("heading", { name: "Workspace preferences" }), family, 14, 20);
      const codeFamily = await page.getByTestId("code-copy").evaluate((element) => getComputedStyle(element).fontFamily);
      expect(codeFamily).toContain("monospace");
      expect(codeFamily).not.toBe(family);

      const actions = page.getByRole("button", { name: "Workspace actions" });
      const save = page.getByRole("button", { name: "Save preferences" });
      const input = page.getByRole("textbox", { name: "Workspace name" });
      const select = page.getByRole("combobox", { name: "Review mode" });
      const compactInput = page.getByRole("textbox", { name: "Filter reports" });
      const compactSelect = page.getByRole("combobox", { name: "Report status" });
      const composer = page.getByRole("textbox", { name: "Ask Octo" });
      await expectTypography(actions, family, 12, 16);
      await expectTypography(save, family, 14, 20);
      for (const control of [input, select, composer]) {
        await expectTypography(control, family, width < 640 ? 16 : 14, 20);
      }
      for (const control of [compactInput, compactSelect]) {
        await expectTypography(control, family, width < 640 ? 16 : 12, width < 640 ? 20 : 16);
      }

      await input.fill("Readable workspace");
      await input.press("Tab");
      await expect(select).toBeFocused();
      await select.selectOption("automatic");
      await save.focus();
      await save.press("Enter");
      await expect(page.getByTestId("saved-preferences")).toHaveText("Readable workspace / automatic");

      await actions.focus();
      await actions.press("ArrowDown");
      const menu = page.getByRole("menu", { name: "Workspace actions" });
      const review = page.getByRole("menuitem", { name: "Review reports" });
      const settings = page.getByRole("menuitem", { name: "Open settings" });
      await expect(menu).toBeVisible();
      await expect(review).toBeFocused();
      await expectTypography(review, family, 14, 20);
      await expectContained(menu);
      await review.press("ArrowDown");
      await expect(settings).toBeFocused();
      await settings.press("Enter");
      await expect(page.getByTestId("selected-action")).toHaveText("settings");
      await expect(menu).toHaveCount(0);
      await expect(actions).toBeFocused();
      await actions.press("ArrowDown");
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(actions).toBeFocused();

      await composer.fill("Review the report and describe the next useful step. ".repeat(4));
      await expect(page.getByTestId("draft-value")).toHaveText("Review the report and describe the next useful step. ".repeat(4).trim());
      await expect(composer).toHaveAttribute("aria-multiline", "true");
      for (const control of [input, select, compactInput, compactSelect, save, composer, page.getByTestId("settings-section")]) {
        await expectContained(control);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`product-typography-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    });
  }
}
