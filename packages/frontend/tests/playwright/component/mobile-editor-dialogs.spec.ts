import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

async function mountEditors(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  await page.route("**/src/features/applicationFrontendFeatureComposition.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `import { createFrontendApplicationComposition } from '/src/features/frontendApplicationComposition.ts';
      import { LOCAL_CORE_ASSISTANT_PROVIDER } from '/src/assistants/coreAssistantProvider.ts';
      export const APPLICATION_FRONTEND_FEATURE_COMPOSITION = createFrontendApplicationComposition([{apiVersion:1,id:'fixture.core',assistantProviders:[LOCAL_CORE_ASSISTANT_PROVIDER],capabilityAssistantProviders:[LOCAL_CORE_ASSISTANT_PROVIDER]}]);
      export const APPLICATION_FRONTEND_FEATURES = APPLICATION_FRONTEND_FEATURE_COMPOSITION.features;
      export const APPLICATION_FRONTEND_REGISTRATION_INPUTS = APPLICATION_FRONTEND_FEATURE_COMPOSITION.registrations;`,
  }));
  // Photo validation imports the upload client. This layout fixture has no
  // authenticated backend; any accidental upload must fail rather than send.
  await page.route("**/src/lib/supabaseClient.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export const supabase = {storage:{from(){throw Error('No uploads in the editor layout fixture')}}};`,
  }));
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await page.route("**/__mobile-editors__", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/__mobile-editors__.js"></script></head><body><div id="root"></div></body></html>` }));
  await page.route("**/__mobile-editors__.js", route => route.fulfill({ contentType: "application/javascript", body: `
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}';import ReactDOMNS from '${deps.reactDomClient}';
    import { SkillsImportModal } from '/src/screens/studio/components/SkillsImportModal.tsx';
    import { AgentProfileModal } from '/src/screens/studio/components/AgentProfileModal.tsx';
    const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
    function App(){
      const [editor,setEditor]=R.useState(null),[source,setSource]=R.useState(''),[skillName,setSkillName]=R.useState(''),[overwrite,setOverwrite]=R.useState(false);
      const [name,setName]=R.useState('Octo'),[bio,setBio]=R.useState(''),[description,setDescription]=R.useState('');
      return h(R.Fragment,null,
        h('button',{onClick:()=>setEditor('skills')},'Import skills'),h('button',{onClick:()=>setEditor('agent')},'Edit agent'),
        h(SkillsImportModal,{isOpen:editor==='skills',onOpenChange:open=>{if(!open)setEditor(null)},importPending:false,
          importSource:source,onImportSourceChange:setSource,importName:skillName,onImportNameChange:setSkillName,
          importOverwrite:overwrite,onImportOverwriteChange:setOverwrite,hasProject:true,onSubmitImport:()=>{throw Error('No sending in this fixture')}}),
        h(AgentProfileModal,{isOpen:editor==='agent',mode:'octo',title:'Edit Octo',subtitle:'Change how your agent appears and behaves.',handle:'octo',handleDisabled:true,
          onHandleChange:()=>{},displayName:name,onDisplayNameChange:setName,avatarImageUrl:'',onAvatarImageUrlChange:()=>{},
          bio,onBioChange:setBio,description,onDescriptionChange:setDescription,dirty:name!=='Octo'||Boolean(bio)||Boolean(description),
          onClose:()=>setEditor(null),onSave:()=>{throw Error('No saving in this fixture')}}));
    }createRoot(document.getElementById('root')).render(h(App));` }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__mobile-editors__");
  await expect(page.getByRole("button", { name: "Import skills", exact: true })).toBeVisible();
}

async function viewport(page: Page, width: number, height: number, top = 0) {
  await page.evaluate(({ width, height, top }) => {
    Object.assign(window.visualViewport!, { width, height, offsetTop: top });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  }, { width, height, top });
  await expect.poll(() => page.getByRole("dialog").evaluate(el => el.getBoundingClientRect().height)).toBe(height);
}

async function actionsWithinViewport(page: Page, title: string, action: string, height: number, top = 0) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  for (const control of [dialog.getByRole("heading", { name: title, exact: true }),
    dialog.getByRole("button", { name: "Close", exact: true }),
    dialog.getByRole("button", { name: "Cancel", exact: true }),
    dialog.getByRole("button", { name: action, exact: true })]) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(top);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(top + height + 1);
  }
}

