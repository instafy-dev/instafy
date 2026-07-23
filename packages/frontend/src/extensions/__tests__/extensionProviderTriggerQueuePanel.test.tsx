import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProviderTriggerCandidate } from "../providerEventTriggers";
import { ExtensionProviderTriggerQueuePanel } from "../extensionProviderTriggerQueuePanel";

function createTriggerEntry(overrides?: Partial<ProviderTriggerCandidate>): ProviderTriggerCandidate {
  return {
    key: "audio.wake_word_detected|provider|speech|candidate_agent_trigger|||||",
    reaction: "candidate_agent_trigger",
    count: 2,
    firstTimestampNs: 1,
    lastTimestampNs: 2,
    latestEvent: {
      kind: "audio.wake_word_detected",
      providerId: "speech",
      providerType: "speech",
      timestampNs: 2,
      payload: {
        label: "Wake word",
      },
    },
    ...overrides,
  };
}

describe("ExtensionProviderTriggerQueuePanel", () => {
  it("renders queued trigger candidates", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderTriggerQueuePanel
        entries={[createTriggerEntry()]}
        onDismissEntry={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(html).toContain("Pending sensor triggers");
    expect(html).toContain("Trigger candidate");
    expect(html).toContain("Dismiss all");
  });

  it("returns null when there are no queued entries", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderTriggerQueuePanel entries={[]} onDismissEntry={vi.fn()} onClear={vi.fn()} />,
    );

    expect(html).toBe("");
  });
});
