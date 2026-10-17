import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const FIXTURE_PATH = "/__typing-agent-stack__";
const SCENARIOS = [
  { count: 1, octo: true, label: "Verifying the complete implementation and its unusually long integration-test results before responding" },
  { count: 3, octo: false, label: "3 working" },
  { count: 8, octo: true, label: "5 working · 3 queued" },
  { count: 64, octo: false, label: "32 working · 24 queued · 8 waiting for approval" },
];

async function mountFixture(page: Page, theme: "light" | "dark") {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatTypingRows } from "/src/screens/studio/components/ChatTypingRows.tsx";
    import { ChatMessageAvatar } from "/src/screens/studio/components/ChatMessageAvatar.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const scenarios = ${JSON.stringify(SCENARIOS)};
    createRoot(document.getElementById("root")).render(
      h("main", { className: "mx-auto max-w-3xl p-4 text-slate-900 dark:text-slate-100" },
        h("h1", { className: "mb-6 text-sm" }, "Typing status layout fixture (synthetic)"),
        scenarios.map(({ count, octo, label }) => {
          const agents = Array.from({ length: count }, (_, index) => ({
            handle: octo && index === 0 ? "octo" : "implementation-reviewer-" + index,
            avatarSeed: octo && index === 0 ? "octo" : "reviewer-" + index,
            displayName: "Reviewer with a deliberately long display name " + index,
            isThinking: true,
          }));
          const ariaLabel = agents.map(agent => agent.displayName).join(", ") + " are working";
          return h("section", { key: count, "data-count": count, className: "mb-8" },
            h("h2", { className: "mb-3 text-xs text-slate-500" }, count + (count === 1 ? " agent" : " agents")),
            h(ChatTypingRows, {
              peerTypingLabel: null, isAssistantTyping: true,
              isAssistantTypingCoveredByJobThreadPreview: false,
              typingAgents: agents, hasMultipleTypingAgents: count > 1,
              typingAgentHandle: agents[0].handle, typingAgentAvatarSeed: agents[0].avatarSeed,
              typingIndicatorState: { phase: "thinking", label: count === 1 ? label : null },
              typingStatusLabel: label, typingStatusAriaLabel: ariaLabel,
              isThinkingLabelExpanded: false, onToggleThinkingLabel() {},
              latestDisplayedMessageId: "fixture-message",
              renderAssistantAvatar: (_metadata, agent, options) => h(ChatMessageAvatar, { kind: "assistant", agent, ...options }),
            }));
        })));
  `;
  const html = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body class="bg-white dark:bg-[var(--color-studio-dark-panel)]"><div id="root"></div></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, route => route.fulfill({ contentType: "application/javascript", body: main }));
  // The fixture supplies inert assistant identities; all rendered avatar,
  // status and row components, including their CSS, are production code.
  const catalog = "/src/assistants/localBuiltInAssistantCatalog.ts";
  await page.route(`**${catalog}*`, route => route.fulfill({
    contentType: "application/javascript", body: RUN_STOP_FIXTURE_STUBS[catalog],
  }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(SCENARIOS.length);
  return errors;
}

for (const theme of ["light", "dark"] as const) {
  test(`typing avatar stacks keep status text clear in ${theme} on desktop and phones`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors = await mountFixture(page, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`typing-${theme}-${width}.png`) });
      const measurements: object[] = [];
      for (const { count, label, octo } of SCENARIOS) {
        const row = page.locator(`[data-count="${count}"]`);
        const indicator = row.getByTestId("assistant-typing-indicator");
        await expect(indicator).toHaveAttribute("aria-live", "polite");
        await expect(indicator.locator(".sr-only")).toContainText("Reviewer with a deliberately long display name");
        await expect(indicator.locator("[data-sweep-text]")).toHaveText(label);
        const layout = await row.evaluate(element => {
          const label = element.querySelector<HTMLElement>("[data-sweep-text]")!;
          const bounds = (node: Element) => {
            const { left, right, width, height } = node.getBoundingClientRect();
            return { left, right, width, height };
          };
          const visible = (node: Element) => node.getBoundingClientRect().width > 0;
          return {
            label: bounds(label),
            faces: [...element.querySelectorAll('[data-testid="assistant-typing-stack-face"]')].filter(visible).map(bounds),
            singleFace: [...element.querySelectorAll('[data-testid="chat-avatar-assistant"]')].filter(visible).map(bounds),
            compactOcto: [...element.querySelectorAll('[data-testid="assistant-thinking-octo-compact"]')].filter(visible).map(bounds),
            clippedLabel: label.scrollWidth > label.clientWidth,
          };
        });
        measurements.push({ count, ...layout });
        expect(layout.label.width).toBeGreaterThan(0);
        expect(layout.label.right).toBeLessThanOrEqual(width);
        if (width >= 640 && count > 1) {
          expect(layout.faces).toHaveLength(2);
          // Preserve avatar-to-avatar overlap, reserving the whole stack
          // before text starts. The fixed 32px gutter regresses here.
          expect(layout.faces[0].right).toBeGreaterThan(layout.faces[1].left);
          expect(layout.faces[1].left).toBeGreaterThan(layout.faces[0].left);
          expect(layout.label.left - layout.faces[1].right).toBeGreaterThanOrEqual(8);
        } else if (width >= 640) {
          expect(layout.singleFace).toHaveLength(1);
          expect(layout.singleFace[0].width).toBe(32);
          expect(layout.label.left - layout.singleFace[0].right).toBe(12);
        } else if (width < 640) {
          expect(layout.faces).toHaveLength(0);
          expect(layout.compactOcto).toHaveLength(octo ? 1 : 0);
          for (const avatar of layout.compactOcto) {
            expect(layout.label.left - avatar.right).toBeGreaterThanOrEqual(8);
          }
        }
        if (count === 1 && width < 640) expect(layout.clippedLabel).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await testInfo.attach(`typing-${theme}-${width}-geometry`, {
        body: JSON.stringify(measurements, null, 2), contentType: "application/json",
      });
    }
    expect(errors).toEqual([]);
  });
}
