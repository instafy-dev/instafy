import { expect, test, type Locator, type Page } from "@playwright/test";

import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs.js";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

/**
 * The helper chips under a plan message (docs/Brand.md, "A plan's helper
 * chips"): the production MultiAgentPlanEntry and stylesheet, in a copy of the
 * chat bubble's classes around a plan message.
 *
 * On a touch screen Workstreams and Cancel group keep the chips' 24px look and
 * take Button's 44px target from an invisible ::after that reaches 10px into
 * the row's gaps, which open to 12px there. So no tap meant for a chip, an
 * open details panel, a rerun notice or the message lands on Cancel group,
 * which stops every remaining helper at once. A lane's "…" never takes a tap
 * there: the chip opens its run trace, and a long-press opens its menu. With a
 * mouse or keyboard the "…" takes the status glyph's slot, and nothing moves.
 * In a job-thread preview, whose card clips the row, no stop's focus ring or
 * touch target is cut.
 */
const FIXTURE_PATH = "/__plan-chips-fixture__";
const CATALOG = "/src/assistants/localBuiltInAssistantCatalog.ts";
const ARTIFACTS = "/src/capabilities/localCapabilityArtifactRegistry.ts";
const JOBS = "/src/services/runtimeController/jobs.ts";
const MESSAGE_TEXT = "plan-message-text";

type Scenario = {
  /** Lane handles, in plan order; the default is the eight-lane plan. */
  lanes?: string[];
  /** Lanes open their run trace (a chat that can open one); else a tap toggles their details. */
  trace?: boolean;
  /** An "expanded" plan: every lane's details open from the start. */
  expanded?: boolean;
  /** Help text's first turn ran out of time and continued: a rerun notice under the row. */
  rerun?: boolean;
  /** The plan as a card in a job-thread preview at its smallest inset, not in a chat bubble. */
  preview?: boolean;
};

