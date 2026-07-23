// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserParticipantPointers } from "../SharedBrowserParticipantPointers";
import type { SharedBrowserCollaborationParticipant } from "../sharedBrowserCollaboration";
import { setRemoteBrowserSurfaceContentSize } from "../remoteBrowserSurfaceGeometry";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("SharedBrowserParticipantPointers", () => {
  let host: HTMLDivElement;
  let viewer: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    viewer = document.createElement("div");
    canvas = document.createElement("canvas");
    setRemoteBrowserSurfaceContentSize(canvas, 400, 200);
    viewer.appendChild(canvas);
    document.body.append(host, viewer);
    root = createRoot(host);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === canvas) {
        return rect(100, 50, 400, 300);
      }
      if ((this as HTMLElement).dataset.testid === "shared-browser-participant-pointers") {
        return rect(80, 40, 500, 300);
      }
      return rect(0, 0, 0, 0);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    viewer.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders only peer pointers for the active page at normalized coordinates", async () => {
    const participants: SharedBrowserCollaborationParticipant[] = [
      {
        id: "self",
        displayName: "Marcus",
        color: "#0ea5e9",
        pageId: "page-1",
        cursor: { x: 0.1, y: 0.1 },
        canControl: true,
      },
      {
        id: "peer",
        displayName: "Anna",
        color: "#8b5cf6",
        pageId: "page-1",
        cursor: { x: 0.5, y: 0.25 },
        canControl: true,
      },
      {
        id: "other-page",
        displayName: "Lee",
        color: "#059669",
        pageId: "page-2",
        cursor: { x: 0.2, y: 0.2 },
        canControl: true,
      },
    ];
    const containerRef = createRef<HTMLDivElement>();
    containerRef.current = viewer;

    await act(async () => {
      root.render(
        <SharedBrowserParticipantPointers
          activePageId="page-1"
          containerRef={containerRef}
          participants={participants}
          selfParticipantId="self"
        />,
      );
    });

    const pointer = host.querySelector<HTMLElement>(
      '[data-testid="shared-browser-participant-pointer"]',
    );
    expect(host.querySelectorAll('[data-testid="shared-browser-participant-pointer"]')).toHaveLength(1);
    expect(pointer?.dataset.participantId).toBe("peer");
    expect(pointer?.style.left).toBe("220px");
    expect(pointer?.style.top).toBe("110px");
    expect(pointer?.textContent).toContain("Anna");
  });
});
