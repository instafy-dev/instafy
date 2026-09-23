import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import {
  applySharedBrowserRfbHumanInput,
  resolveSharedBrowserControlOwner,
  remoteSharedBrowserController,
  sharedBrowserHumanInputEnabled,
} from "../sharedBrowserControlOwner";

const RUNTIME_ID = "aa16d62b-4bc2-4ae9-90eb-e03dfd521bdd";
const PAGE_ID = "CDP_page_target_1";

function sharedRun(
  status: RunRecord["status"],
  metadata: Record<string, unknown> | null = {},
): Pick<RunRecord, "metadata" | "status"> {
  return {
    status,
    metadata:
      metadata === null
        ? null
        : {
            browserTransport: "shared",
            browserRuntimeId: RUNTIME_ID,
            browserPageId: PAGE_ID,
            agent: { displayName: "Octo" },
            ...metadata,
          },
  };
}

function resolveOwner(
  activeRuns: Array<Pick<RunRecord, "metadata" | "status">>,
  target: { browserPageId?: string | null; browserRuntimeId?: string | null } = {},
) {
  return resolveSharedBrowserControlOwner({
    activeRuns,
    browserPageId: target.browserPageId === undefined ? PAGE_ID : target.browserPageId,
    browserRuntimeId:
      target.browserRuntimeId === undefined ? RUNTIME_ID : target.browserRuntimeId,
  });
}

describe("Shared Browser control ownership", () => {
  it.each<RunRecord["status"]>(["queued", "in_progress"])(
    "gives the agent control while its exact Shared Browser run is %s",
    (status) => {
      const owner = resolveOwner([
        sharedRun(status, { browserRuntimeId: RUNTIME_ID.toUpperCase() }),
      ]);

      expect(owner).toEqual({ kind: "agent", displayName: "Octo" });
      expect(
        sharedBrowserHumanInputEnabled({ controlOwner: owner, transportActive: true }),
      ).toBe(false);
    },
  );

  it.each<RunRecord["status"]>(["awaiting_approval", "success", "failed"])(
    "does not infer local agent ownership while the matching run is %s",
    (status) => {
      const owner = resolveOwner([sharedRun(status)]);

      expect(owner).toEqual({ kind: "human" });
      expect(
        sharedBrowserHumanInputEnabled({ controlOwner: owner, transportActive: true }),
      ).toBe(true);
    },
  );

  it("ignores ordinary runs and Shared Browser runs for another runtime or page", () => {
    expect(
      resolveOwner([
        sharedRun("in_progress", { browserTransport: "personal" }),
        sharedRun("queued", { browserRuntimeId: "another-runtime" }),
        sharedRun("in_progress", { browserPageId: PAGE_ID.toLowerCase() }),
      ]),
    ).toEqual({ kind: "human" });
  });

  it("requires resolved target identity and canonical run metadata", () => {
    expect(resolveOwner([sharedRun("in_progress")], { browserRuntimeId: null })).toEqual({
      kind: "human",
    });
    expect(resolveOwner([sharedRun("in_progress")], { browserPageId: null })).toEqual({
      kind: "human",
    });
    expect(resolveOwner([sharedRun("in_progress", null)])).toEqual({ kind: "human" });
    expect(
      resolveOwner([
        sharedRun("in_progress", {
          browserRuntimeId: undefined,
          browserPageId: undefined,
        }),
      ]),
    ).toEqual({ kind: "human" });
  });

  it("uses only the matching run identity and falls back safely when it has no agent", () => {
    expect(
      resolveOwner([
        sharedRun("in_progress", {
          browserRuntimeId: "another-runtime",
          agent: { displayName: "Wrong agent" },
        }),
        sharedRun("queued", { agent: { handle: "@octo" } }),
      ]),
    ).toEqual({ kind: "agent", displayName: "@octo" });
    expect(resolveOwner([sharedRun("in_progress", { agent: null })])).toEqual({
      kind: "agent",
      displayName: "Assistant",
    });
  });

  it("prefers the executing run over a newer queued run on the same page", () => {
    expect(
      resolveOwner([
        sharedRun("queued", { agent: { displayName: "Queued agent" } }),
        sharedRun("in_progress", { agent: { displayName: "Executing agent" } }),
      ]),
    ).toEqual({ kind: "agent", displayName: "Executing agent" });
  });

  it("preserves hidden-tab input semantics for either owner", () => {
    expect(
      sharedBrowserHumanInputEnabled({
        controlOwner: { kind: "human" },
        transportActive: false,
      }),
    ).toBe(false);
  });

  it("toggles the RFB transport between view-only and human control", () => {
    const rfb = { viewOnly: false };
    applySharedBrowserRfbHumanInput(rfb, false);
    expect(rfb.viewOnly).toBe(true);
    applySharedBrowserRfbHumanInput(rfb, true);
    expect(rfb.viewOnly).toBe(false);
  });
});


it("indicates other controllers, never self ownership, unknown identity, or stale collaboration", () => {
  const client = {
    connectionStatus: "connected" as const, participantId: "self", error: null,
    state: { revision: 1, requests: [], controlOwner: { kind: "human" as const, participantId: "other" },
      participants: [{ id: "other", displayName: "Alice", color: "#fff", pageId: "page", cursor: null, canControl: true }] },
  };
  expect(remoteSharedBrowserController(client, null)).toEqual({ kind: "human", displayName: "Alice" });
  expect(remoteSharedBrowserController({ ...client, participantId: "other" }, null)).toBeNull();
  expect(remoteSharedBrowserController({ ...client, participantId: null }, null)).toBeNull();
  expect(remoteSharedBrowserController({ ...client, connectionStatus: "connecting" }, null)).toBeNull();
  expect(remoteSharedBrowserController({ ...client, state: null }, null)).toBeNull();
  expect(remoteSharedBrowserController({ ...client, state: { ...client.state, controlOwner: null } }, null)).toBeNull();
  expect(remoteSharedBrowserController({ ...client, state: { ...client.state, participants: [] } }, null)?.displayName).toBe("Another participant");
  const ai = { kind: "agent" as const, displayName: "Assistant" };
  expect(remoteSharedBrowserController(client, ai)).toBe(ai);
});
