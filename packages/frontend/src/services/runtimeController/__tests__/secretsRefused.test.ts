import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveContext } = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../core", async () => ({
  ...(await vi.importActual<typeof import("../core")>("../core")),
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
}));

import { listProjectSecrets, updateProjectSecret } from "../secrets";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";

function stored(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: null,
    agentIds: [],
    agentHandles: ["octo"],
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-11-13T10:00:00Z",
    updatedAt: "2026-11-13T10:00:00Z",
    ...extra,
  };
}

// docs/Local-Engine-Turns.md section 6: the controller marks a secret its
// credential guard refuses `refused: true` in the listing and in an update's
// answer, and says nothing for any other secret. Secrets reads the mark.
describe("a secret the credential guard refuses", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "inert-session" });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the controller's mark in the listing, and only a true one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            stored("refused-1", "CLAUDE_CODE_OAUTH_TOKEN", { refused: true }),
            stored("kept-1", "ANTHROPIC_API_KEY"),
            stored("odd-1", "DEPLOY_TOKEN", { refused: "yes" }),
          ]),
        ),
      ),
    );
    const result = await listProjectSecrets(PROJECT_ID);
    expect(result.success).toBe(true);
    expect(result.secrets.map((secret) => [secret.id, secret.refused ?? null])).toEqual([
      ["refused-1", true],
      ["kept-1", null],
      ["odd-1", null],
    ]);
    expect(result.secrets[1]).not.toHaveProperty("refused");
  });

  it("keeps the mark on an updated secret's answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(stored("refused-1", "CLAUDE_CODE_OAUTH_TOKEN", { refused: true, description: "remove me" }))),
      ),
    );
    const result = await updateProjectSecret(PROJECT_ID, "refused-1", { description: "remove me" });
    expect(result.success).toBe(true);
    expect(result.secret?.refused).toBe(true);
    expect(result.secret?.description).toBe("remove me");
  });
});
