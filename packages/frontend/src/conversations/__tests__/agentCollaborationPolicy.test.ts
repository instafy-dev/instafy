import { describe, expect, it } from "vitest";

import {
  buildPromptAdvisoryScopeClaims,
  decideTopLevelAgentCollaborationMode,
  decideTopLevelAgentCollaborationModes,
} from "../agentCollaborationPolicy";

describe("agentCollaborationPolicy", () => {
  it("keeps short direct @agent asks inline", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt: "@octo What is 1+1? Reply with just the number.",
        explicitHandles: ["octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("keeps deeper same-agent work inline by default", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "@octo Review the auth flow, inspect the relevant files, and propose the fix for the session bug.",
        explicitHandles: ["octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("does not hard-code explicit split wording in the frontend policy", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "@octo Split this into a separate work thread: review the auth flow, inspect files, and propose a fix.",
        explicitHandles: ["octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("keeps multi-agent explicit mentions inline unless a split is requested", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt: "@octo @sage compare the current controller and frontend routing behavior.",
        explicitHandles: ["octo", "sage"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("keeps independent short multi-agent asks inline", () => {
    const decisions = decideTopLevelAgentCollaborationModes({
      prompt: "@ben What is 1+1? @octo Can you write a two-line poem for me?",
      explicitHandles: ["ben", "octo"],
      hasAttachments: false,
      hasTerminalIntent: false,
    });

    expect(decisions).toEqual({
      ben: "inline",
      octo: "inline",
    });
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt: "@ben What is 1+1? @octo Can you write a two-line poem for me?",
        explicitHandles: ["ben", "octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("keeps mixed multi-agent split wording inline for runtime routing", () => {
    expect(
      decideTopLevelAgentCollaborationModes({
        prompt:
          "@ben What is 1+1? @octo Split this into a separate work thread: review the auth flow, inspect files, and propose a fix.",
        explicitHandles: ["ben", "octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toEqual({
      ben: "inline",
      octo: "inline",
    });
  });

  it("keeps negated thread wording inline", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "@ben Reply inline in this chat with exactly BEN-ONLY. Do not create a linked thread.",
        explicitHandles: ["ben"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");

    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "@ben Reply inline with a status update without creating a separate thread.",
        explicitHandles: ["ben"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("keeps later affirmative split wording inline", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "@octo Do not return a thread id only. Split this into a separate work thread and inspect the routing policy.",
        explicitHandles: ["octo"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });

  it("does not treat child thread references as frontend routing instructions", () => {
    expect(
      decideTopLevelAgentCollaborationModes({
        prompt:
          '@octo Create a linked child thread titled "Peer smoke". In that child thread only, post exactly: @ben what is 6+7? Reply here with the child thread id and reference.',
        explicitHandles: ["octo", "ben"],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toEqual({
      octo: "inline",
      ben: "inline",
    });
  });

  it("builds a compact advisory task claim from the prompt", () => {
    expect(
      buildPromptAdvisoryScopeClaims(
        "@octo Investigate auth middleware and summarize the current failure mode.",
      ),
    ).toEqual([
      {
        advisory: true,
        kind: "task",
        label: "Investigate auth middleware and summarize the current failure mode.",
        scope: "Investigate auth middleware and summarize the current failure mode.",
        source: "prompt",
      },
    ]);
  });

  it("does not hard-code security fanout in the frontend policy", () => {
    expect(
      decideTopLevelAgentCollaborationMode({
        prompt:
          "Find security issues in this project. This is a large codebase, so use parallel read-only subagents by subpath. Do not edit files.",
        explicitHandles: [],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");

    expect(
      decideTopLevelAgentCollaborationMode({
        prompt: "Find and fix security issues in this project.",
        explicitHandles: [],
        hasAttachments: false,
        hasTerminalIntent: false,
      }),
    ).toBe("inline");
  });
});
