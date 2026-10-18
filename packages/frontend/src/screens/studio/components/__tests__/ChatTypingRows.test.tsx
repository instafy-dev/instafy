// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRYING_STATUS_DISPLAY_TEXT } from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import type { RunRecord } from "../../../../types";
import { ChatMessageAvatar } from "../ChatMessageAvatar";
import { ChatTypingRows } from "../ChatTypingRows";
import {
  resolveJobThreadTypingCoverage,
  resolveMultiAgentTypingStatus,
  resolveTranscriptTailKey,
  resolveTypingIndicatorState,
} from "../typingIndicatorState";
import { expectCanonicalOctoCoin } from "../../../../components/__tests__/octoCoinExpectations";

// The face is Octo's coin (OctoCoin, docs/Brand.md): white with the shared
// avatar coin shadow in light, reversed in dark, one ink. jsdom cannot resolve dark: variants, so the coin
// is read from its classes (octoCoinExpectations).
function expectOctoCoinFace(face: Element | null) {
  expect(face).toBeInstanceOf(Element);
  const coin = face!.matches("[data-octo-coin]") ? face : face!.querySelector("[data-octo-coin]");
  return expectCanonicalOctoCoin(coin);
}

describe("ChatTypingRows", () => {
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
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not duplicate assistant status text with activity dots", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="assistant-typing-indicator"]');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.querySelector("[data-sweep-text]")?.textContent).toBe("Thinking…");
    expect(indicator?.querySelectorAll(".animate-pulse")).toHaveLength(0);
    const speakerMarker = container.querySelector('[data-testid="chat-speaker-marker"]');
    expect(speakerMarker?.getAttribute("data-chat-speaker-kind")).toBe("assistant");
    expect(speakerMarker?.getAttribute("data-agent-handle")).toBe("octo");
    expect(
      container
        .querySelector('[data-testid="assistant-thinking-octo-compact"] .octo-mark')
        ?.getAttribute("data-octo-motion"),
    ).toBe("thinking");
  });

  it("passes motion only for live thinking and returns Octo to rest while waiting", async () => {
    const renderAssistantAvatar = vi.fn(
      (
        _metadata?: Record<string, unknown> | null,
        _identity?: { handle: string; avatarSeed: string } | null,
        options?: { motion?: "idle" | "thinking"; scrollReactive?: boolean },
      ) => (
        <span
          data-testid="assistant-avatar"
          data-motion={options?.motion}
          data-scroll-reactive={String(options?.scrollReactive ?? false)}
        />
      ),
    );

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Octo is thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={renderAssistantAvatar}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')?.getAttribute("data-motion"))
      .toBe("thinking");
    expect(
      container
        .querySelector('[data-testid="assistant-avatar"]')
        ?.getAttribute("data-scroll-reactive"),
    ).toBe("true");

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "waiting", label: null }}
          typingStatusLabel="Octo is starting its workspace…"
          typingStatusAriaLabel="Octo is starting its workspace"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={renderAssistantAvatar}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')?.getAttribute("data-motion"))
      .toBe("idle");
    expect(
      container
        .querySelector('[data-testid="assistant-avatar"]')
        ?.getAttribute("data-scroll-reactive"),
    ).toBe("true");
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();
  });

  it("marks peer-human typing as a sticky assistant boundary", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel="Alice is typing"
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="human-typing-indicator"]')).not.toBeNull();
    const boundary = container.querySelector('[data-testid="chat-speaker-boundary"]');
    expect(boundary?.getAttribute("data-chat-speaker-kind")).toBe("boundary");
    expect(container.querySelector('[data-testid="chat-speaker-marker"]')).toBeNull();
  });

  it("marks aggregate multi-agent typing as a neutral speaker boundary", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[
            { handle: "octo", avatarSeed: "octo", displayName: "Octo", isThinking: true },
            {
              handle: "reviewer",
              avatarSeed: "reviewer",
              displayName: "Reviewer",
              isThinking: true,
            },
          ]}
          hasMultipleTypingAgents
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: null }}
          typingStatusLabel="2 agents are working…"
          typingStatusAriaLabel="2 agents are working"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).not.toBeNull();
    const boundary = container.querySelector('[data-testid="chat-speaker-boundary"]');
    expect(boundary?.getAttribute("data-chat-speaker-kind")).toBe("boundary");
    expect(container.querySelector('[data-testid="chat-speaker-marker"]')).toBeNull();
    // The two overlapping faces keep the roster's separator ring, painted in
    // the chat surface's own background, so the coins never merge.
    const faces = Array.from(container.querySelectorAll('[data-testid="assistant-typing-stack-face"]'));
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["rounded-full", "*:ring-1", "*:ring-white", "dark:*:ring-[var(--color-studio-dark-panel)]"]),
      );
    }
  });

  it("animates only the Octo run that is actually in progress in a multi-agent row", async () => {
    const render = async (octoIsThinking: boolean) => {
      await act(async () => {
        root.render(
          <ChatTypingRows
            peerTypingLabel={null}
            isAssistantTyping
            isAssistantTypingCoveredByJobThreadPreview={false}
            typingAgents={[
              {
                handle: "octo",
                avatarSeed: "octo",
                displayName: "Octo",
                isThinking: octoIsThinking,
              },
              {
                handle: "reviewer",
                avatarSeed: "reviewer",
                displayName: "Reviewer",
                isThinking: !octoIsThinking,
              },
            ]}
            hasMultipleTypingAgents
            typingAgentHandle="octo"
            typingAgentAvatarSeed="octo"
            typingIndicatorState={{ phase: "thinking", label: null }}
            typingStatusLabel="Thinking…"
            typingStatusAriaLabel="Octo and Reviewer are thinking"
            isThinkingLabelExpanded={false}
            onToggleThinkingLabel={() => undefined}
            latestDisplayedMessageId="message-1"
            renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
          />,
        );
      });
    };

    await render(false);
    expect(container.querySelector(".octo-mark")?.getAttribute("data-octo-motion")).toBe("idle");
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();

    await render(true);
    expect(container.querySelector(".octo-mark")?.getAttribute("data-octo-motion")).toBe(
      "thinking",
    );
    expect(
      container
        .querySelector('[data-testid="assistant-thinking-octo-compact"] .octo-mark')
        ?.getAttribute("data-octo-motion"),
    ).toBe("thinking");
  });

  it("does not replace a customized Octo avatar with the canonical compact mark", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Octo is thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();
  });

  it("draws the phone-only thinking Octo as the same coin as its chat face", async () => {
    // Below sm the avatar gutter is hidden and this indicator is the row's
    // only face. It used to be the bare reverse logo mark, a glyph with no
    // coin where the reply header then showed Octo's coin.
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Octo is thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={(_metadata, identity, options) => (
            <ChatMessageAvatar
              kind="assistant"
              agent={identity}
              motion={options?.motion}
              scrollReactive={options?.scrollReactive}
            />
          )}
        />,
      );
    });

    const compact = container.querySelector('[data-testid="assistant-thinking-octo-compact"]');
    const gutter = container.querySelector('[data-testid="chat-avatar-assistant"]');
    const compactMark = expectOctoCoinFace(compact);
    const gutterMark = expectOctoCoinFace(gutter);
    // The same coin as the gutter face, not a lookalike: only the size differs.
    const withoutSize = (element: Element | null | undefined) =>
      (element?.getAttribute("class") ?? "").split(/\s+/).filter((token) => !/^[hw]-\d+$/.test(token));
    expect(withoutSize(compactMark.parentElement)).toEqual(withoutSize(gutterMark.parentElement));
    expect(compactMark.getAttribute("class")).toBe(gutterMark.getAttribute("class"));
    expect(compact?.closest(".sm\\:hidden")).not.toBeNull();
    expect(compactMark.getAttribute("data-octo-motion")).toBe("thinking");
    expect(compactMark.getAttribute("data-octo-scroll-reactive")).toBe("true");
    // The gutter keeps the only chat-avatar-assistant selector on the row.
    expect(container.querySelectorAll('[data-testid="chat-avatar-assistant"]')).toHaveLength(1);
  });

  it("gives the thinking Octo of a multi-agent row the same coin", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[
            { handle: "reviewer", avatarSeed: "reviewer", displayName: "Reviewer", isThinking: true },
            { handle: "octo", avatarSeed: "octo", displayName: "Octo", isThinking: true },
          ]}
          hasMultipleTypingAgents
          typingAgentHandle="reviewer"
          typingAgentAvatarSeed="reviewer"
          typingIndicatorState={{ phase: "thinking", label: null }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Reviewer and Octo are thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expectOctoCoinFace(container.querySelector('[data-testid="assistant-thinking-octo-compact"]'));
  });

  it("keeps workspace startup visibly owned by the assistant avatar", async () => {
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "waiting", label: null }}
          typingStatusLabel="Octo is starting its workspace…"
          typingStatusAriaLabel="Octo is starting its workspace"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-testid="assistant-typing-indicator"] [data-sweep-text]')
        ?.textContent,
    ).toBe("Octo is starting its workspace…");
    expect(container.textContent).not.toContain("Starting…");
  });

  it("drops the status row at once when the reply landed while it was up", async () => {
    // Seen on production: octo's reply appeared with its avatar above it,
    // and a second octo avatar sat under the finished answer for seconds,
    // because the spacer meant for a reply still on its way outlived one
    // that had already arrived.
    const props = {
      peerTypingLabel: null,
      isAssistantTypingCoveredByJobThreadPreview: false,
      typingAgents: [],
      hasMultipleTypingAgents: false,
      typingAgentHandle: "octo",
      typingAgentAvatarSeed: "octo",
      typingStatusLabel: "Thinking…",
      typingStatusAriaLabel: "Thinking",
      isThinkingLabelExpanded: false,
      onToggleThinkingLabel: () => undefined,
      renderAssistantAvatar: () => <span data-testid="assistant-avatar" />,
    };
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          latestDisplayedMessageId="question"
        />,
      );
    });
    // The reply lands while the run is still finishing.
    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          latestDisplayedMessageId="reply"
        />,
      );
    });
    // Then the run ends.
    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping={false}
          typingIndicatorState={null}
          latestDisplayedMessageId="reply"
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeNull();
  });

  it("keeps a hidden assistant status spacer until the next message lands", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    const lingeringIndicator = container.querySelector('[data-testid="assistant-typing-indicator"]');
    expect(lingeringIndicator).toBeInstanceOf(HTMLElement);
    expect(lingeringIndicator?.className).toContain("invisible");
    expect(lingeringIndicator?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="assistant-thinking-octo-compact"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeInstanceOf(HTMLElement);

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping={false}
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={null}
          typingStatusLabel="Typing…"
          typingStatusAriaLabel="Typing"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-2"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
  });

  it("clears the assistant status immediately when suppressed", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeInstanceOf(HTMLElement);

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }}
          typingStatusLabel="Thinking…"
          typingStatusAriaLabel="Thinking"
          suppressAssistantStatus
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="message-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeNull();
  });
});

