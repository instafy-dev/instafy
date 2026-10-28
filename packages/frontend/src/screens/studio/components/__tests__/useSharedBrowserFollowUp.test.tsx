/** @vitest-environment jsdom */

// A message from the chat right after the person's own turn in Instafy's
// browser goes on in that browser (sharedBrowserFollowUp). A browser turn has
// only the browser's tools, so that must never happen silently: the composer
// shows it while it applies, and the person can keep the next message in the
// chat, where Octo can also build.

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import { SHARED_BROWSER_FOLLOW_UP_WINDOW_MS } from "../browserHandoffRouting";
import { useSharedBrowserFollowUp } from "../useSharedBrowserFollowUp";

const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const RUN_ID = "00000000-0000-4000-8000-0000000000b2";
const NEXT_RUN_ID = "00000000-0000-4000-8000-0000000000b3";
const ENDED_AT = Date.parse("2026-10-28T19:55:10Z");
const pages = [{ id: "page-1" }];

function browserRun(id = RUN_ID, endedAt = ENDED_AT): RunRecord {
  return {
    id,
    projectId: "project-1",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "success",
    progress: 1,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: {
      browserTransport: "shared",
      browserRuntimeId: "runtime-1",
      browserPageId: "page-1",
      initiatingUserId: USER_ID,
    },
    createdAt: new Date(endedAt - 60_000).toISOString(),
    updatedAt: new Date(endedAt).toISOString(),
  };
}

type Input = Parameters<typeof useSharedBrowserFollowUp<{ id: string }>>[0];
type Result = ReturnType<typeof useSharedBrowserFollowUp<{ id: string }>>;

function Harness({ input, resultRef }: { input: Input; resultRef: MutableRefObject<Result | null> }) {
  resultRef.current = useSharedBrowserFollowUp(input);
  return null;
}

describe("useSharedBrowserFollowUp", () => {
  let container: HTMLDivElement;
  let root: Root;
  const resultRef: MutableRefObject<Result | null> = { current: null };
  const input = (overrides: Partial<Input> = {}): Input => ({
    enabled: true,
    runs: [browserRun()],
    conversationId: "conversation-1",
    runtimeId: "runtime-1",
    userId: USER_ID,
    pages,
    ...overrides,
  });
  const render = async (value: Input) => {
    await act(async () => root.render(<Harness input={value} resultRef={resultRef} />));
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(ENDED_AT + 60_000);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows the follow-up while it applies, and not once its time is up", async () => {
    await render(input());
    expect(resultRef.current?.followUp).toEqual(expect.objectContaining({ runId: RUN_ID, page: { id: "page-1" } }));
    expect(resultRef.current?.resolve()).toEqual(expect.objectContaining({ runId: RUN_ID, page: { id: "page-1" } }));
    // Nothing else changes: the composer stops showing it when the window ends.
    await act(async () => {
      vi.advanceTimersByTime(SHARED_BROWSER_FOLLOW_UP_WINDOW_MS);
    });
    expect(resultRef.current?.followUp).toBeNull();
    expect(resultRef.current?.resolve()).toBeNull();
  });

  it("keeps the next message in the chat once the person says so, until a newer browser turn", async () => {
    await render(input());
    await act(async () => resultRef.current?.dismiss());
    expect(resultRef.current?.followUp).toBeNull();
    expect(resultRef.current?.resolve()).toBeNull();
    // Another turn in the browser offers its own follow-up again.
    await render(input({ runs: [browserRun(), browserRun(NEXT_RUN_ID, ENDED_AT + 30_000)] }));
    expect(resultRef.current?.followUp).toEqual(expect.objectContaining({ runId: NEXT_RUN_ID }));
    expect(resultRef.current?.resolve()).toEqual(expect.objectContaining({ runId: NEXT_RUN_ID }));
  });

  it("offers nothing while the browser is closed", async () => {
    await render(input({ enabled: false }));
    expect(resultRef.current?.followUp).toBeNull();
    expect(resultRef.current?.resolve()).toBeNull();
  });
});
