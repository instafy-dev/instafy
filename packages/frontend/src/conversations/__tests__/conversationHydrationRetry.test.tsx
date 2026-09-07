/** @vitest-environment jsdom */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerProjectConversation } from "../../services/runtimeController/conversations";
import {
  createInitialConversation,
  type ConversationsAction,
  type ConversationsState,
} from "../conversationState";

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      core: { ...actual.controllerClient.core, enabled: true },
    },
  };
});

import { useConversationControllerSync } from "../useConversationControllerSync";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "99999999-8888-4777-8666-555555555555";
const LOCAL_ID = "conversation-local";
let latestSyncState: ReturnType<typeof useConversationControllerSync>;

function buildState(): ConversationsState {
  return {
    projectKey: PROJECT_ID,
    conversations: [createInitialConversation({ localId: LOCAL_ID })],
    activeId: LOCAL_ID,
    sequence: 2,
    runMap: {},
  };
}

function Harness({
  fetchProjectConversations,
  bump,
  projectId = PROJECT_ID,
  userId = USER_ID,
  epoch = 0,
  dispatch: suppliedDispatch,
}: {
  fetchProjectConversations: (args: { projectId: string; limit: number; signal?: AbortSignal }) => Promise<ControllerProjectConversation[] | null>;
  bump: () => void;
  projectId?: string;
  userId?: string;
  epoch?: number;
  dispatch?: (action: ConversationsAction) => void;
}) {
  const state = { ...buildState(), projectKey: projectId };
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const dispatch = useRef(vi.fn<(action: ConversationsAction) => void>()).current;
  const updateMetadata = useRef(vi.fn()).current;
  latestSyncState = useConversationControllerSync({
    state,
    currentUserId: userId,
    controllerProjectMissing: false,
    projectAccessPending: false,
    projectAccessBlocked: false,
    latestStateRef,
    dispatch: suppliedDispatch ?? dispatch,
    controllerConversationSyncEpoch: epoch,
    bumpControllerConversationSyncEpoch: bump,
    fetchProjectConversationsFromController: fetchProjectConversations,
    updateControllerConversationMetadata: updateMetadata,
  });
  return <output
    data-resolved={String(latestSyncState.remoteConversationHistoryResolved)}
    data-error={latestSyncState.remoteConversationHistoryError ?? undefined}
  />;
}

