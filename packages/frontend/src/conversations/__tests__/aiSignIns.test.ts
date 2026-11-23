import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgentSignIn } from "@instafy/sdk/agents";
// Registers the application's turn engines, as the application does at startup.
import "../../features/applicationFrontendFeatureComposition";
import {
  loadClaudeCodeLogins,
  setClaudeCodeLoginsLoaderForTests,
} from "../../features/claudeCode/claudeCodeLoginsStore";
import type { ControllerCredentialListItem } from "../../services/runtimeController/credentials";
import {
  readAiSignInStamp,
  replySignInLine,
  resetViewerConnectionsForTests,
  setViewerConnections,
  setViewerConnectionsOwner,
  turnEngineReplySignIn,
  viewerConnectionsSnapshot,
  viewerHasSeveralSignIns,
  viewerSignInLabel,
  viewerSignInsScopeFor,
  viewerSignInsSnapshot,
} from "../aiSignIns";

// docs/Local-Engine-Turns.md 11.20, D51: the controller stamps which of a
// person's sign-ins ran a turn by id; Studio names it for its owner alone.

const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const SOMEONE_ELSES = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e99";
const LOGIN = { id: "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01", label: "Studio Max", createdAt: "2026-11-01T09:00:00Z" };

function connection(id: string, label: string | null, overrides: Partial<ControllerCredentialListItem> = {}) {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: { source: "device_code" },
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "", ...overrides,
  } as ControllerCredentialListItem;
}

const VIEWER = { isViewer: true, name: "Ada" };
const TEAMMATE = { isViewer: false, name: "Ada" };

