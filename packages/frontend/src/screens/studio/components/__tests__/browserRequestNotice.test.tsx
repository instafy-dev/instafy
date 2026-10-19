/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import { UserMessageBubble } from "../ChatMessageEntries";
import { browserRequestContinuedKeys } from "../browserRequest";

const TASK = "Continue this browser task using the browser attached to this turn.\n\nOpen https://dashboard.stripe.com/apikeys and stop on the list.";

// The continuation as the controller stores it and hands it back after a
// reload: the dispatched task as its content, the notice and the card it
// continues in its prompt metadata.
function storedContinuation() {
  return mapControllerMessageToChat({
    id: "abababab-abab-4bab-8bab-abababababab",
    conversationId: "44444444-4444-4444-8444-444444444444",
    projectId: "55555555-5555-4555-8555-555555555555",
    sessionId: null,
    createdBy: "user-1",
    promptId: null,
    runId: null,
    role: "user",
    content: TASK,
    metadata: {
      prompt_metadata: {
        clientMessageId: "client-1",
        displayContent: "Octo opened Instafy's browser at dashboard.stripe.com",
        dispatchContent: TASK,
        browserRequestOf: "job:job-1",
        browserAutoStarted: true,
        browserTransport: "shared",
      },
    },
    createdAt: "2026-10-19T12:00:00.000Z",
  });
}

describe("the record of a continuation sent to Instafy's browser", () => {
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

  it("keeps the notice and the card it continues after a reload", () => {
    const message = storedContinuation();
    expect(message.content).toBe("Octo opened Instafy's browser at dashboard.stripe.com");
    expect([...browserRequestContinuedKeys([message])]).toEqual(["job:job-1"]);
  });

  it("reads as a one-line notice, not as a message the person wrote", async () => {
    await act(async () => root.render(<UserMessageBubble message={storedContinuation()} />));
    const notice = container.querySelector('[data-testid="chat-browser-request-notice"]');
    expect(notice?.textContent).toBe("Octo opened Instafy's browser at dashboard.stripe.com");
    expect(container.querySelector('[data-testid="chat-bubble-user"]')).toBeNull();
    expect(container.textContent).not.toContain("Continue this browser task");
  });
});
