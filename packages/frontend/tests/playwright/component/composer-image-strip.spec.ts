import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__composer-image-strip__";
const DRAFT = "Keep this draft while reviewing the images.";
const IMAGE_NAMES = Array.from({ length: 8 }, (_, index) =>
  `selected-image-${index + 1}-with-a-long-descriptive-filename.png`);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function mount(page: Page, compact: boolean, {browserModeActive=false,initialDraft=DRAFT} = {}) {
  const deps = await resolveViteReactDependencies(page);
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  // Token-detail helpers share the optional artifact registry. This fixture
  // has no transcript artifacts or provider feature composition.
  await page.route("**/src/capabilities/localCapabilityArtifactRegistry.ts*", route => route.fulfill({
    contentType: "application/javascript", body: "export function resolveLocalCapabilityArtifact(){return null;}",
  }));
  for (const [name, path] of [
    ["ChatBrowserDock", "/src/screens/studio/components/ChatBrowserDock.tsx"],
    ["ComposerInviteModal", "/src/screens/studio/components/ComposerInviteModal.tsx"],
    ["VoiceConversationActionStrip", "/src/screens/studio/components/VoiceConversationActionStrip.tsx"],
    ["ProviderTriggerNotice", "/src/extensions/ProviderTriggerNotice.tsx"],
  ]) {
    await page.route(`**${path}*`, route => route.fulfill({
      contentType: "application/javascript", body: `export function ${name}(){return null;}`,
    }));
  }
  // Real Surface, attachment state/object URLs and modal. Only the editor and
  // unrelated feature surfaces are stubs: this tests the editor ref focus
  // contract, not Lexical, native IME, upload transport or a running model.
  await page.route("**/src/screens/studio/components/chat-input/ChatInput.tsx*", route => route.fulfill({
    contentType: "application/javascript",
    body: `import ReactNS from "${deps.react}"; const React=ReactNS.default??ReactNS;
      export const ChatInput=React.forwardRef(function ChatInput(props,ref){
        const node=React.useRef(null);
        React.useImperativeHandle(ref,()=>({focus:()=>node.current?.focus(),focusAfterValueSync:()=>node.current?.focus()}),[]);
        return React.createElement("textarea",{ref:node,"data-testid":"fixture-editor",value:props.value,
          onChange:event=>props.onChange(event.target.value,null),rows:2,
          style:{width:"100%",minWidth:0,minHeight:44,resize:"none"},"aria-label":"Fixture draft editor"});
      });`,
  }));
  await page.route("**/*", async route => {
    if (route.request().method() !== "GET") {
      failures.push(`Unexpected ${route.request().method()} request`);
      await route.abort();
    } else await route.fallback();
  });
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDOMNS from "${deps.reactDomClient}";
    import { ChatComposerSurface } from "/src/screens/studio/components/ChatComposerSurface.tsx";
    import { useChatComposerAttachments } from "/src/screens/studio/components/useChatComposerAttachments.ts";
    import { ChatImageLightboxOverlay } from "/src/screens/studio/components/ChatPanelOverlays.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDOMNS.default ?? ReactDOMNS;
    const h = React.createElement, noop = () => {};
    function Fixture() {
      const [draft,setDraft]=React.useState(${JSON.stringify(initialDraft)});
      const [imageLightbox,setImageLightbox]=React.useState(null);
      const [sendingAttachment,setSendingAttachment]=React.useState(false);
      const composerOverlayRef=React.useRef(null),chatInputRef=React.useRef(null);
      const attachments=useChatComposerAttachments({draftKey:"synthetic-images",isInputLocked:()=>false,showStatus:noop});
      return h("main",{style:{height:"100dvh",position:"relative",display:"flex",flexDirection:"column"}},
        h("p",{style:{padding:8,fontSize:12}},"Synthetic attachment UI — no upload or model execution"),
        h("button",{onClick:()=>setSendingAttachment(value=>!value),"data-testid":"fixture-upload-toggle",style:{alignSelf:"flex-start",padding:8}},"Toggle simulated upload state"),
        h("output",{"data-testid":"fixture-files",hidden:true},JSON.stringify(attachments.imageAttachments.map(item=>item.file.name))),
        h(ChatComposerSurface,{
          browserDockProps:{},composerOverlayRef,composerAutoHidden:false,browserModeActive:${browserModeActive},
          compactBrowserViewport:${compact},touchLikeInput:${compact},nativeKeyboardOpen:${compact},
          onSubmit:event=>event.preventDefault(),
          queueSurfaceProps:{totalQueuedCount:0,editingQueuedItem:null,chatSendQueueExpanded:false,
            collapsedQueuedMessageSummary:null,queueCanSendNow:false,chatSendQueueDisplay:[],sendingAttachment,inputValue:draft,
            onToggleExpanded:noop,onSendQueuedMessageNow:noop,onEditQueuedMessage:noop,onRemoveQueuedItem:noop,
            onReorderQueuedItem:noop,onCancelQueuedEdit:noop,onRequeueEditedMessage:noop,onSendEditedMessageNow:noop},
          activeGoal:null,activeGoalHealth:null,onPauseGoal:noop,onResumeGoal:noop,onClearGoal:noop,onHelpUnblockGoal:noop,goalDetailsCollapseToken:0,
          onboardingInputLocked:false,onDragOver:attachments.handleComposerDragOver,onDrop:attachments.handleComposerDrop,
          chatInputRef,chatInputProps:{value:draft,onChange:setDraft,editorState:null,placeholder:"Draft",agentHandles:[],onKeyDown:noop},
          imageInputRef:attachments.imageInputRef,onImageInputChange:attachments.handleImageInputChange,imageAttachments:attachments.imageAttachments,
          onOpenImage:(src,alt)=>setImageLightbox({src,alt}),onRemoveImageAttachment:attachments.removeImageAttachment,
          showVoiceStatus:false,voiceStatusMessage:"",providerTriggerNoticeProps:null,
          showComposerNavigationButton:false,onOpenNavigation:noop,homeAttentionCount:0,homeAttentionBadge:"",
          composerActionMenuProps:{pendingNewBrowser:false,onOpenBrowser:noop,onOpenNewBrowser:noop,onOpenInvite:noop,
            onImportGithubRepo:noop,onInsertCommand:noop,showBrowserAction:false,showNewBrowserAction:false,showInviteAction:false},
          onOpenImagePicker:attachments.openImagePicker,sendingAttachment,
          showMobileGhostSuggestionAcceptButton:false,onAcceptGhostSuggestion:noop,showVoicePrimaryAction:false,showVoiceSecondaryAction:false,
          voiceConversationActionStripProps:{},sendButtonDisabled:false,sendButtonVariant:"primary",primaryActionMode:"send",onSendButtonPress:noop,
          composerGhostActionClass:"text-slate-600",composerPrimaryActionClass:"shadow-none",composerActionIconClass:"h-[22px] w-[22px]",inviteModalProps:{}
        }),
        h(ChatImageLightboxOverlay,{imageLightbox,onClose:()=>setImageLightbox(null)}));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  await page.route(`**${FIXTURE}/main.js`, route => route.fulfill({contentType:"application/javascript",body:main}));
  await page.route(`**${FIXTURE}`, route => route.fulfill({contentType:"text/html",body:`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE}/main.js"></script>
    </head><body><div id="root"></div></body></html>`}));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("fixture-editor")).toBeVisible();
  expect(failures).toEqual([]);
  return failures;
}

