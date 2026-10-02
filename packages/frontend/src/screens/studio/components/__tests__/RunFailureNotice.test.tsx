// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRunFailureRetryMetadata,
  isRunFailureRetrySuperseded,
  resolveRunFailurePresentation,
  type RunFailurePresentation,
} from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import {
  RunFailureMessageBody,
  RunFailureRetryProvider,
  type RunFailureRetryContextValue,
} from "../RunFailureNotice";

const PROVIDER_RATE_LIMITED = "exceeded retry limit, last status: 429 Too Many Requests";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

const PROMPT = createMessage({
  id: "user-1",
  role: "user",
  content: "Build me a landing page",
  timestamp: 1,
});
const FAILURE = createMessage({
  id: "failure-1",
  content: PROVIDER_RATE_LIMITED,
  timestamp: 2,
  messageType: "error",
  metadata: { source: "agent", outcome: "failed", messageType: "error", jobId: "job-1" },
});

function presentationFor(message: ChatMessage): RunFailurePresentation {
  const presentation = resolveRunFailurePresentation({
    metadata: message.metadata,
    content: message.content,
    assumeFailed: true,
  });
  if (!presentation) {
    throw new Error("expected a failure presentation");
  }
  return presentation;
}

function contextValue(
  overrides: Partial<RunFailureRetryContextValue> = {},
): RunFailureRetryContextValue {
  return {
    pendingRetryKey: null,
    requestRetry: vi.fn(),
    autoRetryingKey: null,
    ...overrides,
  };
}

