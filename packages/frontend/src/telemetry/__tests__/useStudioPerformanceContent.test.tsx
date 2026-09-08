// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioPerformance, type StudioPerformanceSample, type StudioVisibleContent } from "../studioPerformance";
import { useStudioPerformanceContent } from "../useStudioPerformanceContent";

const ready: StudioVisibleContent = {
  projectId: "project", organizationId: null, conversationId: "chat", messageCount: 400, loading: false, error: false,
};

describe("committed Studio performance content", () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let samples: StudioPerformanceSample[];
  let unsubscribe: () => void;

  function Harness({ content = ready, enabled = true }: { content?: StudioVisibleContent; enabled?: boolean }) {
    useStudioPerformanceContent(content, enabled);
    return <div>{content.loading ? "Loading" : "Committed content"}</div>;
  }

  async function paint() {
    await act(async () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(performance.now());
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    samples = [];
    studioPerformance.clear();
    unsubscribe = studioPerformance.subscribe((sample) => samples.push(sample));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    studioPerformance.clear();
    unsubscribe();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("waits for two animation frames after content commits", async () => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness />));
    expect(container.textContent).toBe("Committed content");
    expect(samples).toEqual([]);
    await paint();
    expect(samples).toEqual([]);
    await paint();
    expect(samples).toMatchObject([{ outcome: "ready", messageCountBucket: "201-1000" }]);
    expect(frames.size).toBe(0);
  });

  it("records loading, then completes the matching ready destination", async () => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness content={{ ...ready, loading: true, messageCount: 0 }} />));
    expect(frames.size).toBe(0);
    await act(async () => root.render(<Harness />));
    await paint();
    await paint();
    expect(samples).toMatchObject([{ outcome: "ready", loadingShown: true }]);
  });

  it("cancels the scheduled completion when ready content becomes loading before paint", async () => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness />));
    await paint();
    await act(async () => root.render(<Harness content={{ ...ready, loading: true, messageCount: 0 }} />));
    expect(frames.size).toBe(0);
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Harness content={{ ...ready, messageCount: 0, error: true }} />));
    await paint();
    await paint();
    expect(samples).toMatchObject([{ outcome: "error", loadingShown: true }]);
  });

  it.each([0, 1])("cancels a pending frame when unmounted after %s frames", async (paints) => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness />));
    if (paints) await paint();
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
    await paint();
    expect(samples).toEqual([]);
  });

  it("does not observe disabled or wrong-scope content, and cancels when disabled", async () => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness enabled={false} />));
    expect(frames.size).toBe(0);
    await act(async () => root.render(<Harness content={{ ...ready, conversationId: "other-chat" }} />));
    expect(frames.size).toBe(0);
    await act(async () => root.render(<Harness />));
    expect(frames.size).toBe(1);
    await act(async () => root.render(<Harness enabled={false} />));
    expect(frames.size).toBe(0);
    expect(samples).toEqual([]);
  });

  it("does not let an old paint callback complete a superseding navigation", async () => {
    studioPerformance.beginConversation("project", "chat");
    await act(async () => root.render(<Harness />));
    await paint();
    studioPerformance.beginConversation("project", "other-chat");
    await paint();
    expect(samples).toMatchObject([{ outcome: "superseded" }]);
    await act(async () => root.render(<Harness content={{ ...ready, conversationId: "other-chat" }} />));
    await paint();
    await paint();
    expect(samples.map((sample) => sample.outcome)).toEqual(["superseded", "ready"]);
  });
});
