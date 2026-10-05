// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapMemory: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      bootstrapMemory: mocks.bootstrapMemory,
    },
  },
}));

import {
  PROJECT_MEMORY_BOOTSTRAP_MAX_RETRIES,
  projectMemoryBootstrapRetryDelay,
  useProjectMemoryBootstrap,
  type ProjectMemoryBootstrapInput,
} from "../useProjectMemoryBootstrap";

const PROJECT = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";

function Probe(input: ProjectMemoryBootstrapInput) {
  useProjectMemoryBootstrap(input);
  return null;
}

const ready: ProjectMemoryBootstrapInput = {
  activeProjectId: PROJECT,
  controllerProjectMissing: false,
  projectReadyForWorkspace: true,
};

describe("useProjectMemoryBootstrap", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.bootstrapMemory.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(input: ProjectMemoryBootstrapInput) {
    await act(async () => {
      root.render(<Probe {...input} />);
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("stops asking a busy origin after a bounded number of tries", async () => {
    mocks.bootstrapMemory.mockResolvedValue({ seeded: false, reason: "workspace-busy" });
    await render(ready);
    // An hour of a busy origin.
    for (let minute = 0; minute < 60; minute += 1) {
      await advance(60_000);
    }
    const calls = mocks.bootstrapMemory.mock.calls.length;
    expect(calls).toBe(1 + PROJECT_MEMORY_BOOTSTRAP_MAX_RETRIES);
    // Quiet from then on, also when the project is shown again.
    await render({ ...ready, projectReadyForWorkspace: false });
    await render(ready);
    await advance(30 * 60_000);
    expect(mocks.bootstrapMemory).toHaveBeenCalledTimes(calls);
  });

  it("keeps the waits growing and the whole window to a few minutes", () => {
    const delays: number[] = [];
    for (let attempt = 0; ; attempt += 1) {
      const delay = projectMemoryBootstrapRetryDelay(attempt);
      if (delay === null) break;
      delays.push(delay);
    }
    expect(delays).toHaveLength(PROJECT_MEMORY_BOOTSTRAP_MAX_RETRIES);
    expect(delays[0]).toBe(1_200);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
    }
    const total = delays.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(3 * 60_000);
    expect(total).toBeLessThan(10 * 60_000);
  });

  it("seeds once an origin that registered late answers", async () => {
    mocks.bootstrapMemory
      .mockResolvedValueOnce({ seeded: false, reason: "no-origin" })
      .mockResolvedValueOnce({ seeded: false, reason: "no-origin" })
      .mockResolvedValue({ seeded: true });
    const commits: unknown[] = [];
    const onCommit = (event: Event) => commits.push((event as CustomEvent).detail);
    window.addEventListener("instafy:workspace-commit", onCommit);
    await render(ready);
    await advance(10_000);
    window.removeEventListener("instafy:workspace-commit", onCommit);
    expect(mocks.bootstrapMemory).toHaveBeenCalledTimes(3);
    expect(commits).toEqual([{ projectId: PROJECT }]);
    await advance(30 * 60_000);
    expect(mocks.bootstrapMemory).toHaveBeenCalledTimes(3);
  });
});
