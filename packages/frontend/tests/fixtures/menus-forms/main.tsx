import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "../../../src/components/Button";
import { Field } from "../../../src/components/Field";
import { Select } from "../../../src/components/Select";
import { Text } from "../../../src/components/Text";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import { StudioDraftsProvider } from "../../../src/workspace/StudioDrafts";
import { StudioDraftNavigationGuard } from "../../../src/navigation/StudioDraftNavigationGuard";
import { SecretsPanel } from "../../../src/screens/studio/components/SecretsPanel";
import { AiPanel } from "../../../src/screens/studio/components/AiPanel";
import { SettingsShell } from "../../../src/screens/studio/components/SettingsShell";
import "../../../src/styles/tailwind.css";

const params = new URLSearchParams(location.search);
function Review() {
 const [panel, setPanel] = useState(params.get("panel") ?? "secrets");
 const [scope, setScope] = useState("space");
 const { resolvedTheme, setThemeMode } = useTheme();
 return <main className="min-h-dvh bg-white text-slate-700 dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100">
  <header className="space-y-2 border-b border-slate-200 p-3 sm:px-6 dark:border-[var(--color-studio-dark-divider)]" data-testid="review-navigation">
   <div className="flex flex-wrap items-center justify-between gap-2"><Text as="h1" variant="bodyStrong" tone="primary">Menus and forms review</Text><SegmentedControl aria-label="Theme" value={resolvedTheme} size="xs" width="fit" onChange={v => setThemeMode(v as "light" | "dark")} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></div>
   <div className="flex flex-wrap items-center gap-2">{["secrets", "connections", "pickers"].map(p => <Button key={p} size="sm" variant={panel === p ? "secondary" : "ghost"} elevation="none" onPress={() => setPanel(p)}>{p[0].toUpperCase() + p.slice(1)}</Button>)}</div>
   <Text variant="caption" tone="muted">Production components with local sample data. No credentials or external services.</Text>
  </header>
  {panel === "secrets" ? <SecretsPanel /> : panel === "connections" ? <AiPanel /> : <SettingsShell title="Pickers" width="comfortable">
   <div className="max-w-sm">
    <Field label="Connection scope" htmlFor="review-scope">
     <Select id="review-scope" value={scope} onChange={e => setScope(e.target.value)}>
      <option value="space">This space</option>
      <option value="team">All team spaces</option>
      <option value="unavailable" disabled>Unavailable scope</option>
     </Select>
    </Field>
   </div>
  </SettingsShell>}
 </main>;
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() { return <ThemeProvider><QueryClientProvider client={queryClient}><StudioDraftsProvider><StudioDraftNavigationGuard><Review /></StudioDraftNavigationGuard></StudioDraftsProvider></QueryClientProvider></ThemeProvider>; }
const router = createMemoryRouter([{ path: "*", element: <App /> }], { initialEntries: ["/studio"] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