async function selectImages(page: Page, names = IMAGE_NAMES) {
  await page.getByTestId("chat-image-upload-input").setInputFiles(
    names.map(name => ({name,mimeType:"image/png",buffer:PNG})),
  );
  await expect(page.getByTestId("chat-image-upload-remove")).toHaveCount(names.length);
}

const selectedFiles = (page: Page) => page.getByTestId("fixture-files").evaluate(node => JSON.parse(node.textContent ?? "[]"));

for (const viewport of [{name:"short phone",width:360,height:438,compact:true},{name:"desktop",width:1280,height:800,compact:false}]) {
  test.describe(viewport.name, () => {
  test.use({hasTouch:viewport.compact});
  test(`eight selected images stay in one bounded row above the draft on ${viewport.name}`, async ({page}, testInfo) => {
    await page.setViewportSize(viewport);
    const failures = await mount(page, viewport.compact);
    await selectImages(page);
    const strip = page.getByTestId("chat-image-upload-strip");
    await expect(strip).toBeVisible();
    const geometry = await strip.evaluate(node => {
      const rect=node.getBoundingClientRect();
      const preview=node.closest('[data-testid="chat-image-upload-preview"]')?.getBoundingClientRect();
      const editor=document.querySelector('[data-testid="chat-composer-text-row"]')?.getBoundingClientRect();
      const tiles=Array.from(node.querySelectorAll('[data-testid^="chat-image-upload-preview-item-"]')).map(item=>item.getBoundingClientRect().top);
      return {height:rect.height,previewBottom:preview?.bottom,editorTop:editor?.top,tops:tiles,
        scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,
        pageWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,pageHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight};
    });
    expect(geometry.height).toBeLessThanOrEqual(112);
    expect(geometry.previewBottom).toBeLessThanOrEqual((geometry.editorTop ?? 0)+1);
    expect(Math.max(...geometry.tops)-Math.min(...geometry.tops)).toBeLessThanOrEqual(1);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight+1);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.pageHeight).toBeLessThanOrEqual(geometry.viewportHeight+1);
    if (viewport.compact) expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    if (viewport.compact) {
      const removeBounds=await page.getByTestId("chat-image-upload-remove").first().boundingBox();
      expect(removeBounds?.width).toBeGreaterThanOrEqual(44);
      expect(removeBounds?.height).toBeGreaterThanOrEqual(44);
    }
    const screenshotPath=testInfo.outputPath("selected-images.png");
    await page.screenshot({path:screenshotPath});
    await testInfo.attach(`${viewport.name}-image-strip`,{contentType:"image/png",path:screenshotPath});
    await page.getByRole("button",{name:`Preview image 8: ${IMAGE_NAMES[7]}`,exact:true}).scrollIntoViewIfNeeded();
    if (viewport.compact) await expect.poll(()=>strip.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
    await expect(page.getByTestId("fixture-editor")).toHaveValue(DRAFT);
    expect(failures).toEqual([]);
  });
  });
}

