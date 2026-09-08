// @vitest-environment jsdom

import { act, useState, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyStudioPanel } from "../../workspace/lazyStudioPanel";
import { StudioPanelPerformance } from "../StudioPanelPerformance";
import { studioPerformance, type StudioPerformanceSample } from "../studioPerformance";
import { useStudioChatPerformance } from "../useStudioChatPerformance";

function deferred<Props extends object>() {
  let resolve!: (module: { default: ComponentType<Props> }) => void;
  const promise = new Promise<{ default: ComponentType<Props> }>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("selected Studio panel readiness", () => {
  let root: Root;
  let container: HTMLDivElement;
  let samples: StudioPerformanceSample[];
  let unsubscribe: () => void;
  let frames: Map<number, FrameRequestCallback>;
  const destination = { projectId: "space-a", organizationId: "team-a", enabled: true, loading: false, error: false };

  async function paint() {
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(performance.now())); });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let nextFrame = 0;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => { frames.delete(frame); });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    studioPerformance.clear();
    samples = [];
    unsubscribe = studioPerformance.subscribe((sample) => samples.push(sample));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    unsubscribe();
    studioPerformance.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("finishes Home startup after a paint opportunity even with a remembered chat", async () => {
    studioPerformance.begin("studio_startup", { ...destination, conversationId: "remembered-chat" });
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred={false}><div>Home</div></StudioPanelPerformance>,
    ));
    expect(container.textContent).toBe("Home");
    expect(samples).toEqual([]);
    await paint();
    expect(samples).toEqual([]);
    await paint();
    expect(samples).toEqual([expect.objectContaining({ operation: "studio_startup", outcome: "ready", messageCountBucket: "0" })]);
  });

  it.each(["space_switch", "organization_switch"] as const)("keeps %s pending through temporary Home and an empty local chat", async (operation) => {
    function Chat({ listResolved, historyLoading, messageCount = 0, accessPending = false }: {
      listResolved: boolean; historyLoading: boolean; messageCount?: number; accessPending?: boolean;
    }) {
      useStudioChatPerformance({
        ...destination, conversationId: "destination-chat", messageCount,
        projectInitialized: true, projectAccessPending: accessPending,
        conversationListResolved: listResolved, initialHistoryLoading: historyLoading,
      });
      return <div>{historyLoading ? "Loading messages" : `${messageCount} messages`}</div>;
    }
    studioPerformance.begin(operation, destination);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} enabled={false} requestedPanel="chat" deferred={false}>
        <div>Home from previous space</div>
      </StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    // The conversations provider has moved to the destination, but its chat
    // tab cannot be selected until discovery supplies its real conversations.
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} requestedPanel="chat" deferred={false}>
        <div>Temporary Home tab</div>
      </StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Chat listResolved historyLoading={false} accessPending />));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Chat listResolved={false} historyLoading={false} />));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    studioPerformance.beginConversation(destination.projectId, "destination-chat");
    await act(async () => root.render(<Chat listResolved historyLoading />));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Chat listResolved historyLoading={false} messageCount={50} />));
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ operation, outcome: "ready", messageCountBucket: "1-50", loadingShown: true })]);
  });

  it("still completes a legitimately empty chat after its list and history are resolved", async () => {
    function EmptyChat() {
      useStudioChatPerformance({
        ...destination, conversationId: "empty-chat", messageCount: 0,
        projectInitialized: true, projectAccessPending: false,
        conversationListResolved: true, initialHistoryLoading: false,
      });
      return <div>Start a chat</div>;
    }
    studioPerformance.begin("studio_startup", destination);
    await act(async () => root.render(<EmptyChat />));
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ outcome: "ready", messageCountBucket: "0", loadingShown: false })]);
  });

  it.each([false, true])("measures history Retry while preserving an unfinished startup (error already painted: %s)", async (errorPainted) => {
    function Chat({ recovered = false }: { recovered?: boolean }) {
      const [retried, setRetried] = useState(false);
      const beginRetry = useStudioChatPerformance({
        ...destination, conversationId: "chat", messageCount: recovered ? 50 : 0,
        projectInitialized: true, projectAccessPending: false,
        conversationListResolved: true, initialHistoryLoading: retried && !recovered,
        error: !retried,
      });
      return <button onClick={() => { beginRetry(); setRetried(true); }}>Retry</button>;
    }
    studioPerformance.begin("studio_startup", destination);
    await act(async () => root.render(<Chat />));
    if (errorPainted) {
      await paint();
      await paint();
      expect(samples).toEqual([expect.objectContaining({ operation: "studio_startup", outcome: "error" })]);
    }
    await act(async () => container.querySelector("button")?.click());
    await paint();
    await paint();
    expect(samples).toHaveLength(errorPainted ? 1 : 0);
    await act(async () => root.render(<Chat recovered />));
    await paint();
    await paint();
    expect(samples.at(-1)).toEqual(expect.objectContaining({
      operation: errorPainted ? "conversation_switch" : "studio_startup",
      outcome: "ready", messageCountBucket: "1-50", loadingShown: true,
    }));
  });

  it("waits for a job thread's selected parent and history, then measures its displayed rows", async () => {
    function Thread({ selected, loading, error = false, messageCount = 0 }: {
      selected: string; loading: boolean; error?: boolean; messageCount?: number;
    }) {
      useStudioChatPerformance({
        ...destination, conversationId: "thread-parent", selectedConversationId: selected,
        messageCount, projectInitialized: true, projectAccessPending: false,
        conversationListResolved: true, initialHistoryLoading: loading, error,
      });
      return <div>{messageCount ? `${messageCount} thread rows` : "Loading run"}</div>;
    }
    studioPerformance.begin("studio_startup", destination);
    studioPerformance.beginConversation(destination.projectId, "thread-parent");
    await act(async () => root.render(<Thread selected="previous-chat" loading={false} error />));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Thread selected="thread-parent" loading />));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(<Thread selected="thread-parent" loading={false} messageCount={3} />));
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({
      operation: "studio_startup", outcome: "ready", messageCountBucket: "1-50", loadingShown: true,
    })]);
  });

  it("keeps a lazy-panel navigation pending until its visible content resolves", async () => {
    const module = deferred<Record<string, never>>();
    const Settings = lazyStudioPanel("Settings", () => module.promise);
    studioPerformance.begin("space_switch", destination);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred><Settings /></StudioPanelPerformance>,
    ));
    expect(container.querySelector('[data-testid="studio-panel-loading"]')).not.toBeNull();
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => module.resolve({ default: () => <div>Settings ready</div> }));
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ operation: "space_switch", outcome: "ready", loadingShown: true })]);
  });

  it("records a committed failed panel as an error instead of a timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Settings = lazyStudioPanel("Settings", async () => { throw new Error("offline"); });
    studioPerformance.begin("organization_switch", destination);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred><Settings /></StudioPanelPerformance>,
    ));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ operation: "organization_switch", outcome: "error" })]);
  });

  it("ignores old-space content, unscoped drawers and a pending project-access check", async () => {
    const Drawer = lazyStudioPanel("Files", async () => ({ default: () => <div>Files drawer</div> }));
    studioPerformance.begin("organization_switch", { projectId: "space-b", organizationId: "team-b" });
    await act(async () => root.render(<>
      <Drawer />
      <StudioPanelPerformance {...destination} deferred={false}><div>Old Home</div></StudioPanelPerformance>
    </>));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    const next = { ...destination, projectId: "space-b", organizationId: "team-b" };
    await act(async () => root.render(
      <StudioPanelPerformance {...next} enabled={false} deferred={false}><div>Providers still switching</div></StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(
      <StudioPanelPerformance {...next} loading deferred={false}><div>Checking access</div></StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    await act(async () => root.render(
      <StudioPanelPerformance {...next} deferred={false}><div>New Home</div></StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ operation: "organization_switch", outcome: "ready", loadingShown: true })]);
  });

  it("cannot finish a conversation switch and cancels readiness when the selected panel unmounts", async () => {
    studioPerformance.begin("conversation_switch", { ...destination, conversationId: "chat-b" });
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred={false}><div>Home</div></StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    studioPerformance.clear();
    await act(async () => root.render(null));
    studioPerformance.begin("space_switch", destination);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred={false}><div>Home</div></StudioPanelPerformance>,
    ));
    await paint();
    expect(frames.size).toBe(1);
    await act(async () => root.render(<div>Selected chat</div>));
    expect(frames.size).toBe(0);
    await paint();
    expect(samples).toEqual([]);
  });

  it("cancels a ready callback if the resolved panel suspends before it is painted", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const Settings = lazyStudioPanel("Settings", async () => ({
      default: ({ suspend }: { suspend: boolean }) => {
        if (suspend) throw pending;
        return <div>Settings</div>;
      },
    }));
    studioPerformance.begin("space_switch", destination);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred><Settings suspend={false} /></StudioPanelPerformance>,
    ));
    await paint();
    expect(frames.size).toBe(1);
    await act(async () => root.render(
      <StudioPanelPerformance {...destination} deferred><Settings suspend /></StudioPanelPerformance>,
    ));
    await paint();
    await paint();
    expect(samples).toEqual([]);
    expect(container.querySelector('[data-testid="studio-panel-loading"]')).not.toBeNull();
    await act(async () => {
      finish();
      root.render(<StudioPanelPerformance {...destination} deferred><Settings suspend={false} /></StudioPanelPerformance>);
    });
    await paint();
    await paint();
    expect(samples).toEqual([expect.objectContaining({ outcome: "ready", loadingShown: true })]);
  });
});
