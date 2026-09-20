import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControllerWorkspaceEntry, ControllerOriginSummary, LocalWorkspacePresence } from "../../sdk/instafy";

export function getStudioWorkspaceOwnerKey({ effectiveRuntimeId, localWorkspace, desktopOrigin }: {
  effectiveRuntimeId: string | null;
  localWorkspace: LocalWorkspacePresence | null;
  desktopOrigin: ControllerOriginSummary | null;
}): string {
  return JSON.stringify([effectiveRuntimeId, localWorkspace?.deviceId, localWorkspace?.path, localWorkspace?.runtimeId,
    desktopOrigin?.originId, desktopOrigin?.runtimeId, desktopOrigin?.endpoint, desktopOrigin?.mode]);
}

export interface StudioKnownFile {
  projectId: string;
  path: string;
  fileId: string;
}

export interface StudioDirectoryListing {
  projectId: string;
  directory: string;
  entries: readonly Pick<ControllerWorkspaceEntry, "path" | "kind">[];
}

export type StudioDirectoryListingListener = (listing: StudioDirectoryListing) => void;

/** Directory responses contain workspace-relative paths, never host filesystem paths. */
export function isSafeStudioFilePath(path: string): boolean {
  return Boolean(path && !path.includes("\\") && !Array.from(path).some((character) => character.charCodeAt(0) < 32)
    && !path.startsWith("/") && !/^[a-z]:/i.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== ".."));
}

/** A metadata-only view of directories the user has already browsed in this workspace. */
export function useStudioKnownFiles(viewerUserId: string | null, projectId: string | null, workspaceOwnerKey: string) {
  // Object identity makes old callbacks invalid even after account/space/origin A → B → A.
  const scope = useMemo(() => ({ viewerUserId, projectId, workspaceOwnerKey }), [viewerUserId, projectId, workspaceOwnerKey]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  type Directories = Record<string, Array<Pick<ControllerWorkspaceEntry, "path" | "kind">>>;
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; directories: Directories }>({ scope, directories: {} });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setSnapshot((previous) => previous.scope === scope ? previous : { scope, directories: {} }); }, [scope]);

  const recordDirectory = useCallback<StudioDirectoryListingListener>((listing) => {
    if (!mounted.current || currentScope.current !== scope || !scope.viewerUserId
      || !scope.projectId || listing.projectId !== scope.projectId
      || (listing.directory !== "" && !isSafeStudioFilePath(listing.directory))) return;
    const entries = listing.entries.filter((entry) => isSafeStudioFilePath(entry.path)
      && entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === listing.directory)
      .map(({ path, kind }) => ({ path, kind }));
    setSnapshot((previous) => {
      if (!mounted.current || currentScope.current !== scope) return previous;
      // A late child response must not resurrect a folder a newer parent listing removed.
      if (previous.scope === scope && listing.directory) {
        let parent = "";
        for (const part of listing.directory.split("/")) {
          const child = parent ? `${parent}/${part}` : part;
          if (Object.hasOwn(previous.directories, parent)
            && !previous.directories[parent].some((entry) => entry.path === child && entry.kind === "directory")) return previous;
          parent = child;
        }
      }
      const directories = { ...(previous.scope === scope ? previous.directories : {}), [listing.directory]: entries };
      // A refreshed parent also removes cached descendants of deleted/moved folders.
      const children = new Set(entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path));
      const prefix = listing.directory ? `${listing.directory}/` : "";
      for (const directory of Object.keys(directories)) {
        if (directory === listing.directory || !directory.startsWith(prefix)) continue;
        const child = `${prefix}${directory.slice(prefix.length).split("/")[0]}`;
        if (!children.has(child)) delete directories[directory];
      }
      return { scope, directories };
    });
  }, [scope]);

  const files = useMemo<StudioKnownFile[]>(() => {
    if (snapshot.scope !== scope || !scope.viewerUserId || !scope.projectId) return [];
    const paths = new Set(Object.values(snapshot.directories).flatMap((entries) => entries
      .filter((entry) => entry.kind === "file").map((entry) => entry.path)));
    return [...paths].sort().map((path) => ({ projectId: scope.projectId!, path, fileId: path }));
  }, [scope, snapshot]);
  return { files, recordDirectory };
}
