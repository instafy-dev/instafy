import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedLocalTabViewer } from "../../../src/screens/studio/components/SharedLocalTabViewer";
import { StudioSidebarWorkspaceSwitcher } from "../../../src/screens/studio/components/StudioSidebarWorkspaceSwitcher";
import { StudioSidebarWorkspacePanel } from "../../../src/screens/studio/components/StudioSidebarWorkspacePanel";
import { Button } from "../../../src/components/Button";
import type { MergedProjectListItem } from "../../../src/projects/useMergedControllerProjects";
import { grantControl, grantBrowse, share } from "./browserData";
import "../../../src/styles/tailwind.css";
import "./review.css";

const query = new URLSearchParams(location.search);
const surface = query.get("surface") ?? "shared-tab";
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const teams = [
  { key: "studio", name: "Review Studio", label: "Review Studio", slug: "review", count: 4, accentColor: "violet" },
  { key: "design", name: "Design Team", label: "Design Team", slug: "design", count: 2, accentColor: "blue" },
  { key: "research", name: "Research", label: "Research", slug: "research", count: 1, accentColor: "green" },
];
const projects: MergedProjectListItem[] = ["Website", "Shared browser review", "Navigation and accessibility", "Archive"].map((name, index) => ({
  id: `space-${index}`, name, orgId: "studio", orgName: "Review Studio", state: null, isRemoteOnly: false, projectIcon: ["🌍", "🔎", "🧭", "📁"][index],
}));
function Sidebar({ report }: { report: (value: string) => void }) {
  const [open, setOpen] = useState(true), [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);
  const [org, setOrg] = useState("studio"), [active, setActive] = useState(projects[0]);
  const [searchOpen, setSearchOpen] = useState(false), [search, setSearch] = useState("");
  const [desktop, setDesktop] = useState(matchMedia("(min-width:640px)").matches);
  const trigger = useRef<HTMLButtonElement>(null);
  const spacesOnly = surface === "spaces";
  useEffect(() => { const media = matchMedia("(min-width:640px)"); const changed = () => setDesktop(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  return <nav aria-label="Review navigation" className="review-sidebar">
    <div className="review-entry"><Button ref={trigger} variant="ghost" preset="inline" onPress={() => setOpen(true)}>Browse teams and spaces</Button></div>
    <div ref={setTarget} className="review-sidebar-panel" />
    <StudioSidebarWorkspacePanel open={open} desktop={desktop} portalTarget={target} triggerRef={trigger}
      headerActionsRef={spacesOnly ? setHeaderActions : undefined} mode={spacesOnly ? "spaces" : "teams-and-spaces"} onClose={() => { setOpen(false); report("Navigation closed"); }}>
      <StudioSidebarWorkspaceSwitcher mode={spacesOnly ? "spaces" : "teams-and-spaces"} spaceHeaderExternal={spacesOnly} spaceHeaderActionsTarget={headerActions}
        orgOptions={teams} workspaceOrgKey={org} onWorkspaceOrgChange={value => { setOrg(value); report(`Team selected: ${value}`); }}
        onOpenOrgSettings={() => report("Team settings")} onOpenOrgOverview={() => report("Team overview")} onCreateOrg={() => report("New team")}
        canSearchSpaces showProjectSearch={searchOpen} workspaceProjectSearchOpen={searchOpen} workspaceProjectQuery={search}
        onWorkspaceProjectQueryChange={setSearch} onToggleProjectSearch={() => { setSearchOpen(value => !value); setSearch(""); }}
        onCreateProject={() => report("New space")} onOpenProjectSettings={() => report("Space settings")}
        currentOrgProject={active} switcherProjects={projects.filter(project => project.id !== active.id && project.name.toLowerCase().includes(search.toLowerCase()))}
        onProjectMenuAction={key => { const selected = projects.find(project => `project:${project.id}` === key); if (selected) { setActive(selected); report(`Space selected: ${selected.name}`); } }}
        projectAttentionCounts={{ "space-1": 2 }} orgAttentionCounts={{ research: 1 }}
        projectsError={query.get("state") === "error" ? "Couldn’t load every space." : null} onRetryProjects={() => report("Retry requested")} />
    </StudioSidebarWorkspacePanel>
  </nav>;
}
function Review() {
  const [lastAction, setLastAction] = useState("Ready"), [closed, setClosed] = useState(false);
  const ended = useCallback(() => setLastAction("Share ended"), []);
  useEffect(() => { const handler = (event: Event) => setLastAction((event as CustomEvent<string>).detail); window.addEventListener("style-review-action", handler); return () => window.removeEventListener("style-review-action", handler); }, []);
  return <main className="review-page">
    <header className="review-heading"><h1>{surface === "shared-tab" ? "Shared local browser controls" : "Team and space navigation"}</h1><p>Production controls with local, inert data. No account or remote browser is connected.</p></header>
    {surface === "shared-tab" ? <div className="review-browser" style={query.has("pane") ? { maxWidth: Math.max(280, Math.min(1040, Number(query.get("pane")) || 1040)) } : undefined}>{closed ? <p>Shared tab closed.</p> : <SharedLocalTabViewer projectId="review-project" share={share} onClose={() => { setClosed(true); setLastAction("Shared tab closed"); }} onEnded={ended} />}</div> : <Sidebar report={setLastAction} />}
    <footer className="review-footer"><output data-testid="review-action-log">{lastAction}</output>
      {surface === "shared-tab" && query.get("controls") !== "0" ? <div className="review-actions"><Button preset="inline" variant="ghost" onPress={grantControl}>Simulate control granted</Button><Button preset="inline" variant="ghost" onPress={grantBrowse}>Simulate browse approved</Button></div> : null}
    </footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Review />);
