import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type ControllerSkillDiscoverLane,
  type ControllerSkillDiscoveryItem,
} from "../../../sdk/instafy";

type SkillsDiscoverLaneFilter = "all" | ControllerSkillDiscoverLane;
type SkillsDiscoverySort = "relevance" | "stars_desc" | "name_asc";

type SkillsDiscoverySkill = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  status: "enabled" | "disabled";
  directoryPath: string;
  filePath: string;
  enabledPath: string;
  disabledPath: string;
};

type DiscoverySourceMeta = {
  label: string;
  faviconUrl: string | null;
};

type UseSkillsDiscoveryStateParams = {
  activeProjectId: string | null | undefined;
  skills: SkillsDiscoverySkill[];
  discoveryResultLimit: number;
  defaultDiscoveryQuery: string;
  activateDiscoverTab: () => void;
  normalizeCategory: (value: string) => string;
  sanitizeCategoryLabel: (value: string) => string;
  resolveDiscoveredSkillSlug: (discovered: ControllerSkillDiscoveryItem) => string | null;
  normalizeSkillName: (value: string) => string;
  resolveDiscoverySourceMeta: (discovered: ControllerSkillDiscoveryItem) => DiscoverySourceMeta;
};

export function useSkillsDiscoveryState({
  activeProjectId,
  skills,
  discoveryResultLimit,
  defaultDiscoveryQuery,
  activateDiscoverTab,
  normalizeCategory,
  sanitizeCategoryLabel,
  resolveDiscoveredSkillSlug,
  normalizeSkillName,
  resolveDiscoverySourceMeta,
}: UseSkillsDiscoveryStateParams) {
  const [brokenDiscoverySourceIcons, setBrokenDiscoverySourceIcons] = useState<Record<string, true>>({});
  const [discoveryQuery, setDiscoveryQuery] = useState(defaultDiscoveryQuery);
  const [discoveryLaneFilter, setDiscoveryLaneFilter] = useState<SkillsDiscoverLaneFilter>("all");
  const [discoveryCategoryFilter, setDiscoveryCategoryFilter] = useState<string>("all");
  const [discoverySort, setDiscoverySort] = useState<SkillsDiscoverySort>("relevance");
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [discoveryResults, setDiscoveryResults] = useState<ControllerSkillDiscoveryItem[]>([]);
  const [discoveryLaneCounts, setDiscoveryLaneCounts] = useState<{
    curated: number;
    registry: number;
    longTail: number;
  }>({ curated: 0, registry: 0, longTail: 0 });
  const [discoveryCuratedCategories, setDiscoveryCuratedCategories] = useState<
    Array<{ name: string; count: number }>
  >([]);

  const discoveryVersionRef = useRef(0);

  const runDiscoverySearch = useCallback(
    async (options?: { query?: string }) => {
      const projectId = activeProjectId?.trim() ?? "";
      if (!projectId) {
        setDiscoveryResults([]);
        setDiscoveryLaneCounts({ curated: 0, registry: 0, longTail: 0 });
        setDiscoveryCuratedCategories([]);
        setDiscoveryWarnings([]);
        setDiscoveryError(null);
        setDiscoveryLoading(false);
        return;
      }

      const query = (options?.query ?? discoveryQuery).trim();

      const requestVersion = discoveryVersionRef.current + 1;
      discoveryVersionRef.current = requestVersion;
      setDiscoveryLoading(true);
      setDiscoveryError(null);

      try {
        const response = await controllerClient.skills.discover({
          projectId,
          query,
          limit: discoveryResultLimit,
        });

        if (discoveryVersionRef.current !== requestVersion) {
          return;
        }

        if (!response.success) {
          throw new Error(response.error ?? "Skill discovery failed.");
        }

        const sanitizedResults = response.results.map((item) => {
          const rawCategory = typeof item.category === "string" ? item.category : "";
          const sanitizedCategory = sanitizeCategoryLabel(rawCategory);
          return {
            ...item,
            category: sanitizedCategory.length > 0 ? sanitizedCategory : null,
          };
        });

        const mergedCategories = new Map<string, number>();
        for (const entry of response.curatedCategories) {
          const sanitizedName = sanitizeCategoryLabel(entry.name);
          const categoryName = sanitizedName.length > 0 ? sanitizedName : "Other";
          const safeCount = Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
          mergedCategories.set(categoryName, (mergedCategories.get(categoryName) ?? 0) + safeCount);
        }
        const sanitizedCuratedCategories = Array.from(mergedCategories.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

        setDiscoveryResults(sanitizedResults);
        setDiscoveryLaneCounts(response.laneCounts);
        setDiscoveryCuratedCategories(sanitizedCuratedCategories);
        setDiscoveryWarnings(response.warnings);
        setDiscoveryError(null);
      } catch (discoverySearchError) {
        if (discoveryVersionRef.current !== requestVersion) {
          return;
        }
        const message =
          discoverySearchError instanceof Error ? discoverySearchError.message : "Skill discovery failed.";
        setDiscoveryResults([]);
        setDiscoveryLaneCounts({ curated: 0, registry: 0, longTail: 0 });
        setDiscoveryCuratedCategories([]);
        setDiscoveryWarnings([]);
        setDiscoveryError(message);
      } finally {
        if (discoveryVersionRef.current === requestVersion) {
          setDiscoveryLoading(false);
        }
      }
    },
    [activeProjectId, discoveryQuery, discoveryResultLimit, sanitizeCategoryLabel],
  );

  useEffect(() => {
    if (!activeProjectId || !activeProjectId.trim()) {
      return;
    }

    if (typeof window === "undefined") {
      void runDiscoverySearch();
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void runDiscoverySearch();
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeProjectId, runDiscoverySearch]);

  const handleDiscoverySearchSubmit = useCallback(() => {
    activateDiscoverTab();
    void runDiscoverySearch({ query: discoveryQuery });
  }, [activateDiscoverTab, discoveryQuery, runDiscoverySearch]);

  const handleDiscoveryLaneChange = useCallback((lane: SkillsDiscoverLaneFilter) => {
    setDiscoveryLaneFilter(lane);
    if (lane !== "curated") {
      setDiscoveryCategoryFilter("all");
    }
  }, []);

  const handleDiscoveryCategoryFilterChange = useCallback(
    (value: string) => {
      if (value === "all") {
        setDiscoveryCategoryFilter("all");
        return;
      }
      setDiscoveryLaneFilter("curated");
      setDiscoveryCategoryFilter(value);
    },
    [],
  );

  useEffect(() => {
    if (discoveryCategoryFilter === "all") {
      return;
    }
    const selectedExists = discoveryCuratedCategories.some(
      (entry) => normalizeCategory(entry.name) === discoveryCategoryFilter,
    );
    if (!selectedExists) {
      setDiscoveryCategoryFilter("all");
    }
  }, [discoveryCategoryFilter, discoveryCuratedCategories, normalizeCategory]);

  const totalDiscoveryCount =
    discoveryLaneCounts.curated + discoveryLaneCounts.registry + discoveryLaneCounts.longTail;

  const filteredDiscoveryResults = useMemo(
    () =>
      discoveryResults.filter((item) => {
        if (discoveryLaneFilter !== "all" && item.lane !== discoveryLaneFilter) {
          return false;
        }
        if (discoveryCategoryFilter !== "all") {
          if (item.lane !== "curated") {
            return false;
          }
          const category = normalizeCategory(item.category ?? "Other");
          return category === discoveryCategoryFilter;
        }
        return true;
      }),
    [discoveryCategoryFilter, discoveryLaneFilter, discoveryResults, normalizeCategory],
  );

  const sortedDiscoveryResults = useMemo(() => {
    if (filteredDiscoveryResults.length <= 1) {
      return filteredDiscoveryResults;
    }
    if (discoverySort === "relevance") {
      return filteredDiscoveryResults;
    }

    const sorted = [...filteredDiscoveryResults];
    if (discoverySort === "stars_desc") {
      sorted.sort((left, right) => {
        const leftStars = typeof left.stars === "number" ? left.stars : -1;
        const rightStars = typeof right.stars === "number" ? right.stars : -1;
        if (leftStars !== rightStars) {
          return rightStars - leftStars;
        }
        return left.title.localeCompare(right.title);
      });
      return sorted;
    }

    sorted.sort((left, right) => {
      const titleCompare = left.title.localeCompare(right.title);
      if (titleCompare !== 0) {
        return titleCompare;
      }
      const leftStars = typeof left.stars === "number" ? left.stars : -1;
      const rightStars = typeof right.stars === "number" ? right.stars : -1;
      return rightStars - leftStars;
    });
    return sorted;
  }, [discoverySort, filteredDiscoveryResults]);

  const discoveryCategoryOptions = useMemo(
    () =>
      discoveryCuratedCategories.map((entry) => ({
        ...entry,
        normalizedValue: normalizeCategory(entry.name),
      })),
    [discoveryCuratedCategories, normalizeCategory],
  );

  const preparedDiscoveryResults = useMemo(
    () =>
      sortedDiscoveryResults.map((discovered) => {
        const discoveredSlug = resolveDiscoveredSkillSlug(discovered);
        const existingSkill =
          discoveredSlug != null
            ? skills.find((skill) => normalizeSkillName(skill.slug) === discoveredSlug) ?? null
            : null;
        const sourceMeta = resolveDiscoverySourceMeta(discovered);
        const faviconKey = sourceMeta.faviconUrl ?? "";
        return {
          discovered,
          existingSkill,
          sourceLabel: sourceMeta.label,
          sourceFaviconUrl: sourceMeta.faviconUrl,
          faviconKey,
          showSourceFavicon:
            sourceMeta.faviconUrl != null &&
            sourceMeta.faviconUrl.length > 0 &&
            brokenDiscoverySourceIcons[faviconKey] !== true,
        };
      }),
    [
      brokenDiscoverySourceIcons,
      normalizeSkillName,
      resolveDiscoveredSkillSlug,
      resolveDiscoverySourceMeta,
      skills,
      sortedDiscoveryResults,
    ],
  );

  const markDiscoverySourceIconBroken = useCallback((faviconKey: string) => {
    setBrokenDiscoverySourceIcons((current) => {
      if (current[faviconKey]) {
        return current;
      }
      return { ...current, [faviconKey]: true };
    });
  }, []);

  return {
    discoveryQuery,
    setDiscoveryQuery,
    discoveryLaneFilter,
    discoveryCategoryFilter,
    discoverySort,
    discoveryLoading,
    discoveryError,
    discoveryWarnings,
    discoveryLaneCounts,
    totalDiscoveryCount,
    discoveryCategoryOptions,
    preparedDiscoveryResults,
    setDiscoverySort,
    handleDiscoverySearchSubmit,
    handleDiscoveryLaneChange,
    handleDiscoveryCategoryFilterChange,
    markDiscoverySourceIconBroken,
    runDiscoverySearch,
  };
}
