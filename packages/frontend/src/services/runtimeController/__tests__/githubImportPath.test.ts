import { describe, expect, it } from "vitest";

import {
  deriveGithubImportTargetPath,
  parseGithubRepoOwnerName,
} from "../githubImportPath";

describe("parseGithubRepoOwnerName", () => {
  it.each([
    "octocat/Hello-World",
    "https://github.com/octocat/Hello-World",
    "https://www.github.com/octocat/Hello-World.git?tab=readme",
    "git@github.com:octocat/Hello-World.git",
  ])("accepts an exact repository reference: %s", (value) => {
    expect(parseGithubRepoOwnerName(value)).toEqual({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it.each([
    "https://notgithub.com/octocat/Hello-World",
    "https://github.com/octocat/Hello-World/issues/1",
    "https://github.com/octocat/Hello-World/blob/main/README.md",
    "https://octocat.github.com/Hello-World",
    "octocat/Hello-World/extra",
  ])("rejects a lookalike or non-root repository reference: %s", (value) => {
    expect(parseGithubRepoOwnerName(value)).toBeNull();
  });

  it("does not derive a misleading owner path from an invalid URL", () => {
    expect(deriveGithubImportTargetPath("https://notgithub.com/octocat/Hello-World")).toBe(
      "repos/imported-repo",
    );
  });
});
