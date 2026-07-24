// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord, RunStatus } from "../../../../types";
import {
  OCTO_SILENCE_HINT_AUTO_DISMISS_MS,
  OCTO_SILENCE_HINT_STORAGE_KEY,
  useOctoSilenceHint,
} from "../useOctoSilenceHint";

const CONVERSATION_ID = "controller-conversation-1";

const DECLINED_METADATA = {
  groupParticipation: {
    decision: "silent",
    reason: "agent_declined",
    enforcedBy: "runtime-controller",
  },
};

function makeRun(
  id: string,
  status: RunStatus,
  metadata: Record<string, unknown> | null = null,
  conversationId: string = CONVERSATION_ID,
): RunRecord {
  return {
    id,
    projectId: "project-1",
    sessionId: null,
    conversationId,
    promptId: null,
    runType: "prompt",
    status,
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata,
    createdAt: null,
    updatedAt: null,
  };
}

function Probe({
  runs,
  eligible,
  conversationControllerId = CONVERSATION_ID,
}: {
  runs: Record<string, RunRecord> | null;
  eligible: boolean;
  conversationControllerId?: string | null;
}) {
  const hint = useOctoSilenceHint({ runs, conversationControllerId, eligible });
  return (
    <button
      type="button"
      data-testid="probe"
      data-visible={hint.visible ? "true" : "false"}
      onClick={hint.dismiss}
    />
  );
}

describe("useOctoSilenceHint", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function probeVisible(): string | null | undefined {
    return container.querySelector('[data-testid="probe"]')?.getAttribute("data-visible");
  }

  async function render(element: ReactElement) {
    await act(async () => {
      root.render(element);
    });
  }

  it("fires once on the first witnessed agent_declined completion and sets the flag", async () => {
    await render(<Probe runs={{ "run-1": makeRun("run-1", "in_progress") }} eligible />);
    expect(probeVisible()).toBe("false");

    await render(
      <Probe runs={{ "run-1": makeRun("run-1", "success", DECLINED_METADATA) }} eligible />,
    );
    expect(probeVisible()).toBe("true");
    expect(window.localStorage.getItem(OCTO_SILENCE_HINT_STORAGE_KEY)).toBe("1");
  });

  it("never fires again once the flag is set, even for a fresh witnessed decline", async () => {
    window.localStorage.setItem(OCTO_SILENCE_HINT_STORAGE_KEY, "1");

    await render(<Probe runs={{ "run-2": makeRun("run-2", "queued") }} eligible />);
    await render(
      <Probe runs={{ "run-2": makeRun("run-2", "success", DECLINED_METADATA) }} eligible />,
    );

    expect(probeVisible()).toBe("false");
  });

  it("does not fire for declines that arrive already completed (not witnessed)", async () => {
    await render(
      <Probe runs={{ "run-3": makeRun("run-3", "success", DECLINED_METADATA) }} eligible />,
    );

    expect(probeVisible()).toBe("false");
    expect(window.localStorage.getItem(OCTO_SILENCE_HINT_STORAGE_KEY)).toBeNull();
  });

  it("does not fire when ineligible (single-human/unresolved), for other conversations, or for non-decline completions", async () => {
    // Ineligible conversation.
    await render(<Probe runs={{ "run-4": makeRun("run-4", "in_progress") }} eligible={false} />);
    await render(
      <Probe
        runs={{ "run-4": makeRun("run-4", "success", DECLINED_METADATA) }}
        eligible={false}
      />,
    );
    expect(probeVisible()).toBe("false");

    // Another conversation's run.
    await render(
      <Probe
        runs={{ "run-5": makeRun("run-5", "in_progress", null, "other-conversation") }}
        eligible
      />,
    );
    await render(
      <Probe
        runs={{
          "run-5": makeRun("run-5", "success", DECLINED_METADATA, "other-conversation"),
        }}
        eligible
      />,
    );
    expect(probeVisible()).toBe("false");

    // Completion without the decline marker.
    await render(<Probe runs={{ "run-6": makeRun("run-6", "in_progress") }} eligible />);
    await render(<Probe runs={{ "run-6": makeRun("run-6", "success") }} eligible />);
    expect(probeVisible()).toBe("false");

    expect(window.localStorage.getItem(OCTO_SILENCE_HINT_STORAGE_KEY)).toBeNull();
  });

  it("auto-dismisses after the timeout and dismisses on demand", async () => {
    vi.useFakeTimers();

    await render(<Probe runs={{ "run-7": makeRun("run-7", "in_progress") }} eligible />);
    await render(
      <Probe runs={{ "run-7": makeRun("run-7", "success", DECLINED_METADATA) }} eligible />,
    );
    expect(probeVisible()).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(OCTO_SILENCE_HINT_AUTO_DISMISS_MS + 1);
    });
    expect(probeVisible()).toBe("false");

    // Manual dismissal path (a later mount would need the flag cleared to show
    // again, so exercise dismiss() by resetting state within this session).
    window.localStorage.removeItem(OCTO_SILENCE_HINT_STORAGE_KEY);
    await render(<Probe runs={{ "run-8": makeRun("run-8", "in_progress") }} eligible />);
    await render(
      <Probe runs={{ "run-8": makeRun("run-8", "success", DECLINED_METADATA) }} eligible />,
    );
    expect(probeVisible()).toBe("true");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="probe"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(probeVisible()).toBe("false");
  });
});
