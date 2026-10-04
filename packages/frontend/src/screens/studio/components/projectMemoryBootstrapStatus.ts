import type { ControllerProjectMemoryBootstrapResult } from "../../../services/runtimeController/projects";
import type { StatusIntent } from "../../../status/StatusProvider";

/** Which manual action asked for the project memory bootstrap. */
export type ProjectMemoryBootstrapAction = "refresh-defaults" | "install-default-skills";

export interface ProjectMemoryBootstrapStatus {
  message: string;
  intent: StatusIntent;
  duration: number;
  /** New files were committed, so open views should reload. */
  committed: boolean;
}

/**
 * The status to show for a bootstrap the user started from Settings or
 * Skills, or `null` for an outcome that should be reported as an error.
 *
 * `conflict` means the space kept changing while the controller wrote, so the
 * changed files were left as they are: a completed outcome, not a failure.
 */
export function describeProjectMemoryBootstrapResult(
  result: ControllerProjectMemoryBootstrapResult,
  action: ProjectMemoryBootstrapAction,
): ProjectMemoryBootstrapStatus | null {
  const skills = action === "install-default-skills";
  if (result.seeded) {
    const count = result.fileCount;
    return {
      message: skills
        ? `Installed ${count} default ${count === 1 ? "skill" : "skills"}.`
        : `Defaults refreshed${count > 0 ? ` (${count} ${count === 1 ? "file" : "files"})` : ""}.`,
      intent: "success",
      duration: skills ? 3000 : 3500,
      committed: true,
    };
  }
  switch (result.reason) {
    case "already-present":
      return {
        message: skills ? "Default skills are already installed." : "No default files changed.",
        intent: "info",
        duration: 3000,
        committed: false,
      };
    case "conflict":
      return {
        message: skills
          ? "Some default skills were left as they are because they changed in the meantime."
          : "Some default files were left as they are because they changed in the meantime.",
        intent: "info",
        duration: 4000,
        committed: false,
      };
    case "workspace-busy":
      return {
        message: "Workspace is busy. Retry in a moment.",
        intent: "warning",
        duration: 3500,
        committed: false,
      };
    case "no-origin":
      return skills
        ? null
        : {
            message: "Start or connect a runtime before refreshing defaults.",
            intent: "warning",
            duration: 3500,
            committed: false,
          };
    default:
      return null;
  }
}
