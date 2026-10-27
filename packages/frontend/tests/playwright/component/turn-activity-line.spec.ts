import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

// A turn's plain-language activity line and its Details, mounted alone with
// the production layout: one quiet line that never wraps or scrolls the page,
// a real button with its state for keyboards and screen readers, and output
// that stays collapsed until asked for.

const FIXTURE_PATH = "/__turn-activity-line-fixture__";
const LONG_SUMMARY =
  "Looked up 14 places in the old town of Lisbon, read 6 pages about Belém, built the map";

type LineState = { running: boolean; long: boolean };

async function mountFixture(page: Page, { dark = false }: { dark?: boolean } = {}): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { AgentJobThreadPreviewLayout } from "/src/screens/studio/components/AgentJobThreadPreviewLayout.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    document.documentElement.classList.toggle("dark", ${dark});
    document.body.className = "${dark ? "bg-[var(--color-studio-dark-panel)] text-slate-200" : "bg-white text-slate-700"}";
    const jobId = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
    const message = {
      id: "activity-thread", role: "assistant", authorId: null, content: "", timestamp: 0,
      files: null, messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId, agent: { handle: "octo" } },
    };
    const command = (id, text, status, output) => ({
      id, role: "assistant", authorId: null, content: text, timestamp: 0, files: null,
      messageType: "command_execution",
      metadata: { source: "agent", jobId, messageType: "command_execution",
        details: { kind: "codex_command_execution", itemId: id, command: text, status, aggregatedOutput: output } },
    });
    const steps = (running) => [
      { kind: "step", id: "a", step: { kind: "command", state: "done", activity: null, label: "Read 6 pages",
        message: command("a", "bash -lc 'instafy web read https://www.visitlisboa.com/en/places/belem-tower https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower'", "completed", "Belém Tower\\n".repeat(30)) } },
      { kind: "step", id: "b", step: { kind: "command", state: running ? "running" : "done", activity: null,
        label: running ? "Looking up places" : "Looked up 14 places",
        message: command("b", "bash -lc 'uw() { node .agents/skills/interactive-map/scripts/uw.mjs \\"$@\\"; }\\nfor spec in a b c; do uw add-point --json \\"$spec\\"; done'", running ? "in_progress" : "completed", "Serving map at http://localhost:4173/") } },
    ];
    function Fixture() {
      const [state, setState] = React.useState({ running: true, long: false });
      const [detailsOpen, setDetailsOpen] = React.useState(false);
      window.__setLineState = (update) => setState((current) => ({ ...current, ...update }));
      const activity = {
        live: state.running ? (state.long ? "Judging calm and lively areas around the river…" : "Looking up places…") : null,
        summary: state.running ? null : (state.long ? ${JSON.stringify(LONG_SUMMARY)} : "Looked up 14 places, read 6 pages, built the map"),
        stepCount: 2,
        details: steps(state.running),
      };
      return h("main", { style: { padding: "16px 16px 16px 48px", maxWidth: "1000px" } },
        h(AgentJobThreadPreviewLayout, {
          message, projectId: "fixture-project", branchThreads: [], showHeaderAvatar: true,
          assistantAvatarMotion: "idle", activity, detailsOpen, cards: [],
          isThreadUnresolved: state.running, canCancelTerminalRun: false, cancelPending: false,
          expandedUpdateIds: {},
          finalSummaryMessage: state.running ? null : { id: "reply", role: "assistant", authorId: null,
            content: "Here's your Lisbon weekend: three days, fourteen places.", timestamp: 0, files: null,
            metadata: { source: "agent", jobId, outcome: "success" } },
          hasPreview: false, previewText: "", isCompleted: !state.running, shouldAnimateThreadLiveState: state.running,
          latestFiles: null, isRunning: state.running, finalSpineTone: "primary",
          threadPreviewRootRef: React.useRef(null), threadPreviewRef: React.useRef(null),
          threadPreviewRootStyle: { "--thread-spine-left": "-26px", "--thread-header-left": "-42px" },
          threadPreviewRailStyle: { top: "32px", bottom: "0px" },
          threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
          threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]",
          onOpenBranchThread() {}, onToggleDetails() { setDetailsOpen((open) => !open); },
          onToggleUpdateExpanded() {}, onCancelRun() {},
          MessageContent: ({ content }) => h("p", null, content), ChatFileChangeList: () => null,
        }),
        h("p", { "data-testid": "following-content" }, "Following conversation content"));
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
  await expect(page.getByTestId("turn-activity-line"), errors.join("; ")).toBeVisible();
  return errors;
}

