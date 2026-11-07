import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedBrowserChrome } from "../../../src/screens/studio/components/SharedBrowserChrome";
import { SharedLocalTabViewer } from "../../../src/screens/studio/components/SharedLocalTabViewer";
import type { BrowserSessionPage } from "../../../src/screens/studio/components/browserSessionPages";
import { Text } from "../../../src/components/Text";
import { share } from "./transport";
import "../../../src/styles/tailwind.css";
import "./review.css";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (params.get("text") === "large") document.documentElement.style.fontSize = "24px";
const basePages: BrowserSessionPage[] = [
  { id: "project", url: "https://example.test/project", host: "example.test", label: "Project", title: "Quarterly website redesign and accessibility review — Project workspace", lastReferencedAt: 3, isActive: true, canGoBack: true, canGoForward: false },
  { id: "research", url: "https://example.test/research", host: "example.test", label: "Research", title: "Customer research and notes from the international team", lastReferencedAt: 2, isActive: false, openedBy: "agent", agentTabNumber: 1 },
  { id: "design", url: "https://example.test/design", host: "example.test", label: "Design", title: "Design references and annotated interface screenshots", lastReferencedAt: 1, isActive: false, openedBy: "agent", agentTabNumber: 2, kept: true },
];
function App() {
  const [event, setEvent] = useState("No action yet");
  const [pages, setPages] = useState(basePages);
  const [open, setOpen] = useState(true);
  const pane = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const surface = params.get("surface") ?? "picker";
  const unavailable = params.get("authority") === "none";
  const onEnded = useCallback((id: string) => setEvent(`Share ended: ${id}`), []);
  const onClose = useCallback(() => { setOpen(false); setEvent("Left shared tab"); }, []);
  useLayoutEffect(() => {
    const node = pane.current!;
    const update = () => setCompact(node.clientWidth < 640);
    update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect();
  }, []);
  return <main className="review-page">
    <header><Text as="h1" variant="subtitle" tone="primary">Browser workspace</Text><Text variant="caption" tone="muted">Tab selection and connection recovery · Local fixture</Text></header>
    <div className={params.get("layout") === "split" ? "review-layout split" : "review-layout"}>
      <div ref={pane} className="review-pane" data-testid="review-pane">
        {surface === "picker" ? <>
          <SharedBrowserChrome pages={pages} compact={compact} resolved={params.get("state") !== "connecting"} pendingAction={null} error={null} historyUserId={null}
            controlOwner={unavailable ? { kind: "agent", displayName: "Octo" } : { kind: "human" }} agentPageIds={["research", "design"]}
            onNavigate={(id, url) => setEvent(`Navigate ${id}: ${url}`)} onBack={id => setEvent(`Back ${id}`)} onForward={id => setEvent(`Forward ${id}`)} onReload={id => setEvent(`Reload ${id}`)} onClearError={() => {}}
            onFocusPage={id => { setPages(values => values.map(page => ({ ...page, isActive: page.id === id }))); setEvent(`Selected ${id}`); }} />
          <section className="review-website" aria-label="Example browser page"><span>FIELDNOTES</span><h2>A calmer place to work</h2><p>Keep the current page clear while switching between research and design.</p></section>
        </> : open ? <SharedLocalTabViewer projectId="review-project" share={share} onClose={onClose} onEnded={onEnded} /> : <Text tone="muted">Shared tab closed.</Text>}
      </div>
      {params.get("layout") === "split" ? <aside className="review-companion"><Text as="h2" variant="subtitle" tone="primary">Conversation</Text><Text tone="secondary">The browser remains usable beside a narrow chat or another workspace panel.</Text></aside> : null}
    </div>
    <output className="review-event" data-testid="review-event">{event}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
