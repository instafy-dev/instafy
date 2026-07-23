import { describe, expect, it } from "vitest";

import { extractExplicitGithubRepoReference } from "../chatGithubImportIntent";

describe("extractExplicitGithubRepoReference", () => {
  it("extracts the first explicit GitHub repository link with surrounding punctuation", () => {
    expect(
      extractExplicitGithubRepoReference(
        "Continue working with (<https://github.com/octocat/Hello-World>), please",
      ),
    ).toBe("https://github.com/octocat/Hello-World");
  });

  it("ignores owner/repo shorthand and non-repository GitHub links", () => {
    expect(extractExplicitGithubRepoReference("Import octocat/Hello-World")).toBeNull();
    expect(extractExplicitGithubRepoReference("Open https://github.com/octocat")).toBeNull();
  });

  it.each([
    "Review https://github.com/octocat/Hello-World",
    "How do I import https://github.com/octocat/Hello-World?",
    "Why can't I clone https://github.com/octocat/Hello-World?",
    "What happens if I import https://github.com/octocat/Hello-World?",
    "Is it possible to load https://github.com/octocat/Hello-World?",
    "Do you think we should import https://github.com/octocat/Hello-World?",
    "Could you tell me whether we should clone https://github.com/octocat/Hello-World?",
    "Can we discuss whether we should load https://github.com/octocat/Hello-World?",
    "What do you think: we should pull https://github.com/octocat/Hello-World?",
    "Do you really think you should import https://github.com/octocat/Hello-World?",
    "Do not import https://github.com/octocat/Hello-World",
    "I am not asking you to import https://github.com/octocat/Hello-World",
    "No need to clone https://github.com/octocat/Hello-World",
    "I don't think this will work on https://github.com/octocat/Hello-World",
    "Review this without importing https://github.com/octocat/Hello-World",
    "Import https://github.com/octocat/Hello-World/issues/1",
    "Import https://github.com/octocat/Hello-World/blob/main/README.md",
    "Import https://notgithub.com/octocat/Hello-World",
  ])("does not turn a non-import GitHub mention into a workspace mutation: %s", (message) => {
    expect(extractExplicitGithubRepoReference(message)).toBeNull();
  });

  it("accepts the private-project phrasing used by first-run chat", () => {
    expect(
      extractExplicitGithubRepoReference(
        "I want to work on my private project https://github.com/instafy-dev/private-repo",
      ),
    ).toBe("https://github.com/instafy-dev/private-repo");
  });

  it("accepts the continue-to-work phrasing used by the chat smoke", () => {
    expect(
      extractExplicitGithubRepoReference(
        "Hey I want to continue to work on my project https://github.com/openai/openai-openapi",
      ),
    ).toBe("https://github.com/openai/openai-openapi");
  });

  it.each([
    "Import https://github.com/octocat/Hello-World",
    "We should import https://github.com/octocat/Hello-World",
    "Can we import https://github.com/octocat/Hello-World now?",
    "Do you think this is ready? We should import https://github.com/octocat/Hello-World",
    "Could you clone https://github.com/octocat/Hello-World",
    "I would like to load https://github.com/octocat/Hello-World",
    "Please work on https://github.com/octocat/Hello-World",
    "Can you work with https://github.com/octocat/Hello-World",
    "Let's continue working on https://github.com/octocat/Hello-World",
  ])("accepts an explicit request to make the repository the workspace: %s", (message) => {
    expect(extractExplicitGithubRepoReference(message)).toBe(
      "https://github.com/octocat/Hello-World",
    );
  });
});
