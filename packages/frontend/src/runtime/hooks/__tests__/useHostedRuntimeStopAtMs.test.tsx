// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../../../types";
import { clearManualStop, manualStopHold, markManualStop } from "../../idlePauseRegistry";
import { useHostedRuntimeStopAtMs } from "../useHostedRuntimeStopAtMs";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function cutOffTurn(reason: string, interruptedAtMs: number): RunRecord {
  return {
    id: `run-${reason}`,
    projectId: PROJECT_ID,
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "queued",
    progress: 0,
    progressStage: "requeued",
    previewUrl: null,
    lastMessage: null,
    metadata: {
      interruption: {
        reason,
        jobId: `job-${reason}`,
        interruptedAt: new Date(interruptedAtMs).toISOString(),
        resumeBy: new Date(interruptedAtMs + 15 * 60_000).toISOString(),
      },
    },
    createdAt: new Date(interruptedAtMs - 60_000).toISOString(),
    updatedAt: new Date(interruptedAtMs).toISOString(),
  };
}

describe("useHostedRuntimeStopAtMs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stopAtMs: number | null | undefined;

  function Harness({ runs }: { runs: Record<string, RunRecord> | null }) {
    stopAtMs = useHostedRuntimeStopAtMs(PROJECT_ID, runs);
    return null;
  }

  async function render(runs: Record<string, RunRecord> | null) {
    await act(async () => {
      root.render(<Harness runs={runs} />);
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clearManualStop(PROJECT_ID);
    stopAtMs = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearManualStop(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("is the latest of this tab's Stop and a person's stop the runs record", async () => {
    await render(null);
    expect(stopAtMs).toBeNull();

    // This tab's Stop, read again when it is set and lifted.
    await act(async () => {
      markManualStop(PROJECT_ID);
    });
    const heldAt = manualStopHold(PROJECT_ID)?.at ?? null;
    expect(heldAt).not.toBeNull();
    expect(stopAtMs).toBe(heldAt);

    const later = (heldAt ?? 0) + 5_000;
    const earlier = (heldAt ?? 0) - 5_000;
    await render({ "run-user_stop": cutOffTurn("user_stop", later) });
    expect(stopAtMs).toBe(later);
    await render({ "run-user_stop": cutOffTurn("user_stop", earlier) });
    expect(stopAtMs).toBe(heldAt);

    await act(async () => {
      clearManualStop(PROJECT_ID);
    });
    expect(stopAtMs).toBe(earlier);

    // A stop nobody chose is no person's stop.
    await render({ "run-heartbeat_timeout": cutOffTurn("heartbeat_timeout", later) });
    expect(stopAtMs).toBeNull();
  });
});
