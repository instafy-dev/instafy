/** @vitest-environment jsdom */

import { act, useCallback, useRef } from "react";
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
let renderedErrors: (string | null)[] = [];

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
  accessPending = false,
  accessBlocked = false,
}: {
  fetchProjectConversations: (args: { projectId: string; limit: number; signal?: AbortSignal }) => Promise<ControllerProjectConversation[] | null>;
  bump: () => void;
  projectId?: string;
  userId?: string;
  epoch?: number;
  dispatch?: (action: ConversationsAction) => void;
  accessPending?: boolean;
  accessBlocked?: boolean;
}) {
  const state = { ...buildState(), projectKey: projectId };
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const dispatch = useRef(vi.fn<(action: ConversationsAction) => void>()).current;
  const updateMetadata = useRef(vi.fn()).current;
  const fetchConversations = useCallback((args: { projectId: string; limit: number; signal?: AbortSignal; internalOnly?: boolean }) =>
    args.internalOnly ? Promise.resolve([]) : fetchProjectConversations(args), [fetchProjectConversations]);
  latestSyncState = useConversationControllerSync({
    state,
    currentUserId: userId,
    controllerProjectMissing: false,
    projectAccessPending: accessPending,
    projectAccessBlocked: accessBlocked,
    latestStateRef,
    dispatch: suppliedDispatch ?? dispatch,
    controllerConversationSyncEpoch: epoch,
    bumpControllerConversationSyncEpoch: bump,
    fetchProjectConversationsFromController: fetchConversations,
    updateControllerConversationMetadata: updateMetadata,
  });
  renderedErrors.push(latestSyncState.remoteConversationHistoryError);
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
    renderedErrors = [];
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

  describe("while the space's access check is still running", () => {
    const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
    const REMOTE_ID = "33333333-3333-4333-8333-333333333333";
    const OTHER_REMOTE_ID = "44444444-4444-4444-8444-444444444444";
    const remoteConversation = (projectId: string, id: string): ControllerProjectConversation => ({
      id, projectId, sessionId: null, createdBy: null, metadata: {},
      createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
    });
    const deferred = () => {
      let resolve!: (value: ControllerProjectConversation[] | null) => void;
      const promise = new Promise<ControllerProjectConversation[] | null>((settle) => { resolve = settle; });
      return { promise, resolve };
    };
    const createdControllerIds = (dispatch: ReturnType<typeof vi.fn>) => dispatch.mock.calls
      .map(([action]) => action as ConversationsAction)
      .flatMap((action) => action.type === "CREATE" ? [action.conversation.controllerId] : []);
    const abortableRead = (signals: AbortSignal[]) => ({ signal }: { signal?: AbortSignal }) => {
      signals.push(signal!);
      return new Promise<ControllerProjectConversation[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    };

    it("reads the space's conversations alongside the check instead of after it", async () => {
      const list = deferred();
      const signals: AbortSignal[] = [];
      const fetchProjectConversations = vi.fn(({ signal }: { signal?: AbortSignal }) => {
        signals.push(signal!);
        return list.promise;
      });
      const bump = vi.fn();
      const dispatch = vi.fn();
      const harness = (accessPending: boolean) => <Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} accessPending={accessPending} />;

      await act(async () => root.render(harness(true)));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(1);

      // The check answering neither aborts nor repeats the read in flight.
      await act(async () => root.render(harness(false)));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(1);
      expect(signals[0]?.aborted).toBe(false);

      await act(async () => list.resolve([remoteConversation(PROJECT_ID, REMOTE_ID)]));
      expect(createdControllerIds(dispatch)).toEqual([REMOTE_ID]);
      expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
      expect(bump).not.toHaveBeenCalled();
    });

    it("keeps a refused read quiet and drops it when the check blocks the space", async () => {
      const signals: AbortSignal[] = [];
      const fetchProjectConversations = vi.fn().mockResolvedValueOnce(null).mockImplementation(abortableRead(signals));
      const bump = vi.fn();
      const dispatch = vi.fn();
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} accessPending />));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(2);

      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} accessBlocked />));
      expect(signals[0]?.aborted).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(6_000));

      expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
      expect(renderedErrors.length).toBeGreaterThan(0);
      expect(renderedErrors.every((error) => error === null)).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(bump).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("starts a refused read over once the check confirms the space, with no error in between", async () => {
      const fetchProjectConversations = vi.fn().mockResolvedValueOnce(null)
        .mockResolvedValueOnce([remoteConversation(PROJECT_ID, REMOTE_ID)]);
      const bump = vi.fn();
      const dispatch = vi.fn();
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} accessPending />));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(1);

      // Confirmed before the refused read's own backoff ran out: it starts
      // over now, as the provider's epoch bump does.
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} />));
      expect(renderedErrors.every((error) => error === null)).toBe(true);
      expect(bump).toHaveBeenCalledOnce();
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} epoch={1} />));

      expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
      expect(createdControllerIds(dispatch)).toEqual([REMOTE_ID]);
      expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
      expect(renderedErrors.every((error) => error === null)).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(6_000));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
    });

    it("never applies a list that answers after a quick switch to another space", async () => {
      const first = deferred();
      const second = deferred();
      const signals: AbortSignal[] = [];
      // Both reads ignore their abort and answer anyway.
      const fetchProjectConversations = vi.fn(({ signal }: { signal?: AbortSignal }) => {
        signals.push(signal!);
        return signals.length === 1 ? first.promise : second.promise;
      });
      const bump = vi.fn();
      const dispatch = vi.fn();
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} accessPending />));
      await act(async () => root.render(<Harness fetchProjectConversations={fetchProjectConversations}
        bump={bump} dispatch={dispatch} projectId={OTHER_PROJECT_ID} accessPending />));
      expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
      expect(signals[0]?.aborted).toBe(true);

      await act(async () => first.resolve([remoteConversation(PROJECT_ID, REMOTE_ID)]));
      expect(dispatch).not.toHaveBeenCalled();
      expect(latestSyncState.remoteConversationHistoryResolved).toBe(false);

      await act(async () => second.resolve([remoteConversation(OTHER_PROJECT_ID, OTHER_REMOTE_ID)]));
      expect(createdControllerIds(dispatch)).toEqual([OTHER_REMOTE_ID]);
      expect(latestSyncState.remoteConversationHistoryResolved).toBe(true);
    });
  });
});