async function mountFixture(page: Page, { preview = false }: { preview?: boolean } = {}): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { MultiAgentPlanEntry, MultiAgentRunsContext } from "/src/screens/studio/components/MultiAgentPlanEntry.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const AT = "2026-10-29T08:00:00Z";
    const GROUP = { parentJobId: "parent-job", groupId: "group-1" };
    const PICTURE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 4'%3E%3Crect width='4' height='4' fill='%23f97316'/%3E%3Ccircle cx='2' cy='2' r='1' fill='%23fff'/%3E%3C/svg%3E";
    const NOTE = "Wrote the draft and pushed it to the branch for the lead to review.";
    // Every status, a picture and a lane known only by its handle; the last
    // lane's note is long enough for "Full note" on its panel's last line.
    const LANES = {
      reading_list: { label: "Reading list", status: "success", seed: "hatchling:1" },
      help_text: { label: "Help text", status: "in_progress", seed: "hatchling:2" },
      release_note: { label: "Release note", status: "failed", seed: "hatchling:3" },
      meeting_note: { label: "Meeting note", status: "queued", seed: "hatchling:4" },
      pia: { label: "Pia", status: "success", seed: PICTURE, asking: true },
      survey: { label: "Survey", status: "awaiting_approval", seed: "hatchling:5" },
      old_draft: { label: "Old draft", status: "canceled", seed: "hatchling:6" },
      scout: { status: "queued", note: (NOTE + " ").repeat(10) },
      notes: { label: "Notes", status: "in_progress", seed: "hatchling:7" },
      // As wide as the row, whatever the font: it ends at the row's right end.
      onboarding: { label: "Rewrite the onboarding checklist for enterprise admins and the help centre", status: "failed", seed: "hatchling:8" },
    };
    const EIGHT = ["reading_list", "help_text", "release_note", "meeting_note", "pia", "survey", "old_draft", "scout"];
    const run = (id, handle, status, jobId, metadata = {}) => ({
      id, projectId: "project", sessionId: null, conversationId: "conversation", promptId: null, runType: "prompt",
      status, progress: 0, progressStage: null, previewUrl: null, lastMessage: LANES[handle]?.note ?? NOTE,
      createdAt: AT, updatedAt: AT, metadata: { jobId, agent: { handle }, multiAgentPlan: { ...GROUP, role: "worker" }, ...metadata },
    });
    window.__opened = [];
    window.__cancels = [];
    // What an element's clipping ancestors leave of the page: each clips, on
    // the axes it does not leave visible, to its padding box.
    window.__clipOf = (element) => {
      const clip = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          clip.left = Math.max(clip.left, rect.left + node.clientLeft);
          clip.right = Math.min(clip.right, rect.left + node.clientLeft + node.clientWidth);
        }
        if (style.overflowY !== "visible") {
          clip.top = Math.max(clip.top, rect.top + node.clientTop);
          clip.bottom = Math.min(clip.bottom, rect.top + node.clientTop + node.clientHeight);
        }
      }
      return clip;
    };
    let AgentJobThreadPreviewLayout = null;
    function Plan({ mountKey, lanes = EIGHT, trace = false, expanded = false, rerun = false, preview = false }) {
      React.useEffect(() => { window.__mountedKey = mountKey; }, [mountKey]);
      const runs = { lead: run("lead-run", "octo", "in_progress", "lead-job", { multiAgentPlan: { ...GROUP, role: "lead_continuation" } }) };
      lanes.forEach((handle, index) => {
        const lane = LANES[handle];
        runs[handle] = run(handle + "-run", handle, rerun && handle === "help_text" ? "failed" : lane.status, handle + "-job", {
          agent: { handle, ...(lane.seed ? { avatarSeed: lane.seed } : {}) },
          leaseMetrics: { leasedByRuntimeId: index % 2 ? "rt-c20e44" : "rt-7f3a91", agentHandle: handle, queueWaitMs: 2000, wallTimeMs: 72000 },
          ...(lane.asking ? { userInputRequest: { requestId: "request-" + handle, status: "pending" } } : {}),
        });
      });
      // As plan-rerun-notice.spec.ts: the feed holds only the stopped turn;
      // its continuation is known from the lane's own messages.
      const messages = rerun ? [
        { id: "stop", role: "assistant", timestamp: 5, content: "Codex run timed out",
          metadata: { jobId: "help_text-job", agent: { handle: "help_text" }, messageType: "error", outcome: "failed",
            multiAgentPlan: { ...GROUP, role: "worker" } } },
        { id: "next", role: "assistant", timestamp: 6, content: "",
          metadata: { jobId: "help_text-job-2", agent: { handle: "help_text" }, kind: "update",
            multiAgentPlan: { ...GROUP, role: "worker", continuation: { of: "help_text-job", turn: 1 } } } },
      ] : [];
      const details = {
        agents: lanes.map((handle) => ({ handle, label: LANES[handle].label, scopeSummary: "Draft the " + (LANES[handle].label ?? handle) })),
        lead: { leadHandle: "octo" },
        ...(expanded ? { presentation: { workerEvidenceVisibility: "expanded" } } : {}),
      };
      const planMessage = { id: "plan", role: "assistant", content: "", timestamp: 1,
        metadata: { jobId: "parent-job", messageType: "multi_agent_plan", multiAgentPlan: { groupId: "group-1" } } };
      if (preview) {
        // The production job-thread preview with the plan as its one card, at
        // its smallest body inset (4px), in the chat's gutter. Its message
        // bodies are plain paragraphs, as the plan message's is below.
        const text = ({ content }) => h("p", { "data-testid": "${MESSAGE_TEXT}" }, content);
        const card = { ...planMessage, id: "team-plan", content: "Splitting this into workstreams.",
          metadata: { ...planMessage.metadata, details } };
        const finished = { id: "summary", role: "assistant", authorId: null, content: "Finished.", timestamp: 2, files: null, metadata: null };
        return h("main", { className: "bg-white py-4 pl-12 pr-4 dark:bg-[var(--color-studio-dark-panel)]" },
          h(MultiAgentRunsContext.Provider, { value: { runs, scopeKey: "viewer" } },
            h(AgentJobThreadPreviewLayout, {
              message: { id: "thread", role: "assistant", authorId: null, content: "", timestamp: 0, files: null,
                messageType: "agent_job_thread", metadata: { messageType: "agent_job_thread", jobId: "thread-job", agent: { handle: "octo" } } },
              projectId: "project", branchThreads: [], showHeaderAvatar: true, assistantAvatarMotion: "idle",
              activity: { live: null, summary: null, stepCount: 0, details: [] }, browserApproval: null, detailsOpen: false,
              cards: [card], isThreadUnresolved: false, canCancelTerminalRun: false, cancelPending: false, expandedUpdateIds: {},
              finalSummaryMessage: finished, hasPreview: false, previewText: "", isCompleted: true,
              shouldAnimateThreadLiveState: false, latestFiles: null, isRunning: false, finalSpineTone: "neutral",
              threadPreviewRootRef: React.createRef(), threadPreviewRef: React.createRef(),
              threadPreviewRootStyle: { paddingLeft: "4px", "--thread-spine-left": "-28px", "--thread-header-left": "-48px" },
              threadPreviewRailStyle: { top: "32px", bottom: "16px" },
              threadSpineJunctionOffsetClass: "left-[var(--thread-spine-left)]",
              threadSpineHeaderOffsetClass: "left-[var(--thread-header-left)]",
              onOpenBranchThread() {}, onToggleDetails() {}, onToggleUpdateExpanded() {}, onCancelRun() {},
              MessageContent: text, ChatFileChangeList: () => null,
            })));
      }
      // ChatMessageEntries' NotchedMessageShell around a plan message, in the
      // chat panel's 16px gutter.
      return h("main", { className: "bg-white p-4 dark:bg-[var(--color-studio-dark-panel)]" },
        h("div", { className: "group relative inline-flex w-fit max-w-[min(92%,56rem)] min-w-0 flex-col items-start py-1 pr-2 text-sm text-slate-700 dark:text-slate-200" },
          h("div", { className: "w-full min-w-0" },
            h("p", { "data-testid": "${MESSAGE_TEXT}" }, "Splitting this into eight workstreams. I will pull their notes together as they land."),
            h(MultiAgentRunsContext.Provider, { value: { runs, scopeKey: "viewer" } },
              h(MultiAgentPlanEntry, {
                details, planMessage, conversationMessages: messages,
                conversationLocalId: trace ? "local" : null,
                onOpenWorkerRunTrace: (value) => window.__opened.push(value.jobId),
              })))));
    }
    const root = createRoot(document.getElementById("root"));
    let mounts = 0;
    // A fresh card per scenario; resolves once it is committed and painted.
    window.__mount = async (scenario) => {
      if (scenario.preview && !AgentJobThreadPreviewLayout) {
        AgentJobThreadPreviewLayout = (await import("/src/screens/studio/components/AgentJobThreadPreviewLayout.tsx")).AgentJobThreadPreviewLayout;
      }
      return mountPlan(scenario);
    };
    const mountPlan = (scenario) => new Promise((resolve) => {
      const mountKey = "mount-" + (mounts += 1);
      window.__opened.length = 0;
      window.__cancels.length = 0;
      root.render(h(Plan, { key: mountKey, mountKey, ...scenario }));
      const settled = () => window.__mountedKey === mountKey
        ? requestAnimationFrame(() => resolve())
        : requestAnimationFrame(settled);
      settled();
    });`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body style="margin:0"><div id="root"></div></body></html>`;
  const js = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  // Inert assistant identities (Octo is "octo") and no capability artifacts:
  // the card, its faces and their CSS are production code. The job-thread
  // preview around it also reaches the account, runtime and workspace, which
  // stay inert data boundaries.
  const stubs = preview ? Object.keys(RUN_STOP_FIXTURE_STUBS).filter((stub) => stub !== JOBS) : [CATALOG, ARTIFACTS];
  for (const stub of stubs) {
    await page.route(`**${stub}*`, (route) => route.fulfill(js(RUN_STOP_FIXTURE_STUBS[stub])));
  }
  // Every lane has a run, so the card never asks for the group's status; a
  // press on Cancel group is only recorded.
  await page.route(`**${JOBS}*`, (route) => route.fulfill(js(`
    export const cancelAgentJob = async () => ({ ok: false });
    export const cancelPlanGroup = async (groupId) => { window.__cancels.push(groupId); return { ok: false }; };
    export const fetchPlanGroupStatus = async () => null;
  `)));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => typeof (window as { __mount?: unknown }).__mount === "function", undefined, {
    timeout: 20_000,
  });
  return errors;
}

