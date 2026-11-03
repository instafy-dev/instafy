import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BrowserRouter } from "react-router-dom";
import { StudioSidebar } from "../../../src/screens/studio/components/StudioSidebar";
import { WorkspaceControlsProvider } from "../../../src/screens/studio/workspaceControls";
import type { StudioPanel } from "../../../src/screens/studio/types";
import {
  SidebarReviewDataProvider,
  useProjects as useSidebarReviewProjects,
} from "./sidebar-adapters";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ChatLines,
  Clock,
  Code,
  Cube,
  Folder,
  Globe,
  Key,
  Plus,
  Settings,
  SidebarCollapse,
  SidebarExpand,
  User,
} from "iconoir-react";
import { Button, IconButton } from "../../../src/components/Button";
import { Input } from "../../../src/components/Input";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { Text } from "../../../src/components/Text";
import { StudioRecentSpaces } from "../../../src/screens/studio/components/StudioRecentSpaces";
import { HistoryDrawer } from "../../../src/screens/studio/components/HistoryDrawer";
import { WorkspaceTabs } from "../../../src/workspace/WorkspaceTabs";
import type { ActiveWorkspaceVersioning } from "../../../src/workspace/useActiveWorkspaceVersioning";
import { StudioDesktopHeader } from "../../../src/screens/studio/components/StudioDesktopHeader";
import { StudioOrganizationRail } from "../../../src/screens/studio/components/StudioOrganizationRail";
import type { SidebarWorkspaceOrgOption } from "../../../src/screens/studio/components/StudioSidebarWorkspaceSwitcher";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import "../../../src/styles/tailwind.css";
import "../../../src/screens/studio/StudioContextLayout.css";
import "./review.css";
const params = new URLSearchParams(location.search);
const showReviewControls = params.get("controls") === "1";
const tabMode = params.get("tabs") === "1";
const actualSidebar = params.get("sidebar") === "actual";
const mobileHistory = params.get("mobile") === "1";
const versioning: ActiveWorkspaceVersioning = {
  mode: "stateless",
  resolved: true,
  firstPaintMode: "stateless",
  originId: "review-origin",
  originMode: "hosted",
  stateless: true,
  recovery: "unknown",
  checkedAt: 0,
  refresh: async () => null,
  projectId: "review-project",
  chromeMode: "stateless",
  historyReady: true,
};
const organizations: SidebarWorkspaceOrgOption[] = [
  {
    key: "workshop",
    name: "Instafy Workshop",
    label: "Instafy Workshop",
    slug: "workshop",
    count: 4,
    accentColor: "violet",
  },
  {
    key: "studio",
    name: "Design Studio",
    label: "Design Studio",
    slug: "studio",
    count: 3,
    accentColor: "blue",
  },
  {
    key: "research",
    name: "Research Lab",
    label: "Research Lab",
    slug: "research",
    count: 2,
    accentColor: "green",
  },
  {
    key: "personal",
    name: "Personal Projects",
    label: "Personal Projects",
    slug: "personal",
    count: 1,
    accentColor: "orange",
  },
];
const navigation = [
  { label: "Chats", icon: ChatLines },
  { label: "Automations", icon: Clock },
  { label: "Files", icon: Folder },
  { label: "Changes", icon: Code },
  { label: "Extensions", icon: Globe },
  { label: "Secrets", icon: Key },
  { label: "Machines", icon: Cube },
  { label: "Settings", icon: Settings },
];
function Review() {
  const { resolvedTheme, setThemeMode } = useTheme();
  const { switchProject: switchReviewProject } = useSidebarReviewProjects();
  const [actualActivePanel, setActualActivePanel] = useState<StudioPanel>("automations");
  const [selected, setSelected] = useState(params.get("org") ?? "workshop");
  const [collapsed, setCollapsed] = useState(params.get("collapsed") === "1");
  const [home, setHome] = useState(params.get("home") === "1");
  const [integrated, setIntegrated] = useState(
    params.get("shell") === "desktop",
  );
  const [destination, setDestination] = useState("Automations");
  const [drawerOpen, setDrawerOpen] = useState(!tabMode);
  const [drawerTarget, setDrawerTarget] = useState<HTMLDivElement | null>(null);
  const [spaceId, setSpaceId] = useState("live");
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState(false);
  useEffect(() => {
    const listener = (event: Event) =>
      setStatus((event as CustomEvent<string>).detail);
    window.addEventListener("review:status", listener);
    return () => window.removeEventListener("review:status", listener);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [contextTarget, setContextTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const browseRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const org =
    organizations.find((item) => item.key === selected) ?? organizations[0];
  useEffect(() => {
    setThemeMode(params.get("theme") === "dark" ? "dark" : "light");
  }, [setThemeMode]);
  const selectOrg = (key: string) => {
    setSelected(key);
    setHome(false);
    setSearchOpen(false);
  };
  const surfaceStyle = {
    "--studio-context-top": "0px",
  } as CSSProperties;
  if (mobileHistory)
    return (
      <main
        className="mobile-history-review"
        data-testid="mobile-history-review"
      >
        <HistoryDrawer
          versioning={versioning}
          onRequestClose={() => setStatus("Close History selected in preview.")}
        />
      </main>
    );
  return (
    <main className="organization-review">
      {showReviewControls ? (
        <header className="review-controls">
          <div className="flex flex-wrap items-center gap-3">
            <Text as="h1" variant="bodyStrong">
              Context hierarchy review
            </Text>
            <SegmentedControl
              aria-label="Theme"
              size="xs"
              width="fit"
              value={resolvedTheme}
              onChange={(value) => setThemeMode(value as "light" | "dark")}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <SegmentedControl
              aria-label="Shell"
              size="xs"
              width="fit"
              value={integrated ? "desktop" : "browser"}
              onChange={(value) => setIntegrated(value === "desktop")}
              options={[
                { value: "browser", label: "Browser" },
                { value: "desktop", label: "Desktop" },
              ]}
            />
          </div>
          <Text variant="caption" tone="muted">
            Production header, space picker, History drawer and workspace tabs.
            Inner navigation and page body are sample content; no backend is
            connected.
          </Text>
        </header>
      ) : null}
      <div className="review-scroll-frame">
        <div
          className="studio-context-layout organization-review-shell relative flex overflow-hidden bg-slate-50 dark:bg-[var(--color-studio-dark-canvas)]"
          data-testid="organization-review-shell"
          data-wide="true"
          data-linked-navigation={!home && !searchOpen}
          data-titlebar-free={integrated}
          data-search-open={searchOpen}
          data-conversation-workspace="true"
          style={surfaceStyle}
        >
          {!actualSidebar ? <StudioOrganizationRail
            organizations={organizations}
            selectedOrgKey={org.key}
            homeActive={home}
            homeAttentionCount={5}
            orgAttentionCounts={{ workshop: 2, studio: 1, research: 2 }}
            titleBarFree={integrated}
            onHome={() => {
              setHome(true);
              setSearchOpen(false);
            }}
            onSelectOrganization={selectOrg}
            onBrowseOrganizations={() =>
              setStatus("Choose any team icon in this local preview.")
            }
            onCreateOrganization={() =>
              setStatus("Team creation is not connected in this local preview.")
            }
            browseButtonRef={browseRef}
            account={
              <IconButton
                aria-label="Sample account"
                variant="ghost"
                size="sm"
                radius="lg"
                onPress={() =>
                  setStatus(
                    "Account settings are not connected in this local preview.",
                  )
                }
              >
                <User className="h-5 w-5" aria-hidden="true" />
              </IconButton>
            }
          />
          : null}
          <StudioDesktopHeader
            contextRef={setContextTarget}
            searchTriggerRef={searchRef}
            drawerWidth={drawerOpen && !home ? 280 : 0}
            drawerHeaderRef={setDrawerTarget}
            navigationCollapsed={collapsed}
            navigationHidden={home}
            homeOverview={home}
            onHomeReturn={() => setHome(false)}
            searchOpen={searchOpen}
            onSearch={() => setSearchOpen(true)}
            orgName={org.name}
            accentColor={org.accentColor}
          >
            {tabMode ? (
              <div className="studio-desktop-tabbar">
                <WorkspaceTabs titleBarInset={false} flushStart={false} />
              </div>
            ) : (
              <div className="studio-desktop-tabbar flex items-center gap-2 px-4">
                <Clock className="h-5 w-5" aria-hidden="true" />
                <h1
                  className="text-sm font-semibold"
                  data-testid="review-page-header"
                >
                  {destination}
                </h1>
              </div>
            )}
          </StudioDesktopHeader>
          {contextTarget && !actualSidebar
            ? createPortal(
                searchOpen ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      aria-label="Sample search"
                      placeholder="Search this preview"
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      preset="inline"
                      onPress={() => {
                        setSearchOpen(false);
                        requestAnimationFrame(() => searchRef.current?.focus());
                      }}
                    >
                      Close
                    </Button>
                  </div>
                ) : (
                  <div className="studio-desktop-context">
                    <StudioRecentSpaces
                      spaces={[
                        { id: "live", name: "live eval 2026 — browser review" },
                        { id: "product", name: "Product website" },
                      ]}
                      teamName={org.name}
                      recency={{ live: 2, product: 1 }}
                      activeProjectId={spaceId}
                      onSelectSpace={setSpaceId}
                      onBrowseAll={() =>
                        setStatus("Browse all spaces selected.")
                      }
                      onNewSpace={() => setStatus("New space selected.")}
                      collapsed={false}
                      expanded={expandedSpaces}
                      onExpandedChange={setExpandedSpaces}
                      rowClassName="gap-1 !px-2 min-h-9"
                      iconClassName="flex h-5 w-5 shrink-0 items-center justify-center"
                      presentation="path"
                    />
                  </div>
                ),
                contextTarget,
              )
            : null}
          {actualSidebar ? (
            <WorkspaceControlsProvider
              value={{
                userId: "review-user",
                userEmail: "review@example.invalid",
                activeProjectName: "live eval 2026 — browser review",
                hasLogs: false,
                sidebarOpen: !collapsed,
                onToggleSidebar: () => setCollapsed(value => !value),
                showChatActions: true,
                onStartNewConversation: () => setStatus("New chat selected in local preview."),
                onStartNewProject: () => setStatus("New space selected in local preview."),
                onOpenProfileSettings: () => setStatus("Profile selected in local preview."),
                navigationPage: home ? "home" : "workspace",
                homeAttentionCount: 5,
                homeAttentionByOrg: { workshop: 2, studio: 1, research: 2 },
              }}
            >
              <StudioSidebar
                items={navigation.map(({ label, icon }) => ({
                  id: ({
                    Chats: "chat", Automations: "automations", Files: "code", Changes: "sourceControl",
                    Extensions: "extensions", Secrets: "secrets", Machines: "machines", Settings: "settings",
                  } as Record<string, StudioPanel>)[label],
                  label,
                  icon,
                  accent: "",
                }))}
                activePanel={home ? "home" : actualActivePanel}
                onSelect={panel => {
                  if (panel === "home") setHome(true);
                  else {
                    setActualActivePanel(panel);
                    setDestination(panel);
                    setStatus(`Navigation selected: ${panel}.`);
                  }
                }}
                collapsed={collapsed}
                selectedOrgKey={selected}
                onOpenTeam={selectOrg}
                onActivateProject={(id, key) => {
                  switchReviewProject(id);
                  selectOrg(key);
                }}
                onActiveTeamChange={team => setSelected(team.key)}
                workspaceSwitcherOpen={workspaceSwitcherOpen}
                onWorkspaceSwitcherOpenChange={setWorkspaceSwitcherOpen}
                workspaceSwitcherPortalTarget={null}
                navigationHeaderExternal
                navigationHeaderPortalTarget={contextTarget}
                navigationPresentation="path"
                compactContextHeader
                hideContext={searchOpen}
                renderNavigationHeader={({ space }) => searchOpen ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Input aria-label="Sample search" placeholder="Search this preview" autoFocus />
                    <Button
                      variant="ghost"
                      preset="inline"
                      onPress={() => {
                        setSearchOpen(false);
                        requestAnimationFrame(() => searchRef.current?.focus());
                      }}
                    >
                      Close
                    </Button>
                  </div>
                ) : <div className="studio-desktop-context">{space}</div>}
              />
            </WorkspaceControlsProvider>
          ) : !home && !searchOpen ? (
            <nav
              aria-label={`${org.name} sample navigation`}
              data-testid="sidebar-context-navigation"
              className={`review-inner-navigation relative flex min-h-0 shrink-0 flex-col text-slate-600 dark:text-slate-300 ${integrated ? "overflow-visible" : "overflow-hidden"}`}
              style={{
                width: collapsed
                  ? "4rem"
                  : "var(--studio-context-column-width)",
              }}
            >
              {integrated ? (
                <div
                  aria-hidden="true"
                  data-rail-surface=""
                  className="absolute inset-x-0 bottom-0"
                />
              ) : null}
              <div
                className="flex h-12 min-h-12 items-center"
                data-testid="sidebar-team-header"
              >
                <div className="flex w-16 shrink-0 justify-center">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    radius="lg"
                    aria-label={
                      collapsed ? "Expand sidebar" : "Collapse sidebar"
                    }
                    onPress={() => setCollapsed((value) => !value)}
                  >
                    {collapsed ? (
                      <SidebarExpand className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <SidebarCollapse className="h-5 w-5" aria-hidden="true" />
                    )}
                  </IconButton>
                </div>
                {!collapsed ? (
                  <Button
                    variant="ghost"
                    preset="inline"
                    onPress={() =>
                      setStatus("New chat selected in local preview.")
                    }
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    New chat
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 overflow-auto px-2 py-2">
                {collapsed ? (
                  <div className="mb-2 flex justify-center">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      radius="lg"
                      aria-label="New chat"
                      onPress={() =>
                        setStatus("New chat selected in local preview.")
                      }
                    >
                      <Plus className="h-5 w-5" aria-hidden="true" />
                    </IconButton>
                  </div>
                ) : null}
                {navigation.map(({ label, icon: Icon }) => (
                  <div key={label} className="mb-1 flex">
                    <Button
                      variant="ghost"
                      preset="inline"
                      aria-label={label}
                      title={collapsed ? label : undefined}
                      aria-current={destination === label ? "page" : undefined}
                      onPress={() => setDestination(label)}
                      className={`w-full ${collapsed ? "justify-center" : "justify-start"}`}
                    >
                      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      {!collapsed ? <span>{label}</span> : null}
                    </Button>
                  </div>
                ))}
              </div>
            </nav>
          ) : null}
          {drawerOpen && !home && !searchOpen ? (
            <aside
              className="studio-context-drawer relative flex min-h-0 shrink-0"
              style={{ width: 280 }}
              aria-label="History pane"
            >
              <div className="studio-content-surface h-full w-full min-w-0">
                <HistoryDrawer
                  versioning={versioning}
                  headerPortalTarget={collapsed ? null : drawerTarget}
                  onRequestClose={() => setDrawerOpen(false)}
                />
              </div>
            </aside>
          ) : null}
          <section
            className={`${searchOpen ? "studio-context-search-screen" : "studio-context-workspace"} min-h-0 min-w-0 flex-1`}
            aria-label="Sample workspace"
          >
            <div
              className={
                searchOpen
                  ? "review-search-content"
                  : "studio-content-surface review-working-content"
              }
            >
              <div className="review-content-measure">
                <Text variant="caption" tone="muted">
                  LOCAL COMPONENT PREVIEW
                </Text>
                <Text as="h2" variant="title" className="mt-2">
                  {searchOpen ? "Search" : home ? "Home" : destination}
                </Text>
                <Text variant="body" tone="secondary" className="mt-3">
                  {home
                    ? "All teams and recent work."
                    : searchOpen
                      ? "Search is intentionally local to this visual review."
                      : `${org.name} / live eval 2026 — browser review`}
                </Text>
                <Text variant="body" tone="secondary" className="mt-8 max-w-xl">
                  {home
                    ? "Select a team on the left to return to its navigation."
                    : "No automations yet. Schedule a prompt to run later, or open History to review saved versions."}
                </Text>
                {!home && !searchOpen ? (
                  <Button
                    variant="ghost"
                    preset="inline"
                    onPress={() => setDrawerOpen((value) => !value)}
                  >
                    {drawerOpen ? "Hide History" : "Show History"}
                  </Button>
                ) : null}
                <div
                  className="review-sample-lines mt-8 max-w-lg"
                  aria-hidden="true"
                >
                  <div />
                  <div />
                  <div />
                </div>
                <Text
                  role="status"
                  data-testid="review-action-status"
                  variant="caption"
                  tone="muted"
                  className="mt-8"
                >
                  {status}
                </Text>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <BrowserRouter>
      <SidebarReviewDataProvider>
        <Review />
      </SidebarReviewDataProvider>
    </BrowserRouter>
  </ThemeProvider>,
);
