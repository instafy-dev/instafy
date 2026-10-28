import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, Page } from "iconoir-react";
import { ConversationSurfaceTabs, type ConversationSurface } from "../../../src/workspace/ConversationSurfaceLayout";
import { browserViewTabDetails } from "../../../src/workspace/browserViewTab";
import { useChatRunStop } from "../../../src/screens/studio/components/useChatRunStop";
import { Composer } from "../run-stop-control/Composer";
import { UserMessageBubble } from "../../../src/screens/studio/components/ChatMessageEntries";
import { ChatImageLightboxOverlay } from "../../../src/screens/studio/components/ChatPanelOverlays";
import reviewImageUrl from "../../../public/og-image.png?inline";
import "../../../src/styles/tailwind.css";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const count = Math.max(0, Math.min(12, Number(query.get("files")) || 0));
const header = query.get("placement") === "header";
const utilityReview = query.has("utilities") ? { goalStatus: query.get("goal") === "active" ? "active" as const : query.get("goal") === "paused" ? "paused" as const : "blocked" as const } : undefined;

function MobileComposerReview() {
  const [activeId, setActiveId] = useState("chat");
  const [imageLightbox, setImageLightbox] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    if (!imageLightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setImageLightbox(null); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [imageLightbox]);
  const controller = useChatRunStop({ conversationId: null, targets: [], canStop: false, viewerUserId: null });
  return <main className="relative flex h-dvh min-h-0 flex-col bg-white text-slate-900 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100">
    <header className="px-5 py-4 text-sm font-medium">Website research <span className="block text-xs font-normal text-slate-500">Local composer preview</span></header>
    {header ? <ConversationSurfaceTabs presentation="header" chatPanelId="review-chat" activeId={activeId} resourceId="browser"
      resources={[{ id: "browser", label: "Browser", panelId: "review-browser", icon: <Globe className="h-3.5 w-3.5" /> }]}
      split={false} wide ratio={.55} onSelect={setActiveId} onSplitChange={() => {}} /> : null}
    <div className="min-h-0 flex-1 overflow-auto p-5 text-sm">
      <section id="review-chat" role="tabpanel" aria-label="Chat" hidden={activeId !== "chat"} className="space-y-6">
        {query.has("messages") ? <div className="flex justify-end">
          <UserMessageBubble message={{
            id: "review-message-with-images", role: "user", timestamp: 1,
            content: "Can you review this social card?",
            metadata: { attachments: Array.from({ length: 3 }, (_, index) => ({
              kind: "image", previewUrl: `${reviewImageUrl}#${index}`, fileName: `social-card-review-${index + 1}.png`,
            })) },
          }} onOpenImage={(src, alt) => setImageLightbox({ src, alt })} />
        </div> : <p className="ml-10 rounded-2xl bg-slate-100 p-3 dark:bg-[var(--color-studio-dark-active)]">Can you help me compare these websites?</p>}
        <div><p className="mb-2 font-medium">Octo</p><p className="text-slate-600 dark:text-slate-300">Switch to Browser to inspect the page. Your message stays in the same input while you switch views.</p></div>
      </section>
      <section id="review-browser" role="tabpanel" aria-label="Browser" hidden={activeId !== "browser"}>
        <div className="rounded-xl border border-slate-200 p-5 dark:border-[color:var(--color-studio-dark-panel-border)]"><Globe className="mb-3 h-6 w-6"/><h1 className="mb-2 font-medium">Browser content</h1><p className="text-slate-600 dark:text-slate-300">Sample page area. The real tabs and chat input remain below.</p></div>
      </section>
    </div>
    <Composer controller={controller} readOnly={query.has("readonly")} recording={false} fullPage
      utilityReview={utilityReview}
      attachmentCount={query.has("attachments") ? Math.max(0, Math.min(12, Number(query.get("attachments")) || 0)) : undefined}
      attachmentSending={query.has("sending")}
      newTab={query.has("newtab")}
      browserFollowUp={query.has("followup")}
      queueReview={query.has("queue") || query.has("stash") || utilityReview ? { count: Math.max(0, Math.min(6, Number(query.get("queue")) || 0)), initialDraft: query.get("draft") ?? "", withStash: query.has("stash") || Boolean(utilityReview) } : undefined}
      viewNavigation={header ? undefined :
      <ConversationSurfaceTabs presentation="composer" chatPanelId="review-chat" activeId={activeId} resourceId="browser"
        resources={[{ id: "browser", label: "Browser", panelId: "review-browser", icon: <Globe className="h-3.5 w-3.5" /> }]}
        split={false} wide={false} ratio={.55} onSelect={setActiveId} onSplitChange={() => {}} />
    } />
    <ChatImageLightboxOverlay imageLightbox={imageLightbox} onClose={() => setImageLightbox(null)} />
  </main>;
}

function Review() {
  const [activeId, setActiveId] = useState("browser");
  const [files, setFiles] = useState(Array.from({ length: count }, (_, index) => ({
    id: `file:${index}`, label: index === 0 ? "release-notes-for-the-next-version.md" : `notes-${index + 1}.md`,
  })));
  const [split, setSplit] = useState(false);
  const resources: ConversationSurface[] = [
    { id: "browser", label: "Browser", panelId: "review-browser", icon: <Globe className="h-3.5 w-3.5" />,
      ...browserViewTabDetails({ pageTitle: query.get("page"), agentName: query.has("agent") ? "Octo" : null }),
      attention: query.has("approval") ? <span className="text-amber-600">Approve</span> : undefined },
    ...files.map(file => ({ ...file, panelId: "review-file", icon: <Page className="h-3.5 w-3.5" />,
      onClose: () => { setFiles(current => current.filter(item => item.id !== file.id)); if (activeId === file.id) setActiveId("browser"); } })),
  ];
  return <main className="min-h-screen bg-white text-slate-900 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100">
    <div className="mx-auto flex min-w-0 flex-col gap-3 p-4" style={{ maxWidth: query.has("pane") ? Number(query.get("pane")) : undefined }}>
      <p className="text-sm text-slate-600 dark:text-slate-400">Production conversation view tabs · local fixture</p>
      <section aria-label="View switcher preview" data-testid="review-strip" className="flex min-w-0 flex-col gap-3">
        <ConversationSurfaceTabs presentation={header ? "header" : "composer"}
          chatPanelId="review-chat" resources={resources} activeId={activeId} resourceId={activeId === "chat" ? "browser" : activeId}
          split={header && split} wide={header} ratio={.55} onSelect={setActiveId} onSplitChange={setSplit} />
      </section>
      <p role="tabpanel" id={activeId === "chat" ? "review-chat" : activeId === "browser" ? "review-browser" : "review-file"} className="text-sm text-slate-600 dark:text-slate-400">Selected: {activeId}</p>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(query.get("context") === "composer" ? <MobileComposerReview /> : <Review />);
