import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Text } from "../../../src/components/Text";
import { AutomationsPanel } from "../../../src/screens/studio/components/AutomationsPanel";
import { StudioDraftsProvider } from "../../../src/workspace/StudioDrafts";
import { StudioDraftNavigationGuard } from "../../../src/navigation/StudioDraftNavigationGuard";
import { StatusProvider } from "../../../src/status/StatusProvider";
import { Status } from "../../../src/status/Status";
import { ThemeProvider, useTheme } from "../../../src/theme/ThemeProvider";
import { completePendingSave } from "./adapters";
import "../../../src/styles/tailwind.css";

const params = new URLSearchParams(window.location.search);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function Review() {
  const { setThemeMode } = useTheme();
  useEffect(() => { setThemeMode(params.get("theme") === "dark" ? "dark" : "light"); }, [setThemeMode]);
  useEffect(() => {
    window.addEventListener("review:complete-save", completePendingSave);
    return () => window.removeEventListener("review:complete-save", completePendingSave);
  }, []);
  return <main className="min-h-dvh bg-white text-slate-700 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100">
    <header className="px-4 py-3 sm:px-5">
      <Text variant="caption" tone="muted">Local automation editor review · All actions use inert fixture data.</Text>
    </header>
    <AutomationsPanel />
    <Status />
  </main>;
}
function App() {
  return <QueryClientProvider client={queryClient}><ThemeProvider><StatusProvider>
    <StudioDraftsProvider><StudioDraftNavigationGuard><Review /></StudioDraftNavigationGuard></StudioDraftsProvider>
  </StatusProvider></ThemeProvider></QueryClientProvider>;
}
const router = createMemoryRouter([{ path: "*", element: <App /> }], { initialEntries: ["/studio?panel=automations"] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
