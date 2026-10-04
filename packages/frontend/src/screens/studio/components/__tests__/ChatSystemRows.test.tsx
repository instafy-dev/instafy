import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatBubbleRow } from "../ChatBubbleRow";
import { buildTimedSyntheticChatRows, unsavedWorkNoticeDescription, UnsavedWorkSystemRow } from "../ChatSystemRows";

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

describe("UnsavedWorkSystemRow", () => {
  const notice = (count: number) => ({ count, onOpenHistory: vi.fn(), onDismiss: vi.fn() });

  it("tells the viewer once where unsaved work is kept, in plain copy", () => {
    const single = renderToStaticMarkup(
      <UnsavedWorkSystemRow notice={notice(1)} renderAssistantAvatar={() => <span />} />,
    );
    expect(single).toContain('data-testid="unsaved-work-system-row"');
    expect(single).toContain("Space");
    expect(single).toContain("Some work wasn&#x27;t saved");
    expect(single).toContain("It&#x27;s kept in History, under Unsaved work, until someone restores or removes it.");
    expect(single).toContain("Open History");
    expect(single).toContain("Dismiss");
    expect(single).not.toContain("—");

    expect(unsavedWorkNoticeDescription(3)).toBe(
      "3 entries are kept in History, under Unsaved work, until someone restores or removes them.",
    );
  });
});