async function mount(page: Page, scenario: Scenario = {}) {
  await page.evaluate((value) => (window as unknown as { __mount: (scenario: Scenario) => Promise<void> }).__mount(value), scenario);
  await expect(page.getByTestId("multi-agent-inline-status")).toBeVisible();
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

/** Whether a tap at (x, y) lands inside the element with this test id. */
function landsIn(page: Page, x: number, y: number, testId: string): Promise<boolean> {
  return page.evaluate(([px, py, id]) => Boolean(document.elementFromPoint(px, py)?.closest(`[data-testid="${id}"]`)),
    [x, y, testId] as const);
}

const recorded = (page: Page, name: "__opened" | "__cancels") =>
  page.evaluate((key) => [...(window as unknown as Record<string, string[]>)[key]], name);

/**
 * Every point of something visible (the message, a chip, the lead, a details
 * panel, a rerun notice, the other Button's 24px box) within 14px of either
 * Button where a tap would land on that Button instead.
 */
function stolenTaps(page: Page) {
  return page.evaluate(() => {
    const byTestId = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
    const thieves = [...byTestId("multi-agent-cancel-group"), ...byTestId("multi-agent-team-chip")];
    const victims = [
      ...byTestId("plan-message-text"), ...byTestId("multi-agent-chip-shell"), ...byTestId("multi-agent-lead-status"),
      ...byTestId("multi-agent-evidence-detail"), ...byTestId("plan-rerun-notice"), ...thieves,
    ];
    const stolen: string[] = [];
    for (const thief of thieves) {
      const reach = thief.getBoundingClientRect();
      for (const victim of victims) {
        if (victim === thief) continue;
        const seen = victim.getBoundingClientRect();
        const left = Math.max(reach.left - 4, seen.left);
        const right = Math.min(reach.right + 4, seen.right);
        const top = Math.max(reach.top - 14, seen.top);
        const bottom = Math.min(reach.bottom + 14, seen.bottom);
        for (let y = top + 0.25; y < bottom; y += 0.5) {
          for (let x = left + 0.5; x < right; x += 2) {
            const hit = document.elementFromPoint(x, y);
            if (hit && thief.contains(hit) && !victim.contains(hit)) {
              stolen.push(`${thief.getAttribute("data-testid")} over ${victim.getAttribute("data-testid")} at ${x},${y}`);
            }
          }
        }
      }
    }
    return stolen;
  });
}

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("on a touch screen nothing you can see in a plan's row sits under Workstreams' or Cancel group's touch targets", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await mountFixture(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse) and (hover: none)").matches)).toBe(true);
    const team = page.getByTestId("multi-agent-team-chip");
    const cancel = page.getByTestId("multi-agent-cancel-group");

    // Both keep the chips' 24px box; the 44px target is the ::after, 10px
    // above and below it.
    await mount(page);
    for (const control of [team, cancel]) {
      expect((await box(control)).height).toBe(24);
      expect(await control.evaluate((element) => {
        const after = getComputedStyle(element, "::after");
        return [after.position, after.top, after.bottom];
      })).toEqual(["absolute", "-10px", "-10px"]);
    }

    // The last lane's details open: the panel is the line right above the
    // lead and Cancel group, and its last 4px stay the panel's.
    await page.getByTestId("multi-agent-evidence-row").last().tap();
    const panel = page.getByTestId("multi-agent-evidence-detail");
    await expect(panel).toHaveCount(1);
    await expect(panel.getByTestId("multi-agent-evidence-full-toggle")).toBeVisible();
    const panelBox = await box(panel);
    const cancelBox = await box(cancel);
    expect(cancelBox.y - (panelBox.y + panelBox.height)).toBeCloseTo(12, 0);
    for (const above of [1, 2, 3, 4]) {
      for (const share of [0.2, 0.5, 0.8]) {
        const x = cancelBox.x + cancelBox.width * share;
        expect(await landsIn(page, x, panelBox.y + panelBox.height - above, "multi-agent-evidence-detail"), `${above}px up`).toBe(true);
      }
    }
    expect(await stolenTaps(page)).toEqual([]);

    // One lane on a phone: Cancel group wraps alone, directly under
    // Workstreams, whose last 4px stay its own.
    await mount(page, { lanes: ["notes"] });
    let teamBox = await box(team);
    let wrapped = await box(cancel);
    expect(wrapped.y - (teamBox.y + teamBox.height), "Cancel group wraps to the next line").toBeCloseTo(12, 0);
    const left = Math.max(teamBox.x, wrapped.x);
    const right = Math.min(teamBox.x + teamBox.width, wrapped.x + wrapped.width);
    expect(right - left, "Cancel group sits under Workstreams").toBeGreaterThan(40);
    for (const up of [0.5, 1.5, 2.5, 3.5]) {
      for (const share of [0.2, 0.5, 0.8]) {
        expect(await landsIn(page, left + (right - left) * share, teamBox.y + teamBox.height - up, "multi-agent-team-chip")).toBe(true);
      }
    }
    expect(await stolenTaps(page)).toEqual([]);

    // One lane on a touch tablet: Cancel group is on the first line, and the
    // message's last 2px stay the message's, over both Buttons.
    await page.setViewportSize({ width: 768, height: 1024 });
    await mount(page, { lanes: ["notes"] });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    teamBox = await box(team);
    wrapped = await box(cancel);
    expect(wrapped.y, "Cancel group on the first line").toBeCloseTo(teamBox.y, 0);
    const text = await box(page.getByTestId(MESSAGE_TEXT));
    expect(teamBox.y - (text.y + text.height)).toBeCloseTo(12, 0);
    for (const control of [teamBox, wrapped]) {
      for (const up of [0.5, 1.5]) {
        for (const share of [0.2, 0.5, 0.8]) {
          expect(await landsIn(page, control.x + control.width * share, text.y + text.height - up, MESSAGE_TEXT)).toBe(true);
        }
      }
    }
    expect(await stolenTaps(page)).toEqual([]);

    // Every other layout the row takes, on a phone and a tablet: an
    // "expanded" plan opens every lane's details, and a rerun notice is the
    // line under Cancel group.
    for (const { width, scenario } of [
      { width: 768, scenario: {} },
      { width: 390, scenario: { expanded: true } },
      { width: 390, scenario: { rerun: true } },
      { width: 320, scenario: {} },
      { width: 320, scenario: { lanes: ["notes", "survey"] } },
    ] satisfies Array<{ width: number; scenario: Scenario }>) {
      await page.setViewportSize({ width, height: 1024 });
      await mount(page, scenario);
      await expect(page.getByTestId("multi-agent-evidence-detail")).toHaveCount(scenario.expanded ? 8 : 0);
      await expect(page.getByTestId("plan-rerun-notice")).toHaveCount(scenario.rerun ? 1 : 0);
      expect(await stolenTaps(page), `${width}px ${JSON.stringify(scenario)}`).toEqual([]);
    }

    // A tap 8px above Cancel group's box presses it; 13px above, past its
    // reach, it does not.
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, { trace: true });
    const pill = await box(cancel);
    await page.touchscreen.tap(pill.x + pill.width / 2, pill.y - 13);
    expect(await recorded(page, "__cancels")).toEqual([]);
    await page.touchscreen.tap(pill.x + pill.width / 2, pill.y - 8);
    await expect.poll(() => recorded(page, "__cancels")).toEqual(["group-1"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors, errors.join("; ")).toEqual([]);
  });

  test("on a touch screen a tap anywhere on a plan chip opens its run trace and a long-press opens its menu", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await mountFixture(page);
    await mount(page, { trace: true });
    const lanes = page.getByTestId("multi-agent-evidence-row");
    await expect(lanes).toHaveCount(8);

    // Taps 4, 12 and 24px from a chip's right end, where the "…" sits with a
    // mouse, open the chip's run trace.
    const expected: string[] = [];
    for (const lane of await lanes.all()) {
      const handle = (await lane.getAttribute("data-agent-handle"))!.replace(/^@/, "");
      const laneBox = await box(lane);
      for (const fromRight of [4, 12, 24]) {
        await page.touchscreen.tap(laneBox.x + laneBox.width - fromRight, laneBox.y + laneBox.height / 2);
        expected.push(`${handle}-job`);
        await expect.poll(() => recorded(page, "__opened"), `${fromRight}px from ${handle}'s end`).toEqual(expected);
      }
    }
    await expect(page.getByTestId("multi-agent-chip-menu")).toHaveCount(0);
    // The "…" never takes a tap, and stays in the accessibility tree.
    const menuButtons = page.getByRole("button", { name: /^More actions for / });
    await expect(menuButtons).toHaveCount(8);
    for (const menuButton of await menuButtons.all()) {
      expect(await menuButton.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect();
        return [getComputedStyle(element).pointerEvents, width, height];
      })).toEqual(["none", 20, 20]);
    }

    // A long-press opens the lane's menu, and not its run trace.
    const releaseNote = page.locator('[data-agent-handle="@release_note"]');
    const target = await box(releaseNote);
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const menu = page.getByTestId("multi-agent-chip-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-label", "Actions for Release note");
    // The open menu hides the rest of the page from the accessibility tree.
    await expect(releaseNote.locator("xpath=..").getByTestId("multi-agent-chip-menu-button")).toHaveAttribute("aria-expanded", "true");
    expect(await recorded(page, "__opened")).toEqual(expected);
    // A contextmenu on the open menu (a right-click, or Android's long-press
    // one where it outlasts the 420ms and the finger is over the menu) stays
    // with the lane and never reaches the message's own menu. The rest of the
    // page, the menu's underlay included, is inert while it is open.
    const onMenu = await page.evaluate(() => {
      const { left, top, width, height } = document.querySelector('[role="menuitem"]')!.getBoundingClientRect();
      const [x, y] = [left + width / 2, top + height / 2];
      const hit = document.elementFromPoint(x, y)!;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
      hit.dispatchEvent(event);
      return { onMenu: Boolean(hit.closest('[data-testid="multi-agent-chip-menu"]')), prevented: event.defaultPrevented };
    });
    expect(onMenu).toEqual({ onMenu: true, prevented: true });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // The click that ended it never reached the chip: the next tap still opens.
    await page.touchscreen.tap(point.x, point.y);
    await expect.poll(() => recorded(page, "__opened")).toEqual([...expected, "release_note-job"]);

    // With the composer focused (a phone's keyboard up), a long-press menu
    // closed by a tap outside does not hand focus back to the field, and
    // rings nothing.
    await page.evaluate(() => {
      const field = document.createElement("textarea");
      field.style.cssText = "position:fixed;left:0;top:0;width:40px;height:12px";
      document.body.append(field);
      field.focus();
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(menu).toBeVisible();
    await page.touchscreen.tap(380, 800);
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await expect(releaseNote).toHaveCSS("box-shadow", "none");
    expect(await recorded(page, "__opened")).toEqual([...expected, "release_note-job"]);
    expect(errors, errors.join("; ")).toEqual([]);
  });
});

