// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserCollaborationControls } from "../SharedBrowserCollaborationControls";
import type {
  SharedBrowserCollaborationClientState,
  SharedBrowserCollaborationParticipant,
} from "../sharedBrowserCollaboration";

function participant(
  id: string,
  displayName: string,
  canControl = true,
): SharedBrowserCollaborationParticipant {
  return {
    id,
    displayName,
    color: id === "self" ? "#0ea5e9" : "#8b5cf6",
    pageId: "page-1",
    cursor: null,
    canControl,
  };
}

function client(overrides: Partial<SharedBrowserCollaborationClientState> = {}) {
  return {
    connectionStatus: "connected" as const,
    participantId: "self",
    state: {
      revision: 1,
      participants: [participant("self", "Taylor"), participant("peer", "Anna")],
      controlOwner: { kind: "human" as const, participantId: "self" },
      requests: [],
    },
    error: null,
    ...overrides,
  } satisfies SharedBrowserCollaborationClientState;
}

describe("SharedBrowserCollaborationControls", () => {
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

  it("shows participants and lets the current driver release control", async () => {
    const onReleaseControl = vi.fn();
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={client()}
          compact={false}
          localControlOwner={{ kind: "human" }}
          onGrantControl={vi.fn()}
          onReleaseControl={onReleaseControl}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="shared-browser-participants"]')?.getAttribute("aria-label"))
      .toContain("Taylor, Anna");
    expect(
      container.querySelector('[data-testid="shared-browser-participants"]')?.className,
    ).not.toContain("max-[540px]:hidden");
    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-state"]')
        ?.textContent,
    ).toContain("You control");
    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-state"]')
        ?.className,
    ).not.toContain("max-[540px]:hidden");
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-collaboration-control-action"]',
    )!;
    expect(action.dataset.action).toBe("release");
    await act(async () => action.click());
    expect(onReleaseControl).toHaveBeenCalledOnce();
  });

  it("keeps compact collaboration controls named while reducing visible density", async () => {
    const compactClient = client({
      state: {
        ...client().state!,
        participants: [
          participant("self", "Taylor"),
          participant("peer", "Anna"),
          participant("third", "Grace"),
        ],
      },
    });
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={compactClient}
          compact
          localControlOwner={{ kind: "human" }}
          onGrantControl={vi.fn()}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });

    const participants = container.querySelector<HTMLElement>(
      '[data-testid="shared-browser-participants"]',
    )!;
    expect(participants.getAttribute("aria-label")).toContain("Taylor, Anna, Grace");
    expect(participants.className).toContain("flex");
    expect(participants.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(participants.textContent).toContain("+2");
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="shared-browser-collaboration-control-state"]',
      )?.className,
    ).toContain("max-w-24");
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="shared-browser-collaboration-control-state"]',
      )?.textContent,
    ).toBe("You control");

    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-collaboration-control-action"]',
    )!;
    expect(action.textContent).toBe("Release");
    expect(action.getAttribute("aria-label")).toBe("Release control");
    expect(action.className).toContain("h-10");
  });

  it("keeps compact agent and read-only ownership visible with long participant names", async () => {
    const readOnlySelf = participant("self", "A very long local participant name", false);
    const longNameClient = client({
      state: {
        ...client().state!,
        participants: [
          readOnlySelf,
          participant("peer", "A teammate with an exceptionally long display name"),
          participant("third", "Another teammate"),
          participant("fourth", "Fourth teammate"),
        ],
        controlOwner: { kind: "human", participantId: "peer" },
      },
    });
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={longNameClient}
          compact
          localControlOwner={{ kind: "agent", displayName: "Octo with a long agent name" }}
          onGrantControl={vi.fn()}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });

    const participants = container.querySelector<HTMLElement>(
      '[data-testid="shared-browser-participants"]',
    )!;
    const state = container.querySelector<HTMLElement>(
      '[data-testid="shared-browser-collaboration-control-state"]',
    )!;
    expect(participants.getAttribute("aria-label")).toContain(
      "A teammate with an exceptionally long display name",
    );
    expect(participants.textContent).toContain("+3");
    expect(state.textContent).toContain("Octo with a long agent name controls");
    expect(state.title).toBe("Octo with a long agent name controls");
    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-action"]'),
    ).toBeNull();
  });

  it("shows the authoritative server agent instead of a stale local hint", async () => {
    const serverAgentClient = client({
      state: {
        ...client().state!,
        controlOwner: { kind: "agent", displayName: "Runtime Octo" },
      },
    });
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={serverAgentClient}
          compact={false}
          localControlOwner={{ kind: "agent", displayName: "Queued agent" }}
          onGrantControl={vi.fn()}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-state"]')
        ?.textContent,
    ).toBe("Runtime Octo controls");
    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-action"]'),
    ).toBeNull();
  });

  it("requests peer control and does not allow duplicate requests", async () => {
    const onRequestControl = vi.fn();
    const peerOwns = client({
      state: {
        ...client().state!,
        controlOwner: { kind: "human", participantId: "peer" },
      },
    });
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={peerOwns}
          compact={false}
          localControlOwner={{ kind: "human" }}
          onGrantControl={vi.fn()}
          onReleaseControl={vi.fn()}
          onRequestControl={onRequestControl}
          onTakeControl={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("Anna controls");
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-collaboration-control-action"]',
    )!;
    expect(action.dataset.action).toBe("request");
    await act(async () => action.click());
    expect(onRequestControl).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={{ ...peerOwns, state: { ...peerOwns.state!, requests: ["self"] } }}
          compact={false}
          localControlOwner={{ kind: "human" }}
          onGrantControl={vi.fn()}
          onReleaseControl={vi.fn()}
          onRequestControl={onRequestControl}
          onTakeControl={vi.fn()}
        />,
      );
    });
    const pending = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-collaboration-control-action"]',
    )!;
    expect(pending.disabled).toBe(true);
    expect(pending.textContent).toContain("Control requested");
  });

  it("offers a requested handoff to the current driver and blocks controls for an agent", async () => {
    const onGrantControl = vi.fn();
    const requested = client({ state: { ...client().state!, requests: ["peer"] } });
    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={requested}
          compact={false}
          localControlOwner={{ kind: "human" }}
          onGrantControl={onGrantControl}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });
    const grant = container.querySelector<HTMLButtonElement>(
      '[data-testid="shared-browser-collaboration-control-action"]',
    )!;
    expect(grant.getAttribute("aria-label")).toBe("Give control to Anna");
    await act(async () => grant.click());
    expect(onGrantControl).toHaveBeenCalledWith("peer");

    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={requested}
          compact
          localControlOwner={{ kind: "human" }}
          onGrantControl={onGrantControl}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="shared-browser-collaboration-control-action"]',
      )?.textContent,
    ).toBe("Give Anna");

    await act(async () => {
      root.render(
        <SharedBrowserCollaborationControls
          client={requested}
          compact={false}
          localControlOwner={{ kind: "agent", displayName: "Octo" }}
          onGrantControl={onGrantControl}
          onReleaseControl={vi.fn()}
          onRequestControl={vi.fn()}
          onTakeControl={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("Octo controls");
    expect(
      container.querySelector('[data-testid="shared-browser-collaboration-control-action"]'),
    ).toBeNull();
  });
});
