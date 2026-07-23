import { afterEach, describe, expect, it } from "vitest";

import {
  buildGithubImportFollowupMessage,
  consumeGithubImportFollowups,
  queueGithubImportFollowup,
  type GithubImportFollowupRecord,
} from "../githubImportFollowup";

const PENDING_QUEUE_KEY = "__INSTAFY_PENDING_GITHUB_IMPORT_FOLLOWUPS__";

afterEach(() => {
  (globalThis as typeof globalThis & { __INSTAFY_PENDING_GITHUB_IMPORT_FOLLOWUPS__?: unknown })[PENDING_QUEUE_KEY] = [];
});

describe("githubImportFollowup", () => {
  it("queues and consumes followups per project", () => {
    queueGithubImportFollowup({
      projectId: "project-a",
      repo: "quantleaf/probly-search",
      fileCount: 12,
      sourceMessageId: "integration-request-a",
    });
    queueGithubImportFollowup({
      projectId: "project-b",
      repo: "owner/second",
    });

    const projectA = consumeGithubImportFollowups("project-a");
    expect(projectA).toHaveLength(1);
    expect(projectA[0]?.projectId).toBe("project-a");
    expect(projectA[0]?.repo).toBe("quantleaf/probly-search");
    expect(projectA[0]?.sourceMessageId).toBe("integration-request-a");

    const projectB = consumeGithubImportFollowups("project-b");
    expect(projectB).toHaveLength(1);
    expect(projectB[0]?.projectId).toBe("project-b");

    expect(consumeGithubImportFollowups("project-a")).toHaveLength(0);
    expect(consumeGithubImportFollowups("project-b")).toHaveLength(0);
  });

  it("builds an assistant followup with suggested replies", () => {
    const entry: GithubImportFollowupRecord = {
      id: "followup-id",
      projectId: "project-a",
      repo: "quantleaf/probly-search",
      ref: "main",
      targetPath: "repos/quantleaf-probly-search",
      fileCount: 24,
      sourceMessageId: "integration-request-1",
      createdAt: 1700000000000,
    };

    const message = buildGithubImportFollowupMessage(entry);
    expect(message.role).toBe("assistant");
    expect(message.messageType ?? null).toBeNull();
    expect(message.content).toContain("quantleaf/probly-search");
    expect(message.content).toContain("24 files");
    expect(message.content).toContain("repos/quantleaf-probly-search");
    expect(message.metadata?.["ui"]).toMatchObject({
      suggestedReplies: expect.arrayContaining([
        "Please investigate the GitHub issues of this project we just imported.",
      ]),
    });
    expect(message.metadata?.["agent"]).toMatchObject({ handle: "octo" });
    expect(message.metadata?.["githubImport"]).toMatchObject({
      sourceMessageId: "integration-request-1",
    });
    expect(message.metadata?.["messageType"] ?? null).toBeNull();
    expect(message.metadata?.["source"] ?? null).toBeNull();
  });
});
