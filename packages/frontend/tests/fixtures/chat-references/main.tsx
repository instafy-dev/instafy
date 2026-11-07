import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageContent } from "../../../src/screens/studio/components/ChatMessageContent";
import { ConversationMessageContext, openConversationMessageReference } from "../../../src/workspace/ConversationMessageContext";
import { ConversationFileContext } from "../../../src/workspace/ConversationFileContext";
import { ConversationMessageMetadataProvider } from "../../../src/conversations/ConversationMessageMetadata";
import { Text } from "../../../src/components/Text";
import "../../../src/styles/tailwind.css";
import "./review.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (params.get("text") === "large") document.documentElement.style.fontSize = "24px";
const filePath = "src/workspace/navigation/components/ConversationHistoryPanel.tsx";
const draft = "Please keep this draft while I check the source.";
const conversations = [{ localId: "review-chat", controllerId: "review-controller", extraAgentHandles: [] }];

function App() {
  const [event, setEvent] = useState("No action yet");
  useEffect(() => {
    const onAction = (event: Event) => setEvent((event as CustomEvent<string>).detail);
    window.addEventListener("reference-review:action", onAction);
    return () => window.removeEventListener("reference-review:action", onAction);
  }, []);
  return <ConversationMessageMetadataProvider conversations={conversations} activeConversationId="review-chat">
    <ConversationFileContext.Provider value={file => setEvent(`Opened ${file.path}:${file.line ?? ""}`)}>
      <ConversationMessageContext.Provider value={reference => openConversationMessageReference(reference, {
        activeProjectId: "review-project",
        conversationsProjectKey: params.get("scope") === "stale" ? "previous-project" : "review-project",
        resolveConversationLocalId: id => id === "review-controller" ? "review-chat" : null,
      }, destination => {
        if (destination.kind === "conversation") setEvent(`Opened message: ${destination.messageId} in ${destination.conversationId}`);
      })}>
      <main className="review-page">
        <header className="review-header"><Text as="h1" variant="subtitle" tone="primary">Navigation review</Text><Text variant="caption" tone="muted">Chat references · Local interaction fixture</Text></header>
        <section className="review-conversation" aria-label="Conversation">
          <article className="review-message" data-testid="review-message">
            <Text as="h2" variant="bodyStrong" tone="primary">Octo</Text>
            <MessageContent projectId="review-project" content={[
              "> Keep the return path easy to find, and preserve the current draft.", "",
              "The source is ready to review. Inspect `" + filePath + ":18` for the navigation change.", "",
              "Compare [[message:review-controller/source-message|the earlier decision]] before editing.",
            ].join("\n")} metadata={{ replyContext: { kind: "message_selection", conversationId: "review-controller", messageId: "source-message" } }} />
          </article>
        </section>
        <section className="review-composer" aria-label="Unsent draft"><label htmlFor="draft"><Text as="span" variant="captionStrong" tone="muted">Draft</Text></label><textarea id="draft" defaultValue={draft} rows={2} /></section>
        <output data-testid="review-event" className="review-event">{event}</output>
      </main>
      </ConversationMessageContext.Provider>
    </ConversationFileContext.Provider>
  </ConversationMessageMetadataProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
