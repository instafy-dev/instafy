import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const FIXTURE_PATH = "/__run-icon-rail-fixture__";

type RailState = {
  waiting: boolean;
  completed: boolean;
  overflow: boolean;
  count: number;
  start: number;
  showStatus: boolean;
  status: string;
  actor: string | null;
};

async function mountFixture(page: Page, initial: Partial<RailState> = {}): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { AgentJobThreadPreviewLayout } from "/src/screens/studio/components/AgentJobThreadPreviewLayout.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const events = Array.from({ length: 32 }, (_, index) => ({
      id: "event-" + index,
      kind: index % 2 ? "command" : "thinking",
      previewText: "Run update " + index,
    }));
    const message = {
      id: "rail-thread", role: "assistant", authorId: null, content: "", timestamp: 0,
      files: null, messageType: "agent_job_thread",
      metadata: { messageType: "agent_job_thread", jobId: "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10", agent: { handle: "octo" } },
    };
    function Fixture() {
      const [state, setState] = React.useState(${JSON.stringify({ waiting: true, completed: false, overflow: false, count: 3, start: 0, showStatus: false, status: "", actor: null, ...initial })});
      window.__setRailState = (update) => setState((current) => ({ ...current, ...update }));
      const visibleEvents = events.slice(state.start, state.start + state.count);
      window.__railState = state;
      return h("main", { style: { padding: "16px", maxWidth: "1000px" } },
        h(AgentJobThreadPreviewLayout, {
          message, projectId: "fixture-project", branchThreads: [], showHeaderAvatar: false,
          showHeaderIdentity: false, assistantAvatarMotion: "idle", hiddenUpdateCount: 3,
          isHybridCompactionActive: false, isThreadPreviewExpanded: false,
          visibleCompactEvents: visibleEvents, overflowCompactCount: state.overflow ? 4 : 0,
          overflowCompactEvents: state.overflow ? events : [],
          latestCompactEventId: visibleEvents.at(-1)?.id ?? null,
          showCompactRailWaitingSpinner: state.waiting, isThreadUnresolved: !state.completed,
          singleCompactEvent: visibleEvents.length === 1 ? visibleEvents[0] : null,
          singleCompactEventLabel: "Reasoning", showSingleCompactEventStatusSweep: false,
          canCancelTerminalRun: false, cancelPending: false, compactRailStatusText: state.status,
          shouldSweepCompactRailStatusText: state.showStatus, showCollapsedCompactRailStatus: state.showStatus,
          showLiveCommandOutput: false, showLiveCommandPlaceholder: false,
          showCollapsedCommandToggle: false, showCollapsedCommandOutput: false,
          latestCommandExecution: null, latestCommandAgentHandle: state.actor, latestCommandPreview: "",
          updatesForInlineRendering: [], expandedUpdateIds: {}, finalSummaryMessage: null,
          hasPreview: false, previewText: "", showSummaryBody: false, suppressSummaryRunningStatus: false,
          isCompleted: state.completed, showRunningSpinnerFallback: false,
          shouldAnimateThreadLiveState: !state.completed, runningStatusLabel: null,
          useCompactRunningPreview: false, runningPreviewHasOverflow: false, latestFiles: null,
          isRunning: !state.completed, finalSpineTone: "primary",
          threadPreviewRootRef: React.useRef(null), threadPreviewRef: React.useRef(null),
          runningPreviewContainerRef: React.useRef(null),
          threadPreviewRootStyle: { "--thread-spine-left": "-26px", "--thread-header-left": "-42px" },
          threadPreviewRailStyle: { top: "32px", bottom: "40px" },
          threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
          threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]", summaryBodyPaddingTopClass: "pt-1",
          onOpenBranchThread() {}, onExpandThreadPreview() {}, onCollapseThreadPreview() {},
          onToggleThreadPreview() {}, onToggleCommandOutput() {}, onToggleUpdateExpanded() {},
          onCancelRun() { window.__runCancelCount = (window.__runCancelCount ?? 0) + 1; },
          MessageContent: ({ content }) => h("span", null, content), ChatFileChangeList: () => null,
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
  // Keep transport/provider edges outside this deterministic layout fixture.
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill(js(body)));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("agent-thread-compact-rail"), errors.join("; ")).toBeVisible();
  return errors;
}

