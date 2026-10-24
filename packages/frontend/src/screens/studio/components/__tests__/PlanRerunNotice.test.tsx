// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTraceRerunNotice } from "../PlanRerunNotice";

describe("a plan job's run trace", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const sources = [
    { metadata: { jobId: "turn-1", multiAgentPlan: { role: "worker" } } },
    { metadata: { jobId: "turn-2", multiAgentPlan: { role: "worker", continuation: { of: "turn-1", turn: 1 } } } },
    { metadata: { jobId: "turn-2-retry", multiAgentPlan: { role: "worker", continuation: { of: "turn-1" }, rateLimitRetry: { of: "turn-2" } } } },
  ];

  it("ends a stopped turn with one quiet line that opens the run standing for it", async () => {
    const opened: string[] = [];
    await act(async () => root.render(<RunTraceRerunNotice jobId="turn-1" sources={sources} onOpen={(jobId) => opened.push(jobId)} />));
    const notice = container.querySelector('[data-testid="plan-rerun-notice"]');
    expect(notice?.textContent).toBe("This lane ran out of turn time and continued in a new turn.Open continuation");
    expect(notice?.className).not.toMatch(/rose|red/);
    await act(async () => (container.querySelector('[data-testid="plan-rerun-open"]') as HTMLButtonElement).click());
    expect(opened).toEqual(["turn-2-retry"]);
  });

  it("says nothing on the run that stands for the lane", async () => {
    await act(async () => root.render(<RunTraceRerunNotice jobId="turn-2-retry" sources={sources} onOpen={() => undefined} />));
    expect(container.innerHTML).toBe("");
  });
});
