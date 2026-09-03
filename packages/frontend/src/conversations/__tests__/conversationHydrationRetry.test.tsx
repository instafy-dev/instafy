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
}: {
  fetchProjectConversations: () => Promise<ControllerProjectConversation[] | null>;
  bump: () => void;
}) {
  const state = buildState();
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  useConversationControllerSync({
    state,
    currentUserId: USER_ID,
    controllerProjectMissing: false,
    projectAccessPending: false,
    projectAccessBlocked: false,
    latestStateRef,
    dispatch: vi.fn<(action: ConversationsAction) => void>(),
    controllerConversationSyncEpoch: 0,
    bumpControllerConversationSyncEpoch: bump,
    fetchProjectConversationsFromController: fetchProjectConversations,
    updateControllerConversationMetadata: vi.fn(),
  });
  return null;
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
});
