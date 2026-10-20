import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ChatLines, Clock, Code, Cube, Folder, Globe, Key, NavArrowDown,
  Plus, Settings, SidebarCollapse, SidebarExpand, User,
} from "iconoir-react";
import { Button, IconButton } from "../../../src/components/Button";
import { Input } from "../../../src/components/Input";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { SpaceIdentity } from "../../../src/components/SpaceIdentity";
import { Text } from "../../../src/components/Text";
import { StudioDesktopHeader } from "../../../src/screens/studio/components/StudioDesktopHeader";
import { StudioOrganizationRail } from "../../../src/screens/studio/components/StudioOrganizationRail";
import type { SidebarWorkspaceOrgOption } from "../../../src/screens/studio/components/StudioSidebarWorkspaceSwitcher";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import "../../../src/styles/tailwind.css";
import "../../../src/screens/studio/StudioContextLayout.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const showReviewControls = params.get("controls") !== "0";
const organizations: SidebarWorkspaceOrgOption[] = [
  { key: "workshop", name: "Instafy Workshop", label: "Instafy Workshop", slug: "workshop", count: 4, accentColor: "violet" },
  { key: "studio", name: "Design Studio", label: "Design Studio", slug: "studio", count: 3, accentColor: "blue" },
  { key: "research", name: "Research Lab", label: "Research Lab", slug: "research", count: 2, accentColor: "green" },
  { key: "personal", name: "Personal Projects", label: "Personal Projects", slug: "personal", count: 1, accentColor: "orange" },
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
  const [version, setVersion] = useState(params.get("version") === "before" ? "before" : "after");
  const [selected, setSelected] = useState(params.get("org") ?? "workshop");
  const [collapsed, setCollapsed] = useState(params.get("collapsed") === "1");
  const [home, setHome] = useState(params.get("home") === "1");
  const [integrated, setIntegrated] = useState(params.get("shell") === "desktop");
  const [destination, setDestination] = useState("Chats");
  const [searchOpen, setSearchOpen] = useState(false);
  const [contextTarget, setContextTarget] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("");
  const browseRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const org = organizations.find(item => item.key === selected) ?? organizations[0];
  useEffect(() => {
    setThemeMode(params.get("theme") === "dark" ? "dark" : "light");
  }, [setThemeMode]);
  const selectOrg = (key: string) => { setSelected(key); setHome(false); setSearchOpen(false); };
  const surfaceStyle = {
    "--studio-context-top": "0px",
    ...(version === "before" ? {
      "--studio-navigation-surface": resolvedTheme === "dark" ? "var(--color-studio-dark-rail)" : "var(--color-slate-50)",
      "--studio-organization-surface": resolvedTheme === "dark" ? "var(--color-studio-dark-canvas)" : "var(--color-slate-100)",
    } : {}),
  } as CSSProperties;

  return <main className="organization-review">
    {showReviewControls ? <header className="review-controls">
      <div className="flex flex-wrap items-center gap-3">
        <Text as="h1" variant="bodyStrong">Organization surface review</Text>
        <SegmentedControl aria-label="Version" size="xs" width="fit" value={version} onChange={setVersion}
          options={[{ value: "before", label: "Before" }, { value: "after", label: "After" }]} />
        <SegmentedControl aria-label="Theme" size="xs" width="fit" value={resolvedTheme}
          onChange={value => setThemeMode(value as "light" | "dark")}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <SegmentedControl aria-label="Shell" size="xs" width="fit" value={integrated ? "desktop" : "browser"}
          onChange={value => setIntegrated(value === "desktop")}
          options={[{ value: "browser", label: "Browser" }, { value: "desktop", label: "Desktop" }]} />
      </div>
      <Text variant="caption" tone="muted">
        Production organization rail, desktop header and connected curves. Inner navigation and workspace are sample content; no account or backend is connected.
      </Text>
    </header> : null}
    <div className="review-scroll-frame">
      <div className="studio-context-layout organization-review-shell relative flex overflow-hidden bg-slate-50 dark:bg-[var(--color-studio-dark-canvas)]"
        data-testid="organization-review-shell" data-wide="true"
        data-linked-navigation={!home && !searchOpen} data-titlebar-free={integrated}
        data-search-open={searchOpen} data-conversation-workspace="true"
        data-review-version={version} style={surfaceStyle}>
        <StudioOrganizationRail organizations={organizations} selectedOrgKey={org.key} homeActive={home}
          homeAttentionCount={5} orgAttentionCounts={{ workshop: 2, studio: 1, research: 2 }}
          titleBarFree={integrated} onHome={() => { setHome(true); setSearchOpen(false); }}
          onSelectOrganization={selectOrg} onBrowseOrganizations={() => setStatus("Choose any team icon in this local preview.")}
          onCreateOrganization={() => setStatus("Team creation is not connected in this local preview.")}
          browseButtonRef={browseRef}
          account={<IconButton aria-label="Sample account" variant="ghost" size="sm" radius="lg"
            onPress={() => setStatus("Account settings are not connected in this local preview.")}>
            <User className="h-5 w-5" aria-hidden="true" />
          </IconButton>} />
        <StudioDesktopHeader contextRef={setContextTarget} searchTriggerRef={searchRef}
          navigationCollapsed={collapsed} navigationHidden={home} homeOverview={home}
          onHomeReturn={() => setHome(false)} searchOpen={searchOpen}
          onSearch={() => setSearchOpen(true)} orgName={org.name} accentColor={org.accentColor}>
          <div className="studio-desktop-tabbar flex items-center gap-2 px-3">
            <ChatLines className="h-4 w-4" aria-hidden="true" />
            <Text as="span" variant="bodyStrong">Workspace review</Text>
          </div>
        </StudioDesktopHeader>
        {contextTarget ? createPortal(searchOpen ? <div className="flex min-w-0 items-center gap-2">
          <Input aria-label="Sample search" placeholder="Search this preview" autoFocus />
          <Button variant="ghost" preset="inline" onPress={() => {
            setSearchOpen(false);
            requestAnimationFrame(() => searchRef.current?.focus());
          }}>Close</Button>
        </div> : <div className="studio-desktop-context">
          <Button variant="ghost" preset="inline" onPress={() => setStatus("Space selection is sample content. Switch teams using the left rail.")}>
            <SpaceIdentity name="Product" icon="🛠️" />
            <span>Product</span><NavArrowDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>, contextTarget) : null}
        {!home && !searchOpen ? <nav
          aria-label={`${org.name} sample navigation`} data-testid="sidebar-context-navigation"
          className={`review-inner-navigation relative flex min-h-0 shrink-0 flex-col text-slate-600 dark:text-slate-300 ${integrated ? "overflow-visible" : "overflow-hidden"}`}
          style={{ width: collapsed ? "4rem" : "var(--studio-context-column-width)" }}>
          {integrated ? <div aria-hidden="true" data-rail-surface="" className="absolute inset-x-0 bottom-0" /> : null}
          <div className="flex h-12 min-h-12 items-center" data-testid="sidebar-team-header">
            <div className="flex w-16 shrink-0 justify-center">
              <IconButton variant="ghost" size="sm" radius="lg"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                onPress={() => setCollapsed(value => !value)}>
                {collapsed ? <SidebarExpand className="h-5 w-5" aria-hidden="true" /> : <SidebarCollapse className="h-5 w-5" aria-hidden="true" />}
              </IconButton>
            </div>
            {!collapsed ? <Button variant="ghost" preset="inline" onPress={() => setStatus("New chat selected in local preview.")}>
              <Plus className="h-4 w-4" aria-hidden="true" />New chat
            </Button> : null}
          </div>
          <div className="min-h-0 overflow-auto px-2 py-2">
            {collapsed ? <div className="mb-2 flex justify-center"><IconButton variant="ghost" size="sm" radius="lg"
              aria-label="New chat" onPress={() => setStatus("New chat selected in local preview.")}>
              <Plus className="h-5 w-5" aria-hidden="true" />
            </IconButton></div> : null}
            {navigation.map(({ label, icon: Icon }) => <div key={label} className="mb-1 flex">
              <Button variant="ghost" preset="inline" aria-label={label} title={collapsed ? label : undefined}
                aria-current={destination === label ? "page" : undefined}
                onPress={() => setDestination(label)} className={`w-full ${collapsed ? "justify-center" : "justify-start"}`}>
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                {!collapsed ? <span>{label}</span> : null}
              </Button>
            </div>)}
          </div>
        </nav> : null}
        <section className={`${searchOpen ? "studio-context-search-screen" : "studio-context-workspace"} min-h-0 min-w-0 flex-1`} aria-label="Sample workspace">
          <div className={searchOpen ? "review-search-content" : "studio-content-surface review-working-content"}>
            <div className="review-content-measure">
              <Text variant="caption" tone="muted">SAMPLE WORKSPACE</Text>
              <Text as="h2" variant="title" className="mt-2">{searchOpen ? "Search" : home ? "Home" : destination}</Text>
              <Text variant="body" tone="secondary" className="mt-3">
                {home ? "All teams and recent work." : searchOpen ? "Search is intentionally local to this visual review." : `${org.name} / Product`}
              </Text>
              <Text variant="body" tone="secondary" className="mt-8 max-w-xl">
                {home ? "Select a team on the left to return to its navigation." : "Switch teams and collapse the inner sidebar to inspect how the selected team connects to its controls and the header."}
              </Text>
              <div className="review-sample-lines mt-8 max-w-lg" aria-hidden="true"><div /><div /><div /></div>
              <Text role="status" variant="caption" tone="muted" className="mt-8">{status}</Text>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ThemeProvider><Review /></ThemeProvider>);
