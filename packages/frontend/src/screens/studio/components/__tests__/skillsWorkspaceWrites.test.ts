import { beforeEach, describe, expect, it, vi } from "vitest";
import { controllerClient } from "../../../../sdk/instafy";
import { skillsWorkspaceReads, toggleSkillAsVersion, uninstallSkillAsVersion } from "../skillsWorkspaceWrites";

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: { list: vi.fn(), listAt: vi.fn(), read: vi.fn(), readAt: vi.fn(), getRawUrl: vi.fn() },
      save: { changes: vi.fn() },
    },
  },
}));

const REV = "1".repeat(40);
const BLOB = "a".repeat(40);
const stateless = { mode: "stateless" as const, originId: "origin-1" };
const desktop = { mode: "desktop" as const, originId: "desk-1" };
const files = controllerClient.workspace.files;
const save = controllerClient.workspace.save;

function readOk(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    file: {
      path: "x", isText: true, contentText: "# Skill", contentBase64: "", size: 7, encoding: "base64",
      mimeType: "text/markdown", blobOid: BLOB, rev: REV, originId: "origin-1", originMode: "hosted", ...patch,
    },
  } as never;
}

describe("skills writes as versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(save.changes).mockResolvedValue({ ok: true } as never);
  });

  it("turns a skill on with one manifest: write the target, delete the source", async () => {
    vi.mocked(files.readAt).mockResolvedValue(readOk());
    const result = await toggleSkillAsVersion({
      projectId: "space-a", versioning: stateless, sourcePath: ".agents/skills/x/SKILL.md.disabled",
      targetPath: ".agents/skills/x/SKILL.md", enabled: true, slug: "x", title: "X",
    });
    expect(result).toEqual({ ok: true });
    expect(files.readAt).toHaveBeenCalledWith({
      projectId: "space-a", path: ".agents/skills/x/SKILL.md.disabled", routing: "default", originId: "origin-1",
    });
    expect(save.changes).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a",
      originId: "origin-1",
      files: [{ path: ".agents/skills/x/SKILL.md", content: "# Skill", encoding: "utf8" }],
      deletes: [".agents/skills/x/SKILL.md.disabled"],
      baseRev: REV,
      expected: { ".agents/skills/x/SKILL.md.disabled": BLOB },
      commitMessage: "Turn on skill x",
    });
    expect(files.read).not.toHaveBeenCalled();
  });

  it("sends no baseRev on a Desktop origin and maps a refusal to copy", async () => {
    vi.mocked(files.readAt).mockResolvedValue(readOk({ rev: null, blobOid: null, originId: "desk-1" }));
    vi.mocked(save.changes).mockResolvedValue({
      ok: false, stage: "apply", error: { status: 409, code: "main_busy", message: "", routeUnavailable: false },
    } as never);
    const result = await toggleSkillAsVersion({
      projectId: "space-a", versioning: desktop, sourcePath: "a/SKILL.md", targetPath: "a/SKILL.md.disabled",
      enabled: false, slug: "a", title: "A",
    });
    expect(save.changes).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", originId: "desk-1",
      files: [{ path: "a/SKILL.md.disabled", content: "# Skill", encoding: "utf8" }],
      deletes: ["a/SKILL.md"], commitMessage: "Turn off skill a",
    });
    expect(result).toEqual({ ok: false, message: "The space is busy saving other changes. Try again in a moment." });
  });

  it("refuses a stateless toggle whose read has no rev", async () => {
    vi.mocked(files.readAt).mockResolvedValue(readOk({ rev: null }));
    const result = await toggleSkillAsVersion({
      projectId: "space-a", versioning: stateless, sourcePath: "a", targetPath: "b", enabled: true, slug: "a", title: "A",
    });
    expect(result).toEqual({ ok: false, message: "Reload the folder and try again." });
    expect(save.changes).not.toHaveBeenCalled();
  });

  it("uninstalls with one folder delete on the listing's rev", async () => {
    vi.mocked(files.listAt).mockResolvedValue({ ok: true, entries: [], rev: REV, originId: "origin-1", originMode: "hosted" } as never);
    expect(await uninstallSkillAsVersion({
      projectId: "space-a", versioning: stateless, directoryPath: ".agents/skills/x", slug: "x", title: "X",
    })).toEqual({ ok: true });
    expect(save.changes).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", originId: "origin-1", deletes: [".agents/skills/x"], baseRev: REV, commitMessage: "Remove skill x",
    });
  });

  it("uninstalls on a Desktop origin without a listing", async () => {
    await uninstallSkillAsVersion({ projectId: "space-a", versioning: desktop, directoryPath: "s/x", slug: "x", title: "X" });
    expect(files.listAt).not.toHaveBeenCalled();
    expect(save.changes).toHaveBeenCalledExactlyOnceWith({
      projectId: "space-a", originId: "desk-1", deletes: ["s/x"], commitMessage: "Remove skill x",
    });
  });

  it("keeps today's runtime-first reads in legacy mode and pins reads otherwise", async () => {
    const legacy = skillsWorkspaceReads({ mode: "legacy", originId: "origin-1" }, false, "runtime-1");
    await legacy.list("space-a", ".agents/skills");
    await legacy.readText("space-a", "a/SKILL.md");
    await legacy.rawUrl("space-a", "a/icon.png");
    expect(files.list).toHaveBeenCalledWith({ projectId: "space-a", path: ".agents/skills", runtimeId: "runtime-1" });
    expect(files.read).toHaveBeenCalledWith({ projectId: "space-a", path: "a/SKILL.md", runtimeId: "runtime-1" });
    expect(files.getRawUrl).toHaveBeenCalledWith({ projectId: "space-a", path: "a/icon.png", runtimeId: "runtime-1" });

    vi.mocked(files.listAt).mockResolvedValue({ ok: true, entries: [], rev: REV, originId: "origin-1", originMode: "hosted" } as never);
    const pinned = skillsWorkspaceReads(stateless, true, "runtime-1");
    await pinned.list("space-a", ".agents/skills");
    expect(files.listAt).toHaveBeenCalledWith({
      projectId: "space-a", path: ".agents/skills", routing: "default", originId: "origin-1",
    });
  });
});
