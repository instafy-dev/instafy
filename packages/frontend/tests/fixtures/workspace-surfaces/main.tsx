import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { StudioDraftNavigationGuard } from "../../../src/navigation/StudioDraftNavigationGuard";
import { StudioDraftsProvider } from "../../../src/workspace/StudioDrafts";
import { SkillsPanel } from "../../../src/screens/studio/components/SkillsPanel";
import { MachinesPanel } from "../../../src/screens/studio/components/MachinesPanel";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import { setReviewAgentCount, type ReviewAgentCount } from "./adapters";
import { setChangesReviewActive } from "./changesAdapters";
import "../../../src/styles/tailwind.css";

const FilesPreview = lazy(() => import("./FilesPreview").then(module => ({ default: module.FilesPreview })));
const ChangesPreview = lazy(() => import("./ChangesPreview").then(module => ({ default: module.ChangesPreview })));

function ReviewSurface() {
  const [params, setParams] = useSearchParams();
  const panel = params.get("panel") ?? "skills";
  // Set the local data scenario before production child effects request status.
  useLayoutEffect(() => { setChangesReviewActive(panel === "changes"); }, [panel]);
  const navigate = useNavigate();
  const { resolvedTheme, setThemeMode } = useTheme();
  const [status, setStatus] = useState("All data and actions stay in this review. Reload to reset.");
  const [agentCount, setAgentCount] = useState<ReviewAgentCount>("single");
  useEffect(() => {
    const onStatus = (event: Event) => setStatus(String((event as CustomEvent).detail));
    const onNavigate = (event: Event) => setParams({ panel: String((event as CustomEvent).detail) });
    window.addEventListener("review:status", onStatus);
    window.addEventListener("review:navigate", onNavigate);
    return () => {
      window.removeEventListener("review:status", onStatus);
      window.removeEventListener("review:navigate", onNavigate);
    };
  }, [setParams]);
  return <main className="flex h-dvh min-h-0 flex-col bg-white text-slate-700 dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100">
    <header className="shrink-0 space-y-2 border-b border-slate-200 px-3 py-3 sm:px-6 dark:border-[var(--color-studio-dark-divider)]" data-testid="review-navigation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text as="h1" variant="bodyStrong" tone="primary">Workspace surface review</Text>
        <SegmentedControl aria-label="Review theme" value={resolvedTheme} onChange={value => setThemeMode(value as "light" | "dark")} size="xs" width="fit"
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </div>
      <nav aria-label="Review pages" className="flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="xs" onPress={() => navigate(-1)}>Back</Button>
        {["files", "changes", "skills", "machines"].map(value => <Button key={value} variant={panel === value ? "secondary" : "ghost"} elevation="none" size="sm"
          aria-current={panel === value ? "page" : undefined} onPress={() => setParams({ panel: value })}>{value[0].toUpperCase() + value.slice(1)}</Button>)}
        {panel === "machines" ? <div className="ml-auto flex items-center gap-2">
          <Text variant="caption" tone="muted">Agents</Text>
          <SegmentedControl aria-label="Agents example" value={agentCount} size="xs" width="fit"
            onChange={value => { const count = value as ReviewAgentCount; setReviewAgentCount(count); setAgentCount(count); }}
            options={[{ value: "single", label: "Single" }, { value: "several", label: "Several" }]} />
        </div> : null}
      </nav>
      <Text variant="caption" tone="muted" role="status" data-testid="review-status">{status}</Text>
    </header>
    <div className="min-h-0 flex-1 overflow-auto bg-white dark:bg-[var(--color-studio-dark-panel)]" data-testid="review-panel">
      <Suspense fallback={<Text className="p-4">Loading review surface…</Text>}>
        {panel === "files" ? <FilesPreview /> : panel === "changes" ? <ChangesPreview /> : panel === "machines" ? <MachinesPanel key={agentCount} /> : <SkillsPanel />}
      </Suspense>
    </div>
  </main>;
}

function ReviewApp() {
  return <ThemeProvider><StudioDraftsProvider><StudioDraftNavigationGuard><ReviewSurface /></StudioDraftNavigationGuard></StudioDraftsProvider></ThemeProvider>;
}
const initialPanel = new URLSearchParams(window.location.search).get("panel") ?? "skills";
const router = createMemoryRouter([{ path: "*", element: <ReviewApp /> }], { initialEntries: [`/studio?panel=${initialPanel}`] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