// Seek the browser's actual CSS animations so CPU load cannot turn a delayed
// entrance into a passing test by letting wall-clock time advance first.
async function transitionRail(page: Page, update: Partial<RailState>, target: "event" | "spinner" | null = null) {
  return page.evaluate(async ({ update, target }) => {
    const fixture = window as unknown as {
      __setRailState: (state: Partial<RailState>) => void;
      __railState: RailState;
    };
    const rail = document.querySelector<HTMLElement>('[data-testid="agent-thread-compact-rail"]')!;
    const buttons = () => [...rail.querySelectorAll<HTMLButtonElement>("button.instafy-compact-event-pill")];
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    for (const animation of rail.getAnimations({ subtree: true })) {
      if ((animation as CSSAnimation).animationName === "compact-event-pill-in") animation.finish();
    }
    const before = buttons().map((button) => ({ button, box: bounds(button) }));
    const following = document.querySelector('[data-testid="following-content"]')!;
    const followingBefore = bounds(following);
    fixture.__setRailState(update);
    // React has committed once the expected state is rendered and two frames
    // have passed; sampling follows the same mounted rail through each update.
    while (!Object.entries(update).every(([key, value]) => fixture.__railState[key as keyof RailState] === value)) {
      await new Promise(requestAnimationFrame);
    }
    await new Promise(requestAnimationFrame);
    const pill = target === "event" ? buttons().at(-1)
      : target === "spinner" ? rail.querySelector<HTMLElement>("span.instafy-compact-event-pill") : null;
    if (pill) {
      for (const animation of pill.getAnimations()) {
        if ((animation as CSSAnimation).animationName === "compact-event-pill-in") {
          animation.pause();
          animation.currentTime = 100;
        }
      }
    }
    const surviving = before.filter(({ button }) => button.isConnected);
    return {
      surviving: surviving.map(({ button, box }) => ({ before: box, after: bounds(button) })),
      count: buttons().length,
      opacity: pill ? Number(getComputedStyle(pill).opacity) : null,
      followingBefore,
      followingAfter: bounds(following),
      spinnerCount: rail.querySelectorAll("span.instafy-compact-event-pill").length,
    };
  }, { update, target });
}

function expectRetainedChipsStable(
  result: Awaited<ReturnType<typeof transitionRail>>,
  count: number,
  horizontalShift = 0,
  compareFollowingContent = true,
) {
  expect(result.surviving).toHaveLength(count);
  for (const { before, after } of result.surviving) {
    expect(after).toEqual({ ...before, x: before.x + horizontalShift });
  }
  if (compareFollowingContent) expect(result.followingAfter).toEqual(result.followingBefore);
}

