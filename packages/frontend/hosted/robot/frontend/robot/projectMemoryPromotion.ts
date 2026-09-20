import type { LearnDraftPayload } from "./bridgeClient";

async function loadControllerClient() {
  return (
    await import(
      "@instafy/frontend/feature-api/controller"
    )
  ).controllerClient;
}

export const LEARNED_INDEX_PATH = ".agents/skills/instafy-learned/SKILL.md";
export const LEARNED_BLOCKS_PREFIX = ".agents/skills/instafy-learned/blocks/";
export const LEARNED_USAGE_PATH = ".agents/skills/instafy-learned/USAGE.json";
export const LEARNED_INDEX_MARKER = "<!-- /learn will keep this section short and updated. -->";

const LEARNED_USAGE_VERSION = 1;
const LEARNED_USAGE_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

const FALLBACK_LEARNED_INDEX_TEMPLATE = `# Learned memory blocks (index)

## Blocks (managed by /learn)

${LEARNED_INDEX_MARKER}
`;

export interface PromoteRobotLearnDraftResult {
  blockName: string;
  blockPath: string;
  indexPath: string;
  indexUpdated: boolean;
  usagePath: string;
  usageUpdated: boolean;
}

interface LearnedUsageEntry {
  uses: number;
  firstSeenMs: number;
  lastUsedMs: number | null;
}

interface LearnedUsageFile {
  version: number;
  updatedAtMs: number;
  blocks: Record<string, LearnedUsageEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeInlineText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[`]/g, "")
    .trim();
}

export function isLearnDraftPayload(value: unknown): value is LearnDraftPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const candidate =
    record.project_memory_candidate && typeof record.project_memory_candidate === "object"
      ? (record.project_memory_candidate as Record<string, unknown>)
      : null;

  return Boolean(
    typeof record.session_path === "string" &&
      typeof record.profile_path === "string" &&
      typeof record.robot_id === "string" &&
      candidate &&
      typeof candidate.suggested_block_path === "string" &&
      typeof candidate.markdown === "string" &&
      typeof candidate.title === "string",
  );
}

export function resolveLearnDraftBlockName(learnDraft: LearnDraftPayload): string | null {
  const suggestedPath = learnDraft.project_memory_candidate.suggested_block_path.trim();
  const match = suggestedPath.match(
    /^\.agents\/skills\/instafy-learned\/blocks\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/i,
  );
  return match?.[1] ?? null;
}

export function buildLearnedIndexBullet(learnDraft: LearnDraftPayload, blockName: string) {
  const title = normalizeInlineText(learnDraft.project_memory_candidate.title);
  const summary = title.length > 0 ? title : normalizeInlineText(blockName.replace(/-/g, " "));
  return `- [\`${blockName}\`](blocks/${blockName}/SKILL.md): ${summary}`;
}

export function upsertLearnedIndexContent(indexContent: string, learnDraft: LearnDraftPayload): string {
  const blockName = resolveLearnDraftBlockName(learnDraft);
  if (!blockName) {
    throw new Error("Robot learn draft does not point at a valid learned block path.");
  }

  const bullet = buildLearnedIndexBullet(learnDraft, blockName);
  const blockLink = `(blocks/${blockName}/SKILL.md)`;
  const baseContent = indexContent.trim().length > 0 ? indexContent : FALLBACK_LEARNED_INDEX_TEMPLATE;
  const lines = baseContent.split(/\r?\n/);

  let replacedExistingLine = false;
  const nextLines = lines.map((line) => {
    if (line.includes(blockLink) && line.trimStart().startsWith("- ")) {
      replacedExistingLine = true;
      return bullet;
    }
    return line;
  });

  if (replacedExistingLine) {
    return `${nextLines.join("\n").replace(/\s+$/, "")}\n`;
  }

  const markerIndex = nextLines.findIndex((line) => line.includes(LEARNED_INDEX_MARKER));
  if (markerIndex >= 0) {
    const insertAt = markerIndex + 1;
    const linesWithBullet = [...nextLines];
    if (linesWithBullet[insertAt]?.trim().length !== 0) {
      linesWithBullet.splice(insertAt, 0, "");
    }
    linesWithBullet.splice(insertAt + 1, 0, bullet);
    return `${linesWithBullet.join("\n").replace(/\s+$/, "")}\n`;
  }

  const appended = `${baseContent.replace(/\s+$/, "")}\n\n## Blocks (managed by /learn)\n\n${LEARNED_INDEX_MARKER}\n\n${bullet}\n`;
  return appended;
}

function normalizeUsageEntry(value: unknown): LearnedUsageEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const uses = Number.isFinite(value.uses) ? Math.max(0, Math.trunc(Number(value.uses))) : 0;
  const firstSeenMs = Number.isFinite(value.firstSeenMs)
    ? Math.max(0, Math.trunc(Number(value.firstSeenMs)))
    : 0;
  const lastUsedMs =
    value.lastUsedMs == null
      ? null
      : Number.isFinite(value.lastUsedMs)
        ? Math.max(0, Math.trunc(Number(value.lastUsedMs)))
        : null;

  return {
    uses,
    firstSeenMs,
    lastUsedMs,
  };
}

function parseLearnedUsageContent(usageContent: string): LearnedUsageFile {
  if (usageContent.trim().length === 0) {
    return {
      version: LEARNED_USAGE_VERSION,
      updatedAtMs: 0,
      blocks: {},
    };
  }

  try {
    const parsed = JSON.parse(usageContent) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("invalid learned usage payload");
    }

    const blocksRecord = isRecord(parsed.blocks) ? parsed.blocks : {};
    const blocks = Object.fromEntries(
      Object.entries(blocksRecord)
        .map(([name, entry]) => [name, normalizeUsageEntry(entry)] as const)
        .filter((entry): entry is [string, LearnedUsageEntry] => entry[1] !== null),
    );

    return {
      version: Number.isFinite(parsed.version) ? Math.max(0, Math.trunc(Number(parsed.version))) : 0,
      updatedAtMs: Number.isFinite(parsed.updatedAtMs)
        ? Math.max(0, Math.trunc(Number(parsed.updatedAtMs)))
        : 0,
      blocks,
    };
  } catch {
    return {
      version: LEARNED_USAGE_VERSION,
      updatedAtMs: 0,
      blocks: {},
    };
  }
}

