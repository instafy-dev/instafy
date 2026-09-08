import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__chat-viewport-bottom-follow__";

async function mount(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  // Optional artifact providers are outside this plain-text scroll fixture.
  await page.route("**/src/capabilities/localCapabilityArtifactRegistry.ts*", route => route.fulfill({
    contentType: "application/javascript", body: "export function resolveLocalCapabilityArtifact(){ return null; }",
  }));
  // Production scroll hooks and real DOM geometry; no controller, auth, IME,
  // message dispatch, or device behavior is simulated as a successful result.
  const main = `
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { useChatScrollController, useChatAutoScrollSync } from "/src/screens/studio/components/useChatScrollOrchestration.ts";
    import { useChatComposerLayoutState } from "/src/screens/studio/components/useChatComposerLayoutState.ts";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const messages = Array.from({length:12}, (_, index) => ({id:"row-"+index,content:"Fixture message "+index,role:"assistant",timestamp:index}));
    function Fixture() {
      const controller = useChatScrollController({activeConversationId:"viewport-fixture",hasMoreHistory:false,isHistoryLoading:false,loadOlderMessages:()=>{},messages});
      const rootRef = React.useRef(null);
      const composerOverlayRef = React.useRef(null);
      const layout = useChatComposerLayoutState({...controller,activeConversationId:"viewport-fixture",rootRef,composerOverlayRef,
        browserModeActive:false,browserSessionOpen:false,chatSendQueueExpanded:false,compactBrowserViewport:false,
        composerGhostSuggestionRemainder:null,editingQueuedItemActive:false,hasMoreHistory:false,imageAttachmentCount:0,
        inputValue:"",isChatInputFocused:()=>false,isHistoryLoading:false,queuedSummaryItemCount:0,sendingAttachment:false,
        showBrowserSessionPageStrip:false,totalQueuedCount:0,touchLikeInput:false,voiceHoldActive:false,voiceInputListening:false});
      useChatAutoScrollSync({...controller,displayedMessages:messages,aiOnboardingOpen:false,composerAutoHidden:false,
        composerOverlayHeight:0,credentialGateStateForBubble:null,isAssistantTyping:false,
        notificationsNudgeAnchorTimestamp:null,notificationsNudgeOpen:false,peerTypingLabel:null});
      React.useEffect(() => {
        window.__scrollSamples = [];
        const node = controller.scrollContainerRef.current;
        const sample = reason => {
          const entries = window.__scrollSamples;
          entries.push({reason,at:performance.now(),top:node.scrollTop,client:node.clientHeight,height:node.scrollHeight,following:controller.shouldAutoScrollRef.current});
          if(entries.length>200)entries.shift();
        };
        const scroll=()=>sample("scroll"); const resize=()=>sample("resize");
        node.addEventListener("scroll",scroll);window.addEventListener("resize",resize);
        const observer=new ResizeObserver(()=>sample("observed"));observer.observe(node);
        return ()=>{node.removeEventListener("scroll",scroll);window.removeEventListener("resize",resize);observer.disconnect();};
      },[]);
      return h(React.Fragment,null,
        h("p", {style:{height:32,margin:0}},"Production scroll hooks; synthetic transcript"),
        h("div", {ref:controller.scrollContainerRef,onScroll:layout.handleScroll,"data-testid":"scroll",style:{height:"calc(100dvh - 132px)",overflowY:"auto"}},
          h("div", {ref:controller.handleScrollContentRef}, ...messages.map(message => h("div",{key:message.id,"data-chat-scroll-message-id":message.id,style:{height:100,boxSizing:"border-box",padding:8}},message.content)))),
        controller.showJumpToLatest ? h("button",{"data-testid":"jump",onClick:controller.jumpToLatest},"Jump to latest") : null);
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  await page.route(`**${FIXTURE}/main.js`, route => route.fulfill({contentType:"application/javascript",body:main}));
  await page.route(`**${FIXTURE}`, route => route.fulfill({contentType:"text/html",body:`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{margin:0;font:14px sans-serif}</style>
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE}/main.js"></script>
    </head><body><div id="root"></div></body></html>`}));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("scroll")).toBeVisible();
}

const bottomDistance = (page: Page) => page.getByTestId("scroll").evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);

test("retains bottom-follow when layout scroll is delivered before resize and releases it for a reader", async ({page}) => {
  await page.setViewportSize({width:360,height:780});
  await mount(page);
  await expect.poll(() => bottomDistance(page)).toBeLessThan(1);
  await page.getByTestId("scroll").evaluate(node => {
    // Deterministically exercise the browser event ordering, with actual
    // changed clientHeight rather than replacing element geometry getters.
    node.style.height = "306px";
    void node.clientHeight;
    node.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => bottomDistance(page)).toBeLessThan(1);
  await expect(page.getByTestId("jump")).toBeHidden();

  await page.getByTestId("scroll").evaluate(node => {
    (node.firstElementChild as HTMLElement).style.paddingBottom = "40px";
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => bottomDistance(page)).toBeLessThan(1);
  await page.getByTestId("scroll").evaluate(node => {
    node.style.height = "648px"; // The browser clamps scrollTop to its new maximum.
    void node.clientHeight;
    node.dispatchEvent(new Event("scroll"));
    (node.firstElementChild as HTMLElement).style.paddingBottom = "80px";
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => bottomDistance(page)).toBeLessThan(1);
  await expect(page.getByTestId("jump")).toBeHidden();

  await page.getByTestId("scroll").evaluate(node => {
    node.style.height = "250px";
    node.scrollTop -= 120;
    node.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect(page.getByTestId("jump")).toBeVisible();
  const top = await page.getByTestId("scroll").evaluate(node => node.scrollTop);
  await page.setViewportSize({width:360,height:438});
  await expect(page.getByTestId("scroll")).toHaveJSProperty("scrollTop", top);
});

test("follows repeated real viewport resizing at the bottom", async ({page}, testInfo) => {
  await page.setViewportSize({width:360,height:780});
  await mount(page);
  try {
    for (const height of [438,780,500,438]) {
      await page.setViewportSize({width:360,height});
      await expect.poll(() => bottomDistance(page)).toBeLessThan(1);
      await expect(page.getByTestId("jump")).toBeHidden();
    }
  } finally {
    await testInfo.attach("scroll-samples", {contentType:"application/json",body:JSON.stringify(await page.evaluate(()=>(window as unknown as {__scrollSamples:unknown}).__scrollSamples))});
  }
});
