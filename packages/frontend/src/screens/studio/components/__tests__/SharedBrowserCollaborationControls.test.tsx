// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedBrowserCollaborationControls } from "../SharedBrowserCollaborationControls";
import type {
  SharedBrowserCollaborationClientState,
  SharedBrowserCollaborationParticipant,
} from "../sharedBrowserCollaboration";

function participant(id: string, displayName: string, canControl = true): SharedBrowserCollaborationParticipant {
  return { id, displayName, color: id === "self" ? "#0ea5e9" : "#8b5cf6", pageId: "page-1", cursor: null, canControl };
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
  let props: ComponentProps<typeof SharedBrowserCollaborationControls>;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
  const action = () => find<HTMLButtonElement>("shared-browser-collaboration-control-action");
  const status = () => find("shared-browser-collaboration-control-state");
  const controller = () => find("shared-browser-controller-indicator");
  const participantsList = () => document.querySelector<HTMLElement>('[aria-label="Browser participants"]')!;
  const participantRow = (id: string) => Array.from(participantsList().querySelectorAll<HTMLLIElement>("li[data-participant-id]"))
    .find(row => row.dataset.participantId === id)!;
  const trigger = () => find<HTMLButtonElement>("shared-browser-collaboration-toggle")!;
  const click = async (element: HTMLElement) => act(async () => { element.focus(); element.click(); });
  const finishFocusRestoration = async () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  async function render(overrides: Partial<typeof props> = {}) {
    props = { ...props, ...overrides };
    await act(async () => root.render(<SharedBrowserCollaborationControls {...props} />));
  }
  async function openControls() {
    await click(trigger());
    expect(document.querySelector('[role="dialog"][aria-label="Browser participants and control"]')).not.toBeNull();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    props = {
      client: client(), compact: true, localControlOwner: { kind: "human" },
      onGrantControl: vi.fn(), onReleaseControl: vi.fn(), onRequestControl: vi.fn(), onTakeControl: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await finishFocusRestoration();
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps participants and release control inline on a wide surface", async () => {
    await render({ compact: false, children: <button>Let AI continue</button> });
    expect(find("shared-browser-participants")?.getAttribute("aria-label")).toContain("Taylor, Anna");
    expect(status()?.textContent).toBe("You control");
    expect(container.textContent).toContain("Let AI continue");
    expect(action()?.dataset.action).toBe("release");
    await click(action()!);
    expect(props.onReleaseControl).toHaveBeenCalledOnce();
    expect(trigger()).toBeNull();
  });

  it("uses one compact presence button and reveals names, ownership, and actions on demand", async () => {
    await render({
      client: client({ state: { ...client().state!, participants: [participant("self", "Taylor"), participant("peer", "Anna"), participant("third", "Grace")] } }),
      children: <button>Let AI continue</button>,
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(trigger().getAttribute("aria-label")).toContain("You control. Taylor, Anna, Grace");
    expect(find("shared-browser-participants")?.textContent).toContain("+2");
    expect(status()).toBeNull();
    expect(action()).toBeNull();
    expect(container.textContent).not.toContain("Let AI continue");

    await openControls();
    expect(status()?.textContent).toBe("You control");
    expect(status()?.classList.contains("sr-only")).toBe(true);
    expect(controller()?.getAttribute("role")).toBe("img");
    expect(controller()?.getAttribute("aria-label")).toBe("You control");
    expect(controller()?.textContent).toBe("Controls");
    expect(controller()?.closest("li")?.dataset.participantId).toBe("self");
    expect(document.querySelectorAll('[data-testid="shared-browser-controller-indicator"]')).toHaveLength(1);
    expect(participantsList().compareDocumentPosition(action()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const continueControl = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Let AI continue")!;
    expect(participantsList().compareDocumentPosition(continueControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(participantRow("self").textContent).toContain("Taylor (you)");
    expect(participantRow("peer").textContent).toBe("Anna");
    expect(participantRow("third").textContent).toBe("Grace");
    expect(document.body.textContent).toContain("Let AI continue");
    expect(action()?.textContent).toBe("Release control");
    await click(action()!);
    expect(props.onReleaseControl).toHaveBeenCalledOnce();
  });

  it("closes with Escape and restores focus to the compact presence button", async () => {
    await render();
    const presence = trigger();
    await openControls();
    await act(async () => action()!.focus());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      document.activeElement!.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await finishFocusRestoration();
    expect(action()).toBeNull();
    expect(presence.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(presence);
  });

  it("keeps complete long names in the popup while honoring the local agent lock", async () => {
    const longName = "A teammate with an exceptionally long display name";
    await render({
      client: client({ state: { ...client().state!, participants: [participant("self", "Local reader", false), participant("peer", longName)], controlOwner: { kind: "human", participantId: "peer" } } }),
      localControlOwner: { kind: "agent", displayName: "Octo with a long agent name" },
    });
    expect(trigger().getAttribute("aria-label")).toContain("Octo with a long agent name controls");
    await openControls();
    expect(document.querySelector('[aria-label="Browser participants"]')?.textContent).toContain(longName);
    expect(status()?.textContent).toBe("Octo with a long agent name controls");
    expect(status()?.classList.contains("sr-only")).toBe(true);
    expect(controller()?.closest("li")?.dataset.controllerKind).toBe("agent");
    expect(controller()?.getAttribute("aria-label")).toBe("Octo with a long agent name controls");
    expect(document.querySelector('li[data-participant-id] [data-testid="shared-browser-controller-indicator"]')).toBeNull();
    expect(action()).toBeNull();
  });

  it("shows the authoritative server agent instead of a stale local hint", async () => {
    await render({
      client: client({ state: { ...client().state!, controlOwner: { kind: "agent", displayName: "Runtime Octo" } } }),
      localControlOwner: { kind: "agent", displayName: "Queued agent" },
    });
    await openControls();
    expect(status()?.textContent).toBe("Runtime Octo controls");
    expect(controller()?.closest("li")?.textContent).toContain("Runtime Octo");
    expect(controller()?.textContent).toBe("Controls");
    expect(controller()?.closest("li")?.dataset.controllerKind).toBe("agent");
    expect(participantsList().textContent).not.toContain("Queued agent");
    expect(action()).toBeNull();
  });

  it.each([true, false])("requests peer control with a clear label and disables duplicate requests (compact=%s)", async (compact) => {
    const peerOwns = client({ state: { ...client().state!, controlOwner: { kind: "human", participantId: "peer" } } });
    await render({ client: peerOwns, compact });
    if (compact) await openControls();
    expect(status()?.textContent).toBe("Anna controls");
    if (compact) {
      expect(controller()?.closest("li")?.dataset.participantId).toBe("peer");
      expect(controller()?.getAttribute("aria-label")).toBe("Anna controls");
      expect(controller()?.textContent).toBe("Controls");
    }
    expect(action()?.textContent).toBe("Request control");
    expect(action()?.getAttribute("aria-label")).toBe("Request control");
    await click(action()!);
    expect(props.onRequestControl).toHaveBeenCalledOnce();
    const dialog = compact ? document.querySelector('[role="dialog"][aria-label="Browser participants and control"]') : null;
    if (compact) expect(document.activeElement).toBe(dialog);

    await render({ client: { ...peerOwns, state: { ...peerOwns.state!, requests: ["self"] } } });
    expect(action()?.disabled).toBe(true);
    expect(action()?.textContent).toBe("Control requested");
    if (compact) {
      expect(participantRow("self").textContent).toContain("Requested");
      expect(participantRow("peer").textContent).not.toContain("Requested");
    }
    await click(action()!);
    expect(props.onRequestControl).toHaveBeenCalledOnce();
    if (compact) {
      expect(document.activeElement).toBe(dialog);
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        document.activeElement!.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
      });
      await finishFocusRestoration();
      expect(action()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger());
    }
  });

  it("surfaces an incoming request on the compact trigger and grants the requested participant", async () => {
    const requested = client({ state: { ...client().state!, requests: ["peer"] } });
    await render({ client: requested });
    expect(find("shared-browser-control-requests")?.textContent).toBe("1");
    expect(trigger().getAttribute("aria-label")).toContain("1 pending control request");
    await openControls();
    expect(action()?.textContent).toBe("Give control");
    expect(action()?.getAttribute("aria-label")).toBe("Give control to Anna");
    expect(action()?.closest("li")).toBe(participantRow("peer"));
    expect(participantRow("peer").textContent).toContain("Requested");
    expect(participantRow("self").textContent).not.toContain("Requested");
    await click(action()!);
    expect(props.onGrantControl).toHaveBeenCalledExactlyOnceWith("peer");

    await render({ localControlOwner: { kind: "agent", displayName: "Octo" } });
    expect(status()?.textContent).toBe("Octo controls");
    expect(action()).toBeNull();
    expect(participantRow("peer").textContent).toContain("Requested");
  });

  it.each([true, false])("preserves the full recipient in the grant action's accessible name (compact=%s)", async compact => {
    const longName = "Alexandra Morrison with a long display name";
    await render({ compact, client: client({ state: {
      ...client().state!,
      participants: [participant("self", "Taylor"), participant("peer", longName)],
      requests: ["peer"],
    } }) });
    if (compact) await openControls();
    expect(action()?.getAttribute("aria-label")).toBe(`Give control to ${longName}`);
    expect(action()?.textContent).toBe(compact ? "Give control" : `Give control to ${longName}`);
    if (compact) {
      expect(participantRow("peer").textContent).toContain(longName);
      expect(action()?.closest("li")).toBe(participantRow("peer"));
    }
    await click(action()!);
    expect(props.onGrantControl).toHaveBeenCalledExactlyOnceWith("peer");
  });

  it("labels every requester and offers control to the first queued request beside that participant", async () => {
    const requested = client({ state: {
      ...client().state!,
      participants: [participant("self", "Taylor"), participant("peer", "Anna"), participant("third", "Grace")],
      requests: ["third", "peer"],
    } });
    await render({ client: requested });
    expect(find("shared-browser-control-requests")?.textContent).toBe("2");
    await openControls();
    expect(participantRow("third").textContent).toContain("Requested");
    expect(participantRow("peer").textContent).toContain("Requested");
    expect(participantRow("self").textContent).not.toContain("Requested");
    expect(document.querySelectorAll('[data-testid="shared-browser-collaboration-control-action"]')).toHaveLength(1);
    expect(action()?.closest("li")).toBe(participantRow("third"));
    expect(action()?.getAttribute("aria-label")).toBe("Give control to Grace");
    await click(action()!);
    expect(props.onGrantControl).toHaveBeenCalledExactlyOnceWith("third");

    await render({ client: { ...requested, state: { ...requested.state!, requests: ["peer"] } } });
    expect(participantRow("third").textContent).not.toContain("Requested");
    expect(action()?.closest("li")).toBe(participantRow("peer"));
    expect(action()?.getAttribute("aria-label")).toBe("Give control to Anna");
  });

  it("keeps focus in the popup when granting control removes the action from its participant row", async () => {
    const requested = client({ state: { ...client().state!, requests: ["peer"] } });
    await render({ client: requested });
    await openControls();
    const dialog = document.querySelector('[role="dialog"][aria-label="Browser participants and control"]');
    await click(action()!);
    expect(document.activeElement).toBe(dialog);

    await render({ client: { ...requested, state: {
      ...requested.state!, requests: [], controlOwner: { kind: "human", participantId: "peer" },
    } } });
    expect(controller()?.closest("li")).toBe(participantRow("peer"));
    expect(participantRow("peer").querySelector("button")).toBeNull();
    expect(action()?.dataset.action).toBe("request");
    expect(document.activeElement).toBe(dialog);
  });

  it("hands control to the requested device even when both devices have the same account name", async () => {
    const participants = [participant("self", "Taylor"), participant("second-device", "Taylor"), participant("viewer", "Anna", false)];
    const deviceClient = (participantId: string, ownerId: string) => client({ participantId, state: {
      revision: 1, participants, controlOwner: { kind: "human", participantId: ownerId }, requests: ownerId === "self" ? ["second-device"] : [],
    } });
    await render({ client: deviceClient("self", "self") });
    await openControls();
    expect(status()?.textContent).toBe("You control");
    expect(controller()?.closest("li")?.dataset.participantId).toBe("self");
    await click(action()!);
    expect(props.onGrantControl).toHaveBeenCalledExactlyOnceWith("second-device");
    await render({ client: deviceClient("self", "second-device") });
    expect(status()?.textContent).toBe("Taylor controls");
    expect(controller()?.closest("li")?.dataset.participantId).toBe("second-device");
    expect(document.querySelector('li[data-participant-id="self"] [data-testid="shared-browser-controller-indicator"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="shared-browser-controller-indicator"]')).toHaveLength(1);
    expect(action()?.dataset.action).toBe("request");
    await click(action()!);
    expect(props.onRequestControl).toHaveBeenCalledOnce();
    await render({ client: deviceClient("second-device", "second-device") });
    expect(status()?.textContent).toBe("You control");
    expect(controller()?.closest("li")?.dataset.participantId).toBe("second-device");
    expect(controller()?.getAttribute("aria-label")).toBe("You control");
    expect(action()?.dataset.action).toBe("release");
  });

  it.each([
    { compact: false, ownerId: "peer" }, { compact: true, ownerId: "peer" },
    { compact: false, ownerId: "self" }, { compact: true, ownerId: "self" },
    { compact: false, ownerId: null }, { compact: true, ownerId: null },
  ])("keeps a read-only participant view-only (compact=$compact, owner=$ownerId)", async ({ compact, ownerId }) => {
    await render({ compact, client: client({ state: {
      revision: 1, participants: [participant("self", "Anna", false), participant("peer", "Taylor")],
      controlOwner: ownerId ? { kind: "human", participantId: ownerId } : null, requests: ["peer"],
    } }) });
    if (compact) await openControls();
    expect(status()?.textContent).toBe(ownerId === "self" ? "You control" : ownerId ? "Taylor controls" : "Control available");
    expect(action()).toBeNull();
  });

  it("allows an eligible participant to take available control", async () => {
    await render({ client: client({ state: { ...client().state!, controlOwner: null } }) });
    await openControls();
    expect(action()?.textContent).toBe("Take control");
    expect(status()?.textContent).toBe("Control available");
    expect(status()?.classList.contains("sr-only")).toBe(false);
    expect(controller()).toBeNull();
    await click(action()!);
    expect(props.onTakeControl).toHaveBeenCalledOnce();
  });

  it.each([
    { state: null, label: "Control syncing…" },
    { state: { ...client().state!, controlOwner: { kind: "human" as const, participantId: "not-yet-present" } }, label: "Teammate controls" },
  ])("keeps $label readable when there is no matching controller row", async ({ state, label }) => {
    await render({ client: client({ state }) });
    await openControls();
    expect(status()?.textContent).toBe(label);
    expect(status()?.classList.contains("sr-only")).toBe(false);
    expect(controller()).toBeNull();
  });

});