describe("conversation hydration recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("schedules its own retry when a space never hydrates, instead of waiting out the backfill", async () => {
    // A space entered before its membership has propagated answers null for
    // every attempt. Recovery used to wait for the 30s backfill tick, which is
    // why the chats drawer stayed empty until a reload.
    const fetchProjectConversations = vi.fn().mockResolvedValue(null);
    const bump = vi.fn();

    await act(async () => {
      root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />);
    });

    // Burn the four in-flight attempts and their backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchProjectConversations).toHaveBeenCalledTimes(4);
    expect(bump).toHaveBeenCalled();

    // Well short of the 30s backfill interval.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("does not schedule a retry when hydration succeeds", async () => {
    const fetchProjectConversations = vi.fn().mockResolvedValue([]);
    const bump = vi.fn();

    await act(async () => {
      root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(fetchProjectConversations).toHaveBeenCalledTimes(1);
    expect(bump).not.toHaveBeenCalled();
  });

  it.each(["project", "user", "unmount"])("aborts the old discovery request on %s change", async (change) => {
    const signals: AbortSignal[] = [];
    const fetchProjectConversations = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      signals.push(signal!);
      return new Promise<ControllerProjectConversation[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));
    expect(signals[0]?.aborted).toBe(false);

    await act(async () => root.render(change === "unmount" ? null : <Harness
      fetchProjectConversations={fetchProjectConversations}
      bump={bump}
      projectId={change === "project" ? "22222222-2222-4222-8222-222222222222" : PROJECT_ID}
      userId={change === "user" ? "another-user" : USER_ID}
    />));

    expect(signals[0]?.aborted).toBe(true);
    expect(fetchProjectConversations).toHaveBeenCalledTimes(change === "unmount" ? 1 : 2);
    expect(bump).not.toHaveBeenCalled();
  });

  it("clears a pending retry delay when the conversation provider unmounts", async () => {
    const fetchProjectConversations = vi.fn().mockResolvedValue(null);
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));
    expect(fetchProjectConversations).toHaveBeenCalledTimes(1);

    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));

    expect(fetchProjectConversations).toHaveBeenCalledTimes(1);
    expect(bump).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a cold-list error after the first failure while continuing its quick recovery", async () => {
    const fetchProjectConversations = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));

    expect(latestSyncState.remoteConversationHistoryResolved).toBe(false);
    expect(latestSyncState.remoteConversationHistoryError).toBe("Couldn't load conversations.");
    expect(fetchProjectConversations).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
    expect(latestSyncState.remoteConversationHistoryError).toBeNull();
    expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
  });

  it.each(["project", "user"])("hides wrong-scope errors immediately when the %s changes", async (scopeChange) => {
    const fetchProjectConversations = vi.fn().mockResolvedValueOnce(null)
      .mockImplementation(() => new Promise<ControllerProjectConversation[]>(() => undefined));
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));
    expect(latestSyncState.remoteConversationHistoryError).toBe("Couldn't load conversations.");

    await act(async () => root.render(<Harness
      fetchProjectConversations={fetchProjectConversations} bump={bump}
      projectId={scopeChange === "project" ? "22222222-2222-4222-8222-222222222222" : PROJECT_ID}
      userId={scopeChange === "user" ? "another-user" : USER_ID}
    />));

    expect(latestSyncState.remoteConversationHistoryError).toBeNull();
    expect(latestSyncState.remoteConversationHistoryResolved).toBe(false);
  });

  it("manual retry aborts a pending automatic read and starts a fresh epoch without waiting", async () => {
    let oldSignal: AbortSignal | undefined;
    const fetchProjectConversations = vi.fn().mockResolvedValueOnce(null)
      .mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
        oldSignal = signal;
        return new Promise<ControllerProjectConversation[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      })
      .mockResolvedValueOnce([]);
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(oldSignal?.aborted).toBe(false);
    expect(latestSyncState.remoteConversationHistoryError).toBe("Couldn't load conversations.");

    await act(async () => latestSyncState.retryRemoteConversationHistory());

    expect(oldSignal?.aborted).toBe(true);
    expect(bump).toHaveBeenCalledOnce();
    expect(latestSyncState.remoteConversationHistoryError).toBeNull();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} epoch={1} />));
    expect(fetchProjectConversations).toHaveBeenCalledTimes(3);
    expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
    expect(latestSyncState.remoteConversationHistoryError).toBeNull();
  });

  it("retains successful discovery and local tabs through a failed warm refresh", async () => {
    const fetchProjectConversations = vi.fn().mockResolvedValueOnce([]).mockResolvedValue(null);
    const bump = vi.fn();
    const dispatch = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} dispatch={dispatch} />));
    expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
    dispatch.mockClear();

    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} dispatch={dispatch} epoch={1} />));

    expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
    expect(latestSyncState.remoteConversationHistoryError).toBe("Couldn't refresh conversations. Your saved chats are still shown.");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not inherit a previous user's successful discovery", async () => {
    const fetchProjectConversations = vi.fn().mockResolvedValueOnce([])
      .mockImplementation(() => new Promise<ControllerProjectConversation[]>(() => undefined));
    const bump = vi.fn();
    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} />));
    expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);

    await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations} bump={bump} userId="another-user" />));
    expect(latestSyncState.remoteConversationHistoryResolved).toBe(false);
    expect(latestSyncState.remoteConversationHistoryError).toBeNull();
  });
});
