import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const FIXTURE_PATH = "/__chat-sticky-speaker-clear__";

// The transcript as ChatPanel lays it out: the presence row (the sticky
// speaker pill) over a scrolled conversation.
async function mountTranscript(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatColumn } from "/src/screens/studio/components/ChatColumn.tsx";
    import { ChatSpeakerStickyOverlay, ChatTranscriptViewport } from "/src/screens/studio/components/ChatTranscriptViewport.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    function Fixture() {
      const ref = React.useRef(null);
      return h("main", { style: { height: "100vh", display: "flex", flexDirection: "column" } },
        h(ChatTranscriptViewport, {
          ariaLabel: "Conversation", scrollContainerRef: ref,
          header: h("div", { className: "px-3 pt-2 sm:px-4" },
            h(ChatColumn, { className: "pointer-events-none flex items-center justify-between gap-2" },
              h(ChatSpeakerStickyOverlay, { speaker: { kind: "assistant", handle: "octo", avatarSeed: "octo" } }))),
        }, Array.from({ length: 80 }, (_, index) => h("p", { key: index, className: "py-1 text-sm" },
          "Opened visitlisboa.com and read the tower's page, line " + index))));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));
  `;
  const html = `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body class="m-0 bg-white"><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  // Inert data boundaries only; the transcript, the pill and their CSS are production code.
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, (route) => route.fulfill({ contentType: "application/javascript", body }));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("chat-speaker-sticky-overlay"), errors.join("; ")).toBeVisible();
  return errors;
}

// A local test, on a phone and on a desktop: the sticky "octo" pill sat over
// the first visible line ("…ned visitlisboa.com"), which showed through.
for (const width of [375, 1280]) {
  test(`the transcript is fully clear behind the sticky speaker pill at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    const errors = await mountTranscript(page);
    const scroller = page.getByTestId("chat-message-scroll");
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const layout = await scroller.evaluate((node) => {
      const pill = document.querySelector('[data-testid="chat-speaker-sticky-overlay"]')!.getBoundingClientRect();
      return {
        pillBottom: pill.bottom - node.getBoundingClientRect().top,
        mask: getComputedStyle(node).maskImage,
      };
    });
    // The mask's stops, as the browser computed them: where the transcript
    // starts to show is the last fully transparent stop.
    const stops = [...layout.mask.matchAll(/rgba?\(([^)]*)\)\s*(-?[\d.]+px)?/gu)].map((match) => {
      const channels = match[1].split(",").map((part) => Number.parseFloat(part));
      return { alpha: channels.length === 4 ? channels[3] : 1, at: match[2] ? Number.parseFloat(match[2]) : null };
    });
    expect(stops.length, layout.mask).toBeGreaterThanOrEqual(2);
    let clearUntil = 0;
    for (const stop of stops) {
      if (stop.alpha > 0) break;
      clearUntil = stop.at ?? clearUntil;
    }
    expect(clearUntil, layout.mask).toBeGreaterThanOrEqual(layout.pillBottom);
    expect(errors, errors.join("; ")).toEqual([]);
  });
}