test("Skills import keeps its title and actions reachable across keyboard resize and rotation", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mountEditors(page);
  await page.getByRole("button", { name: "Import skills", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Source", exact: true });
  await source.fill("https://github.com/example/skills");
  const originalField = await source.elementHandle();
  await viewport(page, 390, 360, 20);
  await actionsWithinViewport(page, "Add skills", "Add and start", 360, 20);
  await expect(source).toBeFocused();
  const scroller = page.getByRole("dialog").locator(".overflow-y-auto");
  expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByRole("textbox", { name: "Optional skill name", exact: true }).fill("My skill");
  await actionsWithinViewport(page, "Add skills", "Add and start", 360, 20);
  await page.setViewportSize({ width: 844, height: 390 });
  await viewport(page, 844, 260);
  expect(await source.evaluate((el, original) => el === original, originalField)).toBe(true);
  await expect(source).toHaveValue("https://github.com/example/skills");
  await expect(page.getByRole("textbox", { name: "Optional skill name", exact: true })).toHaveValue("My skill");
  await actionsWithinViewport(page, "Add skills", "Add and start", 260);
  await page.screenshot({ path: info.outputPath("skills-keyboard-actions.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A newly opened wide dialog also scrolls within the available screen.
  await viewportAfterClose(page, 844, 390);
  await page.getByRole("button", { name: "Import skills", exact: true }).click();
  await actionsWithinViewport(page, "Add skills", "Add and start", 390);
  expect(errors).toEqual([]);
});

async function viewportAfterClose(page: Page, width: number, height: number) {
  await page.evaluate(({ width, height }) => {
    Object.assign(window.visualViewport!, { width, height, offsetTop: 0 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, { width, height });
}

test("Agent editing keeps Save reachable above the keyboard without remounting the draft", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mountEditors(page);
  await page.getByRole("button", { name: "Edit agent", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  await name.fill("Unsaved agent name");
  const originalField = await name.elementHandle();
  await viewport(page, 390, 350);
  await actionsWithinViewport(page, "Edit Octo", "Save", 350);
  await expect(name).toBeFocused();
  const scroller = page.getByRole("dialog").locator(".overflow-y-auto");
  expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await actionsWithinViewport(page, "Edit Octo", "Save", 350);
  await page.setViewportSize({ width: 844, height: 390 });
  await viewport(page, 844, 260);
  expect(await name.evaluate((el, original) => el === original, originalField)).toBe(true);
  await expect(name).toHaveValue("Unsaved agent name");
  await actionsWithinViewport(page, "Edit Octo", "Save", 260);
  await page.screenshot({ path: info.outputPath("agent-keyboard-actions.png") });
  await viewport(page, 844, 152);
  const dialog = page.getByRole("dialog", { name: "Edit Octo", exact: true });
  const shortScroller = dialog.locator("[data-mobile-dialog-content]");
  const nameBounds = (await name.boundingBox())!;
  const closeBounds = (await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
  expect(nameBounds.y).toBeGreaterThanOrEqual(closeBounds.y + closeBounds.height);
  expect(nameBounds.y + nameBounds.height).toBeLessThanOrEqual(152);
  expect(closeBounds.y).toBeGreaterThanOrEqual(0);
  await expect(dialog.getByText("Change how your agent appears and behaves.")).toBeHidden();
  await expect(name).toBeFocused();
  expect(await name.evaluate((el, original) => el === original, originalField)).toBe(true);
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await save.scrollIntoViewIfNeeded();
  const saveBounds = (await save.boundingBox())!;
  expect(saveBounds.y).toBeGreaterThanOrEqual(44);
  expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(152);
  // A repeated viewport event must not undo a deliberate scroll to the actions.
  const actionsScroll = await shortScroller.evaluate(el => el.scrollTop);
  await viewport(page, 844, 152);
  expect(await shortScroller.evaluate(el => el.scrollTop)).toBe(actionsScroll);
  await page.screenshot({ path: info.outputPath("agent-short-landscape-keyboard.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await viewport(page, 390, 350);
  await actionsWithinViewport(page, "Edit Octo", "Save", 350);
  expect(await name.evaluate((el, original) => el === original, originalField)).toBe(true);
  await expect(name).toHaveValue("Unsaved agent name");
  await expect(name).toBeFocused();
  const restoredName = (await name.boundingBox())!;
  expect(restoredName.y).toBeGreaterThanOrEqual(0);
  expect(restoredName.y + restoredName.height).toBeLessThanOrEqual(350);
  expect(errors).toEqual([]);
});
