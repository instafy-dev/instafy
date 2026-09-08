import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Group } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { Text } from "../../../components/Text";
import { SpaceIdentity } from "../../../components/SpaceIdentity";
import { useOrgMembers } from "../../../org/useOrgMembers";
import { useProjects } from "../../../projects/useProjects";
import { useAuth } from "../../../providers/AuthProvider";
import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { formatRelativeTimestamp } from "../homeFeed";
import { teamActivity, teamWorkHref, teamWorkStatus } from "../teamActivity";
import { useHomeActivity } from "../useHomeActivity";
import { useWorkspaceControls } from "../workspaceControls";
import { SettingsShell } from "./SettingsShell";

const SECTION = "space-y-3 border-t border-slate-200/70 pt-5 dark:border-[color:var(--color-studio-dark-divider)]";

export function TeamPanel() {
  const { user } = useAuth();
  const { activeProjectId, projectList } = useProjects();
  const { onOpenOrgSettings, onStartNewProject } = useWorkspaceControls();
  const { requestUrlNavigation, openPanelTab } = useWorkspaceTabs();
  const navigate = useNavigate();
  const activeProject = projectList.find((project) => project.id === activeProjectId);
  const [selection, setSelection] = useState<{ userId: string; id: string } | null>(null);
  const orgs = useQuery({
    queryKey: ["team-overview-organizations", user?.id ?? null],
    enabled: Boolean(user?.id),
    queryFn: async ({ signal }) => {
      const result = await controllerClient.organizations.list({ throwOnError: true, signal });
      if (!result) throw new Error("Unable to load your teams.");
      return result;
    },
  });
  const organizations = user && !orgs.isError ? orgs.data ?? [] : [];
  const selectedId = selection?.userId === user?.id ? selection?.id : null;
  const organization = organizations.find((org) => org.id === selectedId)
    ?? organizations.find((org) => org.id === activeProject?.orgId) ?? organizations[0];
  const organizationId = organization?.id ?? null;
  const members = useOrgMembers(organizationId, user?.id ?? null);
  const [peopleExpanded, setPeopleExpanded] = useState(false);
  // A Team visit must not mark unrelated Home activity as seen.
  const activity = useHomeActivity(user?.id ?? null, 50, false);
  const work = useMemo(() => teamActivity(activity.activityItems, organizationId), [activity.activityItems, organizationId]);
  const spaces = projectList.filter((project) => organizationId && project.orgId === organizationId);
  const canCreateSpace = organization?.role === "owner" || organization?.role === "admin" || organization?.role === "builder";
  const agents = useMemo(() => {
    const seen = new Set<string>();
    return work.filter((item) => {
      if (item.actor.kind !== "agent") return false;
      const key = `${item.actor.userId ?? ""}:${item.actor.handle ?? item.actor.displayName ?? "agent"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [work]);
  const openWork = (href: string | null) => { if (href) navigate(href); };
  const openMachines = () => {
    requestUrlNavigation("push");
    openPanelTab("machines");
  };

  return (
    <SettingsShell title="Team" testId="team-panel" actions={organization ? (
      <Button variant="outline" size="sm" onPress={() => onOpenOrgSettings?.(organization.id)} isDisabled={!onOpenOrgSettings}>Team settings</Button>
    ) : undefined}>
      <div className="space-y-6">
        {orgs.isLoading ? <p role="status">Loading teams…</p> : orgs.isError ? (
          <div role="alert">Unable to load your teams. <Button variant="outline" size="sm" onPress={() => void orgs.refetch()}>Retry</Button></div>
        ) : !organization ? <p>You don’t belong to a team yet. Create a team from Team &amp; spaces to bring people and agents together.</p> : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {organization.avatarUrl ? <img src={organization.avatarUrl} alt="" className="h-12 w-12 rounded-xl object-cover" />
                : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-lg font-semibold dark:bg-slate-700">{organization.name.slice(0, 1).toUpperCase()}</span>}
              <div className="min-w-0 flex-1">
                <Select aria-label="Team" value={organization.id} onChange={(event) => setSelection({ userId: user?.id ?? "", id: event.target.value })}>
                  {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                </Select>
                <Text variant="caption" tone="muted">Your role: {organization.role ?? "member"}. Only work you have access to is shown.</Text>
              </div>
            </div>

            <section className={SECTION} aria-label="Team work">
              <h2 className="text-sm font-semibold">Current and recent work</h2>
              {activity.activityError ? <p role="alert">Activity couldn’t refresh. <Button variant="ghost" size="sm" onPress={() => void activity.retryActivity()}>Retry</Button></p> : null}
              {activity.activityLoading ? <p role="status">Loading activity…</p> : null}
              <ul className="divide-y divide-slate-200/70 dark:divide-[color:var(--color-studio-dark-divider)]">{work.map((item) => (
                <li key={item.id} className="py-3">
                  <button type="button" className="w-full text-left" onClick={() => openWork(teamWorkHref(item))}>
                    <span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-primary-600 dark:text-primary-400">{item.conversation?.title || item.title || "Chat"}</span><span className="text-xs">{teamWorkStatus(item)}</span></span>
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{item.project?.name || "Untitled space"} · {formatRelativeTimestamp(Date.parse(item.at), Date.now())}{item.conversation?.visibility === "private" ? " · Private chat" : ""}</span>
                    {item.preview ? <span className="mt-2 line-clamp-3 block break-words text-sm text-slate-600 dark:text-slate-300">{item.preview}</span> : null}
                  </button>
                </li>
              ))}</ul>
              {!activity.activityLoading && !activity.activityError && work.length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">No activity for this team in the loaded history.</p> : null}
              {activity.activityHasMore ? <Button variant="outline" size="sm" isDisabled={activity.activityLoadingMore} onPress={() => void activity.loadMoreActivity()}>Load more activity</Button> : null}
            </section>

            <section className={SECTION} aria-label="Agents in recent activity">
              <h2 className="text-sm font-semibold">Agents in recent activity</h2>
              {agents.length === 0 ? (!activity.activityLoading && !activity.activityError ? <p className="text-sm text-slate-500 dark:text-slate-400">No agent activity in the loaded history yet.</p> : null) : (
                <ul className="space-y-2">{agents.map((item) => <li key={item.id}>
                  <button type="button" className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left hover:bg-slate-100 dark:hover:bg-[var(--color-studio-dark-rail-hover)]" onClick={() => openWork(teamWorkHref(item))}>
                    <span className="min-w-0"><span className="block text-sm font-medium">{item.actor.handle ? `@${item.actor.handle}` : item.actor.displayName || "Agent"}</span><span className="block truncate text-xs text-slate-500 dark:text-slate-400">{item.project?.name || "Untitled space"} · {item.conversation?.title || "Chat"}</span></span>
                    <span className="shrink-0 text-xs">{teamWorkStatus(item)}</span>
                  </button>
                </li>)}</ul>
              )}
              {activeProject?.orgId === organizationId ? <Button variant="outline" size="sm" onPress={openMachines}>Machines for {activeProject.name || "this space"}</Button> : null}
            </section>

            <section className={SECTION} aria-label="People">
              <h2 className="text-sm font-semibold">People {members.total !== null ? `(${members.total})` : ""}</h2>
              <Input aria-label="Find a teammate" placeholder="Find a teammate" value={members.query} onChange={(event) => members.setQuery(event.target.value)} />
              {members.error ? <p role="alert">Unable to load members. <Button variant="ghost" size="sm" onPress={() => void members.refresh({ force: true })}>Retry</Button></p> : null}
              {members.loading ? <p role="status" className="text-sm">Loading people…</p> : null}
              <ul className="divide-y divide-slate-200/70 dark:divide-[color:var(--color-studio-dark-divider)]">
                {members.members.slice(0, peopleExpanded ? undefined : 8).map((member) => {
                  const lastWork = work.find((item) => item.actor.kind === "user" && item.actor.userId === member.userId);
                  return <li key={member.userId} className="flex items-start gap-3 py-3">
                    <Group className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">{member.fullName || member.email || "Team member"}{member.userId === user?.id ? " · You" : ""}</p>
                      {lastWork ? <button type="button" className="mt-1 text-left text-xs text-primary-600 hover:underline dark:text-primary-400" onClick={() => openWork(teamWorkHref(lastWork))}>{lastWork.conversation?.title || lastWork.title || "Open recent work"}</button> : null}
                    </div>
                    <span className="text-xs capitalize text-slate-500 dark:text-slate-400">{member.role}</span>
                  </li>;
                })}
              </ul>
              {!members.loading && !members.error && members.members.length === 0 ? <p className="text-sm text-slate-500">No matching members.</p> : null}
              {!peopleExpanded && members.members.length > 8 ? <Button variant="ghost" size="sm" onPress={() => setPeopleExpanded(true)}>Show all loaded people</Button> : null}
              {members.hasMore ? <Button variant="outline" size="sm" isDisabled={members.loadingMore} onPress={() => void members.loadMore()}>More people</Button> : null}
            </section>

            <section className={SECTION} aria-label="Team spaces">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Available spaces</h2>
                {canCreateSpace && onStartNewProject ? <Button variant="outline" size="sm" onPress={() => onStartNewProject(organization.id)}>New space</Button> : null}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Spaces loaded in this workspace. Open Team &amp; spaces to find more.</p>
              {spaces.length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">No spaces for this team are loaded in this workspace.</p> : (
                <ul className="space-y-2">{spaces.map((space) => <li key={space.id}>
                  <button type="button" className="flex items-center gap-2 text-sm text-primary-600 dark:text-primary-400" onClick={() => navigate(`/studio?${new URLSearchParams({ projectId: space.id, panel: "automations" })}`)}>
                    <SpaceIdentity name={space.name} icon={space.projectIcon} color={space.projectColor} className="h-7 w-7" />
                    {space.name || "Untitled space"}<span className="text-xs text-slate-500">· Automations</span>
                  </button>
                </li>)}</ul>
              )}
            </section>
          </>
        )}
      </div>
    </SettingsShell>
  );
}
