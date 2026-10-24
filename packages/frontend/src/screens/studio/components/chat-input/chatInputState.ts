import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { parseAssistantMentions } from "../assistantMentionUI";
import { $createAssistantMentionNode } from "./AssistantMentionNode";

/** Initialize plain drafts identically in ChatInput and queue recovery checks. */
export function $applyChatInputText(text: string) {
  const root = $getRoot();
  root.clear();
  for (const line of text.split(/\n/)) {
    const paragraph = $createParagraphNode();
    for (const chunk of parseAssistantMentions(line)) {
      if (chunk.type === "text") {
        if (chunk.value.length > 0) paragraph.append($createTextNode(chunk.value));
      } else {
        paragraph.append($createAssistantMentionNode(chunk.value));
      }
    }
    root.append(paragraph);
  }
}
