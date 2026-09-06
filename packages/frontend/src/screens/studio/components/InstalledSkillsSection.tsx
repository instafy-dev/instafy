import { NavArrowRight, Plus, Puzzle, Trash } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";

type InstalledSkillsSectionSkill = {
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

type InstalledSkillsSectionProps = {
  hasProject: boolean;
  loading: boolean;
  skills: InstalledSkillsSectionSkill[];
  error: string | null;
  bootstrapPending: boolean;
  brokenSkillIcons: Record<string, true>;
  togglePendingSkillId: string | null;
  uninstallPendingSkillId: string | null;
  onReload: () => void;
  onBootstrapSkills: () => void;
  onOpenAddSkillModal: () => void;
  onMarkSkillIconBroken: (skillId: string) => void;
  onToggleSkill: (skill: InstalledSkillsSectionSkill, enabled: boolean) => void;
  onUninstallSkill: (skill: InstalledSkillsSectionSkill) => void;
  onOpenSkillFile: (skill: InstalledSkillsSectionSkill) => void;
};

export function InstalledSkillsSection({
  hasProject,
  loading,
  skills,
  error,
  bootstrapPending,
  brokenSkillIcons,
  togglePendingSkillId,
  uninstallPendingSkillId,
  onReload,
  onBootstrapSkills,
  onOpenAddSkillModal,
  onMarkSkillIconBroken,
  onToggleSkill,
  onUninstallSkill,
  onOpenSkillFile,
}: InstalledSkillsSectionProps) {
  return (
    <Card tone="default" radius="2xl" className="space-y-4">
      <div className="space-y-1">
        <Text variant="bodyStrong" tone="primary">
          Installed
        </Text>
        <Text variant="caption" tone="muted">
          Enable or disable skills used by this space.
        </Text>
      </div>

      {!hasProject ? (
        <Text variant="caption" tone="muted">
          Select a space to manage skills.
        </Text>
      ) : loading && skills.length === 0 ? (
        <LoadingStatus>Loading skills…</LoadingStatus>
      ) : error ? (
        <div className="space-y-2">
          <Text variant="caption" tone="muted">
            {error}
          </Text>
          <Button variant="outline" size="sm" radius="xl" onPress={onReload}>
            Retry
          </Button>
        </div>
      ) : skills.length === 0 ? (
        <div className="space-y-3">
          <Text variant="caption" tone="muted">
            No installed skills yet.
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              radius="xl"
              onPress={onBootstrapSkills}
              isDisabled={bootstrapPending}
              data-testid="skills-bootstrap"
            >
              {bootstrapPending ? <Spinner tone="primary" size="sm" aria-hidden="true" /> : null}
              Bootstrap Default Skills
            </Button>
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={onOpenAddSkillModal}
              data-testid="skills-empty-new"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Import
            </Button>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800" data-testid="skills-list">
          {skills.map((skill) => {
            const isTogglePending = togglePendingSkillId === skill.id;
            const isUninstallPending = uninstallPendingSkillId === skill.id;
            const iconFailed = brokenSkillIcons[skill.id] === true;
            const iconUrl = !iconFailed ? skill.iconUrl?.trim() ?? "" : "";
            return (
              <div
                key={skill.id}
                className="space-y-2 py-3 first:pt-0 last:pb-0"
                data-testid={`skills-item-${skill.slug}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt=""
                          className="h-5 w-5 rounded-sm object-contain"
                          loading="lazy"
                          onError={() => onMarkSkillIconBroken(skill.id)}
                        />
                      ) : (
                        <Puzzle className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 space-y-1">
                      <Text variant="bodyStrong" tone="primary" className="truncate">
                        {skill.title}
                      </Text>
                      <Text variant="caption" tone="muted" className="line-clamp-2">
                        {skill.description ?? skill.slug}
                      </Text>
                    </div>
                  </div>
                  <div className="ml-2 flex shrink-0 items-center gap-1.5 pt-0.5">
                    <Toggle
                      size="sm"
                      aria-label={`Set ${skill.title} active`}
                      isSelected={skill.status === "enabled"}
                      onChange={(nextSelected) => onToggleSkill(skill, nextSelected)}
                      isDisabled={
                        uninstallPendingSkillId !== null ||
                        (togglePendingSkillId !== null && togglePendingSkillId !== skill.id)
                      }
                      data-testid={`skills-toggle-${skill.slug}`}
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      radius="full"
                      onPress={() => onUninstallSkill(skill)}
                      aria-label={`Uninstall ${skill.title}`}
                      title="Uninstall skill"
                      className="text-rose-500 hover:text-rose-600 data-[hovered]:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200 dark:data-[hovered]:text-rose-200"
                      isDisabled={
                        togglePendingSkillId !== null ||
                        (uninstallPendingSkillId !== null && uninstallPendingSkillId !== skill.id)
                      }
                      data-testid={`skills-uninstall-${skill.slug}`}
                    >
                      <Trash className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      radius="full"
                      onPress={() => onOpenSkillFile(skill)}
                      aria-label={`Open ${skill.title}`}
                      title="Open skill file"
                      isDisabled={togglePendingSkillId !== null || uninstallPendingSkillId !== null}
                      data-testid={`skills-open-file-${skill.slug}`}
                    >
                      <NavArrowRight className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>

                {isTogglePending ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Spinner tone="primary" size="sm" aria-hidden="true" />
                    Updating skill state…
                  </div>
                ) : isUninstallPending ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Spinner tone="primary" size="sm" aria-hidden="true" />
                    Uninstalling skill…
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
