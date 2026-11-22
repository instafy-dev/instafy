// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Registers the application's turn engines, as the application does at startup.
import "../../../../features/applicationFrontendFeatureComposition";
import {
  resolveRunFailurePresentation,
  type TurnEngineTurnOwner,
} from "../../../../conversations/runFailurePresentation";
import {
  resetViewerConnectionsForTests,
  setViewerConnections,
} from "../../../../conversations/aiSignIns";
import { setClaudeCodeLoginsLoaderForTests } from "../../../../features/claudeCode/claudeCodeLoginsStore";
import type { ControllerCredentialListItem } from "../../../../services/runtimeController/credentials";
import type { ChatMessage } from "../../types";
import { resolveCopyableMessageContent } from "../chatTranscriptCopy";
import {
  RunFailureMessageBody,
  RunFailureRetryProvider,
  type RunFailureRetryContextValue,
} from "../RunFailureNotice";

// docs/Local-Engine-Turns.md 11.20: a turn that stopped at its sign-in's
// plan's limit tells its owner which sign-in the agent's next turns use, and
// offers Try again, since a resend goes there. Without a next sign-in, a usage
// limit reads and acts as before.

const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const STUDIO_LOGIN = { id: "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02", label: "Studio", createdAt: "2026-11-02T09:00:00Z" };
const RAW = "You've hit your usage limit. Try again at 2026-11-23 18:00 UTC.";
const NEXT_SENTENCE = "Work ChatGPT reached its plan's limit, so this turn stopped. Reviewer's next turns use Personal.";

function connection(id: string, label: string): ControllerCredentialListItem {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: null,
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "",
  } as ControllerCredentialListItem;
}

function failure(metadata: Record<string, unknown> = {}, content = RAW): ChatMessage {
  return {
    id: "failure-1",
    role: "assistant",
    authorId: null,
    content,
    timestamp: 2,
    files: null,
    messageType: "error",
    metadata: {
      source: "agent",
      outcome: "failed",
      messageType: "error",
      jobId: "job-1",
      aiAccessMode: "byoc",
      agent: { handle: "reviewer", displayName: "Reviewer" },
      aiSignIn: { credentialId: WORK },
      ...metadata,
    },
  };
}

function context(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return {
    pendingRetryKey: null,
    requestRetry: vi.fn(),
    autoRetryingKey: null,
    isRetrySuperseded: () => false,
    onConnectAi: vi.fn(),
    turnEngineOwnerOf: () => owner,
  };
}

const VIEWER = { isViewer: true, name: "Ada" };
const TEAMMATE = { isViewer: false, name: "Ada" };

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("a failure at a plan's limit, with backups", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetViewerConnectionsForTests();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [STUDIO_LOGIN] }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(message: ChatMessage, owner: TurnEngineTurnOwner | null) {
    const presentation = resolveRunFailurePresentation({ metadata: message.metadata, content: message.content, assumeFailed: true });
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={context(owner)}>
          <RunFailureMessageBody message={message} presentation={presentation!} />
        </RunFailureRetryProvider>,
      );
      await flush();
    });
  }

  const sentence = () => container.querySelector('[data-testid="run-failure-body"] p')?.textContent ?? "";
  const retry = () => container.querySelector('[data-testid="run-failure-retry"]');

  it("tells its owner which sign-in the agent's next turns use, and offers Try again", async () => {
    await render(failure({ aiSignInNext: { credentialId: PERSONAL, backup: true } }), VIEWER);
    expect(sentence()).toBe(NEXT_SENTENCE);
    expect(retry()).not.toBeNull();
    // Details keep the raw text.
    expect(container.querySelector('[data-testid="run-failure-details-toggle"]')).not.toBeNull();
  });

  it("reads and acts as before without a next sign-in: no Try again for a usage limit", async () => {
    await render(failure(), VIEWER);
    expect(sentence()).toContain("Your AI account has reached its usage limit, so this turn stopped.");
    expect(retry()).toBeNull();
  });

  it("names no sign-in to anyone else, who reads it as before", async () => {
    await render(failure({ aiSignInNext: { credentialId: PERSONAL } }), TEAMMATE);
    expect(sentence()).toContain("has reached its usage limit, so this turn stopped.");
    expect(sentence()).not.toContain("Work ChatGPT");
    expect(sentence()).not.toContain("Personal");
    expect(retry()).toBeNull();
    // A sign-in that is not one of the viewer's names nothing either.
    await render(
      failure({ aiSignIn: { credentialId: "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e99" }, aiSignInNext: { credentialId: PERSONAL } }),
      null,
    );
    expect(sentence()).toContain("has reached its usage limit, so this turn stopped.");
    expect(sentence()).not.toContain("reached its plan's limit");
    expect(retry()).toBeNull();
  });

  it("words a Claude Code login's plan_limit the same way, with its Try again", async () => {
    const message = failure(
      {
        aiAccessMode: "claude-code",
        claudeCode: { version: 1, loginId: STUDIO_LOGIN.id },
        claudeCodeFailure: "plan_limit",
        aiSignIn: { claudeCodeLoginId: STUDIO_LOGIN.id },
        aiSignInNext: { credentialId: WORK, backup: true },
      },
      "Claude Code: usage limit reached.",
    );
    await render(message, VIEWER);
    expect(sentence()).toBe(
      "Studio reached its plan's limit, so this turn stopped. Reviewer's next turns use Work ChatGPT.",
    );
    expect(retry()).not.toBeNull();
    // Without a next sign-in, Claude Code's own sentence, as before.
    await render(failure({ ...message.metadata as Record<string, unknown>, aiSignInNext: undefined }, message.content), VIEWER);
    expect(sentence()).toBe(
      "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets.",
    );
  });

  it("carries the same sentence into a copy of the chat, for its owner alone", () => {
    const message = failure({ aiSignInNext: { credentialId: PERSONAL } });
    expect(resolveCopyableMessageContent(message, { turnEngineOwnerOf: () => VIEWER })).toBe(NEXT_SENTENCE);
    expect(resolveCopyableMessageContent(message, { turnEngineOwnerOf: () => TEAMMATE })).not.toContain("Personal");
  });
});
