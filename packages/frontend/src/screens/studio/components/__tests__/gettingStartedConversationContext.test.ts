import { describe, expect, it } from "vitest";
import {
  resolveConversationHumanPeerContext,
  resolveGettingStartedConversationContext,
} from "../gettingStartedConversationContext";

const peerBaseInput = {
  conversationVisibility: "public" as const,
  controllerConversationId: "conversation-1",
  currentUserId: "user-1",
  orgMemberError: null,
  orgMemberLoading: false,
  orgMembers: [],
  participantError: null,
  participantLoading: false,
  participants: [{ userId: "user-1" }],
  projectMemberError: null,
  projectMemberLoading: false,
  projectMembers: [],
  runtimeControllerEnabled: true,
};

const baseInput = {
  ...peerBaseInput,
  anyAgentsEnabled: false,
};

describe("resolveConversationHumanPeerContext", () => {
  it("resolves a known conversation peer", () => {
    expect(
      resolveConversationHumanPeerContext({
        ...peerBaseInput,
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      }),
    ).toEqual({ hasHumanPeer: true, resolved: true });
  });

  it("resolves a known solo conversation without a peer", () => {
    expect(resolveConversationHumanPeerContext(peerBaseInput)).toEqual({
      hasHumanPeer: false,
      resolved: true,
    });
  });

  it("fails closed while participant context is unresolved", () => {
    expect(
      resolveConversationHumanPeerContext({
        ...peerBaseInput,
        participantLoading: true,
      }),
    ).toEqual({ hasHumanPeer: false, resolved: false });
  });

  it("includes authorized public project and org peers", () => {
    expect(
      resolveConversationHumanPeerContext({
        ...peerBaseInput,
        projectMembers: [{ userId: "project-peer" }],
      }),
    ).toEqual({ hasHumanPeer: true, resolved: true });
    expect(
      resolveConversationHumanPeerContext({
        ...peerBaseInput,
        orgMembers: [{ userId: "org-peer" }],
      }),
    ).toEqual({ hasHumanPeer: true, resolved: true });
  });
});

describe("resolveGettingStartedConversationContext", () => {
  it("suppresses discovery when an AI-disabled conversation has another human", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        participants: [{ userId: "conversation-owner" }],
      }),
    ).toEqual({ relevant: false, resolved: true });
  });

  it("preserves discovery for a single-user conversation", () => {
    expect(resolveGettingStartedConversationContext(baseInput)).toEqual({
      relevant: true,
      resolved: true,
    });
  });

  it("suppresses discovery for a public conversation with a project-member peer", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        projectMembers: [
          { userId: "user-1" },
          { userId: "invited-peer" },
        ],
      }),
    ).toEqual({ relevant: false, resolved: true });
  });

  it("suppresses discovery for a public conversation with an org-only peer", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        orgMembers: [
          { userId: "user-1" },
          { userId: "org-peer" },
        ],
      }),
    ).toEqual({ relevant: false, resolved: true });
  });

  it("does not treat project members as participants in a private conversation", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        conversationVisibility: "private",
        projectMembers: [{ userId: "invited-peer" }],
      }),
    ).toEqual({ relevant: true, resolved: true });
  });

  it("does not treat org members as participants in a private conversation", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        conversationVisibility: "private",
        orgMembers: [{ userId: "org-peer" }],
      }),
    ).toEqual({ relevant: true, resolved: true });
  });

  it("preserves discovery for an AI-oriented group conversation", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        anyAgentsEnabled: true,
        participantLoading: true,
        participants: [{ userId: "user-2" }],
      }),
    ).toEqual({ relevant: true, resolved: true });
  });

  it("waits instead of flashing discovery while the participant context is unknown", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        participantLoading: true,
        participants: [],
      }),
    ).toEqual({ relevant: false, resolved: false });

    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        participantError: "Unavailable",
        participants: [],
      }),
    ).toEqual({ relevant: false, resolved: false });
  });

  it("waits for public project membership without blocking private discovery", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        projectMemberLoading: true,
      }),
    ).toEqual({ relevant: false, resolved: false });

    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        projectMemberError: "Unavailable",
        projectMembers: [{ userId: "stale-peer" }],
      }),
    ).toEqual({ relevant: false, resolved: false });

    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        conversationVisibility: "private",
        projectMemberLoading: true,
        projectMemberError: "Unavailable",
      }),
    ).toEqual({ relevant: true, resolved: true });
  });

  it("waits for an authorized public org directory without blocking private discovery", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        orgMemberLoading: true,
      }),
    ).toEqual({ relevant: false, resolved: false });

    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        orgMemberError: "Unavailable",
        orgMembers: [{ userId: "stale-peer" }],
      }),
    ).toEqual({ relevant: false, resolved: false });

    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        conversationVisibility: "private",
        orgMemberLoading: true,
        orgMemberError: "Unavailable",
      }),
    ).toEqual({ relevant: true, resolved: true });
  });

  it("keeps AI-enabled onboarding available while membership is unresolved", () => {
    expect(
      resolveGettingStartedConversationContext({
        ...baseInput,
        anyAgentsEnabled: true,
        projectMemberLoading: true,
        projectMemberError: "Unavailable",
      }),
    ).toEqual({ relevant: true, resolved: true });
  });
});