export function upsertLearnedUsageContent(
  usageContent: string,
  blockName: string,
  nowMs = Date.now(),
): string {
  const trimmedBlockName = blockName.trim();
  if (!trimmedBlockName) {
    throw new Error("A learned block name is required before updating usage.");
  }

  const usage = parseLearnedUsageContent(usageContent);
  const existing = usage.blocks[trimmedBlockName] ?? {
    uses: 0,
    firstSeenMs: nowMs,
    lastUsedMs: null,
  };

  const shouldBump =
    existing.lastUsedMs == null || nowMs - existing.lastUsedMs > LEARNED_USAGE_DEDUP_WINDOW_MS;

  usage.blocks[trimmedBlockName] = {
    uses: shouldBump ? existing.uses + 1 : existing.uses,
    firstSeenMs: existing.firstSeenMs || nowMs,
    lastUsedMs: nowMs,
  };
  usage.version = usage.version > 0 ? usage.version : LEARNED_USAGE_VERSION;
  usage.updatedAtMs = nowMs;

  return `${JSON.stringify(usage, null, 2)}\n`;
}

export async function promoteRobotLearnDraftToProjectMemory(options: {
  projectId: string;
  learnDraft: LearnDraftPayload;
  runtimeId?: string | null;
}): Promise<PromoteRobotLearnDraftResult> {
  const projectId = options.projectId.trim();
  if (!projectId) {
    throw new Error("A project is required before saving robot learning to project memory.");
  }
  const controllerClient = await loadControllerClient();

  const blockName = resolveLearnDraftBlockName(options.learnDraft);
  if (!blockName) {
    throw new Error("Robot learn draft does not point at a valid learned block path.");
  }

  const blockPath = options.learnDraft.project_memory_candidate.suggested_block_path.trim();
  const runtimeId = options.runtimeId ?? null;

  await controllerClient.projects.bootstrapMemory({ projectId }).catch(() => null);

  const blockWrite = await controllerClient.workspace.files.write({
    projectId,
    path: blockPath,
    content: options.learnDraft.project_memory_candidate.markdown,
    runtimeId,
  });
  if (!blockWrite?.ok) {
    throw new Error(`Unable to write ${blockPath}.`);
  }

  const existingIndexFile = await controllerClient.workspace.files.read({
    projectId,
    path: LEARNED_INDEX_PATH,
    runtimeId,
  });
  const existingIndexContent =
    typeof existingIndexFile?.contentText === "string" ? existingIndexFile.contentText : "";
  const nextIndexContent = upsertLearnedIndexContent(existingIndexContent, options.learnDraft);
  const indexUpdated = nextIndexContent !== existingIndexContent;

  if (indexUpdated) {
    const indexWrite = await controllerClient.workspace.files.write({
      projectId,
      path: LEARNED_INDEX_PATH,
      content: nextIndexContent,
      runtimeId,
    });
    if (!indexWrite?.ok) {
      throw new Error(`Unable to update ${LEARNED_INDEX_PATH}.`);
    }
  }

  const existingUsageFile = await controllerClient.workspace.files.read({
    projectId,
    path: LEARNED_USAGE_PATH,
    runtimeId,
  });
  const existingUsageContent =
    typeof existingUsageFile?.contentText === "string" ? existingUsageFile.contentText : "";
  const nextUsageContent = upsertLearnedUsageContent(existingUsageContent, blockName);
  const usageUpdated = nextUsageContent !== existingUsageContent;

  if (usageUpdated) {
    const usageWrite = await controllerClient.workspace.files.write({
      projectId,
      path: LEARNED_USAGE_PATH,
      content: nextUsageContent,
      runtimeId,
    });
    if (!usageWrite?.ok) {
      throw new Error(`Unable to update ${LEARNED_USAGE_PATH}.`);
    }
  }

  return {
    blockName,
    blockPath,
    indexPath: LEARNED_INDEX_PATH,
    indexUpdated,
    usagePath: LEARNED_USAGE_PATH,
    usageUpdated,
  };
}