test("keyboard removal keeps the other files and draft, then focuses next, previous and finally the editor", async ({page}) => {
  await page.setViewportSize({width:360,height:438});
  const failures = await mount(page,true);
  await selectImages(page);
  const firstRemove = page.getByRole("button",{name:`Remove image 1: ${IMAGE_NAMES[0]}`,exact:true});
  await firstRemove.focus();
  await firstRemove.press("Enter");
  await expect(page.getByRole("button",{name:`Remove image 1: ${IMAGE_NAMES[1]}`,exact:true})).toBeFocused();
  expect(await selectedFiles(page)).toEqual(IMAGE_NAMES.slice(1));
  const lastRemove=page.getByRole("button",{name:`Remove image 7: ${IMAGE_NAMES[7]}`,exact:true});
  await lastRemove.focus();
  await lastRemove.press("Enter");
  await expect(page.getByRole("button",{name:`Remove image 6: ${IMAGE_NAMES[6]}`,exact:true})).toBeFocused();
  expect(await selectedFiles(page)).toEqual(IMAGE_NAMES.slice(1,-1));
  for (let count=6;count>0;count--) {
    const remove=page.getByTestId("chat-image-upload-remove").first();
    await remove.focus();
    await remove.press("Enter");
    await expect(page.getByTestId("chat-image-upload-remove")).toHaveCount(count-1);
  }
  await expect(page.getByTestId("fixture-editor")).toBeFocused();
  await expect(page.getByTestId("fixture-editor")).toHaveValue(DRAFT);
  await expect(page.getByTestId("chat-image-upload-preview")).toBeHidden();
  expect(await selectedFiles(page)).toEqual([]);
  expect(failures).toEqual([]);
});

test("removal without moving focus preserves the editor and simulated upload disables removal", async ({page}) => {
  const failures=await mount(page,false);
  await selectImages(page,IMAGE_NAMES.slice(0,2));
  const editor=page.getByTestId("fixture-editor");
  await editor.focus();
  // An assistive/programmatic activation need not move DOM focus. Exercise the
  // production handler without fabricating focus on its removed control.
  await page.getByTestId("chat-image-upload-remove").first().evaluate(node=>(node as HTMLButtonElement).click());
  await expect(page.getByTestId("chat-image-upload-remove")).toHaveCount(1);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(DRAFT);
  expect(await selectedFiles(page)).toEqual([IMAGE_NAMES[1]]);
  await page.getByTestId("fixture-upload-toggle").click();
  await expect(page.getByTestId("chat-image-upload-remove")).toBeDisabled();
  await expect(page.getByRole("status").filter({hasText:"Uploading images…"})).toBeVisible();
  expect(await selectedFiles(page)).toEqual([IMAGE_NAMES[1]]);
  expect(failures).toEqual([]);
});

