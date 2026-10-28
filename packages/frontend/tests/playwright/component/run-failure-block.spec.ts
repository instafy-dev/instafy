import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

// A turn the AI never answered, mounted alone with the production layout and
// failure block: one plain sentence, "Try again", "Manage AI" only when the
// person's own AI settings can fix it, and the raw diagnostic behind Details.
// Local drive, 2026-10-28: the proxy's 424 read "The upstream provider
// rejected the AI request. Retry later or switch credentials." with nothing to
// press.

const FIXTURE_PATH = "/__run-failure-block-fixture__";
const REFRESH_424 =
  "unexpected status 424 Failed Dependency: Upstream credentials could not be refreshed., url: http://proxy:8789/v1/responses";
// Local drive, 2026-10-28: a turn that made none of the changes it was asked
// for read "The file changes didn't come through." with this sentence under
// it, beside "Run failed", "Ran a command" and "✓ Retried".
const NO_CHANGES = "Codex did not apply any workspace changes for a file-modifying request.";

async function mountFixture(
  page: Page,
  { dark = false, failureText = REFRESH_424 }: { dark?: boolean; failureText?: string } = {},
): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { AgentJobThreadPreviewLayout } from "/src/screens/studio/components/AgentJobThreadPreviewLayout.tsx";
    import { RunFailureRetryProvider } from "/src/screens/studio/components/RunFailureNotice.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    document.documentElement.classList.toggle("dark", ${dark});
    document.body.className = "${dark ? "bg-[var(--color-studio-dark-panel)] text-slate-200" : "bg-white text-slate-700"}";
    const jobId = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
    const message = {
      id: "failed-thread", role: "assistant", authorId: null, content: "", timestamp: 0,
      files: null, messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId, agent: { handle: "octo" } },
    };
    window.__presses = { retry: 0, manageAi: 0 };
    function Fixture() {
      const [aiAccessMode, setAiAccessMode] = React.useState("byoc");
      const [autoRetrying, setAutoRetrying] = React.useState(false);
      window.__setAiAccessMode = setAiAccessMode;
      window.__setAutoRetrying = setAutoRetrying;
      const failure = {
        id: "failure-" + aiAccessMode, role: "assistant", authorId: null, content: ${JSON.stringify(failureText)},
        timestamp: 0, files: null, messageType: "error",
        metadata: { source: "agent", outcome: "failed", messageType: "error", jobId,
          errorMessage: ${JSON.stringify(failureText)}, aiAccessMode },
      };
      const retry = {
        pendingRetryKey: null, autoRetryingKey: autoRetrying ? failure.id : null,
        requestRetry() { window.__presses.retry += 1; },
        onConnectAi() { window.__presses.manageAi += 1; },
      };
      return h(RunFailureRetryProvider, { value: retry }, h("main", { style: { padding: "16px 16px 16px 48px", maxWidth: "1000px" } },
        h(AgentJobThreadPreviewLayout, {
          message, projectId: "fixture-project", branchThreads: [], showHeaderAvatar: true,
          assistantAvatarMotion: "idle", activity: { live: null, summary: null, stepCount: 0, details: [] },
          browserApproval: null, detailsOpen: false, cards: [],
          isThreadUnresolved: false, canCancelTerminalRun: false, cancelPending: false,
          expandedUpdateIds: {}, finalSummaryMessage: failure,
          hasPreview: false, previewText: "", isCompleted: true, shouldAnimateThreadLiveState: false,
          latestFiles: null, isRunning: false, finalSpineTone: "danger",
          threadPreviewRootRef: React.useRef(null), threadPreviewRef: React.useRef(null),
          threadPreviewRootStyle: { "--thread-spine-left": "-26px", "--thread-header-left": "-42px" },
          threadPreviewRailStyle: { top: "32px", bottom: "0px" },
          threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
          threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]",
          onOpenBranchThread() {}, onToggleDetails() {}, onToggleUpdateExpanded() {}, onCancelRun() {},
          MessageContent: ({ content }) => h("p", null, content), ChatFileChangeList: () => null,
        }),
        h("p", { "data-testid": "following-content" }, "Following conversation content")));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;
  const js = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, (route) => route.fulfill(js(body)));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("run-failure-body"), errors.join("; ")).toBeVisible();
  return errors;
}

async function presses(page: Page): Promise<{ retry: number; manageAi: number }> {
  return page.evaluate(() => (window as unknown as { __presses: { retry: number; manageAi: number } }).__presses);
}

