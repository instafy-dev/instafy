import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatBubbleRow } from "../ChatBubbleRow";
import { buildTimedSyntheticChatRows } from "../ChatSystemRows";

describe("buildTimedSyntheticChatRows", () => {
  function createRows({ outOfCredits }: { outOfCredits: boolean }) {
    return buildTimedSyntheticChatRows({
      notificationsNudgeOpen: false,
      credentialGateState: null,
      aiOnboardingOpen: false,
      notificationsNudgeAnchorTimestamp: null,
      notificationsNudgeKind: "browser",
      onEnableNotifications: async () => true,
      onDismissNotificationsNudge: vi.fn(),
      outOfCredits,
      outOfCreditsAnchorTimestamp: outOfCredits ? 123 : null,
      creditLimit: 200,
      onOpenCredits: vi.fn(),
      renderAssistantAvatar: () => <span data-testid="assistant-avatar" />,
    });
  }

  it("shows a transient chat status only when credits are exhausted", () => {
    const exhaustedMarkup = renderToStaticMarkup(<>{createRows({ outOfCredits: true }).map((row) => row.element)}</>);

    expect(exhaustedMarkup).toContain('data-testid="chat-out-of-credits-cta"');
    expect(exhaustedMarkup).toContain("0/200 credits left.");

    const refilledMarkup = renderToStaticMarkup(<>{createRows({ outOfCredits: false }).map((row) => row.element)}</>);
    expect(refilledMarkup).not.toContain('data-testid="chat-out-of-credits-cta"');
    expect(refilledMarkup).not.toContain("credits left");
  });

  it("clears sticky assistant ownership when a synthetic system row begins", () => {
    const systemRows = createRows({ outOfCredits: true });
    const markup = renderToStaticMarkup(
      <>
        <ChatBubbleRow
          speakerMarker={{
            kind: "assistant",
            handle: "octo",
            avatarSeed: "octo",
          }}
        >
          <span>Assistant response</span>
        </ChatBubbleRow>
        {systemRows.map((row) => row.element)}
      </>,
    );

    const markerKinds = Array.from(
      markup.matchAll(/data-chat-speaker-kind="([^"]+)"/g),
      (match) => match[1],
    );
    expect(markerKinds).toEqual(["assistant", "boundary"]);
  });
});
