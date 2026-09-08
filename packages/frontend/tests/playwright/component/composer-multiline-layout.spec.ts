import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__composer-multiline-layout__";

async function mount(page: Page, compact: boolean) {
  const deps = await resolveViteReactDependencies(page);
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  // Token-detail helpers share the optional artifact registry. This fixture
  // has no transcript artifacts or provider feature composition.
  await page.route("**/src/capabilities/localCapabilityArtifactRegistry.ts*", route => route.fulfill({
    contentType: "application/javascript", body: "export function resolveLocalCapabilityArtifact(){return null;}",
  }));
  // The minimal browser CI Vite config has no build-time virtual manifest.
  // Keep the real public assistant/mention registry with its explicit manifest.
  await page.route("**/src/features/applicationFrontendFeatureComposition.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `import { APPLICATION_FRONTEND_FEATURE_MODULES } from "/src/features/publicFrontendFeatureManifest.ts";
      import { createFrontendApplicationComposition } from "/src/features/frontendApplicationComposition.ts";
      export const APPLICATION_FRONTEND_FEATURE_COMPOSITION=createFrontendApplicationComposition(APPLICATION_FRONTEND_FEATURE_MODULES);
      export const APPLICATION_FRONTEND_FEATURES=APPLICATION_FRONTEND_FEATURE_COMPOSITION.features;
      export const APPLICATION_FRONTEND_REGISTRATION_INPUTS=APPLICATION_FRONTEND_FEATURE_COMPOSITION.registrations;`,
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
  // The Surface and ChatInput/Lexical are real; only unrelated feature surfaces are stubs.
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
      const [editorState,setEditorState]=React.useState(null);
      const [draft,setDraft]=React.useState(${JSON.stringify("Hi")});
      const [imageLightbox,setImageLightbox]=React.useState(null);
      const [sendingAttachment,setSendingAttachment]=React.useState(false);
      const composerOverlayRef=React.useRef(null),chatInputRef=React.useRef(null);
      const attachments=useChatComposerAttachments({draftKey:"synthetic-images",isInputLocked:()=>false,showStatus:noop});
      return h("main",{style:{height:"100dvh",position:"relative",display:"flex",flexDirection:"column"}},
        h("p",{style:{padding:8,fontSize:12}},"Synthetic multiline editor QA — no model execution"),
        h("button",{onClick:()=>setSendingAttachment(value=>!value),"data-testid":"fixture-upload-toggle",style:{alignSelf:"flex-start",padding:8}},"Toggle simulated upload state"),
        h("output",{"data-testid":"fixture-editor-state",hidden:true},editorState),
        h(ChatComposerSurface,{
          browserDockProps:{},composerOverlayRef,composerAutoHidden:false,browserModeActive:false,
          compactBrowserViewport:${compact},touchLikeInput:${compact},nativeKeyboardOpen:${compact},
          onSubmit:event=>event.preventDefault(),
          queueSurfaceProps:{totalQueuedCount:0,editingQueuedItem:null,chatSendQueueExpanded:false,
            collapsedQueuedMessageSummary:null,queueCanSendNow:false,chatSendQueueDisplay:[],sendingAttachment,inputValue:draft,
            onToggleExpanded:noop,onSendQueuedMessageNow:noop,onEditQueuedMessage:noop,onRemoveQueuedItem:noop,
            onReorderQueuedItem:noop,onCancelQueuedEdit:noop,onRequeueEditedMessage:noop,onSendEditedMessageNow:noop},
          activeGoal:null,activeGoalHealth:null,onPauseGoal:noop,onResumeGoal:noop,onClearGoal:noop,onHelpUnblockGoal:noop,goalDetailsCollapseToken:0,
          onboardingInputLocked:false,onDragOver:attachments.handleComposerDragOver,onDrop:attachments.handleComposerDrop,
          chatInputRef,chatInputProps:{draftKey:"multiline",value:draft,onChange:(text,state)=>{setDraft(text);setEditorState(state);},editorState,placeholder:"Draft",agentHandles:["ada"],agentProfiles:[{handle:"ada",displayName:"Ada"}],onKeyDown:noop},
          imageInputRef:attachments.imageInputRef,onImageInputChange:attachments.handleImageInputChange,imageAttachments:attachments.imageAttachments,
          onOpenImage:(src,alt)=>setImageLightbox({src,alt}),onRemoveImageAttachment:attachments.removeImageAttachment,
          showVoiceStatus:false,voiceStatusMessage:"",providerTriggerNoticeProps:null,
          showComposerNavigationButton:true,onOpenNavigation:noop,homeAttentionCount:0,homeAttentionBadge:"",
          composerActionMenuProps:{pendingNewBrowser:false,onOpenBrowser:noop,onOpenNewBrowser:noop,onOpenInvite:noop,
            onImportGithubRepo:noop,onInsertCommand:noop,showBrowserAction:false,showNewBrowserAction:false,showInviteAction:false},
          onOpenImagePicker:attachments.openImagePicker,sendingAttachment,
          showMobileGhostSuggestionAcceptButton:false,onAcceptGhostSuggestion:noop,showVoicePrimaryAction:false,showVoiceSecondaryAction:false,
          voiceConversationActionStripProps:{},sendButtonDisabled:false,sendButtonVariant:"primary",primaryActionMode:"send",onSendButtonPress:noop,
          composerGhostActionClass:"text-slate-600",composerPrimaryActionClass:"shadow-none",composerActionIconClass:"h-[22px] w-[22px]",inviteModalProps:{}
        }),
        h(ChatImageLightboxOverlay,{imageLightbox,onClose:()=>setImageLightbox(null)}));
    }
    createRoot(document.getElementById("root")).render(h(React.StrictMode,null,h(Fixture)));`;
  await page.route(`**${FIXTURE}/main.js`, route => route.fulfill({contentType:"application/javascript",body:main}));
  await page.route(`**${FIXTURE}`, route => route.fulfill({contentType:"text/html",body:`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE}/main.js"></script>
    </head><body><div id="root"></div></body></html>`}));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  expect(failures).toEqual([]);
  return failures;
}

async function geometry(page: Page) {
  return page.getByTestId("chat-composer-text-row").evaluate(row => {
    const input = row.querySelector<HTMLElement>('[data-testid="chat-input"]')!;
    const wrapper = row.querySelector('[data-testid="chat-composer-editor"]') ?? input.parentElement!.parentElement!;
    const leading = row.querySelector('[data-testid="chat-composer-leading-controls"]')!;
    const trailing = row.querySelector('[data-testid="chat-composer-trailing-controls"]')!;
    const rect = (node: Element) => {
      const { x, y, width, height, top, bottom, left, right } = node.getBoundingClientRect();
      return { x, y, width, height, top, bottom, left, right };
    };
    const font = getComputedStyle(input);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = font.font;
    return { row: rect(row), editor: rect(wrapper), input: rect(input), leading: rect(leading), trailing: rect(trailing),
      letterWidth: context.measureText("w").width, multiline: row.getAttribute("data-multiline"),
      inputClientHeight: input.clientHeight, inputScrollHeight: input.scrollHeight,
      inputClientWidth: input.clientWidth, inputScrollWidth: input.scrollWidth,
      maxHeight: Number(input.dataset.maxHeightPx),
      pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
      viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
}

async function selection(page: Page) {
  return page.getByTestId("chat-input").evaluate(input => {
    const current = getSelection();
    if (!current?.anchorNode || !current.focusNode || !input.contains(current.anchorNode) || !input.contains(current.focusNode)) return null;
    const offset = (node: Node, position: number) => {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.setEnd(node, position);
      return range.toString().length;
    };
    return { anchor: offset(current.anchorNode, current.anchorOffset), focus: offset(current.focusNode, current.focusOffset), text: current.toString() };
  });
}

async function assertFullWidthEditor(page: Page) {
  await expect.poll(async () => {
    const bounds = await geometry(page);
    return bounds.row.width - bounds.editor.width;
  }, { message: "A multiline draft must use the whole composer width above the action controls" }).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("chat-composer-text-row")).toHaveAttribute("data-multiline", "true");
  const bounds = await geometry(page);
  expect(bounds.editor.bottom).toBeLessThanOrEqual(bounds.leading.top + 1);
  expect(bounds.editor.bottom).toBeLessThanOrEqual(bounds.trailing.top + 1);
}

for (const viewport of [
  { name: "short phone", width: 360, height: 438, compact: true },
  { name: "desktop", width: 1280, height: 800, compact: false },
]) {
  test.describe(viewport.name, () => {
    test.use({ hasTouch: viewport.compact });

    test("wrapping widens the real editor once without remounting or oscillating, then short text collapses", async ({ page }) => {
      await page.setViewportSize(viewport);
      const failures = await mount(page, viewport.compact);
      const editor = page.getByTestId("chat-input");
      await editor.focus();
      const original = await editor.elementHandle();
      const originalLeading = await page.getByTestId("chat-composer-leading-controls").elementHandle();
      const originalTrailing = await page.getByTestId("chat-composer-trailing-controls").elementHandle();
      const inline = await geometry(page);
      expect(inline.editor.left).toBeGreaterThanOrEqual(inline.leading.right);
      expect(inline.editor.right).toBeLessThanOrEqual(inline.trailing.left);
      // It wraps at the inline width but fits on one line after expansion.
      // Measuring this in-browser avoids a font-dependent character threshold.
      const wrappedText = "w".repeat(Math.ceil(inline.input.width / inline.letterWidth) + 2);
      await editor.fill(wrappedText);
      await assertFullWidthEditor(page);
      await expect(editor).toBeFocused();
      expect(await original!.evaluate(node => node === document.querySelector('[data-testid="chat-input"]'))).toBe(true);
      expect(await originalLeading!.evaluate(node => node === document.querySelector('[data-testid="chat-composer-leading-controls"]'))).toBe(true);
      expect(await originalTrailing!.evaluate(node => node === document.querySelector('[data-testid="chat-composer-trailing-controls"]'))).toBe(true);
      expect(await selection(page)).toEqual({ anchor: wrappedText.length, focus: wrappedText.length, text: "" });
      const frames = await page.getByTestId("chat-composer-text-row").evaluate(async row => {
        const widths: number[] = [];
        for (let frame = 0; frame < 24; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          widths.push(row.querySelector('[data-testid="chat-composer-editor"]')!.getBoundingClientRect().width);
        }
        return widths;
      });
      expect(Math.max(...frames) - Math.min(...frames)).toBeLessThanOrEqual(1);
      await editor.fill("Hi");
      await expect(page.getByTestId("chat-composer-text-row")).not.toHaveAttribute("data-multiline", "true");
      expect((await geometry(page)).editor.width).toBeCloseTo(inline.editor.width, 0);
      expect(await original!.evaluate(node => node === document.querySelector('[data-testid="chat-input"]'))).toBe(true);
      await expect(editor).toBeFocused();
      expect(failures).toEqual([]);
    });

    test("hard newlines and resize preserve the real Lexical selection and keep a capped draft within the viewport", async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const failures = await mount(page, viewport.compact);
      const editor = page.getByTestId("chat-input");
      const original = await editor.elementHandle();
      await editor.fill("First line");
      await editor.press("Shift+Enter");
      await page.keyboard.insertText("Second line");
      await assertFullWidthEditor(page);
      await editor.press("Shift+ArrowLeft");
      const selected = await selection(page);
      expect(selected?.text).toBe("e");
      await page.setViewportSize({ width: viewport.compact ? 390 : 1024, height: viewport.compact ? 380 : 650 });
      await assertFullWidthEditor(page);
      expect(await selection(page)).toEqual(selected);
      await expect(editor).toBeFocused();
      expect(await original!.evaluate(node => node === document.querySelector('[data-testid="chat-input"]'))).toBe(true);
      await page.getByTestId("chat-image-upload-input").setInputFiles({
        name: "selected.png", mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
      });
      await expect(page.getByTestId("chat-image-upload-preview-item-0")).toBeVisible();
      await editor.fill(Array.from({ length: 40 }, (_, index) => `Line ${index}: explain this image and its details.`).join("\n"));
      await assertFullWidthEditor(page);
      await expect.poll(async () => {
        const bounds = await geometry(page);
        return bounds.inputScrollHeight > bounds.inputClientHeight;
      }).toBe(true);
      const bounds = await geometry(page);
      const strip = await page.getByTestId("chat-image-upload-strip").boundingBox();
      expect(strip!.y + strip!.height).toBeLessThanOrEqual(bounds.editor.top + 1);
      expect(bounds.input.height).toBeLessThanOrEqual(bounds.maxHeight + 1);
      expect(bounds.inputScrollWidth).toBeLessThanOrEqual(bounds.inputClientWidth + 1);
      expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.pageHeight).toBeLessThanOrEqual(bounds.viewportHeight + 1);
      for (const id of ["chat-composer-navigation-button", "composer-action-menu-trigger", "chat-send-button"]) {
        const button = page.getByTestId(id);
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        if (viewport.compact) {
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        expect(box!.y + box!.height).toBeLessThanOrEqual(bounds.viewportHeight);
        expect(await button.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === node || node.contains(hit);
        })).toBe(true);
      }
      await testInfo.attach(`${viewport.name}-multiline`, { body: await page.screenshot(), contentType: "image/png" });
      expect(failures).toEqual([]);
    });
  });
}

test("a real agent mention survives multiline expansion and resize", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 438 });
  const failures = await mount(page, true);
  const editor = page.getByTestId("chat-input");
  await editor.fill("");
  await editor.pressSequentially("@ad", { delay: 80 });
  await expect(editor).toHaveText("@ad");
  const option = page.getByTestId("assistant-mention-option").filter({ hasText: "Ada" });
  await expect(option).toBeVisible();
  await editor.press("Enter");
  await expect(page.getByTestId("fixture-editor-state")).toContainText('"type":"agent-mention"');
  await page.keyboard.insertText(" please explain ".repeat(12));
  await assertFullWidthEditor(page);
  await page.setViewportSize({ width: 390, height: 380 });
  await expect(page.getByTestId("fixture-editor-state")).toContainText('"type":"agent-mention"');
  await expect(editor).toContainText("@ada");
  await expect(editor).toBeFocused();
  expect(failures).toEqual([]);
});
