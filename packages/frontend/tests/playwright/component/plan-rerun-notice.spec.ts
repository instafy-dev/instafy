import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

/**
 * A team lane that ran out of turn time (or stopped on a short rate limit) is
 * started again by the controller in the same group. Its stopped run is not
 * the lane's result, so the production team card must show the lane as its
 * continuation, with one quiet line and a link to the continuation, never as
 * a red failure. This mounts MultiAgentPlanEntry with the run feed holding
 * only the stopped run and the continuation known from its own messages.
 */
const FIXTURE_PATH = "/__plan-rerun-notice-fixture__";
const WORKING_SURFACE_CLASS = "bg-white text-slate-700 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200";

async function mountFixture(page: Page, dark: boolean) {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { MultiAgentPlanEntry, MultiAgentRunsContext } from "/src/screens/studio/components/MultiAgentPlanEntry.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    document.documentElement.classList.toggle("dark", ${dark});
    const plan = { parentJobId: "parent-job", groupId: "group-1" };
    const run = (id, handle, status, jobId, extra = {}, createdAt = "2026-10-15T08:00:00Z") => ({
      id, projectId: "project", sessionId: null, conversationId: "conversation", promptId: null, runType: "prompt",
      status, progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt, updatedAt: createdAt,
      metadata: { jobId, agent: { handle }, multiAgentPlan: { ...plan, role: "worker", ...extra } },
    });
    const runs = {
      researcher: run("researcher-run", "researcher", "success", "researcher-job"),
      // The run feed has only the lane's stopped first turn.
      builder: run("builder-run", "builder", "failed", "builder-job-1"),
    };
    const messages = [
      { id: "stop", role: "assistant", timestamp: 5, content: "Codex run timed out",
        metadata: { jobId: "builder-job-1", agent: { handle: "builder" }, messageType: "error", outcome: "failed",
          multiAgentPlan: { ...plan, role: "worker" } } },
      { id: "next", role: "assistant", timestamp: 6, content: "",
        metadata: { jobId: "builder-job-2", agent: { handle: "builder" }, kind: "update",
          multiAgentPlan: { ...plan, role: "worker", continuation: { of: "builder-job-1", turn: 1 } } } },
    ];
    const planMessage = { id: "plan", role: "assistant", content: "Plan", timestamp: 1,
      metadata: { jobId: "parent-job", messageType: "multi_agent_plan", multiAgentPlan: { groupId: "group-1" } } };
    const details = { agents: [{ handle: "researcher" }, { handle: "builder" }], lead: { leadHandle: "octo" } };
    function Fixture() {
      const [opened, setOpened] = React.useState([]);
      return h("main", { className: "${WORKING_SURFACE_CLASS}", style: { minHeight: "100vh", padding: "24px 16px" } },
        h(MultiAgentRunsContext.Provider, { value: { runs, scopeKey: "viewer" } },
          h(MultiAgentPlanEntry, { details, planMessage, conversationMessages: messages, conversationLocalId: "local",
            onOpenWorkerRunTrace: (value) => setOpened((current) => [...current, value.jobId]) })),
        h("pre", { "data-testid": "opened" }, JSON.stringify(opened)));
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
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body style="margin:0"><div id="root"></div></body></html>`;
  const js = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(js(main)));
  // Every lane has a run, so the card asks the controller for nothing.
  await page.route("**/src/services/runtimeController/jobs.ts*", (route) => route.fulfill(js(`
    export const cancelPlanGroup = async () => { throw new Error("not in this fixture"); };
    export const fetchPlanGroupStatus = async () => { throw new Error("not in this fixture"); };
  `)));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await expect(page.getByTestId("multi-agent-inline-status"), errors.join("; ")).toBeVisible();
  return errors;
}

for (const dark of [false, true]) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    test.describe(() => {
      test.use({ viewport });

      test(`a continued lane reads as its continuation, not a failure, in ${dark ? "dark" : "light"} at ${viewport.width}px`, async ({ page }) => {
        const errors = await mountFixture(page, dark);
        const builder = page.locator('[data-agent-handle="@builder"]');
        await expect(builder).toHaveAccessibleName("Open run trace for @builder; status active");
        await expect(builder).not.toHaveClass(/rose/);
        await expect(page.getByTestId("multi-agent-inline-status")).not.toHaveAttribute("aria-label", /need attention/);

        const notice = page.getByTestId("plan-rerun-notice");
        await expect(notice).toHaveCount(1);
        await expect(notice).toHaveText("@builder ran out of turn time and continued in a new turn.Open continuation");
        await expect(notice).toBeInViewport();
        // Quiet: the card's muted text colour, not the failure colour.
        const color = await notice.evaluate((element) => getComputedStyle(element).color);
        const [red, green, blue] = color.match(/\d+(\.\d+)?/g)!.map(Number);
        expect(red - Math.max(green, blue), `notice colour ${color}`).toBeLessThan(40);

        await page.getByTestId("plan-rerun-open").click();
        await expect(page.getByTestId("opened")).toHaveText(JSON.stringify(["builder-job-2"]));
        // The lane's chip opens the same continuation.
        await builder.click();
        await expect(page.getByTestId("opened")).toHaveText(JSON.stringify(["builder-job-2", "builder-job-2"]));

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });
    });
  }
}
