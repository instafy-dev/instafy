import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileStudioHistoryControls } from "../../../src/screens/studio/components/MobileStudioHistoryControls";
import { useStudioSearch, type StudioSearchRecord } from "../../../src/screens/studio/components/useStudioSearch";
import "../../../src/styles/tailwind.css";
import "../../../src/screens/studio/StudioContextLayout.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
type Status = "results" | "error" | "loading" | "empty";
declare global {
  interface Window {
    __searchKeyboardReview: { setStatus: (status: Status) => void; activations: number; retries: number };
  }
}
const notice = "Message search matches text in accessible conversations; use at least 2 characters. Also searches recent chat titles (up to 200 per space), opened file names, files already listed in the current space and settings. Unloaded folders and file contents are not included.";
const restoreSession = { restoreKey: "review", query: "navigation", scope: "space" as const, scrollTop: 0, resultId: "", resultLimit: 100, messagePageCount: 1 };
const history = { canGoBack: true, canGoForward: false, goBack: () => {}, goForward: () => {} };
const org = { id: "review-org", name: "Agent Test Workshop" };
const space = { id: "review-space", name: "Android UI review" };
const records: StudioSearchRecord[] = Array.from({ length: params.get("many") === "1" ? 20 : 1 }, (_, i) => ({
  id: `chat-${i}`, title: i ? `Navigation follow-up ${i}` : "Navigation review", description: "Agent Test Workshop / Android UI review",
  keywords: "navigation", group: "Chats", orgId: org.id, spaceId: space.id,
  activate: () => { window.__searchKeyboardReview.activations++; },
}));

function Review() {
  const [status, setStatus] = useState<Status>((params.get("state") as Status) || "results");
  window.__searchKeyboardReview = { ...window.__searchKeyboardReview, setStatus, activations: window.__searchKeyboardReview?.activations ?? 0, retries: window.__searchKeyboardReview?.retries ?? 0 };
  const search = useStudioSearch({
    scopeKey: "review", org, space, records: status === "results" ? records : [], fullPage: true,
    restoreSession, notice, loading: status === "loading", error: status === "error" ? "Could not search this space. Check your connection and retry." : null,
    onRetry: () => { window.__searchKeyboardReview.retries++; setStatus("results"); },
  });
  return <div className="studio-context-layout flex h-dvh min-h-0 flex-col" style={{ paddingBottom: "var(--instafy-safe-area-inset-bottom)" }}>
    <div className="studio-context-search-screen">
      <header className="studio-context-search-mobile" aria-label="Search">{search.renderControl()}</header>
      <div className="px-1"><MobileStudioHistoryControls history={history} returnToSearch={false} /></div>
      <main className="flex min-h-0 min-w-0 flex-1" aria-label="Search results" data-testid="studio-search-screen">{search.results}</main>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Review />);
