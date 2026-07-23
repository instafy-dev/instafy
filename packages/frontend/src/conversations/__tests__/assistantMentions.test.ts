import { describe, expect, it } from "vitest";
import { extractAtMentionHandles, resolvePromptAgentSelection } from "../assistantMentions";

describe("assistantMentions", () => {
  it("extracts allowed handles in mention order", () => {
    const handles = extractAtMentionHandles("@octo ping @sloth and @ghost", ["octo", "sloth"]);
    expect(handles).toEqual(["octo", "sloth"]);
  });

  it("resolves multi-agent mentions as explicit targets", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "hello @a and @b",
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: ["a", "b"],
      stickyMentionedAgent: null,
    });

    expect(selection.activeHandles).toEqual(["octo"]);
    expect(selection.explicitMentionedHandles).toEqual(["a", "b"]);
    expect(selection.mentionedHandles).toEqual(["a", "b"]);
    expect(selection.targetHandles).toEqual(["a", "b"]);
  });

  it("does not route delegated child-thread mentions as parent-level targets", () => {
    const prompt =
      '@octo Create a linked child thread titled "Peer smoke". In that child thread only, post exactly: @ben what is 6+7? Reply here with a thread reference.';

    expect(extractAtMentionHandles(prompt, ["octo", "ben"])).toEqual(["octo"]);

    const selection = resolvePromptAgentSelection({
      prompt,
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: ["ben"],
      stickyMentionedAgent: null,
    });

    expect(selection.explicitMentionedHandles).toEqual(["octo"]);
    expect(selection.targetHandles).toEqual(["octo"]);
  });

  it("ignores literal mention examples inside backticks", () => {
    expect(
      extractAtMentionHandles("Send `@ben what is 6+7?` inside the child thread.", [
        "ben",
      ]),
    ).toEqual([]);
  });

  it("keeps sticky custom mention in default octo mode", () => {
    const first = resolvePromptAgentSelection({
      prompt: "@sloth write a poem",
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: ["sloth"],
      stickyMentionedAgent: null,
    });
    expect(first.targetHandles).toEqual(["sloth"]);
    expect(first.nextStickyMentionedAgent).toBe("sloth");

    const followUp = resolvePromptAgentSelection({
      prompt: "continue",
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: ["sloth"],
      stickyMentionedAgent: first.nextStickyMentionedAgent,
    });
    expect(followUp.explicitMentionedHandles).toEqual([]);
    expect(followUp.targetHandles).toEqual(["sloth"]);
    expect(followUp.mentionedHandles).toEqual(["sloth"]);
  });

  it("maps @octo mention to @octo", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "@octo hello",
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: [],
      stickyMentionedAgent: null,
    });

    expect(selection.explicitMentionedHandles).toEqual(["octo"]);
    expect(selection.targetHandles).toEqual(["octo"]);
    expect(selection.nextStickyMentionedAgent).toBeNull();
  });

  it("maps built-in aliases to the canonical assistant handle", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "@ai hello",
      assistantEnabled: true,
      extraAgentHandles: [],
      configuredAgentHandles: [],
      stickyMentionedAgent: null,
    });

    expect(selection.explicitMentionedHandles).toEqual(["octo"]);
    expect(selection.targetHandles).toEqual(["octo"]);
  });

  it("does not treat a provider-backed handle as a default generic chat handle", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "@localtool wake up",
      assistantEnabled: false,
      extraAgentHandles: [],
      configuredAgentHandles: [],
      stickyMentionedAgent: null,
    });

    expect(selection.explicitMentionedHandles).toEqual([]);
    expect(selection.targetHandles).toEqual([]);
    expect(selection.nextStickyMentionedAgent).toBeNull();
  });

  it("routes a provider handle only when it is explicitly configured as mentionable", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "@localtool wake up",
      assistantEnabled: false,
      extraAgentHandles: [],
      configuredAgentHandles: ["localtool"],
      stickyMentionedAgent: null,
    });

    expect(selection.explicitMentionedHandles).toEqual(["localtool"]);
    expect(selection.targetHandles).toEqual(["localtool"]);
    expect(selection.nextStickyMentionedAgent).toBe("localtool");
  });

  it("keeps sticky custom mention outside default octo mode", () => {
    const selection = resolvePromptAgentSelection({
      prompt: "hello",
      assistantEnabled: false,
      extraAgentHandles: ["a", "b"],
      configuredAgentHandles: ["a", "b"],
      stickyMentionedAgent: "a",
    });

    expect(selection.activeHandles).toEqual(["a", "b"]);
    expect(selection.mentionedHandles).toEqual(["a"]);
    expect(selection.targetHandles).toEqual(["a"]);
    expect(selection.nextStickyMentionedAgent).toBe("a");
  });

  it("routes follow-ups to last mentioned custom agent without pinned handles", () => {
    const first = resolvePromptAgentSelection({
      prompt: "@sloth how are you?",
      assistantEnabled: false,
      extraAgentHandles: [],
      configuredAgentHandles: ["sloth"],
      stickyMentionedAgent: null,
    });
    expect(first.targetHandles).toEqual(["sloth"]);
    expect(first.nextStickyMentionedAgent).toBe("sloth");

    const followUp = resolvePromptAgentSelection({
      prompt: "hello again",
      assistantEnabled: false,
      extraAgentHandles: [],
      configuredAgentHandles: ["sloth"],
      stickyMentionedAgent: first.nextStickyMentionedAgent,
    });
    expect(followUp.explicitMentionedHandles).toEqual([]);
    expect(followUp.mentionedHandles).toEqual(["sloth"]);
    expect(followUp.targetHandles).toEqual(["sloth"]);
  });
});
