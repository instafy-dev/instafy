import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProviderEventLogEntry } from "../providerEventLog";
import { ExtensionProviderEventDebugPanel } from "../extensionProviderEventDebugPanel";

function createEventLogEntry(overrides?: Partial<ProviderEventLogEntry>): ProviderEventLogEntry {
  return {
    key: "camera.photo_captured|camera|camera|surface_in_conversation|||||",
    reaction: "surface_in_conversation",
    count: 2,
    firstTimestampNs: 1,
    lastTimestampNs: 2,
    latestEvent: {
      kind: "camera.photo_captured",
      providerId: "camera",
      providerType: "camera",
      timestampNs: 2,
      payload: {
        label: "Dish",
      },
    },
    ...overrides,
  };
}

describe("ExtensionProviderEventDebugPanel", () => {
  it("renders recent event entries and action buttons", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderEventDebugPanel
        entries={[createEventLogEntry()]}
        onEmitScenario={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(html).toContain("Synthetic provider events");
    expect(html).toContain("Emit camera event");
    expect(html).toContain("Surface in chat");
    expect(html).toContain("Clear log");
  });

  it("renders the empty state when no events exist", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderEventDebugPanel entries={[]} onEmitScenario={vi.fn()} onClear={vi.fn()} />,
    );

    expect(html).toContain("No provider events captured yet.");
  });
});
