import { expect, test, type Locator, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__chat-message-reading-fixture__";
const IDENTIFIER = "r".repeat(70);
const COMMAND = String.raw`node ./tools/check.mjs --workspace "./demo project" --pattern "alpha\\beta" --filter "reader layout" --report "./artifacts/reading.json"`;
const MULTILINE = 'echo "first"\n  echo "second"';
const CONTENT = [
  "First paragraph explains the change in plain language.",
  "Second paragraph gives the next useful detail.",
  "**Reading details.**",
  "Use `flag` for the check.",
  `Identifier \`${IDENTIFIER}\`.`,
  `Run \`${COMMAND}\`.`,
  `Run \`${COMMAND}\`, then inspect the result.`,
  `Inspect \`${MULTILINE}\`.`,
  "- Read the report.\n- Check the result.",
  "> Quoted context stays readable.",
  "```sh\necho ready\n```",
].join("\n\n");

async function mountFixture(page: Page, dark: boolean): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { MessageContent } from "/src/screens/studio/components/ChatMessageContent.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    // Human and assistant bodies both use MessageContent with its default typography.
    createRoot(document.getElementById("root")).render(
      React.createElement("main", { style: { padding: "16px" } },
        ...["human", "assistant"].map((role) => React.createElement("article", {
          key: role, "data-testid": "reading-" + role,
          style: { width: "100%", maxWidth: "800px", marginBottom: "32px" },
        }, React.createElement(MessageContent, { content: ${JSON.stringify(CONTENT)} }))),
      ),
    );`;
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
  const js = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  await page.route("**/src/conversations/ConversationMessageMetadata.tsx*", (route) => route.fulfill(js(
    "export function useConversationMessageMetadata() { return { extraAgentHandles: [], resolveConversationLocalId: () => null }; }",
  )));
  await page.route("**/src/workspace/WorkspaceTabsProvider.tsx*", (route) => route.fulfill(js(
    "export function useWorkspaceTabs() { return { openConversationTab() {}, openPanelTab() {}, requestUrlPush() {} }; }",
  )));
  await page.route("**/src/status/useStatus.tsx*", (route) => route.fulfill(js(
    "export function useStatus() { return { showStatus() {} }; }",
  )));
  await page.route("**/src/sdk/instafy/index.ts*", (route) => route.fulfill(js("export const controllerClient = {};")));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("reading-assistant").locator("p").first()).toHaveText(
    "First paragraph explains the change in plain language.",
  );
  await page.evaluate(() => document.fonts.ready);
  expect(errors).toEqual([]);
}

async function expectAttachedPunctuation(code: Locator, expectedText: string, punctuation: string) {
  const result = await code.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.length) lastText = walker.currentNode as Text;
    }
    const punctuationNode = element.nextSibling;
    if (!lastText || punctuationNode?.nodeType !== Node.TEXT_NODE) {
      throw new Error("Code must have an adjacent punctuation text node");
    }
    const lastCharacter = document.createRange();
    lastCharacter.setStart(lastText, lastText.length - 1);
    lastCharacter.setEnd(lastText, lastText.length);
    const punctuationRange = document.createRange();
    punctuationRange.setStart(punctuationNode, 0);
    punctuationRange.setEnd(punctuationNode, 1);
    const lastRect = lastCharacter.getClientRects()[0];
    const punctuationRect = punctuationRange.getClientRects()[0];
    if (!lastRect || !punctuationRect) throw new Error("Code and punctuation must have visible glyph rectangles");
    const selectedCode = document.createRange();
    selectedCode.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectedCode);
    const selectedText = selection?.toString();
    selection?.removeAllRanges();
    return {
      selectedText,
      punctuation: punctuationNode.textContent,
      sameLine: punctuationRect.top < lastRect.bottom && punctuationRect.bottom > lastRect.top,
      punctuationFollowsCode: punctuationRect.left >= lastRect.left,
    };
  });
  expect(result.selectedText).toBe(expectedText);
  expect(result.punctuation).toBe(punctuation);
  expect(result.sameLine, "punctuation stays on the last code line").toBe(true);
  expect(result.punctuationFollowsCode).toBe(true);
}

for (const width of [360, 899, 900, 1024]) {
  for (const dark of [false, true]) {
    test(`chat reading remains contained at ${width}px in ${dark ? "dark" : "light"} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      await mountFixture(page, dark);

      for (const role of ["human", "assistant"]) {
        const body = page.getByTestId(`reading-${role}`);
        const paragraphs = body.locator("p");
        const metrics = await paragraphs.evaluateAll((nodes) => {
          const first = nodes[0].getBoundingClientRect();
          const second = nodes[1].getBoundingClientRect();
          const style = getComputedStyle(nodes[0]);
          return { gap: second.top - first.bottom, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily };
        });
        expect(metrics.gap).toBeCloseTo(16, 1);
        expect(metrics.fontSize).toBe("14px");
        expect(metrics.lineHeight).toBe(width >= 900 ? "21px" : "22.75px");
        expect(metrics.fontFamily.split(",")[0].trim()).toBe(width >= 900 ? "-apple-system" : "Inter");
        for (const prose of [body.locator("li").first(), body.locator("blockquote p")]) {
          await expect(prose).toHaveCSS("font-family", metrics.fontFamily);
          await expect(prose).toHaveCSS("font-size", metrics.fontSize);
          await expect(prose).toHaveCSS("line-height", metrics.lineHeight);
        }
        await expect(body.locator("strong")).toHaveText("Reading details.");
        await expect(body.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
        expect(await body.locator("strong").evaluate((node) => getComputedStyle(node).display)).toBe("inline");

        const codes = body.getByTestId("chat-message-inline-code");
        await expect(codes).toHaveCount(5);
        await expect(codes.nth(0)).toHaveAttribute("data-code-layout", "inline");
        const quietCode = await codes.nth(0).evaluate((node) => {
          const style = getComputedStyle(node);
          return { border: style.borderTopWidth, shadow: style.boxShadow, fontSize: Number.parseFloat(style.fontSize) };
        });
        expect(quietCode.border).toBe("0px");
        expect(quietCode.shadow).toBe("none");
        expect(quietCode.fontSize).toBeCloseTo(14 * 0.92, 1);
        for (const code of [codes.nth(0), body.getByTestId("chat-message-code-block")]) {
          expect(await code.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("monospace");
        }
        await expect(codes.nth(1)).toHaveAttribute("data-code-layout", "inline");
        await expectAttachedPunctuation(codes.nth(1), IDENTIFIER, ".");
        await expectAttachedPunctuation(codes.nth(2), COMMAND, ".");
        await expectAttachedPunctuation(codes.nth(3), COMMAND, ",");
        await expect(codes.nth(3).locator("xpath=ancestor::p")).toHaveText(`Run ${COMMAND}, then inspect the result.`);
        expect(await codes.nth(4).textContent()).toBe(MULTILINE);

        const bounds = await body.evaluate((article) => {
          const articleRect = article.getBoundingClientRect();
          return Array.from(article.querySelectorAll('[data-testid="chat-message-inline-code"]')).map((code) => {
            const surface = code.closest('[data-testid="chat-message-long-code"]') ?? code.parentElement!;
            const rect = surface.getBoundingClientRect();
            return {
              left: rect.left - articleRect.left,
              right: rect.right - articleRect.right,
              overflow: surface.scrollWidth - surface.clientWidth,
              layout: code.getAttribute("data-code-layout"),
              whiteSpace: getComputedStyle(surface).whiteSpace,
            };
          });
        });
        for (const bound of bounds) {
          expect(bound.left).toBeGreaterThanOrEqual(-1);
          expect(bound.right).toBeLessThanOrEqual(1);
          expect(bound.overflow).toBeLessThanOrEqual(1);
          if (bound.layout === "block") expect(bound.whiteSpace).toBe("pre-wrap");
        }
        await expect(body.getByTestId("chat-message-long-code")).toHaveCount(3);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`chat-reading-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    });
  }
}