test("live run rail replaces its loader promptly without moving existing chips", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await mountFixture(page, { count: 17, overflow: true });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await transitionRail(page, { count: 17, start: 0, waiting: true, completed: false });

    // Long histories used to delay this new chip by 576ms after removing the
    // spinner, creating a false pause before the rail's right edge reappeared.
    for (const count of [18, 19]) {
      const appended = await transitionRail(page, { count, waiting: false }, "event");
      expectRetainedChipsStable(appended, count - 1);
      expect(appended.spinnerCount).toBe(0);
      expect(appended.opacity, "the replacement chip is visible 100ms after it mounts").toBeGreaterThan(0.9);

      const waiting = await transitionRail(page, { waiting: true }, "spinner");
      expectRetainedChipsStable(waiting, count);
      expect(waiting.spinnerCount).toBe(1);
      expect(waiting.opacity, "the next waiting indicator is visible promptly").toBeGreaterThan(0.9);
    }

    // At the cap, dropping the oldest update intentionally advances the
    // retained chips one 16px slot toward the earlier-updates indicator.
    const overflow = await transitionRail(page, { start: 1, waiting: false }, "event");
    expectRetainedChipsStable(overflow, 18, -16);
    expect(overflow.opacity).toBeGreaterThan(0.9);

    await transitionRail(page, { waiting: true });
    const stoppedWaiting = await transitionRail(page, { waiting: false });
    expectRetainedChipsStable(stoppedWaiting, 19);
    const completed = await transitionRail(page, { completed: true });
    // Completion adds the terminal spine segment below the rail.
    expectRetainedChipsStable(completed, 19, 0, false);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await transitionRail(page, { count: 18, start: 0, completed: false, waiting: true });
  const reduced = await transitionRail(page, { count: 19, waiting: false }, "event");
  expectRetainedChipsStable(reduced, 18);
  expect(reduced.opacity).toBe(1);
  expect(await page.getByTestId("agent-thread-compact-rail").evaluate((rail) => rail.getAnimations({ subtree: true }).length)).toBe(0);
  expect(errors, errors.join("; ")).toEqual([]);
});

async function readStatusGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const rail = document.querySelector('[data-testid="agent-thread-compact-rail"]')!;
    const text = document.querySelector<HTMLElement>('[data-sweep-text]')!;
    const actor = document.querySelector('[data-testid="agent-thread-command-owner"]');
    return {
      firstChip: rect(rail.querySelector('button.instafy-compact-event-pill')!),
      text: rect(text),
      row: rect(text.parentElement!),
      actor: actor ? rect(actor) : null,
      isTruncated: text.scrollWidth > text.clientWidth,
      availableWidth: document.querySelector<HTMLElement>('[data-testid="chat-bubble-assistant"]')!.clientWidth,
      title: text.title,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
}

for (const touch of [false, true]) {
  test.describe(touch ? "touch mobile run status" : "desktop run status", () => {
    test.use({ viewport: { width: touch ? 390 : 1280, height: 720 }, hasTouch: touch, isMobile: touch });

    test("keeps its caption aligned and transcript clear as status text changes", async ({ page }) => {
      test.setTimeout(60_000);
      const shortStatus = "Checking the next step";
      const longStatus = "pnpm --filter @instafy/frontend exec playwright test tests/playwright/component/run-icon-rail.spec.ts --reporter=list";
      const errors = await mountFixture(page, { count: 5, showStatus: true, status: shortStatus });
      await transitionRail(page, {});
      const initial = await readStatusGeometry(page);
      expect(initial.coarse).toBe(touch);
      expect(initial.text.x).toBe(initial.firstChip.x);
      expect(initial.text.y - initial.firstChip.bottom).toBe(touch ? 12 : 6);
      expect(initial.row.height).toBe(16);
      await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(0);
      expect(initial.row.width).toBe(initial.text.width + 6);
      expect(initial.row.width).toBeLessThan(initial.availableWidth);

      await transitionRail(page, { status: longStatus });
      const long = await readStatusGeometry(page);
      expect(long.row.width).toBeLessThanOrEqual(Math.min(512, long.availableWidth));
      expect(long.row.width).toBeGreaterThan(initial.row.width);
      expect(long.title).toBe(longStatus);
      expect(long.text.y).toBe(initial.text.y);
      expect(long.text.x).toBe(long.firstChip.x);
      expect(long.isTruncated).toBe(true);
      expect(long.documentWidth).toBe(long.viewportWidth);

      await transitionRail(page, { actor: "reviewer" });
      const actor = await readStatusGeometry(page);
      expect(actor.actor?.x).toBe(actor.firstChip.x);
      expect(actor.row.width).toBeLessThanOrEqual(Math.min(512, actor.availableWidth));
      expect(actor.title).toBe(longStatus);
      expect(actor.text.x).toBeGreaterThan(actor.actor!.right);

      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await readStatusGeometry(page)).toEqual(actor);
      await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(0);
      expect(errors, errors.join("; ")).toEqual([]);
    });
  });
}
