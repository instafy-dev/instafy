import { describe, expect, it } from "vitest";
import {
  parseGithubImportResumeAction,
} from "../githubImport";

describe("githubImport helpers", () => {
  it("round-trips integration request resume details", () => {
    const details = {
      provider: "github",
      description: "Connect GitHub to continue importing openai/openai-openapi.",
      requiredScopes: ["repo.read"],
      capabilities: ["repo.import"],
      authMethods: ["oauth"],
      resumeAction: {
        kind: "github_import",
        repo: "openai/openai-openapi",
        ref: "main",
        targetPath: "repos/openai-openai-openapi",
        promptMessage: "Continue working on https://github.com/openai/openai-openapi",
      },
    };
    expect(parseGithubImportResumeAction(details)).toEqual({
      repo: "openai/openai-openapi",
      ref: "main",
      kind: "github_import",
      targetPath: "repos/openai-openai-openapi",
      promptMessage: "Continue working on https://github.com/openai/openai-openapi",
      idempotencyKey: null,
    });
  });

  it("preserves the original operation key for an import retry", () => {
    expect(
      parseGithubImportResumeAction({
        resumeAction: {
          kind: "github_import",
          repo: "openai/openai-openapi",
          idempotencyKey: "github-import-v1:original",
        },
      }),
    ).toMatchObject({ idempotencyKey: "github-import-v1:original" });
  });
});
