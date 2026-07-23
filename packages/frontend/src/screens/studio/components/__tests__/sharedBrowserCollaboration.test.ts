import { describe, expect, it } from "vitest";
import {
  INITIAL_SHARED_BROWSER_COLLABORATION_CLIENT_STATE,
  collaborationSelfOwnsControl,
  createSharedBrowserCollaborationCursorMessage,
  normalizeSharedBrowserCollaborationCursor,
  parseSharedBrowserCollaborationServerMessage,
  reduceSharedBrowserCollaborationClientState,
} from "../sharedBrowserCollaboration";

describe("Shared Browser collaboration protocol", () => {
  it("parses controller-attested welcome and state messages", () => {
    expect(
      parseSharedBrowserCollaborationServerMessage(
        JSON.stringify({ type: "welcome", participantId: "participant-1" }),
      ),
    ).toEqual({ type: "welcome", participantId: "participant-1" });

    expect(
      parseSharedBrowserCollaborationServerMessage({
        type: "state",
        revision: 4,
        participants: [
          {
            id: "participant-1",
            displayName: "Marcus",
            color: "#0ea5e9",
            pageId: "page-1",
            cursor: { x: 0.4, y: 0.2 },
            canControl: true,
          },
          {
            id: "participant-2",
            displayName: "Anna",
            color: "#8b5cf6",
            pageId: "page-1",
            cursor: null,
            canControl: true,
          },
        ],
        controlOwner: { kind: "human", participantId: "participant-1" },
        requests: ["participant-2"],
      }),
    ).toEqual({
      type: "state",
      revision: 4,
      participants: [
        {
          id: "participant-1",
          displayName: "Marcus",
          color: "#0ea5e9",
          pageId: "page-1",
          cursor: { x: 0.4, y: 0.2 },
          canControl: true,
        },
        {
          id: "participant-2",
          displayName: "Anna",
          color: "#8b5cf6",
          pageId: "page-1",
          cursor: null,
          canControl: true,
        },
      ],
      controlOwner: { kind: "human", participantId: "participant-1" },
      requests: ["participant-2"],
    });
  });

  it("rejects malformed state instead of widening the protocol", () => {
    expect(parseSharedBrowserCollaborationServerMessage("not json")).toBeNull();
    expect(
      parseSharedBrowserCollaborationServerMessage({
        type: "state",
        revision: 1,
        participants: [
          {
            id: "participant-1",
            displayName: "Marcus",
            color: "red",
            pageId: "page-1",
            cursor: { x: "secret", y: 0.5 },
            canControl: true,
          },
        ],
        controlOwner: null,
        requests: [],
      }),
    ).toBeNull();
    expect(
      parseSharedBrowserCollaborationServerMessage({
        type: "welcome",
        participantId: "participant-1",
        unexpected: "must fail closed",
      }),
    ).toBeNull();
    expect(
      parseSharedBrowserCollaborationServerMessage({
        type: "state",
        revision: 1,
        participants: Array.from({ length: 33 }, (_, index) => ({
          id: `participant-${index}`,
          displayName: `Participant ${index}`,
          color: "#0ea5e9",
          pageId: "page-1",
          cursor: null,
          canControl: true,
        })),
        controlOwner: null,
        requests: [],
      }),
    ).toBeNull();
    expect(
      parseSharedBrowserCollaborationServerMessage(
        JSON.stringify({ type: "welcome", participantId: "x" }) + " ".repeat(64 * 1024),
      ),
    ).toBeNull();
    expect(
      parseSharedBrowserCollaborationServerMessage({
        type: "cursor",
        pageId: "page-1",
        x: 0.2,
        y: 0.4,
        text: "must never be accepted",
      }),
    ).toBeNull();
  });

  it("keeps outbound cursor messages coordinate-only and bounded", () => {
    const cursor = normalizeSharedBrowserCollaborationCursor({ x: 0.123456, y: 9 });
    expect(cursor).toEqual({ x: 0.1235, y: 1 });
    expect(createSharedBrowserCollaborationCursorMessage("page-1", cursor!)).toEqual({
      type: "cursor",
      pageId: "page-1",
      x: 0.1235,
      y: 1,
    });
  });

  it("applies monotonic state revisions and fails closed on reconnect", () => {
    let client = reduceSharedBrowserCollaborationClientState(
      INITIAL_SHARED_BROWSER_COLLABORATION_CLIENT_STATE,
      { type: "reset", status: "connecting" },
    );
    client = reduceSharedBrowserCollaborationClientState(client, { type: "socket-open" });
    client = reduceSharedBrowserCollaborationClientState(client, {
      type: "server-message",
      message: { type: "welcome", participantId: "participant-1" },
    });
    client = reduceSharedBrowserCollaborationClientState(client, {
      type: "server-message",
      message: {
        type: "state",
        revision: 2,
        participants: [
          {
            id: "participant-1",
            displayName: "Marcus",
            color: "#0ea5e9",
            pageId: "page-1",
            cursor: null,
            canControl: true,
          },
        ],
        controlOwner: { kind: "human", participantId: "participant-1" },
        requests: [],
      },
    });
    expect(collaborationSelfOwnsControl(client)).toBe(true);

    const stale = reduceSharedBrowserCollaborationClientState(client, {
      type: "server-message",
      message: {
        type: "state",
        revision: 1,
        participants: [],
        controlOwner: null,
        requests: [],
      },
    });
    expect(stale).toBe(client);

    const reconnecting = reduceSharedBrowserCollaborationClientState(client, {
      type: "reset",
      status: "connecting",
    });
    expect(reconnecting.participantId).toBeNull();
    expect(reconnecting.state).toBeNull();
    expect(collaborationSelfOwnsControl(reconnecting)).toBe(false);
  });
});
