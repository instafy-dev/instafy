// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRYING_STATUS_DISPLAY_TEXT } from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import { ChatMessageAvatar } from "../ChatMessageAvatar";
import { ChatTypingRows } from "../ChatTypingRows";
import { resolveTypingIndicatorState } from "../typingIndicatorState";

function classTokens(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

// jsdom cannot resolve Tailwind's dark: variants, so the white coin is read
// from the classes: the mark is inked brand-ink on a bg-white surface inside
// the face, and nothing between the mark and that face swaps either color
// for dark mode (docs/Brand.md keeps the Octo coin white in both themes).
function expectWhiteOctoCoin(face: Element | null) {
  expect(face).toBeInstanceOf(Element);
  const mark = face!.querySelector(".octo-mark");
  expect(mark).not.toBeNull();
  const ink = mark!.closest('[class~="text-brand-ink"]');
  const coin = mark!.closest('[class~="bg-white"]');
  expect(ink && face!.contains(ink)).toBe(true);
  expect(coin && face!.contains(coin)).toBe(true);
  for (let node: Element | null = mark; node && node !== face!.parentElement; node = node.parentElement) {
    expect(classTokens(node).filter((token) => token.startsWith("dark:text-"))).toEqual([]);
  }
  for (let node: Element | null = mark; node && node !== coin!.parentElement; node = node.parentElement) {
    expect(classTokens(node).filter((token) => token.startsWith("dark:bg-"))).toEqual([]);
  }
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

  it("draws the phone-only thinking Octo as the same white coin as its chat face", async () => {
    // Below sm the avatar gutter is hidden and this indicator is the row's
    // only face. It used to be the bare reverse logo mark, so in dark mode a
    // white glyph with no coin stood where the reply header then showed the
    // white Octo coin.
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
    expectWhiteOctoCoin(compact);
    expectWhiteOctoCoin(gutter);
    const compactMark = compact?.querySelector(".octo-mark");
    // The same coin surface as the gutter face, not a lookalike.
    expect(compactMark?.parentElement?.getAttribute("class")).toBe(
      gutter?.querySelector(".octo-mark")?.parentElement?.getAttribute("class"),
    );
    expect(compact?.closest(".sm\\:hidden")).not.toBeNull();
    expect(compactMark?.getAttribute("data-octo-motion")).toBe("thinking");
    expect(compactMark?.getAttribute("data-octo-scroll-reactive")).toBe("true");
    // The gutter keeps the only chat-avatar-assistant selector on the row.
    expect(container.querySelectorAll('[data-testid="chat-avatar-assistant"]')).toHaveLength(1);
  });

  it("gives the thinking Octo of a multi-agent row the same white coin", async () => {
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

    expectWhiteOctoCoin(container.querySelector('[data-testid="assistant-thinking-octo-compact"]'));
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
});
