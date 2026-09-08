import { describe, expect, it } from "vitest";
import { getStudioVisitKey } from "../../../../navigation/studioVisit";
import { chatScrollSnapshotKey, resolveChatScrollHistoryVisit } from "../chatScrollHistory";

const input = {
  location: { key: "first-entry", search: "?projectId=project-a&conversationId=chat-a&panel=chat" },
  userId: "user-a", projectId: "project-a", conversationsProjectKey: "project-a",
  conversationId: "chat-a", conversationControllerId: "remote-a",
};

describe("chat history visit identity", () => {
  it("keeps canonical replacements in one visit without conflating later pushes", () => {
    const original = resolveChatScrollHistoryVisit(input)!;
    const replaced = resolveChatScrollHistoryVisit({ ...input,
      location: { ...input.location, key: "replacement-key", state: { instafyVisitKey: "first-entry", preserved: true } },
    })!;
    expect(chatScrollSnapshotKey(replaced)).toBe(chatScrollSnapshotKey(original));
    expect(chatScrollSnapshotKey(resolveChatScrollHistoryVisit({ ...input,
      location: { ...input.location, key: "second-entry" },
    }))).not.toBe(chatScrollSnapshotKey(original));
    expect(getStudioVisitKey({ key: "router-key", state: { instafyVisitKey: " " } })).toBe("router-key");
  });

  it("prefers the explicit controller conversation identity over a stale local alias", () => {
    expect(resolveChatScrollHistoryVisit({ ...input,
      location: { ...input.location, search: "?projectId=project-a&conversationId=old-local&conversationControllerId=remote-a" },
    })?.conversationId).toBe("chat-a");
    expect(resolveChatScrollHistoryVisit({ ...input,
      location: { ...input.location, search: "?projectId=project-a&conversationId=chat-a&conversationControllerId=remote-b" },
    })).toBeNull();
  });

  it.each([
    { userId: null },
    { projectId: null },
    { conversationId: null },
    { conversationsProjectKey: "previous-project" },
    { location: { key: "new", search: "" } },
    { location: { key: "new", search: "?projectId=project-a" } },
    { location: { key: "new", search: "?projectId=project-b&conversationId=chat-a" } },
    { location: { key: "new", search: "?projectId=project-a&conversationId=chat-b" } },
    { location: { key: "new", search: "?projectId=project-a&conversationId=chat-a&panel=settings" } },
    { location: { key: "new", search: "?projectId=project-a&conversationId=chat-a&jobId=job-a" } },
  ])("does not adopt geometry while route/data identity is unresolved: %j", (override) => {
    expect(resolveChatScrollHistoryVisit({ ...input, ...override })).toBeNull();
  });

  it("isolates a matching job transcript from its parent chat and rejects a different job", () => {
    const location = { ...input.location, search: `${input.location.search}&jobId=job-a` };
    const job = resolveChatScrollHistoryVisit({ ...input, location,
      jobThread: { conversationId: "chat-a", jobId: "job-a" },
    });
    expect(job?.jobId).toBe("job-a");
    expect(chatScrollSnapshotKey(job)).not.toBe(chatScrollSnapshotKey(resolveChatScrollHistoryVisit(input)));
    expect(resolveChatScrollHistoryVisit({ ...input, location,
      jobThread: { conversationId: "chat-a", jobId: "job-b" },
    })).toBeNull();
    expect(resolveChatScrollHistoryVisit({ ...input, location,
      jobThread: { conversationId: "chat-b", jobId: "job-a" },
    })).toBeNull();
  });
});
