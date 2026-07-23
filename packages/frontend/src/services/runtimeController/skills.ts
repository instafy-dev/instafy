import {
  controllerBaseUrl,
  normalizeUuidParam,
  readControllerError,
  resolveControllerAccessToken,
  runtimeControllerEnabled,
} from "./core";

export type ControllerSkillDiscoverSource = "playbooks" | "github";
export type ControllerSkillDiscoverMode = "lexical" | "semantic";
export type ControllerSkillDiscoverLane = "curated" | "registry" | "long_tail";

export interface ControllerSkillDiscoveryItem {
  id: string;
  title: string;
  description: string;
  lane: ControllerSkillDiscoverLane | string;
  provenance: string;
  isInstallable: boolean;
  source: ControllerSkillDiscoverSource | string;
  sourceLabel: string;
  installSource?: string | null;
  suggestedName?: string | null;
  homepage?: string | null;
  repo?: string | null;
  language?: string | null;
  tags?: string[];
  isOfficial?: boolean | null;
  stars?: number | null;
  category?: string | null;
  risk?: string | null;
  healthGrade?: string | null;
  healthScore?: number | null;
}

export interface ControllerSkillDiscoveryLaneCounts {
  curated: number;
  registry: number;
  longTail: number;
}

export interface ControllerSkillDiscoveryCategoryCount {
  name: string;
  count: number;
}

export interface DiscoverControllerSkillsParams {
  projectId: string;
  query?: string;
  sources?: ControllerSkillDiscoverSource[];
  limit?: number;
  officialOnly?: boolean;
  language?: string | null;
  mode?: ControllerSkillDiscoverMode;
  accessToken?: string | null;
}

export interface DiscoverControllerSkillsResult {
  success: boolean;
  query: string;
  results: ControllerSkillDiscoveryItem[];
  laneCounts: ControllerSkillDiscoveryLaneCounts;
  curatedCategories: ControllerSkillDiscoveryCategoryCount[];
  warnings: string[];
  cached: boolean;
  error?: string;
}

export async function discoverControllerSkills(
  params: DiscoverControllerSkillsParams,
): Promise<DiscoverControllerSkillsResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return {
      success: false,
      query: params.query ?? "",
      results: [],
      laneCounts: { curated: 0, registry: 0, longTail: 0 },
      curatedCategories: [],
      warnings: [],
      cached: false,
      error: "Runtime controller is not configured.",
    };
  }

  const normalizedProjectId = normalizeUuidParam(params.projectId ?? null);
  if (!normalizedProjectId) {
    return {
      success: false,
      query: params.query ?? "",
      results: [],
      laneCounts: { curated: 0, registry: 0, longTail: 0 },
      curatedCategories: [],
      warnings: [],
      cached: false,
      error: "Invalid project id.",
    };
  }

  const normalizedQuery = (params.query ?? "").trim();

  const accessToken = await resolveControllerAccessToken(params.accessToken ?? null);
  if (!accessToken) {
    return {
      success: false,
      query: normalizedQuery,
      results: [],
      laneCounts: { curated: 0, registry: 0, longTail: 0 },
      curatedCategories: [],
      warnings: [],
      cached: false,
      error: "Missing controller session token.",
    };
  }

  const url = new URL(
    `${controllerBaseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/skills/discover`,
  );
  if (normalizedQuery.length > 0) {
    url.searchParams.set("q", normalizedQuery);
  }
  if (params.sources && params.sources.length > 0) {
    url.searchParams.set("sources", params.sources.join(","));
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    const clampedLimit = Math.min(40, Math.max(1, Math.floor(params.limit)));
    url.searchParams.set("limit", String(clampedLimit));
  }
  if (params.officialOnly) {
    url.searchParams.set("officialOnly", "true");
  }
  if (params.language && params.language.trim().length > 0) {
    url.searchParams.set("language", params.language.trim());
  }
  if (params.mode) {
    url.searchParams.set("mode", params.mode);
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      const message = await readControllerError(response, "skill discovery failed");
      return {
        success: false,
        query: normalizedQuery,
        results: [],
        laneCounts: { curated: 0, registry: 0, longTail: 0 },
        curatedCategories: [],
        warnings: [],
        cached: false,
        error: message,
      };
    }

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      query?: string;
      results?: ControllerSkillDiscoveryItem[];
      laneCounts?: ControllerSkillDiscoveryLaneCounts;
      curatedCategories?: ControllerSkillDiscoveryCategoryCount[];
      warnings?: string[];
      cached?: boolean;
    } | null;

    const laneCounts =
      payload?.laneCounts &&
      typeof payload.laneCounts.curated === "number" &&
      typeof payload.laneCounts.registry === "number" &&
      typeof payload.laneCounts.longTail === "number"
        ? payload.laneCounts
        : { curated: 0, registry: 0, longTail: 0 };

    return {
      success: payload?.success !== false,
      query:
        typeof payload?.query === "string" ? payload.query : normalizedQuery,
      results: Array.isArray(payload?.results) ? payload.results : [],
      laneCounts,
      curatedCategories: Array.isArray(payload?.curatedCategories)
        ? payload.curatedCategories
            .filter((item) => item && typeof item.name === "string" && typeof item.count === "number")
            .map((item) => ({ name: item.name, count: item.count }))
        : [],
      warnings: Array.isArray(payload?.warnings)
        ? payload.warnings.filter((warning) => typeof warning === "string")
        : [],
      cached: payload?.cached === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] discoverControllerSkills error:", message);
    return {
      success: false,
      query: normalizedQuery,
      results: [],
      laneCounts: { curated: 0, registry: 0, longTail: 0 },
      curatedCategories: [],
      warnings: [],
      cached: false,
      error: message,
    };
  }
}
