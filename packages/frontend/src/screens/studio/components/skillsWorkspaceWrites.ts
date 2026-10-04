import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import type { FilesVersioning } from "./filesVersioning";
import { describeSaveFailure, SAVE_COPY } from "./workspaceSaveCopy";

/**
 * Skills writes in the stateless and desktop modes: each change is one
 * manifest, so it is one version (plan 6b). Reads use the same pinned
 * default origin, so the list shows what was just saved.
 */

export type SkillWriteResult = { ok: true } | { ok: false; message: string };

/** Read access for the Skills panel: legacy keeps today's runtime-first calls. */
export interface SkillsWorkspaceReads {
  list: (projectId: string, path: string) => Promise<ControllerWorkspaceEntry[] | null>;
  readText: (projectId: string, path: string) => Promise<string | null>;
  rawUrl: (projectId: string, path: string) => Promise<string | null>;
}

export function skillsWorkspaceReads(
  versioning: FilesVersioning,
  versioned: boolean,
  runtimeId: string | null,
): SkillsWorkspaceReads {
  if (!versioned) {
    return {
      list: (projectId, path) => controllerClient.workspace.files.list({ projectId, path, runtimeId }),
      readText: async (projectId, path) =>
        (await controllerClient.workspace.files.read({ projectId, path, runtimeId }))?.contentText ?? null,
      rawUrl: (projectId, path) => controllerClient.workspace.files.getRawUrl({ projectId, path, runtimeId }),
    };
  }
  const originId = versioning.originId;
  return {
    list: async (projectId, path) => {
      const listing = await controllerClient.workspace.files.listAt({ projectId, path, routing: "default", originId });
      return listing?.ok ? listing.entries : null;
    },
    readText: async (projectId, path) => {
      const read = await controllerClient.workspace.files.readAt({ projectId, path, routing: "default", originId });
      return read?.ok ? read.file.contentText : null;
    },
    rawUrl: (projectId, path) =>
      controllerClient.workspace.files.getRawUrl({ projectId, path, routing: "default", originId }),
  };
}

/**
 * Turn a skill on or off: write the target file and delete the source in one
 * manifest. On the stateless gateway it carries the read's rev as `baseRev`;
 * the source's blob is sent as `expected` when the origin reports it.
 */
export async function toggleSkillAsVersion(params: {
  projectId: string;
  versioning: FilesVersioning;
  sourcePath: string;
  targetPath: string;
  enabled: boolean;
  slug: string;
  title: string;
}): Promise<SkillWriteResult> {
  const { projectId, versioning, sourcePath, targetPath, enabled, slug, title } = params;
  const read = await controllerClient.workspace.files.readAt({
    projectId,
    path: sourcePath,
    routing: "default",
    originId: versioning.originId,
  });
  if (!read?.ok || read.file.contentText == null) {
    return { ok: false, message: `Unable to read ${sourcePath}.` };
  }
  const baseRev = versioning.mode === "stateless" ? read.file.rev ?? null : null;
  if (versioning.mode === "stateless" && !baseRev) {
    return { ok: false, message: SAVE_COPY.deleteRequiresBaseRev };
  }
  const result = await controllerClient.workspace.save.changes({
    projectId,
    originId: read.file.originId ?? versioning.originId,
    files: [{ path: targetPath, content: read.file.contentText, encoding: "utf8" }],
    deletes: [sourcePath],
    ...(baseRev ? { baseRev } : {}),
    ...(read.file.blobOid ? { expected: { [sourcePath]: read.file.blobOid } } : {}),
    commitMessage: `${enabled ? "Turn on" : "Turn off"} skill ${slug}`,
  });
  if (!result.ok) {
    return {
      ok: false,
      message: describeSaveFailure({ error: result.error, mode: versioning.mode, label: title, operation: "update" })
        .message,
    };
  }
  return { ok: true };
}

/**
 * Uninstall a skill: delete its folder in one manifest. On the stateless
 * gateway a folder delete needs the listing's rev as `baseRev`, so files
 * added after that listing survive.
 */
export async function uninstallSkillAsVersion(params: {
  projectId: string;
  versioning: FilesVersioning;
  directoryPath: string;
  slug: string;
  title: string;
}): Promise<SkillWriteResult> {
  const { projectId, versioning, directoryPath, slug, title } = params;
  let baseRev: string | null = null;
  if (versioning.mode === "stateless") {
    const listing = await controllerClient.workspace.files.listAt({
      projectId,
      path: directoryPath,
      routing: "default",
      originId: versioning.originId,
    });
    baseRev = listing?.ok ? listing.rev : null;
    if (!baseRev) {
      return { ok: false, message: SAVE_COPY.deleteRequiresBaseRev };
    }
  }
  const result = await controllerClient.workspace.save.changes({
    projectId,
    originId: versioning.originId,
    deletes: [directoryPath],
    ...(baseRev ? { baseRev } : {}),
    commitMessage: `Remove skill ${slug}`,
  });
  if (!result.ok) {
    return {
      ok: false,
      message: describeSaveFailure({ error: result.error, mode: versioning.mode, label: title, operation: "delete" })
        .message,
    };
  }
  return { ok: true };
}