describe("resolveTypingIndicatorState", () => {
  const activeRun = (status: RunRecord["status"] = "in_progress"): RunRecord => ({
    id: "run-current", status, projectId: "project", conversationId: "conversation", sessionId: null, promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { jobId: "job-current", agent: { handle: "poet10" } },
  });
  // What the runtime agent stores while Codex waits out a rate-limited request.
  const rawStreamRetry =
    "Retrying: stream disconnected before completion: 429 Too Many Requests: The upstream provider rate limit was reached.";
  const userMessage: ChatMessage = {
    id: "user-1",
    role: "user",
    content: "Rename the header",
    timestamp: 1,
  };
  const status = (id: string, content: string, metadata: Record<string, unknown> = {}): ChatMessage => ({
    id,
    role: "assistant",
    content,
    timestamp: 2,
    messageType: "status",
    metadata: { messageType: "status", ...metadata },
  });

  it("keeps a queued worker waiting instead of attributing its completed sibling's warning", () => {
    const waiting = { phase: "waiting" as const, label: null };
    expect(resolveTypingIndicatorState([userMessage,
      status("sibling", "Workspace updated, but auto-save failed", { runId: "run-sibling", agent: { handle: "poet09" } }),
    ], waiting, activeRun("queued"))).toEqual(waiting);
  });

  it("selects only the current execution's status, including when handles are reused", () => {
    const fallback = { phase: "thinking" as const, label: "Thinking…" };
    const previous = status("previous", "Saving an old poem", { runId: "old-run", jobId: "old-job", agent: { handle: "poet10" } });
    const current = status("current", "Writing the requested poem", { jobId: "job-current" });
    const sibling = status("sibling", "Retrying another worker", { runId: "run-sibling" });
    expect(resolveTypingIndicatorState([userMessage, previous, current, sibling], fallback, activeRun()).label).toBe(current.content);
    expect(resolveTypingIndicatorState([userMessage, previous, sibling], fallback, activeRun())).toEqual(fallback);
    expect(resolveTypingIndicatorState([userMessage, status("unscoped", "Unknown worker")], fallback, activeRun())).toEqual(fallback);
    expect(resolveTypingIndicatorState([userMessage, status("old-job", "Stale attempt", { runId: "run-current", jobId: "old-job" })], fallback, activeRun())).toEqual(fallback);
  });

  it("describes mixed execution and queued states separately", () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({ displayName: `@poet${index + 1}`, status: index < 5 ? "in_progress" as const : "queued" as const }));
    const result = resolveMultiAgentTypingStatus(agents);
    expect(result.label).toBe("5 working · 3 queued");
    expect(result.ariaLabel).toBe("@poet1, @poet2, @poet3, @poet4, @poet5 are working; @poet6, @poet7, @poet8 are queued");
    expect(resolveMultiAgentTypingStatus([{ displayName: "@poet", status: "awaiting_approval" }])).toEqual({
      phase: "waiting", label: "1 waiting for approval", ariaLabel: "@poet is waiting for approval",
    });
  });

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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows a stream retry as calm progress and keeps the stored line", async () => {
    const retry = status("retry-1", rawStreamRetry, { kind: "codex_stream_retry" });
    const state = resolveTypingIndicatorState([userMessage, retry]);
    expect(state).toEqual({ phase: "thinking", label: RETRYING_STATUS_DISPLAY_TEXT });
    expect(retry.content).toBe(rawStreamRetry);

    await act(async () => {
      root.render(
        <ChatTypingRows
          peerTypingLabel={null}
          isAssistantTyping
          isAssistantTypingCoveredByJobThreadPreview={false}
          typingAgents={[]}
          hasMultipleTypingAgents={false}
          typingAgentHandle="octo"
          typingAgentAvatarSeed="octo"
          typingIndicatorState={state}
          typingStatusLabel={state.label ?? "Thinking…"}
          typingStatusAriaLabel={`Octo status: ${state.label}`}
          isThinkingLabelExpanded={false}
          onToggleThinkingLabel={() => undefined}
          latestDisplayedMessageId="retry-1"
          renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
        />,
      );
    });

    const indicator = container.querySelector('[data-testid="assistant-typing-indicator"]');
    expect(indicator?.querySelector("[data-sweep-text]")?.textContent).toBe(RETRYING_STATUS_DISPLAY_TEXT);
    expect(container.textContent).not.toContain("429");
  });

  it("recognises a stream retry by its kind when the line has no Retrying prefix", () => {
    expect(
      resolveTypingIndicatorState([
        userMessage,
        status("retry-1", "stream disconnected before completion", { kind: "codex_stream_retry" }),
      ]),
    ).toEqual({ phase: "thinking", label: RETRYING_STATUS_DISPLAY_TEXT });
  });

  it("keeps ordinary status headlines and ignores a retry from an earlier turn", () => {
    expect(
      resolveTypingIndicatorState([userMessage, status("status-1", "Running tests now.")]),
    ).toEqual({ phase: "thinking", label: "Running tests now." });
    const fallback = { phase: "waiting" as const, label: "Waiting for a runtime…" };
    expect(
      resolveTypingIndicatorState(
        [status("retry-0", rawStreamRetry, { kind: "codex_stream_retry" }), userMessage],
        fallback,
      ),
    ).toBe(fallback);
  });
  it("never renders or lingers a legacy Stop slot and preserves status-label expansion", async () => {
    const stop = vi.fn();
    const toggle = vi.fn();
    const props = {
      peerTypingLabel: null, isAssistantTyping: true, isAssistantTypingCoveredByJobThreadPreview: false,
      typingAgents: [], hasMultipleTypingAgents: false, typingAgentHandle: "octo", typingAgentAvatarSeed: "octo",
      typingIndicatorState: { phase: "thinking" as const, label: "Thinking…" },
      typingStatusLabel: "Thinking…", typingStatusAriaLabel: "Octo is thinking", isThinkingLabelExpanded: false,
      onToggleThinkingLabel: toggle, latestDisplayedMessageId: "message-1", renderAssistantAvatar: () => <span />,
      runStopAction: <button data-testid="stop" onClick={stop}>Stop</button>,
    };
    await act(async () => root.render(<ChatTypingRows {...props} />));
    expect(container.querySelector('[data-testid="stop"]')).toBeNull();
    await act(async () => (container.querySelector('[data-testid="assistant-typing-indicator"]') as HTMLDivElement).click());
    expect(stop).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<ChatTypingRows {...props} isAssistantTyping={false} />));
    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-testid="stop"]')).toBeNull();
  });

});

