import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedBrowserChrome } from "../../../src/screens/studio/components/SharedBrowserChrome";
import type { BrowserSessionPage } from "../../../src/screens/studio/components/browserSessionPages";
import { Text } from "../../../src/components/Text";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (params.get("text") === "large") document.documentElement.style.fontSize = "24px";
const user = "browser-address-local-review";
const historyKey = `instafy:browser-address-history:v1:${user}`;
const history = [
  { title: "Design system foundations — Color, typography, spacing and accessible interaction patterns", url: "https://design.example.test/docs/foundations/typography-and-layout?review=international-accessibility" },
  { title: "Research notes from the international workspace team", url: "https://research.example.test/projects/next-release/customer-interviews" },
  { title: "Design references — Screenshots for small screens and tablet landscape", url: "https://design.example.test/references/mobile-and-tablet-landscape" },
  { title: "Engineering dashboard", url: "https://engineering.example.test/projects/public-core/issues?state=open&sort=updated" },
  { title: "", url: "https://reference.example.test/a-very-long-path/with-many-segments/that-keeps-going-until-the-edge-of-a-small-phone" },
  { title: "Release readiness", url: "https://release.example.test/next/checklist" },
  { title: "Accessibility audit", url: "https://audit.example.test/reports/keyboard-and-focus" },
  { title: "Planning board", url: "https://planning.example.test/board" },
].map((entry, index) => ({ ...entry, lastVisitedAt: 1000 - index }));
if (!sessionStorage.getItem("address-review-seeded")) {
  localStorage.setItem(historyKey, JSON.stringify(history));
  sessionStorage.setItem("address-review-seeded", "yes");
}
const initial: BrowserSessionPage = { id: "workspace", url: "https://workspace.example.test/project", host: "workspace.example.test", label: "Workspace", title: "Project workspace", lastReferencedAt: 1, isActive: true, canGoBack: true, canGoForward: false };
declare global { interface Window { __browserAddressReview: { historyKey: string; navigations: string[]; setControl: (enabled: boolean) => void } } }
window.__browserAddressReview = { historyKey, navigations: [], setControl() {} };

function App() {
  const [page, setPage] = useState(initial);
  const [event, setEvent] = useState("No navigation yet");
  const [control, setControl] = useState(true);
  const pane = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  window.__browserAddressReview.setControl = setControl;
  useLayoutEffect(() => {
    const node = pane.current!;
    const update = () => setCompact(node.clientWidth < 640);
    update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect();
  }, []);
  const navigate = useCallback((_id: string, url: string) => {
    window.__browserAddressReview.navigations.push(url);
    setPage(value => ({ ...value, url, title: "Visited page" }));
    setEvent(`Navigated to ${url}`);
  }, []);
  return <main className="review-page">
    <header><Text as="h1" variant="subtitle" tone="primary">Browser workspace</Text><Text variant="caption" tone="muted">Address editing and recent sites · Local fixture</Text></header>
    <div className={params.get("layout") === "split" ? "review-layout split" : "review-layout"}>
      <div ref={pane} className="review-pane" data-testid="review-pane">
        <SharedBrowserChrome pages={[page]} compact={compact} resolved pendingAction={null} error={null} historyUserId={user}
          controlOwner={control ? { kind: "human" } : { kind: "agent", displayName: "Octo" }}
          onNavigate={navigate} onBack={() => setEvent("Back")} onForward={() => setEvent("Forward")} onReload={() => setEvent("Reload")} onClearError={() => {}} />
        <section className="review-website" aria-label="Example browser page"><span>FIELDNOTES</span><h2>A calmer place to work</h2><p>Find a recent page or enter an address to continue your work.</p></section>
      </div>
      {params.get("layout") === "split" ? <aside className="review-companion"><Text as="h2" variant="subtitle" tone="primary">Conversation</Text><Text tone="secondary">Address editing stays usable beside a narrow chat or another workspace panel.</Text></aside> : null}
    </div>
    <a className="sr-only focus:not-sr-only" href="#review-details" data-testid="next-control">Review details</a>
    <output className="review-event" data-testid="review-event">{event}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