describe("the sign-in a turn ran on", () => {
  beforeEach(() => {
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [] }));
  });
  afterEach(() => {
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(null);
  });

  it("reads only a stamp that names one sign-in by one key, as a UUID", () => {
    expect(readAiSignInStamp({ aiSignIn: { credentialId: WORK.toUpperCase() } })).toEqual({
      signIn: { credentialId: WORK },
      backup: false,
    });
    expect(readAiSignInStamp({ aiSignIn: { claudeCodeLoginId: LOGIN.id, backup: true } })).toEqual({
      signIn: { claudeCodeLoginId: LOGIN.id },
      backup: true,
    });
    expect(readAiSignInStamp({ aiSignInNext: { credentialId: PERSONAL } }, "aiSignInNext")?.signIn).toEqual({
      credentialId: PERSONAL,
    });
    for (const stamp of [
      { credentialId: WORK, claudeCodeLoginId: LOGIN.id },
      { credentialId: "cred-1" },
      { fixtureLoginId: WORK },
      { credentialId: 7 },
      [WORK],
      WORK,
      null,
    ]) {
      expect(readAiSignInStamp({ aiSignIn: stamp })).toBeNull();
    }
    // A stray backup flag is no stamp, and only the key asked for counts.
    expect(readAiSignInStamp({ aiSignIn: { backup: true } })).toBeNull();
    expect(readAiSignInStamp({ aiSignIn: { credentialId: WORK } }, "aiSignInNext")).toBeNull();
    expect(readAgentSignIn({ credentialId: WORK, claudeCodeLoginId: null })).toEqual({ credentialId: WORK });
  });

  it("names the viewer's own sign-ins by the names Your AI shows, and nobody else's", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, null)]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [LOGIN] }));
    await loadClaudeCodeLogins();
    const signIns = viewerSignInsSnapshot();
    expect(viewerSignInLabel({ credentialId: WORK }, signIns)).toBe("Work ChatGPT");
    // credentialFormatting's label for a connection with no name of its own.
    expect(viewerSignInLabel({ credentialId: PERSONAL }, signIns)).toBe(`Credential ${PERSONAL.slice(0, 8)}`);
    expect(viewerSignInLabel({ claudeCodeLoginId: LOGIN.id }, signIns)).toBe("Studio Max");
    expect(viewerSignInLabel({ credentialId: SOMEONE_ELSES }, signIns)).toBeNull();
    expect(viewerSignInLabel({ claudeCodeLoginId: SOMEONE_ELSES }, signIns)).toBeNull();
  });

  it("counts connections and every engine's sign-ins together, unknown until the lists say", async () => {
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBeNull();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    // One connection, and the engine's list not loaded: it cannot tell yet.
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBeNull();
    await loadClaudeCodeLogins();
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBe(false);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [LOGIN] }));
    await loadClaudeCodeLogins();
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBe(true);
    // Revoked connections and ones Your AI does not list don't count.
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [] }));
    setViewerConnections("user-1", [
      connection(WORK, "Work ChatGPT"),
      connection(PERSONAL, "Personal", { revokedAt: "2026-11-01T00:00:00Z" }),
      connection(SOMEONE_ELSES, "Other", { kind: "unknown" }),
    ]);
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBeNull();
    // Two connections settle it without the engine's list.
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    expect(viewerHasSeveralSignIns(viewerSignInsSnapshot())).toBe(true);
  });

  it("puts the line under a reply for its owner once they have more than one sign-in", async () => {
    const reply = { aiSignIn: { credentialId: WORK } };
    const backupReply = { aiSignIn: { credentialId: PERSONAL, backup: true } };
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    await loadClaudeCodeLogins();
    // One sign-in: nothing to tell apart.
    expect(replySignInLine(reply, VIEWER, viewerSignInsSnapshot())).toBeNull();

    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    expect(replySignInLine(reply, VIEWER, viewerSignInsSnapshot())).toBe("Ran on Work ChatGPT");
    expect(replySignInLine(backupReply, VIEWER, viewerSignInsSnapshot())).toBe("Ran on Personal, a backup");
    // An owner the chat cannot tell: only the viewer's own ids name anything.
    expect(replySignInLine(reply, null, viewerSignInsSnapshot())).toBe("Ran on Work ChatGPT");
    expect(replySignInLine({ aiSignIn: { credentialId: SOMEONE_ELSES } }, null, viewerSignInsSnapshot())).toBeNull();
    // Someone else's turn: no line, whatever it names.
    expect(replySignInLine(reply, TEAMMATE, viewerSignInsSnapshot())).toBeNull();
    // No stamp, no line.
    expect(replySignInLine({ aiAccessMode: "byoc" }, VIEWER, viewerSignInsSnapshot())).toBeNull();
  });

  it("tells a turn engine's line of a backup for the turn's own person alone", async () => {
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [LOGIN] }));
    await loadClaudeCodeLogins();
    const metadata = { aiSignIn: { claudeCodeLoginId: LOGIN.id, backup: true } };
    expect(turnEngineReplySignIn(metadata, VIEWER, viewerSignInsSnapshot())).toEqual({ backup: true });
    expect(turnEngineReplySignIn(metadata, TEAMMATE, viewerSignInsSnapshot())).toBeNull();
    expect(turnEngineReplySignIn(metadata, null, viewerSignInsSnapshot())).toBeNull();
  });

  it("watches the engines' lists only when naming a stamp needs them", () => {
    expect(viewerSignInsScopeFor([null], { count: true })).toBe("off");
    // An engine's sign-in needs its list.
    expect(viewerSignInsScopeFor([{ claudeCodeLoginId: LOGIN.id }], { count: false })).toBe("all");
    // Someone else's connection never names anything: no list is asked for.
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    expect(viewerSignInsScopeFor([{ credentialId: SOMEONE_ELSES }], { count: true })).toBe("connections");
    // The viewer's one connection needs the engines' lists to count, but not to name it.
    expect(viewerSignInsScopeFor([{ credentialId: WORK }], { count: true })).toBe("all");
    expect(viewerSignInsScopeFor([{ credentialId: WORK }], { count: false })).toBe("connections");
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    expect(viewerSignInsScopeFor([{ credentialId: WORK }], { count: true })).toBe("connections");
  });

  it("keeps the connections of the person signed in to the chat only", () => {
    setViewerConnectionsOwner("user-1");
    setViewerConnections("user-2", [connection(WORK, "Work ChatGPT")]);
    expect(viewerConnectionsSnapshot()).toBeNull();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT")]);
    expect(viewerConnectionsSnapshot()?.map((credential) => credential.id)).toEqual([WORK]);
    // Another person signs in: the list goes.
    setViewerConnectionsOwner("user-2");
    expect(viewerConnectionsSnapshot()).toBeNull();
    // A list of nobody's is never kept.
    setViewerConnections(null, [connection(WORK, "Work ChatGPT")]);
    expect(viewerConnectionsSnapshot()).toBeNull();
  });
});
