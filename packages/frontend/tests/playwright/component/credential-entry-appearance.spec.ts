import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__credential-entry-appearance__";

// Render the production cards and form. Only application state and I/O are
// replaced: no account, real secret, OAuth flow or controller is involved.
async function mountEntries(page: Page, dark: boolean) {
  const deps = await resolveViteReactDependencies(page);
  const javascript = (body: string) => ({ contentType: "application/javascript", body });
  const stubs: Record<string, string> = {
    "conversations/useConversation.tsx": `export const useConversation=()=>({activeConversationId:'fixture-chat',messages:[],onRecordMessage(){},onSubmit:async()=>{}});`,
    "conversations/ConversationsProvider.tsx": `export const useConversations=()=>({conversations:[],appendMessages(){}});`,
    "workspace/WorkspaceTabsProvider.tsx": `export const useWorkspaceTabs=()=>({requestUrlPush(){},openPanelTab(panel){window.__credentialActions.push(panel)}});`,
    "status/useStatus.tsx": `export const useStatus=()=>({showStatus(){}});`,
    "projects/ProjectAccessProvider.tsx": `export const useOptionalProjectAccess=()=>({canWriteProject:true});`,
    "screens/studio/components/device-auth/useDeviceAuthFlow.ts": `export const useDeviceAuthFlow=()=>({session:null,error:null,busy:false,begin:async()=>{window.__credentialActions.push('connect-github')},cancel:async()=>{}});`,
    "sdk/instafy/index.ts": `export const controllerClient={
      integrations:{listForProject:async()=>({success:true,integrations:[]}),upsert:async()=>({success:true})},
      projects:{importGithub:async()=>({success:false,error:'Not part of this appearance fixture'})},
      secrets:{listForProject:async()=>({success:true,secrets:[{name:'NOTION_API_KEY'}]})}
    };`,
  };
  for (const [path, body] of Object.entries(stubs)) {
    await page.route(`**/src/${path}*`, route => route.fulfill(javascript(body)));
  }
  await page.route(`**${FIXTURE}`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <script>window.__credentialActions=[];</script>
    <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${FIXTURE}.js"></script></head><body><div id="root"></div></body></html>` }));
  await page.route(`**${FIXTURE}.js`, route => route.fulfill(javascript(`
    import '/src/styles/tailwind.css';
    import ReactNS from '${deps.react}';
    import ReactDOMNS from '${deps.reactDomClient}';
    import {SecretRequestEntry,IntegrationRequestEntry} from '/src/screens/studio/components/ChatCredentialRequestEntries.tsx';
    const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
    const secret={id:'fixture-secret',role:'assistant',content:'',timestamp:1,messageType:'secret_request',metadata:{}};
    const integration={id:'fixture-github',role:'assistant',content:'Connect GitHub to import a repository.',timestamp:2,messageType:'integration_request',metadata:{}};
    createRoot(document.getElementById('root')).render(h('main',{style:{maxWidth:'860px',margin:'0 auto',padding:'16px',display:'grid',gap:'24px'}},
      h(SecretRequestEntry,{message:secret,projectId:'fixture-project',details:{name:'NOTION_API_KEY',valueLabel:'Installation access token',skill:'notion'}}),
      h(IntegrationRequestEntry,{message:integration,projectId:'fixture-project',details:{provider:'github',authMethods:['oauth']}})));
  `)));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("secret-request-saved")).toBeVisible();
  await expect(page.getByTestId("integration-request-connect-github")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(errors).toEqual([]);
}

for (const touch of [false, true]) {
  test.describe(touch ? "touch credential actions" : "mouse credential actions", () => {
    test.use({ hasTouch: touch });
    for (const dark of [false, true]) {
      test(`credential cards keep shared targets and independent actions in ${dark ? "dark" : "light"} mode`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
        await mountEntries(page, dark);
        const ids = ["secret-request-open", "secret-request-replace", "integration-request-connect-github", "integration-request-open-secrets"];
        for (const id of ids) {
          const target = page.getByTestId(id);
          await expect(target).toBeEnabled();
          const bounds = (await target.boundingBox())!;
          expect(bounds.height, id).toBe(touch ? 44 : id === "integration-request-connect-github" ? 36 : 32);
          expect(bounds.x, id).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width, id).toBeLessThanOrEqual(390);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("credentials-narrow.png"), fullPage: true });

        // Manage and OAuth controls keep distinct destinations. The entry form
        // still starts empty; changing its appearance must not prefill a secret.
        await page.getByTestId("secret-request-open").click();
        await page.getByTestId("integration-request-connect-github").click();
        expect(await page.evaluate(() => (window as unknown as { __credentialActions: string[] }).__credentialActions)).toEqual(["secrets", "connect-github"]);
        await page.getByTestId("secret-request-replace").click();
        await expect(page.getByTestId("secret-request-value-NOTION_API_KEY")).toHaveValue("");
        await expect(page.getByTestId("secret-request-value-NOTION_API_KEY")).toHaveCSS("-webkit-text-security", "disc");
        await expect(page.getByTestId("secret-request-save")).toBeDisabled();

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({ path: testInfo.outputPath("credentials-wide.png"), fullPage: true });
        for (const id of ["secret-request-open", "integration-request-connect-github"]) {
          const bounds = (await page.getByTestId(id).boundingBox())!;
          expect(bounds.height, id).toBe(touch ? 44 : id === "integration-request-connect-github" ? 36 : 32);
        }
      });
    }
  });
}