// Seen on production: a turn's reply had landed inside its job thread, then a
// status line with the turn's last reasoning title ("Analyzing output schema")
// appeared under the answer and held its place for another twelve seconds.
describe("the typing row after a job thread's reply", () => {
  const JOB_ID = "job-turn";
  const userMessage: ChatMessage = { id: "user-1", role: "user", content: "Set it up", timestamp: 1 };
  const reasoning: ChatMessage = {
    id: "reasoning-1",
    role: "assistant",
    content: "**Analyzing output schema**\n\nDetails.",
    timestamp: 2,
    messageType: "reasoning",
    metadata: { messageType: "reasoning", source: "agent", kind: "update", outcome: "in_progress", jobId: JOB_ID },
  };
  const reply: ChatMessage = {
    id: "reply-1",
    role: "assistant",
    content: "Two values are needed to finish setup.",
    timestamp: 3,
    metadata: { source: "agent", outcome: "success", jobId: JOB_ID },
  };
  const threadRow = (threadMessages: ChatMessage[]): ChatMessage => ({
    id: `agent-job-thread:${JOB_ID}`,
    role: "assistant",
    content: "",
    timestamp: 2,
    messageType: "agent_job_thread",
    metadata: { messageType: "agent_job_thread", jobId: JOB_ID, threadMessages },
  });
  const run = (id: string, jobId: string): RunRecord => ({
    id, status: "in_progress", projectId: "project", conversationId: "conversation", sessionId: null, promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { jobId },
  });

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
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("never takes a finished turn's reasoning title for the current status", () => {
    const fallback = { phase: "thinking" as const, label: "Thinking…" };
    expect(resolveTypingIndicatorState([userMessage, reasoning, reply], fallback, run("run-1", JOB_ID))).toBe(
      fallback,
    );
    expect(resolveTypingIndicatorState([userMessage, reasoning, reply], fallback)).toBe(fallback);
    // Before the reply the same title is the live status.
    expect(resolveTypingIndicatorState([userMessage, reasoning], fallback, run("run-1", JOB_ID))).toEqual({
      phase: "thinking",
      label: "Analyzing output schema",
    });
  });

  it("lets an answered job thread cover the run it belongs to, and only that run", () => {
    expect(resolveJobThreadTypingCoverage(threadRow([reasoning]), [run("run-1", JOB_ID)])).toBe("live");
    // The run record has not caught up with the reply yet.
    expect(resolveJobThreadTypingCoverage(threadRow([reasoning, reply]), [run("run-1", JOB_ID)])).toBe("answered");
    // A different run starting after the reply gets its own typing row.
    expect(
      resolveJobThreadTypingCoverage(threadRow([reasoning, reply]), [run("run-1", JOB_ID), run("run-2", "job-next")]),
    ).toBe("none");
    expect(resolveJobThreadTypingCoverage(threadRow([reasoning, reply]), [])).toBe("none");
    expect(resolveJobThreadTypingCoverage(reply, [run("run-1", JOB_ID)])).toBe("none");
    expect(resolveJobThreadTypingCoverage(undefined, [run("run-1", JOB_ID)])).toBe("none");
  });

  it("drops the status row at once when the reply lands inside the job thread", async () => {
    // The thread keeps one row id while its reply lands inside it; the tail
    // key names the newest message so the typing row sees the reply arrive.
    const runningKey = resolveTranscriptTailKey(threadRow([reasoning]));
    const answeredKey = resolveTranscriptTailKey(threadRow([reasoning, reply]));
    expect(runningKey).not.toBe(answeredKey);
    expect(resolveTranscriptTailKey(reply)).toBe("reply-1");
    expect(resolveTranscriptTailKey(undefined)).toBeNull();

    const props = {
      peerTypingLabel: null,
      isAssistantTypingCoveredByJobThreadPreview: false,
      typingAgents: [],
      hasMultipleTypingAgents: false,
      typingAgentHandle: "octo",
      typingAgentAvatarSeed: "octo",
      typingStatusLabel: "Thinking…",
      typingStatusAriaLabel: "Thinking",
      isThinkingLabelExpanded: false,
      onToggleThinkingLabel: () => undefined,
      renderAssistantAvatar: () => <span data-testid="assistant-avatar" />,
    };
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping
          typingIndicatorState={{ phase: "thinking", label: "Analyzing output schema" }}
          latestDisplayedMessageId={runningKey}
        />,
      );
    });
    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeInstanceOf(HTMLElement);

    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping
          typingIndicatorState={{ phase: "thinking", label: "Analyzing output schema" }}
          latestDisplayedMessageId={answeredKey}
        />,
      );
    });
    await act(async () => {
      root.render(
        <ChatTypingRows
          {...props}
          isAssistantTyping={false}
          typingIndicatorState={null}
          latestDisplayedMessageId={answeredKey}
        />,
      );
    });

    expect(container.querySelector('[data-testid="assistant-typing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-avatar"]')).toBeNull();
  });
});