describe("RunFailureMessageBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(value: RunFailureRetryContextValue | null, message: ChatMessage = FAILURE) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={value}>
          <RunFailureMessageBody message={message} presentation={presentationFor(message)} />
        </RunFailureRetryProvider>,
      );
    });
  }

  const query = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  it("gives Try again and Details a touch-sized hit area", async () => {
    await render(contextValue());

    const retry = query("run-failure-retry");
    const details = query("run-failure-details-toggle");
    expect(retry?.textContent).toBe("Try again");
    expect(details?.textContent).toBe("Details");
    for (const button of [retry, details]) {
      const classes = button?.className.split(/\s+/) ?? [];
      // 44 px on phones and tablets, 36 px from lg up.
      expect(classes).toContain("min-h-11");
      expect(classes).toContain("lg:min-h-9");
      expect(classes).not.toContain("text-xxs");
    }
    // A regular small secondary button, not the 11 px pill.
    expect(retry?.className.split(/\s+/)).toContain("text-sm");
    expect(retry?.className.split(/\s+/)).toContain("bg-slate-100");
    // Details still reads as a quiet text button.
    expect(details?.className.split(/\s+/)).toContain("text-xs");
    expect(details?.className.split(/\s+/)).toContain("bg-transparent");
  });

  it("gives Connect AI the same hit area on a missing credential", async () => {
    const onConnectAi = vi.fn();
    const needsAi = createMessage({ ...FAILURE, content: "credential not found" });
    await render(contextValue({ onConnectAi }), needsAi);

    const connect = query("run-failure-connect-ai");
    expect(connect?.className.split(/\s+/)).toContain("min-h-11");
    expect(query("run-failure-retry")).toBeNull();
    await act(async () => {
      connect?.click();
    });
    expect(onConnectAi).toHaveBeenCalledTimes(1);
  });

  it("shows a pending spinner on Try again while its resend is in flight", async () => {
    const requestRetry = vi.fn();
    await render(contextValue({ requestRetry, pendingRetryKey: "failure-1" }));

    const retry = query("run-failure-retry");
    expect(retry?.textContent).toBe("Try again");
    expect(retry?.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("Loading");
    expect(retry?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      retry?.click();
    });
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it("disables Try again without a spinner while another card's resend is in flight", async () => {
    const requestRetry = vi.fn();
    await render(contextValue({ requestRetry, pendingRetryKey: "failure-other" }));

    const retry = query("run-failure-retry");
    expect(retry?.disabled).toBe(true);
    expect(retry?.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      retry?.click();
    });
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it("shows Retried instead of Try again once the prompt was sent again", async () => {
    const requestRetry = vi.fn();
    await render(contextValue({ requestRetry, isRetrySuperseded: () => true }));

    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-retried")?.textContent).toBe("Retried");
    expect(query("run-failure-details-toggle")).not.toBeNull();
  });

  it("keeps the pressed Try again pending until its request settles", async () => {
    await render(
      contextValue({ pendingRetryKey: "failure-1", isRetrySuperseded: () => true }),
    );

    expect(query("run-failure-retry")?.getAttribute("aria-disabled")).toBe("true");
    expect(query("run-failure-retried")).toBeNull();
  });

  it("reads Retried after a reload from the resend stored in the conversation", async () => {
    const resend = createMessage({
      id: "user-2",
      role: "user",
      content: PROMPT.content,
      timestamp: 3,
      metadata: buildRunFailureRetryMetadata(FAILURE),
    });
    const conversationMessages = [PROMPT, FAILURE, resend];
    await render(
      contextValue({
        isRetrySuperseded: (failureMessage) =>
          isRunFailureRetrySuperseded({ conversationMessages, failureMessage }),
      }),
    );

    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-retried")).not.toBeNull();
  });

  it("moves focus from a pressed Try again to Details when it turns into Retried", async () => {
    const requestRetry = vi.fn();
    await render(contextValue({ requestRetry }));
    const retry = query("run-failure-retry");
    retry?.focus();
    await act(async () => {
      retry?.click();
    });
    expect(requestRetry).toHaveBeenCalledWith(FAILURE);

    await render(contextValue({ requestRetry, pendingRetryKey: "failure-1" }));
    expect(document.activeElement).toBe(query("run-failure-retry"));

    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await render(contextValue({ requestRetry, isRetrySuperseded: () => true }));
    expect(query("run-failure-retry")).toBeNull();
    expect(document.activeElement).toBe(query("run-failure-details-toggle"));
    // The card can sit above the fold; moving focus must not scroll to it.
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it("never moves focus later when the press left Try again in place", async () => {
    // The resend was refused, so Try again stayed. Minutes later another
    // update retires the card while focus sits on the page: nothing here was
    // pressed for that, so focus and the transcript stay where they are.
    const requestRetry = vi.fn();
    await render(contextValue({ requestRetry }));
    const retry = query("run-failure-retry");
    retry?.focus();
    await act(async () => {
      retry?.click();
    });
    await render(contextValue({ requestRetry, pendingRetryKey: "failure-1" }));
    await render(contextValue({ requestRetry }));
    expect(query("run-failure-retry")).not.toBeNull();

    retry?.blur();
    expect(document.activeElement).toBe(document.body);
    await render(contextValue({ requestRetry, isRetrySuperseded: () => true }));
    expect(query("run-failure-retried")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  describe("automatic retry countdown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    });

    it("counts down with a Cancel control instead of Try again, announced politely", async () => {
      const cancelAutoRetry = vi.fn();
      const outside = document.createElement("input");
      document.body.appendChild(outside);
      outside.focus();

      // The status region is on the card, empty, before any countdown starts:
      // many screen readers skip a region that appears already filled.
      await render(contextValue({ cancelAutoRetry }));
      const status = container.querySelector('[role="status"]');
      expect(status?.getAttribute("data-testid")).toBe("run-failure-auto-retry-status");
      expect(status?.textContent).toBe("");

      await render(
        contextValue({
          scheduledAutoRetry: { key: "failure-1", dueAt: Date.now() + 20_000 },
          cancelAutoRetry,
        }),
      );

      expect(container.querySelector('[role="status"]')).toBe(status);
      expect(status?.textContent).toBe("Trying again automatically in 20 seconds.");
      // The ticking number is for sighted readers; the region speaks less often.
      expect(query("run-failure-auto-retry-countdown")?.getAttribute("aria-hidden")).toBe("true");
      expect(query("run-failure-auto-retry-countdown-text")?.textContent).toBe(
        "Trying again in 20 s",
      );
      expect(query("run-failure-retry")).toBeNull();
      expect(query("run-failure-details-toggle")).not.toBeNull();
      // The countdown appearing never takes focus.
      expect(document.activeElement).toBe(outside);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(query("run-failure-auto-retry-countdown-text")?.textContent).toBe(
        "Trying again in 15 s",
      );
      expect(status?.textContent).toBe("Trying again automatically in 20 seconds.");

      // In ten second steps, so someone reaching the card later is not told
      // the starting wait.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(query("run-failure-auto-retry-countdown-text")?.textContent).toBe(
        "Trying again in 9 s",
      );
      expect(status?.textContent).toBe("Trying again automatically in 10 seconds.");

      const cancel = query("run-failure-auto-retry-cancel");
      expect(cancel?.textContent).toBe("Cancel");
      expect(cancel?.getAttribute("aria-label")).toBe("Cancel automatic retry");
      expect(cancel?.className.split(/\s+/)).toContain("min-h-11");
      await act(async () => {
        cancel?.click();
      });
      expect(cancelAutoRetry).toHaveBeenCalledWith("failure-1");
      outside.remove();
    });

    it("hands focus from Cancel to the manual Try again it leaves behind", async () => {
      const cancelAutoRetry = vi.fn();
      await render(
        contextValue({
          scheduledAutoRetry: { key: "failure-1", dueAt: Date.now() + 20_000 },
          cancelAutoRetry,
        }),
      );
      const cancel = query("run-failure-auto-retry-cancel");
      cancel?.focus();
      await act(async () => {
        cancel?.click();
      });

      await render(contextValue({ scheduledAutoRetry: null, cancelAutoRetry }));
      expect(query("run-failure-auto-retry-countdown")).toBeNull();
      expect(document.activeElement).toBe(query("run-failure-retry"));
    });

    it("moves focus from Cancel to Details when the countdown ends on its own", async () => {
      // A keyboard user resting on Cancel when the resend goes out: Cancel
      // goes away, and focus must not drop to the page.
      const cancelAutoRetry = vi.fn();
      await render(
        contextValue({
          scheduledAutoRetry: { key: "failure-1", dueAt: Date.now() + 20_000 },
          cancelAutoRetry,
        }),
      );
      const cancel = query("run-failure-auto-retry-cancel");
      cancel?.focus();
      expect(document.activeElement).toBe(cancel);
      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

      await render(contextValue({ scheduledAutoRetry: null, autoRetryingKey: "failure-1", cancelAutoRetry }));

      expect(query("run-failure-auto-retry-cancel")).toBeNull();
      expect(query("run-failure-auto-retrying")).not.toBeNull();
      expect(document.activeElement).toBe(query("run-failure-details-toggle"));
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      focusSpy.mockRestore();
      expect(cancelAutoRetry).not.toHaveBeenCalled();
    });

    it("leaves focus alone when the countdown ends while Cancel does not hold it", async () => {
      const outside = document.createElement("input");
      document.body.appendChild(outside);
      try {
        await render(
          contextValue({
            scheduledAutoRetry: { key: "failure-1", dueAt: Date.now() + 20_000 },
            cancelAutoRetry: vi.fn(),
          }),
        );
        // Cancel had focus once, then the person moved on.
        query("run-failure-auto-retry-cancel")?.focus();
        outside.focus();

        await render(contextValue({ scheduledAutoRetry: null, autoRetryingKey: "failure-1" }));
        expect(document.activeElement).toBe(outside);

        // Nor when nothing on the card held focus and the page has it.
        await render(
          contextValue({
            scheduledAutoRetry: { key: "failure-1", dueAt: Date.now() + 20_000 },
            cancelAutoRetry: vi.fn(),
          }),
        );
        outside.blur();
        await render(contextValue({ scheduledAutoRetry: null }));
        expect(document.activeElement).toBe(document.body);
      } finally {
        outside.remove();
      }
    });

    it("ignores a countdown that belongs to another failure", async () => {
      await render(
        contextValue({ scheduledAutoRetry: { key: "failure-other", dueAt: Date.now() + 20_000 } }),
      );

      expect(query("run-failure-auto-retry-countdown")).toBeNull();
      expect(query("run-failure-retry")).not.toBeNull();
    });
  });
});
