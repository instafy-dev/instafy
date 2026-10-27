import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserHumanInputControls } from "../../../src/screens/studio/components/BrowserHumanInputControls";
import { useChatRunStop, type ChatRunStopTarget } from "../../../src/screens/studio/components/useChatRunStop";
import { Composer } from "../run-stop-control/Composer";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "menu";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
const titles: Record<string, string> = {
  menu: "Composer actions", commands: "Commands", connect: "Connect a tool",
  queue: "Queued messages", "queue-edit": "Editing a queued message", stash: "Stashed drafts",
  stop: "Stop another person’s turn", takeover: "Take over the browser",
};
const stashes = [
  "Compare keyboard navigation and touch targets across all browser pages before sharing the review with the team.",
  "Save the follow-up questions for the accessibility review, including menus, focus, long titles and narrow screens.",
  "A short reminder to check both light and dark mode.",
  "Review https://example.test/research/a-very-long-reference-with-no-breaks-and-a-long-version-name-2026 to confirm the newest recommendations.",
  "Return to the onboarding draft once the new connection flow is ready for a final mobile check.",
  "Summarize the remaining decisions and send a concise checklist when the investigation is complete.",
];
const target: ChatRunStopTarget = {
  jobId: "review-job", runId: "review-run", agentHandle: "octo",
  agentDisplayName: params.has("longName") ? "Octo research and accessibility reviewer" : "Octo",
  initiatingUserId: "another-review-person",
};

function Review() {
  const [events, setEvents] = useState<string[]>([]);
  const record = (event: string) => setEvents(current => [...current, event]);
  const [targets, setTargets] = useState([target]);
  const [humanControl, setHumanControl] = useState(false);
  const stop = useChatRunStop({
    conversationId: "review-conversation", viewerUserId: "review-viewer",
    targets, canStop: surface === "stop", active: surface === "stop",
    cancelJobs: async (_conversationId, jobIds) => {
      record("stop-confirmed");
      return { ok: true, canceledJobIds: [...jobIds], canceledRunIds: ["review-run"], alreadyFinishedJobIds: [] };
    },
    onStopped: () => setTargets([]),
  });
  return <main className="composer-panels-review" data-review-surface={surface}>
    <header><h1>{titles[surface] ?? titles.menu}</h1><p>Production controls · local sample data · no requests sent</p></header>
    <section className="composer-panels-context" aria-label="Conversation preview">
      {surface === "takeover" ? <>
        <div className="composer-panels-browser-toolbar"><span>example.test / research</span>
          <BrowserHumanInputControls identityKey="review-browser" request={null} canTakeOver={!humanControl}
            humanControlConfirmed={humanControl} onTakeOver={async () => {
              if (params.get("outcome") === "pending") {
                await new Promise<void>(resolve => {
                  window.addEventListener("composer-panels:resolve-takeover", () => resolve(), { once: true });
                });
              }
              if (params.get("outcome") === "error") throw new Error("The browser could not confirm that agent control stopped. Check the connection and try taking over again.");
              record("takeover-confirmed"); setHumanControl(true); return true;
            }}
            onContinue={async () => { record("continue-confirmed"); setHumanControl(false); return true; }} />
        </div>
        <div className="composer-panels-browser-page"><h2>Project research</h2><p>The AI is reviewing this page. You can take over to make changes, then let the task continue.</p></div>
      </> : <div className="composer-panels-conversation"><strong>Octo</strong><p>I’m reviewing the interface. Your draft, queued messages and stashed drafts stay available while the work continues.</p></div>}
    </section>
    <div className="composer-panels-composer">
      <Composer controller={stop} readOnly={false} recording={false} fullPage
        stashMessages={stashes}
        queueReview={{ count: surface === "queue" || surface === "queue-edit" ? 6 : 0, withStash: surface === "stash", initialDraft: surface === "queue-edit" || surface === "stash" ? "" : "Please compare these screenshots.\nCheck the navigation and spacing too." }}
        composerActions={{
          showBrowserAction: true, showNewBrowserAction: true, showInviteAction: true,
          onOpenBrowser: () => record("open-browser"), onOpenNewBrowser: () => record("new-browser"),
          onOpenInvite: () => record("invite"), onImportGithubRepo: () => record("import-repository"),
          onSelectConnector: connector => record(`connect:${connector.id}`), onBrowseConnectors: () => record("browse-tools"),
          onQueueMessage: () => record("queue-draft"), onStashDraft: () => record("stash-draft"),
          installedSkillNames: new Set(["freefinance"]),
        }} />
    </div>
    <output hidden data-testid="review-events">{JSON.stringify(events)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Review />);
