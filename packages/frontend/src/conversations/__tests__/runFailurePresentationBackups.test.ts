import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Registers the application's turn engines, as the application does at startup.
import "../../features/applicationFrontendFeatureComposition";
import {
  loadClaudeCodeLogins,
  setClaudeCodeLoginsLoaderForTests,
} from "../../features/claudeCode/claudeCodeLoginsStore";
import type { ControllerCredentialListItem } from "../../services/runtimeController/credentials";
import { resetViewerConnectionsForTests, setViewerConnections, viewerSignInsSnapshot } from "../aiSignIns";
import { nextSignInForViewer, resolveRunFailurePresentation } from "../runFailurePresentation";

// docs/Local-Engine-Turns.md 11.20: a turn that stopped at its sign-in's
// plan's limit says, to its owner alone, which sign-in the agent's next
// turns use.

const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Studio Max", createdAt: "2026-11-01T09:00:00Z" };
const USAGE_LIMIT = "You've hit your usage limit. Try again at 2026-11-23 18:00 UTC.";

function connection(id: string, label: string | null): ControllerCredentialListItem {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: null,
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "",
  } as ControllerCredentialListItem;
}

function failure(metadata: Record<string, unknown>, content = USAGE_LIMIT) {
  const presentation = resolveRunFailurePresentation({
    metadata: { source: "agent", outcome: "failed", aiAccessMode: "byoc", agent: { handle: "reviewer", displayName: "Reviewer" }, ...metadata },
    content,
  });
  if (!presentation) {
    throw new Error("expected a failure");
  }
  return presentation;
}

const VIEWER = { isViewer: true, name: "Ada" };

describe("a failure at a plan's limit with a next sign-in", () => {
  beforeEach(() => {
    resetViewerConnectionsForTests();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [LOGIN] }));
  });
  afterEach(() => {
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(null);
  });

  it("keeps what the controller stamped beside the failure's own kind", () => {
    const stamped = failure({ aiSignIn: { credentialId: WORK }, aiSignInNext: { credentialId: PERSONAL } });
    expect(stamped.kind).toBe("provider_usage_limit");
    expect(stamped.nextSignIn).toEqual({
      stopped: { credentialId: WORK },
      next: { credentialId: PERSONAL },
      agentName: "Reviewer",
    });
    // Without aiSignInNext, or naming the same sign-in twice, it is as today.
    expect(failure({ aiSignIn: { credentialId: WORK } }).nextSignIn).toBeUndefined();
    expect(failure({ aiSignIn: { credentialId: WORK }, aiSignInNext: { credentialId: WORK } }).nextSignIn).toBeUndefined();
    expect(failure({ aiSignInNext: { credentialId: PERSONAL } }).nextSignIn).toBeUndefined();
  });

  it("names both for the turn's own person, by their own names", () => {
    const stamped = failure({ aiSignIn: { credentialId: WORK }, aiSignInNext: { credentialId: PERSONAL, backup: true } });
    expect(nextSignInForViewer(stamped, { owner: VIEWER, signIns: viewerSignInsSnapshot() })).toEqual({
      sentence: "Work ChatGPT reached its plan's limit, so this turn stopped. Reviewer's next turns use Personal.",
    });
    // An owner the chat cannot tell: only the viewer's own ids name anything.
    expect(nextSignInForViewer(stamped, { owner: null, signIns: viewerSignInsSnapshot() })?.sentence).toContain(
      "Work ChatGPT reached",
    );
  });

  it("names nothing for anyone else, or for a sign-in that is not the viewer's", () => {
    const stamped = failure({ aiSignIn: { credentialId: WORK }, aiSignInNext: { credentialId: PERSONAL } });
    expect(nextSignInForViewer(stamped, { owner: { isViewer: false, name: "Ada" }, signIns: viewerSignInsSnapshot() })).toBeNull();
    expect(nextSignInForViewer(stamped, { owner: VIEWER, signIns: null })).toBeNull();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    expect(nextSignInForViewer(stamped, { owner: VIEWER, signIns: viewerSignInsSnapshot() })).toBeNull();
    // Without the stamp there is nothing to say.
    expect(nextSignInForViewer(failure({ aiSignIn: { credentialId: WORK } }), { owner: VIEWER, signIns: viewerSignInsSnapshot() })).toBeNull();
  });

  it("words a Claude Code login's plan_limit the same way, and the agent by its handle without a name", async () => {
    await loadClaudeCodeLogins();
    const stamped = failure(
      {
        aiAccessMode: "claude-code",
        claudeCode: { version: 1, loginId: LOGIN.id },
        claudeCodeFailure: "plan_limit",
        agent: { handle: "reviewer" },
        aiSignIn: { claudeCodeLoginId: LOGIN.id },
        aiSignInNext: { credentialId: WORK, backup: true },
      },
      "Claude Code reached its usage limit.",
    );
    expect(stamped.kind).toBe("turn_engine");
    expect(nextSignInForViewer(stamped, { owner: VIEWER, signIns: viewerSignInsSnapshot() })?.sentence).toBe(
      "Studio Max reached its plan's limit, so this turn stopped. @reviewer's next turns use Work ChatGPT.",
    );
    const octo = failure({
      agent: { handle: "octo" },
      aiSignIn: { credentialId: WORK },
      aiSignInNext: { claudeCodeLoginId: LOGIN.id },
    });
    expect(nextSignInForViewer(octo, { owner: VIEWER, signIns: viewerSignInsSnapshot() })?.sentence).toBe(
      "Work ChatGPT reached its plan's limit, so this turn stopped. Octo's next turns use Studio Max.",
    );
  });

  it("keeps the failure's own sentence when a name would not read plainly, and still sends it on", () => {
    // credentialFormatting's name for a connection without one names an id
    // and the plumbing, which no failure sentence does (docs/Chat-Activity.md).
    setViewerConnections("user-1", [connection(WORK, null), connection(PERSONAL, "Personal")]);
    const stamped = failure({ aiSignIn: { credentialId: WORK }, aiSignInNext: { credentialId: PERSONAL } });
    expect(nextSignInForViewer(stamped, { owner: VIEWER, signIns: viewerSignInsSnapshot() })).toEqual({ sentence: null });
  });
});