for (const dark of [false, true]) {
  for (const width of [1280, 390]) {
    test(`a turn the AI never answered offers its actions by keyboard at ${width}px (${dark ? "dark" : "light"})`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 800 });
      const errors = await mountFixture(page, { dark });
      const body = page.getByTestId("run-failure-body");
      const manageAi = body.getByRole("button", { name: "Manage AI" });
      const retry = body.getByRole("button", { name: "Try again" });
      const details = body.getByRole("button", { name: "Details" });

      // The person's own AI: what to do, and where. The block is the turn's
      // one status: no "Run failed" beside it.
      await expect(page.getByTestId("agent-thread-terminal-status")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("Run failed");
      await expect(body.locator("p").first()).toHaveText("Your AI connection needs you to sign in again.");
      await expect(manageAi).toBeVisible();
      await expect(retry).toBeVisible();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("main")).not.toContainText(/upstream|provider|credential|switch/i);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`own-ai-${width}-${dark ? "dark" : "light"}.png`) });

      // Keyboard: Manage AI, then Try again, then Details, in reading order.
      await page.keyboard.press("Tab");
      await expect(manageAi).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(retry).toBeFocused();
      await page.keyboard.press("Enter");
      expect(await presses(page)).toEqual({ retry: 1, manageAi: 1 });
      await page.keyboard.press("Tab");
      await expect(details).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(details).toHaveAttribute("aria-expanded", "true");
      await expect(details).toHaveAccessibleName("Hide details");
      await expect(page.getByTestId("run-failure-details")).toHaveText(REFRESH_424);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`own-ai-details-${width}-${dark ? "dark" : "light"}.png`) });
      await page.keyboard.press("Space");
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("run-failure-details")).toHaveCount(0);

      // Instafy AI: nothing for the person to fix, so no sign-in talk and no Manage AI.
      await page.evaluate(() => (window as unknown as { __setAiAccessMode: (mode: string) => void }).__setAiAccessMode("managed"));
      await expect(body.locator("p").first()).toHaveText("Instafy AI isn't answering right now.");
      await expect(body.getByRole("button", { name: "Manage AI" })).toHaveCount(0);
      await expect(retry).toBeVisible();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("main")).not.toContainText(/upstream|provider|credential|switch|sign in/i);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`instafy-ai-${width}-${dark ? "dark" : "light"}.png`) });
      expect(errors, errors.join("; ")).toEqual([]);
    });
  }
}

for (const dark of [false, true]) {
  for (const width of [1280, 390]) {
    test(`a turn that made none of its changes reads in plain words, and calmly while it is tried again, at ${width}px (${dark ? "dark" : "light"})`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 800 });
      const errors = await mountFixture(page, { dark, failureText: NO_CHANGES });
      const main = page.locator("main");
      const body = page.getByTestId("run-failure-body");
      const retry = body.getByRole("button", { name: "Try again" });
      const details = body.getByRole("button", { name: "Details" });

      // One plain sentence and its actions; nothing technical, one status.
      await expect(body.locator("p").first()).toHaveText("Octo didn't finish the changes.");
      await expect(main).not.toContainText(/codex|workspace|request|Run failed|Ran a command|Retried/i);
      await expect(page.getByTestId("turn-activity-line")).toHaveCount(0);
      // The failure block's own tinted rule.
      await expect(main.locator(".border-l-2")).toHaveCount(1);
      await expect(details).toHaveAccessibleName("Details");
      await expect(details).toHaveAttribute("aria-expanded", "false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`no-changes-${width}-${dark ? "dark" : "light"}.png`) });

      // Keyboard: Try again, then Details, which opens the runtime's own words.
      await page.keyboard.press("Tab");
      await expect(retry).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(details).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(details).toHaveAccessibleName("Hide details");
      const controlled = await details.getAttribute("aria-controls");
      expect(controlled).toBeTruthy();
      await expect(page.locator(`[id="${controlled}"]`).getByTestId("run-failure-details")).toHaveText(NO_CHANGES);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`no-changes-details-${width}-${dark ? "dark" : "light"}.png`) });

      // Tried again by itself: one quiet line, no failure, no red, no actions.
      await page.evaluate(() => (window as unknown as { __setAutoRetrying: (on: boolean) => void }).__setAutoRetrying(true));
      const quiet = page.getByTestId("run-failure-auto-retrying");
      await expect(quiet).toContainText("Trying again…");
      await expect(page.getByTestId("run-failure-body")).toHaveCount(0);
      await expect(main.getByRole("button")).toHaveCount(0);
      await expect(main).not.toContainText(/didn't finish|Run failed|Retried|codex|workspace/i);
      await expect(main.locator(".border-l-2")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`no-changes-retrying-${width}-${dark ? "dark" : "light"}.png`) });
      expect(errors, errors.join("; ")).toEqual([]);
    });
  }
}

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });

  test("gives the failure block's actions a 44px target on a coarse pointer", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await mountFixture(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const body = page.getByTestId("run-failure-body");
    for (const name of ["Manage AI", "Try again", "Details"]) {
      const box = await body.getByRole("button", { name }).boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors, errors.join("; ")).toEqual([]);
  });
});
