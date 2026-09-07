import { useId, useState } from "react";
import { ChatLines, Filter, NavArrowDown, NavArrowRight, Plus, Puzzle, Search } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { SearchInput } from "../../../components/SearchInput";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";
import type { ControllerSkillDiscoveryItem } from "../../../sdk/instafy";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

type SkillsDiscoveryInstalledSkill = {
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

type SkillsDiscoveryPreparedItem = {
  discovered: ControllerSkillDiscoveryItem;
  existingSkill: SkillsDiscoveryInstalledSkill | null;
  sourceLabel: string;
  sourceFaviconUrl: string | null;
  faviconKey: string;
  showSourceFavicon: boolean;
};

type SkillsDiscoveryCategoryOption = {
  name: string;
  count: number;
  normalizedValue: string;
};

type SkillsDiscoverySectionProps = {
  hasProject: boolean;
  discoveryQuery: string;
  onDiscoveryQueryChange: (value: string) => void;
  onDiscoverySearchSubmit: () => void;
  discoveryLaneFilter: string;
  onDiscoveryLaneFilterChange: (value: string) => void;
  discoveryCategoryFilter: string;
  onDiscoveryCategoryFilterChange: (value: string) => void;
  discoverySort: string;
  onDiscoverySortChange: (value: string) => void;
  discoveryLoading: boolean;
  discoveryError: string | null;
  discoveryWarnings: string[];
  totalDiscoveryCount: number;
  discoveryLaneCounts: {
    curated: number;
    registry: number;
    longTail: number;
  };
  discoveryCategoryOptions: SkillsDiscoveryCategoryOption[];
  preparedDiscoveryResults: SkillsDiscoveryPreparedItem[];
  importPending: boolean;
  togglePendingSkillId: string | null;
  onMarkDiscoverySourceIconBroken: (faviconKey: string) => void;
  onToggleExistingSkill: (skill: SkillsDiscoveryInstalledSkill, enabled: boolean) => void;
  onAskExistingSkill: (skill: SkillsDiscoveryInstalledSkill) => void;
  onOpenExistingSkill: (skill: SkillsDiscoveryInstalledSkill) => void;
  onDiscoveredSkillAction: (
    discovered: ControllerSkillDiscoveryItem,
    existingSkill: SkillsDiscoveryInstalledSkill | null,
  ) => void;
};

export function SkillsDiscoverySection({
  hasProject,
  discoveryQuery,
  onDiscoveryQueryChange,
  onDiscoverySearchSubmit,
  discoveryLaneFilter,
  onDiscoveryLaneFilterChange,
  discoveryCategoryFilter,
  onDiscoveryCategoryFilterChange,
  discoverySort,
  onDiscoverySortChange,
  discoveryLoading,
  discoveryError,
  discoveryWarnings,
  totalDiscoveryCount,
  discoveryLaneCounts,
  discoveryCategoryOptions,
  preparedDiscoveryResults,
  importPending,
  togglePendingSkillId,
  onMarkDiscoverySourceIconBroken,
  onToggleExistingSkill,
  onAskExistingSkill,
  onOpenExistingSkill,
  onDiscoveredSkillAction,
}: SkillsDiscoverySectionProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const filtersId = useId();
  const changedFilterCount = [
    discoveryLaneFilter !== "all",
    discoveryCategoryFilter !== "all",
    discoverySort !== "relevance",
  ].filter(Boolean).length;

  return (
    <Card tone="default" radius="2xl" className="space-y-4" data-testid="skills-discovery-card">
      <div className="space-y-1">
        <Text variant="bodyStrong" tone="primary">
          Discover
        </Text>
        <Text variant="caption" tone="muted">
          Curated picks, registries, and community GitHub skills in one place.
        </Text>
      </div>

      <div className="space-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              id="skills-discovery-query-input"
              label="Search skills"
              value={discoveryQuery}
              onChange={(event) => onDiscoveryQueryChange(event.target.value)}
              placeholder="Search skills…"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onDiscoverySearchSubmit();
                }
              }}
              inputTestId="skills-discovery-query"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            radius="xl"
            onPress={onDiscoverySearchSubmit}
            isDisabled={!hasProject || discoveryLoading}
            data-testid="skills-discovery-search"
            aria-label="Search skills"
            className="shrink-0"
          >
            {discoveryLoading ? (
              <Spinner tone="primary" size="sm" aria-hidden="true" />
            ) : (
              <Search className="h-4 w-4" aria-hidden="true" />
            )}
            Search
          </Button>
        </div>

        {!isLargeScreen ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              radius="lg"
              aria-expanded={filtersExpanded}
              aria-controls={filtersExpanded ? filtersId : undefined}
              onPress={() => setFiltersExpanded((expanded) => !expanded)}
              data-testid="skills-discovery-filters-toggle"
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              Filters{changedFilterCount > 0 ? ` (${changedFilterCount})` : ""}
              <NavArrowDown className={`h-4 w-4 transition-transform ${filtersExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
            </Button>
            {!discoveryError && !discoveryLoading ? (
              <Text variant="caption" tone="muted">
                {preparedDiscoveryResults.length} result{preparedDiscoveryResults.length === 1 ? "" : "s"}
              </Text>
            ) : null}
          </div>
        ) : null}

        {isLargeScreen || filtersExpanded ? (
          <div id={filtersId} className="grid gap-2 @min-[36rem]/settings-content:grid-cols-3" data-testid="skills-discovery-filters">
            <label className="min-w-0 space-y-1">
              <Text as="span" variant="caption" tone="muted">
                Source
              </Text>
              <Select
                value={discoveryLaneFilter}
                onChange={(event) => onDiscoveryLaneFilterChange(event.target.value)}
                disabled={!hasProject || discoveryLoading}
                tone="muted"
                data-testid="skills-discovery-source-select"
              >
                <option value="all">All ({totalDiscoveryCount})</option>
                <option value="curated">Curated ({discoveryLaneCounts.curated})</option>
                <option value="registry">Registry ({discoveryLaneCounts.registry})</option>
                <option value="long_tail">Community ({discoveryLaneCounts.longTail})</option>
              </Select>
            </label>

            <label className="min-w-0 space-y-1">
              <Text as="span" variant="caption" tone="muted">
                Category
              </Text>
              <Select
                value={discoveryCategoryFilter}
                onChange={(event) => onDiscoveryCategoryFilterChange(event.target.value)}
                disabled={!hasProject || discoveryLoading || discoveryCategoryOptions.length === 0}
                tone="muted"
                data-testid="skills-discovery-category-select"
              >
                <option value="all">All categories</option>
                {discoveryCategoryOptions.map((entry) => (
                  <option key={entry.name} value={entry.normalizedValue}>
                    {entry.name} ({entry.count})
                  </option>
                ))}
              </Select>
            </label>

            <label className="min-w-0 space-y-1">
              <Text as="span" variant="caption" tone="muted">
                Sort
              </Text>
              <Select
                value={discoverySort}
                onChange={(event) => onDiscoverySortChange(event.target.value)}
                disabled={!hasProject || discoveryLoading}
                tone="muted"
                data-testid="skills-discovery-sort-select"
              >
                <option value="relevance">Relevance</option>
                <option value="stars_desc">Stars</option>
                <option value="name_asc">Name (A-Z)</option>
              </Select>
            </label>
          </div>
        ) : null}
      </div>

      {discoveryLoading ? <LoadingStatus>Searching skills…</LoadingStatus> : null}

      {isLargeScreen && !discoveryError && !discoveryLoading ? (
        <Text variant="caption" tone="muted">
          {preparedDiscoveryResults.length} result{preparedDiscoveryResults.length === 1 ? "" : "s"}
        </Text>
      ) : null}

      {discoveryWarnings.length > 0 ? (
        <div className="space-y-1">
          {discoveryWarnings.slice(0, 3).map((warning) => (
            <Text key={warning} variant="caption" tone="muted">
              {warning}
            </Text>
          ))}
        </div>
      ) : null}

      {discoveryError ? (
        <Text variant="caption" tone="muted">
          {discoveryError}
        </Text>
      ) : null}

      {!discoveryError && !discoveryLoading && preparedDiscoveryResults.length === 0 ? (
        <Text variant="caption" tone="muted">
          No discovery results yet. Try a different search query.
        </Text>
      ) : null}

      {preparedDiscoveryResults.length > 0 ? (
        <div className="divide-y divide-slate-200 dark:divide-slate-800" data-testid="skills-discovery-list">
          {preparedDiscoveryResults.map(
            ({ discovered, existingSkill, sourceLabel, sourceFaviconUrl, faviconKey, showSourceFavicon }) => (
              <div
                key={discovered.id}
                className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                data-testid={`skills-discovery-item-${discovered.id}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <Puzzle className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Text variant="bodyStrong" tone="primary" className="truncate">
                        {discovered.title}
                      </Text>
                      {typeof discovered.stars === "number" ? (
                        <span className="inline-flex items-center whitespace-nowrap text-xs font-medium text-slate-500 dark:text-slate-400">
                          ★ {discovered.stars.toLocaleString()}
                        </span>
                      ) : null}
                    </div>
                    <Text variant="caption" tone="muted" className="line-clamp-2">
                      {discovered.description}
                    </Text>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                      {showSourceFavicon ? (
                        <img
                          src={sourceFaviconUrl ?? ""}
                          alt=""
                          className="h-3.5 w-3.5 rounded-sm object-cover"
                          loading="lazy"
                          onError={() => {
                            if (!faviconKey) {
                              return;
                            }
                            onMarkDiscoverySourceIconBroken(faviconKey);
                          }}
                        />
                      ) : null}
                      <span>{sourceLabel}</span>
                      {discovered.repo ? <span aria-hidden="true">·</span> : null}
                      {discovered.repo ? <span className="truncate">{discovered.repo}</span> : null}
                      {discovered.category ? <span aria-hidden="true">·</span> : null}
                      {discovered.category ? <span className="truncate">{discovered.category}</span> : null}
                    </div>
                  </div>
                </div>

                {existingSkill ? (
                  <div className="ml-2 flex shrink-0 items-center gap-1.5 pt-0.5">
                    <Toggle
                      size="sm"
                      aria-label={`Set ${existingSkill.title} active`}
                      isSelected={existingSkill.status === "enabled"}
                      onChange={(nextSelected) => onToggleExistingSkill(existingSkill, nextSelected)}
                      isDisabled={
                        !hasProject ||
                        (togglePendingSkillId !== null && togglePendingSkillId !== existingSkill.id)
                      }
                      data-testid={`skills-discovery-toggle-${discovered.id}`}
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      radius="full"
                      onPress={() => onAskExistingSkill(existingSkill)}
                      aria-label={`Ask how to use ${existingSkill.title}`}
                      title="Draft setup prompt in Assistant"
                      isDisabled={!hasProject || importPending}
                      data-testid={`skills-discovery-ask-${discovered.id}`}
                    >
                      <ChatLines className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      radius="full"
                      onPress={() => onOpenExistingSkill(existingSkill)}
                      aria-label={`Open ${existingSkill.title}`}
                      title="Open skill file"
                      isDisabled={!hasProject || importPending}
                      data-testid={`skills-discovery-open-${discovered.id}`}
                    >
                      <NavArrowRight className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                ) : (
                  <Button
                    variant={discovered.isInstallable ? "ghost" : "outline"}
                    size="sm"
                    radius="xl"
                    onPress={() => onDiscoveredSkillAction(discovered, existingSkill)}
                    isDisabled={!hasProject || importPending || !discovered.isInstallable}
                    data-testid={`skills-discovery-install-${discovered.id}`}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {discovered.isInstallable ? "Install" : "Not installable"}
                  </Button>
                )}
              </div>
            ),
          )}
        </div>
      ) : null}
    </Card>
  );
}
