import { createHash } from "node:crypto";

import { listWorkspaceEntries, readWorkspaceFileText } from "../utils/harness.js";

export type LearnedBlockSize = {
  dir: string;
  skillPath: string;
  detailsPath: string;
  skillBytes: number | null;
  detailsBytes: number | null;
  skillHash: string | null;
  detailsHash: string | null;
};

export type LearnRoutingSnapshot = {
  collectedAt: string;
  agentsMdBytes: number | null;
  agentsMdHash: string | null;
  instafyMdBytes: number | null;
  instafyMdHash: string | null;
  learnedIndexBytes: number | null;
  learnedIndexHash: string | null;
  learnedUsageBytes: number | null;
  learnedUsageHash: string | null;
  learnedBlocks: LearnedBlockSize[];
  learnedBlockCount: number;
  learnedBlockTotalBytes: number | null;
};

function bytesFor(text: string | null): number | null {
  if (text === null) return null;
  return Buffer.byteLength(text, "utf8");
}

function hashFor(text: string | null): string | null {
  if (text === null) return null;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sumNullable(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0);
}

export async function collectLearnRoutingSnapshot(
  page: any,
  projectId: string,
  options?: { maxBlocks?: number },
): Promise<LearnRoutingSnapshot> {
  const maxBlocks = Math.max(1, Math.min(80, options?.maxBlocks ?? 40));
  const collectedAt = new Date().toISOString();

  const agents = await readWorkspaceFileText(page, "AGENTS.md", { projectId }).catch(() => null);
  const instafy = await readWorkspaceFileText(page, "INSTAFY.md", { projectId }).catch(() => null);
  const learnedIndex = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/SKILL.md", { projectId }).catch(() => null);
  const learnedUsage = await readWorkspaceFileText(page, ".agents/skills/instafy-learned/USAGE.json", { projectId }).catch(() => null);

  const blocksRoot = ".agents/skills/instafy-learned/blocks";
  const entries = await listWorkspaceEntries(page, blocksRoot, { projectId }).catch(() => null);
  const blockDirs = (entries ?? [])
    .filter((entry) => {
      const kind = (entry.kind ?? "").toLowerCase();
      if (kind === "file") return false;
      return true;
    })
    .map((entry) => entry.path)
    .filter((value) => value && value.startsWith(blocksRoot));

  blockDirs.sort((a, b) => a.localeCompare(b));
  const limited = blockDirs.slice(0, maxBlocks);
  const learnedBlocks: LearnedBlockSize[] = [];
  for (const dir of limited) {
    const skillPath = `${dir}/SKILL.md`;
    const detailsPath = `${dir}/DETAILS.md`;
    const skill = await readWorkspaceFileText(page, skillPath, { projectId }).catch(() => null);
    const details = await readWorkspaceFileText(page, detailsPath, { projectId }).catch(() => null);
    learnedBlocks.push({
      dir,
      skillPath,
      detailsPath,
      skillBytes: bytesFor(skill),
      detailsBytes: bytesFor(details),
      skillHash: hashFor(skill),
      detailsHash: hashFor(details),
    });
  }

  const learnedBlockTotalBytes = sumNullable(
    learnedBlocks.flatMap((entry) => [entry.skillBytes, entry.detailsBytes]),
  );

  return {
    collectedAt,
    agentsMdBytes: bytesFor(agents),
    agentsMdHash: hashFor(agents),
    instafyMdBytes: bytesFor(instafy),
    instafyMdHash: hashFor(instafy),
    learnedIndexBytes: bytesFor(learnedIndex),
    learnedIndexHash: hashFor(learnedIndex),
    learnedUsageBytes: bytesFor(learnedUsage),
    learnedUsageHash: hashFor(learnedUsage),
    learnedBlocks,
    learnedBlockCount: blockDirs.length,
    learnedBlockTotalBytes,
  };
}
