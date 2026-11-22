// @vitest-environment jsdom

import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PAUSE_OPEN_LABEL, BrowserPauseRow } from "../BrowserPauseRow";
import { openBrowserPause, useShowBrowserOnHumanInput } from "../useShowBrowserOnRequest";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, LET_OCTO_CONTINUE } from "../useBrowserHumanInput";
import type { ChatMessage } from "../../types";
import type { RunRecord } from "../../../../types";

/**
 * ChatPanel's part, which is wired to a dozen providers and so is not
 * mounted here (chatPanelBrowserPauseRow.test.ts reads its wiring): the
 * chat's end shows the row while the pause waits and the Browser view is not
 * on screen. A fresh pause and the row's press both bring the view forward,
 * which the person can leave again for Chat.
 */
function Chat({ messages, runs, onShow }: { messages: ChatMessage[]; runs: RunRecord[]; onShow: () => void }) {
  const [browserVisible, setBrowserVisible] = useState(false);
  const show = useCallback(() => {
    onShow();
    setBrowserVisible(true);
  }, [onShow]);
  useShowBrowserOnHumanInput({ identity: "chat-1", userId: "user-1", messages, runs, show });
  return (
    <>
      <button type="button" data-testid="back-to-chat" onClick={() => setBrowserVisible(false)}>Chat</button>
      <BrowserPauseRow
        pause={openBrowserPause(messages, runs, "user-1")}
        browserVisible={browserVisible}
        avatar={null}
        onOpen={show}
      />
    </>
  );
}

const run: RunRecord = {
  id: "run-1", projectId: "project-1", sessionId: null, conversationId: "chat-1", promptId: null, runType: "prompt",
  status: "success", progress: 1, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
  metadata: { jobId: "job-1", initiatingUserId: "user-1", browserTransport: "shared", browserRuntimeId: "runtime-1", browserPageId: "PAGE1" },
};
const yesterday = Date.now() - 18 * 60 * 60_000;
const pausedChat: ChatMessage[] = [
  { id: "prompt", role: "user", content: "Sign in to my accounting site and list last month's invoices", timestamp: yesterday - 10_000 },
  {
    id: "pause", role: "assistant", content: "Tool call completed", timestamp: yesterday,
    metadata: { messageType: "mcp_tool_call", jobId: "job-1", details: {
      server: "instafy_shared_browser", tool: "request_human_input", status: "completed",
      terminalConsent: { state: "blocked", terminal: true, retryable: false, code: "human_input_required" },
    } },
  },
  {
    id: "reply", role: "assistant", timestamp: yesterday + 1_000, metadata: { jobId: "job-1" },
    content: "Sign in or fill in the highlighted fields on the page in Instafy's browser, then choose Let Octo continue.",
  },
];

describe("BrowserPauseRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const row = () => container.querySelector('[data-testid="browser-pause-row"]');
  const open = () => container.querySelector<HTMLButtonElement>('[data-testid="browser-pause-open"]');

  // Dogfood, Nov 22: the morning after Octo paused on a sign-in, the reply
  // said to choose Let Octo continue, and nothing in the chat led to the page.
  it("leads back to a pause from before the chat was opened, until the Browser view shows it", async () => {
    const onShow = vi.fn();
    await act(async () => root.render(<Chat messages={pausedChat} runs={[run]} onShow={onShow} />));
    // History switches nothing by itself: the row is the way back.
    expect(onShow).not.toHaveBeenCalled();
    expect(row()).not.toBeNull();
    expect(open()?.textContent).toBe(BROWSER_PAUSE_OPEN_LABEL);
    expect(BROWSER_PAUSE_OPEN_LABEL).toBe("Open Instafy's browser");
    expect(container.textContent).not.toContain("\u2014");

    await act(async () => open()!.click());
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(row()).toBeNull();

    // Back in Chat with the pause still waiting: the row is there again.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="back-to-chat"]')!.click());
    expect(row()).not.toBeNull();
  });

  it("goes once the person writes again, Let Octo continue's press too", async () => {
    const onShow = vi.fn();
    await act(async () => root.render(<Chat messages={pausedChat} runs={[run]} onShow={onShow} />));
    expect(row()).not.toBeNull();
    const press: ChatMessage = {
      id: "press", role: "user", content: LET_OCTO_CONTINUE, timestamp: Date.now(),
      metadata: { dispatchContent: BROWSER_HUMAN_INPUT_CONTINUE_PROMPT },
    };
    await act(async () => root.render(<Chat messages={[...pausedChat, press]} runs={[run]} onShow={onShow} />));
    expect(row()).toBeNull();
    expect(onShow).not.toHaveBeenCalled();
  });

  it("shows nothing for a pause in someone else's turn", async () => {
    const theirs = { ...run, metadata: { ...run.metadata, initiatingUserId: "user-2" } };
    await act(async () => root.render(<Chat messages={pausedChat} runs={[theirs]} onShow={vi.fn()} />));
    expect(row()).toBeNull();
  });
});
