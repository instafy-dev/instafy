import { useCallback, useEffect, useRef, useState } from "react";
import { controllerClient } from "../../../sdk/instafy";

const SKILLS_ROOT_PATH = ".agents/skills";
const EMPTY_NAMES: ReadonlySet<string> = new Set();

// Names of the folders under .agents/skills, loaded once per project/runtime
// and on refresh(). A null listing or an error yields an empty set, so tiles
// simply show no Connected badge. It does not poll.
export function useInstalledSkillNames({
  projectId,
  runtimeId,
}: {
  projectId: string | null;
  runtimeId: string | null;
}): { names: ReadonlySet<string>; refresh: () => Promise<void> } {
  const [names, setNames] = useState<ReadonlySet<string>>(EMPTY_NAMES);
  const loadVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const trimmedProjectId = (projectId ?? "").trim();
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    if (!trimmedProjectId) {
      setNames(EMPTY_NAMES);
      return;
    }
    try {
      const entries = await controllerClient.workspace.files.list({
        projectId: trimmedProjectId,
        path: SKILLS_ROOT_PATH,
        runtimeId,
      });
      if (loadVersionRef.current !== version) {
        return;
      }
      if (!entries) {
        setNames(EMPTY_NAMES);
        return;
      }
      setNames(
        new Set(
          entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name),
        ),
      );
    } catch {
      if (loadVersionRef.current === version) {
        setNames(EMPTY_NAMES);
      }
    }
  }, [projectId, runtimeId]);

  useEffect(() => {
    void refresh();
    return () => {
      // Invalidate in-flight loads so a stale project cannot land after a switch.
      loadVersionRef.current += 1;
    };
  }, [refresh]);

  return { names, refresh };
}
