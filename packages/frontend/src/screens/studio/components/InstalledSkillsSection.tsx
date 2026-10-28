import { MoreHoriz, NavArrowRight, Plus, Puzzle, Refresh, Trash } from "iconoir-react";
import { useLayoutEffect, useRef } from "react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { Toggle } from "../../../components/Toggle";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

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

/** A skill pack installed with the space's runtime: shown, but the runtime manages it. */
type IncludedSkill = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  version: string | null;
};

type InstalledSkillsSectionProps = {
  hasProject: boolean;
  loading: boolean;
  skills: InstalledSkillsSectionSkill[];
  includedSkills?: IncludedSkill[];
  error: string | null;
  workspaceUnavailable?: boolean;
  bootstrapPending: boolean;
  brokenSkillIcons: Record<string, true>;
  togglePendingSkillId: string | null;
  uninstallPendingSkillId: string | null;
  onReload: () => void;
  onBootstrapSkills: () => void;
  onConnectTool: () => void;
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
  includedSkills = [],
  error,
  workspaceUnavailable = false,
  bootstrapPending,
  brokenSkillIcons,
  togglePendingSkillId,
  uninstallPendingSkillId,
  onReload,
  onBootstrapSkills,
  onConnectTool,
  onOpenAddSkillModal,
  onMarkSkillIconBroken,
  onToggleSkill,
  onUninstallSkill,
  onOpenSkillFile,
}: InstalledSkillsSectionProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const sectionRef = useRef<HTMLElement | null>(null);
  const retryFocused = useRef(false);
  useLayoutEffect(() => {
    // Successful recovery removes Retry. Keep keyboard users at this section,
    // but never move focus if they left the control while the request ran.
    if ((!error || workspaceUnavailable) && retryFocused.current && document.activeElement === document.body) {
      const destination = workspaceUnavailable
        ? document.querySelector<HTMLElement>('[data-testid="workspace-availability-retry"]')
        : sectionRef.current?.querySelector<HTMLHeadingElement>("h2");
      destination?.focus({ preventScroll: true });
    }
    if (!error || workspaceUnavailable) retryFocused.current = false;
  }, [error, workspaceUnavailable]);
  return (
    <section ref={sectionRef} className="min-w-0 space-y-4" aria-label="Installed skills">
      <div className="flex items-center justify-between gap-2" data-testid="skills-toolbar">
        <Text as="h2" variant="bodyStrong" tone="primary" className="min-w-0" tabIndex={-1}>
          Installed skills
        </Text>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="primary" preset="inline" onPress={onConnectTool}
            isDisabled={!hasProject}
            aria-label="Connect a tool" data-testid="skills-connect-tool">
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="@min-[36rem]/settings-content:hidden">Connect</span>
            <span className="hidden @min-[36rem]/settings-content:inline">Connect a tool</span>
          </Button>
          <MenuTrigger>
            <IconButton variant="ghost" size="sm" isDisabled={!hasProject}
              aria-label="More skill actions" data-testid="skills-actions">
              <MoreHoriz className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <StudioPopover placement="bottom end" layout="menu">
              <StudioMenu aria-label="Skill actions">
                <StudioMenuItem id="import" onAction={onOpenAddSkillModal} isDisabled={workspaceUnavailable} data-testid="skills-new">
                  <MenuItemContent start={<Plus aria-hidden="true" />}>Import custom skill</MenuItemContent>
                </StudioMenuItem>
                {!error && !workspaceUnavailable ? <StudioMenuItem id="refresh" onAction={onReload} isDisabled={loading} data-testid="skills-refresh">
                  <MenuItemContent start={<Refresh aria-hidden="true" />}>Refresh skills</MenuItemContent>
                </StudioMenuItem> : null}
                {!loading && !error && !workspaceUnavailable && skills.length === 0 ? <StudioMenuItem id="restore" onAction={onBootstrapSkills}
                  isDisabled={bootstrapPending} data-testid="skills-bootstrap">
                  Restore defaults
                </StudioMenuItem> : null}
              </StudioMenu>
            </StudioPopover>
          </MenuTrigger>
        </div>
      </div>
      <Text variant="bodyCompact" tone="secondary">
        Instructions available to the AI in this space.
      </Text>
      {loading && skills.length > 0 && !error ? <LoadingStatus>Refreshing skills…</LoadingStatus> : null}
      {workspaceUnavailable && skills.length > 0 ? <Text variant="caption" tone="muted">Showing the last loaded skills.</Text> : null}

      {!hasProject ? (
        <Text variant="caption" tone="muted">
          Select a space to manage skills.
        </Text>
      ) : error && !workspaceUnavailable ? (
        <div className="flex items-center gap-2" data-testid="skills-load-error">
          <Text as="p" variant="caption" tone="muted" className="min-w-0" role="status">
            {error}
          </Text>
          <Button variant="text" tone="muted" preset="inline" onPress={onReload} isPending={loading}
            onFocus={() => { retryFocused.current = true; }}
            onBlur={(event) => { if (event.currentTarget.isConnected) retryFocused.current = false; }}
            className="shrink-0" data-testid="skills-retry">
            Retry
          </Button>
        </div>
      ) : workspaceUnavailable && skills.length === 0 && includedSkills.length === 0 ? null : loading && skills.length === 0 ? (
        <LoadingStatus>Loading skills…</LoadingStatus>
      ) : skills.length === 0 && includedSkills.length === 0 ? (
        <div className="space-y-3">
          <Text variant="caption" tone="muted">
            No installed skills yet.
          </Text>
          {bootstrapPending ? <LoadingStatus>Restoring defaults…</LoadingStatus> : (
            <Text variant="caption" tone="muted">
              Connect a tool for guided setup, or import your own skill from the menu above.
            </Text>
          )}
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
                      {isLargeScreen ? (
                        <Text variant="bodyStrong" tone="primary" className="line-clamp-2 break-words @min-[36rem]/settings-content:line-clamp-1">
                          {skill.title}
                        </Text>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onPress={() => onOpenSkillFile(skill)}
                          aria-label={`Open ${skill.title}`}
                          title="Open skill file"
                          isDisabled={workspaceUnavailable || togglePendingSkillId !== null || uninstallPendingSkillId !== null}
                          className="max-w-full text-left"
                          data-testid={`skills-open-file-${skill.slug}`}
                        >
                          <Text as="span" variant="bodyStrong" tone="primary" className="line-clamp-2 break-words">
                            {skill.title}
                          </Text>
                        </Button>
                      )}
                      <Text variant="bodyCompact" tone="secondary" className="line-clamp-2">
                        {skill.description ?? skill.slug}
                      </Text>
                    </div>
                  </div>
                  <div className="ml-2 flex shrink-0 items-center gap-2 pt-0.5">
                    <Toggle
                      size="sm"
                      aria-label={`Set ${skill.title} active`}
                      isSelected={skill.status === "enabled"}
                      onChange={(nextSelected) => onToggleSkill(skill, nextSelected)}
                      isDisabled={
                        workspaceUnavailable ||
                        uninstallPendingSkillId !== null ||
                        (togglePendingSkillId !== null && togglePendingSkillId !== skill.id)
                      }
                      data-testid={`skills-toggle-${skill.slug}`}
                    />
                    {isLargeScreen ? (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onPress={() => onUninstallSkill(skill)}
                        aria-label={`Uninstall ${skill.title}`}
                        title="Uninstall skill"
                        tone="danger"
                        isDisabled={
                          workspaceUnavailable ||
                          togglePendingSkillId !== null ||
                          (uninstallPendingSkillId !== null && uninstallPendingSkillId !== skill.id)
                        }
                        data-testid={`skills-uninstall-${skill.slug}`}
                      >
                        <Trash className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    ) : null}
                    {isLargeScreen ? (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onPress={() => onOpenSkillFile(skill)}
                        aria-label={`Open ${skill.title}`}
                        title="Open skill file"
                        isDisabled={workspaceUnavailable || togglePendingSkillId !== null || uninstallPendingSkillId !== null}
                        data-testid={`skills-open-file-${skill.slug}`}
                      >
                        <NavArrowRight className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    ) : (
                      <MenuTrigger>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={`Actions for ${skill.title}`}
                          title="Skill actions"
                          isDisabled={togglePendingSkillId !== null || uninstallPendingSkillId !== null}
                          data-testid={`skills-actions-${skill.slug}`}
                        >
                          <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                        <StudioPopover placement="bottom end" layout="menu">
                          <StudioMenu
                            aria-label={`Actions for ${skill.title}`}
                            onAction={(key) => {
                              if (key === "open") onOpenSkillFile(skill);
                              if (key === "uninstall") onUninstallSkill(skill);
                            }}
                          >
                            <StudioMenuItem id="open" isDisabled={workspaceUnavailable} textValue="Open skill file">
                              <MenuItemContent start={<NavArrowRight aria-hidden="true" />}>Open skill file</MenuItemContent>
                            </StudioMenuItem>
                            <StudioMenuItem id="uninstall" isDisabled={workspaceUnavailable} textValue="Uninstall skill" data-testid={`skills-uninstall-${skill.slug}`}>
                              <MenuItemContent start={<Trash aria-hidden="true" />} textClassName="text-rose-600 dark:text-rose-400">Uninstall skill</MenuItemContent>
                            </StudioMenuItem>
                          </StudioMenu>
                        </StudioPopover>
                      </MenuTrigger>
                    )}
                  </div>
                </div>

                {isTogglePending ? (
                  <LoadingStatus>Updating skill state…</LoadingStatus>
                ) : isUninstallPending ? (
                  <LoadingStatus>Uninstalling skill…</LoadingStatus>
                ) : null}
              </div>
            );
          })}
          {includedSkills.map((skill) => (
            <div
              key={skill.id}
              className="space-y-2 py-3 first:pt-0 last:pb-0"
              data-testid={`skills-included-${skill.slug}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <Puzzle className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <Text variant="bodyStrong" tone="primary" className="line-clamp-2 break-words @min-[36rem]/settings-content:line-clamp-1">
                      {skill.title}
                    </Text>
                    <Text variant="bodyCompact" tone="secondary" className="line-clamp-2">
                      {skill.description ?? skill.slug}
                    </Text>
                  </div>
                </div>
                <Text variant="caption" tone="muted" className="ml-2 shrink-0 pt-0.5 text-right" data-testid={`skills-included-label-${skill.slug}`}>
                  {skill.version ? `Included with Instafy · ${skill.version}` : "Included with Instafy"}
                </Text>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
