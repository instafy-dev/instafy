import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFileStaleMergeRequest,
  MERGE_SNAPSHOT_INLINE_LIMIT,
} from "../workspaceFileStaleMerge";

const large = (seed: string) => seed.repeat(Math.ceil(MERGE_SNAPSHOT_INLINE_LIMIT / seed.length));

describe("buildWorkspaceFileStaleMergeRequest", () => {
  it("sends large versions as two attached text snapshots, never as workspace files", async () => {
    const notice = { path: "src/app/App.tsx", baseText: large("base\n"), localText: large("mine\n") };
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: true });

    expect(textFiles.map((file) => [file.name, file.type])).toEqual([
      ["App.tsx.base.txt", "text/plain"],
      ["App.tsx.local.txt", "text/plain"],
    ]);
    expect(await textFiles[0].text()).toBe(notice.baseText);
    expect(await textFiles[1].text()).toBe(notice.localText);
    expect(prompt).toContain("the attached file App.tsx.base.txt");
    expect(prompt).toContain("the attached file App.tsx.local.txt");
    expect(prompt).toContain("Read the two attached snapshot files.");
    expect(prompt).not.toContain("artifacts/instafy-merge");
    expect(prompt).not.toContain(notice.baseText);
  });

  it("keeps an empty base as an empty snapshot", async () => {
    const { textFiles } = buildWorkspaceFileStaleMergeRequest(
      { path: "notes.md", baseText: "", localText: `${large("new\n")}more` },
      { canAttachFiles: true },
    );
    expect(textFiles[0].size).toBe(0);
    expect(textFiles[0].name).toBe("notes.md.base.txt");
  });

  it("keeps small versions inline", () => {
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(
      { path: "src/lib.rs", baseText: "fn a() {}", localText: "fn b() {}" },
      { canAttachFiles: true },
    );
    expect(textFiles).toEqual([]);
    expect(prompt).toContain("```rust\nfn a() {}\n```");
    expect(prompt).toContain("```rust\nfn b() {}\n```");
  });

  it("keeps every size inline when this server can't store attachments", () => {
    const notice = { path: "README.md", baseText: large("a"), localText: large("b") };
    const { prompt, textFiles } = buildWorkspaceFileStaleMergeRequest(notice, { canAttachFiles: false });
    expect(textFiles).toEqual([]);
    expect(prompt).toContain(notice.localText);
  });
});