test.describe("mouse and keyboard", () => {
  test.use({ viewport: { width: 720, height: 600 } });

  test("with a mouse or keyboard a plan chip's menu button takes its status slot without moving anything", async ({ page }) => {
    const errors = await mountFixture(page);
    await mount(page, { trace: true });
    expect(await page.evaluate(() => matchMedia("(pointer: fine) and (hover: hover)").matches)).toBe(true);
    const lane = page.locator('[data-agent-handle="@help_text"]');
    const slot = lane.locator("[data-chip-status]");
    const menuButton = lane.locator("xpath=..").getByTestId("multi-agent-chip-menu-button");
    await expect(menuButton).toHaveAccessibleName("More actions for Help text");
    const reveal = menuButton.locator("xpath=..");
    const chipBoxes = () => page.getByTestId("multi-agent-chip-shell").evaluateAll((shells) =>
      shells.map((shell) => {
        const { x, y, width, height } = shell.getBoundingClientRect();
        return [x, y, width, height];
      }));
    const atRest = await chipBoxes();
    await expect(slot).toHaveAttribute("data-chip-status", "working");
    await expect(slot).toHaveCSS("opacity", "1");
    await expect(reveal).toHaveCSS("opacity", "0");

    // Hover: the "…" takes the glyph's 20px slot, 2px inside the chip's end.
    await lane.hover();
    await expect(slot).toHaveCSS("opacity", "0");
    await expect(reveal).toHaveCSS("opacity", "1");
    const [menuBox, slotBox] = [await box(menuButton), await box(slot)];
    for (const side of ["x", "y", "width", "height"] as const) {
      expect(menuBox[side], side).toBeCloseTo(slotBox[side], 1);
    }
    expect(await chipBoxes()).toEqual(atRest);
    await menuButton.click();
    await expect(page.getByTestId("multi-agent-chip-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("multi-agent-chip-menu")).toHaveCount(0);
    expect(await recorded(page, "__opened")).toEqual([]);

    // Keyboard focus on the chip rings it and keeps its glyph; the next Tab
    // takes the "…", which then shows in the slot.
    await page.mouse.move(1, 1);
    await expect(menuButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(lane).toBeFocused();
    await expect(lane).not.toHaveCSS("box-shadow", "none");
    await expect(slot).toHaveCSS("opacity", "1");
    await expect(reveal).toHaveCSS("opacity", "0");
    await page.keyboard.press("Tab");
    await expect(menuButton).toBeFocused();
    await expect(slot).toHaveCSS("opacity", "0");
    await expect(reveal).toHaveCSS("opacity", "1");
    expect(await chipBoxes()).toEqual(atRest);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("multi-agent-chip-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => recorded(page, "__opened")).toEqual(["help_text-job"]);
    expect(errors, errors.join("; ")).toEqual([]);
  });
});

type Clip = { left: number; right: number; top: number; bottom: number };

test.describe("job-thread preview", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("in a job-thread preview no plan chip's focus ring or touch target is cut by the card's clip", async ({ page, browser }) => {
    // The bubble clips x flush with its right end, and the card clips both
    // axes. A chip as wide as the row ends at the row's right end, and Cancel
    // group always sits on its last line.
    test.setTimeout(60_000);
    const lanes = ["reading_list", "onboarding", "help_text", "release_note"];
    const errors = await mountFixture(page, { preview: true });
    await mount(page, { preview: true, lanes });
    const edges = await page.evaluate(() => {
      const right = (element: Element | null) => element!.getBoundingClientRect().right;
      const row = document.querySelector('[data-testid="multi-agent-inline-status"]')!;
      return {
        row: row.getBoundingClientRect().toJSON(),
        wide: right(document.querySelector('[data-agent-handle="@onboarding"]')),
        cancel: document.querySelector('[data-testid="multi-agent-cancel-group"]')!.getBoundingClientRect().toJSON(),
      };
    });
    expect(edges.row.right - edges.wide, "the long lane ends at the row's right end").toBeLessThan(1);
    expect(edges.row.bottom - edges.cancel.bottom, "Cancel group is on the last line").toBeLessThan(1);

    // Every Tab stop in the row: its ring (its box grown by its box-shadow's
    // widest spread) stays inside what its clipping ancestors leave.
    await page.mouse.move(1, 1);
    const stops: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(async () => {
        const element = document.activeElement as HTMLElement | null;
        if (!element?.closest('[data-testid="multi-agent-inline-status"]')) return null;
        // Button's ring grows in over 150ms.
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const box = element.getBoundingClientRect();
        const reach = Math.max(0, ...[...getComputedStyle(element).boxShadow.matchAll(/(-?[\d.]+)px(?=\s*(?:,|$))/g)].map((match) => Number(match[1])));
        const clip = (window as unknown as { __clipOf: (element: Element) => Clip }).__clipOf(element);
        const cut = [
          box.left - reach < clip.left - 0.5 ? "left" : null, box.right + reach > clip.right + 0.5 ? "right" : null,
          box.top - reach < clip.top - 0.5 ? "top" : null, box.bottom + reach > clip.bottom + 0.5 ? "bottom" : null,
        ].filter(Boolean);
        return { name: element.getAttribute("aria-label") ?? element.textContent ?? "", reach, cut };
      });
      if (!stop) {
        if (stops.length) break;
        continue;
      }
      expect(stop.reach, stop.name).toBeGreaterThan(0);
      expect(stop.cut, stop.name).toEqual([]);
      stops.push(stop.name);
    }
    // Workstreams, each lane and its "…", Cancel group.
    expect(stops).toHaveLength(2 + lanes.length * 2);
    expect(errors, errors.join("; ")).toEqual([]);

    // On touch, Workstreams' and Cancel group's 44px targets are whole too,
    // and nothing visible sits under them.
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const touchPage = await touch.newPage();
      const touchErrors = await mountFixture(touchPage, { preview: true });
      await mount(touchPage, { preview: true, lanes });
      const targets = await touchPage.evaluate(() =>
        [...document.querySelectorAll('button[data-testid="multi-agent-team-chip"], [data-testid="multi-agent-cancel-group"]')].map((button) => {
          const box = button.getBoundingClientRect();
          const after = getComputedStyle(button, "::after");
          const clip = (window as unknown as { __clipOf: (element: Element) => Clip }).__clipOf(button);
          const top = box.top + parseFloat(after.top);
          const bottom = box.bottom - parseFloat(after.bottom);
          return { name: button.getAttribute("aria-label") ?? "", height: bottom - top, inside: top >= clip.top - 0.5 && bottom <= clip.bottom + 0.5 };
        }));
      expect(targets.map(({ name }) => name.split(";")[0])).toEqual(["Workstreams", "Cancel group"]);
      for (const target of targets) {
        expect(target.height, target.name).toBeCloseTo(44, 1);
        expect(target.inside, target.name).toBe(true);
      }
      expect(await stolenTaps(touchPage)).toEqual([]);
      expect(touchErrors, touchErrors.join("; ")).toEqual([]);
    } finally {
      await touch.close();
    }
  });
});
