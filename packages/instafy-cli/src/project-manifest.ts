import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProjectManifest {
  spaceId: string;
  orgId?: string | null;
  orgName?: string | null;
  controllerUrl?: string | null;
  createdAt?: string | null;
  profile?: string | null;
  tunnels?: Record<
    string,
    {
      purpose: string;
      hostname?: string | null;
      url?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    }
  >;
}

export function findProjectManifest(startDir: string): {
  manifest: ProjectManifest | null;
  path: string | null;
} {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, ".instafy", "space.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<ProjectManifest> & {
          spaceId?: string;
          space_id?: string;
        };
        const spaceId =
          typeof parsed?.spaceId === "string"
            ? parsed.spaceId.trim()
            : typeof parsed?.space_id === "string"
              ? parsed.space_id.trim()
              : "";
        if (spaceId) {
          return { manifest: { ...parsed, spaceId }, path: candidate };
        }
      } catch {
        // ignore malformed manifest
      }
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return { manifest: null, path: null };
}
