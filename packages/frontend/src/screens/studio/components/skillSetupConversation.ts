import { getSkillImportConversationTitle } from "../../../conversations/conversationAutoTitle";
import { isSkillSetupOpener } from "../../../conversations/skillCommands";
import type { ChatMessage } from "../types";
import { PRODUCT_CONNECTORS, buildConnectorImportMessage } from "./connectors";

/** The titles Studio gives a chat that a connector's Connect chip opened. */
const CONNECTOR_SETUP_TITLES: ReadonlySet<string> = new Set(
  PRODUCT_CONNECTORS.flatMap((connector) => {
    if (connector.kind !== "skill") return [];
    const title = getSkillImportConversationTitle(buildConnectorImportMessage(connector));
    return title ? [title] : [];
  }),
);

/**
 * Whether a chat is a skill setup: a person opened it with
 * `/skills import <source> --start` or `/skills start <name>`. Once it is, it
 * stays one for the rest of that chat, as the runtime keeps a setup going until
 * the skill's "## Getting started" is done and Studio cannot tell when that is.
 *
 * In a skill setup the composer answers the setup. A reply goes out as a chat
 * turn even while the browser is shown, so it runs with the workspace's values
 * and without a page snapshot; a walk in the browser goes on only through the
 * browser's own controls (the card's button, Let AI continue, a new browser
 * page). Any other chat keeps the browser composer as it is.
 *
 * The opener is looked for in the loaded messages. While older messages of a
 * long chat are not loaded, a chat titled the way Studio titles a connector's
 * setup ("Connect FreeFinance") counts too; with no opener and no such title it
 * is an ordinary chat.
 */
export function isSkillSetupConversation(input: {
  messages: readonly Pick<ChatMessage, "role" | "content">[];
  olderMessagesUnloaded: boolean;
  title: string | null | undefined;
}): boolean {
  const opened = input.messages.some(
    (message) => message.role === "user" && typeof message.content === "string" && isSkillSetupOpener(message.content),
  );
  if (opened) return true;
  const title = input.title?.trim() ?? "";
  return input.olderMessagesUnloaded && CONNECTOR_SETUP_TITLES.has(title);
}