test("each thumbnail opens its own image and the modal contains keyboard focus and restores its opener", async ({page}) => {
  await page.setViewportSize({width:360,height:438});
  const failures=await mount(page,true);
  await selectImages(page);
  for (let index=0;index<IMAGE_NAMES.length;index++) {
    const opener=page.getByRole("button",{name:`Preview image ${index+1}: ${IMAGE_NAMES[index]}`,exact:true});
    await opener.focus();
    await opener.press("Enter");
    const dialog=page.getByRole("dialog",{name:"Image preview",exact:true});
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("chat-image-lightbox-image")).toHaveAttribute("alt",IMAGE_NAMES[index]);
    await expect.poll(()=>page.getByTestId("chat-image-lightbox-image").evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    for (const key of ["Tab","Tab","Shift+Tab","Shift+Tab"]) {
      await page.keyboard.press(key);
      await expect.poll(()=>dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true);
    }
    if (index%2===0) await page.keyboard.press("Escape");
    else await page.getByTestId("chat-image-lightbox-close").click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.getByTestId("fixture-editor")).toHaveValue(DRAFT);
    expect(await selectedFiles(page)).toEqual(IMAGE_NAMES);
  }
  expect(failures).toEqual([]);
});

test("duplicate filenames keep distinct preview and removal controls", async ({page}) => {
  const failures=await mount(page,false);
  await selectImages(page,[IMAGE_NAMES[0],IMAGE_NAMES[0]]);
  await expect(page.getByRole("button",{name:`Preview image 1: ${IMAGE_NAMES[0]}`,exact:true})).toHaveCount(1);
  await expect(page.getByRole("button",{name:`Preview image 2: ${IMAGE_NAMES[0]}`,exact:true})).toHaveCount(1);
  const secondRemove=page.getByRole("button",{name:`Remove image 2: ${IMAGE_NAMES[0]}`,exact:true});
  await secondRemove.focus();
  await secondRemove.press("Enter");
  await expect(page.getByRole("button",{name:`Remove image 1: ${IMAGE_NAMES[0]}`,exact:true})).toBeFocused();
  await expect(page.getByTestId("chat-image-upload-remove")).toHaveCount(1);
  expect(await selectedFiles(page)).toEqual([IMAGE_NAMES[0]]);
  await expect(page.getByTestId("fixture-editor")).toHaveValue(DRAFT);
  expect(failures).toEqual([]);
});

test("browser mode expands for selected images and returns to its compact layout with the same editor", async ({page}) => {
  await page.setViewportSize({width:360,height:438});
  const failures=await mount(page,true,{browserModeActive:true,initialDraft:""});
  const surface=page.getByTestId("chat-composer-surface");
  const editor=page.getByTestId("fixture-editor");
  const originalEditor=await editor.elementHandle();
  await expect(surface).toHaveAttribute("data-browser-composer-condensed","true");
  await selectImages(page,IMAGE_NAMES.slice(0,2));
  await expect(surface).not.toHaveAttribute("data-browser-composer-condensed","true");
  const previewBounds=await page.getByTestId("chat-image-upload-preview").boundingBox();
  const textBounds=await page.getByTestId("chat-composer-text-row").boundingBox();
  expect(previewBounds).not.toBeNull();
  expect(textBounds).not.toBeNull();
  expect(previewBounds!.y+previewBounds!.height).toBeLessThanOrEqual(textBounds!.y+1);
  expect(await editor.evaluate((node,original)=>node===original,originalEditor)).toBe(true);
  await editor.fill(DRAFT);
  for (let count=2;count>0;count--) {
    const remove=page.getByTestId("chat-image-upload-remove").first();
    await remove.focus();
    await remove.press("Enter");
    await expect(page.getByTestId("chat-image-upload-remove")).toHaveCount(count-1);
  }
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(DRAFT);
  await expect(surface).not.toHaveAttribute("data-browser-composer-condensed","true");
  await editor.fill("");
  await expect(surface).toHaveAttribute("data-browser-composer-condensed","true");
  expect(await editor.evaluate((node,original)=>node===original,originalEditor)).toBe(true);
  await expect(editor).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
