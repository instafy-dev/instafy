import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClaudeCodeLogin,
  deleteClaudeCodeLogin,
  listClaudeCodeLogins,
  normalizeClaudeCodeLoginLabel,
  renameClaudeCodeLogin,
} from "../claudeCodeLogins";
import { listMyAgents } from "../agents";

// docs/Local-Engine-Turns.md 11.19: the person's Claude Code logins, an id
// and a name each, from their own session. Nothing reaches a controller: the
// requests go to a stubbed fetch.

const { resolveContext } = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../core", async () => ({
  ...(await vi.importActual<typeof import("../core")>("../core")),
  runtimeControllerEnabled: true,
  controllerBaseUrl: "https://controller.test",
  resolveControllerRequestContext: resolveContext,
}));

const WORK = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
const PERSONAL = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body?: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
  );
}

function sent(index = 0): { url: string; method: string; body: unknown; authorization: string | null } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    authorization: new Headers(init.headers).get("authorization"),
  };
}

beforeEach(() => {
  resolveContext.mockResolvedValue({ baseUrl: "https://controller.test", accessToken: "inert-session" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("the person's Claude Code logins", () => {
  it("lists them oldest first, as the controller orders them, keeping only well-formed ones", async () => {
    answer(200, {
      logins: [
        { id: PERSONAL, label: "Personal", createdAt: "2026-11-01T09:00:00Z" },
        { id: WORK.toUpperCase(), label: " Work ", createdAt: "2026-11-02T09:00:00Z", folder: "/Users/sam/.claude-work" },
        { id: "not-a-uuid", label: "Odd", createdAt: "2026-11-03T09:00:00Z" },
        { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "", createdAt: "2026-11-03T09:00:00Z" },
        { id: PERSONAL, label: "Twice", createdAt: "2026-11-04T09:00:00Z" },
        "nothing",
      ],
    });
    const result = await listClaudeCodeLogins();
    expect(sent()).toMatchObject({
      url: "https://controller.test/me/claude-code-logins",
      method: "GET",
      authorization: "Bearer inert-session",
    });
    expect(result).toEqual({
      success: true,
      logins: [
        { id: PERSONAL, label: "Personal", createdAt: "2026-11-01T09:00:00Z" },
        // Nothing but an id, a name and when it was made: no folder.
        { id: WORK, label: "Work", createdAt: "2026-11-02T09:00:00Z" },
      ],
    });
  });

  it("reads an answer without a list as a failure", async () => {
    answer(200, { items: [] });
    await expect(listClaudeCodeLogins()).resolves.toMatchObject({ success: false, code: null });
  });

  it("adds one by its name, and keeps the controller's code when it refuses", async () => {
    answer(201, { id: WORK, label: "Work", createdAt: "2026-11-22T10:00:00Z" });
    await expect(createClaudeCodeLogin("Work")).resolves.toEqual({
      success: true,
      login: { id: WORK, label: "Work", createdAt: "2026-11-22T10:00:00Z" },
    });
    expect(sent()).toMatchObject({ url: "https://controller.test/me/claude-code-logins", method: "POST", body: { label: "Work" } });

    for (const [status, code] of [
      [403, "claude_code_turn_not_allowed"],
      [400, "claude_code_login_label_invalid"],
      [409, "claude_code_login_label_taken"],
      [409, "claude_code_login_limit"],
    ] as const) {
      answer(status, { message: "refused", code });
      await expect(createClaudeCodeLogin("Work")).resolves.toMatchObject({ success: false, code });
    }
  });

  it("renames and deletes one by its id, and asks nothing for an id that is not one", async () => {
    answer(200, { id: WORK, label: "Day job", createdAt: "2026-11-22T10:00:00Z" });
    await expect(renameClaudeCodeLogin(WORK, "Day job")).resolves.toMatchObject({
      success: true,
      login: { id: WORK, label: "Day job" },
    });
    expect(sent()).toMatchObject({
      url: `https://controller.test/me/claude-code-logins/${WORK}`,
      method: "PATCH",
      body: { label: "Day job" },
    });

    answer(204);
    await expect(deleteClaudeCodeLogin(WORK)).resolves.toEqual({ success: true });
    expect(sent(1)).toMatchObject({ url: `https://controller.test/me/claude-code-logins/${WORK}`, method: "DELETE" });

    answer(404, { message: "Claude Code login not found", code: "not_found" });
    await expect(deleteClaudeCodeLogin(PERSONAL)).resolves.toMatchObject({ success: false, code: "not_found" });

    await expect(renameClaudeCodeLogin("../agents", "Work")).resolves.toMatchObject({ success: false });
    await expect(deleteClaudeCodeLogin("work")).resolves.toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("takes a name as the controller does: trimmed, 1 to 60 characters, on one line", () => {
    expect(normalizeClaudeCodeLoginLabel("  Work ")).toBe("Work");
    expect(normalizeClaudeCodeLoginLabel("x".repeat(60))).toBe("x".repeat(60));
    // Characters, not UTF-16 units.
    expect(normalizeClaudeCodeLoginLabel("😀".repeat(60))).toBe("😀".repeat(60));
    for (const label of ["", "   ", "x".repeat(61), "Work\nHome", "Work\u0007", "Work\u2028Home", "\u202eWork", 42, null]) {
      expect(normalizeClaudeCodeLoginLabel(label), String(label)).toBeNull();
    }
  });

  it("refuses what Desktop's consent dialog refuses in a name: a double quote and invisible characters", () => {
    for (const label of [
      // A right-to-left override, which can turn the dialog's words around.
      "Work \u202eemoH",
      // A zero-width space and a soft hyphen, invisible.
      "Work\u200bplan",
      "Work\u00adplan",
      // A double quote, which the dialog wraps the name in.
      'Work "plan"',
      // England's flag: a black flag and tag characters, a format character each.
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
      // A byte order mark inside the name, and a lone half of a surrogate pair.
      "Wo\ufeffrk",
      "Work\ud800",
    ]) {
      expect(normalizeClaudeCodeLoginLabel(label), JSON.stringify(label)).toBeNull();
    }
    // The joiners stay: an emoji joined by a zero-width joiner, and a name a
    // zero-width non-joiner parts, as Persian writes it.
    expect(normalizeClaudeCodeLoginLabel("Coding \u{1F469}\u200d\u{1F4BB}")).toBe("Coding \u{1F469}\u200d\u{1F4BB}");
    expect(normalizeClaudeCodeLoginLabel("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    );
    expect(normalizeClaudeCodeLoginLabel("Work 'plan'")).toBe("Work 'plan'");
  });
});

describe("an agent's Claude Code login", () => {
  it("reads the login an agent names only as a UUID, and none as null", async () => {
    const base = { handle: "reviewer", provider: "claude-code", avatarSeed: "hatchling:3" };
    answer(200, [
      { ...base, id: "agent-1", claudeCodeLoginId: WORK.toUpperCase() },
      { ...base, id: "agent-2", claudeCodeLoginId: null },
      { ...base, id: "agent-3", claudeCodeLoginId: "work" },
      { ...base, id: "agent-4" },
    ]);
    const result = await listMyAgents();
    expect(result.agents.map((agent) => agent.claudeCodeLoginId)).toEqual([WORK, null, null, null]);
  });
});