async function setLine(page: Page, update: Partial<LineState>) {
  await page.evaluate((next) => {
    (window as unknown as { __setLineState: (state: Partial<LineState>) => void }).__setLineState(next);
  }, update);
}

async function lineGeometry(page: Page) {
  return page.getByTestId("turn-activity-line").evaluate((line) => {
    const label = line.querySelector<HTMLElement>("[data-sweep-text]")!;
    const box = line.getBoundingClientRect();
    return {
      height: box.height,
      right: box.right,
      labelTruncated: label.scrollWidth > label.clientWidth,
      title: line.getAttribute("title"),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
}

for (const dark of [false, true]) {
  for (const width of [1280, 390]) {
    test(`one plain line opens Details by keyboard at ${width}px (${dark ? "dark" : "light"})`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 800 });
      const errors = await mountFixture(page, { dark });
      const line = page.getByTestId("turn-activity-line");

      // Running: the current step in plain words, swept, and announced politely.
      await expect(line).toHaveAccessibleName("Looking up places… Details");
      await expect(line).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("turn-activity-announcement")).toHaveAttribute("aria-live", "polite");
      await expect(line.locator(".instafy-status-sweep")).toHaveCount(1);
      const running = await lineGeometry(page);
      expect(running.height).toBe(20);
      expect(running.documentWidth).toBe(running.viewportWidth);

      // A long line stays one line and truncates, with the whole text as its title.
      await setLine(page, { long: true });
      const long = await lineGeometry(page);
      expect(long.height).toBe(20);
      expect(long.documentWidth).toBe(long.viewportWidth);
      if (width === 390) expect(long.labelTruncated).toBe(true);
      expect(long.title).toBe("Judging calm and lively areas around the river…");

      // Done: the summary, no sweep, and the same one line.
      await setLine(page, { running: false, long: false });
      await expect(line).toHaveAccessibleName("Looked up 14 places, read 6 pages, built the map Details");
      await expect(page.locator(".instafy-status-sweep")).toHaveCount(0);
      await expect(page.getByText("Here's your Lisbon weekend")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`turn-done-${width}-${dark ? "dark" : "light"}.png`) });

      // Keyboard: Tab reaches the line, Enter opens Details, which lists the steps.
      await page.keyboard.press("Tab");
      await expect(line).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(line).toHaveAttribute("aria-expanded", "true");
      await expect(line).toHaveAccessibleName("Looked up 14 places, read 6 pages, built the map Hide details");
      const details = page.getByRole("list", { name: "Steps" });
      await expect(details).toBeVisible();
      await expect(details.getByRole("listitem")).toHaveCount(2);
      const controls = await line.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
      // Output stays collapsed until its own chevron.
      await expect(page.getByTestId("chat-command-output")).toHaveCount(0);
      const showOutput = details.getByRole("button", { name: "Show output" }).first();
      await showOutput.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("chat-command-output")).toHaveCount(1);
      await expect(details.getByRole("button", { name: "Hide output" })).toHaveAttribute("aria-expanded", "true");
      const opened = await lineGeometry(page);
      expect(opened.documentWidth).toBe(opened.viewportWidth);
      await page.screenshot({ path: testInfo.outputPath(`turn-details-${width}-${dark ? "dark" : "light"}.png`) });

      await line.focus();
      await page.keyboard.press("Space");
      await expect(line).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("list", { name: "Steps" })).toHaveCount(0);
      expect(errors, errors.join("; ")).toEqual([]);
    });
  }
}

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });

  test("gives the line and the step rows a 44px target on a coarse pointer", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await mountFixture(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await setLine(page, { running: false });
    const line = page.getByTestId("turn-activity-line");
    expect((await line.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await line.tap();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    const toggle = page.getByTestId("turn-activity-command-output-toggle").first();
    const box = await toggle.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors, errors.join("; ")).toEqual([]);
  });
});

test("reduced motion keeps the running line still", async ({ page }) => {
  const errors = await mountFixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page
    .getByTestId("turn-activity-line")
    .evaluate((line) => line.getAnimations({ subtree: true }).length);
  expect(animations).toBe(0);
  expect(errors, errors.join("; ")).toEqual([]);
});
