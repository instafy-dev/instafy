// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatInvitePromptHandlers } from "../useChatInvitePromptHandlers";

type Handlers = ReturnType<typeof useChatInvitePromptHandlers>;

describe("useChatInvitePromptHandlers", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handlers: Handlers | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    handlers = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  function Harness(props: Parameters<typeof useChatInvitePromptHandlers>[0]) {
    handlers = useChatInvitePromptHandlers(props);
    return null;
  }

  it("sends a message aimed at a browser page in the person's own words", async () => {
    const performSubmit = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <Harness
          addConversationParticipant={vi.fn().mockResolvedValue([])}
          performSubmit={performSubmit}
          showStatus={vi.fn()}
        />,
      );
    });
    await act(async () => {
      handlers!.openInvitePrompt({
        conversationId: "local-1",
        controllerId: "conversation-1",
        message: "Summarize this page for @sam",
        editorState: null,
        missingUsers: [{ userId: "user-2", handle: "sam", displayName: "Sam" }],
        imageFiles: [],
        browserPageTarget: {
          id: "PAGE-OTHER-CHAT",
          url: "https://www.example.com/places/kiosk",
          host: "example.com",
          label: "Kiosk",
        },
        browserLaunchMode: null,
        expectedLaneIdle: false,
      });
    });
    await act(async () => {
      await handlers!.handleInvitePromptInviteAndSend();
    });

    expect(performSubmit).toHaveBeenCalledOnce();
    // No sentence names the page: a browser turn gets it as its bound tab.
    expect(performSubmit.mock.calls[0]![0]).toMatchObject({ message: "Summarize this page for @sam" });
  });
});
